# Chat Log Implementation Plan

## Goal

Build a `chat_log` table that records every message exchanged between the chatbot and users -- both what the bot sent and what the user said. This provides:

1. **Debugging**: See the full conversation as the user experienced it
2. **Transparency**: Users/researchers can see exactly what the chatbot sent
3. **Future migration path**: The chat_log can eventually replace the `responses` table, which only stores structured survey answers

## Design Decisions

### Separate table (not extending `responses`)

The `responses` table is the primary data product, consumed by: dashboard JSON/CSV APIs, async exporter with `vlab_prepro` preprocessing (pivot, keep_final_answer, etc.), Cube.js analytics cubes, and the exodus bail system. All of these assume "one row = one user answer." Adding bot messages to this table would require every consumer to add direction filters, creating regression risk. A separate table means zero impact on existing functionality.

### Self-contained (both bot AND user messages)

The chat_log stores both sides of the conversation. This means a single `SELECT * FROM chat_log WHERE userid = X ORDER BY timestamp` gives the full conversation -- no joins needed. There is intentional duplication with the `responses` table for user messages, because the tables serve different purposes: `responses` = structured survey data product, `chat_log` = conversation replay.

### Echo-based capture for bot messages

Bot messages are captured when Facebook echoes them back (events with `message.is_echo = true`), NOT at the point of sending. This means the chat_log records what was actually delivered, not what we intended to send. If Facebook fails to deliver a message (no echo), it won't appear in the chat log -- which is correct behavior.

### Raw data philosophy

The table stores raw facts: the message text, the full Facebook API payload, and the state metadata at time of message. Derived values (translated_response, question_text, question_idx, seed, flowid, parent_shortcode, etc.) that the `responses` table stores are deliberately NOT included -- they can be computed from the raw data + survey definitions. This keeps the schema clean and the data honest.

## Schema

```sql
CREATE TABLE IF NOT EXISTS chatroach.chat_log (
    userid        VARCHAR NOT NULL,      -- chat respondent (Facebook PSID)
    pageid        VARCHAR,               -- Facebook page ID
    timestamp     TIMESTAMPTZ NOT NULL,  -- when sent/received
    direction     VARCHAR NOT NULL,      -- 'bot' or 'user'
    content       VARCHAR NOT NULL,      -- human-readable message text
    question_ref  VARCHAR,               -- which question this relates to (nullable for system messages)
    shortcode     VARCHAR,               -- which survey form
    surveyid      UUID,                  -- survey version
    message_type  VARCHAR,               -- free text, best-effort from source data
    raw_payload   JSONB,                 -- full Facebook API payload for debugging
    metadata      JSONB,                 -- state metadata snapshot at time of message
    PRIMARY KEY (userid, timestamp, direction)
);
```

### Message Types

`message_type` is free-text (VARCHAR, no constraint). The value is populated best-effort from the source data — for bot messages, from the echo metadata's `type` field; for user messages, from the event category (e.g., the output of `categorizeEvent()`). No predefined taxonomy is enforced.

### Column Details

**`content`**: The human-readable message text. For bot messages, this is the text sent to the user (extracted from the echo). For user messages, this is the text/payload the user sent.

**`question_ref`**: The Typeform question reference ID. For bot messages, extracted from `message.metadata.ref` in the echo. For user messages, extracted from the current state (the question being answered). Nullable -- some messages may not relate to a specific question.

**`shortcode`** and **`surveyid`**: The current survey form context, extracted from the user's state at the time of the message.

**`raw_payload`**: The complete Facebook event JSON. For bot messages, this is the full echo event (includes quick_reply options shown, button configs, attachments, metadata flags like stitch/wait/payment/handoff). For user messages, this is the full incoming event. Invaluable for deep debugging.

**`metadata`**: The state machine metadata snapshot (`state.md`) at the time of the message. Contains clusterid, seed, startTime, form context, and other state metadata. This captures the survey state at the exact moment the message was exchanged.

### Indexes

```sql
-- For querying conversations by user
INDEX (userid, timestamp ASC) STORING (content, direction, question_ref),

-- For querying by survey
INDEX (shortcode, userid, timestamp ASC),

-- For JSONB queries on metadata
INVERTED INDEX (metadata)
```

### Permissions

```sql
GRANT INSERT, SELECT ON chatroach.chat_log TO chatroach;
GRANT SELECT ON chatroach.chat_log TO chatreader;
```

