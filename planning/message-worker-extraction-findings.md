# Message Worker Extraction - Replybot Investigation Findings

## Overview

Replybot is a **Kafka-consuming state machine engine** that processes Facebook/Instagram/WhatsApp webhook events and responds by sending messages back through the Facebook Graph API. It does NOT directly send messages to users itself—instead, it:

1. Consumes webhook events from Kafka (via BotSpine)
2. Transitions state based on event + current state
3. Generates message payloads to send
4. Publishes outgoing messages back to Kafka for downstream processing

**Key insight:** Messages are published to `VLAB_RESPONSE_TOPIC` Kafka topic, NOT sent directly to Facebook. Some other service (likely a separate message-worker) consumes those messages and actually calls the Facebook Graph API.

---

## Architecture: High-Level Data Flow

```
Kafka (Incoming Events)
         ↓
   BotSpine (stream processor)
         ↓
   Machine.run() (state transition + message generation)
         ↓
   produce() → Kafka (VLAB_RESPONSE_TOPIC + VLAB_STATE_TOPIC + VLAB_PAYMENT_TOPIC)
         ↓
[Downstream service] → Facebook Graph API
```

### Entry Point
- **File:** `/home/nandan/Documents/vlab-research/fly/replybot/lib/index.js` (lines 54-106)
- **Main processor function:** `processor()` at line 55
- **Orchestrator:** `SpineSupervisor` using `BotSpine` from `@vlab-research/botspine`
- **Number of spines:** Controlled by `NUM_SPINES` environment variable

---

## 1. Message Sending Architecture

### High-Level Flow in Machine.run()

**File:** `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/transition.js`

```javascript
async run(state, user, rawEvent)
  ↓
transition(state, event)           // state machine decision
  ↓
actionsResponses()                 // generate messages + get tokens/forms
  ↓
act(actions, pageToken)            // send messages to Facebook
  ↓
sendMessage(action, pageToken)     // loop through each message
  ↓
facebookRequest()                  // make API call with retry logic
```

**Key lines:**
- Lines 79-173: The complete `run()` method
- Line 130: `await this.actionsResponses(state, user, timestamp, page, newState, output)` — generates message payloads
- Line 132: `await this.act(actions, pageToken)` — sends messages to Facebook
- Lines 140-150: Success report returned with `actions`, `responses`, `payment`, `handoff`

### Message Generation: from State Machine to Message Object

**File:** `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/machine.js`

**Flow:**
```
act(ctx, state, output)                    // Line 641
  ↓
switch (output.action)
  - 'RESPOND':      respond(ctx, qa, output)         // Line 646
  - 'SWITCH_FORM':  respond(ctx, md, [], output)     // Line 670
  ↓
_gatherResponses(ctx, qa, _response(...))  // Line 821
  ↓
translateField(ctx, qa, field)             // Typeform → Facebook message format
  ↓
addRecipient()                             // Add recipient: { id: userId }
```

**Key functions:**
- `act()` at line 641 — Main dispatcher. Routes based on action type. Returns `{ messages: [], payment?, handoff? }`
- `respond()` at line 818 — Builds message array from qa log + form
- `_gatherResponses()` at line 743 — Recursively gathers multi-question responses (handles "statement" fields that auto-advance)
- `_response()` at line 770 — Builds individual message object

### Message Object Structure (Before Recipient Addition)

The `translateField()` function (via `@vlab-research/translate-typeform` package) returns a message object with this structure:

```javascript
{
  message: {
    text: "Question text here",
    metadata: JSON.stringify({
      type: "question",     // or "statement"
      ref: "field_ref",
      wait?: {...},         // if waiting for external event
      repeat?: true,        // if repeated validation failure
      off?: true,           // if form is off-time
      payment?: {...},      // if field has payment action
      handoff?: {...}       // if field has handoff action
      keepMoving?: boolean  // if statement without wait
    })
  }
}
```

