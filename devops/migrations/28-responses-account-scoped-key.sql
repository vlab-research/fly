-- 28-responses-account-scoped-key.sql
--
-- Make the responses row key the CONVERSATION, not the participant.
--
-- Same defect and same fix as 27-chat-log-account-scoped-key.sql; read that
-- file's header first, it explains why widening the ON CONFLICT target alone
-- cannot work and why ALTER PRIMARY KEY is the only route. Everything there
-- was reproduced against CockroachDB v24.1.0 on both tables.
--
-- responses was keyed PRIMARY KEY (userid, timestamp, question_ref) and
-- scribble wrote `ON CONFLICT (userid, timestamp, question_ref) DO NOTHING`,
-- so an answer recorded for one participant on two of our messaging accounts
-- at the same instant was silently DISCARDED rather than stored. Narrower
-- exposure than chat_log -- it needs millisecond-exact collision -- but it is
-- the same class of bug and the same participant-vs-conversation confusion.
--
-- PRODUCTION PREREQUISITE -- READ THIS BEFORE RUNNING.
--
-- `pageid` cannot enter a primary key while it is nullable (SQLSTATE 42P15),
-- and production holds 1,818,162 NULL-pageid rows out of ~17.8M. Unlike
-- chat_log's 14.8k, that is far too many to backfill in the single implicit
-- transaction a .sql migration would give it. Those rows are frozen legacy --
-- max(timestamp) where pageid IS NULL is 2020-09-06, and every month for the
-- last ten months has zero -- so the backfill is a one-time historical
-- cleanup, not an ongoing concern.
--
-- Run the batched backfill FIRST, to completion:
--
--     bash devops/backfill-responses-pageid.sh <namespace>
--
-- then this file. The guard below refuses to proceed otherwise, so getting
-- the order wrong is a loud no-op rather than a half-migrated table. On a
-- fresh database (test harnesses, `make test-db`) there are no NULL rows and
-- the guard passes untouched.
--
-- =====================================================================
-- SEQUENCING (decided 2026-08-17). Run BOTH migrations, THEN deploy once:
--
--     1. bash devops/run-migration.sh <ns> migrations/27-chat-log-account-scoped-key.sql
--     2. bash devops/backfill-responses-pageid.sh <ns>
--     3. bash devops/run-migration.sh <ns> migrations/28-responses-account-scoped-key.sql
--     4. deploy the scribble build carrying both new ON CONFLICT targets
--
-- One scribble build changes BOTH response.go and chatlog.go, so a deploy needs
-- both migrations applied. See 27's header for why 27 must not be applied alone
-- and left undeployed.
--
-- ORDERING within that plan: schema before code, always. The new ON CONFLICT
-- target raises 42P10 against the old schema and scribble treats every write
-- error as fatal (scribble.go:36-39, log.Fatalf), so shipping the code first is
-- a crash loop, not a degradation.
--
-- The reverse window -- migration applied, old pods still serving -- is safe on
-- THIS table, and that is not luck: the old code writes NULL only for an absent
-- pageid, and current traffic produces none (newest NULL row is 2020-09-06). So
-- no 23502 during the rollout. chat_log does not have that property, which is
-- why scribble coerces nil there.
--
-- Also block the chat-log producer restoration on this landing; step 4 is
-- shared. See documentation/chat-message-logging.md.
-- =====================================================================
--
-- COST AND HEADROOM. This is the only genuinely hot table in this pair, and the
-- one real cost in the whole change. Measured in production 2026-08-17:
--
--     responses    39.24 GiB    982 ranges   17,774,273 rows
--     (for scale:  chat_log 2.91 GiB / 65 ranges; messages 384.62 GiB / 9089)
--
-- ALTER PRIMARY KEY is an ONLINE schema change -- background index backfill then
-- swap, no table lock, writes continue throughout. It rewrites the primary index
-- and rebuilds the secondary indexes, so peak additional space is roughly the
-- size of the table again, ~39 GiB, while the old indexes still exist. Cluster
-- is 4 x 236 GiB with ~130 GiB free per node.
--
-- That fits under EITHER reading of what `range_size` measures, so the ambiguity
-- does not need resolving before running. If it is replica-inclusive (which the
-- four largest tables summing to roughly total cluster used space suggests),
-- peak is ~39 GiB cluster-wide, ~10 GiB/node -- about 8% of free space. If it is
-- per-replica logical, peak is ~118 GiB cluster-wide at RF=3, ~29 GiB/node --
-- about 23% of free space. Comfortable either way.
--
-- Space is NOT reclaimed at completion: dropped index data is garbage-collected
-- asynchronously per the table's zone `gc.ttlseconds`, so plan for peak usage to
-- persist for that TTL afterwards rather than falling immediately.
--
-- The rewrite moves more bytes than 17.8M rows suggests, because the primary
-- key's STORING set includes `metadata` JSONB, `response` and `question_text`.
-- Prefer a low-traffic window. Correctness was verified against CockroachDB
-- v24.1.0 on the real DDL -- FK to surveys, the `clusterid` STORED computed
-- column, the inverted index and the wide covering index all survive -- but that
-- verification was a single node with trivial data, NOT concurrency at 17.8M
-- rows under load. Watch the schema-change job rather than assuming.

-- Refuse to run against un-backfilled data. See the header.
SELECT crdb_internal.force_error(
         'XXUUU',
         'responses still has NULL pageid rows -- run devops/backfill-responses-pageid.sh first'
       )
FROM chatroach.responses
WHERE pageid IS NULL
LIMIT 1;

-- NOT NULL, and deliberately NO DEFAULT -- see 27's equivalent block for the full
-- reasoning. In short: '' is the sentinel for rows whose account was never
-- recorded (the backfill above), but a column DEFAULT applies to future INSERTs
-- and would silently hand "account unknown" to a writer that merely forgot the
-- column. This migration exists because attribution was failing silently, so an
-- omitting writer gets a loud 23502. `states.pageid` is likewise NOT NULL with no
-- default.
ALTER TABLE chatroach.responses ALTER COLUMN pageid SET NOT NULL;

-- pageid is APPENDED, so (userid, timestamp) stays an exact key prefix and
-- every existing access path keeps its locality.
ALTER TABLE chatroach.responses
  ALTER PRIMARY KEY USING COLUMNS (userid, timestamp, question_ref, pageid);

-- ALTER PRIMARY KEY retains the OLD primary key as a UNIQUE secondary index.
-- Left in place it re-imposes the exact constraint this migration removes, and
-- the fix becomes a silent no-op whose inserts fail 23505 instead. Load-bearing.
DROP INDEX IF EXISTS chatroach.responses@responses_userid_timestamp_question_ref_key CASCADE;

-- Fail loudly if any unique index other than the new primary key survives.
SELECT crdb_internal.force_error(
         'XXUUU',
         'responses still has a unique index that excludes pageid: ' || index_name
       )
FROM [SHOW INDEXES FROM chatroach.responses]
WHERE non_unique = false AND index_name != 'responses_pkey'
LIMIT 1;
