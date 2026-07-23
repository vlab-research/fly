# Platform Abstraction — Current State & WhatsApp Roadmap

## Status: Platform Abstraction Complete (Messenger & WhatsApp)

**Scope:** Everything described in this document is implemented on the `feature/whatsapp-platform-keying` branch. On `main`, replybot still emits Facebook-native payloads (`type: 'native'`) and message-worker forwards them without translation — there is no platform abstraction on main.

The platform abstraction layer is fully implemented and tested for both Messenger and WhatsApp platforms. This document describes what was done, the current architecture, and the account ID keying model that unifies multi-platform routing.

---

## What Was Done

### Inbound: UniversalEvent Normalization

On the branch, all events entering the replybot are normalized to `UniversalEvent` format by `replybot/lib/event-normalizer.js`. The replybot's state machine (`machine.js`) no longer reads raw Messenger fields — it operates entirely on `event_type` strings and typed `payload` objects.

**Before:** `exec()` checked `nxt.message.quick_reply`, `nxt.postback.payload`, `nxt.pass_thread_control`, etc.
**After:** `exec()` checks `nxt.event_type` (`'user_text'`, `'user_interaction'`, `'handover'`, etc.) and reads from `nxt.payload`.

### Outbound: MessageContent + Typed Commands

On the branch, the replybot produces platform-agnostic `MessageContent` objects and typed commands instead of Facebook-native message structures.

**Before:** `respond()` returned `{ recipient: { id }, message: { text, metadata: '{"ref":"..."}' } }`, and `buildCommands()` produced `{ type: "native", message: { ... facebook payload ... } }` or `{ type: "pass_thread_control", ... }`.

**After:** `respond()` returns `MessageContent` objects (`{ type: 'text', text, metadata: { ref, type } }`), and `buildCommands()` produces:
- `SendMessageCommand { type: "send_message", message: MessageContent, platform, platform_account_id, platform_context? }`
- `HandoffCommand { type: "handoff", target_app_id, metadata }`

### Cleanup

- **Deleted:** `messenger/index.js` (getUserInfo), `chat-log/publisher.js`, `tokenstore.js`
- **Removed packages:** `@vlab-research/translate-typeform`, `@vlab-research/utils` from replybot
- **Ported locally:** `addCustomType`, `parseNumber`, `normalizeUnicodeNumerals`, `normalizePhone`, `validator`, `defaultMessage`/`followUpMessage`/`offMessage`, `translateTypeformField`
- **Removed:** `getUserInfo()`, `getPageToken()`, `TokenStore`, `publishChatLog`, `getHandoffFromMessage()`

### Handoff Redesign

Handoff is now a first-class field type with `action: 'HANDOFF'` (new on this branch):
1. User answers question before handoff field → RESPOND → sends handoff message as text
2. Echo of handoff message arrives → ECHO handler detects `md.type === 'handoff'` → returns `action: 'HANDOFF'`
3. `apply()` transitions to `WAIT_EXTERNAL_EVENT` with synthesized `wait: { type: 'handover' }`
4. `act()` returns `{ messages: [], handoff: _wrapSideEffect(ctx, output.handoff) }`
5. `buildCommands()` produces `HandoffCommand { type: "handoff" }`
6. Handover event returns control → wait fulfilled → survey resumes

This avoids the stuck-handoff bug (firing handoff on send would suppress the echo that arms the wait).

### Pipe Transforms (from main)

`{{hidden:phone|e164}}` syntax in interpolation, with `normalizePhone` ported locally.

### Test Results

- **298 passing, 0 failing** in replybot
- **All Go tests pass** in message-worker
- **6 lint errors** — all pre-existing `fetch` (not from our changes)

---

## Current Architecture

### Inbound Flow (Messenger & WhatsApp)

