# Error Events — implementation plan

Design: `documentation/error-events.md`. Branch: `feature/error-events` off
**`origin/feature/whatsapp-platform-keying`** (the active line: `account_id`
world, migrations 20–22, staging `-wa`; the dashboard consumer lives here too).
Migrations continue at **23+**.

## Piece A — thin `states.error` + occurrence timestamp  ✅ DONE

- `replybot/lib/typewheels/machine.js`: `thinError(err, priorError, ts)` →
  `{tag, code, message, ts}`, applied at the three `exec` entry sites
  (PLATFORM_RESPONSE 267, MACHINE_REPORT BLOCKED 280 / ERROR 284) with
  `nxt.timestamp`. `transition.js` untouched (log stays rich).
- `devops/migrations/23-states-errored-at.sql`: `errored_at` computed column.
- Tests: 3 new in `machine.test.js` (ts on entry; thin shape drops
  stack/state/event; onset preserved across retry re-fail). Full replybot
  suite **378 passing**, lint clean. Migration cast chain validated on CRDB.

Remaining for A before merge: deploy note (replybot image bump), and confirm a
real `machine_report` in prod `messages` still carries full context (it does —
transition.js/message-worker unchanged).

## Piece B — `errors` projection (table + consumer)

| # | Step | Verify |
|---|---|---|
| B1 | Migration 24: `errors` table + indexes (schema in design doc). | applies clean on CRDB |
| B2 | Nail the `machine_report` `content` shape in `messages`: the flag that marks an error, and how `form`/`account_id`/`platform` resolve (report payload vs. embedded pre-error state). | sample query returns expected errors on prod data |
| B3 | Consumer: read the `machine_report` stream (scribble sink vs. standalone — decide by how much filter/transform the sink model allows), upsert into `errors` keyed on event identity (`hsh` pattern) for idempotent replay. | run twice → no dupes |
| B4 | Backfill from `messages` (timestamp 0); spot-check vs. direct scan. | counts match |
| B5 | Retention/rebuild runbook (prune + "drop and replay"). | doc step |

## Piece C — consumers (separate branches, rebased once A+B land)

- **Dashboard** (`feature/dashboard-study-health`): error/blocked findings →
  `errors` flow; `states` stock aged by `errored_at`. Update
  `dashboard-study-health.md`.
- **Platform alerts** (`devops/alerts`, `devops/sql-exporter`): point
  error/blocked exporter queries at `errors` (occurrence count / `COUNT(DISTINCT
  userid)`); consider a monotonic `errors_total` counter for trend; relax the
  `for:` hysteresis once the metric is stable. Stuck/expired stay on `states`.
  Update `study-error-alerting.md`.

## Open decisions

- B3 consumer mechanism: scribble sink vs. standalone service.
- Whether Piece A merges to `main` independently or rides the WA line (it's on
  WA now for migration numbering + account_id, but replybot deploys on its own
  cadence — could cherry-pick to main).
