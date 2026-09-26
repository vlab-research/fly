-- 34-states-timeout-date-compound-wait.sql: schedule the timeout arm of a
-- compound wait.
--
-- states.timeout_date is what dean's Timeouts query sweeps, and dean is the
-- only producer of `timeout` events. The definition in
-- 07-timeout-date-validation.sql only looks at the top level of
-- state_json->'wait', so a compound wait
--
--   {"op": "or", "vars": [{"type": "external", ...}, {"type": "timeout", "value": "1 day"}]}
--
-- has no top-level `type`, computes NULL, and is never swept: "wait for the
-- video OR one day" waits forever for the video (Linear VIR-28).
--
-- WHAT THE COLUMN COMPUTES
--
--   top-level timeout   unchanged from 07, except the relative-interval check
--                       below is wider.
--   op = 'or'           the EARLIEST schedulable timeout arm -- the wait ends at
--                       whichever arm is satisfied first.
--   op = 'and'          the LATEST schedulable timeout arm. Replybot marks every
--                       timeout arm satisfied by one dean event (value ==
--                       waitStart, waiting.js), so firing at an earlier arm would
--                       satisfy a longer one early. If a non-timeout arm is still
--                       unmet when it fires, replybot records the event and
--                       keeps waiting; the recorded event satisfies the arm when
--                       the rest arrives.
--   anything else       NULL, as before.
--
-- Only the first four arms (vars[0..3]) of a one-level compound wait are read:
-- a computed column cannot iterate a JSON array or call a UDF (CockroachDB
-- v24.1, issue 83234). Nested compounds and absolute-date arms inside a
-- compound are not scheduled. An absolute arm is left out because
-- parse_timestamp raises on a bad string, and an error here fails every write
-- to the row, crash-looping the states sink. See documentation/waits-and-timeouts.md.
--
-- RELATIVE INTERVALS accept 1-3 "<number> <unit>" parts, decimals, the usual
-- abbreviations and any case ("90 mins", "1.5 hours", "1 day 2 hours"); 07
-- accepted only a single whole number and a spelled-out unit. Every string the
-- pattern admits must also parse and must not overflow a TIMESTAMP, or the write
-- fails, so the number is capped at 6 digits (4 for years). The largest
-- admitted interval, three parts of 999999 months, lands in year ~252000,
-- inside the TIMESTAMP range. 07's unbounded `\d+` admitted "999999 years",
-- which overflows and errors.
--
-- HOW THE SWAP WORKS, AND WHY NOT 07's DROP-THEN-ADD
--
-- 07 dropped the column and added it back. Between the two, `timeout_date`
-- does not exist: dean's Timeouts query errors (dean.go handle() is
-- log.Fatal, so the whole run dies) and the dashboard's states queries fail,
-- for as long as the ADD takes to backfill. Here the new column is built under
-- a temporary name while the old one keeps serving, and the two are swapped by
-- renames in one transaction, which is a metadata change. Readers never see the
-- column missing. The index is rebuilt the same way.
--
-- Every step is safe to re-run from any point of failure: re-running converges
-- on the same end state, at the cost of repeating the backfill.
--
-- PRODUCTION COST (runbook: planning/vir-28-compound-wait-timeout.md)
--
-- Two online backfills and no table lock: ADD COLUMN ... STORED with its
-- (current_state, timeout_date) STORING (state_json) index, then DROP COLUMN,
-- which rewrites the primary index. 33-states-last-inbound.sql is the same
-- shape -- stored column plus an index storing state_json -- and took 113 s on
-- vprod (1,124,891 rows) under run-migration.sh with writers serving, so expect
-- a few minutes in total. While both indexes exist the table carries a second
-- copy of state_json; dropped index data is reclaimed after the zone's
-- gc.ttlseconds (25 h in production), not at completion.

SET sql_safe_updates = false;

-- Left behind if an earlier run failed between the swap and the drop; the swap
-- is already done, so dropping it completes that run and this one repeats it.
ALTER TABLE chatroach.states DROP COLUMN IF EXISTS timeout_date_superseded;

