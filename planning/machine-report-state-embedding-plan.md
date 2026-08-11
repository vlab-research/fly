# Plan: slim machine_report wire payload (Option E)

## Goal

Stop embedding `newState` (and other unbounded fields) in the `machine_report` event sent over Kafka. Replace with a bounded, scalar-only payload that preserves the only signals any consumer actually uses: `error`, action name, and from/to state names.

Outcome: per-message wire/storage size drops from up to 632 KB to ~hundreds of bytes. The 9,750-row stuck user goes from 1.22 GB on disk to ~2 MB. OOM on replybot reload eliminated for this class of bug regardless of what other state grows.

Scope is `machine_report` only. The `state` Kafka topic (`publishState`, `replybot/lib/index.js:39-42`) is out of scope — `state_json` there is a legitimate source of truth for scribble's `states` table.

## Background

See `planning/machine-report-state-embedding.md` for the original brief. Key facts:

- Producer: `replybot/lib/index.js:20-31`. Wraps the full `report` (which contains `newState`, `actions`, `responses`, `payment`, `handoff`) into `event.value` and POSTs to botserver `/synthetic`.
- The only in-process consumer is replybot itself (`replybot/lib/typewheels/machine.js:293-311`). It reads exactly one field: `value.error` (and only `error.tag` to distinguish FB vs INTERNAL).
- Test fixtures construct `synthetic({ type: 'machine_report', value: { error: {...} } })` with no `newState` (`replybot/lib/typewheels/machine.test.js:694,705,715,917,925,933,943` and `transition.test.js:302`) — confirms the consumer-side contract.
- All other publish-paths (`responses`, `state`, `payment`) are separate; this plan touches none of them.

## Pre-flight verification (BLOCKER — do before any code change)

Verify nothing outside replybot reads `value.newState` from `machine_report` events. If anything does, this plan needs revision.

1. **scribble messages sink** — already confirmed: `scribble/message.go:32-39` writes the raw kafka value to `messages.content` verbatim. No field-level read.
2. **All other consumers of the chat-events kafka topic** — grep for the topic name (likely `vlab-prod-events` or similar; check `devops/values/`) to find every consumer subscription.
3. **All readers of `messages.content`** — grep across `event-exporter/`, `dashboard-server/`, `dashboard-client/src/`, `dean/`, `exodus/`, `botserver/` for any SQL touching the `messages` table (also called `ln`). For each hit, check whether it parses `content` JSON and reads `newState` / `state_json`.
4. **event-exporter** — there are `ourworld_oct_nov_2025*.jsonl` artifacts in the repo. Confirm whatever produced them either doesn't include machine_report rows or doesn't depend on `newState`.
5. **botserver `/synthetic` handler** — `botserver/server/handlers.js`. Confirm it just attaches `source: 'synthetic'` + `timestamp` and forwards; no field-level read of `value.newState`.

If any consumer reads `value.newState`, stop and reassess (Option G — hard cap as backstop — or per-consumer migration).

## The change

### New wire shape

`event.value` for `machine_report` becomes:

```js
{
  user,                                  // string
  page,                                  // string
  timestamp,                             // number
  transition: {                          // present whenever a transition ran (most reports)
    from,                                // string, e.g. "QOUT" — previous state.state
    to,                                  // string, e.g. "RESPONDING" — newState.state
    action,                              // string, e.g. "RESPOND" — output.action
  },
  error,                                 // present when report.error is set; full payload, unchanged
}
```

Bounded by construction: `from`, `to`, `action` are enum-valued strings drawn from a small finite set (state names in `apply()`, action names in `exec()` switches). `error` keeps its current shape — see "Error path stays full" below.

### Where to make the change

Two files. Keep the internal `report` object shape untouched so `processor()` in `replybot/lib/index.js:55-90` and the rest of the in-process pipeline (`stateStore.updateState(userId, report.newState)`, etc.) still work. Only reshape what crosses the wire.

**1. `replybot/lib/typewheels/transition.js` — add `previousState` and `action` to every `publish: true` return site.**

The report doesn't currently carry `state.state` (the from-state) or `output.action`. Add them so `publishReport` can pick them up without re-deriving.

Touch points:
- `:85` (CORRUPTED_MESSAGE) — `previousState: state.state`, no action (no transition ran).
- `:106-115` (RESET) — `previousState: state.state`, `action: output.action` ('RESET').
- `:140-150` (success) — `previousState: state.state`, `action: output.action`.
- `:152-161` (MachineIOError) — `previousState: state.state`, `action: output.action`.
- `:162-170` (STATE_ACTIONS error) — `previousState: state.state`, `action: output.action`.

Note `state.state` must be captured before `apply()` overwrites it. The synchronous transition at `:89` returns `newState` separately, so `state` (the input) is still the pre-transition state at every catch site. Verify this when editing.

**2. `replybot/lib/index.js:20-31` — reshape `publishReport` payload.**