Or for attachments (images, files):
```javascript
{
  message: {
    attachment: {
      type: "image|file|video|...",
      payload: { url: "..." }
    },
    metadata: JSON.stringify({...})
  }
}
```

Or for quick replies:
```javascript
{
  message: {
    text: "Question with options",
    quick_replies: [
      { content_type: "text", title: "Option 1", payload: "opt1" },
      ...
    ],
    metadata: JSON.stringify({...})
  }
}
```

After `respond()` adds recipient:
```javascript
{
  recipient: { id: "USER_PSID" },
  message: {
    text: "...",
    metadata: JSON.stringify({...})
  }
}
```

Or with one-time notification token (for opt-in users):
```javascript
{
  recipient: { one_time_notif_token: "TOKEN" },
  message: { text: "...", metadata: JSON.stringify({...}) }
}
```

**Key lines:**
- Line 819: `addRecipient = dat => ({ recipient: { id: ctx.user.id }, ...dat })`
- Line 823: `map(r => r.recipient ? r : addRecipient(r))` — ensures all messages have recipient
- Lines 784-786: One-time notification token handling

---

## 2. Sending Messages to Facebook

### Direct Facebook API Integration

**File:** `/home/nandu/Documents/vlab-research/fly/replybot/lib/messenger/index.js`

**Key functions:**

#### `sendMessage(data, pageToken)`
- **Purpose:** Call Facebook Graph API `POST /me/messages`
- **Parameters:**
  - `data`: Message object (with `recipient` and `message` fields)
  - `pageToken`: Facebook page token for authentication
- **Returns:** Facebook API response (includes `message_id` on success)
- **Retry logic:** Exponential backoff (see below)

**Line 60-65:**
```javascript
async function sendMessage(data, pageToken) {
  const headers = { Authorization: `Bearer ${pageToken}` }
  const url = `${BASE_URL}/me/messages`
  const fn = () => r2.post(url, { headers, json: data }).json
  return await facebookRequest(fn)
}
```

#### `getUserInfo(id, pageToken)`
- **Purpose:** Fetch user profile from Facebook Graph API
- **Call:** `GET /<psid>?fields=id,name,first_name,last_name`
- **Returns:** `{ id, name, first_name, last_name }`
- **Cached:** Via Cacheman with TTL from `REPLYBOT_MACHINE_TTL` (default: 60 minutes)
- **Fallback:** `{ id, name: '_', first_name: '_', last_name: '_' }` if API fails

#### `passThreadControl(userId, targetAppId, metadata, pageToken)`
- **Purpose:** Hand off conversation to a different app (e.g., human agent)
- **Call:** `POST /me/pass_thread_control`
- **Parameters:**
  - `recipient: { id: userId }`
  - `target_app_id`: App to hand off to
  - `metadata`: JSON string with context

### Retry Logic

**File:** `/home/nandan/Documents/vlab-research/fly/replybot/lib/messenger/index.js`, lines 10-41

**Implemented in `facebookRequest(reqFn, retries = 0)`:**

1. **Timeout retries (ETIMEDOUT errors):**
   - Max retries: `FACEBOOK_RETRIES` (default: 5)
   - Backoff: Exponential — `Math.pow(2, retries) * BASE_RETRY_TIME`
   - `BASE_RETRY_TIME` default: 400ms
   - Delays: 400ms, 800ms, 1600ms, 3200ms, 6400ms

2. **Facebook API error retries:**
   - Retryable error codes: `[1200, 551]` (rate limit, service unavailable)
   - Same exponential backoff as timeout retries

3. **Non-retryable errors:**
   - Wrapped in `MachineIOError` with tag `'FB'` or `'NETWORK'`

