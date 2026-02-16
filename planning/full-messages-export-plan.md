# Full Messages Export

## Context

The `chatroach.messages` table (101M rows, ~123 GB) already stores **every event** that flows through replybot — both Facebook Messenger events and synthetic events (bails, moviehouse, linksniffer, payments, etc.). The existing `chat_log` table only captures visible conversation messages (echo, text, quick_reply, postback). Rather than expanding `chat_log`, we leverage `messages` directly to export the full event history for a survey, with user-selectable event type filters.

## Event Type Taxonomy

Based on live data from the messages table and `categorizeEvent()` in `replybot/lib/typewheels/machine.js`:

### Messenger Events (`source: 'messenger'`)

| Event Type | Description | Count in DB |
|-----------|-------------|-------------|
| `echo` | Bot message echoed back by Facebook | 27.8M |
| `quick_reply` | User tapped a quick reply button | 15.9M |
| `text` | User sent a text message | 3.9M |
| `referral` | User arrived via ad/link referral | 1.1M |
| `postback` | User tapped a structured button | 275K |
| `watermark` | Read/delivery receipts | ~1 |

### Synthetic Events (`source: 'synthetic'`)

| Event Type | Description | Count in DB |
|-----------|-------------|-------------|
| `machine_report` | State machine error/status reports | 43.6M |
| `redo` | Retry last question | 3.4M |
| `platform_response` | Facebook API response result | 2.3M |
| `payment` | Payment provider response (external) | 470K |
| `bailout` | Switch user to different form (from exodus) | 260K |
| `follow_up` | Resend response to a question | 213K |
| `moviehouse` | Video player events (play/pause/ended/etc.) | 182K |
| `linksniffer` | Link click tracking | 139K |
| `repeat_payment` | Retry payment for a question | 40K |
| `block_user` | Block user from continuing | 3.3K |
| `external_other` | Other external events (handoff_return, etc.) | 1.3K |
| `unblock` | Return user from blocked state | 584 |

### Grouped Categories (for frontend UI)

The frontend presents event types as grouped categories with a checkbox per group, all selected by default:

| Group | Label | Event Types Included | Default |
|-------|-------|---------------------|---------|
| **Conversation** | Messages | `echo`, `text`, `quick_reply`, `postback` | ON |
| **Referrals** | Referrals & Opt-ins | `referral`, `optin` | ON |
| **Bails** | Bail Events | `bailout` | ON |
| **Payments** | Payment Events | `payment`, `repeat_payment` | ON |
| **External Tracking** | Moviehouse & Linksniffer | `moviehouse`, `linksniffer`, `external_other` | ON |
| **Retries & Follow-ups** | Retries & Follow-ups | `redo`, `follow_up` | ON |
| **System** | System Events | `machine_report`, `platform_response`, `block_user`, `unblock` | ON |
| **Other** | Watermarks & Other | `watermark`, `reaction`, `media`, `handover`, `timeout` | ON |

The options model stores the group names, not individual event types. The exporter maps groups → event types server-side.

## Architecture

### Query Strategy

Join through `responses` to map survey → userids, then query `messages` by userid using the existing `(userid, timestamp ASC) STORING (content)` index:

```sql
SELECT m.userid, m.timestamp, m.content
FROM chatroach.messages m
INNER JOIN (
    SELECT DISTINCT userid
    FROM chatroach.responses
    WHERE shortcode IN (
        SELECT shortcode FROM chatroach.surveys
        WHERE survey_name = %s
        AND userid = (SELECT id FROM chatroach.users WHERE email = %s)
    )
) r ON m.userid = r.userid
ORDER BY m.userid, m.timestamp ASC
```

Event type filtering and JSON parsing happen in the Python exporter (application layer), not SQL — since `content` is VARCHAR not JSONB and there's no type column.

### CSV Output Columns

The exporter parses each message's JSON content and produces these columns:

| Column | Source |
|--------|--------|
| `userid` | from messages row |
| `timestamp` | from messages row |
| `source` | parsed: `messenger` or `synthetic` |
| `event_type` | classified from JSON structure (see classifier below) |
| `direction` | derived: `bot` (echo), `user` (text/qr/postback), `system` (synthetic) |
| `content` | extracted: message text where applicable, or event summary |
| `event_detail` | for external events: the subtype (e.g., `moviehouse:play`, `linksniffer:click`) |
| `raw_json` | optional: the full raw JSON string |

### Event Classifier (Python)

A pure function that mirrors `categorizeEvent()` logic, operating on parsed JSON dicts:

