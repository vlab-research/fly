# Scribble Chat Log Sink Implementation Status

## Executive Summary

The chat log sink has **NOT been implemented** in the scribble service. The planning document exists and is comprehensive, but no code has been written. This report details what's missing and what needs to be implemented.

## Current Status

### What Exists
1. **Planning document**: `/home/nandan/Documents/vlab-research/fly/planning/chat-log-implementation-plan.md`
   - Complete design specification with architecture, schema, data flow, and implementation steps
   - Defines the scribble sink requirements clearly

2. **Documentation**: `/home/nandan/Documents/vlab-research/fly/documentation/chat-message-logging.md`
   - System-wide documentation of chat logging

3. **Pattern examples in scribble**:
   - `/home/nandan/Documents/vlab-research/fly/scribble/message.go` — Message sink (44 lines)
   - `/home/nandan/Documents/vlab-research/fly/scribble/state.go` — State sink (79 lines)
   - `/home/nandan/Documents/vlab-research/fly/scribble/response.go` — Response sink with caching (181 lines)
   - `/home/nandan/Documents/vlab-research/fly/scribble/scribble.go` — Main router (107 lines)
   - `/home/nandu/Documents/vlab-research/fly/scribble/write.go` — Interface definitions and batch logic (92 lines)

### What's Missing

#### 1. Database Migration
- **File**: `/home/nandan/Documents/vlab-research/fly/devops/migrations/08-chat-log.sql`
- **Status**: MISSING
- **Required by plan**: Create table with schema:
  ```
  userid (VARCHAR, NOT NULL)
  pageid (VARCHAR)
  timestamp (TIMESTAMPTZ, NOT NULL)
  direction (VARCHAR, NOT NULL) — 'bot' or 'user'
  content (VARCHAR, NOT NULL)
  question_ref (VARCHAR)
  shortcode (VARCHAR)
  surveyid (UUID)
  message_type (VARCHAR)
  raw_payload (JSONB)
  metadata (JSONB)
  PRIMARY KEY (userid, timestamp, direction)
  ```

#### 2. Scribble Chat Log Sink
- **File**: `/home/nandan/Documents/vlab-research/fly/scribble/chatlog.go`
- **Status**: MISSING (not in `/home/nandan/Documents/vlab-research/fly/scribble/`)
- **What it needs**:
  - `ChatLogEntry` struct with fields matching database schema
  - `Marshal(*kafka.Message) (Writeable, error)` method — deserializes Kafka messages to ChatLogEntry
  - `SendBatch([]Writeable) error` method — batch INSERT to chat_log table
  - Should follow pattern of `message.go` (simple) or `response.go` (complex)

#### 3. Scribble Router Registration
- **File**: `/home/nandan/Documents/vlab-research/fly/scribble/scribble.go`
- **Current state**: Lines 64-68 define marshaller map:
  ```go
  marshallers := map[string]func(*pgxpool.Pool) Scribbler{
      "states":    NewStateScribbler,
      "responses": NewResponseScribbler,
      "messages":  NewMessageScribbler,
  }
  ```
- **Missing**: No `"chat_log": NewChatLogScribbler` entry — needs to be added