## What Goes In the Chat Log

**Included** -- every message the user sees or sends:
- Bot questions (all field types)
- Bot statements (informational, auto-advance)
- Bot validation errors ("Sorry, that's not valid...")
- Bot follow-up reminders
- Bot thank-you / off-survey messages
- User text messages
- User quick replies
- User postback button taps

**Excluded** -- system internals the user doesn't see:
- Synthetic events (timeouts, redos, bailouts, block/unblock)
- Read/delivery receipts (watermarks)
- Referral events
- Reaction events
- Handover protocol events
- Any event that doesn't represent a visible message in the conversation

## Architecture

### Design Principles

All business logic follows functional programming principles:

- **Pure functions for all extraction/transformation logic**: `extractChatLogEntry(event, state)` is a pure function — given an event and state, it returns a chat log entry or null. No side effects, no IO, no Kafka producer references. This makes it trivially testable with plain unit tests.
- **IO at the edges only**: Kafka publishing is a thin wrapper that calls the pure extraction function, then passes the result to the producer. The extraction logic never touches Kafka, the database, or any external system.
- **Composition over mutation**: Chat log entries are constructed as new objects, not by mutating event or state. The extraction function returns a fresh data structure.
- **Testability by design**: Because extraction is pure, tests are just `assertEqual(extractChatLogEntry(mockEvent, mockState), expectedEntry)` — no mocks for Kafka, no test databases, no setup/teardown.

### Data Flow

```
EXISTING (unchanged):
  Facebook webhook -> botserver -> Kafka chat-events -> replybot (processes events)
  Replybot -> Kafka state/response/payment topics -> scribble -> DB tables

NEW:
  Replybot (on ECHO event)     -> extract bot message -> publish to Kafka chat-log topic
  Replybot (on user msg event) -> extract user message -> publish to Kafka chat-log topic
  New scribble chat-log sink   -> consume from chat-log topic -> INSERT into chat_log table
```

### Capture Points in Replybot

The capture happens in replybot's `processor()` function (`replybot/lib/index.js`), which already processes every event through the state machine. After the normal state machine processing:

**For ECHO events** (bot messages):
The state machine's `categorizeEvent()` in `machine.js` classifies echoes as `ECHO` events. After normal ECHO handling (which transitions state from RESPONDING to QOUT), we extract:
- `content`: from `event.message.text`
- `question_ref`: from `JSON.parse(event.message.metadata).ref`
- `message_type`: from `JSON.parse(event.message.metadata).type` (mapped to our types)
- `raw_payload`: the full event object
- `metadata`: from `state.md` (the state metadata)
- `shortcode`: from `state.forms[state.forms.length - 1]`
- `surveyid`: from state context
- `pageid`: from `event.sender.id` (for echoes, sender is the page)
- `userid`: from `event.recipient.id` (for echoes, recipient is the user)
- `direction`: `'bot'`
- `timestamp`: from the event timestamp

**For user message events** (TEXT, QUICK_REPLY, POSTBACK):
After normal state machine processing, we extract:
- `content`: from `event.message.text` or `event.postback.title`
- `question_ref`: from the current state's question field
- `message_type`: `'text'`, `'quick_reply'`, or `'postback'` based on event type
- `raw_payload`: the full event object
- `metadata`: from `state.md`
- `shortcode`: from `state.forms[state.forms.length - 1]`
- `surveyid`: from state context
- `pageid`: from state context
- `userid`: from `event.sender.id`
- `direction`: `'user'`
- `timestamp`: from the event timestamp

### New Kafka Topic

**Topic name**: `vlab-{env}-chat-log` (e.g., `vlab-prod-chat-log`, `vlab-staging-chat-log`)

Configuration (matching existing topic patterns):
- Partitions: 12
- Replication factor: 3 (production), 1 (staging)
- Retention: 31 days (`2678400000` ms)
- Message key: userid (for ordered processing per user)

### New Scribble Sink

A new scribble sink (similar to the existing messages, states, and responses sinks) that:
1. Consumes from the `chat-log` Kafka topic
2. Deserializes the chat log entry
3. Batch INSERTs into the `chat_log` table with `ON CONFLICT DO NOTHING`

