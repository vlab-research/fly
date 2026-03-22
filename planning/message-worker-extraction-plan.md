# Plan: Extract Message Sending from Replybot into Go Message-Worker

## Context

Replybot is a monolithic Node.js service that consumes Kafka events, runs a state machine, generates messages, and sends them directly to the Facebook Graph API — all in one synchronous loop. We want to incrementally migrate toward a distributed architecture by extracting the message-sending responsibility into a separate Go service (message-worker).

**Why now**: Instead of a big-bang Rust rewrite (the `feat/rust-replybot-migration` branch), we're adopting an incremental strangler-fig approach. Message sending is the cleanest seam to cut first — it's a leaf operation with no downstream dependencies.

**Intended outcome**: Exact same functionality as before. Replybot still runs the state machine and generates messages, but instead of calling the Facebook API directly, it publishes message commands to Kafka. A new Go message-worker service consumes those commands and delivers them.

**Phase 1 (this PR)**: Replybot publishes Facebook-native message payloads and handoff commands → worker forwards to Facebook API (passthrough).
**Phase 2 (future PR)**: Replybot emits platform-agnostic commands → worker handles all platform translation.

**Scope**: Messenger only (the only platform currently in production).

**Cleanup goal**: After extraction, the only Facebook API function remaining in replybot is `getUserInfo()`. The `sendMessage()` and `passThreadControl()` functions are deleted along with their tests.

---

## Architecture Change

```
BEFORE:
  Kafka events → Replybot → [state machine] → sendMessage() → Facebook API
                                             → passThreadControl() → Facebook API
                                             → publish metadata → Kafka (responses)

AFTER:
  Kafka events → Replybot → [state machine] → publish commands → Kafka (commands)
                                             → publish metadata → Kafka (responses)
                                                     ↓
                                             Message-Worker (Go)
                                               ├─ type: "native" → POST /me/messages
                                               └─ type: "pass_thread_control" → POST /me/pass_thread_control
                                                     ↓
                                             Facebook Graph API
                                                     ↓
                                             (on error) → machine_report → botserver → synthetic event → Kafka

After extraction, replybot/lib/messenger/index.js contains ONLY getUserInfo().
sendMessage() and passThreadControl() are deleted.
```

---

## Required Reading

Before implementing, agents MUST read:

| Document | Location | What it explains |
|----------|----------|-----------------|
| Replybot message-sending investigation | `planning/message-worker-extraction-findings.md` | How replybot currently generates and sends messages, the full code path from state machine to Facebook API, message object shapes, Kafka topics, error handling |
| Go message-worker investigation | `planning/message-worker-go-findings.md` | How the Go worker works, SendMessageCommand format, translation logic, retry strategy, token storage, gap analysis vs replybot |
| Integration testing guide | `planning/INTEGRATION_TESTING_GUIDE.md` | How to run E2E tests in the Kind cluster, service topology, debugging procedures |

---

## Implementation Steps

### Step 1: Bring over Go code from rust branch

**Source branch**: `feat/rust-replybot-migration`
**Target**: New feature branch (via git worktree)

Copy these directories using `git show` or `git checkout`:
```bash
# From the rust branch, copy:
git checkout feat/rust-replybot-migration -- message-worker/
git checkout feat/rust-replybot-migration -- burrow/
```

**`message-worker/`** — The full Go message-worker service. Key files:
- `cmd/message-worker/main.go` — Binary entry point. Sets up Kafka consumer (burrow), creates worker, runs graceful shutdown.
- `worker.go` — `ProcessCommand()` orchestration: translate → send → emit event. This is the main file to modify for passthrough mode.
- `translator.go` — `TranslateToMessenger(cmd) → MessengerMessage`. Converts platform-agnostic command to Facebook quick_replies/attachments format.
- `translator_whatsapp.go` — WhatsApp translation (buttons ≤3, lists 4-10). Unused in phase 1.
- `translator_instagram.go` — Instagram translation. Unused in phase 1.
- `messenger_client.go` — `MessengerClient.SendMessage()`. POSTs to `{baseURL}/me/messages` with Bearer token. Handles Facebook error codes (1200, 551, 2, -1 are retriable).
- `tokenstore.go` — `PostgresTokenStore.GetToken()`. Queries `credentials` table, caches tokens with configurable TTL (default 300s).
- `retry.go` — `RetryWithBackoff()`. Exponential backoff: 100ms → 200ms → 400ms, max 3 attempts. Classifies errors as retriable (network, 429, 5xx) vs non-retriable (400, 401, 403, 404).
- `config.go` — `LoadConfigFromEnv()`. All configuration from env vars.
- `kafka.go` — Kafka event producer for `message_sent`/`message_failed` events.
- `types/command.go` — `SendMessageCommand` struct (the Kafka input format).
- `types/events.go` — `UniversalEvent` envelope, `MessageSentPayload`, `MessageFailedPayload`.
- `types/messenger.go` — `MessengerMessage` struct (Facebook API format).
- `stub_clients.go` — WhatsApp/Instagram/Telegram stubs (return 501).
- `*_test.go` — 41 tests, 78.9% coverage.
- `go.mod`, `go.sum` — Dependencies (Go 1.25, confluent-kafka-go/v2, pgx/v5, zap, burrow).
- `Dockerfile` — Multi-stage build.
- `chart/` — Helm chart with deployment, service, HPA templates.

