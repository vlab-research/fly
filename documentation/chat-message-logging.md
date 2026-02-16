# Chat Message Logging

## Overview

The chat log feature provides conversation replay for debugging and transparency. It has two parts:

1. **Chat log table + capture pipeline** -- a `chat_log` table that records every visible message between bot and user, captured via replybot publishing to a Kafka topic, consumed by a scribble sink.
2. **Chat log CSV export** -- export chat log data as CSV through the existing async export pipeline, with an append-only `export_status` table.

## Chat Log Table

### Schema

Defined in `devops/migrations/08-chat-log.sql`.

```sql
CREATE TABLE IF NOT EXISTS chatroach.chat_log (
    userid        VARCHAR NOT NULL,
    pageid        VARCHAR,
    timestamp     TIMESTAMPTZ NOT NULL,
    direction     VARCHAR NOT NULL,       -- 'bot' or 'user'
    content       VARCHAR NOT NULL,       -- message text
    question_ref  VARCHAR,                -- typeform question ref (nullable)
    shortcode     VARCHAR,                -- survey shortcode at time of message
    surveyid      UUID,
    message_type  VARCHAR,                -- 'echo', 'text', 'quick_reply', 'postback', or type from metadata
    raw_payload   JSONB,                  -- full Facebook event JSON
    metadata      JSONB,                  -- state machine metadata at time of message
    PRIMARY KEY (userid, timestamp, direction)
);
```

Indexes:
- `(userid, timestamp ASC) STORING (content, question_ref)` -- per-user conversation replay
- `(shortcode, userid, timestamp ASC)` -- per-survey filtering
- `INVERTED INDEX (metadata)` -- JSONB queries on metadata

### What gets captured

Only **visible conversation messages** -- not synthetic events, watermarks, referrals, or system events:

- **Bot messages** (`direction = 'bot'`): Captured from Facebook echo events (`is_echo = true`). The `question_ref` and `message_type` come from the echo's metadata. Content is the text of the message sent to the user.
- **User messages** (`direction = 'user'`): Captured from TEXT, QUICK_REPLY, and POSTBACK events. Content is the user's text or the postback title.

## Capture Pipeline

```
Replybot (after processing each event)
    |
    +-- extractChatLogEntry(event, state) -> ChatLogEntry | null  [pure function]
    |
    +-- publishChatLog(produce, topic, rawEvent, state)           [IO wrapper]
            |
            v
    Kafka topic: vlab-{env}-chat-log
            |
            v
    Scribble (chat_log sink)
            |
            v
    INSERT INTO chat_log ... ON CONFLICT(userid, timestamp, direction) DO NOTHING
```

**Replybot** (`replybot/lib/chat-log/publisher.js`):
- `extractChatLogEntry(event, state)` is a pure function that returns a `ChatLogEntry` object or `null` depending on the event category.
- `publishChatLog(produce, topic, rawEvent, state)` parses the raw event, calls the pure extractor, and publishes to Kafka if the result is non-null.
- Called from `replybot/lib/index.js` after the state machine processes each event, gated on the `VLAB_CHAT_LOG_TOPIC` env var being set.

**Scribble** (`scribble/chatlog.go`):
- `ChatLogScribbler` implements the `Scribbler` interface.
- Deserializes `ChatLogEntry` from Kafka JSON, writes batches to the `chat_log` table.
- Uses `INSERT ... ON CONFLICT(userid, timestamp, direction) DO NOTHING` for idempotency.
- Runs as a separate scribble deployment with its own consumer group (`scribble-chat-log`).

**Production config** (`devops/values/production.yaml`):
- Topic: `vlab-prod-chat-log`, 12 partitions, replication factor 3, 31-day retention.
- Replybot env: `VLAB_CHAT_LOG_TOPIC` points to the topic.
- Scribble deployment: `destination: "chat_log"`, consumer group `scribble-chat-log`.

## Chat Log CSV Export

### Export Pipeline

```
Dashboard Client (Export tab on survey page)
    |
    +-- POST /exports?survey=<name>  { export_type: "chat_log", include_metadata: false, include_raw_payload: false }
    |
    v
Dashboard Server (generates UUID, INSERTs "Started" row, publishes to Kafka)
    |
    v
Kafka topic: vlab-exports
    |
    v
Exporter (consumes message, queries chat_log, writes CSV, UPDATEs row by id)
    |
    v
Cloud storage (GCS/S3) -> presigned download URL written to export_status
```

### How it works

1. User navigates to a survey's **Export** tab and clicks "Export Chat Log".
2. A form page (`CreateChatLogExport`) presents two toggles: **include_metadata** (default OFF) and **include_raw_payload** (default OFF).
3. On submit, the dashboard client calls `POST /exports?survey=<name>` with `{ export_type: "chat_log", include_metadata: <bool>, include_raw_payload: <bool> }`.
4. The dashboard server (`exports.controller.js`):
   - Maps `export_type` from the request body to a `source` value (`'chat_log'` or `'responses'`).
   - Generates a UUID via `crypto.randomUUID()`.
   - INSERTs a "Started" row into `export_status` with that UUID, so the user sees it immediately.
   - Publishes a Kafka message to `vlab-exports` with `export_id`, `source`, and `chat_log_options`.
