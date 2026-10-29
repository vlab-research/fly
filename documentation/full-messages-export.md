# Full Messages Export

The Full Messages export produces a CSV of every classified message exchanged with users of a given survey, drawn from the `messages` table. It complements the `chat_log` export (see `chat-message-logging.md`): `chat_log` is the curated, deduplicated record of user-visible exchanges; `full_messages` is the raw stream — every echo, postback, referral, bail event, etc. — passed through the event classifier and optionally filtered.

## End-to-end Flow

```
Dashboard Client (Export tab → "Export Full Messages")
    |
    +-- POST /exports?survey=<name>  { export_type: "full_messages", event_groups: [...], include_raw_json, start_time?, end_time? }
    |
    v
Dashboard Server (generates UUID, INSERTs a "Requested" row into export_status)
    |
    v
Exporter polls export_status for Requested rows (migration 16, no Kafka)
    |
    v
Exporter (locks the row, queries `messages`, writes CSV, UPDATEs row by id)
    |
    v
Cloud storage (GCS/S3) -> presigned download URL written to export_status
```

## Form Inputs

The `CreateFullMessagesExport` container at `/exports/create-full-messages?survey_name=<name>` exposes:

- **Event types to include** — checkbox group over: conversation, referrals, bails, payments, external_tracking, retries, system, other. Groups are expanded into concrete event types by the exporter (`expand_groups`).
- **Start time (UTC, optional)** — lower bound on `messages.timestamp`, inclusive.
- **End time (UTC, optional)** — upper bound on `messages.timestamp`, exclusive.
- **Include raw JSON** — adds a column with the unparsed message payload.

The date/time pickers always operate in UTC to match how `messages.timestamp` is stored. Both bounds are independently optional: leave either blank to leave that side open. With both blank, the export covers all messages for every respondent (current default behavior).

## Time Window Semantics

- The window applies to `messages.timestamp` only, in the per-batch message query inside `export_full_messages` (`exporter/exporter/exporter.py`).
- **Inclusive start, exclusive end** (`timestamp >= start AND timestamp < end`) — this makes contiguous windows naturally non-overlapping.
- **User discovery is not bounded.** The exporter first finds distinct `userid`s from the `responses` table for the survey, then queries `messages` for those users within the window. A user who responded years ago is still eligible if they have messages inside the window.
- The output filename embeds the bounds (e.g. `{survey}_full_messages_20251001T000000Z_to_20251101T000000Z.csv`) so multiple windowed runs for the same survey don't clobber each other. Unbounded runs keep the original `{survey}_full_messages.csv` filename.

## Wire Format

The row's `options` column (`full_messages_options`) carries the times as ISO-8601 strings. Pydantic (`FullMessagesExportOptions` in `exporter/exporter/main.py`) parses them into `datetime | None`. The dashboard client converts moment values via `.utc().toISOString()` before posting; absent bounds are omitted from the body so they round-trip to `None`.

## Event Classification and Direction

`parse_event` (`exporter/exporter/exporter.py`) reads each raw row's JSON once and returns its type (one of those in `EVENT_GROUPS`), its `content` and its `event_detail` together. It dispatches on `source` to one parser per platform: `messenger`, `whatsapp` and `synthetic`. A row from any other source is `unknown`, and a shape a platform parser does not recognise is `unknown_<source>`. No group contains those types, so the export drops them; they count towards the `filtered` total in the job's log line. `get_direction` then labels each type `bot`, `user` or `system`.

### The bot's side

**`echo` is the only type that yields `bot`.** So whether the bot's side of a conversation appears at all depends entirely on what is classified as an echo. Two shapes are:

| Shape | Where the text lives | Notes |
|---|---|---|
| `type: "bot_echo"` | flat `text` | message-worker's send echo, published after each successful WhatsApp send. It is matched **before** the source dispatch: `source` names the platform, but the envelope is ours. |
| `source: "messenger"` + `message.is_echo` | nested `message.text` | Facebook's webhook. |

The echo's `text` is the message as the participant saw it: the text, a question's text without its options, or a media caption. Uncaptioned media exports as a `bot` row with empty content, as Facebook's `is_echo` does. The exporter does not invent a placeholder for content the bot did not write. **WhatsApp echoes published before message-worker added `text` (VIR-114) also export with empty content.** The text of those messages exists only in the `machine_report` rows' `send_message` commands, and the export does not read it from there.

WhatsApp status webhooks are not a substitute. They carry the message id, not its content or our metadata.

### WhatsApp rows

Hermes publishes each Cloud API `messages[]` or `statuses[]` item as its own row. `_parse_whatsapp` reads them in the same order, and with the same readings, as replybot's `categorizeWhatsAppEvent`, so the export agrees with what the state machine took each row to be:

| WhatsApp row | `event_type` | `content` |
|---|---|---|
| has `referral` (Click-to-WhatsApp) | `referral` | `referral.ref`, or else the ad's autofill text, which carries the form token when Meta sends no `ref` |
| `status: failed` | `send_failed` (group `system`) | `<code>: <title>` of the first error. This is Meta's asynchronous send rejection, not a receipt. |
| `status`: `sent`, `delivered` or `read` | `watermark` | the status |
| `type: text` | `text` | `text.body`. A bare `form.<code>` entry token stays `text`: it is what the participant typed. |
| `type: interactive` (`button_reply`, `list_reply`) | `quick_reply` | the reply's `title`, the label the machine validates answers against |
| `type: button` (template quick reply) | `quick_reply` | `button.text` |
| `image`, `video`, `audio`, `voice`, `document`, `sticker` | `media` | the media type (`voice` is reported as `audio`) |
| `type: reaction` | `reaction` | the emoji |
| anything else (e.g. `location`) | `unknown_whatsapp` | dropped |

## Key File References

| Component | File |
|-----------|------|
| Form UI | `dashboard-client/src/containers/CreateFullMessagesExport/CreateFullMessagesExport.js` |
| API call | `dashboard-client/src/services/api/startExport.js` |
| Server route | `dashboard-server/api/exports/exports.controller.js` |
| Exporter Pydantic model | `exporter/exporter/main.py` (`FullMessagesExportOptions`) |
| Exporter query + CSV writer | `exporter/exporter/exporter.py` (`export_full_messages`) |
