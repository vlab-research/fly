# Platform Abstraction — Consolidated Implementation Plan

**Branch:** `feature/platform-abstraction` (from `feature/message-worker-extraction`)
**Goal:** Abstract both inbound and outbound message flows so adding WhatsApp/Instagram/TikTok requires only new platform parsers and translators — no changes to core state machine logic.

This plan merges the original `platform-abstraction-plan.md` with all 8 resolved open questions. It is self-contained and ready for implementation.

---

## Table of Contents

1. [Key Design Decisions](#key-design-decisions)
2. [Target Architecture](#target-architecture)
3. [Files to Create](#files-to-create)
4. [Files to Modify](#files-to-modify)
5. [Files to Delete](#files-to-delete)
6. [Implementation Order](#implementation-order)
7. [Testing & Deployment Strategy](#testing--deployment-strategy)

---

## Key Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Inbound direction | Full normalization to UniversalEvent | Port `parse_messenger_event()` from rust-machine. State machine sees only normalized `event_type` strings + typed payloads. |
| Outbound direction | New `generic-translator.js` producing `MessageContent` | Replaces `@vlab-research/translate-typeform`'s Facebook-native output. Clean break. |
| Translate-typeform | KILL ENTIRELY from replybot | Port all needed functions locally: `addCustomType`, `parseNumber`, `normalizeUnicodeNumerals`, `validator` logic, `defaultMessage`/`followUpMessage`/`offMessage`. Facebot/testrunner keeps using the package for test event generation (separate concern). |
| Validator | New `generic-validator.js` | Works on `MessageContent` — no Facebook-native structures. Port the validation logic that's currently Facebook-coupled. |
| getUserInfo | Replace with `{ id: userId }` | Only `user.id` (PSID) is actually used. Profile data (name, first_name, last_name) is unused. |
| getPageToken | Remove from replybot | Token lookup is message-worker's job. |
| getPageFromEvent | Replace with `event.source.account_id` | Normalizer extracts page_id for all event types including echo (sender/recipient swap) and synthetic. |
| parseEvent | Replace entirely (Option B) | Our `parseEvent(rawString)` does single JSON.parse then dispatches to platform normalizers. Handles double-encoded JSON strings internally (like Rust reference). No `recursiveJSONParser` from `@vlab-research/utils`. Both fresh and replay paths use this one function. |
| @vlab-research/utils | Remove entirely from replybot | `parseEvent` and `getPageFromEvent` both replaced. Chat-log publisher deleted. |
| Platform-specific escape hatch | `platform_context` on SendMessageCommand | Generic object for platform-specific delivery instructions (OTN tokens for Messenger, etc.) |
| Handoff | Separate `HandoffCommand` | Two-level dispatch: command type → message type. Cleaner than polluting MessageContent. |
| Chat-log publisher | DELETE entirely | Full cleanup: code, Helm values, docs, facebot stack.ts. No longer needed. |
| Deployment | Message-worker dual-format support | Old commands (no top-level `type` field) vs new commands (`"send_message"`/`"handoff"`) are trivially distinguishable. Deploy message-worker first, then replybot. |

---

## Target Architecture

```
BotServer (Node.js) — UNCHANGED
  │ Still receives Facebook webhooks, adds source: "messenger"
  │ Publishes to Kafka
  ↓
Kafka → Replybot (Node.js, via BotSpine/SpineSupervisor)
  │ NEW: parseEvent() from event-normalizer.js → UniversalEvent
  │   - parseMessengerEvent() for source: "messenger"
  │   - parseSyntheticEvent() for source: "synthetic"
  │   - (stubs for source: "whatsapp", "instagram")
  │ NEW: categorizeEvent() matches on event.event_type string, NOT raw Messenger fields
  │ exec(state, universalEvent) — reads from event.payload (typed), not raw fields
  │ apply(state, output) — unchanged
  │ actionsResponses() — NO getUserInfo(), NO getPageToken()
  │   user = { id: userId }
  │   page = event.source.account_id
  │ act() → generic-translator.js → MessageContent (platform-agnostic)
  │ respond() — NO recipient addition (goes in command envelope)
  │ _gatherResponses() — produces MessageContent[] instead of Facebook-native messages
  │ Validation → generic-validator.js (works on MessageContent)
  │ buildCommands() produces:
  │   SendMessageCommand { type: "send_message", message: MessageContent, platform_context? }
  │   HandoffCommand { type: "handoff", target_app_id, metadata }
  │ publishCommands() → Kafka "commands" topic
  │ Also: publishState, publishResponses, publishPayment (unchanged)
  │ REMOVED: publishChatLog
  ↓
Kafka "commands" → Message-Worker (Go, burrow pool of 100 workers)
  │ NEW: Two-level dispatch with backward compat:
  │   type: "send_message" → route by message.type (text/question/media)
  │     → processTranslatedMessage() → TranslateToMessenger/WhatsApp/Instagram()
  │     → client.SendMessage() (constructs recipient from user_id or platform_context)
  │   type: "handoff" → processHandoff() → client.PassThreadControl()
  │   (no type field) → LEGACY: route by message.type (native/pass_thread_control)
  │   REMOVED later: processNativeMessage(), MessageTypeNative (after transition confirmed)
  │ On failure: reportError() → botserver /synthetic → same error feedback loop
  ↓
Platform API (Messenger, WhatsApp, Instagram, etc.)
```

### Target Kafka Command Formats

**SendMessageCommand (question):**
```json
{
  "type": "send_message",
  "command_id": "cmd_<hex>",
  "issued_at": 1711100000000,
  "conversation_id": "user_123",
  "user_id": "user_123",
  "platform": "messenger",
  "platform_account_id": "page_456",
  "message": {
    "type": "question",
    "question_text": "What is your gender?",
    "options": [
      { "value": "male", "label": "Male", "description": null },
      { "value": "female", "label": "Female", "description": null }
    ],
    "metadata": { "ref": "gender", "type": "multiple_choice" }
  }
}
```

**SendMessageCommand (with OTN via platform_context):**
```json
{
  "type": "send_message",
  "command_id": "cmd_<hex>",
  "issued_at": 1711100000000,
  "conversation_id": "user_123",
  "user_id": "user_123",
  "platform": "messenger",
  "platform_account_id": "page_456",
  "platform_context": { "one_time_notif_token": "TOKEN123" },
  "message": {
    "type": "question",
    "question_text": "Ready to continue?",
    "options": [{ "value": "yes", "label": "Yes" }],
    "metadata": { "ref": "continue_q", "type": "welcome_screen" }
  }
}
```

**HandoffCommand:**
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

### UniversalEvent Shape

```javascript
{
  event_id: "evt_<uuid>",
  user_id: "<psid>",
  timestamp: 1711100000000,
  source: { type: "messenger", account_id: "<page_id>" },
  event_type: "user_text" | "user_interaction" | "user_media" | "bot_message_sent" | "conversation_started" | ...,
  payload: { ... typed payload ... },
  raw: { ... original event ... }
}
```

### MessageContent Shape

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

### Messenger event_type Mapping (Complete)

| Messenger field | event_type | payload shape |
|-----------------|------------|---------------|
| `message.text` (no quick_reply, not echo) | `user_text` | `{ type: "user_text", text }` |
| `message.quick_reply` | `user_interaction` | `{ type: "user_interaction", value, label, interaction_type: "quick_reply", source_message_id }` |
| `postback` | `user_interaction` | `{ type: "user_interaction", value, label, interaction_type: "postback", source_message_id }` |
| `message.is_echo` | `bot_message_sent` | echo payload (metadata parsed from JSON string to object) |
| `referral` / `postback.payload === "get_started"` | `conversation_started` | `{ type: "conversation_started", trigger: "referral", referral }` |
| `delivery` | `bot_message_delivered` | `{ type: "bot_message_delivered", watermark, delivered_at }` |
| `read` | `bot_message_read` | `{ type: "bot_message_read", watermark, read_at }` |
| `reaction` | `user_reaction` | `{ type: "user_reaction", reaction, emoji, action }` |
| `message.attachments` | `user_media` | `{ type: "user_media", attachments, stickerId }` |
| `optin` | `optin` | `{ type: "optin", optin_type, token, payload }` |
| `pass_thread_control` | `handover` | `{ type: "handover", previous_owner_app_id, new_owner_app_id, metadata }` |
| Synthetic types | `synthetic_*` | `{ event: { type, value } }` |

---

## Files to Create

### 1. `replybot/lib/event-normalizer.js`

**Purpose:** Parses raw Kafka event JSON into `UniversalEvent`. Replaces `@vlab-research/utils` `parseEvent()` entirely (Option B — single JSON.parse, no `recursiveJSONParser`). Handles double-encoded JSON strings internally.

**Exports:**
- `parseEvent(rawKafkaEvent)` — Dispatches by `source` field. Returns `UniversalEvent`.
- `parseMessengerEvent(data, timestamp)` — Port from Rust `statestore.rs`. Extracts sender/recipient (swaps for echo), calls `categorizeMessengerEvent()`.
- `parseSyntheticEvent(data, timestamp)` — Prefixes event type with `synthetic_`. Extracts `data.page` into `source.account_id`.
- `categorizeMessengerEvent(data)` — Port from Rust. Returns `{ event_type, payload }`.

**Key helpers:**
- `parsePayload(payload)` — Auto-detect JSON string vs object for `quick_reply.payload` and `postback.payload`.
- `newEventId()` — Generate UUID for event tracking.

**CRITICAL: Double-encoded JSON handling.** Facebook sometimes sends `quick_reply.payload` and `postback.payload` as escaped JSON strings. The normalizer must auto-detect and handle both cases. Also parse `message.metadata` from JSON string to object for echo events.

**Event replay compatibility:** This single `parseEvent()` is used for both fresh Kafka events and database-replayed events. Both contain the same raw JSON — no `recursiveJSONParser` means no differences in parsing behavior.

### 2. `replybot/lib/generic-translator.js`

**Purpose:** Port of Rust `translate.rs`. Takes a Typeform field (already run through `addCustomType` + `interpolateField`) and produces `MessageContent`.

**Exports:**
- `translateTypeformField(field)` → `MessageContent`

**Field type mapping:**

| Typeform type | MessageContent type | Notes |
|---------------|---------------------|-------|
| short_text, long_text, number, date, email, phone_number, upload | text | text = field.title, metadata.type = field_type |
| multiple_choice, dropdown, picture_choice | question | options from choices, value = choice.ref or label |
| yes_no | question | options: [true/"Yes", false/"No"] |
| legal | question | options: [true/"I Accept", false/"I don't Accept"] |
| opinion_scale | question | options: numeric strings from start to start+steps-1 |
| rating | question | options: star emoji strings |
| welcome_screen | question | single Continue option |
| statement, wait, stitch | text | metadata includes field.md (wait, keepMoving, etc.) |
| thankyou_screen | text | same as statement |
| share | text | metadata includes url and buttonText |
| webview | text | metadata includes url and buttonText |
| attachment | media | media_url from field.md, media_type default "image" |

**Option value types:**
- `yes_no`/`legal`: boolean `true`/`false`
- `opinion_scale`/`rating`: string numbers `"1"`, `"2"`
- `multiple_choice`/etc: string (choice ref or label)

**Metadata is a structured object** (NOT JSON string):
```javascript
metadata: {
  ref: "gender",
  type: "multiple_choice",
  // Control flags from addCustomType:
  wait: { op: "or", vars: [...] },
  handoff: { target_app_id: "..." },
  payment: { ... },
  keepMoving: true,
  repeat: true,
  isRepeat: true,
  off: true,
  stitch: { form: "...", metadata: {...} },
}
```

### 3. `replybot/lib/generic-validator.js`

**Purpose:** Replaces `validator()` from `translate-typeform`. Works on `MessageContent` — no Facebook-native structures. Ports and refactors the platform-agnostic validation logic.

**Exports:**
- `validator(field, messages)` → `(response) => { valid, message }` — Main dispatch
- `defaultMessage(messages)` → string — Port from translate-typeform (~5 lines)
- `followUpMessage(messages)` → string — Port from translate-typeform (~5 lines)
- `offMessage(messages)` → string — Port from translate-typeform (~5 lines)

**Validator types:**
- **Question types** (multiple_choice, dropdown, yes_no, legal, etc.) — Check if response matches one of `field.options[].value`. No need to inspect `quick_replies` or button templates. Much simpler than the old Facebook-coupled validators.
- **Number** — Read `validate` config from `field.metadata` (structured object, no JSON.parse). Validates range, integer, etc.
- **Phone** — Read `validate` from `field.metadata`. Validates format.
- **Email** — Use `email-validator` package (already in translate-typeform).
- **Upload/Notify** — Read `validate` from `field.metadata`.
- **Text/Statement** — Plain `typeof r === 'string'` checks.

### 4. `planning/platform-abstraction-plan.md` (this file)

Already exists. This document is the consolidated, actionable implementation plan.

---

## Files to Modify

### replybot/lib/typewheels/machine.js

This is the largest change (~900 lines). Key modifications:

**1. Imports:**
```javascript
// REMOVE:
const { validator, defaultMessage, followUpMessage, offMessage } = require('@vlab-research/translate-typeform')

// ADD:
const { validator, defaultMessage, followUpMessage, offMessage } = require('../generic-validator')
const { translateTypeformField } = require('../generic-translator')
```

**2. `categorizeEvent(nxt)` — COMPLETE REWRITE:**
Match on `nxt.event_type` string instead of raw Messenger fields:
```javascript
function categorizeEvent(nxt) {
  switch (nxt.event_type) {
    case 'user_text': return 'TEXT'
    case 'user_interaction':
      return nxt.payload.interaction_type === 'quick_reply' ? 'QUICK_REPLY' : 'POSTBACK'
    case 'user_media': return 'MEDIA'
    case 'user_reaction': return 'REACTION'
    case 'bot_message_sent': return 'ECHO'
    case 'bot_message_delivered': return 'WATERMARK'
    case 'bot_message_read': return 'WATERMARK'
    case 'conversation_started': return 'REFERRAL'
    case 'optin': return 'OPTIN'
    case 'handover': return 'HANDOVER_EVENT'
    case 'synthetic_external': return 'EXTERNAL_EVENT'
    case 'synthetic_timeout': return 'EXTERNAL_EVENT'
    case 'synthetic_machine_report': return 'MACHINE_REPORT'
    case 'synthetic_bailout': return 'BAILOUT'
    case 'synthetic_unblock': return 'UNBLOCK'
    case 'synthetic_follow_up': return 'FOLLOW_UP'
    case 'synthetic_repeat_payment': return 'REPEAT_PAYMENT'
    case 'synthetic_redo': return 'REDO'
    case 'synthetic_platform_response': return 'PLATFORM_RESPONSE'
    case 'synthetic_block_user': return 'BLOCK_USER'
    default: return 'UNKNOWN'
  }
}
```

**3. `exec(state, nxt)` — UPDATE field access paths:**
- `QUICK_REPLY`: `nxt.message.quick_reply.payload.value` → `nxt.payload.value`
- `POSTBACK`: `nxt.postback.payload.value` → `nxt.payload.value`
- `TEXT`: `nxt.message.text` → `nxt.payload.text`
- `MEDIA`: `nxt.message.attachments` → `nxt.payload.attachments`
- `ECHO`: `nxt.message.metadata` (JSON string) → `nxt.payload.metadata` (structured object — no JSON.parse needed)
- `OPTIN`: `nxt.optin` → `nxt.payload` (with `token` instead of `one_time_notif_token`)
- `HANDOVER_EVENT`: `nxt.pass_thread_control` → `nxt.payload`
- `WATERMARK`: rewrite `getWatermark(nxt)` to read from `nxt.event_type` and `nxt.payload.watermark`
- Helper functions `_synth()`, `_externalEvent()`, `_handoverEvent()` — rewrite to check `nxt.event_type`
- `makeEventMetadata(event)` — read from `event.payload` instead of raw fields

**4. `respond(ctx, qa, output)` — REMOVE addRecipient:**
```javascript
// CURRENT:
function respond(ctx, qa, output) {
  const addRecipient = dat => ({ recipient: { id: ctx.user.id }, ...dat })
  return _gatherResponses(ctx, qa, _response(ctx, qa, output))
    .filter(r => !!r)
    .map(r => r.recipient ? r : addRecipient(r))
}
// NEW:
function respond(ctx, qa, output) {
  return _gatherResponses(ctx, qa, _response(ctx, qa, output))
    .filter(r => !!r)
}
```

**5. `_response(ctx, qa, {...})` — return MessageContent with separate token:**
Return `{ message: MessageContent, token: token_or_null }` instead of Facebook-native with embedded `recipient: { one_time_notif_token }`.

**6. `_gatherResponses(ctx, qa, q, previous)` — inspect MessageContent:**
```javascript
// CURRENT:
const msg = q.message
const md = msg && JSON.parse(msg.metadata)

// NEW:
const md = q.metadata  // structured object
```

**7. `repeatResponse(question, text)` and `offResponse(previousQuestion, text)` — return MessageContent:**
```javascript
// CURRENT:
function repeatResponse(question, text) {
  return { message: { text, metadata: JSON.stringify({ repeat: true, ref: question }) } }
}
// NEW:
function repeatResponse(question, text) {
  return { type: 'text', text, metadata: { repeat: true, ref: question } }
}
```

**8. Side effect extraction — `getPaymentFromMessage()` and `getHandoffFromMessage()`:**
Read from `messageContent.metadata.payment` and `messageContent.metadata.handoff` (structured objects, no JSON.parse).

### replybot/lib/typewheels/transition.js

**1. Imports:**
```javascript
// REMOVE:
const { getUserInfo } = require('../messenger')
const { parseEvent, getPageFromEvent } = require('@vlab-research/utils')

// ADD:
const { parseEvent } = require('../event-normalizer')
```

**2. Machine constructor — remove Facebook dependencies:**
- Remove `this.getUser` method
- Remove `this.getPageToken` method
- Remove `TokenStore` from constructor parameters (token lookup is message-worker's job)

**3. `transition(state, parsedEvent)`:**
```javascript
// CURRENT:
const page = getPageFromEvent(parsedEvent)

// NEW:
const page = parsedEvent.source.account_id
```

**4. `actionsResponses()` — remove Facebook API calls:**
```javascript
// CURRENT:
const pageToken = await iowrap('getPageToken', 'INTERNAL', this.getPageToken, pageId)
const user = await this.getUser(userId, pageToken)

// NEW:
const user = { id: userId }
```

**5. `run()` — use new parseEvent:**
```javascript
// CURRENT:
const event = parseEvent(rawEvent)  // from @vlab-research/utils

// NEW:
const event = parseEvent(rawEvent)  // from event-normalizer.js — returns UniversalEvent directly
```

**6. `buildCommands()` — COMPLETE REWRITE:**
Produce `type: "send_message"` + `type: "handoff"` commands instead of `type: "native"` + `type: "pass_thread_control"`.

```javascript
buildCommands(messages, handoff, user, page, platform) {
  const commands = messages.map(({ message, token }) => ({
    type: 'send_message',
    command_id: crypto.randomBytes(8).toString('hex'),
    issued_at: Date.now(),
    conversation_id: user,
    user_id: user,
    platform: platform,        // from UniversalEvent.source.type
    platform_account_id: page, // from UniversalEvent.source.account_id
    message: message,          // MessageContent
    ...(token ? { platform_context: { one_time_notif_token: token } } : {})
  }))

  if (handoff) {
    commands.push({
      type: 'handoff',
      command_id: crypto.randomBytes(8).toString('hex'),
      issued_at: Date.now(),
      user_id: user,
      platform: platform,
      platform_account_id: page,
      target_app_id: handoff.target_app_id,
      metadata: handoff.metadata || {}
    })
  }

  return commands
}
```

**Note:** `messages` array now contains `{ message: MessageContent, token: string|null }` objects (from `_response()`). Platform is no longer hardcoded as `'messenger'`.

### replybot/lib/typewheels/form.js

**1. Imports:**
```javascript
// REMOVE:
const { translator, addCustomType: baseAddCustomType, parseNumber } = require('@vlab-research/translate-typeform')

// ADD (port locally):
const { translateTypeformField } = require('../generic-translator')
// addCustomType, parseNumber, normalizeUnicodeNumerals are now local functions in this file
```

**2. Port functions locally:**
- `addCustomType(field)` — Copy from translate-typeform `index.js` (~60 lines: YAML parsing of `properties.description`, markdown link stripping). Merge with existing local extension for handoff.
- `parseNumber(str, locale)` — Copy from translate-typeform `validator.js` (~40 lines: unicode numeral normalization).
- `normalizeUnicodeNumerals(value)` — Copy from translate-typeform `validator.js` (~20 lines: unicode digit mapping table).

**3. `translateField(ctx, qa, field)`:**
```javascript
// CURRENT:
function translateField(ctx, qa, field) {
  return translator(addCustomType(interpolateField(ctx, qa, field)))
}

// NEW:
function translateField(ctx, qa, field) {
  return translateTypeformField(addCustomType(interpolateField(ctx, qa, field)))
}
```

**4. `getField({ form, user }, ref, index)`:**
Still works with `user = { id: userId }` since it only uses `user.id`.

**5. `getFromMetadata(ctx, key)`:**
Reads from `ctx.user`. After removing getUserInfo, `ctx.user` is `{ id: userId }`. Mustache interpolation `{{hidden:first_name}}` etc. will resolve to undefined/empty string (acceptable — profile data is unused in practice).

### replybot/lib/typewheels/statestore.js

**Replace `this.parseEvent` with new `parseEvent` from `event-normalizer.js`:**
```javascript
const { parseEvent } = require('../event-normalizer')

// In constructor — REMOVE this.parseEvent binding:
// this.parseEvent = parseEvent  (from @vlab-research/utils)

// In _getEvents — use the new parseEvent directly:
async _getEvents(user, event) {
  const res = await this.db.get(user, +STATE_STORE_LIMIT)
  return _resolve(res, event)
    .map(parseEvent)  // NEW: directly produces UniversalEvent
    .slice(0, -1)
}
```

The new `parseEvent()` returns `UniversalEvent` directly — events replayed from DB are normalized at read time. No database migration needed, no separate `normalizeEvent()` step needed. The `exec()` function already receives `UniversalEvent` from both paths.

### replybot/lib/typewheels/utils.js

**Update `getMetadata()` to accept UniversalEvent:**

```javascript
function getMetadata(event) {
  let md

  try {
    // NEW: read from UniversalEvent
    let r
    if (event.event_type === 'conversation_started') {
      r = event.payload.referral
    }

    if (r && r.ref) {
      const pairs = r.ref.split('.')
      md = _group(pairs.map(decodeURIComponent))
    }
  } catch (e) {
    md = {}
  }

  md.form = md.form || process.env.FALLBACK_FORM
  md.startTime = event.timestamp
  md.pageid = event.source.account_id  // NEW: replace getPageFromEvent(event)

  return {
    ...md,
    ...randomSeed(event, md)
  }
}
```

For synthetic events, extract from `event.payload.event` instead of raw `event.event`.

### replybot/lib/index.js

**Remove chat-log publisher:**

```javascript
// REMOVE:
const { publishChatLog } = require('./chat-log/publisher')

// REMOVE:
const VLAB_CHAT_LOG_TOPIC = process.env.VLAB_CHAT_LOG_TOPIC

// Inside processor(), REMOVE:
if (VLAB_CHAT_LOG_TOPIC) {
  await publishChatLog(produce, VLAB_CHAT_LOG_TOPIC, event, state)
}
```

### replybot/package.json

**Changes:**
- REMOVE `@vlab-research/translate-typeform` — all functions ported locally
- REMOVE `@vlab-research/utils` — `parseEvent` replaced by `event-normalizer.js`, `getPageFromEvent` replaced by `event.source.account_id`, chat-log deleted
- KEEP `js-yaml` — used by ported `addCustomType()`
- KEEP `mustache` — used by `interpolateField()` in form.js
- KEEP `cacheman` — used by Machine constructor for caching
- KEEP `lodash` — used extensively
- KEEP `chrono-node` — used by date parsing
- KEEP `jsonwebtoken` — used by form fetching

### message-worker/types/command.go

**Changes:**
- Add `HandoffCommand` struct with `type`, `command_id`, `issued_at`, `user_id`, `platform`, `platform_account_id`, `target_app_id`, `metadata`
- Add `PlatformContext json.RawMessage` to `SendMessageCommand`
- Change `Option.Value` from `interface{}` to `json.RawMessage`
- Add `Option.Description *string`
- Change `MessageContent.Metadata` from `map[string]interface{}` to `json.RawMessage`
- Remove `NativePayload`, `TargetAppID`, `HandoffMetadata` from `MessageContent`
- Remove `MessageTypeNative` and `MessageTypePassThreadControl` constants
- Add helper methods: `GetMetadataString()`, `GetRefFromMetadata()`, `GetTypeFromMetadata()`, `GetOTNToken()`, `ValueAsString()` (rewritten for `json.RawMessage`)

### message-worker/worker.go

**Two-level dispatch with backward compatibility:**

```go
func (w *Worker) ProcessCommand(ctx context.Context, rawCmd json.RawMessage) error {
    var baseCmd struct { Type string `json:"type"` }
    json.Unmarshal(rawCmd, &baseCmd)

    switch baseCmd.Type {
    case "send_message":
        var cmd types.SendMessageCommand
        json.Unmarshal(rawCmd, &cmd)
        return w.processSendMessage(ctx, cmd)

    case "handoff":
        var cmd types.HandoffCommand
        json.Unmarshal(rawCmd, &cmd)
        return w.processHandoff(ctx, cmd)

    case "":  // LEGACY: old format has no top-level "type" field
        var cmd types.SendMessageCommand
        json.Unmarshal(rawCmd, &cmd)
        switch cmd.Message.Type {
        case "native":
            return w.processNativeMessage(ctx, cmd)
        case "pass_thread_control":
            return w.processPassThreadControl(ctx, cmd)
        default:
            return fmt.Errorf("unknown legacy message type: %s", cmd.Message.Type)
        }

    default:
        return fmt.Errorf("unknown command type: %s", baseCmd.Type)
    }
}
```

Remove (after transition confirmed stable): `processNativeMessage()`, `processPassThreadControl()`.

### message-worker/main.go

Update deserialization — pass `json.RawMessage` to `ProcessCommand()` instead of `SendMessageCommand`:
```go
// CURRENT:
processFunc := func(msg *kafka.Message) {
    var cmd types.SendMessageCommand
    if err := json.Unmarshal(msg.Value, &cmd); err != nil { ... }
    if err := worker.ProcessCommand(ctx, cmd); err != nil { ... }
}

// NEW:
processFunc := func(msg *kafka.Message) {
    if err := worker.ProcessCommand(ctx, msg.Value); err != nil { ... }
}
```

### message-worker/messenger_client.go

**Changes:**
- Update `FacebookRecipient` to support `one_time_notif_token`:
  ```go
  type FacebookRecipient struct {
      ID                string `json:"id,omitempty"`
      OneTimeNotifToken string `json:"one_time_notif_token,omitempty"`
  }
  ```
- Remove `SendNativeMessage()` method
- Keep `PassThreadControl()` — called from `processHandoff()`
- Keep `SendMessage()` — update to support recipient from platform_context

### message-worker/client.go

Update `MessageSender` interface:
- Remove `SendNativeMessage()` method
- Keep `SendMessage()` and `PassThreadControl()`

### message-worker/stub_clients.go

Remove `SendNativeMessage()` from `StubClient`.

### message-worker/translator.go

Update for `json.RawMessage` metadata and option values:
- `getMetadataString()` — changed from `map[string]interface{}` to `json.RawMessage`
- `getRefFromMetadata()` — same
- `ValueAsString()` — rewritten to unmarshal `json.RawMessage` (handle string, bool, number)

---

## Files to Delete

- **`replybot/lib/messenger/index.js`** — Only exported `getUserInfo()`, replaced by `{ id: userId }`
- **`replybot/lib/chat-log/publisher.js`** — Chat-log publisher deleted entirely

---

## Repo-Wide Cleanup

### Helm Values

Remove `VLAB_CHAT_LOG_TOPIC` env var:
- `devops/values/production.yaml` (around line 554)
- `devops/values/staging.yaml` (around line 361)
- `replybot/kube-scratch-dev/debugger.yaml` (around line 77)

### Facebot Testrunner

Remove chat-log topic forcing in `facebot/testrunner/stack.ts`:
```typescript
// REMOVE this block entirely (around lines 349-351):
// Ensure VLAB_CHAT_LOG_TOPIC is set
if (!replybotEnv.VLAB_CHAT_LOG_TOPIC) {
  replybotEnv.VLAB_CHAT_LOG_TOPIC = 'vlab-chat-log';
}
```
Rebuild `facebot/testrunner/dist/stack.js` after.

### Documentation

Delete or mark as deprecated: `documentation/chat-message-logging.md`

---

## Implementation Order

1. **Worktree setup** — create from `feature/message-worker-extraction`, branch `feature/platform-abstraction`
2. **New files** — `event-normalizer.js`, `generic-translator.js`, `generic-validator.js`
3. **Replybot inbound** — modify `machine.js` `categorizeEvent()` + `exec()`, `transition.js` (parseEvent, getPageFromEvent), `statestore.js` (parseEvent), `utils.js` (getMetadata, getPageFromEvent)
4. **Replybot outbound** — modify `machine.js` `respond()`/`_gatherResponses()`/`_response()`/`act()`/side effect extraction, `form.js` (translateField, port addCustomType/parseNumber), `transition.js` `buildCommands()`
5. **Replybot cleanup** — delete `messenger/index.js`, replace `getUserInfo` with `{ id: userId }`, remove `getPageToken`, delete `chat-log/publisher.js`, update `index.js` (remove chat-log), update `package.json`
6. **Message-worker types** — `command.go` (HandoffCommand, PlatformContext, Option changes, remove Native/PassThreadControl)
7. **Message-worker worker** — `worker.go` (two-level dispatch with backward compat), `main.go` (deserialization)
8. **Message-worker client** — `messenger_client.go` (FacebookRecipient, remove SendNativeMessage), `client.go` (interface), `stub_clients.go`
9. **Message-worker translator** — `translator.go` (json.RawMessage metadata and option values)
10. **Repo cleanup** — Helm values (remove VLAB_CHAT_LOG_TOPIC), facebot `stack.ts`, documentation
11. **Tests** — Update replybot tests (`lib/**/*.test.js`) for UniversalEvent/MessageContent, update message-worker tests (`*_test.go`) for new command types
12. **Integration testing** — full flow with facebot/dev.sh
13. **Documentation** — update `replybot/README.md`, `message-worker/README.md`, add `documentation/platform-abstraction.md`

---

## Testing & Deployment Strategy

### Deployment Order

1. Deploy message-worker with dual-format support
2. Verify it still handles old `native`/`pass_thread_control` commands correctly
3. Deploy replybot with new code
4. Verify new `send_message`/`handoff` commands flow through correctly
5. After transition is confirmed stable (days later), remove old format support from message-worker in a follow-up PR

### Integration Test

Full flow with facebot:
1. Send a message via facebot → verify replybot normalizes to UniversalEvent
2. Verify replybot produces `send_message` commands with MessageContent
3. Verify message-worker translates MessageContent to Messenger format
4. Verify message-worker sends to Facebook API (or facebot mock)
5. Verify error feedback loop works (machine_report → BLOCKED/ERROR state)
6. Test with `NODE_ENV=development` to verify facebot doesn't do actual Facebook API calls

### Risks to Verify

- **ECHO handler metadata parsing** — Currently parses `event.message.metadata` as JSON string. After normalization, it's `event.payload.metadata` as structured object. Verify all metadata fields preserved.
- **Double-encoded JSON** — `recursiveJSONParser` is gone. Verify normalizers handle all known double-encoded fields from real Facebook events.
- **Option.Value deserialization** — Boolean values (`true`/`false`) from yes_no/legal must serialize and deserialize correctly through Kafka → Go.
- **`_gatherResponses()` rewrite** — Recursive statement gathering must work identically.
- **Event replay** — `getState()` must correctly replay stored events through the new `exec()` which expects UniversalEvent.
- **`generic-validator.js` correctness** — Must produce identical validation results to the old Facebook-coupled validator.
