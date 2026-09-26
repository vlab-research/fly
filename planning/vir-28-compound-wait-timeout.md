# VIR-28: compound `or` wait never times out

Linear: https://linear.app/vlab-research/issue/VIR-28

## Cause

`states.timeout_date` (07-timeout-date-validation.sql, unchanged by any later
migration, including `devops/migrations/prod/`) only reads the top level of
`state_json->'wait'`. `{"op": "or", "vars": [...]}` has no top-level `type`,
so the column is NULL. dean is the only producer of `timeout` events, and it
filters out rows with a NULL date. The ticket counts 4,114 such conversations
in `vprod`, the newest from 2023-08-30. `op: and` with a timeout arm was broken
the same way, and worse: it can never finish even after the event arrives,
because its timeout arm is never satisfied.

The replybot side already worked. `waiting.js` recurses into `op`/`vars`, and a
timeout leaf is satisfied by any timeout event with `value == waitStart`, which
is exactly what dean sends. Only the scheduling was missing.

## Fix

A new migration, `34-states-timeout-date-compound-wait.sql`, redefines the column:

- `op: or`: `LEAST` over the arms, which gives the earliest timeout arm.
- `op: and`: `GREATEST` over the arms, which gives the latest. One dean event
  satisfies every timeout leaf at once, so firing at an earlier arm would
  satisfy a longer one early.
