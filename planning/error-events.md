# Error Events — plan

**Status (2026-07-25): Piece A is done and is what ships. Pieces B and C are
deferred as a future plan** — not started, and deliberately not started until
the root issue in §"Why B is parked" is decided.

Design: `documentation/error-events.md`.
Branch: `feature/error-events`, based on **`origin/feature/whatsapp-platform-keying`**
(the active line: `account_id` world, migrations 20–22, on staging), NOT `main`.
Migrations continue at **23+**.

Supporting evidence docs (keep, they are the input to any future attempt):
- `planning/error-events-b2-payload.md` — the real on-the-wire `machine_report`
  shape, verified from source. Read this before designing anything.
- `planning/error-events-b3-mechanism.md` — scribble-sink vs standalone-service
  scoping. Recommendation: scribble sink. Partly unverified (see its header).

---

## Piece A — thin `states.error` + occurrence timestamp  ✅ DONE

Committed as `b3345b63`. This is the "nice to have now" slice and it stands on
its own — it improves the existing stock-based alerting without depending on
any of the deferred work.

- `replybot/lib/typewheels/machine.js`: `thinError(err, priorError, ts)` →
  `{tag, code, message, ts}`, applied at the three `exec` entry sites
  (PLATFORM_RESPONSE, MACHINE_REPORT BLOCKED / ERROR) using `nxt.timestamp`.
  - `ts` = occurrence time, set once per episode, **preserved across retry
    re-fails**, **cleared on RESPOND** so a new episode gets a fresh onset.
  - Drops stack / pre-error `state` snapshot / raw `event` from the persisted
    state. `transition.js` intentionally untouched, so `messages` keeps the
    full context any future projection would need.
- `devops/migrations/23-states-errored-at.sql`: `errored_at` computed column
  (`ceiling((state_json->'error'->>'ts')::INT8/1000)::INT8::TIMESTAMPTZ`),
  mirroring `form_start_time`. Cast chain validated on CRDB.
- Tests: 3 new in `machine.test.js`; full replybot suite **378 passing**, lint
  clean. `message` preserved, so the 2 Grafana panels and the
  `error_tag`/`fb_error_code` computed columns keep working.

**Why it is worth shipping alone:** `updated` is bumped by Dean on every
retry/followup/timeout, so it cannot distinguish "quiet" from "recovered" and
re-warms old errors — the source of the AlertManager flapping. `errored_at`
(onset, immune to retry churn) lets the existing stock be aged by when the
error actually started, without any new table, service, or wire-format change.

### Remaining to ship A

1. Apply migration `23-states-errored-at.sql` (staging → prod).
2. Replybot image bump + deploy.
3. Optional follow-on (independent of B): repoint the alert/dashboard queries
   that age the error stock from `updated` to `errored_at`, and widen the
   `for:` hysteresis. This is where the de-flapping benefit is actually
   realised — A only makes it *possible*.

---

## Why B is parked (read before restarting)

B was going to be an append-only `errors` table projected from `machine_report`
events. Tracing the real payload (see `error-events-b2-payload.md`) turned up a
structural problem that a table + sink does not solve:

**`FB` delivery errors — the highest-volume class, and the one the alerts group
by survey — carry no `form` and no `platform`.** Their report is only
`{error:{tag,message,code}, user, page, timestamp}` (`message-worker/worker.go:320-347`).

That is not an oversight. Three layers:

1. **The command is not self-describing.** `SendMessageCommand`
   (`message-worker/types/command.go:17-27`) has `Platform` and
   `PlatformAccountID` but no survey/form field, because
   `transition.js buildCommands(...)` (`transition.js:76-104`) never puts one
   in. message-worker cannot attribute the failure because it was never told
   what it was sending for.
2. **message-worker is impersonating replybot.** `machine_report` means
   "replybot ran the machine, here is the report". message-worker has no
   machine run — it has a failed command — so it hand-builds a four-field
   skeleton that happens to satisfy `machine.js`'s reader. A delivery failure
   is being reported through a state-machine event type.
3. **There is no error-event contract.** Each producer invents its own partial
   shape. Errors converge only at `states.error`, and only by being *routed
   through the state machine* — which is precisely why attribution exists in
   `states` and evaporates when you try to read errors as events.

Today this is masked: the FB report feeds back through the machine, sets
`states.error`, and the alerts read `states.current_form`. Attribution happens
via the state, not via the event. A pure event projection loses it.

### Decisions to make before restarting B

1. **Define one error-event contract** that is complete at emission and that
   every producer emits (bigger; fixes layers 2–3; makes `errors` a genuine 1:1
   projection with no enrichment step) — **or** keep `machine_report` and just
   enrich it with `form`/`platform` (smaller; fixes layer 1 only). Leaning:
   contract first. Either way it is a wire-format change needing a coordinated
   replybot + message-worker deploy.