5. The exporter (`exporter/exporter/main.py`) consumes the message. The `KafkaMessage` model includes `export_id` (required) and `source` (defaults to `'responses'`).
6. When `source` is `'chat_log'`, the exporter calls `export_chat_log()` which:
   - Queries `chat_log` joined through `surveys` and `users` to filter by survey name and owner email.
   - Conditionally includes `metadata` and `raw_payload` columns based on `chat_log_options`.
   - Writes CSV to `exports/{survey_name}_chat_log.csv` on the storage backend.
   - UPDATEs the `export_status` row `WHERE id = <export_id>` with status "Finished" and the presigned download URL.
   - On failure, UPDATEs the row to status "Failed".

### Exported columns

Base columns (always included): `userid`, `pageid`, `timestamp`, `direction`, `content`, `question_ref`, `shortcode`, `surveyid`, `message_type`.

Optional columns (toggled by user):
- `metadata` -- state machine metadata JSONB, cast to string
- `raw_payload` -- full Facebook event JSONB, cast to string

### Storage paths

- Response exports: `exports/{survey_name}.csv`
- Chat log exports: `exports/{survey_name}_chat_log.csv`

## Export Status Redesign (Append-Only Log)

### Migration

Defined in `devops/migrations/09-export-log-redesign.sql`. Transforms `export_status` from a "one row per user per survey" upsert table into an append-only log.

Changes from the original `export_status` schema (`02-export-status.sql`):
1. **Added `id` column** (UUID, `DEFAULT gen_random_uuid()`) -- unique identifier per export attempt.
2. **Added `source` column** (`VARCHAR NOT NULL DEFAULT 'responses'`) -- `'responses'` or `'chat_log'`.
3. **Dropped the `UNIQUE` constraint** on `(survey_id, user_id)` -- multiple exports can now exist per user per survey.
4. **Added indexes**: unique index on `id`, index on `survey_id`, index on `user_id`.

### Effective schema after migration

```
export_status:
    id           UUID DEFAULT gen_random_uuid()   -- unique per export attempt
    updated      TIMESTAMPTZ DEFAULT now() ON UPDATE now()
    user_id      VARCHAR NOT NULL
    survey_id    VARCHAR NOT NULL
    status       VARCHAR NOT NULL                  -- 'Started', 'Finished', 'Failed'
    export_link  VARCHAR NOT NULL
    source       VARCHAR NOT NULL DEFAULT 'responses'  -- 'responses' or 'chat_log'
```

### Write pattern

The dashboard server and exporter coordinate via the UUID:

1. **Dashboard server INSERTs** the initial row with `status = 'Started'` and `export_link = 'Not Found'`.
2. **Exporter UPDATEs** the row `WHERE id = <export_id>` to set `status` and `export_link`.

There is no UPSERT. The exporter never INSERTs rows.

### Read pattern

The Export tab on each survey calls `GET /exports/status/survey?survey=<name>`, which returns all `export_status` rows for that user and survey, ordered by `updated DESC`. Each row has a `source` field displayed as "Responses" or "Chat Log".

## Dashboard UI

The Export tab on each survey page (`SurveyScreen.js`) shows:
- Two buttons: "Export Responses" and "Export Chat Log"
- An inline table of that survey's exports with columns: Source, Status, Time, Download

The "Export Chat Log" button navigates to `/exports/create-chat-log?survey_name=<name>`, which renders the `CreateChatLogExport` form with the two toggle switches.

## Kafka Topics

| Topic | Producer | Consumer | Purpose |
|-------|----------|----------|---------|
| `vlab-{env}-chat-log` | replybot | scribble (chat_log sink) | Chat log entries for DB storage |
| `vlab-exports` | dashboard-server | exporter | Export job requests (both responses and chat_log) |

## Key File References

| Component | File |
|-----------|------|
| Chat log table schema | `devops/migrations/08-chat-log.sql` |
| Export status redesign | `devops/migrations/09-export-log-redesign.sql` |
| Chat log extraction (pure) | `replybot/lib/chat-log/publisher.js` |
| Chat log publish call site | `replybot/lib/index.js` |
| Scribble chat_log sink | `scribble/chatlog.go` |
| Exporter Kafka model | `exporter/exporter/main.py` |
| Exporter chat_log query + export | `exporter/exporter/exporter.py` |
| Dashboard server export controller | `dashboard-server/api/exports/exports.controller.js` |
| Dashboard server export queries | `dashboard-server/queries/exports/exports.queries.js` |
| Dashboard client export tab | `dashboard-client/src/containers/SurveyScreen/SurveyScreen.js` |
| Dashboard client chat log form | `dashboard-client/src/containers/CreateChatLogExport/CreateChatLogExport.js` |
| Production Helm values | `devops/values/production.yaml` |
