# Error Events — Handoff

Status snapshot for continuing the error-events work in a fresh session.
Read `documentation/error-events.md` (design) and `planning/error-events.md`
(plan) first — this doc is the "where we are + why + what's next" layer.

---

## TL;DR

We're making errors first-class in the pipeline so **both** the platform
alerts and the researcher dashboard read one honest primitive instead of a
Dean-warmed `states` stock. Two tiers:

1. **`states.error` → thin** (`{tag, code, message, ts}`), gaining an
   occurrence timestamp (`errored_at`). **✅ DONE — Piece A, committed.**
2. **`errors` table** = append-only projection of `machine_report` events
   (rich context, indexed) for rate/trend/debugging. **⏳ Piece B, next.**

Then consumers (Piece C) migrate onto it: dashboard error findings + the
sql_exporter/AlertManager error rules.

## Branches & worktrees

- **`feature/error-events`** (worktree `../fly-error-events`) — THIS work.
  Based on **`origin/feature/whatsapp-platform-keying`**, NOT main.
  - Why: local `main` is stale/divergent (behind `origin/main`, plus an
    unpushed stray commit); the WhatsApp line is the active line (`account_id`
    world, migrations 20–22, on staging, dashboard stacked on it). Migrations
    continue at **23+** there. Verified WA's replybot edits don't touch our
    `exec` error sites.
  - HEAD: `b3345b63` (Piece A). Replybot deps installed (`nvm use` → node 22).
- **`feature/dashboard-study-health`** (worktree `../fly-dashboard-health`) —
  the researcher banner (earlier work), already rebased onto the WA line,
  suite green (dashboard-server 328 passing). This is **Piece C's dashboard
  half**; it currently queries the `states` stock and will be repointed at
  `errors` once Piece B lands.
- Main worktree `.../fly` on `main` — leave alone; has unrelated uncommitted
  files. **Housekeeping the user may want:** local `main` needs to be
  reconciled with `origin/main` (fast-forward + deal with the stray
  `c571b497` "moviehouse staging doc" commit).

## What Piece A did (committed `b3345b63`)

- `replybot/lib/typewheels/machine.js`: added `thinError(err, priorError, ts)`
  → `{tag, code, message, ts}`, applied at the 3 `exec` entry sites
  (PLATFORM_RESPONSE ~267, MACHINE_REPORT BLOCKED ~280 / ERROR ~284) using
  `nxt.timestamp`.
  - `ts` = occurrence time, set once per episode, **preserved across retry
    re-fails** (a failed Dean retry blips through RESPONDING but keeps the
    original onset via `priorError.ts`), **cleared on RESPOND** recovery so a
    new episode gets a fresh ts.
  - Drops stack / pre-error `state` snapshot / raw `event` from the persisted
    state. `transition.js` is **intentionally untouched** so the log
    (`messages`) keeps the full context the errors projection will read.
- `devops/migrations/23-states-errored-at.sql`: `errored_at` computed column
  (`ceiling((state_json->'error'->>'ts')::INT8/1000)::INT8::TIMESTAMPTZ`,
  mirrors `form_start_time`). Cast chain validated on CRDB.
- Tests: 3 new in `machine.test.js`. Full replybot suite **378 passing**,
  lint clean. `message` preserved (2 Grafana panels + `error_tag`/
  `fb_error_code` computed cols still work; nothing reads the dropped fields —
  verified by grep).
- Remaining for A before it ships: replybot image bump/deploy; that's it.

## Piece B — the `errors` projection (NEXT, not started)

Design in `documentation/error-events.md` §3. Table shape:
`errors(userid, account_id, platform, form, timestamp, tag, code, message,
stack, state_json, event)` + indexes `(form,timestamp)`, `(userid,timestamp)`,
`(tag,timestamp)`. Migration **24**.

**The one thing to resolve first (B2):** trace a real `machine_report` event
as it lands in `messages` and confirm:
- what in `content` flags it as an *error* report (vs a non-error report),
- where `form` / `account_id` / `platform` come from (the report payload vs.
  the embedded pre-error `state`).
Do this against prod `messages` (see "Access" below) or the serialization
code path (`replybot/lib/index.js publishReport` builds
`{type:'machine_report', value: report}`; `message-worker/worker.go`
`reportError` builds `MachineReportValue`). **Design the table/consumer
against the actual payload, not a guess.**

**Consumer:** a dedicated consumer of the `machine_report` stream (CQRS —
second projection alongside the state machine). Decide **scribble sink vs.
standalone service** by how much filter/transform scribble's sink model
allows. Must be idempotent on **event identity** (reuse the `messages`
`hsh = fnv64a(content)` dedup pattern) so replays don't double-count. Flow =
one row per occurrence, retry re-fails included; **never** dedup on episode.
Backfill from `messages` (durable past topic retention). Rebuildable.

