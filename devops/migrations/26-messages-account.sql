-- 26-messages-account.sql
--
-- Give the archival log tables the conversation's account and platform.
--
-- A conversation is (platform, account_id, user_id). `messages` had no account
-- column at all, so replay could not tell one participant's two conversations
-- apart and `chatbase.get()` interleaved them (plan §2.2 item 3).
--
-- =====================================================================
-- THIS MIGRATION DELIBERATELY DOES **NOT** CHANGE THE PRIMARY KEY.
--
-- Plan §7.4 as written called for widening the ON CONFLICT target to
-- (hsh, userid, account_id), which -- since that target IS the primary key
-- (01-init.sql:22) -- means ALTER PRIMARY KEY and a full rewrite of a 384 GiB
-- table. That was investigated and REJECTED with evidence, approved 2026-08-17.
-- Recorded here because the absence of the rewrite is the load-bearing decision
-- in this file, and a future reader will otherwise "fix" it back.
--
-- WHY THE REWRITE IS UNNECESSARY. `hsh` is a STORED computed column:
--
--     hsh INT8 NOT NULL AS (fnv64a(content)) STORED     -- 01-init.sql:22
--
-- It hashes the ENTIRE content blob, and the account identifier is INSIDE that
-- blob in every shape -- `phone_number_id` (WhatsApp), `recipient.id`/`sender.id`
-- (Messenger), `page` (synthetic), and now also top-level `account_id`. So
-- (hsh, userid) is ALREADY transitively account-scoped: two events on two
-- different accounts cannot collide, because the bytes that distinguish the
-- accounts are among the bytes being hashed.
--
-- The only route to the cross-account row loss §7.4 feared is a genuine 64-bit
-- fnv64a collision between two DIFFERENT contents. And note what widening the
-- key would buy against that: it eliminates only the cross-account subset of
-- hash collisions and leaves same-account collisions -- the overwhelmingly
-- larger population, since 1,911 of 1,090,149 users (0.175%) have ever spanned
-- two accounts -- entirely untouched. It is not a coherent fix for hash
-- collisions; it is a 384 GiB rewrite that narrows an already-negligible risk by
-- a fraction. `SHOW STATISTICS` has reported distinct(hsh) == row_count at every
-- sample back to 2024 (101,118,611 / 101,118,611 at the latest).
--
-- Severity also differs from the tables migrations 27 and 28 rewrote. A dropped
-- `messages` row costs an event in replay. A dropped `responses` row WAS a
-- participant's answer. That asymmetry is why 28 was worth its cost and this is
-- not.
--
-- WHAT THE REWRITE WOULD HAVE COST (production, measured 2026-08-17):
--
--     messages   384.6 GiB   9089 ranges   106,275,818 rows
--     of which   primary                        128.2 GiB
--                messages_userid_timestamp_idx  128.2 GiB
--                messages_userid_idx            128.2 GiB  (NOT VISIBLE)
--
--     cluster    4 x 235.9 GiB, 413.7 GiB used, 127.4-133.7 GiB free per node
--
-- `range_size` is REPLICA-INCLUSIVE. Verified, not assumed: under the
-- per-replica reading `messages` alone would need ~960 GiB of physical disk
-- inside a cluster whose TOTAL used space is 413.7 GiB, which is impossible.
-- Under the replica-inclusive reading, 439.0 GiB of replicated logical across
-- chatroach compresses to the 413.7 GiB actually on disk (~0.94x) and the
-- cluster arithmetic closes to within 1%.
--
-- ALTER PRIMARY KEY rebuilds the primary index AND every secondary index, so
-- peak would have been +384.6 GiB replicated = +96 GiB/node against 127.4 GiB
-- free on the tightest node -- 75% of free space, held for gc.ttlseconds (25h)
-- afterwards. And account_id cannot be nullable in a primary key (SQLSTATE
-- 42P15, as migration 28 documents), so a COMPLETE backfill of all 106M rows
-- would have been mandatory FIRST, adding ~+128 GiB replicated of MVCC garbage
-- and taking the realistic peak past the free space on nodes 3 and 4.
--
-- What this file does instead peaks at +128.2 GiB replicated (+32 GiB/node, 25%
-- of free) for one index, and nets to roughly zero once migration 29 drops the
-- superseded index.
-- =====================================================================
--
-- CONSEQUENCES OF LEAVING THE KEY ALONE -- both are improvements:
--
--   1. NO DEPLOY ORDERING HAZARD. scribble/message.go keeps
--      `ON CONFLICT (hsh, userid)`, so old and new scribble both run against
--      both schemas, in either order. Contrast migrations 27/28, whose new
--      conflict targets raise 42P10 against the old schema and crash-loop
--      scribble (scribble.go, log.Fatalf). Nothing here needs a coordinated
--      schema-then-code deploy.
--
--   2. account_id STAYS NULLABLE, which is what makes the backfill incremental,
--      interruptible, and safe to run AFTER the read path ships rather than
--      before it. See "THE BACKFILL IS NOT A PREREQUISITE" below.
--
-- ORDERING vs MIGRATIONS 27 AND 28. Independent; either order works. Adding a
-- nullable, defaultless column is a metadata-only change in CockroachDB and
-- commutes with ALTER PRIMARY KEY. This matters because production applies
-- 27, 28, then 26, while both test paths apply them in lexical order --
-- facebot/testrunner/stack.ts (file by file) and devops/Makefile `test-db`
-- (`cat ./migrations/*.sql` into ONE session). Everything below is
-- `chatroach.`-qualified because that single-session path aborts every
-- subsequent migration on one unqualified name.
--
-- APPLY:
--   bash devops/run-migration.sh <namespace> migrations/26-messages-account.sql

