# WhatsApp Template Messages

## Why this exists

WhatsApp only allows free-form business messages within the **24-hour
customer-service window** — the 24 hours following the user's last inbound
message. Outside that window (dean timeouts and follow-ups, payment retries,
any re-contact), a business may only send a **pre-approved template
message**. Before this feature, message-worker's WhatsApp path had no
template support, so any out-of-window send failed.

This mirrors the Messenger utility-message system
(`documentation/utility-messages.md`) — same identity model, same dashboard,
same survey-JSON contract — with WhatsApp-specific API shapes where Meta's
two platforms genuinely differ. Read the utility-messages doc first; this
doc only covers what WhatsApp changes.

---

## Identity model (unchanged)

> **A template is uniquely identified by the tuple `(account_id, name, language)`.**

`message_templates.account_id` holds the messaging account id matching
`credentials.key` — the **page id** for Messenger, the **`phone_number_id`**
for WhatsApp. No schema change was needed for WhatsApp support.

However, WhatsApp template CRUD against Meta happens at the **WABA
(WhatsApp Business Account) level**, not the phone-number level. The WABA id
is resolved per-request from the `whatsapp_business` credential's
`details.waba_id`. The DB rows stay keyed by `phone_number_id`; the WABA id
is never stored on the template row.

### Credential requirement (Track A / org numbers)

A `whatsapp_business` credential MUST carry `waba_id` in its `details`:

```json
{
  "entity": "whatsapp_business",
  "key": "<phone_number_id>",
  "details": {
    "id": "<phone_number_id>",
    "waba_id": "<waba_id>",
    "access_token": "<business token>"
  }
}
```

The Embedded Signup flow (`dashboard-client/src/containers/WhatsAppEmbedded`)
stores this shape automatically. Org-number credentials created out-of-band
("Track A") must include `details.waba_id` too — the dashboard **fails
loudly with a 400** ("missing details.waba_id") on any template operation
against a credential without it. There is no fallback.

Note also: one WABA can own multiple phone numbers. Since templates are
approved per-WABA on Meta's side but stored per-`phone_number_id` here, two
numbers on the same WABA share the Meta template namespace — creating the
same (name, language) from a second number on the same WABA will collide at
Meta even though the local DB row would be unique.

---

## Dashboard-server: platform-aware CRUD

`dashboard-server/api/message-templates/` resolves the account behind
`accountId` at request time (`resolveAccountOps` in the controller):

1. Try `credentials` with `entity = 'facebook_page'` → **Messenger path,
   byte-identical to before**: Graph calls against `/{page_id}/message_templates`
   with the page access token.
2. Else try `entity = 'whatsapp_business'` → **WhatsApp path**: resolve
   `waba_id` from details (400 if missing), then Graph calls against
   `/{waba_id}/message_templates` with the credential's stored **business
   access token** (never the page-token helper).
3. Neither → 404.

| Operation | Messenger | WhatsApp |
|-----------|-----------|----------|
| Create | `POST /{page_id}/message_templates` | `POST /{waba_id}/message_templates` |
| Status refresh | `GET /{page_id}/message_templates?name=X` | `GET /{waba_id}/message_templates?name=X` |
| Delete | `DELETE ...?hsm_id=<id>` | `DELETE ...?hsm_id=<id>&name=<name>` — WhatsApp **requires both**; hsm_id alone deletes nothing |

### Create payload differences

Shared: `category: UTILITY`, BODY component with `{{n}}` placeholders,
`example.body_text` (array-of-arrays, one variation). **WhatsApp REQUIRES
example values for every placeholder** — the shared `validateCreateInput`
already enforces this for both platforms (missing examples → 400 before any
Graph call).

Buttons differ (`buildWhatsAppCreatePayload` vs `buildFacebookCreatePayload`
in `message-templates.core.js`):

| | Messenger | WhatsApp |
|---|-----------|----------|
| Button type | `POSTBACK` (QUICK_REPLY rejected at creation) | `QUICK_REPLY` |
| Baked payload | `{"value":"<label>","ref":"{{1}}"}` baked at approval | **none** — only visible `text` is baked; the tap payload is supplied per-send |

