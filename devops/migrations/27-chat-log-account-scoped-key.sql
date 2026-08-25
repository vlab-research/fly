-- 27-chat-log-account-scoped-key.sql
--
-- Make the chat_log row key the CONVERSATION, not the participant.
--
-- A conversation is (platform, account_id, user_id), not a user id. chat_log
-- was keyed PRIMARY KEY (userid, timestamp, direction) and scribble wrote
-- `ON CONFLICT (userid, timestamp, direction) DO NOTHING`, so when the same
-- person was in conversations on two of our messaging accounts, the second
-- account's message was not an error -- it was silently DISCARDED. At second
-- granularity this is the most exposed of the conflict keys: two bot messages
-- to the same participant in the same second on two different accounts collide.
--
-- Adding `pageid` to the ON CONFLICT target alone does NOT work, and both
-- failure modes were reproduced against CockroachDB v24.1.0:
--
--   1. Without a unique index covering exactly the new target columns, the
--      statement fails at runtime, not compile time:
--        ERROR: there is no unique or exclusion constraint matching the
--        ON CONFLICT specification (SQLSTATE 42P10)
--   2. Adding a bare UNIQUE INDEX while leaving the old PRIMARY KEY in place
--      is worse than the bug: the second account's row now passes the ON
--      CONFLICT arbiter, reaches the primary index, and raises
--        ERROR: duplicate key value violates unique constraint "chat_log_pkey"
--        (SQLSTATE 23505)
--      which fails scribble's whole batch instead of dropping one row.
--
-- So the PRIMARY KEY itself has to carry the account. Three consequences,
-- each verified on v24.1.0:
--
--   a. `pageid` must be NOT NULL -- "cannot use nullable column in primary
--      key" (SQLSTATE 42P15). Production holds 14,834 NULL-pageid chat_log
--      rows, so they are backfilled to the empty-string "account unknown"
--      sentinel rather than dropped, and scribble coerces nil to '' on the
--      write path for the same reason (scribble/chatlog.go accountOrUnknown).
--      Those NULLs are a separate live producer bug: replybot omitted the
--      account on ~0.9% of entries (395 of the last 43,824 rows written), and
--      whoever restores the producer -- see the dormancy note below -- must fix
--      that too, or it resumes at roughly 5k rows a month.
--      `states.pageid` is already `VARCHAR NOT NULL` inside its primary key --
--      this brings chat_log in line with the table that already keys on the
--      conversation.
--   b. `pageid` is APPENDED to the key rather than inserted in the middle, so
--      (userid, timestamp) remains an exact key prefix and every existing
--      access path keeps its locality.
--   c. ALTER PRIMARY KEY RETAINS THE OLD PRIMARY KEY AS A UNIQUE SECONDARY
--      INDEX. If it is not dropped, it re-imposes the exact constraint this
--      migration exists to remove -- the fix silently does nothing and inserts
--      fail 23505 on `chat_log_userid_timestamp_direction_key` instead. The
--      drop below is load-bearing, and the guard after it makes a rename or a
--      skipped drop fail loudly instead of shipping a no-op.
--
-- =====================================================================
-- SEQUENCING (decided 2026-08-17). Run BOTH migrations, THEN deploy once:
--
--     1. bash devops/run-migration.sh <ns> migrations/27-chat-log-account-scoped-key.sql
--     2. bash devops/backfill-responses-pageid.sh <ns>
--     3. bash devops/run-migration.sh <ns> migrations/28a-responses-account-scoped-key.sql
--     (then deploy scribble, verify, then 28b-responses-drop-old-unique-index.sql)
--     4. deploy the scribble build carrying both new ON CONFLICT targets
--
-- One scribble build changes BOTH chatlog.go and response.go, so a deploy
-- needs both migrations applied. Do not apply 27 alone and defer the deploy:
-- the old code's three-column target no longer matches any unique index once
-- this runs, so it also raises 42P10 -- and because chat_log currently takes
-- zero writes (see COST), that mismatch is INVISIBLE until someone restores
-- the producer, at which point the sink crash-loops. Creating a landmine that
-- only detonates on someone else's unrelated change is the exact failure class
-- this whole effort exists to remove.
--
-- The window does not close on its own; it closes when the producer is
-- restored, and we control that. So the producer restoration is BLOCKED on
-- this work landing rather than raced against it. See
-- documentation/chat-message-logging.md.
--
-- ORDERING within that plan: schema before code, always. The new ON CONFLICT
-- target raises 42P10 against the old schema, and scribble treats every write
-- error as fatal (scribble.go:36-39, log.Fatalf), so shipping the code first is
-- a crash loop rather than a degradation.
-- =====================================================================
--
-- COST: cheap -- 2.91 GiB across 65 ranges -- and cheaper right now than it
-- will ever be again. chat_log is
-- 1,479,724 rows and is currently taking ZERO writes -- its producer,
-- replybot/lib/chat-log/publisher.js, was deleted as collateral damage in
-- 675c31bd (2026-07-17, the UniversalEvent refactor) and reached production
-- around replybot-v0.0.211-wa; the last row landed 2026-07-27. So this runs
-- against a quiescent table: no write contention, no backfill racing a
-- producer, and no chance of a poison batch hitting log.Fatalf mid-migration.
--
-- The dormancy is an accident, not a decision -- the dashboard still offers
-- "Create Chat Log Export" and the exporter still serves it, so the producer
-- will come back. That is exactly why this ships now: the account scoping has
-- to already be in place when it does. July 2026 was the table's highest-volume
-- month ever (606,187 rows) and still accelerating when writes stopped, so the
-- same migration after the producer returns is a materially bigger operation.
--
-- BEFORE RESTORING replybot/lib/chat-log/publisher.js: migration 27 AND the
-- scribble build carrying ON CONFLICT(userid, pageid, timestamp, direction)
-- must both already be deployed. Deploying the producer against the old
-- scribble build crash-loops the chat-log sink. The producer must also stamp
-- the messaging account on every entry -- the deleted one omitted it on ~0.9%
-- of writes, and pageid is part of the primary key now.