-- =====================================================================
-- 1. The columns. Nullable, no DEFAULT -- metadata-only and instantaneous even
--    on 106M rows. A DEFAULT would force a full-table backfill here, which is
--    exactly what this migration is designed to avoid.
-- =====================================================================

ALTER TABLE chatroach.messages ADD COLUMN IF NOT EXISTS account_id VARCHAR;
ALTER TABLE chatroach.messages ADD COLUMN IF NOT EXISTS platform   VARCHAR;

-- responses and chat_log already carry the account as `pageid` (folded into
-- their primary keys by migrations 28 and 27). They lack only the platform.
--
-- Stored rather than derived, for both tables and for messages: `credentials`
-- cascades on user delete, so a deleted researcher would otherwise strip the
-- platform binding out of history (plan §3.1). Archival tables must not depend
-- on mutable current state to be interpretable.
--
-- NOTE: nothing writes these two columns yet. scribble/response.go and
-- scribble/chatlog.go read no platform from their message shapes, and chat_log
-- has had no producer at all since 2026-07-27. The columns land now because
-- adding them is free and because the chat-log producer restoration should not
-- also have to carry a migration.
ALTER TABLE chatroach.responses ADD COLUMN IF NOT EXISTS platform VARCHAR;
ALTER TABLE chatroach.chat_log  ADD COLUMN IF NOT EXISTS platform VARCHAR;

-- =====================================================================
-- 2. The access path for account-scoped replay.
--
--    chatbase.get() becomes
--      WHERE userid = $1 AND (account_id = $2 OR account_id IS NULL)
--      ORDER BY timestamp
--    so (userid, account_id, timestamp) is the exact key it wants.
--
--    STORING (content, platform) keeps it covering: get() selects `content`, and
--    without platform in the index an account-scoped read of the platform would
--    need an index join per row.
--
--    This is a plain CREATE INDEX -- an online, resumable, cancellable schema
--    change touching ONE index. If it goes wrong the partial index is dropped
--    and the primary index was never touched. Cost: +128.2 GiB replicated,
--    ~32 GiB/node, ~25% of free space.
--
--    BONUS: the join in get() becomes `USING (userid, account_id)`, an exact
--    prefix of this index, which should finally eliminate the `sort` node that
--    migrations 18 and 19 both had to write corrections about.
-- =====================================================================

CREATE INDEX IF NOT EXISTS messages_userid_account_timestamp_idx
  ON chatroach.messages (userid, account_id, timestamp ASC)
  STORING (content, platform);

