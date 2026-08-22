/*
 * Migration 19 (PHASE 2 of 2): drop the messages_userid_idx canary
 *
 * Run ONLY after migration 18 has soaked cleanly for a few days (see the SOAK
 * CHECKLIST in 18-drop-cold-message-indexes.sql). Migration 18 made this index
 * NOT VISIBLE, so production has already been serving the hot path from
 * messages_userid_timestamp_idx without it. This phase deletes it to reclaim disk.
 *
 * PRECONDITION CHECK (must pass before running):
 *   - SHOW INDEXES FROM chatroach.public.messages;
 *       messages_userid_idx should show visible=f (NOT VISIBLE) from migration 18.
 *       [VERIFIED 2026-07-26 — correct.]
 *   - The hot query plan scans messages_userid_timestamp_idx.
 *   - replybot latency / error rate unchanged over the soak window.
 *
 *   -- CORRECTED 2026-07-26 --------------------------------------------------
 *   This check previously read "...with no `sort` node". That was WRONG and would
 *   have failed. It was EXPLAINed against a simplified query. The real read path
 *   (chatbase-postgres/lib/index.js:21-37) LEFT JOINs `states` for the
 *   message_pointer checkpoint; the merge join on userid destroys the timestamp
 *   ordering, so a `sort` node IS present and IS expected. It is not a regression:
 *   messages_userid_idx is keyed (userid, hsh) and would sort too, no better.
 *   Use this to check the plan:
 *     EXPLAIN SELECT * FROM messages
 *       LEFT JOIN (SELECT userid, message_pointer FROM states WHERE userid='<id>')
 *         USING (userid)
 *       WHERE userid='<id>'
 *       AND (message_pointer IS NULL OR message_pointer <= timestamp)
 *       ORDER BY timestamp ASC;
 *   --------------------------------------------------------------------------
 *
 *   -- ADDITIONAL PRECONDITIONS ADDED 2026-07-26 ------------------------------
 *   1. Ship the `SELECT *` -> `SELECT content` change in
 *      @vlab-research/chatbase-postgres FIRST. While `SELECT *` remains, EXPLAIN
 *      emits an index recommendation to CREATE the exact index this migration
 *      drops (it wants `id`, which lives only in `primary`). get() discards `id`.
 *   2. Fix the CockroachDB replica co-location risk first — two CRDB pods share
 *      one GKE node. See planning/cockroachdb-memory-and-topology-plan.md Part 0.
 *   --------------------------------------------------------------------------
 *
 * If any check fails, STOP and re-arm instead:
 *   ALTER INDEX chatroach.public.messages@messages_userid_idx VISIBLE;
 *
 * IMPACT: frees the final ~131.6 GiB logical. Combined with migration 18, the
 * messages table drops from 5 content-storing indexes to 2 (~60% smaller). Disk
 * reclaims after gc.ttlseconds (90000s / 25h) — verify with df before shrinking
 * PVCs/nodes (Tier 4).
 *
 * SAFETY: online schema change; does not block reads/writes. Idempotent (IF EXISTS).
 *
 * APPLY:
 *   ./devops/run-prod-migration.sh devops/migrations/19-drop-message-userid-idx.sql
 */

DROP INDEX IF EXISTS chatroach.public.messages@messages_userid_idx;

/*
 * VERIFY AFTER (schema): only primary + messages_userid_timestamp_idx remain.
 *   SHOW INDEXES FROM chatroach.public.messages;
 *
 * ROLLBACK (recreate — re-scans the full table, ~131 GiB):
 *   CREATE INDEX messages_userid_idx
 *     ON chatroach.public.messages (userid) STORING (content, timestamp);
 */