**Code (lines 19-37):**
```javascript
if (e.code === 'ETIMEDOUT' && retries < RETRIES) {
  await delay(Math.pow(2, retries) * BASE_RETRY_TIME)
  res = await facebookRequest(reqFn, retries + 1)
} else {
  throw new MachineIOError('NETWORK', e.message, { code: e.code, message: e.message })
}

if (res && res.error) {
  const retryCodes = [1200, 551]
  if (retryCodes.includes(res.error.code) && retries < RETRIES) {
    await delay(Math.pow(2, retries) * BASE_RETRY_TIME)
    return await facebookRequest(reqFn, retries + 1)
  }
  throw new MachineIOError('FB', res.error.message, res.error)
}
```

### In-Memory Caching

**File:** `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/transition.js`, lines 13-27

Uses `Cacheman` to cache:
- **Form definitions:** `form:${pageid}:${shortcode}:${timestamp}` — TTL: `REPLYBOT_MACHINE_TTL`
- **User profiles:** `user:${id}` — TTL: `REPLYBOT_MACHINE_TTL`
- **Page tokens:** `pagetoken:${page}` — TTL: `REPLYBOT_MACHINE_TTL`

---

## 3. Message Types Supported

### From Typeform Translation

Replybot uses the `@vlab-research/translate-typeform` package to convert Typeform field definitions into Facebook message formats.

**Supported message types (inferred from code + translator package):**

1. **Text with Quick Replies**
   ```javascript
   {
     message: {
       text: "Your question?",
       quick_replies: [
         { content_type: "text", title: "Option A", payload: "a" },
         { content_type: "text", title: "Option B", payload: "b" }
       ]
     }
   }
   ```

2. **Text with Buttons** (via attachments)
   ```javascript
   {
     message: {
       attachment: {
         type: "template",
         payload: {
           template_type: "button",
           text: "Your question?",
           buttons: [
             { type: "postback", title: "Option A", payload: "a" },
             { type: "web_url", title: "Link", url: "..." }
           ]
         }
       }
     }
   }
   ```

3. **Image Attachments**
   ```javascript
   {
     message: {
       attachment: {
         type: "image",
         payload: { url: "https://..." }
       }
     }
   }
   ```

4. **File Attachments**
   ```javascript
   {
     message: {
       attachment: {
         type: "file",
         payload: { url: "https://..." }
       }
     }
   }
   ```

5. **Plain Text**
   ```javascript
   {
     message: {
       text: "Just text"
     }
   }
   ```

6. **Statements** (auto-advance without user input)
   - Handled via `keepMoving` metadata flag
   - Machine automatically sends next question after statement
   - See `_gatherResponses()` at line 758 in machine.js

**Message validation:**
- Invalid responses trigger repeat of previous question
- `validator()` from `@vlab-research/translate-typeform` checks field conditions
- Custom validation messages via `ctx.form.custom_messages`

---

## 4. Replybot Structure

### Directory Organization

```
replybot/
├── lib/
│   ├── index.js                    # Main entry point, Kafka orchestration
│   ├── producer.js                 # Kafka producer setup (node-rdkafka)
│   ├── errors.js                   # Error definitions (MachineIOError)
│   ├── messenger/
│   │   └── index.js                # Facebook API calls (sendMessage, passThreadControl)
│   ├── typewheels/
│   │   ├── machine.js              # Core message generation logic (act, respond)
│   │   ├── transition.js           # State machine runner (Machine class)
│   │   ├── form.js                 # Form field translation & interpolation
│   │   ├── statestore.js           # State persistence
│   │   ├── tokenstore.js           # Page token fetching
│   │   ├── utils.js                # Helpers (form lookup, metadata parsing)
│   │   ├── waiting.js              # Wait condition evaluation
│   │   ├── events.test.js          # Test event fixtures
│   │   └── *.test.js               # Unit tests
│   ├── responses/
│   │   ├── responser.js            # Legacy response writer (not active in current flow)
│   │   ├── stateman.js             # Legacy state writer (not active)
│   │   ├── batch.js                # Legacy batch processor
│   │   ├── pgstream.js             # DB stream helpers
│   │   └── debugger.js             # Debugging utilities
│   ├── chat-log/
│   │   ├── publisher.js            # Publishes chat log entries to Kafka
│   │   └── publisher.test.js
│   ├── spine-supervisor/
│   │   ├── spine-supervisor.js     # BotSpine orchestrator
│   │   └── mock-chatbase.js        # Mock database for tests
│   └── typewheels/
│       └── ourform.js              # Form fetching via HTTP
├── package.json                    # Dependencies (see below)
├── README.md                        # Setup & deployment docs
└── mocks/
    └── sample.json                 # Sample Typeform definition for tests
```