## Piece C — consumers (separate branches, after B)

- **Dashboard** (`feature/dashboard-study-health`): error/blocked findings →
  `errors` flow; `states` stock **aged by `errored_at`** (not `updated`) gives
  "who's broken now." Update `documentation/dashboard-study-health.md`.
- **Platform alerts** (`devops/alerts/templates/study-health.yaml`,
  `devops/sql-exporter/templates/configmap.yaml`): point the error/blocked
  exporter queries at `errors` (occurrences in window / `COUNT(DISTINCT
  userid)`) instead of the Dean-warmed `states` stock. Consider a monotonic
  `errors_total` counter for real trend (`increase()`/`predict_linear`). Relax
  the `for:` hysteresis once the metric is stable. **Stuck/expired alerts stay
  stock-based** (genuine current-state questions — not events). Update
  `documentation/study-error-alerting.md`.

## Design rationale (so it isn't relitigated)

- **Why a timestamp at all / why not `updated`:** `updated` is bumped by Dean
  on every retry/followup/timeout, so it can't distinguish "quiet" from
  "recovered" and re-warms old errors — the source of the AlertManager
  flapping the user sees. `errored_at` (onset, immune to retries) fixes the
  *stock's* aging without giving up its nice per-user counting.
- **Why `states.error.ts` AND an `errors` table (not just one):** two
  different questions. **Stock** (`states`, aged by `errored_at`) answers "how
  many *users* are broken right now" (population, per-user, bounded). **Flow**
  (`errors`) answers "at what *rate* are errors occurring / is it trending" —
  a gross rate that a sampled stock provably *cannot* reconstruct (net level
  changes hide gross arrivals; `dS/dt = arrivals − departures`, one equation
  two unknowns). Prometheus already gives the stock a time dimension, so the
  flow's irreducible value is the gross rate + debugging context.
- **Retry re-fails count as new error rows** in the flow (each is a real
  `machine_report`), but a retry that *succeeds* emits no error event → the
  original ages out. So the flow counts only genuine failures — the exact
  thing the `updated`-warmed stock got wrong.
- **Errors have two producers, one convergence:** `transition.js` (processing
  failures) + `message-worker/worker.go` `reportError` (FB/delivery). Both
  emit `machine_report`, which is what lands in `messages` and drives
  `states.error`. So the projection off `machine_report` captures both for
  free; there is no single "creation point" in one file.
- **Ratio alerts (`survey:error_ratio:1h`) are the worst offenders:** both
  numerator (error stock) AND denominator (`survey_active_users`) are
  Dean-warmed stocks — the denominator is not a clean activity flow. A real
  rate needs error-events / real-interaction-events (from `messages`/
  `responses`), both Dean-free.
- **Is the current setup "bad"?** No — it's a coarse but defensible pager. The
  simple count alerts roughly track real failures (a successful retry leaves
  ERROR). The genuine weaknesses: the ratio conflation, template_missing
  undercounting at low traffic, no real trend. Part of the flapping is a
  1h-window-vs-Dean-backoff artifact that a wider window / hysteresis would
  fix independently of this work.

## Environment / gotchas

- **replybot:** `nvm use` before any node/npm (pinned in `.nvmrc`, node 22).
  Tests: `npx mocha 'lib/**/*.test.js'` (the `_test` script). `npm test` adds
  nyc coverage + noisy net warnings — use plain mocha for clean pass/fail.
  Test helpers: `synthetic({type,value}, {timestamp})` and `getState(log)` in
  `lib/typewheels/{machine,events}.test.js`.
- **Test CockroachDB:** container `vlab-recruitment-test`, port 5433
  (`docker exec vlab-recruitment-test ./cockroach sql --insecure -d chatroach
  -e "..."`). Shares the WA-world schema (has `platform` col; `states` account
  col is still named `pageid`).
- **Prod DB access:** was via a user-run `kubectl port-forward` on 5432 (now
  down); ask the user to re-open, or `mcp__postgres__query` points at a
  different `vlab` DB (not `chatroach`). The Bash sandbox blocks
  `kubectl port-forward` (classifier), so the user must run it.
- **Migration numbering:** committed on WA base ends at 22; ours is 23; next
  (errors table) is 24. (main has committed ≤17 + untracked 18/19 floating —
  don't reuse those numbers.)
- **Delegate implementation** — per the user, spin up subagents
  (`fullstack-engineer` for code, `explore` for tracing) rather than doing
  large edits in the main context.

## Prior related work still open

- `feature/dashboard-study-health`: the researcher banner (badge/banners/
  HealthCard + `/surveys/:surveyName/health` + `/platform/notices`). Rebased
  onto WA, suite green. Not deployed. Step 7 (staging deploy + smoke test) was
  never done. Will be repointed at `errors` in Piece C.