- The relative-interval pattern is wider (the ticket's second point): 1-3
  parts, decimals, abbreviations, any case. The number is capped at 6 digits
  (4 for years), because an admitted value that overflows TIMESTAMP errors,
  and a computed-column error fails the write. 07's unbounded `\d+` already
  admitted `"999999 years"`, which errors. The new test
  `TestTimeoutDate_NeverFailsTheWrite` fails against 07 for exactly that reason.

### Decisions and alternatives

| Question | Decision | Why / alternatives |
|---|---|---|
| Where to fix | The column, not dean's `calculated_timeout_date` | The dashboard, the Grafana panels and `study-error-alerting` (`expired_waits`) all read `timeout_date`. Fixing only dean would leave them blind to compound waits. |
| How many arms | `vars[0..3]`, one level deep | A computed column cannot use `jsonb_array_elements` or a UDF (tried on v24.1: issue 83234). Four covers every shape seen in docs and tests. More arms make an already long expression longer. |
| Absolute arms inside a compound | Not scheduled | No regex fully validates a date (`2026-02-31` matches a digit pattern but `parse_timestamp` raises), and a raise fails the write and crash-loops the states sink. Top-level absolute stays as it was, unguarded: every existing row already parses, and adding a guard could turn working values NULL. |
| Named (`variable`) arms inside a compound | Not scheduled (unchanged) | That path is dean's settings join, not the column. Documented. |
| Rewrite pattern | Build a `timeout_date_next` column plus index, swap both names in one transaction, drop the old column | 07 used drop-then-add. While the ADD backfills, `timeout_date` does not exist, so dean's `Timeouts` errors (`handle` is `log.Fatal`, and the whole run dies) and the dashboard's states queries fail. The swap costs the same backfills and removes that outage. Tested on v24.1.28 as re-runnable from every inter-statement failure point. |
| Split into 34a/34b like 28? | No | 28 split so a code deploy could land between the halves. No code deploy is needed here: dean reads the column by the same name. |

## Where the docs and the code disagreed

1. `documentation/questions.md` and `replybot/README.md` recommended `op: or`
   plus a timeout "so there is always a way out". It never fired. Fixed by this
   change; both docs now link to `documentation/waits-and-timeouts.md`.
2. `documentation/questions.md` implied any interval string works. Only
   `^\d+\s*<spelled unit>$` did. It now documents the real syntax.
3. Nothing documented that an empty `DEAN_TIMEOUT_BLACKLIST` makes `Timeouts`
   fire **one** row per run (`ORDER BY ... LIMIT 1`). Production is unaffected
   (it sets a blacklist); the testcontainers stack runs with it empty. Now in
   `dean/README.md` and `documentation/waits-and-timeouts.md` §5. Not changed,
   since it is out of scope.
4. `devops/dev/create-states-table.sql` (untracked, main checkout only) says
   `timeout_date` is "incompatible with CRDB v24.x". That is false: 07 and 34
   both apply on v24.1.0 (testcontainers) and v24.1.28 (`make test-db`).
5. The ticket says public docs no longer promote the compound form. The
   in-repo `documentation/questions.md` still did.
6. A top-level absolute timeout with an unparseable string fails the state
   write. This predates the change and is not fixed here. See "Follow-ups".

## Production rollout

**Pre-flight (read only):**

```sql
SHOW INDEXES FROM chatroach.states;   -- expect states_current_state_timeout_date_idx on timeout_date
SELECT count(*) FROM chatroach.states;
SELECT state_json->'wait'->>'op' AS op, count(*), count(timeout_date)
FROM chatroach.states WHERE current_state = 'WAIT_EXTERNAL_EVENT' GROUP BY 1;
```

If the index has a different name, the swap transaction fails on its first
statement and rolls back. That is safe: re-run once the file matches production.

**Apply:** `bash devops/run-migration.sh vstag migrations/34-states-timeout-date-compound-wait.sql`,
verify, then the same against `vprod`. No code deploy is needed, before or after.

**Cost:** two online backfills (the ADD with its index, then the DROP COLUMN
primary-index rewrite) and no table lock. Migration 33 had the same shape
(stored column plus an index STORING `state_json`) and took 113 s on vprod
(1,124,891 rows) with writers serving, so expect a few minutes. Disk: while
both indexes exist, `state_json` is held one extra time. The dropped index is
reclaimed after `gc.ttlseconds` (25 h), not at completion.

**What happens on the first dean run afterwards:** of the ~4,114 stuck `or`
rows, only those whose timeout matured within `DEAN_TIMEOUT_MAX_PAST`
(production: `72 hours`, `devops/values/production.yaml`) are selected. The
2023 rows fall far outside that window, so **they stay parked**. That is
intended: messaging someone three years later is worse than leaving them. If
recovering any of them is wanted, a Bail is the tool, not this migration.

**Alerting side effect to watch:** `expired_waits` (`timeout_date < NOW()` on a
waiting row) feeds both the `deanexpiredwaits` alert and the dashboard's
study-health rule. Both only count rows `updated` inside their window (1 h and
24 h), so stale 2023 rows do not count. A compound row that is still being
touched but whose timeout matured more than 72 h ago would start counting. It
would stay there, because dean will not fire that far back. The ticket's data
shows none (newest `or` row 2023-08-30), but check the verify query's `max(updated)`.

**Verify:**

```sql
SELECT count(*) FROM chatroach.states
WHERE current_state = 'WAIT_EXTERNAL_EVENT' AND state_json->'wait'->>'op' = 'or'
  AND timeout_date IS NOT NULL;               -- was 0
SELECT job_id, status, fraction_completed FROM [SHOW JOBS]
WHERE job_type LIKE '%SCHEMA CHANGE%' ORDER BY created DESC LIMIT 5;
```

If a schema-change job sits at `fraction_completed = 0` with an empty `error`,
check the cockroach pod log for `memory budget exceeded` (see 26's and 28a's
headers). Recover with `CANCEL JOB`, then re-run the file with
`SET use_declarative_schema_changer = 'off'`. The file is re-runnable from any
point.

**Rollback:** re-apply 07's expression by the same swap (a new migration). No
data is lost either way: the column is derived.

## Verification done

- `dean`: new `timeout_compound_wait_test.go` (column semantics, write safety,
  `Timeouts` end to end). It passes on 01-34 and fails on 01-33. Full dean
  suite green.
- Backfill check: rows written under 07, then 34 applied. Compound and
  wide-syntax rows gain dates, and garbage rows stay NULL without failing the
  backfill. `EXPLAIN` shows the timeout scan uses the renamed index.
- `replybot`: machine tests pinning a dean timeout against `or` (string and
  relative arms), `and` (waits, then completes on the event) and a stale
  `waitStart`. They pass on current code, confirming no replybot change is needed.
- testcontainers: a new e2e test, `Sends message after the timeout arm of a
  compound or wait`.

## Follow-ups (not done here)

- Guard top-level absolute timeouts against unparseable strings (a write
  failure today).
- Decide whether `Timeouts` should drop the `LIMIT 1` branch.
- Payments' predicate still excludes composite waits on purpose (see
  `dean/README.md`). It is unaffected.