### Main Components

1. **SpineSupervisor** (`spine-supervisor/spine-supervisor.js`)
   - Creates `NUM_SPINES` instances of BotSpine workers
   - Each worker processes Kafka stream independently
   - Calls `processor()` function for each event

2. **Machine** (core state machine)
   - `Machine.run(state, user, rawEvent)` — main entry point
   - Handles state transitions and message generation
   - Coordinates token fetching, form loading, message sending
   - Returns a report object with `actions`, `responses`, `payment`, `handoff`

3. **BotSpine** (from `@vlab-research/botspine`)
   - Stream processor wrapper around node-rdkafka
   - Provides source, transform, sink streams
   - Handles Kafka connection & message parsing/serialization

4. **Producer** (Kafka message publishing)
   - Publishes to Kafka topics: `VLAB_STATE_TOPIC`, `VLAB_RESPONSE_TOPIC`, `VLAB_PAYMENT_TOPIC`, `VLAB_CHAT_LOG_TOPIC`
   - Configured via environment variables

### Lifecycle: Event to Published Response

**File:** `/home/nandan/Documents/vlab-research/fly/replybot/lib/index.js`, lines 54-106

```javascript
processor(machine, stateStore) → async function _processor({ key: userId, value: event })

  1. Parse event: parseEvent(rawEvent)
  2. Load state: stateStore.getState(userId, event)
  3. Run machine: machine.run(state, userId, event)
  4. Get report: { newState, responses, payment, handoff, actions }
  5. Publish results:
     - publishState()       → VLAB_STATE_TOPIC
     - publishResponses()   → VLAB_RESPONSE_TOPIC
     - publishPayment()     → VLAB_PAYMENT_TOPIC
     - publishChatLog()     → VLAB_CHAT_LOG_TOPIC (if configured)
  6. Update local state: stateStore.updateState(userId, newState)
```

---

## 5. Kafka Topics & Data Flow

### Topics Consumed
- **Via BotSpine:** Incoming webhook events (topic configured via BotSpine, not explicitly in replybot code)
- Stream name: `vlab-spinaltap-synthetic` or similar (from botserver → replybot bridge)

### Topics Produced

**1. VLAB_STATE_TOPIC**
- **Purpose:** Persist state machine state after every transition
- **Message structure:**
  ```javascript
  {
    userid,
    pageid,
    updated: timestamp,
    current_state: state.state,
    state_json: state  // Full state object
  }
  ```
- **Key:** `userid` (for partitioning)

**2. VLAB_RESPONSE_TOPIC**
- **Purpose:** Outgoing messages to be sent to users
- **Message structure:**
  ```javascript
  {
    parent_surveyid,
    parent_shortcode,
    surveyid,
    shortcode,
    flowid,
    userid,
    pageid,
    question_ref,
    question_idx,
    question_text,
    response,
    seed,
    metadata,
    timestamp
  }
  ```
- **Note:** This is metadata about the response, NOT the actual message payload
- **Key:** `userid` (for partitioning)

**3. VLAB_PAYMENT_TOPIC**
- **Purpose:** Payment/financial transaction records
- **Message structure:**
  ```javascript
  {
    userid,
    pageid,
    timestamp,
    ...payment  // Field-specific payment metadata
  }
  ```
