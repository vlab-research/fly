/*
 * Migration 29 (PHASE 2 of 2): drop the messages_userid_timestamp_idx canary
 *
 * Phase 1 was migration 26, which built messages_userid_account_timestamp_idx
 * and retired this index as a CANARY -- NOT VISIBLE, still on disk, restorable
 * with one instant statement. This phase deletes it for good.
 *
 * This is the same two-step shape as migrations 18 -> 19, one index later:
 *
 *   migration 18   messages_userid_idx            -> NOT VISIBLE   (canary)
 *   migration 19   messages_userid_idx            -> DROP
 *   migration 26   messages_userid_timestamp_idx  -> NOT VISIBLE   (canary)
 *   migration 29   messages_userid_timestamp_idx  -> DROP          (this file)
 *
 * WHY IT IS SAFE. The survivor is a strict superset for the read path.
 *
 *   | index                                  | keyed on                        | stores            |
 *   |----------------------------------------|---------------------------------|-------------------|
 *   | messages_userid_timestamp_idx (dropped)| (userid, timestamp, hsh)        | content           |
 *   | messages_userid_account_timestamp_idx  | (userid, account_id, timestamp) | content, platform |
 *
 * Both are prefixed on `userid` and both cover `content`, so no read that this
 * index served becomes an index join. The survivor additionally scopes by
 * account, which is the entire point of the conversation-identity work: replay
 * must be able to tell one participant's two conversations apart.
 *
 * The account-scoped read tolerates NULL account_id (the `OR account_id IS NULL`
 * branch in chatbase.get()), so this drop does NOT depend on `devops/backfill`
 * having run. It is the other way round -- see IMPACT.
 *
 * PRECONDITION CHECKS. The two below are enforced in SQL and abort the
 * migration; verify the third by hand.
 *
 *   1. messages_userid_account_timestamp_idx exists and is VISIBLE.
 *   2. No schema-change job is still building it. (CREATE INDEX returns when the
 *      JOB IS CREATED, not when the backfill finishes -- migration 26's header
 *      documents this trap at length.)
 *   3. Soak: the hot path has been served by the replacement, with replybot
 *      latency and error rate unchanged. Check the plan uses the new index:
 *        EXPLAIN SELECT content FROM chatroach.messages
 *         WHERE userid = '<real-userid>' AND (account_id = '<acct>' OR account_id IS NULL)
 *         ORDER BY timestamp ASC;
 *
 * A NOTE ON WHAT THE SOAK PROVES -- read before trusting it. NOT VISIBLE stops
 * the optimizer *choosing* an index; explicit hints,
 * `optimizer_use_not_visible_indexes`, and constraint checks can still reach it.
 * Migration 19's canary was read ~5,700/day in production for weeks while
 * nominally dark (§5.1d). Confirm this one actually went quiet rather than
 * assuming NOT VISIBLE did it:
 *
 *   SELECT ti.index_name, ius.total_reads, ius.last_read
 *     FROM crdb_internal.index_usage_statistics ius
 *     JOIN crdb_internal.table_indexes ti
 *       ON ti.descriptor_id = ius.table_id AND ti.index_id = ius.index_id
 *    WHERE ti.descriptor_name = 'messages';
 *
 * On vstag 2026-08-22 this index read total_reads = 0, last_read = NULL, against
 * 20 reads on its replacement -- it did go dark here. Re-measure on production.
 *
 * IMPACT, and why this migration GATES the backfill. `messages` has no column
 * families, so writing account_id rewrites the WHOLE row -- `content` included --
 * into every secondary index. `devops/backfill` therefore churns roughly a full
 * copy of the table through MVCC, held for gc.ttlseconds. Dropping this index
 * cuts that write amplification from 4 indexes to 3 AND frees the space to
 * absorb it. On vstag the four indexes are near-equal in size (5,527-5,574 MB
 * logical each of a 22,111 MB table, measured 2026-08-23), so this reclaims
 * about a quarter of the table.
 *
 * RECLAIM IS NOT IMMEDIATE. Space returns only after gc.ttlseconds -- 14400s
 * (4h) on vstag, 90000s (25h) on production, both table-level and verified
 * 2026-08-22. Do not queue the backfill against a `df` taken straight after this
 * runs; wait out the window and re-check:
 *   kubectl exec -n <ns> gbv-cockroachdb-0 -- df -h /cockroach/cockroach-data
 *
 * SAFETY: DROP INDEX is an online schema change; it does not block reads or
 * writes. Idempotent (IF EXISTS), and the guards are inert on a re-run.
 *
 * APPLY -- do NOT use devops/run-migration.sh. Its `kubectl run -i --rm` client
 * loses its websocket and prints `ERROR: Migration failed` over SQL that
 * COMMITTED. Verify against the schema, never against the exit code.
 *
 *   kubectl exec -i -n <ns> gbv-cockroachdb-0 -- ./cockroach sql --insecure \
 *     --database=chatroach < devops/migrations/29-drop-superseded-messages-index.sql
 */