```
Facebook/WhatsApp Webhook
  ↓
Hermes (handlers.rs)
  │ Tags event with source: "messenger" | "whatsapp"
  │ Stamps phone_number_id (WhatsApp) or page_id (Messenger)
  │ Publishes raw JSON to Kafka
  ↓
Kafka → Replybot (via BotSpine)
  │ parseEvent(rawKafkaEvent) → event-normalizer.js
  │   → parseMessengerEvent() for source: "messenger"
  │   → parseWhatsAppEvent() for source: "whatsapp"
  │   → categorizeMessengerEvent() / categorizeWhatsAppEvent() → { event_type, payload }
  │   Returns UniversalEvent
  ↓
Machine (machine.js)
  │ categorizeEvent(universalEvent) — switch on event_type string
  │ exec(state, universalEvent) — reads from event.payload
  │ apply(state, output) — state transitions
  │ act(ctx, state, output) — produces { messages: MessageContent[], handoff?, payment? }
  ↓
Transition (transition.js)
  │ buildCommands(messages, handoff, user, page, platform)
  │   → SendMessageCommand { type: "send_message", message: MessageContent, platform, platform_account_id }
  │   → HandoffCommand { type: "handoff", target_app_id, metadata }
  ↓
Kafka "commands" topic
  ↓
Message-Worker (Go)
  │ ProcessCommand(json.RawMessage)
  │   type: "send_message" → processSendMessage()
  │     → TranslateToMessenger(cmd) or TranslateToWhatsApp(cmd) → platform API format
  │     → client.SendMessage()
  │   type: "handoff" → processHandoff()
  │     → client.PassThreadControl() (Messenger only; WhatsApp has no thread control)
  │   (no type) → LEGACY path (backward compat)
  ↓
Facebook Messenger API or WhatsApp Cloud API
```

### Key Data Shapes

**UniversalEvent:**
```javascript
{
  event_id: "evt_<uuid>",
  user_id: "<psid>",
  timestamp: 1711100000000,
  source: { type: "messenger" | "whatsapp", account_id: "<page_id|phone_number_id>" },
  event_type: "user_text" | "user_interaction" | "user_media" | "bot_message_sent" | "conversation_started" | "handover" | "optin" | "synthetic_*" | ...,
  payload: { ... typed payload ... },
  raw: { ... original event ... }
}
```

**MessageContent:**
```javascript
{
  type: "text" | "question" | "media",
  text: null,                              // for text type
  question_text: null,                     // for question type
  options: [{ value, label, description }], // for question type
  media_url: null,                         // for media type
  media_type: null,                        // "image" | "video" | "audio" | "file"
  caption: null,                           // for media type
  metadata: { ref, type, ...controlFlags }  // structured object, NOT JSON string
}
```

**SendMessageCommand (Kafka):**
```json
{
  "type": "send_message",
  "command_id": "cmd_<hex>",
  "issued_at": 1711100000000,
  "conversation_id": "user_123",
  "user_id": "user_123",
  "platform": "messenger" | "whatsapp",
  "platform_account_id": "page_456" | "phone_number_id",
  "platform_context": { "one_time_notif_token": "TOKEN123" },
  "message": { "type": "question", "question_text": "...", "options": [...], "metadata": {...} }
}
```

**HandoffCommand (Kafka):**
```json
{
  "type": "handoff",
  "command_id": "cmd_<hex>",
  "issued_at": 1711100000000,
  "user_id": "user_123",
  "platform": "messenger",
  "platform_account_id": "page_456",
  "target_app_id": "263902037430900",
  "metadata": { "source": "replybot", "reason": "escalation" }
}
```

### Files Changed

**New files:**
- `replybot/lib/event-normalizer.js` — parseEvent, parseMessengerEvent, categorizeMessengerEvent
- `replybot/lib/generic-translator.js` — translateTypeformField (MessageContent output)
- `replybot/lib/generic-validator.js` — validator, defaultMessage, followUpMessage, offMessage (works on MessageContent/raw fields)