**`burrow/`** — Local Kafka consumer library. Provides concurrent message processing with at-least-once ordering guarantees. Used by message-worker's `main.go` to create a `burrow.Pool` of 100 workers.

After copying, verify the Go code compiles:
```bash
cd message-worker && go build ./...
```

### Step 2: Add native passthrough and pass_thread_control to Go message-worker

The worker currently expects platform-agnostic `SendMessageCommand` with `message.type: text|question|media` and calls `TranslateToMessenger()` to convert. For phase 1, we need two new command types:

1. **`native`** — Pre-formatted Facebook message payloads (skip translation, forward to `/me/messages`)
2. **`pass_thread_control`** — Handoff commands (forward to `/me/pass_thread_control`)

#### 2a. Type changes

**Changes to `message-worker/types/command.go`:**

The current `MessageContent` struct:
```go
type MessageContent struct {
    Type         string            `json:"type"`           // "text", "question", "media"
    Text         string            `json:"text,omitempty"`
    QuestionText string            `json:"question_text,omitempty"`
    Options      []Option          `json:"options,omitempty"`
    MediaType    string            `json:"media_type,omitempty"`
    MediaURL     string            `json:"media_url,omitempty"`
    Caption      string            `json:"caption,omitempty"`
    Metadata     map[string]string `json:"metadata,omitempty"`
}
```

Add new fields:
```go
type MessageContent struct {
    Type         string            `json:"type"`           // "text", "question", "media", "native", "pass_thread_control"
    // ... existing fields ...
    NativePayload json.RawMessage  `json:"native_payload,omitempty"` // Pre-formatted platform message (for type "native")
    // Fields for pass_thread_control:
    TargetAppID  string            `json:"target_app_id,omitempty"`  // App to hand off to
    HandoffMetadata string         `json:"handoff_metadata,omitempty"` // JSON string context for handoff
}
```

#### 2b. Worker routing

**Changes to `message-worker/worker.go` (`ProcessCommand()`):**

Current flow (simplified):
```go
func (w *Worker) ProcessCommand(ctx context.Context, cmd SendMessageCommand) error {
    // 1. Translate
    msg, err := Translate(cmd)  // dispatches to TranslateToMessenger/WhatsApp/Instagram
    // 2. Send
    messageID, err := w.client.SendMessage(ctx, cmd.UserID, cmd.PlatformAccountID, msg)
    // 3. Emit event
    w.emitSuccess(cmd, messageID)
}
```

Add routing by command type:
```go
func (w *Worker) ProcessCommand(ctx context.Context, cmd SendMessageCommand) error {
    switch cmd.Message.Type {
    case "native":
        // Phase 1: passthrough — skip translation, send pre-formatted payload
        return w.processNativeMessage(ctx, cmd)
    case "pass_thread_control":
        // Handoff — call /me/pass_thread_control
        return w.processPassThreadControl(ctx, cmd)
    default:
        // Existing translation path (text, question, media)
        return w.processTranslatedMessage(ctx, cmd)
    }
}

func (w *Worker) processNativeMessage(ctx context.Context, cmd SendMessageCommand) error {
    messageID, err := w.client.SendNativeMessage(ctx, cmd.UserID, cmd.PlatformAccountID, cmd.Message.NativePayload)
    if err != nil { /* error handling + machine_report */ }
    w.emitSuccess(cmd, messageID)
    return nil
}

func (w *Worker) processPassThreadControl(ctx context.Context, cmd SendMessageCommand) error {
    err := w.client.PassThreadControl(ctx, cmd.UserID, cmd.PlatformAccountID, cmd.Message.TargetAppID, cmd.Message.HandoffMetadata)
    if err != nil { /* error handling + machine_report */ }
    w.emitSuccess(cmd, "") // No message_id for thread control
    return nil
}
```