-- =====================================================================
-- 3. Retire the superseded index as a CANARY, not a DROP.
--
--    messages_userid_timestamp_idx (userid, timestamp) STORING (content) is
--    strictly a prefix-weaker form of the index above. But this is the table
--    where migration 18 established the house pattern the hard way: make it
--    NOT VISIBLE, soak, drop in a separate phase. A visible index keeps serving
--    traffic, so the soak would prove nothing; NOT VISIBLE runs the true end
--    state while keeping revert to one instant, zero-rebuild statement:
--
--      ALTER INDEX chatroach.messages@messages_userid_timestamp_idx VISIBLE;
--
--    Migration 29 drops it after a clean soak. Until then both indexes are on
--    disk -- that is the +128.2 GiB peak, and it is the price of a reversible
--    cutover on the largest table in the system.
--
--    NOTE FOR SEQUENCING: migration 19 was never applied -- messages_userid_idx
--    is still on disk at visible=f, 128.2 GiB replicated of dead weight, armed
--    as a canary on 2026-07-22 and never phase-2'd. Applying 19 before this file
--    makes the whole change net disk-NEGATIVE. Escalated separately.
-- =====================================================================

ALTER INDEX chatroach.messages@messages_userid_timestamp_idx NOT VISIBLE;

-- =====================================================================
-- 4. THE BACKFILL IS NOT A PREREQUISITE -- and that is the point.
--
--    Migrations 27 and 28 had to guard against running before their backfills,
--    because `SET NOT NULL` genuinely could not proceed on un-backfilled data.
--    The equivalent guard is deliberately ABSENT here: nothing in this file
--    requires account_id to be populated, so the ordering is reversed. Schema
--    first, read path second, backfill last and at leisure:
--
--      1. this migration
--      2. the chatbase-postgres get() change (it TOLERATES NULL account_id)
--      3. bash devops/backfill-messages-account.sh <namespace>   -- resumable
--
--    Historical rows therefore replay exactly as they do today throughout the
--    backfill: no better, but no worse, and self-healing as it drains. Under a
--    strict `account_id = $2` read the same rows would replay as EMPTY, which is
--    the "every existing conversation replays as empty" catastrophe the plan
--    warns about -- converted from a sequencing risk into a guarantee, because
--    STATE_STORE_LIMIT=30000 with ORDER BY timestamp ASC means replay reads the
--    OLDEST 30k events, exactly the ones a partial backfill has not reached.
--
--    THE NULL-TOLERANT BRANCH IN get() IS TEMPORARY. Removal gate, exact:
--
--      -- rows that are still attributable but not yet attributed. Must be 0.
--      -- Full scan of 384 GiB; run it deliberately, not on a dashboard.
--      SELECT count(*) FROM chatroach.messages
--       WHERE account_id IS NULL
--         AND json_valid(content)
--         AND (<devops/sql/messages-account-id-expr.sql>) IS NOT NULL;
--
--      -- cheap coarse progress, same caveat about cost:
--      SELECT count(*) FROM chatroach.messages WHERE account_id IS NULL;
--
--    The coarse count never reaches zero and should not: ~0.0015% of rows are
--    synthetic events that carry no account at all (3 in a uniform 200,000-row
--    sample, so order 1,600 rows), plus any malformed content. Those are
--    permanently unattributable, and NULL is the honest answer. Only the first
--    query is the gate.
-- =====================================================================

-- =====================================================================
-- 5. Assert the primary key really is untouched.
--
--    scribble/message.go's ON CONFLICT (hsh, userid) depends on it, and the
--    rejected plan text asking for (hsh, userid, account_id) is still in
--    circulation. If someone applies that later, this fails loudly on the next
--    run rather than leaving a silently rewritten 384 GiB table. Mirrors the
--    closing assertion in migration 28.
-- =====================================================================

SELECT crdb_internal.force_error(
         'XXUUU',
         'messages has a unique index that is not exactly (hsh, userid): ' || index_name
       )
FROM (
  -- ORDER BY inside array_agg is load-bearing: without it the column order is
  -- unspecified and a correct key could compare unequal, turning this assertion
  -- into an intermittent false alarm.
  SELECT index_name, array_agg(column_name ORDER BY seq_in_index) AS cols
  FROM [SHOW INDEXES FROM chatroach.messages]
  WHERE non_unique = false AND storing = false AND implicit = false
  GROUP BY index_name
)
WHERE cols != ARRAY['hsh', 'userid']
LIMIT 1;