**Modified files (replybot):**
- `lib/typewheels/machine.js` — categorizeEvent, exec, apply, act, respond, _gatherResponses, _response
- `lib/typewheels/transition.js` — parseEvent, buildCommands, removed getUserInfo/getPageToken/TokenStore
- `lib/typewheels/form.js` — translateField, addCustomType (local), pipe transforms, normalizePhone
- `lib/typewheels/statestore.js` — parseEvent from event-normalizer
- `lib/typewheels/utils.js` — getMetadata reads from UniversalEvent
- `lib/typewheels/waiting.js` — UniversalEvent handover path, removed raw fallback
- `lib/index.js` — removed publishChatLog, VLAB_CHAT_LOG_TOPIC
- `lib/responses/debugger.js`, `responser.js`, `stateman.js` — removed TokenStore
- `lib/spine-supervisor/spine-supervisor.js` — removed TokenStore
- `package.json` — removed @vlab-research/translate-typeform and @vlab-research/utils, added email-validator, phone

**Modified files (message-worker):**
- `types/command.go` — HandoffCommand, PlatformContext, Option.Value as json.RawMessage, MessageContent.Metadata as json.RawMessage
- `worker.go` — two-level dispatch (send_message/handoff/legacy)
- `cmd/message-worker/main.go` — pass json.RawMessage to ProcessCommand
- `messenger_client.go` — FacebookRecipient with OTN, removed SendNativeMessage
- `client.go` — removed SendNativeMessage from interface
- `stub_clients.go` — removed SendNativeMessage
- `translator.go` — json.RawMessage metadata and option values

**Deleted files:**
- `replybot/lib/messenger/index.js`, `messenger.test.js`
- `replybot/lib/chat-log/publisher.js`, `publisher.test.js`
- `replybot/lib/typewheels/tokenstore.js`

**Repo cleanup:**
- Helm values (production, staging) — removed VLAB_CHAT_LOG_TOPIC
- facebot/testrunner/stack.ts — removed chat-log topic forcing
- documentation/chat-message-logging.md — marked deprecated

---

## Account ID Routing & First-Class Platform Credentials

### Overview

Runtime routes all messages by account ID. In the database, the **`credentials` table is keyed by a generic `(platform, account_id)` pair**, where:
- **`platform`** ∈ `{"messenger", "whatsapp", "instagram", "tiktok", ...}` — the messaging platform.
- **`account_id`** is platform-specific: `page_id` for Messenger, `phone_number_id` for WhatsApp, etc.

**Implemented model (`feature/whatsapp-platform-keying`): `credentials.key` IS the account id.** No new columns. For messaging entities, `key` holds the platform account id — the production convention since the dashboard sets `key: id` on connect (verified: 63/63 prod `facebook_page` rows have `key = details->>'id'`). `devops/migrations/20-messaging-account-unique.sql` adds the one schema change, a partial unique index:

```sql
CREATE UNIQUE INDEX unique_messaging_account
  ON chatroach.credentials (key)
  STORING (details, userid)
  WHERE entity IN ('facebook_page', 'whatsapp_business');
```

It enforces the system invariant (below) at registration time — a cross-platform account-id collision fails the INSERT loudly, never misroutes silently — and serves the account→credential lookup index-only. The predicate keeps label-keyed credentials (`api_token`, `reloadly`, `secrets`, `typeform_token`, `facebook_ad_user`) out of the routing namespace.

**System invariant:** account ids are globally unique across messaging platforms. This is not a credentials-local choice — `states` is `PRIMARY KEY (userid, pageid)`, and responses, messages, payment events, and dean's scans all route on the bare account id with no platform field. Credentials is simply where the invariant is *enforced*.

**One uniform lookup, all consumers** (no dual-read, no transition window — correct against pre-existing data as-is):

```sql
WHERE key = $1 AND entity IN ('facebook_page', 'whatsapp_business')
```