#### 2c. Client changes

**Changes to `message-worker/messenger_client.go`:**

Add two new methods:

```go
// SendNativeMessage sends a pre-formatted Facebook-native message payload.
// The payload should be the complete Facebook API request body including
// "recipient" and "message" fields.
func (c *MessengerClient) SendNativeMessage(ctx context.Context, userID, pageID string, payload json.RawMessage) (string, error) {
    token, err := c.tokenStore.GetToken(ctx, pageID)
    if err != nil {
        return "", fmt.Errorf("token lookup failed: %w", err)
    }

    url := fmt.Sprintf("%s/me/messages", c.baseURL)
    req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(payload))
    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("Authorization", "Bearer "+token)

    resp, err := c.httpClient.Do(req)
    // ... parse response, extract message_id, classify errors (same as existing SendMessage) ...
}

// PassThreadControl hands off the conversation to another app.
// Calls POST /me/pass_thread_control with the target app ID and metadata.
func (c *MessengerClient) PassThreadControl(ctx context.Context, userID, pageID, targetAppID, metadata string) error {
    token, err := c.tokenStore.GetToken(ctx, pageID)
    if err != nil {
        return fmt.Errorf("token lookup failed: %w", err)
    }

    body := map[string]interface{}{
        "recipient":     map[string]string{"id": userID},
        "target_app_id": targetAppID,
        "metadata":      metadata,
    }
    bodyBytes, _ := json.Marshal(body)

    url := fmt.Sprintf("%s/me/pass_thread_control", c.baseURL)
    req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(bodyBytes))
    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("Authorization", "Bearer "+token)

    resp, err := c.httpClient.Do(req)
    // ... check for errors, classify as retriable/non-retriable ...
    return nil
}
```

The `MessageSender` interface will need updating:
```go
type MessageSender interface {
    SendMessage(ctx context.Context, userID, pageID string, msg interface{}) (string, error)
    SendNativeMessage(ctx context.Context, userID, pageID string, payload json.RawMessage) (string, error)
    PassThreadControl(ctx context.Context, userID, pageID, targetAppID, metadata string) error
}
```

#### 2d. Tests

**Add tests in new file `worker_native_test.go`:**
- Test that `type: "native"` bypasses translation and forwards payload to Facebook API
- Test error handling for native messages (retriable vs non-retriable)

**Add tests in new file `worker_handoff_test.go`:**
- Test that `type: "pass_thread_control"` calls the correct endpoint
- Test with target_app_id and metadata
- Test error handling for handoff failures

### Step 3: Modify replybot to publish commands instead of calling Facebook API

#### 3a. Modify `replybot/lib/typewheels/transition.js`

**Current `Machine` class structure** (key methods):
```
Machine.run(state, user, rawEvent)     — lines 79-173, main orchestrator
Machine.actionsResponses(...)          — lines 101-128, generates messages + gets tokens
Machine.act(actions, pageToken)        — lines 65-72, loops and calls sendMessage()
Machine.sendMessage(action, pageToken) — lines 55-63, calls Facebook API via messenger module
```

**Change `Machine.act()`** — Instead of sending messages, just return them:
```javascript
// BEFORE (lines 65-72):
async act(actions, pageToken) {
    for (const action of actions.messages) {
        await this.sendMessage(action, pageToken)
    }
}

// AFTER:
act(actions) {
    // Just return the messages — they'll be published to Kafka by run()
    return actions.messages || []
}
```

**Change `Machine.run()`** — Publish commands to Kafka instead of calling act():
```javascript
// In run(), around line 130-140:
// BEFORE:
//   const actions = await this.actionsResponses(state, user, timestamp, page, newState, output)
//   await this.act(actions, pageToken)
//
// AFTER:
//   const actions = await this.actionsResponses(state, user, timestamp, page, newState, output)
//   const messages = this.act(actions)
//   // messages are returned in the report for publishing
```

