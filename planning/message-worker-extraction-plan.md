# Plan: Extract Message Sending from Replybot into Go Message-Worker

## Context

Replybot is a monolithic Node.js service that consumes Kafka events, runs a state machine, generates messages, and sends them directly to the Facebook Graph API — all in one synchronous loop. We want to incrementally migrate toward a distributed architecture by extracting the message-sending responsibility into a separate Go service (message-worker).

**Why now**: Instead of a big-bang Rust rewrite (the `feat/rust-replybot-migration` branch), we're adopting an incremental strangler-fig approach. Message sending is the cleanest seam to cut first — it's a leaf operation with no downstream dependencies.

**Intended outcome**: Exact same functionality as before. Replybot still runs the state machine and generates messages, but instead of calling the Facebook API directly, it publishes message commands to Kafka. A new Go message-worker service consumes those commands and delivers them.

**Phase 1 (this PR)**: Replybot publishes Facebook-native message payloads → worker forwards to Facebook API (passthrough).
**Phase 2 (future PR)**: Replybot emits platform-agnostic commands → worker handles all platform translation.

**Scope**: Messenger only (the only platform currently in production).

---

## Architecture Change

```
BEFORE:
  Kafka events → Replybot → [state machine] → sendMessage() → Facebook API
                                             → publish metadata → Kafka (responses)

AFTER:
  Kafka events → Replybot → [state machine] → publish commands → Kafka (commands)
                                             → publish metadata → Kafka (responses)
                                                     ↓
                                             Message-Worker (Go)
                                                     ↓
                                             Facebook Graph API
                                                     ↓
                                             (on error) → machine_report → botserver → synthetic event → Kafka
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

### Step 2: Add native passthrough mode to Go message-worker

The worker currently expects platform-agnostic `SendMessageCommand` with `message.type: text|question|media` and calls `TranslateToMessenger()` to convert. For phase 1, we need it to accept pre-formatted Facebook-native payloads and skip translation.

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

Add a new field for native payloads:
```go
type MessageContent struct {
    Type         string            `json:"type"`           // "text", "question", "media", "native"
    // ... existing fields ...
    NativePayload json.RawMessage  `json:"native_payload,omitempty"` // Pre-formatted platform message
}
```

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

Add native bypass before translation:
```go
func (w *Worker) ProcessCommand(ctx context.Context, cmd SendMessageCommand) error {
    if cmd.Message.Type == "native" {
        // Phase 1: passthrough — skip translation, send pre-formatted payload
        messageID, err := w.client.SendNativeMessage(ctx, cmd.UserID, cmd.PlatformAccountID, cmd.Message.NativePayload)
        if err != nil {
            // ... error handling (same as existing) ...
        }
        w.emitSuccess(cmd, messageID)
        return nil
    }
    // ... existing translation path ...
}
```

**Changes to `message-worker/messenger_client.go`:**

Add a new method that sends pre-formatted payloads:
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
```

The `MessageSender` interface will need updating too:
```go
type MessageSender interface {
    SendMessage(ctx context.Context, userID, pageID string, msg interface{}) (string, error)
    SendNativeMessage(ctx context.Context, userID, pageID string, payload json.RawMessage) (string, error)
}
```

**Add tests for native mode** in a new file `worker_native_test.go`:
- Test that `type: "native"` bypasses translation
- Test that native payload is forwarded correctly to Facebook API
- Test error handling for native messages

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

The `run()` method returns a report object. Add the messages to it:
```javascript
return {
    newState,
    responses,
    payment: actions.payment,
    handoff: actions.handoff,
    commands: messages.map(msg => ({  // NEW: message commands for Kafka
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
}
```

**NOTE**: You'll need to add `uuid` dependency or use a simple ID generator. Check if replybot already has one (likely via `@vlab-research/utils` or `farmhash`).

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

#### 3c. Keep `replybot/lib/messenger/index.js` intact

Do NOT delete this file. It's still needed for:
- `passThreadControl(userId, targetAppId, metadata, pageToken)` — used for handoff
- `getUserInfo(id, pageToken)` — used for user profile lookup
- `sendMessage()` — keep the function, just stop calling it from the hot path

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
| `replybot/lib/typewheels/transition.js` | **Modify** | Remove direct sendMessage calls, return messages for Kafka publishing. Key methods: `act()` (lines 65-72), `run()` (lines 79-173) |
| `replybot/lib/index.js` | **Modify** | Add `publishCommands()` function, add `KAFKA_COMMANDS_TOPIC` env var. Processor function at lines 54-106 |
| `replybot/lib/typewheels/machine.js` | **Read only** | Understand message generation: `act()` at line 641, `respond()` at line 818, `_gatherResponses()` at line 743. Do NOT modify. |
| `replybot/lib/messenger/index.js` | **Keep as-is** | Still needed for `passThreadControl()`, `getUserInfo()`. `sendMessage()` stays but is no longer called from hot path |
| `replybot/lib/typewheels/tokenstore.js` | **Read** | Understand current token storage to verify compatibility with Go worker |
| `replybot/lib/errors.js` | **Read** | Understand `MachineIOError` — the error type that was thrown on send failure |
| `replybot/lib/producer.js` | **Read** | Understand existing Kafka producer setup to follow same pattern for commands |
| `message-worker/worker.go` | **Adapt** | Add native passthrough in `ProcessCommand()` |
| `message-worker/types/command.go` | **Adapt** | Add `NativePayload json.RawMessage` to `MessageContent` |
| `message-worker/messenger_client.go` | **Adapt** | Add `SendNativeMessage()` method |
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
| Replybot test breakage | Medium | Medium | Keep `sendMessage()` in codebase. Only change is where it's called. Mock updates should be minimal. |
| Message ordering | Low | Medium | Kafka partitioning by `user_id` ensures per-user ordering. Same key as replybot's existing publishing. |
| Handoff (passThreadControl) breaks | Low | High | `passThreadControl()` is NOT being extracted — it stays in replybot. Verify it's not called through the `act()` path. |

---

## Out of Scope (Phase 2+)

- Platform-agnostic command format (remove `translate-typeform` dependency from message path)
- WhatsApp/Instagram support in message-worker
- Extracting `passThreadControl` into the worker
- Extracting payment command publishing
- Removing `messenger/index.js` from replybot
