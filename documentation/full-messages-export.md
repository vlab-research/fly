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

`classify_event` maps each raw row's JSON to one of the types in `EVENT_GROUPS`; `get_direction` then labels it `bot`, `user`, or `system`. **`echo` is the only type that yields `bot`** — so whether the bot's side of a conversation appears in the export at all depends entirely on what classifies as an echo.

Two shapes do:

| Shape | Where the text lives | Notes |
|---|---|---|
| `type: "bot_echo"` | flat `text` | message-worker's send echo, published after every successful send on every platform. Matched **before** the per-source branch, because `source` names the platform but the envelope is ours — a messenger-sourced `bot_echo` would otherwise fall through to `unknown_messenger`. |
| `source: "messenger"` + `message.is_echo` | nested `message.text` | Facebook's webhook. Historical rows keep this shape indefinitely, so both are read. |

**Previously, WhatsApp conversations exported with no bot side at all.** `classify_event` had branches for `messenger` and `synthetic` and none for `whatsapp`, so WhatsApp rows fell through to `unknown`; and the synthetic echo carried no message text to export even if they hadn't. The synthetic-echo migration fixed both halves — the echo now carries rendered text, and it is classified on every platform. See `planning/synthetic-echo-migration.md`.

Note that an uncaptioned media echo exports as a `bot` row with empty content, the same as Facebook's `is_echo` did — the exporter does not invent a placeholder for content the bot did not write.

## Key File References

| Component | File |
|-----------|------|
| Form UI | `dashboard-client/src/containers/CreateFullMessagesExport/CreateFullMessagesExport.js` |
| API call | `dashboard-client/src/services/api/startExport.js` |
| Server route | `dashboard-server/api/exports/exports.controller.js` |
| Exporter Pydantic model | `exporter/exporter/main.py` (`FullMessagesExportOptions`) |
| Exporter query + CSV writer | `exporter/exporter/exporter.py` (`export_full_messages`) |
