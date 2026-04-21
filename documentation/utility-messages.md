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

### Postback buttons

A template can declare up to 3 `POSTBACK` buttons. **Labels are fixed at approval time** — Facebook renders them; we can't change them after the fact. The per-button `value` (what the survey logic branches on) is also baked in at approval time. Only the survey field `ref` is substituted per send.

Why `POSTBACK` and not `QUICK_REPLY`? Messenger's utility template API rejects `QUICK_REPLY` at template creation with a `Fatal` error (`error_subcode: 2018416`) — `POSTBACK`, `URL`, and `PHONE_NUMBER` are the only accepted button types. This was validated by direct testing against v25.0 of the Graph API (see `scripts/test-utility-template.js`).

**How per-send `ref` substitution works**. Each approved button carries a payload of the form:

```
{"value":"<button-label>","ref":"{{1}}"}
```

At send time, `translateUtilityMessage` emits a per-button component with `sub_type: 'postback'` and a single `text` parameter carrying the actual field `ref`. Facebook substitutes `{{1}}` in the baked payload to produce the delivered payload:

```
{"value":"<button-label>","ref":"<actual-field-ref>"}
```

Taps arrive as a `messaging_postbacks` webhook event. Replybot's existing `POSTBACK` case handler (`replybot/lib/typewheels/machine.js:463-471`) already extracts `postback.payload.value` and advances the state machine identically to a `QUICK_REPLY` tap — no new code paths are needed. The `messaging_postbacks` field is already in the `subscribed_apps` list created by the dashboard's `addWebhooks` call.

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
            "sub_type": "postback",
            "index": 0,
            "parameters": [
              { "type": "text", "text": "<field-ref>" }
            ]
          },
          {
            "type": "button",
            "sub_type": "postback",
            "index": 1,
            "parameters": [
              { "type": "text", "text": "<field-ref>" }
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
already hoists top-level fields from the translated payload. Button taps arrive
as `messaging_postbacks` events and are handled by the existing POSTBACK branch
in `replybot/lib/typewheels/machine.js:463-471`, which extracts
`postback.payload.value` exactly the same way the QUICK_REPLY branch extracts
`quick_reply.payload.value`.

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
| Template rejected with `TEMPLATE_VARIABLES_MISSING_SAMPLE_VALUES` | Facebook requires sample values for every `{{N}}` placeholder in the BODY. The dashboard currently does not collect these — if a body uses placeholders, either remove them or provide examples at creation time (see "Examples / sample values" section). |
| Template creation returns `{"error":"Fatal"}` (subcode `2018416`) | The template BUTTONS component uses `QUICK_REPLY`. Messenger utility templates only accept `POSTBACK`, `URL`, or `PHONE_NUMBER` at creation. Use `buildFacebookCreatePayload`'s current POSTBACK output. |

---

## Deployment notes

1. Run `devops/migrations/13-message-templates.sql` and `devops/migrations/14-message-templates-buttons.sql` on CockroachDB
2. Publish `@vlab-research/translate-typeform@0.2.11` to npm
3. Update `replybot` lockfile (`npm install @vlab-research/translate-typeform@0.2.11`) and redeploy
4. Redeploy dashboard-server and dashboard-client

---

## Facebook app permissions and rollout

Getting a Facebook app to the point where it can actually call
`POST /{pageId}/message_templates` is not automatic. The steps below are
ordered — each is necessary, none is sufficient alone.

### 1. OAuth scope on page connect

The dashboard-client Facebook Login flow (`FacebookPages.js`) must request
`pages_utility_messaging` in the `scope` string.

**Gotcha**: Meta's docs refer to the permission as `page_utility_messaging`
(singular), but Facebook's OAuth endpoint rejects that with
`Invalid Scope: page_utility_messaging`. The name accepted at the
OAuth layer is `pages_utility_messaging` (plural, matching the other
`pages_*` Messenger permissions). Verify the granted token's scopes via
the Access Token Debugger.

### 2. Graph API version

- dashboard-client SDK: `REACT_APP_FACEBOOK_GRAPH_VERSION=25.0` (netlify.toml)
- dashboard-server: `FACEBOOK_GRAPH_URL=https://graph.facebook.com/v22.0` (Helm values)

Older versions (v17 and below) do not expose the utility message template
endpoint.

### 3. Webhook subscription

`POST /{pageId}/subscribed_apps` must include **`message_template_status_update`**
in `subscribed_fields`. Meta's utility messages guide lists this as a core
prerequisite for using the `message_templates` edge — not just for receiving
approval notifications. The dashboard's `addWebhooks` call
(`dashboard-server/api/facebook/facebook.controller.js`) sends the full list;
pages connected before this field was added need to re-run the webhook
subscription (use the **Update** link on the page in `/connect/facebook-messenger`).

### 4. App-level permission grant

In the Facebook App Dashboard under **App Review → Permissions and Features**,
`pages_utility_messaging` must be added and show as **Standard Access Granted**.
Standard Access is enough for pages where the connecting user has a role on
the app (developer/tester/admin); Advanced Access (full App Review) is needed
for production use by arbitrary page admins.

To unlock the "Request Advanced Access" button in the portal, Meta requires
one successful test API call (`POST /{pageId}/message_templates`) on the
permission. The button can take up to 24h to activate after the first
successful call.

### Resolved: the `#10` and `Fatal` errors

Two separate issues were seen during rollout, both now resolved:

1. `(#10) Application does not have permission for this action` — seen on
   pages owned by a business that wasn't the one connected to the app. The
   fix was to create the template from a page connected to the same business
   as the Facebook App.

2. `{"error":"Fatal"}` (Graph `error_subcode: 2018416`, user title
   "Message Template Creation Failed") — returned whenever the template's
   BUTTONS component used `type: QUICK_REPLY`. Messenger utility templates
   reject `QUICK_REPLY` at creation; only `POSTBACK`, `URL`, and
   `PHONE_NUMBER` are accepted. Fixed by switching to `POSTBACK` with a
   `{{1}}`-templated payload (see "Postback buttons" section).

**Next steps when resuming:**
1. Wait ≥24h after the permission was granted in the portal — Meta's
   permission state can take time to propagate.
2. Confirm Business Verification is complete on the business that owns the
   app — some Messenger permissions silently require this.

### BODY placeholder examples

Facebook rejects any template whose BODY contains `{{N}}` placeholders but
omits sample values, with `specific_rejection_reason: TEMPLATE_VARIABLES_MISSING_SAMPLE_VALUES`.

The dashboard form detects `{{N}}` placeholders in the body field as the
user types and renders one "Sample value" input per unique placeholder.
The examples array is sent to dashboard-server as a positional array
(examples[0] → {{1}}, examples[1] → {{2}}, …), validated server-side
against placeholder count and sequentiality, and emitted on the BODY
component as `example: { body_text: [examples] }` (a single variation).

The examples are only used at approval time — the actual runtime values
come from `params` in the survey JSON at send time. Placeholder numbering
must be sequential starting from `{{1}}`; both the client (live validation)
and server (rejection) enforce this.

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
