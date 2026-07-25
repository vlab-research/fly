# Error Events — thin live state + an errors projection

> How survey/processing errors are recorded. Two tiers from one principle:
> **`messages` is the complete, immutable event log; everything else is a
> disposable projection of it.**
>
> **Related:** `documentation/dashboard-study-health.md` (researcher banner),
> `documentation/study-error-alerting.md` (platform alerts + taxonomy),
> `replybot/README.md` (state machine).

---

## 1. The principle (why two tiers)

The pipeline is already event-sourced: **`messages` is the durable log** —
it holds every event, including the `machine_report` events that carry
errors. `states`, `responses`, `chat_log` are projections of it.

Errors come from **two producers that converge on one event type**:

- `replybot/lib/typewheels/transition.js` — processing failures
  (`CORRUPTED_MESSAGE`, `STATE_TRANSITION`, `STATE_ACTIONS`/`FORM_NOT_FOUND`).
- `message-worker/worker.go` `reportError()` — delivery failures (`FB`).

Both emit a `machine_report` external event (`{ error: { tag, … } }`). That
event (a) lands in `messages` and (b) is consumed by `machine.js exec` to set
`states.error`. `machine.js` does **not** create errors — it routes them.

Historically the error survived only as sticky `states.error`, doing two
incompatible jobs. We split them:

| Tier | What | Shape | Source |
|---|---|---|---|
| **`states.error`** | current error on the live state (a *stock*) | thin: `tag`, `code`, `message`, `ts` | `machine.js exec` on entry |
| **`errors`** | every error occurrence (a *flow*) | rich + indexed | a **projection of `machine_report` events** |

## 2. `states.error` — the thin live fact  ✅ implemented (Piece A)

Set once, on the transition into ERROR/BLOCKED, in `machine.js` `exec`
(`thinError`). The existing `state.state === 'ERROR' | 'BLOCKED'` no-op guard
makes it write-once-per-episode; `RESPOND` clears it on recovery.

```js
state_json.error = { tag, code, message, ts }   // ts = epoch ms, occurrence time
```

- **`ts` is the occurrence timestamp**, from the triggering event
  (`nxt.timestamp`). Preserved across retry re-fails (a failed Dean retry
  blips through RESPONDING but keeps the original `ts`); a genuine RESPOND
  clears the error so a new episode gets a fresh `ts`. Immune to retry churn.
- **Heavy fields dropped here** — no stack, no pre-error `state` snapshot, no
  raw `event`. Those stay on the `machine_report` event → `messages` → the
  errors projection. `states` rows shrink; `transition.js` is untouched so the
  log stays rich.
- Computed columns `error_tag`/`fb_error_code` still read `tag`/`code`; a new
  `errored_at` (migration `23-states-errored-at.sql`) exposes `ts` as a
  timestamp so the current-error population can be aged by **onset**, not by
  `updated` (which Dean re-warms — the source of the alert flapping).

## 3. `errors` — the projection (Piece B, next)

An append-only read model, one row per error occurrence, built by a
**dedicated consumer of the `machine_report` stream** (CQRS: same event,
second projection, independent of the state machine). Captures both producers
for free. Pure projection → rebuildable by replay.

```
errors ( userid, account_id, platform, form, timestamp,
         tag, code, message,
         stack, state_json, event )   -- rich context; cold table, no truncation
  INDEX (form, timestamp), (userid, timestamp), (tag, timestamp)
```
(`account_id` = the messaging-account id, same value as `states.pageid` /
`credentials.key`; `platform` from `state_json.md.platform`.)

- **Flow, not episode:** every occurrence is a row, retry re-fails included —
  that's the rate/trend signal. Dedup on **event identity** (reuse the
  `messages` `hsh = fnv64a(content)` pattern) so replays are idempotent; never
  dedup on episode.
- **Backfill = replay** `messages` (durable past the topic's retention).
- **Rebuildable / disposable.** Wrong mapping? Drop and re-run.

## 4. Consumers — both audiences, one primitive (Piece C, later)

- **Researcher dashboard** (`dashboard-study-health.md`): error/blocked
  findings source recent-error *flow* from `errors`; `states` stock (aged by
  `errored_at`) gives "who's currently broken." Zero-threshold visibility.
- **Platform alerts** (`study-error-alerting.md`): sql_exporter points its
  error/blocked queries at `errors` (occurrences in window / `COUNT(DISTINCT
  userid)`), not the Dean-warmed `states` stock. De-flaps, gives an honest
  rate, and a monotonic counter unlocks real trend detection. Stuck/expired
  alerts stay stock-based (genuine current-state questions).

Stock (`states`, aged by `errored_at`) answers **"how many users are broken
now"** (population). Flow (`errors`) answers **"at what rate are errors
occurring"** (a gross rate a sampled stock provably can't reconstruct). Both
read from the same `machine_report` events.

## 5. What this is NOT

- Not a change to the source of truth (`messages` unchanged; both tiers are
  projections).
- Not a new producer (both error sources already emit `machine_report`).
- Not a replacement for the platform alerting path — it's the shared, honest
  primitive underneath both the alerts and the dashboard.