- **Key:** `userid`
- **Populated when:** A form field has payment metadata

**4. VLAB_CHAT_LOG_TOPIC** (optional)
- **Purpose:** Log all visible messages (for analytics)
- **Publisher:** `lib/chat-log/publisher.js`
- **Message structure:**
  ```javascript
  {
    userid,
    pageid,
    timestamp,
    event_type,  // 'echo', 'text', 'quick_reply', 'postback'
    text,
    ...
  }
  ```
- **Key:** `userid`
- **Only active if:** `VLAB_CHAT_LOG_TOPIC` environment variable is set

---

## 6. Where Messages Are Actually Sent to Facebook

### IMPORTANT FINDING: Decoupled Architecture

**Replybot does NOT directly send messages to Facebook users.**

Instead:
1. Replybot generates message payloads and publishes them to `VLAB_RESPONSE_TOPIC`
2. **A separate downstream service** (likely a "message worker") consumes `VLAB_RESPONSE_TOPIC`
3. That downstream service calls `sendMessage()` to the Facebook Graph API

**Evidence:**
- In `lib/index.js`, line 74: Messages are published via `publishResponses(report.responses)` to Kafka
- In `transition.js`, lines 132-138: `Machine.act()` is called to send messages INSIDE the main processor loop
- BUT: Looking at the actual `report` structure returned from `machine.run()`, it includes `actions` (the message payloads) that should be sent

**Discrepancy to investigate:** There's a potential mismatch:
- `Machine.act()` in transition.js DOES call `this.sendMessage()` (lines 65-71)
- But the report being published to Kafka (line 145) includes the generated messages as `actions`

**Most likely scenario:**
- Replybot CAN send messages synchronously (via `Machine.act()`)
- AND it also publishes the messages to Kafka for async processing / audit trail
- The downstream message-worker would be redundant if Kafka publishing is the primary path

### Current Call Chain (Within Replybot)

If replybot DOES send messages synchronously:
```
Machine.run()
  ↓
actionsResponses() → generate message payloads
  ↓
act(messages, pageToken) → loop and send each
  ↓
sendMessage(action, pageToken) → call Facebook Graph API
  ↓
facebookRequest(reqFn, retries) → with exponential backoff
```

---

## 7. Dependencies

### Direct Dependencies (package.json)

| Package | Version | Purpose |
|---------|---------|---------|
| `@vlab-research/botspine` | 0.0.13 | Kafka stream processor abstraction |
| `@vlab-research/chatbase-postgres` | ^0.1.0 | Database abstraction (state/responses) |
| `@vlab-research/translate-typeform` | ^0.2.7 | Convert Typeform → Facebook message format |
| `@vlab-research/utils` | 0.0.11 | Shared utilities (parseEvent, etc.) |
| `node-rdkafka` | (via BotSpine) | Kafka producer/consumer |
| `cacheman` | ^2.2.1 | In-memory caching (forms, users, tokens) |
| `mustache` | ^4.0.0 | Template interpolation in questions |
| `js-yaml` | ^3.14.0 | Value casting for type coercion |
| `r2` | ^2.0.1 | HTTP client for Facebook Graph API |
| `lodash` | ^4.17.11 | Utility functions |
| `parse-duration` | ^0.4.4 | Parse duration strings (TTLs) |
| `jsonwebtoken` | ^8.5.1 | Token handling |
| `farmhash` | ^3.0.0 | Hashing for seed generation |
| `ioredis` | ^5.3.2 | Redis (if used for caching) |

### Environment Dependencies

