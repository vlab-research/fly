/*
 * Migration 22: covering index on chatroach.surveys for shortcode -> survey_name
 *
 * WHY
 * ---
 * The sql_exporter study-health metrics resolve a form's shortcode to its study name
 * (`surveys.survey_name`) so the Grafana boards and alerts can say "Kenya Girl Effect"
 * instead of "placebo". That lookup is:
 *
 *     SELECT survey_name FROM surveys WHERE shortcode = $1 ORDER BY created DESC LIMIT 1
 *
 * There IS an index on (shortcode, userid, created) -- but it does NOT store
 * `survey_name`, so the optimizer cannot answer from it and falls back to scanning
 * `surveys@primary`. Measured on prod 2026-07-26 with EXPLAIN ANALYZE:
 *
 *     table: surveys@primary
 *     spans: FULL SCAN
 *     KV bytes read: 300 MiB      <-- per scrape, every 60s (~430 GB/day)
 *
 * 300 MiB for 5,059 rows because `surveys@primary` carries the big `form_json` /
 * `messages_json` / `translation_conf` columns. The scan reads them all to fetch one
 * varchar.
 *
 * This is about to get much worse: the core visibility work
 * (planning/core-visibility-alerting-plan.md, W1) adds the same study lookup to five
 * more 1h metrics. Without this index that is ~6x300 MiB per minute. This migration is
 * an explicit PRECONDITION for that work.
 *
 * WHAT
 * ----
 * A covering index keyed (shortcode, created DESC) storing survey_name. Key order
 * matches the query exactly -- `shortcode` equality then `created DESC` -- so the
 * `ORDER BY created DESC LIMIT 1` is answered by reading the first row of the span,
 * with no sort and no index join back to primary.
 *
 * SAFETY
 * ------
 * - `surveys` is small (5,059 rows) and cold on writes: rows are inserted when a study
 *   is created or edited, not on the message path. This is nothing like the write
 *   amplification concern that governs `states` (see documentation/cockroachdb-storage.md).
 * - CREATE INDEX is an online schema change in CockroachDB: no table lock, no downtime.
 * - Purely additive. Nothing is dropped and no existing plan is invalidated -- the
 *   optimizer gains an option. Rollback is a plain DROP INDEX (see below).
 * - IF NOT EXISTS makes this re-runnable.
 *
 * VERIFY (after applying)
 * -----------------------
 *   EXPLAIN ANALYZE
 *   SELECT survey_name FROM chatroach.surveys
 *   WHERE shortcode = 'placebo' ORDER BY created DESC LIMIT 1;
 *
 *   Expect: surveys@surveys_shortcode_created_survey_name_idx, NO "FULL SCAN",
 *   KV bytes read in KiB rather than MiB.
 *
 *   Then re-EXPLAIN the exporter's survey_recent_states query and confirm the
 *   `surveys@primary FULL SCAN` line is gone.
 *
 * ROLLBACK
 * --------
 *   DROP INDEX chatroach.surveys@surveys_shortcode_created_survey_name_idx;
 */

CREATE INDEX IF NOT EXISTS surveys_shortcode_created_survey_name_idx
  ON chatroach.surveys (shortcode, created DESC)
  STORING (survey_name);