Configuration in Helm values:
```yaml
- destination: "chat_log"
  replicaCount: 1
  env:
  - name: KAFKA_TOPIC
    value: *chatlogtopic
  - name: KAFKA_GROUP
    value: "scribble-chat-log"
  - name: SCRIBBLE_CHUNK_SIZE
    value: "32"
  - name: SCRIBBLE_BATCH_SIZE
    value: "128"
  - name: SCRIBBLE_STRICT_MODE
    value: "false"
```

### Dashboard API (future read path)

A new endpoint for conversation replay:
- `GET /api/v1/chat-log?survey=<survey_name>&userid=<userid>` -- returns ordered conversation
- Could also support: `GET /api/v1/chat-log/export?survey=<survey_name>` -- bulk export

This is not part of the initial implementation but should be considered in the design.

## Implementation Steps

### Step 1: Database Migration

Create file: `devops/migrations/08-chat-log.sql`

```sql
CREATE TABLE IF NOT EXISTS chatroach.chat_log (
    userid        VARCHAR NOT NULL,
    pageid        VARCHAR,
    timestamp     TIMESTAMPTZ NOT NULL,
    direction     VARCHAR NOT NULL,
    content       VARCHAR NOT NULL,
    question_ref  VARCHAR,
    shortcode     VARCHAR,
    surveyid      UUID,
    message_type  VARCHAR,
    raw_payload   JSONB,
    metadata      JSONB,
    PRIMARY KEY (userid, timestamp, direction),
    INDEX (userid, timestamp ASC) STORING (content, direction, question_ref),
    INDEX (shortcode, userid, timestamp ASC),
    INVERTED INDEX (metadata)
);

GRANT INSERT, SELECT ON chatroach.chat_log TO chatroach;
GRANT SELECT ON chatroach.chat_log TO chatreader;
```

### Step 2: Scribble -- New ChatLogScribbler

Add a new Go file: `scribble/chatlog.go`

This follows the same pattern as `scribble/message.go`, `scribble/response.go`, and `scribble/state.go`:

1. Define a `ChatLogEntry` struct matching the table columns
2. Implement `Marshal(msgs []*kafka.Message) ([]interface{}, error)` -- deserializes Kafka messages into ChatLogEntry structs
3. Implement `SendBatch(pool *pgxpool.Pool, entries []interface{}) error` -- batch INSERT with ON CONFLICT DO NOTHING

Add the new destination to the scribble main routing in `scribble/scribble.go` (similar to how `messages`, `states`, and `responses` are routed based on `SCRIBBLE_DESTINATION` env var).

### Step 3: Replybot -- Chat Log Publisher

Add a new module: `replybot/lib/chat-log/publisher.js`

This module has two clear layers:

**1. Pure extraction function** (no IO, trivially testable):
```javascript
// Pure function: (event, state) -> ChatLogEntry | null
// No Kafka, no database, no side effects
function extractChatLogEntry(event, state) {
    const category = categorizeEvent(event) // reuse existing categorization

    if (category === 'ECHO') {
        const meta = JSON.parse(event.message.metadata || '{}')
        return {
            userid: event.recipient.id,
            pageid: event.sender.id,
            timestamp: new Date(event.timestamp),
            direction: 'bot',
            content: event.message.text || '',
            question_ref: meta.ref || null,
            shortcode: state.forms ? state.forms[state.forms.length - 1] : null,
            surveyid: /* from state context */,
            message_type: meta.type || null,
            raw_payload: event,
            metadata: state.md || null,
        }
    }

    if (['TEXT', 'QUICK_REPLY', 'POSTBACK'].includes(category)) {
        return {
            userid: event.sender.id,
            pageid: /* from state or event */,
            timestamp: new Date(event.timestamp),
            direction: 'user',
            content: event.message?.text || event.postback?.title || '',
            question_ref: state.question || null,
            shortcode: state.forms ? state.forms[state.forms.length - 1] : null,
            surveyid: /* from state context */,
            message_type: category.toLowerCase(),
            raw_payload: event,
            metadata: state.md || null,
        }
    }

    return null // not a chat message, skip
}
```

**2. IO boundary** (thin wrapper that publishes):
```javascript
// IO wrapper: calls pure extraction, then publishes result
function publishChatLog(producer, topic, event, state) {
    const entry = extractChatLogEntry(event, state)
    if (!entry) return // skip non-chat events

    const message = {
        key: entry.userid,
        value: JSON.stringify(entry),
    }

    producer.produce(topic, message)
}
```