The `run()` method returns a report object. Add the messages and handoff to it:
```javascript
// Build command list: messages + optional handoff
const commands = messages.map(msg => ({
    command_id: uuid(),
    issued_at: Date.now(),
    conversation_id: user,
    user_id: user,
    platform: 'messenger',
    platform_account_id: page,
    message: {
        type: 'native',
        native_payload: msg  // The Facebook-native payload (recipient + message)
    }
}))

// If there's a handoff action, add it as a command too
if (actions.handoff) {
    commands.push({
        command_id: uuid(),
        issued_at: Date.now(),
        conversation_id: user,
        user_id: user,
        platform: 'messenger',
        platform_account_id: page,
        message: {
            type: 'pass_thread_control',
            target_app_id: actions.handoff.target_app_id,
            handoff_metadata: JSON.stringify(actions.handoff.metadata || {})
        }
    })
}

return {
    newState,
    responses,
    payment: actions.payment,
    // handoff is now a command, no longer returned separately
    commands
}
```

**NOTE**: You'll need to add `uuid` dependency or use a simple ID generator. Check if replybot already has one (likely via `@vlab-research/utils` or `farmhash`).

**NOTE on handoff**: The current code path for `passThreadControl` needs to be traced. In the existing replybot, `Machine.run()` returns `handoff` in the report, and something calls `passThreadControl()` with it. Find that call site (likely in `transition.js` or `index.js`) and replace it with the command publishing. The handoff object typically has: `{ target_app_id, metadata }`. See `replybot/lib/messenger/index.js` `passThreadControl()` for the exact parameters.

#### 3b. Modify `replybot/lib/index.js`

**Current producer setup** (lines 17-50): Creates a Kafka producer and publishes to `VLAB_STATE_TOPIC`, `VLAB_RESPONSE_TOPIC`, `VLAB_PAYMENT_TOPIC`, `VLAB_CHAT_LOG_TOPIC`.

Add a new topic and publishing function:

```javascript
// Add new env var
const COMMANDS_TOPIC = process.env.KAFKA_COMMANDS_TOPIC || 'commands'

// Add new publish function (similar pattern to existing publishState/publishResponses)
function publishCommands(producer, commands) {
    for (const cmd of commands) {
        producer.produce(
            COMMANDS_TOPIC,
            null,                           // partition (null = auto)
            Buffer.from(JSON.stringify(cmd)),
            cmd.user_id,                    // key (for partitioning)
            Date.now()
        )
    }
}
```

In the `processor()` function (around line 74), after getting the report from `machine.run()`:
```javascript
// Existing:
publishState(report)
publishResponses(report.responses)
publishPayment(report.payment)

// Add:
if (report.commands && report.commands.length > 0) {
    publishCommands(producer, report.commands)
}
```

#### 3c. Clean up `replybot/lib/messenger/index.js`

**Delete** the following functions (they are now handled by message-worker):
- `sendMessage(data, pageToken)` — message delivery is now via Kafka → message-worker
- `facebookRequest(reqFn, retries)` — retry logic for Facebook API calls (only used by sendMessage and passThreadControl)
- `passThreadControl(userId, targetAppId, metadata, pageToken)` — handoff is now a command via Kafka → message-worker

**Keep** only:
- `getUserInfo(id, pageToken)` — still called synchronously by replybot during state machine execution to populate user context (name, etc.)
- Any helper used by `getUserInfo` (e.g., the `r2` HTTP client import, `BASE_URL` constant, `Cacheman` caching)

**Clean up tests**: Remove tests for `sendMessage`, `facebookRequest`, and `passThreadControl` from any test files in `replybot/lib/messenger/`. Keep tests for `getUserInfo`.

**Clean up imports**: Remove the `MachineIOError` import if it was only used for `sendMessage`/`passThreadControl` error wrapping. Check `replybot/lib/errors.js` — if `MachineIOError` is still used elsewhere (e.g., state machine logic), keep it; if it was only for Facebook API errors, it can be removed too.

**Update any files that import from `messenger/index.js`**: Search for `require('./messenger')` or `require('../messenger')` and remove references to deleted functions. The `transition.js` file likely imports `sendMessage` — that import should be removed as part of step 3a.

### Step 4: Error handling adaptation