```python
def classify_event(msg: dict) -> str:
    source = msg.get("source")
    if source == "messenger":
        m = msg.get("message", {})
        if m.get("is_echo"): return "echo"
        if m.get("quick_reply"): return "quick_reply"
        if "text" in m: return "text"
        if m.get("attachments"): return "media"
        if msg.get("postback"): return "postback"
        if msg.get("referral"): return "referral"
        if msg.get("read") or msg.get("delivery"): return "watermark"
        if msg.get("reaction"): return "reaction"
        if msg.get("optin"): return "optin"
        if msg.get("pass_thread_control"): return "handover"
        return "unknown_messenger"
    elif source == "synthetic":
        etype = msg.get("event", {}).get("type", "")
        if etype == "external":
            subtype = msg.get("event", {}).get("value", {}).get("type", "")
            if subtype.startswith("moviehouse:"): return "moviehouse"
            if subtype.startswith("linksniffer:"): return "linksniffer"
            if subtype.startswith("payment:"): return "payment"
            return "external_other"
        if etype in ("bailout","redo","follow_up","repeat_payment","block_user",
                     "unblock","platform_response","machine_report","timeout"):
            return etype
        return "unknown_synthetic"
    return "unknown"
```

## File Changes

### 1. Exporter: storage backend (`exporter/exporter/storage.py`)

- Add `save_file(path)` method to `BaseStorageBackend`, `GoogleStorageBackend`, and `S3StorageBackend`
- Uploads from a local file path instead of requiring a DataFrame
- Enables streaming CSV writes without holding all data in memory

### 2. Exporter: Pydantic model + dispatch (`exporter/exporter/main.py`)

- Add `FullMessagesExportOptions` model:
  ```python
  class FullMessagesExportOptions(BaseModel):
      event_groups: list[str] = ["conversation", "referrals", "bails", "payments",
                                  "external_tracking", "retries", "system", "other"]
      include_raw_json: bool = False
  ```
- Add `full_messages_options: FullMessagesExportOptions = FullMessagesExportOptions()` field to `KafkaMessage`
- Add `elif data.source == "full_messages"` branch in `process()`

### 3. Exporter: streaming export + classifier (`exporter/exporter/exporter.py`)

- Add `EVENT_GROUPS` dict mapping group names → list of event type strings
- Add `classify_event(msg: dict) -> str` pure function (see classifier above)
- Add `expand_groups(groups: list[str]) -> set[str]` to map group names → individual event types
- Add `extract_content(msg: dict, event_type: str) -> str` to pull human-readable content from message JSON
- Add `extract_event_detail(msg: dict, event_type: str) -> str` for external event subtypes
- Add `get_direction(event_type: str) -> str` to derive direction from event type
- Add `_iter_messages(raw_rows, allowed_types, include_raw_json)` — generator that:
  - Parses each row's JSON content
  - Classifies event type via `classify_event()`
  - Filters: skips rows not in `allowed_types` (never materializes them)
  - Yields dicts with CSV columns: userid, timestamp, source, event_type, direction, content, event_detail, [raw_json]
- Add `export_full_messages(cnf, export_id, user, survey, options)`:
  - **Streaming approach**: Uses `csv.DictWriter` + `tempfile.NamedTemporaryFile` instead of pandas DataFrame
  - Queries `messages` table via generator (`db.query` already yields rows)
  - Pipes generator through `_iter_messages()` for classification + filtering
  - Writes matching rows directly to temp CSV file — memory usage is O(1) per row
  - Uploads temp file via `storage_backend.save_file(path)`
  - File path: `exports/{survey_name}_full_messages.csv`

**Why streaming instead of DataFrame**: The `messages` table is 101M rows / ~123 GB. Even for a single survey, the result set can be millions of rows (e.g., 43M `machine_report` rows alone). Loading all of that into a pandas DataFrame would OOM. With streaming, only one row is in memory at a time, and rows filtered out by event group never accumulate at all.

### 3. Dashboard server controller (`dashboard-server/api/exports/exports.controller.js`)

- Extend the source mapping to handle three types: `responses`, `chat_log`, `full_messages`
- Pass `full_messages_options` in Kafka message when source is `full_messages`

### 4. Dashboard client: new form (`dashboard-client/src/containers/CreateFullMessagesExport/CreateFullMessagesExport.js`)

- New component following `CreateChatLogExport` pattern
- `Checkbox.Group` with 8 grouped categories, all checked by default
- Each checkbox label shows group name + brief description
- Toggle for "Include raw JSON" (default OFF)
- Calls `startExport(survey, { event_groups, include_raw_json }, 'full_messages')`

### 5. Dashboard client: export tab + routing

- **`SurveyScreen.js`**: Add "Export Full Messages" button alongside existing export buttons
- **Router**: Add route for `/exports/create-full-messages` → `CreateFullMessagesExport`
- **Export table source column**: Add `full_messages` → `'Full Messages'` to the render mapping

## Verification

1. **Unit test the classifier**: Test `classify_event()` with sample JSON for each event type
2. **Test the query**: Run the join query via MCP against a known survey to verify it returns messages
3. **Test the export flow end-to-end**: Create an export via the dashboard, verify CSV output has correct columns and event type filtering works
4. **Test with large survey**: Verify performance with a survey that has many users (e.g., `langchoice` with 70K users)
