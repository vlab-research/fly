# Facebook Utility Messages

## Why this exists

Facebook deprecated all out-of-window messaging mechanisms in early 2026:

| Feature | Deprecated |
|---------|-----------|
| Message Tags (`CONFIRMED_EVENT_UPDATE`, etc.) | April 27, 2026 |
| Recurring Notifications / Marketing Messages | February 10, 2026 (globally; still live in AU/EU/JP/KR/UK) |
| **Utility Messages** | **Current replacement — globally available** |

[Utility Messages](https://developers.facebook.com/docs/messenger-platform/send-messages/utility-messages/)
are the only remaining global mechanism for sending non-promotional content (survey
results, prize notifications, appointment reminders) to a user after the 24-hour
Messenger window closes. They require a pre-approved template per Facebook Page
and do not require user opt-in.

This document describes the end-to-end integration across dashboard-server,
dashboard-client, translate-typeform, and replybot. Meta's API docs were the
primary design input — see [References](#references) at the bottom for the
specific pages consulted.

---

## Identity model

> **A template is uniquely identified by the tuple `(facebook_page_id, name, language)`.**

Read that again. The same `name` can exist in multiple languages — each is a separate
record, approved by Facebook independently. This is Facebook's own model and it flows
through every layer:

- **DB schema** — `UNIQUE (facebook_page_id, name, language)`
- **Dashboard UI** — one row per (name, language); name help-text calls this out
- **API** — `POST` rejects duplicate `(pageId, name, language)` with 409
- **Survey JSON** — both `template` and `language` are required, no defaults
- **Translator** — throws if either is missing; passes `language.code` through
  to the Facebook Send API so FB picks the right approved variant

Silently defaulting a language would mask misconfigured surveys, so every layer
requires both values explicitly.

---

## End-to-end flow

```
1. Dashboard (author)
   POST /api/v1/message-templates
     → dashboard-server looks up the page token, calls
       POST /{pageId}/message_templates with category=UTILITY
     → row inserted with status=PENDING, fb_template_id stored

2. Dashboard (polling)
   GET /api/v1/message-templates?pageId=X every 4 s while any row is PENDING
     → for PENDING rows, server calls GET /{pageId}/message_templates?name=X
       and updates status + rejection_reason in the DB
     → polling stops automatically when no rows are PENDING

3. Survey send (runtime)
   replybot reaches a utility_message field in the survey flow
     → interpolateField() resolves {{hidden:X}} inside properties.description
     → addCustomType() parses the YAML into field.md
     → translateUtilityMessage() emits Facebook's UTILITY payload with
       messaging_type: 'UTILITY' at the top level (via metadata.sendParams)
     → replybot sends the payload to Facebook, which matches the
       (name, language) pair against an approved template and delivers
```

---

## Template authoring (Dashboard)

Route: `/message-templates`

**Form fields**:

| Field | Constraint |
|-------|-----------|
| Page | Must be a Facebook Page already connected via `/connect/facebook-messenger` |
| Name | `snake_case` — lowercase letters, digits, underscores only. Unique per (page, language). |
| Language | Searchable Select, Facebook-supported locales (see `dashboard-client/src/containers/MessageTemplates/locales.js`; source: [Meta's supported languages list](https://developers.facebook.com/docs/whatsapp/api/messages/message-templates#supported-languages)). No freetext. |
| Body | Up to 1024 characters. Uses `{{1}}`, `{{2}}`, etc. for positional parameters. |
| Quick-reply buttons | Up to 3 buttons, label ≤ 20 chars, unique within the template. Optional — leave empty for text-only templates. |

**No edit**: Facebook does not permit editing an approved utility template. To change
wording *or buttons*, delete and recreate.

**Status lifecycle**: `PENDING` → `APPROVED` or `REJECTED`. Custom utility templates
usually auto-approve in seconds. Rejected rows carry a tooltip-visible rejection
reason surfaced from Facebook's `rejected_reason` field.

### Quick-reply buttons

A template can declare up to 3 [`QUICK_REPLY`](https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/components#quick-reply-buttons) buttons. **Labels are fixed at approval time** — Facebook renders them; we can't change them after the fact. Per-send **payloads** (what the survey logic branches on) come from the survey JSON, not the template.

Why `QUICK_REPLY` and not postback buttons? Taps on `QUICK_REPLY` buttons arrive as a Messenger `message.quick_reply` event — the same webhook shape native Messenger quick replies use. Replybot's existing `QUICK_REPLY` handler (`replybot/lib/typewheels/machine.js:473-486`) already parses `{value, ref}` payloads, so button taps need no new code paths. Postback buttons (from `translateButtonChoice`) go through a different webhook (`messaging_postbacks`) and would require parallel plumbing — we intentionally avoid that.

The translator emits per-button payloads as `JSON.stringify({value, ref})`, mirroring `makeMultipleChoice` at `translate-typeform/translate-fields.js:37`.

---

## Delete semantics

[Facebook exposes two delete paths on the `message_templates` edge](https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates#deleting-templates):

| Endpoint | Effect |
|----------|--------|
| `DELETE /{pageId}/message_templates?name=X` | Deletes **every language variant** with that name |
| `DELETE /{pageId}/message_templates?hsm_id=<id>` | Deletes exactly one language variant |

The dashboard DELETE endpoint (`DELETE /api/v1/message-templates/:id`) always uses
the `hsm_id` path so a row-level delete maps to exactly one Facebook record. This is
why `fb_template_id` is stored on every row.

---

## Survey JSON shape

Place in a Typeform statement's description as YAML. Both `template` and `language`
are required. `params` is a positional array, matching Facebook's `{{1}}`, `{{2}}`, …
numbering in the approved body:

```yaml
type: utility_message
template: prize_notification
language: en_US
params:
  - "{{hidden:name}}"
  - "$5"
buttons:   # optional; one value per button on the approved template, in order
  - "yes"
  - "no"
```

Omit `buttons` entirely for a text-only template. Do **not** set `keepMoving: true` when the template has buttons — you want the survey to wait for the user's tap so logic jumps can branch on the response.

Survey JSON equivalent:

```json
{
  "type": "utility_message",
  "template": "prize_notification",
  "language": "en_US",
  "params": ["{{hidden:name}}", "$5"],
  "buttons": ["yes", "no"]
}
```

**Hidden-field interpolation** happens on `properties.description` as a string
*before* the YAML is parsed (`replybot/lib/typewheels/form.js` `interpolateField`
→ `translate-typeform` `addCustomType`). So by the time `translateUtilityMessage`
reads `data.md.params`, the `{{hidden:name}}` token has already been substituted
with the user's actual name. The translator itself does no interpolation.

---

## Send API shape (runtime)

`translateUtilityMessage` (in `translate-typeform/translate-fields.js`) returns an
object whose `metadata.sendParams` carries `messaging_type: 'UTILITY'`. The existing
`formatResponse` logic spreads those params at the top level of the outgoing payload,
so the request Facebook receives looks like:

```json
{
  "recipient": { "id": "<PSID>" },
  "messaging_type": "UTILITY",
  "message": {
    "attachment": {
      "type": "template",
      "payload": {
        "template_type": "utility_messages",
        "name": "prize_notification",
        "language": { "code": "en_US" },
        "components": [
          {
            "type": "body",
            "parameters": [
              { "type": "text", "text": "Alice" },
              { "type": "text", "text": "$5" }
            ]
          },
          {
            "type": "button",
            "sub_type": "quick_reply",
            "index": 0,
            "parameters": [
              { "type": "payload", "payload": "{\"value\":\"yes\",\"ref\":\"<field-ref>\"}" }
            ]
          },
          {
            "type": "button",
            "sub_type": "quick_reply",
            "index": 1,
            "parameters": [
              { "type": "payload", "payload": "{\"value\":\"no\",\"ref\":\"<field-ref>\"}" }
            ]
          }
        ]
      },
      "metadata": "…"
    }
  }
}
```

No changes were needed in replybot's send layer — the `sendParams` mechanism
already hoists top-level fields from the translated payload. Button payloads
use the same `{value, ref}` shape as `translateMultipleChoice`, so taps come
back on the existing `QUICK_REPLY` code path.

---

## Database schema

`devops/migrations/13-message-templates.sql` creates the base table:

```sql
CREATE TABLE chatroach.message_templates(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    userid UUID NOT NULL REFERENCES chatroach.users(id) ON DELETE CASCADE,
    facebook_page_id VARCHAR NOT NULL,
    fb_template_id VARCHAR,
    name VARCHAR NOT NULL,
    language VARCHAR NOT NULL DEFAULT 'en_US',
    body TEXT NOT NULL,
    status VARCHAR NOT NULL DEFAULT 'PENDING',
    rejection_reason TEXT,
    created TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (facebook_page_id, name, language),
    INDEX (userid, created DESC),
    INDEX (facebook_page_id, status)
);
```

`devops/migrations/14-message-templates-buttons.sql` adds quick-reply buttons:

```sql
ALTER TABLE chatroach.message_templates
  ADD COLUMN IF NOT EXISTS buttons JSONB NOT NULL DEFAULT '[]'::JSONB;
```

Shape: `[{"label": "Yes"}, {"label": "No"}]`. Payloads live in the survey JSON per-send, not on the template.

---

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Template stays PENDING forever | Facebook approval is unusually slow or failed silently. Refresh the page; if still stuck after an hour, delete and recreate. |
| Template rejected with "promotional" reason | UTILITY is strictly non-promotional. Rewrite the body to be transactional (confirmations, reminders, results) — not marketing. |
| Send fails with "template not found" | The `(template, language)` pair in survey JSON does not match any APPROVED row. Check spelling and create the missing language variant. |
| Unique constraint error on create | A template with that `(name, language)` on this page already exists. Use a different name or delete the existing row first. |
| Send fails with "placeholder count mismatch" | Survey `params` array length does not match the number of `{{N}}` placeholders in the approved body. Count and align. |

---

## Deployment notes

1. Run `devops/migrations/13-message-templates.sql` and `devops/migrations/14-message-templates-buttons.sql` on CockroachDB
2. Publish `@vlab-research/translate-typeform@0.2.10` to npm
3. Update `replybot` lockfile (`npm install @vlab-research/translate-typeform@0.2.10`) and redeploy
4. Redeploy dashboard-server and dashboard-client

---

## References

Meta documentation that informed the implementation. If you're debugging a
payload shape, rejection reason, or locale code, these pages are the source
of truth — our code mirrors them.

- [Messenger Platform — Send Utility Messages](https://developers.facebook.com/docs/messenger-platform/send-messages/utility-messages/) — the top-level feature overview; explains `messaging_type: UTILITY`, the `utility_messages` template type, and why no user opt-in is required.
- [WhatsApp Business Management API — Message Templates](https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates) — CRUD for templates. Messenger's `utility_messages` template system inherits this API, including the `(page_id, name, language)` identity model and the `hsm_id` vs `name` delete semantics.
- [Template Components](https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/components) — the `BODY` / `BUTTONS` component model used at template creation time, including the `QUICK_REPLY` button sub-type and its label constraints.
- [Supported Languages](https://developers.facebook.com/docs/whatsapp/api/messages/message-templates#supported-languages) — the full set of language codes; the source for `dashboard-client/src/containers/MessageTemplates/locales.js`.
- [Meta deprecation notices for Message Tags and Recurring Notifications](https://developers.facebook.com/docs/messenger-platform/changelog/) — context for why this replacement was needed (also covered in `documentation/marketing-messages.md`).

Related internal documentation:

- [`marketing-messages.md`](./marketing-messages.md) — the now-deprecated Recurring Notifications integration that this feature replaces. Kept for historical context.