2. **Is `form` the right key**, or should the command carry fuller survey
   context (shortcode + form id) since the envelope is being touched anyway?
3. **The `STATE_TRANSITION` hole** (below) — fix in the same breath, or track
   separately?

Rejected alternatives, and why (so they are not relitigated):
- *Join `states` at write time* — cheap and fixes history, but breaks the
  "pure projection, rebuildable by replay" property the whole design rests on:
  a rebuild re-attributes old errors to whatever form the user is on today.
- *Nullable `form`, join at query time* — keeps purity, but per-survey error
  rate is then only correct while the user is still in that state, so the flow
  silently degrades exactly where it is most needed.

### Known defect found along the way: `STATE_TRANSITION` errors vanish

`transition.js:151-157` returns `publish: false`, so these errors reach **no**
table — not `messages`, not `states` — only stdout. Deliberate since
`cb87b858` (2020-09-07, "dont publish report in state_transition error").

Most likely reason, reconstructed (not confirmed by the commit message): a
**loop guard**. `machine.js:293-310` no-ops a `machine_report` once the state is
already ERROR/BLOCKED, but a `STATE_TRANSITION` thrown *while processing a
machine_report* would publish another report, which would throw again — an
unbounded error loop. If that is the reason, the root fix is to make error
events **non-reentrant** (an error event may never itself produce a new error
report) and then publish them like everything else, rather than dropping them
silently.

`documentation/error-events.md` §1 previously listed `STATE_TRANSITION` as a
producer feeding the log; that has been corrected.

---

## Piece B — `errors` projection (DEFERRED, not started)

Kept for whoever picks this up. Do **not** start at B1; start at the decisions
above, because they change the table shape.

| # | Step | Verify |
|---|---|---|
| B1 | Migration 24: `errors` table + indexes. Shape depends on the contract decision. | applies clean on CRDB |
| B2 | ✅ **done** — payload shape nailed; see `error-events-b2-payload.md`. Still wants a prod tag-distribution query to size the FB fraction. | sample query on prod |
| B3 | Consumer. Scoped: scribble sink recommended (`error-events-b3-mechanism.md`). Idempotent on event identity (`hsh` pattern). | run twice → no dupes |
| B4 | Backfill from `messages`. Note: backfilled rows cannot have `form` for FB errors under any option. | counts match |
| B5 | Retention/rebuild runbook. | doc step |

## Piece C — consumers (DEFERRED, blocked on B)

- **Dashboard** (`feature/dashboard-study-health`): error/blocked findings →
  `errors` flow; `states` stock aged by `errored_at`. Update
  `documentation/dashboard-study-health.md`.
- **Platform alerts** (`devops/alerts`, `devops/sql-exporter`): point
  error/blocked queries at `errors`; consider a monotonic `errors_total` for
  trend; relax `for:` hysteresis once stable. Stuck/expired alerts stay
  stock-based (genuine current-state questions). Update
  `documentation/study-error-alerting.md`.

**Note:** the `errored_at` half of Piece C does *not* depend on B and can be
done as part of shipping A (see "Remaining to ship A", item 3).

---

## Environment / gotchas

- **replybot:** `nvm use` first (node 22, pinned in `.nvmrc`). Tests:
  `npx mocha 'lib/**/*.test.js'`. `npm test` adds nyc + noisy net warnings.
  Helpers: `synthetic({type,value},{timestamp})` and `getState(log)` in
  `lib/typewheels/{machine,events}.test.js`.
- **Test CockroachDB:** container `vlab-recruitment-test`, port 5433
  (`docker exec vlab-recruitment-test ./cockroach sql --insecure -d chatroach
  -e "..."`). Shares the WA-world schema.
- **Prod DB access:** needs a user-run `kubectl port-forward` — the Bash
  sandbox blocks it (classifier). As of 2026-07-25 nothing is listening on
  5432. `mcp__postgres__query` points at a different `vlab` DB, not
  `chatroach`.
- **Migration numbering:** WA base ends at 22; ours is 23; next free is 24.
  (`main` has committed ≤17 plus untracked 18/19 floating — do not reuse.)

## Related open work

- `feature/dashboard-study-health` — researcher banner (badge/banners/HealthCard
  + `/surveys/:surveyName/health` + `/platform/notices`). Rebased onto the WA
  line, suite green, **not deployed**; staging deploy + smoke test never done.
  It currently queries the `states` stock, which is fine and unblocked — it only
  needed `errors` for the deferred flow half.