-- GUARD 1: refuse if the replacement is missing or not serving traffic. Dropping
-- this index without a visible successor leaves replay on a primary-key scan of
-- the whole table.
SELECT crdb_internal.force_error(
         'XXUUU',
         'messages_userid_account_timestamp_idx is missing or NOT VISIBLE; refusing '
         || 'to drop its predecessor. Apply migration 26 first.'
       )
FROM (
  SELECT count(*) AS n
  FROM [SHOW INDEXES FROM chatroach.messages]
  WHERE index_name = 'messages_userid_account_timestamp_idx' AND visible
)
WHERE n = 0;

-- GUARD 2: refuse while that replacement is still backfilling. Same failure mode
-- migration 26 guards against, and the same reason: an in-flight CREATE INDEX
-- reports nothing useful through SQL, so an unguarded drop here would leave both
-- secondary access paths unusable at once.
SELECT crdb_internal.force_error(
         'XXUUU',
         'messages_userid_account_timestamp_idx is still building; refusing to drop '
         || 'its predecessor. Wait for: ' || description
       )
FROM crdb_internal.jobs
WHERE job_type IN ('SCHEMA CHANGE', 'NEW SCHEMA CHANGE')
  AND status NOT IN ('succeeded', 'failed', 'canceled')
  AND description LIKE '%messages_userid_account_timestamp_idx%'
LIMIT 1;

DROP INDEX IF EXISTS chatroach.public.messages@messages_userid_timestamp_idx;

/*
 * VERIFY AFTER (schema): messages_userid_timestamp_idx is gone.
 *   SHOW INDEXES FROM chatroach.public.messages;
 *
 * Expected remaining, in the order this rollout leaves them:
 *   primary                                (hsh, userid)
 *   messages_userid_account_timestamp_idx  visible   -- the read path
 *   messages_userid_idx                    NOT VISIBLE -- migration 19's canary,
 *                                          still pending; unrelated to this file.
 *
 * ROLLBACK (recreate -- re-scans the full table; NOT instant, unlike re-arming a
 * canary. On vstag it needs migration 26's two settings TOGETHER or it wedges
 * silently at fraction_completed = 0 with an empty error column):
 *   SET use_declarative_schema_changer = 'off';
 *   SET CLUSTER SETTING bulkio.index_backfill.batch_size = 200;  -- vstag; ~10000 on prod
 *   CREATE INDEX messages_userid_timestamp_idx
 *     ON chatroach.public.messages (userid, timestamp ASC) STORING (content);
 *   RESET CLUSTER SETTING bulkio.index_backfill.batch_size;
 *
 * Prefer rolling FORWARD if the read path regresses: the replacement is a strict
 * superset, so a regression here is a query-plan problem, not a missing-index one.
 */