-- One leaf expression repeated per arm: the interval is value.timeout for a
-- {"type": "relative"} object, or value itself when it is a string. The last
-- (ELSE) copy is the top-level wait.
ALTER TABLE chatroach.states ADD COLUMN IF NOT EXISTS timeout_date_next TIMESTAMPTZ AS (CASE
  WHEN state_json->'wait'->>'type' = 'timeout'
       AND state_json->'wait'->'value'->>'type' = 'absolute'
    THEN timezone('UCT', parse_timestamp(state_json->'wait'->'value'->>'timeout'))
  WHEN state_json->'wait'->>'op' = 'or' THEN LEAST(
    CASE WHEN state_json->'wait'->'vars'->0->>'type' = 'timeout' AND (CASE WHEN state_json->'wait'->'vars'->0->'value'->>'type' = 'relative' THEN state_json->'wait'->'vars'->0->'value'->>'timeout' WHEN jsonb_typeof(state_json->'wait'->'vars'->0->'value') = 'string' THEN state_json->'wait'->'vars'->0->>'value' END) ~* '^\s*((\d{1,6}(\.\d{1,6})?\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|mons?|months?)|\d{1,4}(\.\d{1,6})?\s*(y|yrs?|years?))\s*){1,3}$'
      THEN timezone('UCT', CEILING((state_json->>'waitStart')::INT/1000)::INT::TIMESTAMP + parse_interval(CASE WHEN state_json->'wait'->'vars'->0->'value'->>'type' = 'relative' THEN state_json->'wait'->'vars'->0->'value'->>'timeout' WHEN jsonb_typeof(state_json->'wait'->'vars'->0->'value') = 'string' THEN state_json->'wait'->'vars'->0->>'value' END))
    END,
    CASE WHEN state_json->'wait'->'vars'->1->>'type' = 'timeout' AND (CASE WHEN state_json->'wait'->'vars'->1->'value'->>'type' = 'relative' THEN state_json->'wait'->'vars'->1->'value'->>'timeout' WHEN jsonb_typeof(state_json->'wait'->'vars'->1->'value') = 'string' THEN state_json->'wait'->'vars'->1->>'value' END) ~* '^\s*((\d{1,6}(\.\d{1,6})?\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|mons?|months?)|\d{1,4}(\.\d{1,6})?\s*(y|yrs?|years?))\s*){1,3}$'
      THEN timezone('UCT', CEILING((state_json->>'waitStart')::INT/1000)::INT::TIMESTAMP + parse_interval(CASE WHEN state_json->'wait'->'vars'->1->'value'->>'type' = 'relative' THEN state_json->'wait'->'vars'->1->'value'->>'timeout' WHEN jsonb_typeof(state_json->'wait'->'vars'->1->'value') = 'string' THEN state_json->'wait'->'vars'->1->>'value' END))
    END,
    CASE WHEN state_json->'wait'->'vars'->2->>'type' = 'timeout' AND (CASE WHEN state_json->'wait'->'vars'->2->'value'->>'type' = 'relative' THEN state_json->'wait'->'vars'->2->'value'->>'timeout' WHEN jsonb_typeof(state_json->'wait'->'vars'->2->'value') = 'string' THEN state_json->'wait'->'vars'->2->>'value' END) ~* '^\s*((\d{1,6}(\.\d{1,6})?\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|mons?|months?)|\d{1,4}(\.\d{1,6})?\s*(y|yrs?|years?))\s*){1,3}$'
      THEN timezone('UCT', CEILING((state_json->>'waitStart')::INT/1000)::INT::TIMESTAMP + parse_interval(CASE WHEN state_json->'wait'->'vars'->2->'value'->>'type' = 'relative' THEN state_json->'wait'->'vars'->2->'value'->>'timeout' WHEN jsonb_typeof(state_json->'wait'->'vars'->2->'value') = 'string' THEN state_json->'wait'->'vars'->2->>'value' END))
    END,
    CASE WHEN state_json->'wait'->'vars'->3->>'type' = 'timeout' AND (CASE WHEN state_json->'wait'->'vars'->3->'value'->>'type' = 'relative' THEN state_json->'wait'->'vars'->3->'value'->>'timeout' WHEN jsonb_typeof(state_json->'wait'->'vars'->3->'value') = 'string' THEN state_json->'wait'->'vars'->3->>'value' END) ~* '^\s*((\d{1,6}(\.\d{1,6})?\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|mons?|months?)|\d{1,4}(\.\d{1,6})?\s*(y|yrs?|years?))\s*){1,3}$'
      THEN timezone('UCT', CEILING((state_json->>'waitStart')::INT/1000)::INT::TIMESTAMP + parse_interval(CASE WHEN state_json->'wait'->'vars'->3->'value'->>'type' = 'relative' THEN state_json->'wait'->'vars'->3->'value'->>'timeout' WHEN jsonb_typeof(state_json->'wait'->'vars'->3->'value') = 'string' THEN state_json->'wait'->'vars'->3->>'value' END))
    END
  )
  WHEN state_json->'wait'->>'op' = 'and' THEN GREATEST(
    CASE WHEN state_json->'wait'->'vars'->0->>'type' = 'timeout' AND (CASE WHEN state_json->'wait'->'vars'->0->'value'->>'type' = 'relative' THEN state_json->'wait'->'vars'->0->'value'->>'timeout' WHEN jsonb_typeof(state_json->'wait'->'vars'->0->'value') = 'string' THEN state_json->'wait'->'vars'->0->>'value' END) ~* '^\s*((\d{1,6}(\.\d{1,6})?\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|mons?|months?)|\d{1,4}(\.\d{1,6})?\s*(y|yrs?|years?))\s*){1,3}$'
      THEN timezone('UCT', CEILING((state_json->>'waitStart')::INT/1000)::INT::TIMESTAMP + parse_interval(CASE WHEN state_json->'wait'->'vars'->0->'value'->>'type' = 'relative' THEN state_json->'wait'->'vars'->0->'value'->>'timeout' WHEN jsonb_typeof(state_json->'wait'->'vars'->0->'value') = 'string' THEN state_json->'wait'->'vars'->0->>'value' END))
    END,
    CASE WHEN state_json->'wait'->'vars'->1->>'type' = 'timeout' AND (CASE WHEN state_json->'wait'->'vars'->1->'value'->>'type' = 'relative' THEN state_json->'wait'->'vars'->1->'value'->>'timeout' WHEN jsonb_typeof(state_json->'wait'->'vars'->1->'value') = 'string' THEN state_json->'wait'->'vars'->1->>'value' END) ~* '^\s*((\d{1,6}(\.\d{1,6})?\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|mons?|months?)|\d{1,4}(\.\d{1,6})?\s*(y|yrs?|years?))\s*){1,3}$'
      THEN timezone('UCT', CEILING((state_json->>'waitStart')::INT/1000)::INT::TIMESTAMP + parse_interval(CASE WHEN state_json->'wait'->'vars'->1->'value'->>'type' = 'relative' THEN state_json->'wait'->'vars'->1->'value'->>'timeout' WHEN jsonb_typeof(state_json->'wait'->'vars'->1->'value') = 'string' THEN state_json->'wait'->'vars'->1->>'value' END))
    END,
    CASE WHEN state_json->'wait'->'vars'->2->>'type' = 'timeout' AND (CASE WHEN state_json->'wait'->'vars'->2->'value'->>'type' = 'relative' THEN state_json->'wait'->'vars'->2->'value'->>'timeout' WHEN jsonb_typeof(state_json->'wait'->'vars'->2->'value') = 'string' THEN state_json->'wait'->'vars'->2->>'value' END) ~* '^\s*((\d{1,6}(\.\d{1,6})?\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|mons?|months?)|\d{1,4}(\.\d{1,6})?\s*(y|yrs?|years?))\s*){1,3}$'
      THEN timezone('UCT', CEILING((state_json->>'waitStart')::INT/1000)::INT::TIMESTAMP + parse_interval(CASE WHEN state_json->'wait'->'vars'->2->'value'->>'type' = 'relative' THEN state_json->'wait'->'vars'->2->'value'->>'timeout' WHEN jsonb_typeof(state_json->'wait'->'vars'->2->'value') = 'string' THEN state_json->'wait'->'vars'->2->>'value' END))
    END,
    CASE WHEN state_json->'wait'->'vars'->3->>'type' = 'timeout' AND (CASE WHEN state_json->'wait'->'vars'->3->'value'->>'type' = 'relative' THEN state_json->'wait'->'vars'->3->'value'->>'timeout' WHEN jsonb_typeof(state_json->'wait'->'vars'->3->'value') = 'string' THEN state_json->'wait'->'vars'->3->>'value' END) ~* '^\s*((\d{1,6}(\.\d{1,6})?\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|mons?|months?)|\d{1,4}(\.\d{1,6})?\s*(y|yrs?|years?))\s*){1,3}$'
      THEN timezone('UCT', CEILING((state_json->>'waitStart')::INT/1000)::INT::TIMESTAMP + parse_interval(CASE WHEN state_json->'wait'->'vars'->3->'value'->>'type' = 'relative' THEN state_json->'wait'->'vars'->3->'value'->>'timeout' WHEN jsonb_typeof(state_json->'wait'->'vars'->3->'value') = 'string' THEN state_json->'wait'->'vars'->3->>'value' END))
    END
  )
  ELSE
    CASE WHEN state_json->'wait'->>'type' = 'timeout' AND (CASE WHEN state_json->'wait'->'value'->>'type' = 'relative' THEN state_json->'wait'->'value'->>'timeout' WHEN jsonb_typeof(state_json->'wait'->'value') = 'string' THEN state_json->'wait'->>'value' END) ~* '^\s*((\d{1,6}(\.\d{1,6})?\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|mons?|months?)|\d{1,4}(\.\d{1,6})?\s*(y|yrs?|years?))\s*){1,3}$'
      THEN timezone('UCT', CEILING((state_json->>'waitStart')::INT/1000)::INT::TIMESTAMP + parse_interval(CASE WHEN state_json->'wait'->'value'->>'type' = 'relative' THEN state_json->'wait'->'value'->>'timeout' WHEN jsonb_typeof(state_json->'wait'->'value') = 'string' THEN state_json->'wait'->>'value' END))
    END
END) STORED;

CREATE INDEX IF NOT EXISTS states_current_state_timeout_date_next_idx
  ON chatroach.states (current_state, timeout_date_next) STORING (state_json);

-- One transaction, so readers see either the old column and index or the new
-- ones, never a missing name. Renames are metadata only.
BEGIN;
ALTER INDEX chatroach.states@states_current_state_timeout_date_idx
  RENAME TO states_current_state_timeout_date_superseded_idx;
ALTER INDEX chatroach.states@states_current_state_timeout_date_next_idx
  RENAME TO states_current_state_timeout_date_idx;
ALTER TABLE chatroach.states RENAME COLUMN timeout_date TO timeout_date_superseded;
ALTER TABLE chatroach.states RENAME COLUMN timeout_date_next TO timeout_date;
COMMIT;

-- Drops the superseded index with it.
ALTER TABLE chatroach.states DROP COLUMN timeout_date_superseded;

SET sql_safe_updates = true;