UPDATE chatroach.chat_log SET pageid = '' WHERE pageid IS NULL;

-- NOT NULL, and deliberately NO DEFAULT.
--
-- The '' sentinel is for rows whose account was genuinely never recorded: the
-- historical backfill above, and scribble's explicit nil coercion. Both are
-- documented decisions about a known, measured producer gap.
--
-- A column DEFAULT is a different thing. It applies to future INSERTs, so it
-- would silently hand "account unknown" to any writer that merely forgot the
-- column. Given that this migration exists precisely because account attribution
-- was going wrong SILENTLY, an omitting writer should get a loud 23502 instead.
-- `states.pageid` -- the table that already keys on the conversation -- is
-- likewise NOT NULL with no default.
ALTER TABLE chatroach.chat_log ALTER COLUMN pageid SET NOT NULL;

ALTER TABLE chatroach.chat_log
  ALTER PRIMARY KEY USING COLUMNS (userid, timestamp, direction, pageid);

-- See (c): this is the old primary key, kept by ALTER PRIMARY KEY as a UNIQUE
-- index. Dropping it is what actually lets two accounts coexist.
DROP INDEX IF EXISTS chatroach.chat_log@chat_log_userid_timestamp_direction_key CASCADE;

-- Fail loudly if any unique index other than the new primary key survives --
-- that index would silently reinstate the bug.
SELECT crdb_internal.force_error(
         'XXUUU',
         'chat_log still has a unique index that excludes pageid: ' || index_name
       )
FROM [SHOW INDEXES FROM chatroach.chat_log]
WHERE non_unique = false AND index_name != 'chat_log_pkey'
LIMIT 1;