**Current error flow in `transition.js`** (around lines 133-165):
```javascript
try {
    await this.act(actions, pageToken)
    // ... success path: return report with newState
} catch (e) {
    if (e instanceof MachineIOError) {
        // Transition to BLOCKED or ERROR state
        const errorState = { ...newState, state: 'BLOCKED', error: e }
        return { newState: errorState, ... }
    }
    throw e
}
```

**New error flow**: Since `act()` no longer does I/O, it won't throw `MachineIOError`. Remove or simplify the try/catch:

```javascript
// act() is now synchronous and won't throw IO errors
const messages = this.act(actions)
// ... return report with commands, no try/catch needed for IO
```

**How errors now flow**:
1. Message-worker tries to send, retries up to 3 times with exponential backoff
2. If all attempts fail, worker calls `POST {BOTSERVER_URL}/synthetic` with a `machine_report` event:
   ```json
   {
     "userid": "user_123",
     "pageid": "page_456",
     "type": "machine_report",
     "payload": {
       "tag": "FB",
       "message": "User has blocked the bot",
       "details": { "code": 403 }
     }
   }
   ```
3. Botserver publishes this as a synthetic event to Kafka
4. Replybot consumes it and handles `MACHINE_REPORT` event type (already implemented — see event categorization in `machine.js` line 163)
5. Replybot transitions user to BLOCKED state

**Important**: Replybot already categorizes and handles `MACHINE_REPORT` events. The `exec()` function in `machine.js` has a case for this event type. Verify this works correctly by tracing the code path.

### Step 5: Helm/deployment configuration

**Add message-worker to the Helm umbrella chart.**

The message-worker's `chart/` directory (from the rust branch) contains:
- `Chart.yaml` — chart metadata
- `values.yaml` — default configuration
- `templates/deployment.yaml` — Kubernetes Deployment
- `templates/service.yaml` — Kubernetes Service
- `templates/hpa.yaml` — HorizontalPodAutoscaler
- `templates/_helpers.tpl` — template helpers

**Integration with umbrella chart** (`devops/vlab/Chart.yaml`):
- Add message-worker as a dependency/subchart
- Or package it as a standalone chart and deploy separately

**Environment variables for message-worker deployment:**
```yaml
env:
  - name: KAFKA_BROKERS
    value: "kafka:9092"
  - name: KAFKA_COMMAND_TOPIC
    value: "commands"
  - name: KAFKA_EVENT_TOPIC
    value: "chat-events"
  - name: KAFKA_GROUP_ID
    value: "message-worker"
  - name: KAFKA_AUTO_OFFSET_RESET
    value: "latest"
  - name: DATABASE_URL
    valueFrom:
      secretKeyRef:
        name: cockroachdb-credentials
        key: url
  - name: BOTSERVER_URL
    value: "http://fly-botserver"
  - name: FACEBOOK_GRAPH_URL
    value: "https://graph.facebook.com/v18.0"
  - name: NUM_WORKERS
    value: "100"
  - name: MAX_RETRY_ATTEMPTS
    value: "3"
  - name: INITIAL_BACKOFF_MS
    value: "100"
  - name: MAX_BACKOFF_MS
    value: "1000"
```

For dev/testing, use `FACEBOOK_GRAPH_URL: "http://gbv-facebot"` to point at the facebot mock.

**New env var for replybot:**
```yaml
- name: KAFKA_COMMANDS_TOPIC
  value: "commands"
```

**Kafka topic**: Ensure `commands` topic exists. Check `devops/dev/kafka-manifests/topics.yaml` (or equivalent) and add if missing:
```yaml
- name: commands
  partitions: 6
  replication-factor: 1
```

### Step 6: Token storage compatibility

**CRITICAL**: The Go message-worker queries tokens from PostgreSQL:
```sql
SELECT COALESCE(details->>'access_token', details->>'token') AS token
FROM credentials
WHERE facebook_page_id = $1
ORDER BY created DESC LIMIT 1
```

**Replybot's token storage** is in `replybot/lib/typewheels/tokenstore.js`. It likely uses a different table/query. You MUST:

1. Read `replybot/lib/typewheels/tokenstore.js` to find the actual query
2. Check the production database schema for the token table
3. If the schema differs, adapt `message-worker/tokenstore.go` to match

**If replybot uses a different table** (e.g., `tokens` or `page_tokens`), update the Go query accordingly. The `TokenStore` interface is clean — just change the SQL in `GetToken()`.

