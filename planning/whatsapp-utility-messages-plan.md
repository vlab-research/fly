# WhatsApp Utility Messages — Implementation Plan

## Goal

Extend the Messenger utility-messages feature to WhatsApp Business: let users
author approved templates in the dashboard, and send template messages via
survey flows using `fly-message-worker` (Go) as the outbound sender.

## What we're building on

The Messenger implementation (`documentation/utility-messages.md`) already
nailed the hard parts: the `(account_id, name, language)` identity model, the
template authoring UI, placeholder validation, the `{{N}}` in POSTBACK payload
trick, webhook-subscription gating, and the approval-polling loop. The
template-creation API at `POST /{id}/message_templates` is **the same Graph
API endpoint** for both platforms — only the resource (Page vs WABA) differs.

What doesn't carry over is the send side: WhatsApp uses a different endpoint
(`/{PHONE_NUMBER_ID}/messages`), different recipient identifier (E.164 phone
number, not PSID), and different inbound webhook shape for button taps.

## Scope

In:
- WhatsApp template authoring (UTILITY category first — MARKETING /
  AUTHENTICATION can follow)
- Sending approved templates from message-worker
- Receiving button taps and routing them through replybot's existing
  survey state machine

Out (initially):
- Non-template WhatsApp messaging (the translator scaffolding already handles
  text / interactive / media; that path is separate and unaffected by this
  plan)
- MARKETING and AUTHENTICATION template categories — UTILITY only for v1
- Media components (header image/video) — body + buttons only for v1

## Architecture delta

| Layer | Messenger (today) | WhatsApp (add) |
|---|---|---|
| OAuth scope | `pages_utility_messaging` | `whatsapp_business_management` + `whatsapp_business_messaging` |
| Connect flow | `/connect/facebook-messenger` → Page picker | new `/connect/whatsapp` → WABA picker → phone-number picker |
| Credential key | `facebook_page_id` | WABA ID + phone-number ID (needs both) |
| Template endpoint | `POST /{pageId}/message_templates` | `POST /{wabaId}/message_templates` |
| Button types accepted | POSTBACK only (QUICK_REPLY rejected) | QUICK_REPLY *and* URL *and* PHONE_NUMBER |
| Send endpoint | `POST /me/messages` via replybot | `POST /{phoneNumberId}/messages` via message-worker |
| Send payload | `messaging_type: UTILITY` + `template_type: utility_messages` | `type: template` + `template: {name, language, components}` |
| Recipient | PSID | E.164 phone number |
| Button-tap webhook | `messaging_postbacks` → replybot's POSTBACK branch | `messages` with `interactive.button_reply` → replybot needs new branch |

## Data model

Rename or generalise `chatroach.message_templates.facebook_page_id` —
currently it's the only account-key column. Two reasonable shapes:

**Option A: single column, semantic name.** Rename to `platform_account_id`
+ add `platform` column (`messenger` | `whatsapp`). WhatsApp rows store the
WABA ID. For WhatsApp sends we additionally need a phone-number ID; those
can live in a separate `whatsapp_phone_numbers` table keyed by
(`platform_account_id`, `phone_number_id`), populated from the Graph API
`/{waba_id}/phone_numbers` edge at connect time.

**Option B: two tables.** Keep Messenger's table untouched; add
`whatsapp_message_templates` with its own unique constraint
`(waba_id, name, language)` and FKs. More code duplication, less migration risk.

Leaning A. The Messenger feature is young enough that migration is cheap,
and a unified `platform_account_id` matches how message-worker already
treats credentials (`tokenstore.go:65-93` uses a single generic key).

New tables we'll likely need regardless of A/B:

- `whatsapp_phone_numbers` — `(platform_account_id, phone_number_id, display_number, verified_name)`; populated at connect time, read at send time.

## Per-layer work

### 1. OAuth & connect flow (dashboard-client)

New container `/connect/whatsapp`. Requests scopes:
`whatsapp_business_management`, `whatsapp_business_messaging`, `business_management`.
After FB Login:
- List user's WABAs: `GET /me/businesses` → per business: `GET /{business_id}/owned_whatsapp_business_accounts`
- Let user pick a WABA
- For the chosen WABA, list its phone numbers: `GET /{waba_id}/phone_numbers`, let user pick one (usually one, but WABAs can have multiple)
- Store credential: `entity='whatsapp_account'`, `key=waba_id`, `details={access_token, waba_id, phone_number_id, display_number}`
- Subscribe app to WABA: `POST /{waba_id}/subscribed_apps` (needed for incoming webhooks and template-status updates)

### 2. Template authoring (dashboard-server + dashboard-client)

Reuse `buildFacebookCreatePayload` nearly verbatim. Three small deltas:
- Accept a `platform` field; route to `/{wabaId}/message_templates` for WhatsApp
- Optionally let buttons be `QUICK_REPLY` instead of `POSTBACK` when
  `platform === 'whatsapp'` (WhatsApp accepts QUICK_REPLY at creation). But
  for consistency with Messenger and to keep translate-typeform symmetric,
  I'd stick with POSTBACK on WhatsApp too — simpler, one code path
- Resource identity becomes `(waba_id, name, language)`; server must validate
  the credential lookup uses the right platform

UI delta: page picker → source picker that lists connected pages and
connected WABAs together, tagged by platform. Same body / examples /
buttons form for both.

