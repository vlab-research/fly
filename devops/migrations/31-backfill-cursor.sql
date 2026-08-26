-- A durable resume cursor for devops/backfill (Phase 1.5).
--
-- APPLY: bash devops/run-migration.sh <namespace> devops/migrations/31-backfill-cursor.sql
--
-- WHY THIS EXISTS.
--
-- The backfill prints its cursor to stdout on every batch, and that was fine
-- while it was a 25-minute run driven from a laptop. Production is ~41 hours in
-- an in-cluster Job (planning/backfill-in-cluster-job.md), and there recovery
-- meant scraping a log line out of a pod that may already have been garbage
-- collected. If it was, the only remaining option is restarting from the
-- beginning of a 107M-row keyspace -- correct, because every batch carries
-- `AND account_id IS NULL`, but hours of scanning to get back to where it was.
--
-- With this table the tool reloads its own cursor at startup, so a restarted pod
-- resumes by itself and `backoffLimit` no longer has to be 0.
--
-- WHY A TABLE AND NOT A CONFIGMAP. The process already holds a connection to
-- this database and already has write privileges on it. A ConfigMap would need a
-- ServiceAccount, a Role, a RoleBinding and a Kubernetes client in a tool whose
-- entire dependency list today is pgx -- new failure modes, none of them in the
-- direction of the actual risk.
--
-- WHY THE CURSOR IS NOT WRITTEN IN THE SAME TRANSACTION AS THE BATCH.
--
-- It would be tidier, and it is deliberately not done. Each batch is currently
-- ONE statement, which CockroachDB runs as an implicit transaction and can
-- retry automatically at the gateway. Wrapping the UPDATE and this upsert in an
-- explicit BEGIN/COMMIT moves retryable serialization errors (40001) out to the
-- client, where this tool has no retry loop -- so the tidier version would trade
-- a harmless race for a new way to abort a 41-hour job.
--
-- The race it leaves is harmless by construction: if the process dies between
-- the batch committing and the cursor being written, the cursor is one batch
-- stale, and re-running that batch updates nothing because every row in it now
-- has a non-NULL account_id. At-least-once is the correct guarantee here.
--
CREATE TABLE IF NOT EXISTS chatroach.backfill_cursor (
  -- Which backfill this row belongs to. Passed as --cursor-key, so two
  -- different backfills can never read each other's position.
  cursor_key   STRING PRIMARY KEY,

  -- The position in chatroach.messages PRIMARY KEY (hsh, userid) of the last
  -- batch known to have committed. NULL means "started, no batch finished yet",
  -- which is a real state and is why these are nullable: a 0/'' sentinel would
  -- be indistinguishable from a genuine first row.
  hsh          INT8   NULL,
  userid       STRING NULL,

  -- Cumulative across restarts, not per-process. These are for the operator
  -- watching a two-day job; nothing reads them back for control flow.
  batches      INT8   NOT NULL DEFAULT 0,
  rows_updated INT8   NOT NULL DEFAULT 0,

  -- Set once the run reaches the end of the table. A restart that finds this
  -- true exits immediately instead of re-walking 107M rows to update nothing.
  done         BOOL   NOT NULL DEFAULT false,

  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- NO GRANT TO `chatroach`, DELIBERATELY.
--
-- The service user has only INSERT and SELECT on chatroach.messages -- verified
-- on vprod 2026-08-26 -- so the backfill cannot run as `chatroach` at all and
-- runs as `root`. Granting the service user write access to this table would
-- widen the service's privileges for a tool that will never connect as it.

-- VERIFY:
--   SELECT * FROM chatroach.backfill_cursor;
--   SHOW GRANTS ON TABLE chatroach.backfill_cursor;