**Alternative**: If tokens are stored in a format the Go worker can't easily query, you could pass the `pageToken` in the Kafka command message. Add a `token` field to the command and skip the database lookup when it's provided. This is less secure (tokens in Kafka) but simpler.

---

## Critical Files Reference

| File | Action | Purpose |
|------|--------|---------|
| `replybot/lib/typewheels/transition.js` | **Modify** | Remove direct sendMessage/passThreadControl calls, return messages+handoff as Kafka commands. Key methods: `act()` (lines 65-72), `run()` (lines 79-173) |
| `replybot/lib/index.js` | **Modify** | Add `publishCommands()` function, add `KAFKA_COMMANDS_TOPIC` env var. Remove handoff publishing if it was separate. Processor function at lines 54-106 |
| `replybot/lib/typewheels/machine.js` | **Read only** | Understand message generation: `act()` at line 641, `respond()` at line 818, `_gatherResponses()` at line 743. Do NOT modify. |
| `replybot/lib/messenger/index.js` | **Clean up** | Delete `sendMessage()`, `facebookRequest()`, `passThreadControl()`. Keep ONLY `getUserInfo()`. |
| `replybot/lib/messenger/*.test.*` | **Clean up** | Remove tests for deleted functions. Keep `getUserInfo` tests. |
| `replybot/lib/typewheels/tokenstore.js` | **Read** | Understand current token storage to verify compatibility with Go worker |
| `replybot/lib/errors.js` | **Review** | Check if `MachineIOError` is still used after removing Facebook API calls. Remove if orphaned. |
| `replybot/lib/producer.js` | **Read** | Understand existing Kafka producer setup to follow same pattern for commands |
| `message-worker/worker.go` | **Adapt** | Add native passthrough + pass_thread_control routing in `ProcessCommand()` |
| `message-worker/types/command.go` | **Adapt** | Add `NativePayload`, `TargetAppID`, `HandoffMetadata` fields to `MessageContent` |
| `message-worker/messenger_client.go` | **Adapt** | Add `SendNativeMessage()` and `PassThreadControl()` methods |
| `message-worker/tokenstore.go` | **Verify/adapt** | Ensure SQL matches existing database schema |
| `message-worker/Dockerfile` | **Verify** | Ensure it builds correctly after changes |
| `devops/vlab/Chart.yaml` | **Modify** | Add message-worker as subchart dependency |
| `devops/values/*.yaml` | **Modify** | Add message-worker env config for each environment |

---

## Kafka Message Formats

### Command (replybot → message-worker)

**Topic**: `commands`
**Key**: `user_id` (for partition ordering)

```json
{
  "command_id": "cmd_a1b2c3d4",
  "issued_at": 1711100000000,
  "conversation_id": "12345678",
  "user_id": "12345678",
  "platform": "messenger",
  "platform_account_id": "109876543210",
  "message": {
    "type": "native",
    "native_payload": {
      "recipient": { "id": "12345678" },
      "message": {
        "text": "What is your gender?",
        "quick_replies": [
          { "content_type": "text", "title": "Male", "payload": "{\"ref\":\"gender\",\"value\":\"male\"}" },
          { "content_type": "text", "title": "Female", "payload": "{\"ref\":\"gender\",\"value\":\"female\"}" }
        ],
        "metadata": "{\"type\":\"question\",\"ref\":\"gender\"}"
      }
    }
  }
}
```

### Handoff command (replybot → message-worker)

**Topic**: `commands`
**Key**: `user_id`

```json
{
  "command_id": "cmd_h1a2n3d4",
  "issued_at": 1711100000000,
  "conversation_id": "12345678",
  "user_id": "12345678",
  "platform": "messenger",
  "platform_account_id": "109876543210",
  "message": {
    "type": "pass_thread_control",
    "target_app_id": "263902037430900",
    "handoff_metadata": "{\"source\":\"replybot\",\"reason\":\"live_agent_request\"}"
  }
}
```

### Success event (message-worker → Kafka)

**Topic**: `chat-events`

