# Platform Abstraction Plan — Complete Context Document

**Branch:** `feature/platform-abstraction` (from `feature/message-worker-extraction`)
**Goal:** Abstract both inbound and outbound message flows so adding WhatsApp/Instagram/TikTok requires only new platform parsers and translators — no changes to core state machine logic.

---

## Table of Contents

1. [Key Design Decisions & Reasoning](#key-design-decisions--reasoning)
2. [Current Architecture (Phase 1 — Passthrough)](#current-architecture-phase-1--passthrough)
3. [Target Architecture (Phase 2 — Abstracted)](#target-architecture-phase-2--abstracted)
4. [Data Flow Diagrams](#data-flow-diagrams)
5. [Current Source Code (Complete)](#current-source-code-complete)
6. [Rust-Machine Reference Code (Complete)](#rust-machine-reference-code-complete)
7. [Implementation Plan: Part 1 — Replybot Inbound](#part-1--replybot--inbound-event-normalization)
8. [Implementation Plan: Part 2 — Replybot Outbound](#part-2--replybot--outbound-generic-message-generation)
9. [Implementation Plan: Part 3 — Remove Facebook Dependencies](#part-3--remove-facebook-dependencies-from-replybot)
10. [Implementation Plan: Part 4 — Message-Worker Updates](#part-4--message-worker-updates)
11. [Implementation Plan: Part 5 — WhatsApp Architecture-Only](#part-5--architecture-only-whatsapp-support)
12. [Implementation Order](#implementation-order)
13. [Migration & Testing Strategy](#migration--testing-strategy)
14. [Risk Assessment & Open Questions](#risk-assessment--open-questions)

---

## Key Design Decisions & Reasoning

| Decision | Choice | Why |
|---|---|---|
| Base branch | `feature/message-worker-extraction` | Phase 1 passthrough already done here — replybot publishes commands to Kafka, message-worker consumes. Starting from this base. |
| Inbound direction | Full normalization (UniversalEvent) | Porting `parse_messenger_event()` from rust-machine. The state machine should never see raw Messenger fields — only normalized `event_type` strings + typed payloads. This is what enables adding WhatsApp/Instagram as input sources without changing `exec()` or `act()`. |
| Outbound direction | New generic translator alongside | Writing a new `generic-translator.js` that outputs platform-agnostic `MessageContent` instead of Facebook-native format. Replaces `@vlab-research/translate-typeform` entirely. The old translator is deeply coupled to Facebook (quick_replies, attachment format, metadata as JSON string) — a clean break is better than patching. |
| getUserInfo | Replace with `{ id: userId }` | Investigation showed that `getUserInfo()` fetches Facebook profile (name, first_name, last_name) but **only `user.id` (the PSID) is actually used** — in `respond()` for `recipient.id`, in `buildCommands()` for `user_id`, and in `getField()` for error messages. The PSID is already available from the incoming event's `sender.id`. Profile data can be fetched later if needed for personalization. |
| Platform-specific escape hatch | `platform_context` on SendMessageCommand | Instead of hardcoding `one_time_notif_token` as a first-class field, a generic `platform_context` (object/json.RawMessage) carries platform-specific delivery instructions. Messenger: OTN token. WhatsApp: could carry `message_type: "template"`, `template_name`. Instagram: might have its own quirks. Core `MessageContent` stays clean. |
| Handoff | Separate `HandoffCommand` | The current approach (`type: "pass_thread_control"` within `SendMessageCommand`) pollutes `MessageContent` with `TargetAppID` and `HandoffMetadata` fields that are meaningless for text/question/media messages. A separate command type means each command has its own schema. Two-level dispatch (command type → message type) is actually cleaner. Matches rust-machine branch design. |
| WhatsApp | Architecture only, implement later | WhatsApp parsers/translators already exist in rust-machine branch and message-worker stubs. Just ensure the architecture supports it. Actual implementation is a separate project. |
| Chat-log publisher | Skip for now | `chat-log/publisher.js` currently inspects raw Messenger fields (ECHO, TEXT, QUICK_REPLY, POSTBACK). Will need updating later but is not critical for this work. |
| Phase order | Inbound + outbound together | User explicitly chose to implement both simultaneously. The inbound and outbound changes are interdependent — `exec()` reads events (inbound), `act()` produces commands (outbound), and the new `categorizeEvent()` bridges both. |
| translate-typeform handling | New generic translator (replaces package) | Writing a new `generic-translator.js` that produces `MessageContent` directly. The old `@vlab-research/translate-typeform` package outputs Facebook-native format and is deeply embedded in `machine.js` via `translateField()`. We replace the `translator()` call inside `translateField()` with our new function. The `addCustomType()` and `interpolateField()` functions from that package are already re-implemented in `form.js` (with the handoff extension) so we only lose the final Facebook-specific translation step. |

---

## Current Architecture (Phase 1 — Passthrough)

```
BotServer (Node.js)
  │ Receives Facebook webhooks, normalizes timestamp, adds source: "messenger"
  │ Publishes to Kafka (BOTSERVER_EVENT_TOPIC)
  ↓
Kafka → Replybot (Node.js, via BotSpine/SpineSupervisor)
  │ parseEvent() from @vlab-research/utils — extracts sender.id, recipient.id, timestamp
  │ getPageFromEvent() — extracts page_id
  │ categorizeEvent() — inspects RAW Messenger fields (message.is_echo, message.quick_reply, postback, etc.)
  │ exec(state, event) — state machine decision using raw Messenger fields
  │ apply(state, output) — state transition
  │ actionsResponses() — fetches form, getUserInfo() from Facebook API, getPageToken()
  │ act() — translateField() → @vlab-research/translate-typeform → Facebook-native messages
  │ respond() — adds recipient: { id: ctx.user.id } to each message
  │ _gatherResponses() — recursive statement gathering, produces Facebook-native message objects
  │ buildCommands() — wraps Facebook-native payloads in SendMessageCommand with type: "native"
  │ publishCommands() → Kafka "commands" topic
  │ Also: publishState, publishResponses, publishPayment, publishChatLog
  ↓
Kafka "commands" → Message-Worker (Go, burrow pool of 100 workers)
  │ ProcessCommand() routes by cmd.Message.Type:
  │   type: "native" → processNativeMessage() → MessengerClient.SendNativeMessage() → POST /me/messages
  │   type: "pass_thread_control" → processPassThreadControl() → MessengerClient.PassThreadControl() → POST /me/pass_thread_control
  │   type: "text"/"question"/"media" → processTranslatedMessage() → TranslateTo*() → UNUSED in Phase 1
  │ On failure: reportError() → botserver /synthetic → Kafka (synthetic event) → Replybot → BLOCKED/ERROR state
  ↓
Facebook Graph API
```

### Current Kafka Command Format (Phase 1)

**SendMessageCommand (native):**
```json
{
  "command_id": "<hex>",
  "issued_at": 1711100000000,
  "conversation_id": "user_123",
  "user_id": "user_123",
  "platform": "messenger",
  "platform_account_id": "page_456",
  "message": {
    "type": "native",
    "native_payload": {
      "recipient": { "id": "user_123" },
      "message": {
        "text": "What is your gender?",
        "quick_replies": [
          {"content_type": "text", "title": "Male", "payload": "{\"value\":\"male\",\"ref\":\"gender\"}"},
          {"content_type": "text", "title": "Female", "payload": "{\"value\":\"female\",\"ref\":\"gender\"}"}
        ],
        "metadata": "{\"type\":\"question\",\"ref\":\"gender\"}"
      }
    }
  }
}
```

**SendMessageCommand (handoff):**
```json
{
  "command_id": "<hex>",
  "issued_at": 1711100000000,
  "conversation_id": "user_123",
  "user_id": "user_123",
  "platform": "messenger",
  "platform_account_id": "page_456",
  "message": {
    "type": "pass_thread_control",
    "target_app_id": "263902037430900",
    "handoff_metadata": "{\"source\":\"replybot\"}"
  }
}
```

---

## Target Architecture (Phase 2 — Abstracted)

```
BotServer (Node.js) — UNCHANGED
  │ Still receives Facebook webhooks, adds source: "messenger"
  │ Publishes to Kafka
  ↓
Kafka → Replybot (Node.js, via BotSpine/SpineSupervisor)
  │ NEW: parseEvent() from event-normalizer.js → UniversalEvent
  │   - parseMessengerEvent() for source: "messenger"
  │   - parseSyntheticEvent() for source: "synthetic"
  │   - (stubs for source: "whatsapp", "instagram" etc.)
  │ NEW: categorizeEvent() matches on event.event_type string, NOT raw Messenger fields
  │ exec(state, universalEvent) — reads from event.payload (typed), not raw fields
  │ apply(state, output) — unchanged
  │ actionsResponses() — NO getUserInfo(), NO getPageToken()
  │   user = { id: userId } instead of Facebook profile lookup
  │ act() → generic-translator.js → MessageContent (platform-agnostic)
  │ respond() — NO recipient addition (goes in command envelope)
  │ _gatherResponses() — produces MessageContent[] instead of Facebook-native messages
  │ buildCommands() produces:
  │   SendMessageCommand { type: "send_message", message: MessageContent, platform_context? }
  │   HandoffCommand { type: "handoff", target_app_id, metadata }
  │ publishCommands() → Kafka "commands" topic
  │ Also: publishState, publishResponses, publishPayment (unchanged)
  ↓
Kafka "commands" → Message-Worker (Go, burrow pool of 100 workers)
  │ NEW: Two-level dispatch:
  │   First by command type:
  │     "send_message" → route by message.type (text/question/media)
  │       → processTranslatedMessage() → TranslateToMessenger/WhatsApp/Instagram()
  │       → client.SendMessage() (constructs recipient from user_id or platform_context)
  │     "handoff" → processHandoff() → client.PassThreadControl()
  │     "external_service" → (future)
  │   REMOVED: processNativeMessage(), MessageTypeNative
  │   REMOVED: processPassThreadControl() as message type
  │ On failure: reportError() → botserver /synthetic → same error feedback loop
  ↓
Platform API (Messenger, WhatsApp, Instagram, etc.)
```

### Target Kafka Command Format (Phase 2)

**SendMessageCommand (text):**
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
    "type": "text",
    "text": "Welcome to our survey!",
    "metadata": { "ref": "welcome", "type": "statement" }
  }
}
```

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

**SendMessageCommand (media):**
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
    "type": "media",
    "media_type": "image",
    "media_url": "https://example.com/image.jpg",
    "caption": null,
    "metadata": { "ref": "photo", "type": "attachment" }
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
  "platform_context": {
    "one_time_notif_token": "TOKEN123"
  },
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

---

## Data Flow Diagrams

### Inbound: Current vs Target

**Current (Phase 1):**
```
Facebook Webhook JSON
  → BotServer adds source:"messenger", timestamp
  → Kafka (raw event)
  → Replybot parseEvent() from @vlab-research/utils
      extracts sender.id, recipient.id, timestamp
  → categorizeEvent() INSPECTS raw Messenger fields:
      event.message.is_echo → ECHO
      event.message.quick_reply → QUICK_REPLY
      event.postback → POSTBACK
      event.message.text → TEXT
      event.message.attachments → MEDIA
      event.referral → REFERRAL
      event.reaction → REACTION
      event.read / event.delivery → WATERMARK
      event.source === 'synthetic' && event.event.type === '...' → synthetic categories
  → exec(state, event) reads raw fields directly:
      event.message.quick_reply.payload.value
      event.message.text
      event.postback.payload
      event.pass_thread_control
      event.message.metadata (JSON string)
      event.optin.one_time_notif_token
```

**Target (Phase 2):**
```
Facebook Webhook JSON
  → BotServer adds source:"messenger", timestamp  (UNCHANGED)
  → Kafka (raw event)  (UNCHANGED)
  → Replybot parseEvent() from event-normalizer.js
      dispatches by source field
  → parseMessengerEvent(raw.data, raw.timestamp):
      extracts sender.id / recipient.id (swaps for echo)
      calls categorizeMessengerEvent(data)
      produces UniversalEvent with event_type + typed payload
  → categorizeEvent() matches on event.event_type STRING:
      "user_text" → TEXT
      "user_interaction" (interaction_type: "quick_reply") → QUICK_REPLY
      "user_interaction" (interaction_type: "postback") → POSTBACK
      "bot_message_sent" → ECHO
      "conversation_started" → REFERRAL
      "user_reaction" → REACTION
      "user_media" → MEDIA
      "bot_message_delivered" / "bot_message_read" → WATERMARK
      "synthetic_*" → existing synthetic categories
  → exec(state, universalEvent) reads from event.payload:
      event.payload.value (for user_interaction)
      event.payload.text (for user_text)
      event.payload.interaction_type (quick_reply vs postback)
      event.payload.attachments (for user_media)
      event.payload.one_time_notif_token (for optin)
      event.metadata (structured object, not JSON string)
```

### Outbound: Current vs Target

**Current (Phase 1):**
```
act() → translateField() → @vlab-research/translate-typeform → Facebook-native message:
  { message: { text: "...", quick_replies: [...], metadata: "{...}" } }

respond() adds recipient: { id: ctx.user.id }

_gatherResponses() accumulates Facebook-native message objects

buildCommands() wraps each in SendMessageCommand with type: "native":
  { message: { type: "native", native_payload: { recipient: {...}, message: {...} } } }

Message-Worker processNativeMessage() → SendNativeMessage() → POST raw payload to /me/messages
```

**Target (Phase 2):**
```
act() → translateField() → generic-translator.js → MessageContent (platform-agnostic):
  { type: "question", question_text: "...", options: [...], metadata: { ref, type } }

respond() does NOT add recipient — user_id goes in command envelope

_gatherResponses() accumulates MessageContent objects

buildCommands() wraps each in SendMessageCommand with type: "send_message":
  { type: "send_message", user_id: "...", message: { type: "question", ... }, platform_context? }
  OR HandoffCommand: { type: "handoff", target_app_id: "...", ... }

Message-Worker processTranslatedMessage() → TranslateToMessenger() →
  MessengerMessage { text, quick_replies, metadata } →
  MessengerClient.SendMessage(ctx, platformAccountID, userID, messengerMsg) →
  constructs { recipient: { id: userID } or one_time_notif_token from platform_context } →
  POST to /me/messages
```

---

## Current Source Code (Complete)

All code below is from the `feature/message-worker-extraction` branch — the exact code that will be modified.

### replybot/lib/index.js

```javascript
const util = require('util')
const { Machine } = require('./typewheels/transition')
const { StateStore } = require('./typewheels/statestore')
const { BotSpine } = require('@vlab-research/botspine')
const { pipeline } = require('stream')
const { TokenStore } = require('./typewheels/tokenstore')
const { producer, producerReady } = require('./producer')
const { SpineSupervisor } = require('./spine-supervisor/spine-supervisor')
const { publishChatLog } = require('./chat-log/publisher')

const VLAB_CHAT_LOG_TOPIC = process.env.VLAB_CHAT_LOG_TOPIC
const KAFKA_COMMANDS_TOPIC = process.env.KAFKA_COMMANDS_TOPIC || 'commands'

const REPLYBOT_STATESTORE_TTL = process.env.REPLYBOT_STATESTORE_TTL || '24h'
const REPLYBOT_MACHINE_TTL = process.env.REPLYBOT_MACHINE_TTL || '60m'

async function publishReport(report) {
  const url = process.env.BOTSERVER_URL
  const json = {
    user: report.user,
    page: report.page,
    event: { type: 'machine_report', value: report }
  }
  return fetch(`${url}/synthetic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(json),
  })
}

async function produce(topic, message, userid) {
  await producerReady
  const data = Buffer.from(JSON.stringify(message))
  producer.produce(topic, null, data, userid)
}

function publishState(userid, pageid, updated, state) {
  const message = { userid, pageid, updated, current_state: state.state, state_json: state }
  return produce(process.env.VLAB_STATE_TOPIC, message, userid)
}

function publishResponses(message) {
  if (!message) return
  return produce(process.env.VLAB_RESPONSE_TOPIC, message, message.userid)
}

function publishPayment(message) {
  return produce(process.env.VLAB_PAYMENT_TOPIC, message, message.userid)
}

function publishCommands(commands) {
  if (!commands || commands.length === 0) return
  for (const cmd of commands) {
    produce(KAFKA_COMMANDS_TOPIC, cmd, cmd.user_id)
  }
}

function processor(machine, stateStore) {
  return async function _processor({ key: userId, value: event }) {
    try {
      console.log('EVENT: ', event)
      const state = await stateStore.getState(userId, event)
      console.log('STATE: ', state)
      const report = await machine.run(state, userId, event)
      console.log('REPORT: ', report)

      if (report.publish) {
        await publishReport(report)
      }
      if (report.newState) {
        await publishState(report.user, report.page, report.timestamp, report.newState)
        await stateStore.updateState(userId, report.newState)
      }
      if (report.responses) {
        await publishResponses(report.responses)
      }
      if (report.payment) {
        await publishPayment(report.payment)
      }
      if (report.commands && report.commands.length > 0) {
        await publishCommands(report.commands)
      }
      if (VLAB_CHAT_LOG_TOPIC) {
        await publishChatLog(produce, VLAB_CHAT_LOG_TOPIC, event, state)
      }
    }
    catch (e) {
      console.error('Error from ReplyBot: \n',
        e.message,
        '\n Error occured during event: ', util.inspect(JSON.parse(event), null, 8))
      console.error(e.stack)
    }
  }
}

const NUM_SPINES = process.env.NUM_SPINES
if (!NUM_SPINES) {
  throw new Error('NUM_SPINES environment variable must be set')
}
const numSpines = parseInt(NUM_SPINES)
if (isNaN(numSpines) || numSpines < 1) {
  throw new Error('NUM_SPINES must be a positive integer')
}
process.setMaxListeners(numSpines * 3 + 5)

const supervisor = new SpineSupervisor(numSpines, 5, 5 * 60 * 1000, null, BotSpine)
supervisor.start(processor)
```

**KEY CHANGE POINTS:**
- Line `const report = await machine.run(state, userId, event)` — `event` is currently the raw Kafka event string. After change, we need to parse it into a UniversalEvent BEFORE passing to `machine.run()`. But `machine.run()` already calls `parseEvent()` internally — we'll change it to call our new normalizer instead.
- `publishChatLog` call passes raw `event` — we're skipping chat-log changes for now.

### replybot/lib/typewheels/transition.js

```javascript
const { exec, apply, act, update } = require('./machine')
const { getForm } = require('./ourform')
const { getUserInfo } = require('../messenger')
const { responseVals } = require('../responses/responser')
const { parseEvent, getPageFromEvent } = require('@vlab-research/utils')
const { iowrap } = require('../errors')
const _ = require('lodash')
const util = require('util')
const Cacheman = require('cacheman')
const crypto = require('crypto')


class Machine {
  constructor(ttl, tokenStore) {
    const cache = new Cacheman()
    this.cache = cache

    this.getForm = (pageid, shortcode, timestamp) => {
      return cache.wrap(`form:${pageid}:${shortcode}:${timestamp}`, () => getForm(pageid, shortcode, timestamp), ttl)
    }
    this.getUser = (id, pageToken) => {
      return cache.wrap(`user:${id}`, () => getUserInfo(id, pageToken), ttl)
    }
    this.getPageToken = page => {
      return cache.wrap(`pagetoken:${page}`, () => tokenStore.get(page), ttl)
    }
  }

  transition(state, parsedEvent) {
    const page = getPageFromEvent(parsedEvent)
    const output = exec(state, parsedEvent)
    const newState = apply(state, output)
    return { newState, output, page }
  }

  async actionsResponses(state, userId, timestamp, pageId, newState, output) {
    const upd = output && update(output)
    const shortcode = newState.forms.slice(-1)[0]

    if (!newState.md) {
      throw new Error(`User without metadata: ${userId}. State: ${util.inspect(newState, null, 8)}`)
    }
    const { startTime } = newState.md

    const pageToken = await iowrap('getPageToken', 'INTERNAL', this.getPageToken, pageId)
    const [form, surveyId, formSettings] = await iowrap('getForm', 'INTERNAL', this.getForm,
      pageId, shortcode, startTime)

    const user = await this.getUser(userId, pageToken)

    const { messages, payment, handoff } = act({ form, user, page: { id: pageId }, timestamp }, state, output)
    const responses = responseVals(newState, upd, form, surveyId, pageId, user, timestamp)

    return { actions: messages, responses, pageToken, timestamp, payment, handoff }
  }

  act(messages) {
    return messages || []
  }

  buildCommands(messages, handoff, user, page) {
    const commands = messages.map(msg => ({
      command_id: crypto.randomBytes(8).toString('hex'),
      issued_at: Date.now(),
      conversation_id: user,
      user_id: user,
      platform: 'messenger',
      platform_account_id: page,
      message: {
        type: 'native',
        native_payload: msg
      }
    }))

    if (handoff) {
      commands.push({
        command_id: crypto.randomBytes(8).toString('hex'),
        issued_at: Date.now(),
        conversation_id: user,
        user_id: user,
        platform: 'messenger',
        platform_account_id: page,
        message: {
          type: 'pass_thread_control',
          target_app_id: handoff.target_app_id,
          handoff_metadata: JSON.stringify(handoff.metadata || {})
        }
      })
    }

    return commands
  }

  async run(state, user, rawEvent) {
    let newState, output, page
    const event = parseEvent(rawEvent)
    const timestamp = event.timestamp

    if (!timestamp) {
      return { publish: true, timestamp: Date.now(), user, error: { tag: 'CORRUPTED_MESSAGE', event } }
    }

    try {
      const t = this.transition(state, event)
      newState = t.newState
      output = t.output
      page = t.page

      if (output.action === 'NONE') {
        return { publish: false, timestamp, user, page, newState }
      }

      if (output.action === 'RESET') {
        return { publish: true, timestamp, user, page, newState }
      }

    } catch (e) {
      return {
        publish: false, timestamp, user, page,
        error: { tag: 'STATE_TRANSITION', message: e.message, stack: e.stack, state, event }
      }
    }
    try {
      const { actions, pageToken, responses, payment, handoff } = await this.actionsResponses(state, user, timestamp, page, newState, output)
      const messages = this.act(actions)
      const commands = this.buildCommands(messages, handoff, user, page)

      return {
        publish: true, timestamp, user, page, responses, payment, commands, newState
      }
    } catch (e) {
      return {
        publish: true, timestamp, user, page, newState,
        error: { tag: 'STATE_ACTIONS', message: e.message, stack: e.stack }
      }
    }
  }
}

module.exports = { Machine }
```

**KEY CHANGE POINTS:**
- `const { getUserInfo } = require('../messenger')` — REMOVE, replace with `{ id: userId }`
- `this.getUser` — REMOVE, no longer needed
- `this.getPageToken` — REMOVE, token lookup is message-worker's job
- `const pageToken = await iowrap(...)` — REMOVE from actionsResponses
- `const user = await this.getUser(userId, pageToken)` — REPLACE with `const user = { id: userId }`
- `transition()` uses `getPageFromEvent(parsedEvent)` — REPLACE with getting page from UniversalEvent.source.account_id
- `run()` calls `parseEvent(rawEvent)` from `@vlab-research/utils` — REPLACE with `parseEvent(rawEvent)` from our new `event-normalizer.js`
- `buildCommands()` — COMPLETELY REWRITE to produce `send_message` + `handoff` commands instead of `native` + `pass_thread_control`
- Platform (`'messenger'`) is currently hardcoded — should come from `UniversalEvent.source.type`

### replybot/lib/typewheels/machine.js

This is the largest file (~900 lines). The KEY CHANGE POINTS are highlighted below — the full source was captured in the exploration phase and is available on the branch.

**KEY CHANGE POINTS:**

1. **`categorizeEvent(nxt)`** (currently lines ~230-290) — COMPLETELY REWRITE. Currently inspects raw Messenger fields:
   ```javascript
   // CURRENT: inspects raw Messenger fields
   if (nxt.referral || ...) return 'REFERRAL'
   if (nxt.message && nxt.message.is_echo) return 'ECHO'
   if (nxt.postback) return 'POSTBACK'
   if (nxt.message && nxt.message.quick_reply) return 'QUICK_REPLY'
   if (nxt.message && nxt.message.text !== undefined) return 'TEXT'
   // etc.
   ```
   **NEW:** Match on `nxt.event_type` string:
   ```javascript
   // NEW: match on normalized event_type string
   switch (nxt.event_type) {
     case 'user_text': return 'TEXT'
     case 'user_interaction':
       return nxt.payload.interaction_type === 'quick_reply' ? 'QUICK_REPLY' : 'POSTBACK'
     case 'bot_message_sent': return 'ECHO'
     case 'conversation_started': return 'REFERRAL'
     case 'bot_message_delivered': case 'bot_message_read': return 'WATERMARK'
     case 'user_reaction': return 'REACTION'
     case 'user_media': return 'MEDIA'
     case 'synthetic_machine_report': return 'MACHINE_REPORT'
     // etc.
   }
   ```

2. **`exec(state, nxt)`** (currently lines ~290-560) — UPDATE to read from `nxt.payload` instead of raw fields:
   - `QUICK_REPLY`: `nxt.message.quick_reply.payload.value` → `nxt.payload.value`
   - `POSTBACK`: `nxt.postback.payload` / `nxt.postback.payload.value` → `nxt.payload.value`
   - `TEXT`: `nxt.message.text` → `nxt.payload.text`
   - `MEDIA`: `nxt.message.attachments` → `nxt.payload.attachments`
   - `ECHO`: `nxt.message.metadata` (JSON string) → `nxt.payload.metadata` (structured object)
   - `OPTIN`: `nxt.optin` → `nxt.payload` with `one_time_notif_token`
   - `HANDOVER_EVENT`: `nxt.pass_thread_control` → `nxt.payload` with `previous_owner_app_id`
   - `WATERMARK`: `getWatermark(nxt)` → `nxt.payload` with `type` and `watermark`
   - Helper functions `_synth()`, `_externalEvent()`, `_handoverEvent()` — REWRITE to check `nxt.event_type`

3. **`act(ctx, state, output)`** — `respond()` and `_gatherResponses()` currently produce Facebook-native message objects with `{ recipient, message: { text, quick_replies, metadata } }`. REWRITE to produce `MessageContent` objects with `{ type, text/question_text, options, metadata }`.

4. **`respond(ctx, qa, output)`** — REMOVE `addRecipient` function. Messages no longer carry recipient info.

5. **`_response(ctx, qa, {...})`** — Instead of calling `translateField()` (which returns Facebook-native), call generic translator. OTN token (`recipient: { one_time_notif_token: token }`) should be returned separately, not embedded in message body.

6. **`_gatherResponses(ctx, qa, q, previous)`** — Currently inspects `q.message.metadata` (JSON string). REWRITE to inspect `q.metadata` (structured object).

7. **`repeatResponse(question, text)`** — Currently returns `{ message: { text, metadata: JSON.stringify({...}) } }`. REWRITE to return `MessageContent`.

8. **`offResponse(previousQuestion, text)`** — Same as above.

9. **Side effect extraction** — `getPaymentFromMessage()` and `getHandoffFromMessage()` currently parse `message.message.metadata` (JSON string) to extract `payment` and `handoff` objects. REWRITE: these are now in `MessageContent.metadata` as structured fields.

10. **`makeEventMetadata(event)`** — Currently reads raw Messenger fields like `event.pass_thread_control`. REWRITE to read from `event.payload`.

### replybot/lib/typewheels/form.js

**KEY CHANGE POINTS:**

1. **`translateField(ctx, qa, field)`** — Currently calls `translator(addCustomType(interpolateField(ctx, qa, field)))` where `translator` is from `@vlab-research/translate-typeform` and produces Facebook-native format. REPLACE with call to `generic-translator.js`.

   ```javascript
   // CURRENT:
   const { translator, addCustomType: baseAddCustomType, parseNumber } = require('@vlab-research/translate-typeform')
   function translateField(ctx, qa, field) {
     return translator(addCustomType(interpolateField(ctx, qa, field)))
   }
   
   // NEW:
   const { translateTypeformField } = require('../generic-translator')
   function translateField(ctx, qa, field) {
     return translateTypeformField(addCustomType(interpolateField(ctx, qa, field)))
   }
   ```

2. **`addCustomType(field)`** — This already has a local extension with handoff support on top of `baseAddCustomType`. The `baseAddCustomType` from `translate-typeform` is still needed for parsing YAML in description. We need to either:
   - Keep importing `addCustomType as baseAddCustomType` from `translate-typeform` (only for YAML parsing)
   - OR port the YAML parsing logic locally
   
   The `baseAddCustomType` parses the `properties.description` field for YAML that defines custom types (utility_message, handoff, wait, stitch, share, webview, attachment, payment). This is platform-agnostic logic and should be kept. The `translator()` function is the only Facebook-specific part we're replacing.

3. **`getField({ form, user }, ref, index)`** — Currently requires `user.id`. After removing `getUserInfo()`, `user` is `{ id: userId }`. This still works — no change needed.

4. **`getFromMetadata(ctx, key)`** — Reads from `ctx.user` and `ctx.md`. After removing getUserInfo, `ctx.user` is `{ id: userId }`. Mustache interpolation `{{hidden:first_name}}` etc. will resolve to undefined/empty string. This is acceptable since we confirmed profile data is unused in practice.

### replybot/lib/messenger/index.js

```javascript
const BASE_URL = process.env.FACEBOOK_GRAPH_URL || "https://graph.facebook.com/v8.0"
const RETRIES = process.env.FACEBOOK_RETRIES || 5
const BASE_RETRY_TIME = process.env.FACEBOOK_BASE_RETRY_TIME || 400

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function facebookRequest(reqFn, retries = 0) {
  let res;
  try {
    res = await reqFn()
  } catch (e) {
    if (e.code === 'ETIMEDOUT' && retries < RETRIES) {
      await delay(Math.pow(2, retries) * BASE_RETRY_TIME)
      res = await facebookRequest(reqFn, retries + 1)
    }
    else { throw e }
  }
  if (res && res.error) {
    const retryCodes = [1200, 551]
    if (retryCodes.includes(res.error.code) && retries < RETRIES) {
      await delay(Math.pow(2, retries) * BASE_RETRY_TIME)
      return await facebookRequest(reqFn, retries + 1)
    }
    throw res.error
  }
  return res
}

async function getUserInfo(id, pageToken) {
  const url = `${BASE_URL}/${id}?fields=id,name,first_name,last_name`
  const headers = { Authorization: `Bearer ${pageToken}` }
  try {
    const user = await facebookRequest(() => fetch(url, { headers }).then(r => r.json()))
    return user;
  } catch (e) {
    console.error(e);
    return { id, name: '_', first_name: '_', last_name: '_' }
  }
}

module.exports = { getUserInfo }
```

**This entire file will be DELETED.** Only `getUserInfo` is exported, and we're replacing it with `{ id: userId }`.

### replybot/lib/chat-log/publisher.js

```javascript
'use strict'
const { categorizeEvent } = require('../typewheels/machine')
const { parseEvent } = require('@vlab-research/utils')

function extractChatLogEntry(event, state) {
  const category = categorizeEvent(event)
  if (category === 'ECHO') {
    const md = event.message.metadata || {}
    return {
      userid: event.recipient.id,
      pageid: event.sender.id,
      timestamp: event.timestamp,
      direction: 'bot',
      content: event.message.text || '',
      question_ref: md.ref || null,
      shortcode: state.forms && state.forms.length > 0 ? state.forms[state.forms.length - 1] : null,
      surveyid: null,
      message_type: md.type || null,
      raw_payload: event,
      metadata: state.md || null,
    }
  }
  if (category === 'TEXT' || category === 'QUICK_REPLY' || category === 'POSTBACK') {
    return {
      userid: event.sender.id,
      pageid: (state.md && state.md.pageid) || null,
      timestamp: event.timestamp,
      direction: 'user',
      content: (event.message && event.message.text) || (event.postback && event.postback.title) || '',
      question_ref: state.question || null,
      shortcode: state.forms && state.forms.length > 0 ? state.forms[state.forms.length - 1] : null,
      surveyid: null,
      message_type: category.toLowerCase(),
      raw_payload: event,
      metadata: state.md || null,
    }
  }
  return null
}

function publishChatLog(produce, topic, rawEvent, state) {
  const event = parseEvent(rawEvent)
  const entry = extractChatLogEntry(event, state)
  if (!entry) return
  return produce(topic, entry, entry.userid)
}

module.exports = { extractChatLogEntry, publishChatLog }
```

**SKIPPED for now** — but note that after we change `categorizeEvent()` to work with UniversalEvent, this file will break because it calls `categorizeEvent(event)` where `event` is still a raw parsed event (from `@vlab-research/utils parseEvent`). We need to either:
- Temporarily keep the old `categorizeEvent` available (exported under a different name)
- Or disable chat-log publishing until it's updated
- Or update it as part of this work (but user chose to skip)

**IMPORTANT:** If chat-log is skipped, we must ensure `VLAB_CHAT_LOG_TOPIC` is not set during the transition, otherwise the publisher will crash on the new `categorizeEvent()` signature.

### replybot/lib/errors.js

```javascript
class MachineIOError extends Error {
  constructor(tag, msg, details) {
    super(msg)
    this.tag = tag
    this.details = details
  }
  get name() { return this.constructor.name; }
}

async function iowrap(msg, tag, fn, ...args) {
  try {
    const res = await fn(...args)
    return res
  } catch (e) {
    if (e instanceof MachineIOError) { throw e }
    const err = new MachineIOError(tag, msg, e.details)
    err.stack = e.stack
    throw err
  }
}

module.exports = { MachineIOError, iowrap }
```

**No changes needed** — but note that `MachineIOError` with tags `'FB'` and `'NETWORK'` can no longer be thrown from replybot since it no longer calls Facebook API directly. The `iowrap` is still used for `getForm` and `getPageToken` — but `getPageToken` is being removed. After changes, `iowrap` will only wrap `getForm`.

### replybot/package.json

```json
{
  "name": "replybot",
  "version": "1.0.0",
  "engines": { "node": ">=22 <23" },
  "dependencies": {
    "@vlab-research/botspine": "0.0.13",
    "@vlab-research/chatbase-postgres": "^0.1.0",
    "@vlab-research/translate-typeform": "^0.2.16",
    "@vlab-research/utils": "0.0.11",
    "cacheman": "^2.2.1",
    "chrono-node": "^1.3.11",
    "farmhash": "^3.0.0",
    "ioredis": "^5.3.2",
    "js-yaml": "^3.14.0",
    "jsonwebtoken": "^8.5.1",
    "lodash": "^4.17.11",
    "mustache": "^4.0.0",
    "parse-duration": "^0.4.4",
    "pg": "^8.11.0"
  },
  "overrides": { "pg": "^8.11.3" }
}
```

**Changes needed:**
- REMOVE `@vlab-research/translate-typeform` — replaced by `generic-translator.js`
- KEEP `@vlab-research/utils` — still used for `parseEvent` in chat-log publisher and `getPageFromEvent` in transition.js (or remove if we replace all usages)
- KEEP `js-yaml` — used in `form.js` `addCustomType()` for YAML parsing in field descriptions
- KEEP `mustache` — used in `form.js` for interpolation
- KEEP `lodash` — used extensively
- KEEP `cacheman` — used for caching in Machine constructor
- ADD `uuid` package — for generating event IDs in UniversalEvent (or use crypto.randomUUID())
- Fix duplicate `overrides` key

### Message-Worker Current Code (Key Files)

**`message-worker/types/command.go`** — Current state:

```go
type PlatformType string
const (
    PlatformMessenger PlatformType = "messenger"
    PlatformWhatsApp  PlatformType = "whatsapp"
    PlatformInstagram PlatformType = "instagram"
    PlatformTelegram  PlatformType = "telegram"
)

type SendMessageCommand struct {
    CommandID         string       `json:"command_id"`
    IssuedAt          int64        `json:"issued_at"`
    ConversationID    string       `json:"conversation_id"`
    UserID            string       `json:"user_id"`
    Platform          PlatformType `json:"platform"`
    PlatformAccountID string       `json:"platform_account_id"`
    Message           MessageContent `json:"message"`
}

type MessageType string
const (
    MessageTypeText             MessageType = "text"
    MessageTypeQuestion         MessageType = "question"
    MessageTypeMedia            MessageType = "media"
    MessageTypeNative           MessageType = "native"           // REMOVE
    MessageTypePassThreadControl MessageType = "pass_thread_control" // REMOVE
)

type MessageContent struct {
    Type MessageType `json:"type"`
    Text *string `json:"text,omitempty"`
    QuestionText *string  `json:"question_text,omitempty"`
    Options      []Option `json:"options,omitempty"`
    MediaType *MediaType `json:"media_type,omitempty"`
    MediaURL  *string    `json:"media_url,omitempty"`
    Caption   *string    `json:"caption,omitempty"`
    NativePayload json.RawMessage `json:"native_payload,omitempty"`     // REMOVE
    TargetAppID      string `json:"target_app_id,omitempty"`          // MOVE to HandoffCommand
    HandoffMetadata  string `json:"handoff_metadata,omitempty"`       // MOVE to HandoffCommand
    Metadata map[string]interface{} `json:"metadata,omitempty"`         // KEEP but change to json.RawMessage for consistency
}

type Option struct {
    Value interface{} `json:"value"`  // CHANGE to json.RawMessage for proper deserialization
    Label string      `json:"label"`
    // ADD: Description *string `json:"description,omitempty"`
}
```

**`message-worker/worker.go`** — Current ProcessCommand routing:

```go
func (w *Worker) ProcessCommand(ctx context.Context, cmd types.SendMessageCommand) error {
    switch cmd.Message.Type {
    case types.MessageTypeNative:           // REMOVE
        return w.processNativeMessage(ctx, cmd)
    case types.MessageTypePassThreadControl: // REMOVE
        return w.processPassThreadControl(ctx, cmd)
    default:
        return w.processTranslatedMessage(ctx, cmd)  // KEEP, this becomes the ONLY path for send_message
    }
}
```

**`message-worker/messenger_client.go`** — Current client:

The `MessengerClient` currently has three methods on the `MessageSender` interface:
- `SendMessage()` — takes a platform-specific message, constructs `FacebookSendRequest{Recipient, Message}`, POSTs to `/me/messages`
- `SendNativeMessage()` — takes raw JSON payload, POSTs directly to `/me/messages`. **REMOVE**.
- `PassThreadControl()` — takes userID, platformAccountID, targetAppID, metadata, POSTs to `/me/pass_thread_control`. **KEEP** but called from `processHandoff()`.

For `SendMessage()`, the `FacebookRecipient` currently always uses `{ ID: userID }`. **CHANGE**: check `platform_context` for `one_time_notif_token` and use that instead when present.

---

## Rust-Machine Reference Code (Complete)

This is the reference implementation from `feat/rust-replybot-migration:machine/machine-core/src/` that we are porting to Node.js and aligning the Go message-worker with.

### statestore.rs — Inbound Event Parsing

**`parse_event(raw)`** — dispatcher:
```rust
pub fn parse_event(raw: &RawEvent) -> Result<UniversalEvent, ParseError> {
    match raw.source.as_str() {
        "messenger" => parse_messenger_event(&raw.data, raw.timestamp),
        "whatsapp" => parse_whatsapp_event(&raw.data, raw.timestamp),
        "instagram" => parse_instagram_event(&raw.data, raw.timestamp),
        "telegram" => parse_telegram_event(&raw.data, raw.timestamp),
        "synthetic" => parse_synthetic_event(&raw.data, raw.timestamp),
        "message_worker" => parse_message_worker_event(&raw.data, raw.timestamp),
        "external_worker" => parse_external_worker_event(&raw.data, raw.timestamp),
        "bot" => parse_message_worker_event(&raw.data, raw.timestamp),
        _ => Err(ParseError::InvalidFormat(format!("Unknown source: {}", raw.source))),
    }
}
```

**`parse_messenger_event(data, timestamp)`** — full implementation:
```rust
fn parse_messenger_event(data: &Value, timestamp: i64) -> Result<UniversalEvent, ParseError> {
    let sender_id = data.get("sender").and_then(|s| s.get("id")).and_then(|id| id.as_str())
        .ok_or_else(|| ParseError::MissingField("sender.id".to_string()))?;
    let recipient_id = data.get("recipient").and_then(|r| r.get("id")).and_then(|id| id.as_str())
        .ok_or_else(|| ParseError::MissingField("recipient.id".to_string()))?;

    let is_echo = data.get("message").and_then(|m| m.get("is_echo"))
        .and_then(|e| e.as_bool()).unwrap_or(false);

    // For echo: sender is the page, recipient is the user. Swap.
    let (user_id, page_id) = if is_echo { (recipient_id, sender_id) } else { (sender_id, recipient_id) };

    let source = EventSource::Messenger { account_id: page_id.to_string() };
    let (event_type, payload) = categorize_messenger_event(data)?;

    Ok(UniversalEvent {
        event_id: UniversalEvent::new_event_id(),
        user_id: UniversalEvent::generate_opaque_user_id(user_id),
        timestamp,
        source,
        event_type,
        payload,
        raw: Some(data.clone()),
    })
}
```

**`categorize_messenger_event(data)`** — full implementation:
```rust
fn categorize_messenger_event(data: &Value) -> Result<(String, Value), ParseError> {
    use serde_json::json;

    if let Some(message) = data.get("message") {
        // Echo
        if message.get("is_echo").and_then(|e| e.as_bool()).unwrap_or(false) {
            let mut message_payload = message.clone();
            if let Some(metadata) = message.get("metadata").and_then(|m| m.as_str()) {
                if let Ok(parsed) = serde_json::from_str::<Value>(metadata) {
                    if let Some(obj) = message_payload.as_object_mut() {
                        obj.insert("metadata".to_string(), parsed);
                    }
                }
            }
            return Ok(("bot_message_sent".to_string(), message_payload));
        }

        // Quick reply — CRITICAL: payload can be JSON string or object
        if let Some(quick_reply) = message.get("quick_reply") {
            let payload_obj = quick_reply.get("payload").and_then(|p| {
                if let Some(s) = p.as_str() { serde_json::from_str::<Value>(s).ok() }
                else { Some(p.clone()) }
            });
            let payload_value = payload_obj.as_ref().and_then(|p| p.get("value")).cloned().unwrap_or(Value::Null);
            let ref_value = payload_obj.as_ref().and_then(|p| p.get("ref")).and_then(|r| r.as_str());

            return Ok(("user_interaction".to_string(), json!({
                "type": "user_interaction",
                "value": payload_value,
                "source_message_id": ref_value.unwrap_or(""),
                "interaction_type": "quick_reply"
            })));
        }

        // Text
        if let Some(text) = message.get("text") {
            return Ok(("user_text".to_string(), json!({ "type": "user_text", "text": text })));
        }

        // Attachments/sticker
        if message.get("attachments").is_some() || message.get("stickerId").is_some() {
            return Ok(("user_media".to_string(), json!({
                "type": "user_media",
                "attachments": message.get("attachments"),
                "stickerId": message.get("stickerId")
            })));
        }
    }

    // Postback — CRITICAL: payload can be JSON string or object
    if let Some(postback) = data.get("postback") {
        let payload_obj = postback.get("payload").and_then(|p| {
            if let Some(s) = p.as_str() { serde_json::from_str::<Value>(s).ok() }
            else if p.is_object() { Some(p.clone()) }
            else { None }
        });
        let payload_value = payload_obj.as_ref().and_then(|p| p.get("value")).cloned()
            .unwrap_or_else(|| postback.get("payload").cloned().unwrap_or(Value::Null));
        let ref_value = payload_obj.as_ref().and_then(|p| p.get("ref")).and_then(|r| r.as_str());
        let title = postback.get("title").and_then(|t| t.as_str()).unwrap_or("");

        return Ok(("user_interaction".to_string(), json!({
            "type": "user_interaction",
            "value": payload_value,
            "label": title,
            "source_message_id": ref_value.unwrap_or(""),
            "interaction_type": "postback",
            "raw_payload": postback.get("payload")
        })));
    }

    // Referral
    if let Some(referral) = data.get("referral") {
        return Ok(("conversation_started".to_string(), json!({
            "type": "conversation_started",
            "trigger": "referral",
            "referral": referral
        })));
    }

    // Read receipt
    if let Some(read) = data.get("read") {
        return Ok(("bot_message_read".to_string(), json!({
            "type": "bot_message_read",
            "watermark": read.get("watermark"),
            "read_at": data.get("timestamp")
        })));
    }

    // Delivery receipt
    if let Some(delivery) = data.get("delivery") {
        return Ok(("bot_message_delivered".to_string(), json!({
            "type": "bot_message_delivered",
            "watermark": delivery.get("watermark"),
            "delivered_at": data.get("timestamp")
        })));
    }

    // Reaction
    if let Some(reaction) = data.get("reaction") {
        return Ok(("user_reaction".to_string(), json!({
            "type": "user_reaction",
            "reaction": reaction.get("reaction"),
            "emoji": reaction.get("emoji"),
            "action": reaction.get("action")
        })));
    }

    // Optin (for OTN tokens)
    if let Some(optin) = data.get("optin") {
        return Ok(("optin".to_string(), json!({
            "type": "optin",
            "optin_type": optin.get("type"),
            "token": optin.get("one_time_notif_token"),
            "payload": optin.get("payload")
        })));
    }

    // Pass thread control (handover)
    if let Some(pass_thread) = data.get("pass_thread_control") {
        return Ok(("handover".to_string(), json!({
            "type": "handover",
            "previous_owner_app_id": pass_thread.get("previous_owner_app_id"),
            "new_owner_app_id": pass_thread.get("new_owner_app_id"),
            "metadata": pass_thread.get("metadata")
        })));
    }

    Err(ParseError::InvalidFormat(format!("Unknown Messenger event type: {}",
        serde_json::to_string(data).unwrap_or_else(|_| "unknown".to_string()))))
}
```

**`parse_synthetic_event(data, timestamp)`** — full implementation:
```rust
fn parse_synthetic_event(data: &Value, timestamp: i64) -> Result<UniversalEvent, ParseError> {
    let event = data.get("event").ok_or_else(|| ParseError::MissingField("event".to_string()))?;
    let event_type = event.get("type").and_then(|t| t.as_str())
        .ok_or_else(|| ParseError::MissingField("event.type".to_string()))?;

    let user_id = if let Some(uid) = data.get("user_id").and_then(|u| u.as_str()) {
        uid.to_string()
    } else {
        let user_id_raw = data.get("user").and_then(|u| u.as_str())
            .ok_or_else(|| ParseError::MissingField("user (legacy format)".to_string()))?;
        UniversalEvent::generate_opaque_user_id(user_id_raw)
    };

    let unified_type = format!("synthetic_{}", event_type);
    let payload = json!({ "event": event.clone() });

    Ok(UniversalEvent {
        event_id: UniversalEvent::new_event_id(),
        user_id,
        timestamp,
        source: EventSource::Synthetic,
        event_type: unified_type,
        payload,
        raw: Some(data.clone()),
    })
}
```

### event_category.rs — Event Categorization

```rust
pub enum EventCategory {
    ConversationStart, ConversationEnd,
    UserText, UserInteraction, UserMedia, UserReaction, UserLocation, UserContact,
    BotMessageSent, BotMessageDelivered, BotMessageRead, BotMessageFailed,
    HandoverEvent,
    ExternalEvent, Timeout,
    Unblock, FollowUp, RepeatPayment, Redo, PlatformResponse, MachineReport, Bailout, BlockUser,
    Unknown,
}

pub fn categorize_event(event: &UniversalEvent) -> EventCategory {
    match event.event_type.as_str() {
        "user_text"              => EventCategory::UserText,
        "user_interaction"       => EventCategory::UserInteraction,
        "user_media"             => EventCategory::UserMedia,
        "user_reaction"          => EventCategory::UserReaction,
        "user_location"          => EventCategory::UserLocation,
        "user_contact"           => EventCategory::UserContact,
        "bot_message_sent"       => EventCategory::BotMessageSent,
        "bot_message_delivered"  => EventCategory::BotMessageDelivered,
        "bot_message_read"       => EventCategory::BotMessageRead,
        "bot_message_failed"     => EventCategory::BotMessageFailed,
        "conversation_started"   => EventCategory::ConversationStart,
        "conversation_ended"     => EventCategory::ConversationEnd,
        "handoff"                => EventCategory::HandoverEvent,
        "optin"                  => EventCategory::ConversationStart, // optin treated as conversation start
        "synthetic_external"     => EventCategory::ExternalEvent,
        "synthetic_timeout"     => EventCategory::Timeout,
        "synthetic_redo"         => EventCategory::Redo,
        "synthetic_machine_report" => EventCategory::MachineReport,
        "synthetic_unblock"      => EventCategory::Unblock,
        "synthetic_follow_up"    => EventCategory::FollowUp,
        "synthetic_repeat_payment" => EventCategory::RepeatPayment,
        "synthetic_platform_response" => EventCategory::PlatformResponse,
        "synthetic_bailout"      => EventCategory::Bailout,
        "synthetic_block_user"   => EventCategory::BlockUser,
        "service_completed"      => EventCategory::ExternalEvent,
        "service_failed"         => EventCategory::ExternalEvent,
        _ => categorize_legacy_event(event),
    }
}
```

**MAPPING TO CURRENT JS CATEGORIES:**
| EventCategory (Rust) | event_type string | Current JS category |
|---|---|---|
| ConversationStart | `conversation_started`, `optin` | REFERRAL, OPTIN |
| UserText | `user_text` | TEXT |
| UserInteraction | `user_interaction` | QUICK_REPLY or POSTBACK (by interaction_type) |
| UserMedia | `user_media` | MEDIA |
| UserReaction | `user_reaction` | REACTION |
| BotMessageSent | `bot_message_sent` | ECHO |
| BotMessageDelivered | `bot_message_delivered` | WATERMARK |
| BotMessageRead | `bot_message_read` | WATERMARK |
| HandoverEvent | `handover` | HANDOVER_EVENT |
| ExternalEvent | `synthetic_external`, `service_completed`, `service_failed` | EXTERNAL_EVENT |
| Timeout | `synthetic_timeout` | EXTERNAL_EVENT (type: timeout) |
| MachineReport | `synthetic_machine_report` | MACHINE_REPORT |
| Bailout | `synthetic_bailout` | BAILOUT |
| Unblock | `synthetic_unblock` | UNBLOCK |
| FollowUp | `synthetic_follow_up` | FOLLOW_UP |
| RepeatPayment | `synthetic_repeat_payment` | REPEAT_PAYMENT |
| Redo | `synthetic_redo` | REDO |
| PlatformResponse | `synthetic_platform_response` | PLATFORM_RESPONSE |
| BlockUser | `synthetic_block_user` | BLOCK_USER |

### translate.rs — Generic Translator (Typeform → MessageContent)

```rust
pub fn translate_typeform_field(field: &TypeformField) -> Result<MessageContent, String> {
    match field.field_type.as_deref() {
        // Text input types
        Some("short_text") => Ok(translate_text_field(field)),
        Some("long_text") => Ok(translate_text_field(field)),
        Some("number") => Ok(translate_text_field(field)),
        Some("date") => Ok(translate_text_field(field)),
        Some("email") => Ok(translate_text_field(field)),
        Some("phone_number") => Ok(translate_text_field(field)),
        Some("upload") => Ok(translate_text_field(field)),

        // Question types with choices
        Some("multiple_choice") => Ok(translate_question_with_choices(field)),
        Some("dropdown") => Ok(translate_question_with_choices(field)),
        Some("picture_choice") => Ok(translate_question_with_choices(field)),
        Some("yes_no") => Ok(translate_yes_no(field)),
        Some("legal") => Ok(translate_legal(field)),

        // Scale types
        Some("opinion_scale") => Ok(translate_opinion_scale(field)),
        Some("rating") => Ok(translate_rating(field)),

        // Statement/informational
        Some("statement") => Ok(translate_statement(field)),
        Some("welcome_screen") => Ok(translate_welcome_screen(field)),
        Some("thankyou_screen") => Ok(translate_statement(field)),

        // Special/custom types (parsed from YAML in description)
        Some("wait") => Ok(translate_statement(field)),
        Some("stitch") => Ok(translate_statement(field)),
        Some("share") => translate_share(field),
        Some("webview") => translate_webview(field),
        Some("attachment") => translate_attachment(field),

        _ => Err(format!("Unknown field type: {:?}", field.field_type)),
    }
}

fn translate_text_field(field: &TypeformField) -> MessageContent {
    MessageContent {
        message_type: MessageType::Text,
        text: Some(field.title.clone()),
        metadata: Some(json!({
            "ref": field.ref_,
            "type": field.field_type.clone().unwrap_or_default()
        })),
        ..Default::default()
    }
}

fn translate_question_with_choices(field: &TypeformField) -> MessageContent {
    let options = field.properties.choices.iter().map(|c| MessageOption {
        value: json!(c.ref_.as_ref().unwrap_or(&c.label.clone())),
        label: c.label.clone(),
        description: None,
    }).collect();

    MessageContent {
        message_type: MessageType::Question,
        question_text: Some(field.title.clone()),
        options: Some(options),
        metadata: Some(json!({
            "ref": field.ref_,
            "type": field.field_type.clone().unwrap_or_default()
        })),
        ..Default::default()
    }
}

fn translate_yes_no(field: &TypeformField) -> MessageContent {
    MessageContent {
        message_type: MessageType::Question,
        question_text: Some(field.title.clone()),
        options: Some(vec![
            MessageOption { value: json!(true), label: "Yes".to_string(), description: None },
            MessageOption { value: json!(false), label: "No".to_string(), description: None },
        ]),
        metadata: Some(json!({ "ref": field.ref_, "type": "yes_no" })),
        ..Default::default()
    }
}

fn translate_legal(field: &TypeformField) -> MessageContent {
    MessageContent {
        message_type: MessageType::Question,
        question_text: Some(field.title.clone()),
        options: Some(vec![
            MessageOption { value: json!(true), label: "I Accept".to_string(), description: None },
            MessageOption { value: json!(false), label: "I don't Accept".to_string(), description: None },
        ]),
        metadata: Some(json!({ "ref": field.ref_, "type": "legal" })),
        ..Default::default()
    }
}

fn translate_opinion_scale(field: &TypeformField) -> MessageContent {
    let steps = field.properties.steps.unwrap_or(5) as i64;
    let start_at = field.properties.start_at_one.unwrap_or(true);
    let start = if start_at { 1 } else { 0 };

    let options: Vec<MessageOption> = (start..=start + steps - 1)
        .map(|n| MessageOption {
            value: json!(n.to_string()),
            label: n.to_string(),
            description: None,
        }).collect();

    MessageContent {
        message_type: MessageType::Question,
        question_text: Some(field.title.clone()),
        options: Some(options),
        metadata: Some(json!({ "ref": field.ref_, "type": "opinion_scale" })),
        ..Default::default()
    }
}

fn translate_rating(field: &TypeformField) -> MessageContent {
    let steps = field.properties.steps.unwrap_or(5) as i64;
    let options: Vec<MessageOption> = (1..=steps)
        .map(|n| MessageOption {
            value: json!(n.to_string()),
            label: "⭐".repeat(n as usize),
            description: None,
        }).collect();

    MessageContent {
        message_type: MessageType::Question,
        question_text: Some(field.title.clone()),
        options: Some(options),
        metadata: Some(json!({ "ref": field.ref_, "type": "rating" })),
        ..Default::default()
    }
}

fn translate_welcome_screen(field: &TypeformField) -> MessageContent {
    MessageContent {
        message_type: MessageType::Question,
        question_text: Some(field.title.clone()),
        options: Some(vec![
            MessageOption {
                value: json!("continue"),
                label: field.properties.button_text.clone().unwrap_or("Continue".to_string()),
                description: None,
            }
        ]),
        metadata: Some(json!({ "ref": field.ref_, "type": "welcome_screen" })),
        ..Default::default()
    }
}

fn translate_statement(field: &TypeformField) -> MessageContent {
    MessageContent {
        message_type: MessageType::Text,
        text: Some(field.title.clone()),
        metadata: Some(json!({
            "ref": field.ref_,
            "type": field.field_type.clone().unwrap_or_default(),
            // Preserve any custom metadata from addCustomType (wait, handoff, keepMoving, etc.)
            ...field.md
        })),
        ..Default::default()
    }
}

fn translate_share(field: &TypeformField) -> MessageContent {
    let url = field.md.as_ref()
        .and_then(|md| md.get("url"))
        .and_then(|u| make_url(u));
    MessageContent {
        message_type: MessageType::Text,
        text: Some(field.title.clone()),
        metadata: Some(json!({
            "ref": field.ref_,
            "type": "share",
            "url": url,
            "buttonText": field.properties.button_text
        })),
        ..Default::default()
    }
}

fn translate_webview(field: &TypeformField) -> MessageContent {
    let url = field.md.as_ref()
        .and_then(|md| md.get("url"))
        .and_then(|u| make_url(u));
    MessageContent {
        message_type: MessageType::Text,
        text: Some(field.title.clone()),
        metadata: Some(json!({
            "ref": field.ref_,
            "type": "webview",
            "url": url,
            "buttonText": field.properties.button_text
        })),
        ..Default::default()
    }
}

fn translate_attachment(field: &TypeformField) -> MessageContent {
    MessageContent {
        message_type: MessageType::Media,
        media_url: field.md.as_ref().and_then(|md| md.get("url")).and_then(|u| u.as_str()).map(String::from),
        media_type: Some("image".to_string()), // default, could be overridden
        caption: None,
        metadata: Some(json!({ "ref": field.ref_, "type": "attachment" })),
        ..Default::default()
    }
}
```

### commands.rs — Command Types (Rust)

```rust
#[serde(tag = "type")]
pub enum Command {
    SendMessage(SendMessageCommand),
    ExternalService(ExternalServiceCommand),
    Handoff(HandoffCommand),
}

pub struct SendMessageCommand {
    pub command_id: String,
    pub issued_at: i64,
    pub conversation_id: String,
    pub user_id: String,
    pub platform: PlatformType,
    pub platform_account_id: String,
    pub message: MessageContent,
}

pub struct MessageContent {
    pub message_type: MessageType,     // Question, Text, Media, Template
    pub question_text: Option<String>,
    pub options: Option<Vec<MessageOption>>,
    pub text: Option<String>,
    pub media_url: Option<String>,
    pub media_type: Option<String>,
    pub caption: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Clone, serdeSerialize)]
pub enum MessageType { Question, Text, Media, Template }

pub struct MessageOption {
    pub value: serde_json::Value,   // Can be string, bool, or number
    pub label: String,
    pub description: Option<String>,
}

pub struct HandoffCommand {
    pub conversation_id: String,
    pub user_id: String,
    pub target_app_id: String,
    pub metadata: serde_json::Value,
}

pub struct ExternalServiceCommand {
    pub command_id: String,
    pub issued_at: i64,
    pub conversation_id: String,
    pub user_id: String,
    pub platform_account_id: String,
    pub service: String,
    pub provider: String,
    pub details: serde_json::Value,
    pub timeout_ms: i64,
}
```

### act.rs — act() and gather_responses() (Rust)

```rust
pub fn act(ctx: &ActContext, state: &MachineState, action: &MachineAction) -> Vec<Command> {
    match action {
        MachineAction::None => vec![],
        MachineAction::Respond { .. } => {
            // If validation failed, repeat question with error message
            // Otherwise, respond with next question
            respond_next_question(ctx, state, action)
        }
        MachineAction::RespondAgain => {
            respond_with_field(ctx, state.question_ref(), state.token())
        }
        MachineAction::SwitchForm { .. } => {
            respond_with_field(ctx, state, first_field_ref, None)
        }
        MachineAction::MakePayment { .. } => {
            create_payment_command_from_field(field, context, ctx)
        }
        MachineAction::End { .. } => {
            respond_with_field(ctx, state, question, None)
        }
        _ => vec![], // WaitResponse, WaitExternalEvent, etc.
    }
}

fn gather_responses(ctx: &ActContext, state: &MachineState, ref_: &str, accumulated: Vec<MessageContent>) -> Vec<MessageContent> {
    let field = get_field(ctx, ref_);
    // 1. Interpolate description BEFORE YAML parsing (critical ordering)
    let field = interpolate_field(ctx, state, &field);
    // 2. Parse YAML in description → add_custom_type
    let field = add_custom_type(&field);
    // 3. Interpolate the rest (title, etc.)
    let field = interpolate_remaining(ctx, state, &field);
    // 4. Translate to platform-agnostic MessageContent
    let message = translate_typeform_field(&field)?;

    // 5. Check if should gather next (statement or keepMoving without wait)
    if should_gather_next(&field) {
        let next_ref = get_next_field_ref(ctx, state, ref_);
        if let Some(next_ref) = next_ref {
            return gather_responses(ctx, state, &next_ref, [...accumulated, message]);
        }
    }

    [...accumulated, message]
}
```

**CRITICAL DIFFERENCE from current JS `_gatherResponses()`:**
- Current JS: `translateField()` produces Facebook-native `{ message: { text, quick_replies, metadata } }` then `_gatherResponses` inspects `q.message` and `JSON.parse(msg.metadata)`
- New: `translateTypeformField()` produces `MessageContent { type, text, question_text, options, metadata }` then `_gatherResponses` inspects `q.metadata` (structured object)

**CRITICAL: Statement metadata handling in current JS:**
```javascript
// CURRENT: _gatherResponses inspects Facebook-native message
const msg = q.message          // { text: "...", quick_replies: [...], metadata: "{...}" }
const md = msg && JSON.parse(msg.metadata)  // Parse JSON string
if (md.repeat) { ... }
if ((md.type === 'statement' || md.keepMoving) && !md.wait) { ... }

// NEW: _gatherResponses inspects MessageContent
const md = q.metadata          // Already a structured object { ref, type, wait, ... }
if (md.repeat) { ... }
if ((md.type === 'statement' || md.keepMoving) && !md.wait) { ... }
```

---

## Part 1: Replybot — Inbound Event Normalization

### 1a. New file: `replybot/lib/event-normalizer.js`

Port `parse_messenger_event()` and `categorize_messenger_event()` from rust-machine `statestore.rs`.

**Functions to implement:**

- `parseEvent(rawKafkaEvent)` — Parse raw Kafka event JSON, extract `source` and `data` fields, dispatch to platform-specific parser. The raw Kafka event from botserver has the shape: `{ source: "messenger"|"synthetic"|..., timestamp, sender: {...}, recipient: {...}, ... }`. Note: the current `parseEvent()` from `@vlab-research/utils` returns a parsed object with `sender.id`, `recipient.id`, `timestamp` etc. Our new `parseEvent()` returns a `UniversalEvent`.

  ```javascript
  function parseEvent(rawKafkaEvent) {
    const raw = typeof rawKafkaEvent === 'string' ? JSON.parse(rawKafkaEvent) : rawKafkaEvent
    const source = raw.source
    const timestamp = raw.timestamp

    switch (source) {
      case 'messenger': return parseMessengerEvent(raw, timestamp)
      case 'synthetic': return parseSyntheticEvent(raw, timestamp)
      case 'message_worker': return parseMessageWorkerEvent(raw, timestamp)
      case 'bot': return parseMessageWorkerEvent(raw, timestamp)  // legacy
      // case 'whatsapp': throw new Error('WhatsApp not yet implemented')
      // case 'instagram': throw new Error('Instagram not yet implemented')
      default: throw new Error(`Unknown source: ${source}`)
    }
  }
  ```

- `parseMessengerEvent(data, timestamp)` → UniversalEvent. Port directly from Rust. Critical detail: for echo events, sender and recipient are swapped (sender = page, recipient = user).

- `parseSyntheticEvent(data, timestamp)` → UniversalEvent. Prefix event type with `synthetic_`.

- `categorizeMessengerEvent(data)` → `{ event_type, payload }`. Port the full mapping from Rust, including the JSON string auto-detection for `quick_reply.payload` and `postback.payload`.

**UniversalEvent shape:**
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

**Messenger event_type mapping (complete):**
| Messenger field | event_type | payload shape |
|---|---|---|
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

**CRITICAL: Payload JSON string auto-detection** — Facebook sometimes sends `quick_reply.payload` and `postback.payload` as escaped JSON strings like `"{\"value\":\"male\",\"ref\":\"gender\"}"` instead of objects. The parser must auto-detect and handle both:
```javascript
function parsePayload(payload) {
  if (typeof payload === 'string') {
    try { return JSON.parse(payload) } catch { return payload }
  }
  return payload
}
```

### 1b. Modify `replybot/lib/typewheels/machine.js` — categorizeEvent()

Replace `categorizeEvent()` with a version matching on `event.event_type` string. This is the CRITICAL bridge between inbound normalization and the state machine.

**Current `categorizeEvent()` inspects raw Messenger fields:**
```javascript
function categorizeEvent(nxt) {
  if (nxt.referral || ...) return 'REFERRAL'
  if (nxt.message && nxt.message.is_echo) return 'ECHO'
  if (nxt.postback) return 'POSTBACK'
  if (nxt.message && nxt.message.quick_reply) return 'QUICK_REPLY'
  if (nxt.message && nxt.message.text !== undefined) return 'TEXT'
  // etc.
}
```

**New `categorizeEvent()` matches on event_type:**
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
    case 'conversation_started': return 'REFERRAL'  // or GET_STARTED based on trigger
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

### 1c. Modify `replybot/lib/typewheels/machine.js` — exec()

Update `exec()` to read from `UniversalEvent.payload` instead of raw Messenger fields. This is the most intricate change — every event handler must be updated.

**QUICK_REPLY handler:**
```javascript
// CURRENT:
case 'QUICK_REPLY': {
  const qrResponse = nxt.message.quick_reply.payload.value === undefined ?
    nxt.message.quick_reply.payload : nxt.message.quick_reply.payload.value
  return { action: 'RESPOND', response: qrResponse, responseValue: qrResponse, question: state.question }
}
// NEW:
case 'QUICK_REPLY': {
  const responseValue = nxt.payload.value
  return { action: 'RESPOND', response: responseValue, responseValue, question: state.question }
}
```

**POSTBACK handler:**
```javascript
// CURRENT:
case 'POSTBACK': {
  return { action: 'RESPOND', response: nxt.postback.payload, responseValue: nxt.postback.payload.value, question: state.question }
}
// NEW:
case 'POSTBACK': {
  const responseValue = nxt.payload.value
  return { action: 'RESPOND', response: responseValue, responseValue, question: state.question }
}
```

**TEXT handler:**
```javascript
// CURRENT:
case 'TEXT': {
  return { action: 'RESPOND', response: nxt.message.text, responseValue: nxt.message.text, question: state.question }
}
// NEW:
case 'TEXT': {
  return { action: 'RESPOND', response: nxt.payload.text, responseValue: nxt.payload.text, question: state.question }
}
```

**MEDIA handler:**
```javascript
// CURRENT:
const attachment = nxt.message.attachments && nxt.message.attachments[0]
return { action: 'RESPOND', response: attachment, responseValue: attachment && attachment.payload && attachment.payload.url, ... }
// NEW:
const attachment = nxt.payload.attachments && nxt.payload.attachments[0]
return { action: 'RESPOND', response: attachment, responseValue: attachment && attachment.payload && attachment.payload.url, ... }
```

**ECHO handler:**
```javascript
// CURRENT:
const md = nxt.message.metadata  // JSON string like '{"type":"question","ref":"gender"}'
if (md.type === 'thankyou_screen') { ... }
if (md.wait) { ... }
if (md.stitch) { ... }

// NEW:
const md = nxt.payload.metadata  // Already a structured object
if (md.type === 'thankyou_screen') { ... }
if (md.wait) { ... }
if (md.stitch) { ... }
```

**OPTIN handler:**
```javascript
// CURRENT:
if (nxt.optin.type !== 'one_time_notif_req') return _noop()
const { one_time_notif_token: token, payload } = nxt.optin

// NEW:
if (nxt.payload.optin_type !== 'one_time_notif_req') return _noop()
const token = nxt.payload.token  // already parsed from one_time_notif_token
const payload = nxt.payload.payload
```

**HANDOVER_EVENT handler:**
```javascript
// CURRENT:
const { new_owner_app_id } = nxt.pass_thread_control
if (new_owner_app_id && new_owner_app_id !== process.env.FACEBOOK_APP_ID) { ... }

// NEW:
const { new_owner_app_id } = nxt.payload
if (new_owner_app_id && new_owner_app_id !== process.env.FACEBOOK_APP_ID) { ... }
```

**WATERMARK handler:**
```javascript
// CURRENT:
function getWatermark(event) {
  if (!event.read && !event.delivery) return undefined
  const type = event.read ? 'read' : 'delivery'
  const mark = event[type].watermark
  return { type, mark }
}

// NEW:
function getWatermark(event) {
  // event.payload already has { type: "bot_message_delivered/read", watermark }
  if (event.event_type !== 'bot_message_delivered' && event.event_type !== 'bot_message_read') return undefined
  const type = event.event_type === 'bot_message_read' ? 'read' : 'delivery'
  const mark = event.payload.watermark
  return { type, mark }
}
```

**Helper functions to update:**
- `_synth(type, event)` → currently checks `event.source === 'synthetic' && event.event.type === type`. NEW: check `event.event_type === 'synthetic_' + type`
- `_externalEvent(event)` → currently checks `event.source === 'synthetic' && (event.event.type === 'timeout' || event.event.type === 'external')`. NEW: check `event.event_type === 'synthetic_external' || event.event_type === 'synthetic_timeout'`
- `_handoverEvent(event)` → currently checks `event.source === 'messenger' && event.pass_thread_control`. NEW: check `event.event_type === 'handover'`
- `makeEventMetadata(event)` → currently reads `event.pass_thread_control`, `event.event.type`, `event.event.value`. NEW: read from `event.payload`

**REFERRAL handler — special case:**
The current `REFERRAL` handler calls `getForm(nxt)` which parses the referral ref string (e.g., `"form.LDfNCy.campaign.fb_ads"`). The `getForm()` function from `ourform.js` reads `event.referral.ref` or `event.postback.referral.ref`. After normalization, this data is in `event.payload.referral`. We need to update `getForm()` or pass the referral data explicitly.

### 1d. Modify `replybot/lib/typewheels/transition.js`

- `run()` — Replace `const event = parseEvent(rawEvent)` (from `@vlab-research/utils`) with `const event = parseEvent(rawEvent)` (from our new `event-normalizer.js`). The event is now a `UniversalEvent`.
- `transition()` — Replace `getPageFromEvent(parsedEvent)` with extracting `page` from `parsedEvent.source.account_id`.
- Remove `getUserInfo` import and `this.getUser` method.
- Remove `getPageToken` from constructor and `actionsResponses()`.
- Replace `const user = await this.getUser(userId, pageToken)` with `const user = { id: userId }`.

### 1e. Modify `replybot/lib/index.js`

- The `processor()` function currently receives `{ key: userId, value: event }` where `event` is the raw Kafka event string. This is passed to `machine.run(state, userId, event)` which internally calls `parseEvent()`. No change needed in `index.js` itself — the `parseEvent()` call inside `machine.run()` is what changes.
- **BUT:** The `publishChatLog` call also does `parseEvent(rawEvent)` using `@vlab-research/utils`. Since we're skipping chat-log changes, we need to ensure this doesn't break. Options: (a) disable chat-log during transition, (b) keep old `parseEvent` import for chat-log only.

---

## Part 2: Replybot — Outbound Generic Message Generation

### 2a. New file: `replybot/lib/generic-translator.js`

Port `translate_typeform_field()` from rust-machine `translate.rs`. This is the core of the outbound abstraction.

**Function signature:**
```javascript
function translateTypeformField(field) -> MessageContent
```

**MessageContent shape:**
```javascript
{
  type: "text" | "question" | "media",
  text: null,                    // for text type
  question_text: null,           // for question type
  options: [{ value, label, description }],  // for question type
  media_url: null,               // for media type
  media_type: null,              // "image" | "video" | "audio" | "file"
  caption: null,                 // for media type
  metadata: { ref, type, ...controlFlags }  // structured object, NOT JSON string
}
```

**Field type mapping (complete):**
| Typeform type | MessageContent type | Notes |
|---|---|---|
| short_text, long_text, number, date, email, phone_number, upload | text | text = field.title, metadata.type = field_type |
| multiple_choice, dropdown, picture_choice | question | options from choices, value = choice.ref or label |
| yes_no | question | options: [true/"Yes", false/"No"] |
| legal | question | options: [true/"I Accept", false/"I don't Accept"] |
| opinion_scale | question | options: numeric strings from start to start+steps-1 |
| rating | question | options: star emoji strings "⭐" to "⭐⭐⭐⭐⭐" |
| welcome_screen | question | single Continue option |
| statement, wait, stitch | text | metadata includes field.md (wait, keepMoving, etc.) |
| thankyou_screen | text | same as statement |
| share | text | metadata includes url and buttonText |
| webview | text | metadata includes url and buttonText |
| attachment | media | media_url from field.md, media_type default "image" |

**Value types in options:**
- `yes_no`/`legal`: boolean `true`/`false` (NOT strings "true"/"false")
- `opinion_scale`/`rating`: string numbers `"1"`, `"2"`, etc.
- `multiple_choice`/`dropdown`/`picture_choice`: string (the choice ref, or label if no ref)

**All options preserved** — no truncation. Message-worker enforces platform limits (Messenger: 13 quick replies, WhatsApp: 3 buttons / 10 list items).

**Metadata is a structured object** — NOT a JSON string like the current `metadata: JSON.stringify({...})`. All control flags are direct properties:
```javascript
metadata: {
  ref: "gender",              // field reference for matching responses
  type: "multiple_choice",     // original field type
  // Conditional flags (from addCustomType / YAML parsing):
  wait: { op: "or", vars: [...] },  // wait condition
  handoff: { target_app_id: "..." }, // handoff directive
  payment: { ... },                 // payment directive
  keepMoving: true,                 // statement gathering flag
  repeat: true,                     // repeat question flag
  isRepeat: true,                   // is this a repeated question?
  off: true,                        // survey is off
  stitch: { form: "...", metadata: {...} },  // stitch to new form
}
```

### 2b. Modify `replybot/lib/typewheels/machine.js` — respond() and _gatherResponses()

This is the most complex change. The entire message generation pipeline must be rewritten.

**Current flow:**
```
translateField(ctx, qa, field)
  → interpolateField() → addCustomType() → translator() [from translate-typeform]
  → Facebook-native: { message: { text, quick_replies, metadata: JSON.stringify({...}) } }

respond(ctx, qa, output)
  → _response(ctx, qa, output)
  → _gatherResponses(ctx, qa, q, previous)
    → inspects q.message.metadata (JSON string)
    → recursively gathers statement/keepMoving messages
  → .map(r => r.recipient ? r : addRecipient(r))
  → Facebook-native messages array
```

**New flow:**
```
translateField(ctx, qa, field)
  → interpolateField() → addCustomType() → translateTypeformField() [from generic-translator.js]
  → MessageContent: { type, text/question_text, options, metadata: {...} }

respond(ctx, qa, output)
  → _response(ctx, qa, output)
  → _gatherResponses(ctx, qa, mc, previous)
    → inspects mc.metadata (structured object)
    → recursively gathers statement/keepMoving MessageContents
  → MessageContent[] (NO recipient addition)
```

**Specific changes:**

1. **`translateField()`** — Replace `translator()` with `translateTypeformField()`:
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

2. **`repeatResponse(question, text)`** — Return MessageContent instead of Facebook-native:
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

3. **`offResponse(previousQuestion, text)`** — Same pattern:
   ```javascript
   // CURRENT:
   function offResponse(previousQuestion, text) {
     return { message: { text, metadata: JSON.stringify({ off: true, ref: previousQuestion }) } }
   }
   // NEW:
   function offResponse(previousQuestion, text) {
     return { type: 'text', text, metadata: { off: true, ref: previousQuestion } }
   }
   ```

4. **`_response()`** — Multiple changes:
   - `translateField()` now returns `MessageContent`, not Facebook-native
   - OTN token handling: instead of embedding `recipient: { one_time_notif_token: token }` in the message, return it separately so `buildCommands()` can put it in `platform_context`
   - Validation: `validator()` from `translate-typeform` still works for response validation. It takes a field with custom type and custom messages, returns `{ valid, message }`. Keep using it.

   **OTN token handling — design:**
   ```javascript
   // _response returns { message: MessageContent, token: token_or_null }
   // NOT { recipient: { one_time_notif_token: token }, ...message }
   ```

5. **`_gatherResponses()`** — Inspect `MessageContent.metadata` instead of `message.message.metadata`:
   ```javascript
   // CURRENT:
   const msg = q.message
   const md = msg && JSON.parse(msg.metadata)
   if (md.repeat) { ... }
   if ((md.type === 'statement' || md.keepMoving) && !md.wait) { ... }

   // NEW:
   const md = q.metadata
   if (md.repeat) { ... }
   if ((md.type === 'statement' || md.keepMoving) && !md.wait) { ... }
   ```

6. **`respond()`** — Remove `addRecipient`:
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

7. **Side effect extraction** — `getPaymentFromMessage()` and `getHandoffFromMessage()`:
   ```javascript
   // CURRENT:
   function getSideEffectFromMessage(ctx, message, type) {
     const metadata = JSON.parse(message.message.metadata)
     if (metadata[type]) return _wrapSideEffect(ctx, metadata[type])
   }
   // NEW:
   function getSideEffectFromMessage(ctx, messageContent, type) {
     if (messageContent.metadata && messageContent.metadata[type]) {
       return _wrapSideEffect(ctx, messageContent.metadata[type])
     }
   }
   ```

### 2c. Modify `replybot/lib/typewheels/transition.js` — buildCommands()

**COMPLETELY REWRITE.** Currently produces `type: "native"` commands with Facebook-native payloads. New version produces `type: "send_message"` commands with MessageContent, and separate `type: "handoff"` commands.

```javascript
buildCommands(messages, handoff, user, page, platform) {
  const commands = messages.map(({ message, token }) => ({
    type: 'send_message',
    command_id: crypto.randomBytes(8).toString('hex'),
    issued_at: Date.now(),
    conversation_id: user,
    user_id: user,
    platform: platform,  // from UniversalEvent.source.type, e.g., "messenger"
    platform_account_id: page,  // from UniversalEvent.source.account_id
    message: message,  // MessageContent
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

**The `messages` array now contains `{ message: MessageContent, token: string|null }` objects** instead of raw Facebook payloads. This is because `_response()` now returns `MessageContent` with a separate `token` field for OTN.

**Platform is no longer hardcoded as `'messenger'`** — it comes from `UniversalEvent.source.type`.

---

## Part 3: Remove Facebook Dependencies from Replybot

### 3a. Replace getUserInfo with { id: userId }

In `transition.js`:
```javascript
// CURRENT:
const { getUserInfo } = require('../messenger')
// ...
const user = await this.getUser(userId, pageToken)

// NEW:
const user = { id: userId }
```

Remove `this.getUser` method from Machine constructor.
Remove `const { getUserInfo } = require('../messenger')` import.

### 3b. Remove getPageToken from actionsResponses

```javascript
// CURRENT:
const pageToken = await iowrap('getPageToken', 'INTERNAL', this.getPageToken, pageId)
const user = await this.getUser(userId, pageToken)

// NEW:
const user = { id: userId }
// pageToken is no longer needed — message-worker handles token lookup
```

Remove `this.getPageToken` from Machine constructor.
Remove `TokenStore` import and constructor parameter.
Remove `const { TokenStore } = require('./typewheels/tokenstore')` from wherever Machine is instantiated.

### 3c. Delete replybot/lib/messenger/index.js

This file only exports `getUserInfo()` now. After replacing with `{ id: userId }`, the entire module is unnecessary.

### 3d. Remove @vlab-research/translate-typeform dependency

In `form.js`:
```javascript
// CURRENT:
const { translator, addCustomType: baseAddCustomType, parseNumber } = require('@vlab-research/translate-typeform')

// NEW:
const { translateTypeformField } = require('../generic-translator')
const { addCustomType: baseAddCustomType, parseNumber } = require('@vlab-research/translate-typeform')
```

Wait — we still need `baseAddCustomType` and `parseNumber` from `translate-typeform`. Options:
1. Keep importing only `addCustomType` and `parseNumber` from `translate-typeform` (they're platform-agnostic)
2. Port `addCustomType` and `parseNumber` locally

**Decision: Keep importing from translate-typeform for now.** Only the `translator()` function is Facebook-specific. The `addCustomType()` (YAML parsing) and `parseNumber()` (unicode number handling) are platform-agnostic utilities. We can port them later as a cleanup step.

In `package.json` — keep `@vlab-research/translate-typeform` dependency for now (we still use `addCustomType` and `parseNumber`).

### 3e. Update replybot/lib/responses/responser.js

`responseVals()` takes `user` parameter and uses `user.id`:
```javascript
const { seed, form: parent_shortcode } = newState.md
const metadata = newState.md
return {
  parent_shortcode, surveyid, shortcode, flowid,
  userid: user.id,  // Still works with { id: userId }
  pageid, question_ref, question_idx, question_text, response, seed, metadata, timestamp,
}
```

No change needed — `{ id: userId }` has `.id` just like the Facebook profile object.

### 3f. Update replybot/package.json

- Keep `@vlab-research/translate-typeform` (still needed for `addCustomType`, `parseNumber`, `validator`, `defaultMessage`, `followUpMessage`, `offMessage`)
- Keep `@vlab-research/utils` (still needed by chat-log publisher — but if we disable chat-log, could remove)
- Add `uuid` or use `crypto.randomUUID()` for event ID generation
- Fix duplicate `overrides` key

---

## Part 4: Message-Worker Updates

### 4a. Update types/command.go

**Add `Command` tagged union type:**
```go
// Command represents a command from the commands Kafka topic.
// The Type field determines which specific command struct to deserialize into.
type Command struct {
    Type string          `json:"type"` // "send_message" | "handoff" | "external_service"
    Raw  json.RawMessage `json:"-"`    // Full JSON for delayed deserialization
}
```

**Add `PlatformContext` to `SendMessageCommand`:**
```go
type SendMessageCommand struct {
    CommandID         string          `json:"command_id"`
    IssuedAt          int64           `json:"issued_at"`
    ConversationID    string          `json:"conversation_id"`
    UserID            string          `json:"user_id"`
    Platform          PlatformType    `json:"platform"`
    PlatformAccountID string          `json:"platform_account_id"`
    Message           MessageContent  `json:"message"`
    PlatformContext    json.RawMessage `json:"platform_context,omitempty"` // NEW: platform-specific delivery instructions
}
```

**Update `MessageContent` — add Description to Option, change Metadata:**
```go
type Option struct {
    Value       json.RawMessage `json:"value"`                  // Changed from interface{} for proper deserialization
    Label       string          `json:"label"`
    Description *string         `json:"description,omitempty"`  // NEW
}

type MessageContent struct {
    Type         MessageType      `json:"type"`
    Text         *string          `json:"text,omitempty"`
    QuestionText *string          `json:"question_text,omitempty"`
    Options      []Option         `json:"options,omitempty"`
    MediaType    *MediaType       `json:"media_type,omitempty"`
    MediaURL     *string          `json:"media_url,omitempty"`
    Caption      *string          `json:"caption,omitempty"`
    Metadata     json.RawMessage  `json:"metadata,omitempty"`  // Changed from map[string]interface{} for consistency
}
```

**Add `HandoffCommand`:**
```go
type HandoffCommand struct {
    Type              string          `json:"type"` // always "handoff"
    CommandID         string          `json:"command_id"`
    IssuedAt          int64           `json:"issued_at"`
    UserID            string          `json:"user_id"`
    Platform          PlatformType    `json:"platform"`
    PlatformAccountID string          `json:"platform_account_id"`
    TargetAppID       string          `json:"target_app_id"`
    Metadata          json.RawMessage `json:"metadata"`
}
```

**Remove from MessageContent:**
- `NativePayload json.RawMessage` — no more native passthrough
- `TargetAppID string` — moved to HandoffCommand
- `HandoffMetadata string` — moved to HandoffCommand

**Remove MessageType constants:**
- `MessageTypeNative` — no more native passthrough
- `MessageTypePassThreadControl` — replaced by HandoffCommand

**Update `Validate()` method:**
- Remove `MessageTypeNative` and `MessageTypePassThreadControl` cases
- Remove validation for `NativePayload`, `TargetAppID`, `HandoffMetadata`

**Helper functions for Metadata:**
```go
func (mc *MessageContent) GetMetadataString() string {
    if len(mc.Metadata) == 0 { return "" }
    return string(mc.Metadata)
}

func (mc *MessageContent) GetRefFromMetadata() string {
    if len(mc.Metadata) == 0 { return "" }
    var md struct {
        Ref string `json:"ref"`
    }
    if err := json.Unmarshal(mc.Metadata, &md); err != nil { return "" }
    return md.Ref
}

func (mc *MessageContent) GetTypeFromMetadata() string {
    if len(mc.Metadata) == 0 { return "" }
    var md struct {
        Type string `json:"type"`
    }
    if err := json.Unmarshal(mc.Metadata, &md); err != nil { return "" }
    return md.Type
}
```

**Helper for PlatformContext (OTN):**
```go
func (cmd *SendMessageCommand) GetOTNToken() string {
    if len(cmd.PlatformContext) == 0 { return "" }
    var ctx struct {
        OneTimeNotifToken string `json:"one_time_notif_token"`
    }
    if err := json.Unmarshal(cmd.PlatformContext, &ctx); err != nil { return "" }
    return ctx.OneTimeNotifToken
}
```

### 4b. Update worker.go — Two-Level Dispatch

**New ProcessCommand flow:**
```go
func (w *Worker) ProcessCommand(ctx context.Context, rawCmd json.RawMessage) error {
    // Step 1: Parse command type
    var baseCmd struct {
        Type string `json:"type"`
    }
    if err := json.Unmarshal(rawCmd, &baseCmd); err != nil {
        return fmt.Errorf("failed to parse command type: %w", err)
    }

    // Step 2: Route by command type
    switch baseCmd.Type {
    case "send_message":
        var cmd types.SendMessageCommand
        if err := json.Unmarshal(rawCmd, &cmd); err != nil {
            return fmt.Errorf("failed to parse send_message command: %w", err)
        }
        return w.processSendMessage(ctx, cmd)

    case "handoff":
        var cmd types.HandoffCommand
        if err := json.Unmarshal(rawCmd, &cmd); err != nil {
            return fmt.Errorf("failed to parse handoff command: %w", err)
        }
        return w.processHandoff(ctx, cmd)

    default:
        return fmt.Errorf("unknown command type: %s", baseCmd.Type)
    }
}

func (w *Worker) processSendMessage(ctx context.Context, cmd types.SendMessageCommand) error {
    // Route by message type: text, question, media
    // All go through translation
    return w.processTranslatedMessage(ctx, cmd)
}

func (w *Worker) processHandoff(ctx context.Context, cmd types.HandoffCommand) error {
    client, ok := w.clients[cmd.Platform]
    if !ok {
        return w.reportErrorFromHandoff(cmd, fmt.Errorf("no client for platform: %s", cmd.Platform))
    }

    metadataStr := string(cmd.Metadata)
    _, err := RetryWithBackoff(ctx, w.config, func() error {
        return client.PassThreadControl(ctx, cmd.UserID, cmd.PlatformAccountID, cmd.TargetAppID, metadataStr)
    })

    if err != nil {
        return w.reportErrorFromHandoff(cmd, err)
    }

    // Success
    return nil  // or emit event
}
```

**Remove:**
- `processNativeMessage()` — no more native passthrough
- `processPassThreadControl()` — replaced by `processHandoff()`

**Update main.go deserialization:**
The `processFunc` in `main.go` currently deserializes into `types.SendMessageCommand`. It needs to change to pass `json.RawMessage` to `ProcessCommand()`:
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

### 4c. Update messenger_client.go

**SendMessage() — construct recipient from user_id or platform_context:**
```go
func (c *MessengerClient) SendMessage(ctx context.Context, platformAccountID, userID string, message interface{}) (*SendMessageResponse, error) {
    token, err := c.tokenStore.GetToken(ctx, platformAccountID)
    if err != nil { return nil, &PlatformError{...} }

    // Build recipient — userID by default
    recipient := FacebookRecipient{ID: userID}

    // NOTE: OTN token handling is done at the worker level, which passes
    // the constructed request. Or we can add a SendMessageWithPlatformContext method.

    req := FacebookSendRequest{Recipient: recipient, Message: message}
    // ... rest same as current
}
```

**For OTN support, add a method or modify SendMessage:**
```go
// Option A: Add recipient override parameter
func (c *MessengerClient) SendMessageWithRecipient(ctx context.Context, platformAccountID string, recipient FacebookRecipient, message interface{}) (*SendMessageResponse, error) {
    // Same as SendMessage but uses provided recipient instead of constructing from userID
}

// Option B: Check platform_context in worker before calling
// In processSendMessage:
otn := cmd.GetOTNToken()
var recipient FacebookRecipient
if otn != "" {
    recipient = FacebookRecipient{OneTimeNotifToken: otn}
} else {
    recipient = FacebookRecipient{ID: cmd.UserID}
}
```

**Update FacebookRecipient to support OTN:**
```go
type FacebookRecipient struct {
    ID                 string `json:"id,omitempty"`
    OneTimeNotifToken  string `json:"one_time_notif_token,omitempty"`
}
```

**Remove SendNativeMessage()** — no longer needed.

**Keep PassThreadControl()** — called from `processHandoff()`.

### 4d. Update translator.go

The translator currently works with `types.MessageContent` that has `Metadata map[string]interface{}`. After changing to `json.RawMessage`, update helper functions:

```go
// CURRENT:
func getMetadataString(metadata map[string]interface{}) string { ... }
func getRefFromMetadata(metadata map[string]interface{}) string { ... }

// NEW:
func getMetadataString(metadata json.RawMessage) string {
    if len(metadata) == 0 { return "" }
    return string(metadata)
}

func getRefFromMetadata(metadata json.RawMessage) string {
    if len(metadata) == 0 { return "" }
    var md struct { Ref string `json:"ref"` }
    if err := json.Unmarshal(metadata, &md); err != nil { return "" }
    return md.Ref
}
```

**Quick reply payload format** — the translator builds payloads as `{"value": ..., "ref": "..."}` JSON objects when a `ref` is present. This must remain unchanged — it's how the bot matches responses to questions.

**Option.Value changed from `interface{}` to `json.RawMessage`:**
```go
// CURRENT:
func (o *Option) ValueAsString() string {
    switch v := o.Value.(type) {
    case string: return v
    case bool: ...
    case float64: ...
    }
}

// NEW:
func (o *Option) ValueAsString() string {
    var s string
    if err := json.Unmarshal(o.Value, &s); err == nil { return s }
    var b bool
    if err := json.Unmarshal(o.Value, &b); err == nil { return strconv.FormatBool(b) }
    var f float64
    if err := json.Unmarshal(o.Value, &f); err == nil {
        if f == float64(int64(f)) { return strconv.FormatInt(int64(f), 10) }
        return strconv.FormatFloat(f, 'f', -1, 64)
    }
    return string(o.Value)
}
```

### 4e. Update MessageSender interface

```go
// CURRENT:
type MessageSender interface {
    SendMessage(ctx context.Context, platformAccountID, userID string, message interface{}) (*SendMessageResponse, error)
    SendNativeMessage(ctx context.Context, userID, platformAccountID string, payload json.RawMessage) (string, error)
    PassThreadControl(ctx context.Context, userID, platformAccountID, targetAppID, metadata string) error
}

// NEW:
type MessageSender interface {
    SendMessage(ctx context.Context, platformAccountID, userID string, message interface{}) (*SendMessageResponse, error)
    PassThreadControl(ctx context.Context, userID, platformAccountID, targetAppID, metadata string) error
}
```

**Update stub_clients.go** — Remove `SendNativeMessage()` from `StubClient`.

---

## Part 5: Architecture-Only WhatsApp Support

- `EventSource` in normalizer supports `source: "whatsapp"` — just throw "not implemented" for now
- `PlatformType` in message-worker already includes `PlatformWhatsApp`
- WhatsApp translator already exists in `message-worker/translator_whatsapp.go`
- Actual WhatsApp parser (inbound) and client (outbound) to be implemented separately later
- Stub clients continue returning 501

---

## Implementation Order

1. **Worktree setup** — create from `feature/message-worker-extraction`, branch `feature/platform-abstraction`
2. **Replybot inbound** — `event-normalizer.js` + modify `machine.js` `categorizeEvent()` + `exec()` + `transition.js`
3. **Replybot outbound** — `generic-translator.js` + modify `machine.js` `respond()`/`_gatherResponses()`/`act()` + `transition.js` `buildCommands()`
4. **Replybot cleanup** — remove `messenger/index.js`, replace `getUserInfo` with `{ id: userId }`, remove `getPageToken`, update `package.json`
5. **Message-worker types** — update `command.go` (add `HandoffCommand`, `PlatformContext`, update `Option`, remove `MessageTypeNative`/`MessageTypePassThreadControl`), update `events.go`
6. **Message-worker worker** — update `worker.go` routing (two-level dispatch), update `main.go` deserialization
7. **Message-worker client** — update `messenger_client.go` (recipient from platform_context, remove `SendNativeMessage`), update `client.go` interface, update `stub_clients.go`
8. **Message-worker translator** — update `translator.go` for `json.RawMessage` metadata and option values
9. **Integration testing** — full flow with facebot/dev.sh
10. **Documentation** — update `replybot/README.md`, `message-worker/README.md`, add `documentation/platform-abstraction.md`

---

## Migration & Testing Strategy

### Atomic Switch

Once replybot produces generic commands, Phase 1 `type: "native"` commands stop. Message-worker's `processTranslatedMessage()` path activates. **Both services must be deployed together** — there's no backward compatibility between Phase 1 and Phase 2 command formats.

### Deployment Order

1. Deploy message-worker first with the new code (it can handle both old `native` commands and new `send_message`/`handoff` commands during a brief overlap)
2. Deploy replybot with the new code
3. Verify commands flow through correctly

Actually, this is tricky. The new message-worker WON'T handle old `native` commands because we're removing `MessageTypeNative`. Options:
- **Option A:** Deploy both simultaneously (zero-downtime deployment with coordinated rollout)
- **Option B:** Make message-worker temporarily support BOTH old and new formats during transition
- **Option C:** Drain the `commands` Kafka topic before deploying replybot, then deploy both

**Recommendation: Option A** — coordinated deployment. The `commands` topic is low-volume (only active conversations), so draining is feasible.

### Integration Test

Full flow with facebot:
1. Send a message via facebot
2. Verify replybot normalizes it to UniversalEvent
3. Verify replybot produces `send_message` commands with MessageContent
4. Verify message-worker translates MessageContent to Messenger format
5. Verify message-worker sends to Facebook API (or facebot mock)
6. Verify error feedback loop works (machine_report → BLOCKED/ERROR state)

### Existing Tests

- replybot has tests in `lib/**/*.test.js` — these must be updated for the new UniversalEvent and MessageContent formats
- message-worker has comprehensive tests in `*_test.go` — these must be updated for new command types and removed native path

---

## Risk Assessment & Open Questions

### High Risk

1. **`_gatherResponses()` rewrite** — This recursive function is subtle and handles statement gathering, repeat questions, and keepMoving logic. Any bug here causes wrong messages to be sent. Must be thoroughly tested.

2. **ECHO handler metadata parsing** — Currently parses `event.message.metadata` as JSON string. After normalization, it's `event.payload.metadata` which is already an object. But the metadata shape has changed (no longer Facebook-specific). Must verify all metadata fields are preserved correctly.

3. **Option.Value deserialization** — Changing from `interface{}` to `json.RawMessage` in Go requires updating `ValueAsString()` and all quick_reply payload construction in the translator. Boolean values (`true`/`false`) must serialize correctly.

4. **translate-typeform dependency** — We're keeping `addCustomType()` and `parseNumber()` from `translate-typeform`. If this package is tightly coupled to the `translator()` function internally, we may need to port more code than expected.

### Medium Risk

5. **REFERRAL handler** — `getForm(event)` reads from `event.referral.ref`. After normalization, this is `event.payload.referral.ref`. Need to update `getForm()` in `ourform.js`.

6. **OTN token flow** — The current flow embeds OTN in `recipient: { one_time_notif_token }` within the message body. The new flow separates it into `platform_context`. Must verify message-worker correctly constructs the recipient from platform_context.

7. **Chat-log publisher** — Currently uses old `categorizeEvent()` and `parseEvent()`. If we skip updating it, we must ensure `VLAB_CHAT_LOG_TOPIC` is not set, or the publisher will crash.

### Open Questions

1. **`validator()` from translate-typeform** — We still need it for response validation. It takes `addCustomType(interpolateField(ctx, qa, field))` and `custom_messages` and returns `{ valid, message }`. This function is platform-agnostic and should continue to work. But we need to verify it doesn't depend on Facebook-specific field properties.

2. **`defaultMessage()`, `followUpMessage()`, `offMessage()` from translate-typeform** — These are also platform-agnostic message generators used in `_response()`. They return plain text strings. Should continue to work.

3. **`getForm()` function** — Currently in `ourform.js`, reads from the event object to extract form shortcode from referral ref. After normalization, the referral data is in `event.payload.referral`. Need to update the function signature or how it's called.

4. **`getPageFromEvent()` from @vlab-research/utils** — Currently extracts page_id from parsed event. After normalization, page_id is in `event.source.account_id`. Can replace directly.

5. **Event replay / statestore** — The `StateStore` replays events from CockroachDB to rebuild state. These stored events are in the OLD raw Messenger format. After our changes, `exec()` expects `UniversalEvent`. We need either:
   - A migration to convert stored events to UniversalEvent format
   - OR a compatibility layer that normalizes old-format events during replay
   
   This is **CRITICAL** — without it, state recovery will break for existing users.

6. **Coordinated deployment** — Both replybot and message-worker must be deployed together. Need to verify deployment process supports this.

### Event Replay Compatibility — CRITICAL ARCHITECTURAL DECISION

**The normalization layer must work for BOTH fresh messages (from Kafka) AND replayed events (from CockroachDB).** Events are stored in their raw format in the `messages.content` column — no DB migration needed. The normalizer is called at both entry points.

**Current event flow (two paths, same parseEvent):**

```
Fresh:  Kafka raw string → parseEvent() (@vlab-research/utils recursiveJSONParser) → raw Messenger object → exec()
Replay: DB content string → parseEvent() (StateStore._getEvents .map(this.parseEvent)) → raw Messenger object → getState() → exec()
```

**New event flow (two paths, same normalizer):**

```
Fresh:  Kafka raw string → parseEvent() → raw Messenger object → normalizeEvent() → UniversalEvent → exec()
Replay: DB content string → parseEvent() → raw Messenger object → normalizeEvent() → UniversalEvent → getState() → exec()
```

**Implementation:**

The normalization function `normalizeEvent()` is added to `event-normalizer.js`. It takes a parsed raw event (the output of `parseEvent()`) and produces a `UniversalEvent`.

**Where it's called:**

1. **`StateStore._getEvents()`** — After `.map(this.parseEvent)`, add `.map(normalizeEvent)`:
   ```javascript
   async _getEvents(user, event) {
     const res = await this.db.get(user, +STATE_STORE_LIMIT)
     return _resolve(res, event)
       .map(this.parseEvent)
       .map(normalizeEvent)  // NEW: normalize raw events to UniversalEvent
       .slice(0, -1)
   }
   ```

2. **`Machine.run()`** — Replace the current flow:
   ```javascript
   // CURRENT:
   const event = parseEvent(rawEvent)
   
   // NEW:
   const event = normalizeEvent(parseEvent(rawEvent))
   ```

**Key invariant:** `normalizeEvent()` produces identical `UniversalEvent` objects regardless of whether the input came from Kafka or from the database. Since both sources contain the same raw JSON (just differently stringified), and `parseEvent()` normalizes the stringification, this is guaranteed.

**No database migration needed.** Events stay stored in raw Messenger format. The normalization happens at read time, not write time. This means:
- Old stored events (Messenger format) are normalized when replayed
- New events from any platform are normalized when received
- Adding a new platform (WhatsApp) just requires a new parser in the normalizer — all existing stored Messenger events continue to work
