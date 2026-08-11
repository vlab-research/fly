# Investigate: stop embedding full state in machine_report messages

## Background

Replybot OOMs are caused by the `messages` table growing quadratically for some users. The mechanism:

1. State machine appends to `state.externalEvents` on every Dean retry (`replybot/lib/typewheels/machine.js:121-160`).
2. Every state transition publishes a `machine_report` message that **embeds the full `newState`** (`replybot/lib/index.js:39-42`).
3. As `state.externalEvents` grows, every machine_report message also grows.
4. Replybot reload reads ALL messages for a user (`@vlab-research/chatbase-postgres/lib/index.js:21-37`) and `recursiveJSONParser` doubles memory peak.

For one stuck user (`8563270007096163`):
- 9,750 messages totalling 1.22 GB of content
- Largest individual message: 632 KB
- Pattern: each message is a `machine_report` containing a snapshot of state with an ever-growing `externalEvents` and `qa` array

Other Dean fixes will stop the array from growing, but the existing 1.22 GB on disk per user is the immediate OOM trigger and will recur for any future state-bloat bug. We want to make `machine_report` messages structurally bounded so this can never OOM again, regardless of what else grows.

## Current behavior

`replybot/lib/index.js:39-42`:

```js
function publishState(userid, pageid, updated, state) {
  const message = { userid, pageid, updated, current_state: state.state, state_json: state }
  return produce(process.env.VLAB_STATE_TOPIC, message, userid)
}
```

This is the `state` Kafka topic message. Need to also check `machine_report` shape (sent via `publishReport()` HTTP POST to botserver, `replybot/lib/index.js:20-31`) which embeds the full report including `newState`.

## Investigation goals

1. **Trace all consumers** of the state Kafka topic (env: `VLAB_STATE_TOPIC = "vlab-prod-state"`). At minimum: scribble (writes to `states` table). Look in:
   - `scribble/` (likely main consumer)
   - Any other service in the monorepo subscribing to that topic
   - Anything in `event-exporter/`
2. **For each consumer**: what fields of `state_json` does it actually read or persist? Does it need the full blob, or just specific fields (current_state, pointer, qa, etc.)?
3. **Same for `machine_report`** events going to `BOTSERVER_URL/synthetic`. Trace the botserver handler — what does it do with `value.newState`?
4. **`messages` table semantics**: replybot also stores incoming events in `messages` (via `chatbase.put`). Are `machine_report` messages stored there too? If so, by whom — does the bot publish to itself, or does it come back through Kafka? Check `botserver/server/handlers.js`.
5. **Check the `states` table writer**: `replybot/lib/responses/stateman.js:44` does `UPSERT INTO states(...)` — presumably with the full state_json. That's fine; it's one row per user. But verify it's the only writer; if scribble also writes from the Kafka topic, we have two writers.

## Possible fixes (don't implement, just propose)

- **A**: Stop embedding `newState` in messages entirely. Send only `{userid, current_state, updated}` and let consumers query the `states` table for full state if needed.
- **B**: Embed only a delta (what changed in this transition) instead of full state.
- **C**: Embed only specific top-level fields needed by consumers (whitelist), excluding `externalEvents`, `qa`, `forms`, etc.
- **D**: Keep current shape but compress (gzip) — same wire load, smaller storage. Probably not enough on its own.

Tradeoffs to evaluate:
- Replayability: if the state topic IS the source of truth for downstream replay, full state matters. If `states` table is the source of truth and topic is just notifications, full state is redundant.
- Race conditions: scribble may rely on the topic message being self-contained so it doesn't race against state-table writes.

## What to deliver

A markdown report at `planning/machine-report-state-embedding-findings.md` with:

1. List of every consumer of the state Kafka topic and the `machine_report` synthetic event, with file paths and line numbers.
2. For each consumer: which `state_json` fields it actually reads.
3. Recommendation among A/B/C/D (or another option) with justification.
4. Migration plan: how to cut over without breaking consumers (versioned schema? coordinated deploy?).
5. Estimated message-size reduction for the worst-case user (`8563270007096163`).

## Constraints

- Read-only investigation. Do NOT change any code.
- Use the postgres MCP only for schema/structure questions, not data scans.
- Read project documentation first (`documentation/`, relevant `<app>/README.md` files) and note gaps for a follow-up doc pass.