```json
{
  "event_id": "evt_x1y2z3",
  "conversation_id": "12345678",
  "user_id": "12345678",
  "timestamp": 1711100001000,
  "platform": { "type": "messenger", "account_id": "109876543210" },
  "source": "message_worker",
  "type": "message_sent",
  "payload": {
    "type": "message_sent",
    "command_id": "cmd_a1b2c3d4",
    "conversation_id": "12345678",
    "user_id": "12345678",
    "platform_message_id": "m_abc123",
    "attempts": 1
  }
}
```

### Failure → synthetic event path (message-worker → botserver → Kafka)

When all retries fail, message-worker POSTs to `{BOTSERVER_URL}/synthetic`:
```json
{
  "userid": "12345678",
  "pageid": "109876543210",
  "type": "machine_report",
  "payload": {
    "tag": "FB",
    "message": "platform API error (status 403): User has blocked the bot",
    "details": { "code": "USER_BLOCKED", "attempts": 3, "retriable": false }
  }
}
```

Botserver forwards this as a synthetic event on Kafka. Replybot processes it and transitions to BLOCKED state.

---

## Verification Plan

### Unit tests

1. **Go message-worker tests**: `cd message-worker && go test -v ./...`
   - All 41 existing tests should still pass
   - New tests for native passthrough mode should pass

2. **Replybot tests**: `cd replybot && npm test`
   - Existing tests should pass (may need mock updates since `act()` behavior changed)
   - New tests for command publishing

### Integration tests (Kind cluster)

Follow the setup in `planning/INTEGRATION_TESTING_GUIDE.md`:

1. Build and deploy:
   ```bash
   # Build message-worker image
   cd message-worker
   docker build -t localhost:5000/vlabresearch/message-worker:dev .
   docker push localhost:5000/vlabresearch/message-worker:dev

   # Rebuild replybot with changes
   cd replybot
   docker build -t localhost:5000/vlabresearch/replybot:dev .
   docker push localhost:5000/vlabresearch/replybot:dev

   # Deploy via Helm
   helm upgrade fly devops/vlab/ --values devops/values/integrations/fly.yaml
   ```

2. Verify message flow:
   - Send a test referral event via botserver
   - Check `commands` topic for published command: `kubectl exec kafka-0 -- kafka-console-consumer --bootstrap-server localhost:9092 --topic commands --from-beginning --max-messages 1`
   - Check message-worker logs: `kubectl logs -l app=message-worker --tail=50`
   - Check facebot received message: `kubectl logs -l app=facebot --tail=50`

3. Run testrunner:
   ```bash
   cd facebot/testrunner && ./dev.sh
   ```
   All currently passing tests (bailout, logic jump, validation, stitched forms) should still pass.

### Error handling verification

1. Configure facebot to reject a message (return 403)
2. Verify message-worker retries 3 times then sends `machine_report`
3. Verify replybot receives the synthetic event and transitions to BLOCKED
4. Check state in CockroachDB: `kubectl exec db-cockroachdb-0 -- ./cockroach sql --insecure --database=chatroach -e "SELECT current_state FROM states WHERE userid = 'TEST_USER'"`

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Token schema mismatch | Medium | High | Read `tokenstore.js` and check DB schema BEFORE implementing. Adapt Go query to match. |
| Async error delay | Low | Low | Accepted tradeoff. Errors still reach BLOCKED state, just slightly delayed. |
| Kafka `commands` topic missing | Medium | High | Add to topic creation manifests. Verify with `kafka-topics --list`. |
| Burrow library won't compile on main | Low | Medium | It's a standalone Go module. `go build ./...` will catch issues immediately. |
| Replybot test breakage | Medium | Medium | Tests for deleted functions (`sendMessage`, `passThreadControl`) are removed. Tests for `getUserInfo` are kept. Mock updates needed for `act()` behavior change. |
| Message ordering | Low | Medium | Kafka partitioning by `user_id` ensures per-user ordering. Same key as replybot's existing publishing. |
| Handoff regression | Medium | High | Trace the exact call path for `passThreadControl` in replybot before deleting. Verify the handoff object shape (`target_app_id`, `metadata`) matches what the Go worker expects. Test with an actual handoff flow if possible. |

---

## Out of Scope (Phase 2+)

- Platform-agnostic command format (remove `translate-typeform` dependency from message path)
- WhatsApp/Instagram support in message-worker
- Extracting payment command publishing
- Extracting `getUserInfo` from replybot (requires sync request-reply pattern, not a good fit for Kafka)
- Removing `messenger/index.js` entirely from replybot (still needed for `getUserInfo`)
