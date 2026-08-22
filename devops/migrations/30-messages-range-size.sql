-- Cap the range size on chatroach.messages so its index backfills fit in memory.
--
-- APPLY: bash devops/run-migration.sh <namespace> migrations/30-messages-range-size.sql
--
-- WHY THIS EXISTS -- AND WHAT IT IS *NOT*.
--
-- CORRECTED 2026-08-22. An earlier version of this header claimed the range size
-- was why migration 26's CREATE INDEX could not complete, on the theory that the
-- backfiller materializes a range at a time and a 288-467 MB range could not fit
-- a 250MiB SQL pool. THAT WAS WRONG, and it was wrong in a way worth recording:
-- the same failure recurred unchanged after the pool was raised to 1GiB, with the
-- allocation simply growing to fill the larger pool. Range size was never the
-- binding constraint.
--
-- The real cause was `bulkio.index_backfill.batch_size` (stock 50000) against
-- 35 KB rows -- ~1.75 GB of index entries per batch, which overflows any pool --
-- combined with the declarative schema changer ignoring that setting. See the
-- apply instructions at the head of 26-messages-account.sql.
--
-- SO WHY KEEP THIS FILE? Because 512 MiB ranges are still wrong for this table on
-- their own terms. `messages` rows average 34.8 KB and reach 351 KB, so stock
-- settings produced ranges of 288-467 MB -- large enough that any single-range
-- operation is a memory spike, and large enough to make rebalancing coarse. 64
-- MiB is the appropriate size for a table this shaped. It is a sound change
-- being kept for a sound reason, not the fix it was originally written up as.
--
-- It was first set BY HAND while debugging. This file exists so it stops being
-- invisible live state.
--
ALTER TABLE chatroach.messages
  CONFIGURE ZONE USING range_max_bytes = 67108864, range_min_bytes = 16777216;

-- Restore the stock GC TTL. It was lowered to 600s by hand on 2026-08-22 to force
-- prompt reclaim of the indexes migration 18 dropped; that was a one-off and must
-- not linger, since a short TTL shrinks the AS OF SYSTEM TIME window and the
-- protected window for incremental backups.
ALTER TABLE chatroach.messages CONFIGURE ZONE USING gc.ttlseconds = 14400;

-- VERIFY:
--   SHOW ZONE CONFIGURATION FOR TABLE chatroach.messages;
--   SELECT count(*) AS ranges, round(max(range_size)/1024.0/1024,0) AS max_mb
--     FROM [SHOW RANGES FROM TABLE chatroach.messages WITH DETAILS];