Status lifecycle, 4s dashboard polling, and no-edit semantics are identical
to Messenger. WhatsApp review is a real review (can take minutes-to-hours,
unlike Messenger's usually-instant auto-approval).

---

## Survey JSON contract (field metadata)

Identical to Messenger — this is the contract the e2e integration builds on.
A `utility_message` field's YAML description:

```yaml
type: utility_message
template: recontact_confirm
language: en_US
params:
  - "{{hidden:name}}"
  - "10:00"
```

By the time the send command reaches message-worker, the field's
`MessageContent.metadata` (JSON) carries:

```json
{
  "type": "utility_message",
  "template": "recontact_confirm",
  "language": "en_US",
  "params": ["Alice", "10:00"],
  "ref": "<field ref>"
}
```

- `template` and `language` are **required**; the translator errors
  (`ErrMissingUtilityTemplate` / `ErrMissingUtilityLanguage`) if either is
  missing — no defaults.
- `params` is positional against the approved body's `{{1}}, {{2}}, …`.
- Buttons come from the field's own choices (`MessageContent.options`), not
  from metadata — choice labels must equal the approved template's button
  labels and count.
- The base `MessageContent.type` is `"question"` when the field has choices
  and `"text"` when it doesn't; the `metadata.type == "utility_message"`
  discriminator — not the base type — is what routes to the template
  translator (same dispatch as Messenger).

---

## Message-worker: WhatsApp template send

`TranslateToWhatsApp` (`message-worker/translator_whatsapp.go`) dispatches
`utility_message` fields to `translateWhatsAppTemplate`, which builds a
Cloud API template send, POSTed by the existing `WhatsAppClient` to
`/{phone_number_id}/messages`:

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "<user phone>",
  "type": "template",
  "template": {
    "name": "recontact_confirm",
    "language": { "code": "en_US" },
    "components": [
      {
        "type": "body",
        "parameters": [
          { "type": "text", "text": "Alice" },
          { "type": "text", "text": "10:00" }
        ]
      },
      {
        "type": "button", "sub_type": "quick_reply", "index": "0",
        "parameters": [{ "type": "payload", "payload": "{\"value\":\"Yes\",\"ref\":\"<field ref>\"}" }]
      },
      {
        "type": "button", "sub_type": "quick_reply", "index": "1",
        "parameters": [{ "type": "payload", "payload": "{\"value\":\"No\",\"ref\":\"<field ref>\"}" }]
      }
    ]
  }
}
```

Deliberate differences from the Messenger send shape (both mandated by the
respective APIs — see `documentation/utility-messages.md` for the Messenger
rejections that pin its shape):

| | Messenger | WhatsApp |
|---|-----------|----------|
| Envelope | `message.template` + top-level `messaging_type: UTILITY` | top-level `type: "template"` + `template`; no messaging_type concept |
| Body component | always present, even with zero params | **omitted when there are no params** (WhatsApp rejects an empty parameters array) |
| Buttons | ONE `buttons` component, positional POSTBACK parameters, payload = bare `ref` (the value half is baked at approval) | one component **per button** with `sub_type: quick_reply` and string `index`; payload = full `{"value":...,"ref":"..."}` JSON (nothing is baked at approval) |

The per-button payload is exactly the JSON Messenger quick replies deliver
(`buildQuickReplyPayload`), so when the user taps, the webhook's button
payload parses through replybot's existing quick-reply handling unchanged.

The existing WhatsApp echo emission (`worker.go emitWhatsAppEcho`) applies
to template sends too — the survey state machine advances off the emitted
`bot_echo` exactly as for free-form WhatsApp sends.

---

## Dashboard-client

`src/containers/MessageTemplates/` lists and creates templates for **both**
account kinds. `accounts.js` merges `/media/pages` (Facebook pages) with
`/credentials` filtered to `entity: whatsapp_business` (labelled
`WhatsApp <display_phone_number || phone_number_id>`). Selecting a WhatsApp
account shows an informational banner (WABA-level creation, required sample
values, quick-reply buttons); the form itself is shared — sample-value
inputs already appear for any body with `{{n}}` placeholders, which both
platforms require server-side.

---

## Failure modes (fail fast, no silent fallbacks)

| Symptom | Cause |
|---------|-------|
| 400 "missing details.waba_id" on any template operation | `whatsapp_business` credential lacks `details.waba_id`. Reconnect the number via Embedded Signup, or add `waba_id` to the credential details (Track A). |
| 400 "examples must provide N sample value(s)" | Body has `{{n}}` placeholders but no examples — WhatsApp rejects such templates, so the API refuses before calling Meta. |
| Send error `ErrMissingUtilityTemplate` / `ErrMissingUtilityLanguage` | Survey field metadata lacks `template` or `language` — both are required, no defaults. |
| Send fails with template-not-found from Meta | The (name, language) pair doesn't match an APPROVED template on the number's WABA. Check spelling/language and approval status in the dashboard. |
| Delete appears to succeed but the template survives on Meta | Would indicate delete was called without `name` — WhatsApp's hsm_id delete requires the name too. The dashboard always sends both. |
| Meta 409/duplicate on create from a second number | Same (name, language) already exists on the shared WABA (see "one WABA, many numbers" note above). |