#### 4. Replybot Chat Log Publisher
- **File**: `/home/nandan/Documents/vlab-research/fly/replybot/lib/chat-log/publisher.js`
- **Status**: MISSING (directory doesn't exist)
- **What it needs**:
  - Pure extraction function `extractChatLogEntry(event, state)` — determines if event should be logged
  - IO wrapper `publishChatLog(producer, topic, event, state)` — publishes to Kafka
  - Integration point in `/home/nandu/Documents/vlab-research/fly/replybot/lib/index.js` processor() function

#### 5. Kafka Topic Configuration
- **Files**:
  - `/home/nandu/Documents/vlab-research/fly/devops/values/production.yaml`
  - `/home/nandu/Documents/vlab-research/fly/devops/values/staging.yaml`
- **Status**: Topic name and configuration NOT defined in Helm values
- **Required**:
  - Topic name: `vlab-{env}-chat-log` (e.g., `vlab-prod-chat-log`)
  - Partitions: 12
  - Replication factor: 3 (prod), 1 (staging)
  - Retention: 31 days (2678400000 ms)
  - Message key: userid

#### 6. Helm Configuration for Scribble Sink
- **File**: Deployment configuration in Helm values
- **Status**: MISSING
- **Required**: New scribble deployment with:
  ```yaml
  - destination: "chat_log"
    replicaCount: 1
    env:
    - name: KAFKA_TOPIC
      value: "vlab-prod-chat-log"
    - name: KAFKA_GROUP
      value: "scribble-chat-log"
    - name: SCRIBBLE_CHUNK_SIZE
      value: "32"
    - name: SCRIBBLE_BATCH_SIZE
      value: "128"
    - name: SCRIBBLE_STRICT_MODE
      value: "false"
  ```

#### 7. Replybot Environment Configuration
- **File**: Helm values for replybot
- **Status**: MISSING
- **Required**: New env var in replybot config:
  ```yaml
  - name: VLAB_CHAT_LOG_TOPIC
    value: "vlab-prod-chat-log"
  ```

#### 8. Monitoring/Alerts
- **File**: Prometheus alert configuration in devops
- **Status**: MISSING
- **Required**: Consumer group lag alert for `scribble-chat-log`

## Implementation Requirements Summary

| Component | Type | File | Status | Complexity |
|-----------|------|------|--------|------------|
| Database migration | SQL | `devops/migrations/08-chat-log.sql` | Missing | Low |
| Chat log scribbler | Go | `scribble/chatlog.go` | Missing | Medium |
| Scribble router | Go modify | `scribble/scribble.go` | Missing | Low |
| Chat log publisher | JavaScript | `replybot/lib/chat-log/publisher.js` | Missing | High |
| Replybot integration | JavaScript modify | `replybot/lib/index.js` | Missing | Medium |
| Kafka topic config | YAML | `devops/values/{prod,staging}.yaml` | Missing | Low |
| Helm scribble sink | YAML | `devops/values/{prod,staging}.yaml` | Missing | Low |
| Replybot env config | YAML | `devops/values/{prod,staging}.yaml` | Missing | Low |
| Monitoring alert | YAML | devops alerts | Missing | Low |

## Key Design Points (from plan)

1. **Separate table, not extending responses**: Prevents regression risk to existing consumers (dashboard, exporter, Cube.js, exodus)

2. **Self-contained**: Both bot AND user messages in one table — `SELECT * FROM chat_log WHERE userid = X ORDER BY timestamp` gives full conversation

3. **Echo-based capture**: Bot messages captured when Facebook echoes them back (`message.is_echo = true`), not when sent

4. **Raw data philosophy**: Stores message text, full Facebook payload, and state metadata — no derived values

5. **Functional core**:
   - Extraction logic is pure function (testable, no side effects)
   - IO at the edges (thin Kafka producer wrapper)
   - Composition over mutation

6. **Message filtering**:
   - **Included**: Bot questions/statements/errors, user text/quick_reply/postback
   - **Excluded**: Synthetic events, read/delivery receipts, referrals, reactions, handover protocol

## File Paths Reference

Key files to understand the pattern:

| File | Purpose |
|------|---------|
| `/home/nanda/Documents/vlab-research/fly/scribble/message.go` | Simple sink pattern to follow |
| `/home/nanda/Documents/vlab-research/fly/scribble/response.go` | Complex sink pattern (with caching) |
| `/home/nanda/Documents/vlab-research/fly/scribble/write.go` | Writeable interface, batch logic |
| `/home/nanda/Documents/vlab-research/fly/scribble/scribble.go` | Main router, marshaller registration |
| `/home/nanda/Documents/vlab-research/fly/scribble/test_helpers.go` | Test database setup patterns |
| `/home/nanda/Documents/vlab-research/fly/replybot/lib/index.js` | Processor function — integration point |
| `/home/nanda/Documents/vlab-research/fly/replybot/lib/typewheels/machine.js` | State machine, categorizeEvent() |
| `/home/nanda/Documents/vlab-research/fly/devops/values/production.yaml` | Kafka topics, Helm config |

## Next Steps

To implement:

1. **Create database migration** — simple SQL table creation
2. **Create scribble sink** — Go code following message.go pattern
3. **Update scribble router** — add "chat_log" to marshallers map
4. **Create replybot publisher** — JavaScript extraction + publishing logic
5. **Integrate into replybot** — call publisher from processor()
6. **Update Helm configuration** — add Kafka topic, scribble sink, env vars, alerts
7. **Write tests** — unit tests for extraction logic and scribble sink

## Notes

- No code has been written yet; this is purely a planning document
- All dependencies and patterns are clear from existing implementations
- The plan is well-specified and ready for implementation
- Implementation should follow functional programming principles already established in the codebase