### 3. Send-time translator (new package or extend translate-typeform)

Add `translateWhatsappUtilityMessage(data, ref)` emitting:

```json
{
  "messaging_product": "whatsapp",
  "to": "<E.164 phone>",
  "type": "template",
  "template": {
    "name": "<template name>",
    "language": { "code": "en_US" },
    "components": [
      { "type": "body", "parameters": [ {"type": "text", "text": "<param>"} ] },
      { "type": "button", "sub_type": "postback", "index": 0, "parameters": [ {"type": "payload", "payload": "<ref>"} ] }
    ]
  }
}
```

Note that for WhatsApp the button parameter type is `payload` (not `text`
like Messenger). The placeholder-substitution mechanism still works the
same — it just uses a different parameter type inside.

### 4. Send dispatch (message-worker)

Currently `stub_clients.go:49-58` returns "not yet implemented" for
WhatsApp. Replace with a real `WhatsappClient`:

- Endpoint: `POST https://graph.facebook.com/{version}/{phone_number_id}/messages`
- Auth: `Authorization: Bearer <token>` from `tokenstore.GetToken(ctx, platform_account_id)`
- Payload: the translator's output (above)

Extend `MessageContent` (`types/command.go`) with a template variant, or
reuse `MessageTypeNative` for pre-formatted template payloads emitted by
replybot's upstream. Simpler: reuse `native`.

Upstream (replybot's outgoing-message producer) needs to know how to
build the WhatsApp template command. Easiest: have translate-typeform
emit a `native` message with the full WhatsApp template payload, and
replybot packages it as `SendMessageCommand{platform: 'whatsapp',
platform_account_id: '<waba_id>', message: {type: native, payload: ...}}`.

### 5. Inbound webhook handling (replybot)

WhatsApp button taps arrive as a `messages` webhook with
`entry[].changes[].value.messages[].interactive.button_reply = {id, title}`.
The `id` is the button's approved payload (our baked `{"value":"<label>","ref":"{{1}}"}`
with `{{1}}` substituted to the real field ref).

New branch in replybot's event classifier:
- Recognise `interactive.button_reply` → extract `id`, JSON-parse
- Produce the same internal shape as the Messenger POSTBACK branch:
  `{ action: 'RESPOND', response, responseValue, question }`

Since `recursiveJSONParser` already auto-parses nested JSON, most of the
existing POSTBACK handler can be shared. The classifier at
`replybot/lib/typewheels/machine.js:185` (sets `'POSTBACK'` from
`nxt.postback`) is where the new branch slots in — returning `'POSTBACK'`
for a `messages.interactive.button_reply` event lets the existing case
at `machine.js:463-471` handle it without modification.

### 6. Webhook subscription

`/{waba_id}/subscribed_apps` should include:
- `messages` (inbound messages + button taps)
- `message_template_status_update` (approval/rejection)

## Sequencing

Proposed phases, each independently shippable:

**Phase 1 — Connect + template authoring (dashboard only).**
New `/connect/whatsapp` flow. WABA + phone-number pickers. Credentials
saved. Template authoring UI works end-to-end against the WhatsApp Graph
API. No sending yet. Users can see APPROVED templates but trying to use
one in a survey is a no-op. Gets the UX validated and the permission
grants through app review.

**Phase 2 — Send side (message-worker + translate-typeform).**
Implement `WhatsappClient` in message-worker. Add the WhatsApp
template translator. Wire replybot's outgoing-message producer to
emit a `whatsapp` `SendMessageCommand` when it hits a `utility_message`
field on a WhatsApp platform account. Sends go out; button taps are
still lost.

**Phase 3 — Inbound button taps (replybot).**
Add the `interactive.button_reply` webhook classifier branch.
Survey flows now close the loop.

## Open questions

1. **Unified template authoring UI or two tabs?** One combined list (tag
   each row by platform) keeps the dashboard clean. Two tabs is more
   conservative. Lean: one list.

2. **Platform-specific name collisions.** Facebook enforces uniqueness
   per `(account_id, name, language)` on each side independently, but a
   single user might have both a Page and a WABA and create a template
   named `prize_ready` on both. Our DB unique constraint needs to match
   Facebook's scope — unique on `(platform_account_id, name, language)`,
   not globally.

3. **Button POSTBACK vs QUICK_REPLY on WhatsApp.** Both work at template
   creation. POSTBACK keeps the code path symmetric with Messenger
   (good for `translateUtilityMessage` reuse). QUICK_REPLY is the "native"
   WhatsApp interactive experience. I'd pick POSTBACK for v1 unless
   UX testing says otherwise.

4. **Phone number verification.** Brand-new WABAs require phone-number
   verification before they can send. The connect flow should surface
   verification status so users know why sending might fail.

5. **OAuth review cycle.** `whatsapp_business_management` needs app
   review; we may hit the same "Standard Access granted in UI but not
   in backend" issue we saw with `pages_utility_messaging`. Budget a
   week of Meta support back-and-forth.

## Effort estimate (rough)

- Phase 1: 2–3 days of focused work + days-to-weeks waiting on app review
- Phase 2: 2–3 days (translator + Go client + wiring)
- Phase 3: 0.5–1 day (one new classifier branch)

Unknown: app-review timeline for the WhatsApp permissions.