```js
async function publishReport(report) {
  const url = process.env.BOTSERVER_URL
  const value = {
    user: report.user,
    page: report.page,
    timestamp: report.timestamp,
    ...(report.newState && {
      transition: {
        from: report.previousState,
        to: report.newState.state,
        action: report.action,
      },
    }),
    ...(report.error && { error: report.error }),
  }
  const json = {
    user: report.user,
    page: report.page,
    event: { type: 'machine_report', value },
  }
  return r2.post(`${url}/synthetic`, { headers: {}, json }).response
}
```

That's the entire wire-shape change. `report.newState`, `report.actions`, `report.responses`, `report.payment`, `report.handoff` are dropped from the wire payload. They remain on the `report` object for in-process use (`processor()` reads them for `publishState`, `publishResponses`, `publishPayment`).

### Error path stays full (intentional)

Per discussion: when an error occurs the report is rare and the full debugging payload is the most useful thing on it. `error` is forwarded as-is, including:

- `error.event` on `CORRUPTED_MESSAGE` (the offending raw event).
- `e.details` on `MachineIOError` (API response bodies, etc.).
- `error.message` and `error.stack` everywhere.

Note: the `STATE_TRANSITION` error catch at `transition.js:118-126` returns `publish: false`, so it never crosses the wire — its embedded `state` and `event` are not a wire-size concern. Out of scope for this plan; flag as a separate observability gap (errors are silently dropped) for follow-up.

## Tests

### Update existing tests

Tests that assert on the wire-published report shape need to be updated. Search:

```sh
rg -n "publishReport|publish.*report" replybot/lib --type js
```

Tests that just construct synthetic machine_report fixtures (`{ value: { error: ... } }`) need no change — they already use the consumer-side shape and they don't go through `publishReport`.

### Add new tests

`replybot/lib/index.test.js` (create if absent) or wherever `publishReport` is unit-testable:

1. Successful transition report → wire payload contains `transition.{from,to,action}` and no `newState`, `actions`, `responses`, `payment`, `handoff`.
2. Error transition report → wire payload contains `error` (full) + `transition.{from,to,action}`.
3. CORRUPTED_MESSAGE report → wire payload contains `error`, no `transition`.
4. Wire payload size for a synthetic state with 10,000-element `externalEvents` is < 1 KB (regression guard).

The size-regression test is the load-bearing one. It's the only thing that catches a future contributor accidentally re-embedding state.

### Test bookkeeping

`replybot/CLAUDE.md` requires `nvm use 12` for any node/npm in this directory. Run from `replybot/` dir. Existing test command is in `package.json` — check `npm test` or equivalent.

## Rollout

Single-deploy, no consumer coordination required (because no consumer reads the dropped fields — verified in pre-flight).

1. Land code change + tests on a feature branch.
2. Deploy to staging. Pick a stuck-or-active test user, drive a few transitions through the bot, query the staging `messages` table to confirm row sizes are now small.
3. Verify replybot still self-transitions to ERROR / BLOCKED on simulated MachineIOErrors (the `error`-round-trip path must still work). This is the only behavior the slim payload must preserve.
4. Deploy to production. Monitor:
   - Replybot OOM rate (the original symptom — should drop to zero for this class of cause).
   - `messages` table row-size distribution (a quick `LENGTH(content)` percentile query).
   - Any sudden change in error-handling behavior (BLOCKED / ERROR self-transition rate).
5. Existing 1.22 GB of bloat for stuck user `8563270007096163` is still on disk after this change. Cleanup is a separate task — likely a one-shot `DELETE FROM messages WHERE userid = ... AND content LIKE '%machine_report%' AND LENGTH(content) > 100000`. Out of scope here; the plan only stops the bleed.

## Out of scope

- The Dean retry behavior that grows `state.externalEvents` unboundedly (separate quarantine plan: `planning/dean-spammers-external-events-quarantine.md`).
- Compacting the `state` topic / `states` table (Option D from the brief).
- Backfill / cleanup of existing oversized `messages` rows.
- The `STATE_TRANSITION` error path silently dropping (`publish: false`) errors with full state embedded in the error object — observability gap, file separately.
- Per-action publish-suppression (Option F) — explored and rejected because UPDATE_STATE transitions can produce real errors via `actionsResponses()` IO, and naive action-based filtering would silently swallow them.

## Estimated impact

| Metric | Before | After |
|---|---|---|
| Largest single message (worst case) | 632 KB | ~few hundred bytes (or `error` size on error rows) |
| Stuck-user message corpus (`8563270007096163`) | 1.22 GB | ~2 MB |
| Replybot reload memory peak (recursiveJSONParser doubles it) | unbounded | bounded |
| Per-row payload during normal operation | 100s of KB | ~200 bytes |

Numbers assume the externalEvents-bloat fix lands separately. Even without that fix, this change alone caps `messages` table growth — externalEvents only lives in the `states` row (one per user), not in every machine_report row.