**Integration into `replybot/lib/index.js` `processor()` function:**
- After `machine.run()` completes and produces its report
- Call `publishChatLog(producer, topic, event, state)` to extract and publish
- The extraction logic determines which events to log (ECHO, TEXT, QUICK_REPLY, POSTBACK -- not synthetic events, watermarks, etc.)

### Step 4: Kafka Topic Configuration

Add the new topic to Helm values files:

In `devops/values/production.yaml`:
```yaml
chatLogTopic: &chatlogtopic "vlab-prod-chat-log"
```

Add to `kafkaTopics` list:
```yaml
- name: *chatlogtopic
  partitions: 12
  replicationFactor: 3
  config:
    "retention.ms": "2678400000" # 31 days
```

Similarly for staging values.

### Step 5: Helm Configuration for Scribble Sink

Add the new sink to the scribble configuration in the Helm values (alongside existing states, responses, messages sinks):

```yaml
- destination: "chat_log"
  replicaCount: 1
  env:
  - name: KAFKA_TOPIC
    value: *chatlogtopic
  - name: KAFKA_GROUP
    value: "scribble-chat-log"
  - name: SCRIBBLE_CHUNK_SIZE
    value: "32"
  - name: SCRIBBLE_BATCH_SIZE
    value: "128"
  - name: SCRIBBLE_STRICT_MODE
    value: "false"
```

### Step 6: Replybot Configuration

Add new env vars to replybot Helm config:
```yaml
- name: VLAB_CHAT_LOG_TOPIC
  value: *chatlogtopic
```

### Step 7: Monitoring

Add a lagging alert for the new consumer group:
```yaml
- consumergroup: scribble-chat-log
  alertname: LaggingConsumerScribbleChatLog
  window: "5m"
  limit: "200"
```

## File Changes Summary

| File | Change |
|------|--------|
| `devops/migrations/08-chat-log.sql` | NEW -- table creation migration |
| `scribble/chatlog.go` | NEW -- ChatLogScribbler (Marshal + SendBatch) |
| `scribble/scribble.go` | MODIFY -- add "chat_log" destination routing |
| `replybot/lib/chat-log/publisher.js` | NEW -- chat log extraction and Kafka publishing |
| `replybot/lib/index.js` | MODIFY -- integrate chat log publishing into processor() |
| `devops/values/production.yaml` | MODIFY -- add chat-log topic, scribble sink, replybot env var, alert |
| `devops/values/staging.yaml` | MODIFY -- same as production |

## Testing Strategy

1. **Unit tests for extraction logic**: Test `extractChatLogEntry()` with various event types (echo, text, quick_reply, postback, synthetic) to verify correct extraction and that excluded events return null.

2. **Unit tests for scribble**: Test ChatLogScribbler Marshal and SendBatch against a test CockroachDB (following existing scribble test patterns in `scribble/scribble_test.go`).

3. **Integration test**: Use the existing facebot test infrastructure to run a full conversation flow and verify chat_log entries appear correctly in the database with correct direction, content, and metadata.

4. **Verify existing functionality untouched**: Run existing test suites to confirm responses, states, and messages pipelines are unaffected.

## Future Work (not in scope now)

- Dashboard API endpoint for conversation replay
- Chat log export alongside response exports
- Backfill historical data from messages table (extracting echoes and user messages)
- Eventually migrate response exports to read from chat_log
- Eventually deprecate the responses table

## Key File References

For implementation context, these are the critical files to understand:

| File | Why |
|------|-----|
| `replybot/lib/index.js` | Where processor() lives -- the integration point |
| `replybot/lib/typewheels/machine.js` | State machine -- categorizeEvent() and ECHO handling |
| `scribble/scribble.go` | Main routing -- how destinations are selected |
| `scribble/message.go` | Pattern to follow for ChatLogScribbler |
| `scribble/response.go` | Pattern to follow (with translation as comparison) |
| `devops/migrations/01-init.sql` | Existing schema for reference |
| `devops/values/production.yaml` | Kafka topics, scribble sinks, replybot env config |
| `botserver/server/handlers.js` | How events enter the system |
| `replybot/lib/messenger/index.js` | How messages are sent to Facebook |
| `documentation/chat-message-logging.md` | Full documentation of current system |