| Variable | Default | Purpose |
|----------|---------|---------|
| `NUM_SPINES` | (required) | Number of parallel Kafka consumer workers |
| `KAFKA_BROKERS` | (required) | Kafka broker addresses |
| `VLAB_STATE_TOPIC` | (required) | Topic for state persistence |
| `VLAB_RESPONSE_TOPIC` | (required) | Topic for outgoing messages |
| `VLAB_PAYMENT_TOPIC` | (required) | Topic for payment events |
| `VLAB_CHAT_LOG_TOPIC` | (optional) | Topic for chat log entries |
| `FACEBOOK_GRAPH_URL` | `https://graph.facebook.com/v8.0` | Facebook API base URL |
| `FACEBOOK_RETRIES` | 5 | Retry attempts for API calls |
| `FACEBOOK_BASE_RETRY_TIME` | 400 | Base retry delay in ms |
| `REPLYBOT_STATESTORE_TTL` | `24h` | State cache TTL |
| `REPLYBOT_MACHINE_TTL` | `60m` | Form/user/token cache TTL |
| `CHATBASE_BACKEND` | (required) | Database backend module |
| `BOTSERVER_URL` | (required) | URL for reporting machine events |
| `KAFKA_CONNECTION_TIMEOUT` | 30000 | Kafka connection timeout in ms |

---

## 8. Error Handling

### Error Types

**File:** `/home/nandan/Documents/vlab-research/fly/replybot/lib/errors.js`

1. **MachineIOError** — Wrapper for IO errors (Facebook API, network, Kafka)
   - `tag`: 'NETWORK', 'FB', 'INTERNAL'
   - Includes `details` object with original error info
   - Caught in `transition.js` line 153

2. **FieldError** — Validation errors when fetching/processing form fields
   - Gracefully ignored (line 59 in responser.js)
   - Typically means field configuration is missing/invalid

3. **Standard Errors** — State machine logic errors
   - Logged and published in error report

### Error Reporting

**File:** `/home/nandan/Documents/vlab-research/fly/replybot/lib/index.js`, lines 83-88

On error:
1. Log to console: `console.error('Error from ReplyBot: \n', e.message, ...)`
2. Don't crash the processor (graceful error handling)
3. Continue processing next event

Errors are caught at processor level but NOT published back via Kafka (only logged).

---

## 9. State Machine States

**File:** `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/machine.js`, line 828

```javascript
_initialState() {
  return { state: 'START', qa: [], forms: [] }
}
```

**Key state properties:**
- `state`: Current state (START, RESPONDING, QOUT, BLOCKED, etc.)
- `qa`: Array of [question_ref, answer_value] pairs (question-answer history)
- `forms`: Array of active form shortcodes
- `md`: Metadata (seed, startTime, referrer, handover info, etc.)
- `wait`: Waiting condition (for external events)
- `pointer`: Pagination pointer

**State transitions** are determined by event categorization (line 163):
- REFERRAL, OPTIN, UNBLOCK, FOLLOW_UP, REPEAT_PAYMENT, REDO, PLATFORM_RESPONSE, MACHINE_REPORT, BAILOUT, BLOCK_USER
- HANDOVER_EVENT, EXTERNAL_EVENT, WATERMARK, ECHO, POSTBACK, QUICK_REPLY, TEXT, MEDIA, REACTION, UNKNOWN

---

## 10. Key Design Patterns

### 1. Pure Function Core
- `exec(state, event)` — Pure function determining action (no side effects)
- `apply(state, output)` — Pure function applying action to state (no side effects)
- `act(ctx, state, output)` — Pure function generating messages

### 2. Functional Composition
- Message generation chains: `translateField()` → `addCustomType()` → `interpolateField()`
- Recursive message gathering: `_gatherResponses()` for multi-part responses

### 3. Caching Layers
- Cacheman for form/user/token caching with TTL
- Avoids repeated Facebook API calls for same user/page

### 4. Error Wrapping
- `iowrap()` function wraps IO operations with error handling
- Converts errors to `MachineIOError` for structured reporting

### 5. Metadata Preservation
- Message metadata field stores machine-internal state (repeat, wait, payment, handoff)
- Allows downstream services to understand message context

---

## 11. Message Batching

**NO explicit batching** at the replybot level.