| Consumer | Notes |
|----------|-------|
| `message-worker/tokenstore.go` `GetToken(ctx, accountID)` | platform selects the API client (Messenger vs WhatsApp), never the credential |
| `formcentral/db.go` `getSurveyByParams` | pageid on `/surveys` is the account id |
| `dinersclub/provider.go` `GenericGetUser` | `PaymentEvent.Pageid` is the account id |
| `dean/queries.go` `FollowUps` | join `ON pageid = c.key AND c.entity IN (...)` — NOTE: a 9th consumer missed by the original 8-consumer inventory |
| dashboard-server queries (states, templates, media) + dashboard-client UI | DONE (commit `2bea1f8f`): states SCOPE_SQL scopes `states.pageid` via `key` + entity filter; migration 22 renames `media.facebook_page_id` / `message_templates.facebook_page_id` → `account_id` (those tables' own columns, not the credentials computed column); API accepts `accountId` with legacy `pageId` fallback. Hermes tags all inbound events with `source.account_id` (Messenger page_id, WhatsApp phone_number_id). |

**RATIFIED DESIGN DECISION (2026-07-22): account identity = `(allocator, id)`, serialized to one string.**
Considered and decided against the alternative — first-class `(platform, account_id)`
pairs threaded through every key, join, and event schema. Basis:

- *Platform is an attribute of an account, never part of its identity.* The
  namespace that guarantees uniqueness is the **id allocator**, not the
  platform: Meta is ONE allocator issuing page ids and `phone_number_id`s
  from one graph-id space, so a bare Meta id is already unambiguous across
  both Meta platforms. Which platform an id belongs to lives where
  properties live — `credentials.entity`, threaded event attributes,
  `states.platform` (migration 21).
- *Platform-as-attribute is cheap and already done* (migration 21, response
  metadata, event threading). *Platform-as-identity* would require the
  `states` PK rewrite, pair-matching in every join and consumer contract,
  and dual-read windows on three Kafka topics and four service APIs — while
  adding zero behavioral capability over the serialized form, since
  ambiguity is already impossible.
- *Meta is the default (bare-numeric) namespace* — a default that can never
  create ambiguity, per standard serialization practice (E.164, relative
  URIs). An explicit `meta:` prefix would rewrite the entire keyspace to
  disambiguate nothing.
- *Tripwires that reopen the first-class-pair migration:* an allocator whose
  ids cannot be prefix-encoded; a need to shard or segregate data by
  platform; any observed failure of an allocator's id-space uniqueness.

**Account-id namespace policy (standing rule for new platforms):** the bare-numeric namespace is reserved for Meta graph ids (page ids, WhatsApp `phone_number_id` — note WhatsApp is keyed by the Meta graph id, *not* the phone number, which is display metadata). Any platform whose account ids are not Meta graph ids — raw phone numbers (SMS providers), Telegram bot ids, etc. — MUST be namespaced with a channel prefix stamped once at Hermes ingestion (e.g. `sms:+2348012345678`, `tg:7123456789`); the platform's outbound API client strips its own prefix. This matters most for *correlated reuse*: the same physical phone number deliberately used on two channels (`sms:` vs `signal:`) must not collide. A prefixed id is the `(entity, key)` pair encoded into the one opaque string that fits through `states.pageid`, event payloads, and every API that only carries a single account-id field. When the first prefixed entity is added to the index predicate, also add a CHECK (Meta entities `^[0-9]+$`, others `^[a-z]+:`) to turn the convention into a constraint.

**Test-DB gotcha (fixed):** the per-app test initdb concatenates `devops/migrations/*` through `cockroach sql`; migrations 16/17 used unqualified `export_status`, which aborted the run before later migrations applied. They are now qualified (`chatroach.export_status`). Any migration must use fully-qualified `chatroach.` table names or it will break the test bootstrap for everything after it.

### Credential Model By Platform

| Platform | Entity Type | Account ID | Details Example |
|----------|-------------|------------|-----------------|
| Messenger | `facebook_page` | `page_id` (e.g., `'935593143497601'`) | `{ "id": "935593143497601", "name": "My Page", "access_token": "EAAB..." }` |
| WhatsApp | `whatsapp_business` | `phone_number_id` (e.g., `'1023456789'`) | `{ "id": "1023456789", "waba_id": "<waba_id>", "access_token": "EAAB...", "display_phone_number": "+1-234-567-8900" }` |

### How Account ID Flows Through the System

1. **Hermes (ingestion):** Tags inbound events with `source: { type: "messenger" | "whatsapp", account_id: ... }` before publishing to Kafka.
2. **Replybot (normalization):** Normalizes to `UniversalEvent.source.account_id` (generic; platform-agnostic).
3. **Survey resolution (formcentral):** Looks up user by credentials query `WHERE (platform, account_id) = ...` → finds userid → resolves survey by `(shortcode, userid)`.
4. **Message-worker (outbound):** Receives `SendMessageCommand` with `platform` and `platform_account_id` → looks up token by `(platform, platform_account_id)` → sends to platform API.
5. **State scoping (dashboard):** Filters by platform account IDs to scope responses and states.

**Key invariant:** A given `(platform, account_id)` pair belongs to exactly one user. This is enforced by a unique constraint on the credentials table.

### Platform Threading (md.platform)

Platform ('messenger' | 'whatsapp') flows end-to-end as a **conversation attribute**, persisted in state and threaded through synthetic re-entry events (timeouts, follow-ups, payment retries). This ensures WhatsApp conversations routed correctly through async re-entry events, not defaulted to Messenger.

**Persistence & Flow (Commits 0a130a7a, 21-states-platform.sql):**
- Replybot `getMetadata()` persists `md.platform` from `event.source.type` at conversation start (REFERRAL event)
- Survives form stitches and state transitions in Redis and states table
- `states.platform` is a STORED computed column derived from `state_json->'md'->>'platform'` (NULL for legacy rows pre-WhatsApp)
- Consumers default to `COALESCE(platform, 'messenger')` for backward compatibility

**Synthetic Re-Entry Logic (transition.js:32-34):**
- Non-synthetic events: platform = `event.source.type` (direct from normalizer: 'messenger' or 'whatsapp')
- Synthetic events: platform = `state.md.platform` (persisted) → event's optional `platform` hint → fallback 'messenger'
- Fixes a critical bug: WhatsApp synthetic events (dean timeout/follow-up/payment retry) no longer default to Messenger

**Outbound Threading:**
- Replybot passes `platform` to `buildCommands()` → `SendMessageCommand.platform` → Kafka
- Message-worker receives `platform` → routes to correct API client (Messenger API vs WhatsApp Graph API)
- Payment events and dean external events include optional `platform` field for dinersclub routing

**Related docs:** See `replybot/README.md` for platform hint flow; `message-worker/README.md` for GetToken signature.

---

## WhatsApp Implementation (Complete)

This section documents the completed WhatsApp integration on this branch.

### 1. Hermes — WhatsApp Webhook Handler

**File:** `hermes/src/handlers.rs`

Hermes now handles both Messenger and WhatsApp webhooks:

**Endpoints:**
- `GET /webhooks` — Messenger webhook verification (VERIFY_TOKEN)
- `POST /webhooks` — Messenger webhook ingestion (signature verification)
- `GET /whatsapp` — WhatsApp webhook verification (WHATSAPP_VERIFY_TOKEN, separate from Messenger)
- `POST /whatsapp` — WhatsApp webhook ingestion (signature verification)
- `POST /synthetic` — pre-normalized UniversalEvent injection (internal, no signature check)
- `GET /health` — readiness probe (returns 200 when Kafka producer is ready)

**Signature Enforcement:**
- Middleware `require_meta_signature()` enforces X-Hub-Signature-256 (HMAC-SHA256) on both POST routes when `FB_APP_SECRET` is set
- No-op when unset (local dev, testrunner)
- Both Messenger and WhatsApp use the same app secret; signature is computed over the raw request body before parsing

**Environment Variables (hermes/config.rs):**
- `VERIFY_TOKEN` — Messenger webhook token
- `WHATSAPP_VERIFY_TOKEN` — WhatsApp webhook token (optional; if absent, /whatsapp verification always fails)
- `FB_APP_SECRET` — optional signature enforcement secret (both platforms)
- `KAFKA_BROKERS` — comma-separated broker list
- `BOTSERVER_EVENT_TOPIC` (or `VLAB_EVENT_TOPIC`) — Kafka topic for events
- `PORT` — HTTP listen port (default 3000)
- `DASHBOARD_URL` — unused in hermes (placeholder for future template status polling)
- `AUTH0_DASHBOARD_SECRET` — unused in hermes

**WhatsApp Event Stamping (event.rs `stamp_whatsapp_event`):**
- Extracts `metadata.phone_number_id` from the incoming payload
- Stamps `source: 'whatsapp'` and `phone_number_id` before Kafka publish
- Publishes to the event topic as-is; replybot's event-normalizer handles parsing

**Shared Router (build_router):**
- Built from tests and main.rs identically, ensuring test paths exercise production routing
- Middleware layers (signature verification) apply to both POST handlers

### 2. Replybot Event Normalizer — WhatsApp Parser

**File:** `replybot/lib/event-normalizer.js`

WhatsApp event parsing implemented alongside Messenger:

**event_type mapping for WhatsApp:**

| WhatsApp field | event_type | payload shape |
|---|---|---|
| `messages[].text.body` | `user_text` | `{ type: "user_text", text }` |
| `messages[].interactive.button_reply` | `user_interaction` | `{ type: "user_interaction", value, label, interaction_type: "button_reply" }` |
| `messages[].interactive.list_reply` | `user_interaction` | `{ type: "user_interaction", value, label, interaction_type: "list_reply" }` |
| `messages[].image/video/document/audio/voice` | `user_media` | `{ type: "user_media", attachments: [{ type, url }] }` |
| `messages[].location` | (currently ignored) | N/A |
| `messages[].contacts` | (currently ignored) | N/A |
| `messages[].referral` | `conversation_started` | `{ type: "conversation_started", trigger: "referral", referral: { ref: "form.<SHORTCODE>" } }` |
| `statuses[].status: "delivered"` | `bot_message_delivered` | `{ type: "bot_message_delivered", watermark, delivered_at }` |
| `statuses[].status: "read"` | `bot_message_read` | `{ type: "bot_message_read", watermark, read_at }` |
| `statuses[].status: "sent"` | `bot_message_sent` | `{ type: "bot_message_sent", ... }` (for echo tracking) |

**Key differences from Messenger:**
- No `quick_reply` — WhatsApp uses `interactive.button_reply` and `interactive.list_reply` instead
- No `postback` — WhatsApp uses button/list replies
- No `pass_thread_control` — WhatsApp doesn't have thread control (handoff not currently supported)
- `user_id` is the sender's WhatsApp phone number (from `messages[].from`)
- `account_id` is the WhatsApp Business phone number ID (from metadata)
- No `optin` / `one_time_notif_token` — WhatsApp has no OTN equivalent

**Dispatcher in parseEvent():**
```javascript
function parseEvent(rawKafkaEvent) {
  const data = JSON.parse(rawKafkaEvent)
  const source = data.source
  
  switch (source) {
    case 'messenger':
      return parseMessengerEvent(data, data.timestamp)
    case 'whatsapp':
      return parseWhatsAppEvent(data, data.timestamp)
    case 'synthetic':
      return parseSyntheticEvent(data, data.timestamp)
    default:
      // error handling
  }
}
```

### 3. Replybot Platform Threading & Synthetic Re-Entry

**File:** `replybot/lib/typewheels/transition.js:32-34`, `lib/typewheels/utils.js`

Platform is now threaded through synthetic events:
- Conversation start captures `md.platform` from `event.source.type` (Messenger or WhatsApp)
- Dean timeouts, follow-ups, and payment retries carry the persisted platform forward
- Fallback chain for synthetic events: `state.md.platform` → `event.platform` hint → `'messenger'`

### 4. Message-Worker — WhatsApp API Client & Translation

**Files:** `message-worker/translator_whatsapp.go`, `message-worker/stub_clients.go`, `message-worker/worker.go`

WhatsApp translation and client stubs already exist from Phase 1:

| Message Type | WhatsApp Translation |
|----------|----------|
| Text | `type: "text"` with `body` |
| Question (≤3 options) | `type: "interactive"` with `button` sub_type |
| Question (4-10 options) | `type: "interactive"` with `list` sub_type |
| Question (>10 options) | Error: `ErrTooManyOptions` |
| Media | Type-specific field (`image`, `video`, `audio`, `document`) |
| Utility Message (template) | See `documentation/whatsapp-templates.md` |

The router in `worker.go` dispatches:
- `platform: "messenger"` → MessengerClient.SendMessage
- `platform: "whatsapp"` → StubClient (to be replaced with real WhatsAppClient)

**Stub Client:** `stub_clients.go` provides `StubWhatsAppClient` for testing/staging. Production requires a real `WhatsAppClient` implementing the Cloud API format (recipient `to: phone`, `messaging_product: "whatsapp"`, etc.).

### 5. Template Message Support

**Files:** 
- `message-worker/translator_whatsapp.go` — `translateWhatsAppTemplate` emits WABA-level template sends
- `documentation/whatsapp-templates.md` — complete guide to WhatsApp template authoring, identity model, and dashboard integration
- `documentation/utility-messages.md` — Messenger utility templates (unchanged); note cross-reference to WhatsApp model

**WhatsApp Template Send Shape:**
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
      { "type": "body", "parameters": [ { "type": "text", "text": "<param>" } ] },
      { "type": "button", "sub_type": "quick_reply", "index": "0", 
        "parameters": [ { "type": "payload", "payload": "{\"value\":\"Yes\",\"ref\":\"<field ref>\"}" } ] }
    ]
  }
}
```

### 6. WhatsApp Entry-Point Behavior

Three distinct paths initiate WhatsApp surveys, all routing through the same REFERRAL handler in `machine.js`:

**Entry Path 1: Click-to-WhatsApp (CTWA) Referral Object (Production)**

User clicks a CTWA ad or explicit Meta referral link. The inbound webhook carries `messages[].referral: { ref: "form.<SHORTCODE>" }`. Event-normalizer's `categorizeWhatsAppEvent` (line 248-259) recognizes the referral object, synthesizes `event_type: 'conversation_started'`, and passes `payload.referral.ref` to machine.js REFERRAL handler. Survey starts with no-retake enforcement.

**Entry Path 2: Bare-Text Reference Token (wa.me links, manual typing, smoke tests)**

Message body matches the strict pattern `/^(?:start\s+)?form\.([A-Za-z0-9_-]+)$/i` (case-insensitive, full-match after trim). Event-normalizer's `categorizeWhatsAppEvent` (line 270-287) tests the text when there is no referral object. On match, synthesizes `event_type: 'conversation_started'`, `payload.referral.ref: "form.<shortcode>"` identically to the CTWA path. Survey starts with no-retake enforcement.

Valid patterns: `form.flysmoke`, `FORM.FLYSMOKE`, `start form.myform`, `START FORM.MYFORM`

Invalid (no match): `tell me form.flysmoke` (extra text), `form.` (incomplete). Surrounding whitespace is fine — the body is trimmed before matching.

**Why strict full-match:** Prevents mid-survey user replies from accidentally re-triggering entry. An existing user answering "form.myform" must not be interrupted.

**Entry Path 3: Pre-Normalized UniversalEvent (/synthetic, Staging/Testing)**

POST a fully-formed UniversalEvent to `POST /synthetic` with `source.type: 'whatsapp'`, `event_type: 'conversation_started'`, `payload.referral.ref: "form.<SHORTCODE>"`. Hermes publishes to Kafka as-is; replybot routes to REFERRAL handler. No Meta webhook setup required; enables repeatable testing.

**Non-Entry: Plain Text Not Matching Pattern**

Inbound text without a referral object that does NOT match the form-ref pattern (e.g., "hi", "help") normalizes as `event_type: 'user_text'`. Machine's TEXT handler finds no active conversation and ignores (no-op). User receives no reply. This is intentional: WhatsApp is customer-service-driven, not broadcast-driven. Users must explicitly request a survey via an entry point.

### 7. Token Store & Credential Lookup

**File:** `message-worker/tokenstore.go`

The token store's `GetToken(ctx, accountID)` signature unchanged; dispatcher logic selects platform-specific credentials:
- `messenger` + `account_id` → look up `facebook_page` entity
- `whatsapp` + `account_id` → look up `whatsapp_business` entity
- No platform hint → fall back to uniform `WHERE key = $1 AND entity IN (...)` query (safe due to unique_messaging_account index)

---

## Consumer Status

| Consumer | Status | Notes |
|----------|--------|-------|
| **Hermes** | ✅ DONE | GET/POST /whatsapp endpoints, signature verification, phone_number_id stamping |
| **Replybot event-normalizer** | ✅ DONE | parseWhatsAppEvent, WhatsApp event_type mapping |
| **Replybot platform threading** | ✅ DONE | md.platform persisted, synthetic re-entry routing via state |
| **Message-worker translation** | ✅ DONE | TranslateToWhatsApp text/question/media/template |
| **Message-worker routing** | ✅ DONE | ProcessCommand dispatches platform → API client |
| **Dashboard-server** | ✅ DONE | States and templates scoped by account_id + entity; API accepts accountId |
| **Dashboard-client** | ✅ DONE | Message-templates UI supports WhatsApp accounts; template status polling |
| **TokenStore** | ✅ DONE | GetToken resolves messaging credentials by platform + account_id |

---

## Known Limitations & Non-Implementations

### Handoff / Thread Control

WhatsApp has no equivalent to Messenger's `pass_thread_control` API. Handoff fields are not currently handled on WhatsApp. To implement:
1. Replybot would need to NOT emit a HandoffCommand for WhatsApp (or emit a WhatsApp-flavored variant)
2. Alternative: use metadata-based handoff where an external app reads metadata and coordinates via shared state
3. Status: **Deferred** — no production WhatsApp surveys require handoff yet

### Location & Contact Sharing

WhatsApp inbound events can carry `location` and `contacts` payloads. These are currently recognized by the normalizer but mapped to UNKNOWN event_type (no-op). If surveys need these, add `LOCATION` and `CONTACTS` event categories to machine.js.

### One-Time Notifications

Messenger's `optin` events (one_time_notif_token) have no WhatsApp equivalent. Messenger-only feature; WhatsApp users cannot opt into OTN.

---

## Key Insight: The Core Is Now Truly Platform-Agnostic

The most important outcome of the platform abstraction work is that **the replybot's core state machine logic (`machine.js`) and message-worker routing are completely platform-agnostic.** All platforms now:
- Normalize to UniversalEvent before the state machine sees them
- Use platform-agnostic MessageContent for sends
- Thread platform through commands for proper routing
- Use uniform account-id keying for credential lookup

Adding a third platform (Instagram, TikTok, SMS, etc.) requires:
1. A new **inbound parser** (parseInstagramEvent, etc.) in event-normalizer.js
2. A new **outbound translator** (TranslateToInstagram, etc.) in message-worker
3. A new **webhook handler** in Hermes (if applicable) or an adapter that stamps events before publishing to Kafka
4. A new **API client** in message-worker if not using a shared wrapper

The state machine, form system, validation, and payment logic stay the same. This is exactly what the platform abstraction was designed to enable.
