-- Give the archival log tables the conversation's account and platform.
--
-- A conversation is (platform, account_id, user_id). `messages` had no account
-- column, so replay could not tell one participant's two conversations apart.
--
-- APPLY: bash devops/run-migration.sh <namespace> migrations/26-messages-account.sql
--
-- Ordering vs migrations 27 and 28: independent, either order. Adding a nullable
-- defaultless column is metadata-only in CockroachDB. Every name is
-- `chatroach.`-qualified because the test bootstrap pipes all migrations through
-- one session, where an unqualified name aborts everything after it.

-- Nullable, no DEFAULT: instantaneous even on 106M rows. A DEFAULT would force a
-- full-table rewrite here, which is exactly what this migration avoids.
ALTER TABLE chatroach.messages ADD COLUMN IF NOT EXISTS account_id VARCHAR;
ALTER TABLE chatroach.messages ADD COLUMN IF NOT EXISTS platform   VARCHAR;

-- responses and chat_log already carry the account as `pageid`. They lack only
-- the platform. Stored rather than derived: `credentials` cascades on user
-- delete, so a deleted researcher would otherwise strip the platform binding out
-- of history. Nothing writes these two yet.
ALTER TABLE chatroach.responses ADD COLUMN IF NOT EXISTS platform VARCHAR;
ALTER TABLE chatroach.chat_log  ADD COLUMN IF NOT EXISTS platform VARCHAR;

-- The access path for account-scoped replay. STORING keeps it covering: get()
-- selects `content`, and without `platform` an account-scoped read of it would
-- need an index join per row. A plain CREATE INDEX -- online, resumable, and if
-- it goes wrong the partial index is dropped and the primary is untouched.
CREATE INDEX IF NOT EXISTS messages_userid_account_timestamp_idx
  ON chatroach.messages (userid, account_id, timestamp ASC)
  STORING (content, platform);

-- Retire the superseded index as a CANARY, not a DROP. A visible index keeps
-- serving traffic, so a soak would prove nothing; NOT VISIBLE runs the true end
-- state while keeping revert to one instant statement:
--
--   ALTER INDEX chatroach.messages@messages_userid_timestamp_idx VISIBLE;
--
-- Migration 29 drops it after a clean soak. Until then both are on disk.
-- GUARD: never hide the old index while the new one is still being built.
--
-- CREATE INDEX returns when the schema-change JOB IS CREATED, not when the
-- backfill finishes. Run this file straight through and the ALTER below can hide
-- messages_userid_timestamp_idx while its replacement is still backfilling --
-- leaving BOTH secondary indexes unusable and dropping replay onto a primary-key
-- scan of a 384 GiB table. Observed on vstag 2026-08-22, where the backfill ran
-- for 19 hours without completing.
--
-- Aborts the migration rather than proceeding. If it fires, wait for the job
-- (SHOW JOBS) and re-run -- everything above is idempotent.
SELECT crdb_internal.force_error(
         'XXUUU',
         'messages_userid_account_timestamp_idx is still building; refusing to hide '
         || 'its predecessor. Wait for: ' || description
       )
FROM crdb_internal.jobs
WHERE job_type IN ('SCHEMA CHANGE', 'NEW SCHEMA CHANGE')
  AND status NOT IN ('succeeded', 'failed', 'canceled')
  AND description LIKE '%messages_userid_account_timestamp_idx%'
LIMIT 1;

ALTER INDEX chatroach.messages@messages_userid_timestamp_idx NOT VISIBLE;

-- THE PRIMARY KEY IS DELIBERATELY UNTOUCHED, and this asserts it stayed that way.
--
-- `hsh` is a STORED fnv64a(content) and the account is inside `content` in every
-- shape, so (hsh, userid) is already transitively account-scoped. Widening it
-- would mean ALTER PRIMARY KEY on a 384 GiB table -- a full rewrite of the
-- primary and every secondary index, peaking at ~96 GiB/node against 127 GiB
-- free on the tightest node.
--
-- scribble/message.go's ON CONFLICT (hsh, userid) depends on this, so if someone
-- widens the key later this fails loudly on the next run rather than leaving a
-- silently rewritten table.
SELECT crdb_internal.force_error(
         'XXUUU',
         'messages has a unique index that is not exactly (hsh, userid): ' || index_name
       )
FROM (
  -- ORDER BY inside array_agg is load-bearing: without it the column order is
  -- unspecified and a correct key can compare unequal.
  SELECT index_name, array_agg(column_name ORDER BY seq_in_index) AS cols
  FROM [SHOW INDEXES FROM chatroach.messages]
  WHERE non_unique = false AND storing = false AND implicit = false
  GROUP BY index_name
)
WHERE cols != ARRAY['hsh', 'userid']
LIMIT 1;

-- THE BACKFILL IS NOT A PREREQUISITE. Nothing here requires account_id to be
-- populated, so the order is: this migration, then the account-scoped read path
-- (which tolerates NULL), then `go run ./devops/backfill` at leisure.
--
-- Historical rows replay exactly as they do today throughout the drain. Under a
-- strict `account_id = $2` read they would replay as EMPTY instead, because
-- replay reads the OLDEST STATE_STORE_LIMIT events and those are precisely the
-- ones a partial backfill has not reached.
--
-- REMOVAL GATE for the `OR account_id IS NULL` branch in chatbase.get() -- rows
-- still attributable but not yet attributed. Must be 0. Full scan of 384 GiB;
-- run it deliberately, not on a dashboard.
--
--   SELECT count(*) FROM chatroach.messages
--    WHERE account_id IS NULL
--      AND json_valid(content)
--      AND (<devops/sql/messages-account-id-expr.sql>) IS NOT NULL;
--
-- A plain count of NULL account_id never reaches zero and should not: ~3,000
-- rows are synthetic events carrying no account at all. See
-- planning/messages-account-not-null-todo.md.