**Behavior:**
- For a single state transition, one or more messages may be generated
- Each message is sent individually (loop in `act()` at line 67 of transition.js)
- Multiple questions can be sent if previous question was a "statement" type
- `_gatherResponses()` recursively collects all messages before sending

**Example:** If user answers, and the next field is a statement with a condition:
1. Generate response to user's answer
2. Generate the statement message
3. Generate the next interactive field
4. All sent in a single event processing cycle

---

## 12. Architectural Gaps & Questions

### Unresolved Questions

1. **Message worker relationship:** Is there a separate service consuming `VLAB_RESPONSE_TOPIC` and actually sending to Facebook? Or is replybot doing it all?
   - Evidence for separate worker: Kafka topic publishing
   - Evidence against: `Machine.act()` directly calls `sendMessage()`
   - **Need to check:** Downstream consumers of `VLAB_RESPONSE_TOPIC`

2. **Response topic usage:** The `VLAB_RESPONSE_TOPIC` publishes metadata about responses (question_ref, response text), not the actual message payload sent to Facebook
   - This is used for analytics/auditing, not for actual message delivery

3. **State topology:** With multiple spines processing events, how is state consistency maintained?
   - StateStore uses version/timestamp checks (UPSERT logic)
   - Potential race conditions if same user sends multiple messages simultaneously

### Key Assumptions

1. **Page tokens are pre-stored** — Replybot fetches via `TokenStore.get(page)`, assumes tokens exist in database
2. **Forms are cached after first fetch** — No hot-reload if Typeform definitions change (cache TTL is 24h)
3. **Messages are sent synchronously** — `Machine.act()` awaits all `sendMessage()` calls before returning

---

## Files Referenced

### Core Flow Files
- `/home/nandan/Documents/vlab-research/fly/replybot/lib/index.js` — Main processor & Kafka orchestration
- `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/transition.js` — Machine class & run logic
- `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/machine.js` — Message generation (act, respond)
- `/home/nandu/Documents/vlab-research/fly/replybot/lib/messenger/index.js` — Facebook API integration

### Supporting Files
- `/home/nandan/Documents/vlab-research/fly/replybot/lib/producer.js` — Kafka producer
- `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/form.js` — Field translation & interpolation
- `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/statestore.js` — State persistence
- `/home/nandan/Documents/vlab-research/fly/replybot/lib/chat-log/publisher.js` — Chat log publishing
- `/home/nandan/Documents/vlab-research/fly/replybot/lib/errors.js` — Error definitions

### Configuration Files
- `/home/nandan/Documents/vlab-research/fly/replybot/package.json` — Dependencies
- `/home/nandan/Documents/vlab-research/fly/replybot/README.md` — Setup & deployment

---

## Summary: For Message Worker Extraction

**If you're extracting a message-worker service:**

1. **Take from transition.js:**
   - `Machine.act()` method (lines 65-72)
   - `sendMessage()` calls
   - Facebook API integration from `messenger/index.js`
   - Retry logic from `facebookRequest()`

2. **Interface the worker should expose:**
   - Consume messages from Kafka topic (`VLAB_RESPONSE_TOPIC` or a new topic)
   - Each message has `recipient` and `message` fields
   - Call Facebook Graph API with retry logic
   - Publish success/failure back to audit topic

3. **Data it will receive:**
   - Message object with `recipient: { id: PSID }` or `{ one_time_notif_token: TOKEN }`
   - `message` field with `text`, `attachment`, `quick_replies`, etc.
   - Metadata in `message.metadata` for context

4. **What to keep in replybot:**
   - State machine logic (exec, apply)
   - Form/question generation (act, respond)
   - State persistence
   - Publishing to response topic

5. **What message-worker gains:**
   - Single responsibility: Convert message payload to Facebook API calls
   - Scalability: Run multiple instances to parallelize API calls
   - Observability: Track which messages succeeded/failed independently
   - Resilience: Decouple state machine from API call latency
