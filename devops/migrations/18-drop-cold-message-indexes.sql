/*
 * Migration 18 (PHASE 1 of 2): drop cold message indexes + arm the userid canary
 *
 * ==========================================================================
 * APPLIED 2026-07-22. VERIFIED AGAINST PROD 2026-07-26: schema correct,
 * physical usage ~596 GB -> ~407 GiB, GC settled. Outcome was as intended.
 *
 * ONE COMMENT BELOW IS WRONG — see "so no sort" in the Phase 1 notes and the
 * SOAK CHECKLIST. The real read path (chatbase-postgres/lib/index.js:21-37)
 * LEFT JOINs `states` for the message_pointer checkpoint; that merge join
 * destroys timestamp ordering, so the plan DOES contain a `sort` node. The
 * decision to keep messages_userid_timestamp_idx is still correct — the
 * alternative is keyed (userid, hsh) and would sort too. Corrected in full in
 * migration 19 and documentation/cockroachdb-storage.md.
 * ==========================================================================
 *
 * Part of a two-phase index cleanup on chatroach.messages. See
 * documentation/cockroachdb-storage.md for full context and measurements
 * (prod 2026-07-22, CRDB v24.1.28, RF3). `content` (raw event JSON) is STORED in
 * every secondary index, so each index is a near-full copy of the table (~131.6
 * GiB each). Target end state: keep only `primary` + `messages_userid_timestamp_idx`.
 *
 * THIS PHASE does two things:
 *
 * 1. DROP the two global time-ordered indexes. They are used ONLY by the manual
 *    full-replay tool (replybot/lib/responses/batch.js via
 *    replybot/kube-scratch/batchscratch.yaml), which is NOT in the prod Helm
 *    release (scratchbot: false). No running prod workload depends on them
 *    (25 / 6 lifetime reads). Frees ~263 GiB logical after GC.
 *
 * 2. ARM THE CANARY: make messages_userid_idx NOT VISIBLE instead of dropping it.
 *    The hot path (state recompute on Redis miss:
 *      SELECT * FROM messages WHERE userid=$1 ORDER BY timestamp ASC)
 *    is then forced onto messages_userid_timestamp_idx (keyed (userid, timestamp),
 *    so no sort — this is already the optimizer's natural choice; EXPLAIN verified).
 *    messages_userid_idx stays on disk as an INSTANTLY-restorable safety net:
 *      ALTER INDEX chatroach.public.messages@messages_userid_idx VISIBLE;
 *    Phase 2 (migration 19) drops it for good after a few days of clean soak.
 *
 * WHY NOT VISIBLE (not just "leave it"): a visible index would keep serving traffic,
 * so the soak would prove nothing about life without it. NOT VISIBLE makes the soak
 * run the true end state while keeping revert to a one-line, zero-rebuild operation.
 *
 * SOAK CHECKLIST (watch for a few days before running migration 19):
 *   - Hot query plan uses messages_userid_timestamp_idx, no `sort` node:
 *       EXPLAIN SELECT * FROM messages WHERE userid='<real-userid>' ORDER BY timestamp ASC;
 *   - replybot state-recompute latency / error rate unchanged (Grafana/Prometheus).
 *   - No unexpected full scans or slow queries in the CRDB console.
 *   - After > gc.ttlseconds (90000s / 25h): per-pod disk drops ~263 GiB worth:
 *       kubectl -n vprod exec gbv-cockroachdb-0 -- df -h /cockroach/cockroach-data
 *   If anything regresses: ALTER INDEX ...@messages_userid_idx VISIBLE;  (instant)
 *
 * SAFETY: DROP INDEX / ALTER INDEX VISIBILITY are online schema changes; they do
 * not block reads or writes. Statements are ordered so each settles before the next.
 * Idempotent (IF EXISTS).
 *
 * APPLY:
 *   ./devops/run-prod-migration.sh devops/migrations/18-drop-cold-message-indexes.sql
 */

-- Global time-ordered covering index; manual batch-replay tool only.
DROP INDEX IF EXISTS chatroach.public.messages@messages_timestamp_idx;

-- Second global time-ordered (DESC) covering index; also batch-replay only.
DROP INDEX IF EXISTS chatroach.public.messages@messages_timestamp_idx1;

-- Canary: keep on disk, remove from the serving path. Restore with VISIBLE if needed.
ALTER INDEX chatroach.public.messages@messages_userid_idx NOT VISIBLE;

/*
 * VERIFY AFTER (schema): three indexes remain — primary + messages_userid_timestamp_idx
 * (visible) + messages_userid_idx (NOT VISIBLE, `visible=f`):
 *   SHOW INDEXES FROM chatroach.public.messages;
 *
 * ROLLBACK THIS PHASE:
 *   -- restore the canary to the serving path (instant, no rebuild):
 *   ALTER INDEX chatroach.public.messages@messages_userid_idx VISIBLE;
 *   -- recreate the timestamp indexes (each re-scans the full table, ~131 GiB):
 *   CREATE INDEX messages_timestamp_idx  ON chatroach.public.messages (timestamp ASC)  STORING (content);
 *   CREATE INDEX messages_timestamp_idx1 ON chatroach.public.messages (timestamp DESC) STORING (content);
 */
