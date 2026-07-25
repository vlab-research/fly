'use strict';

/**
 * States Queries
 *
 * Queries the states table scoped to a (email, survey_name). Because the
 * states table only carries `current_form` (the shortcode), and a single
 * shortcode can belong to multiple survey_names under the same owner — with
 * different historical versions — version resolution is done at query time
 * via a LATERAL join: for each state row, find the surveys row owned by this
 * user with matching shortcode and the latest `created <= form_start_time`.
 * That row's `survey_name` determines whether the state belongs to the
 * survey being monitored.
 *
 * Performance note: the controller pre-collects all shortcodes the owner
 * uses under this survey_name (and any sibling survey_names that share a
 * shortcode — i.e. anything that could possibly match) and passes them in
 * as $3. The pre-filter `current_form = ANY($3)` prunes states down to a
 * tiny candidate set using the `states (current_state, current_form, ...)`
 * indexes before the lateral fires; the lateral then only disambiguates
 * versions on those candidate rows. Without that pre-filter the lateral
 * runs against every row in `states`.
 *
 * Notes:
 *  - State rows with NULL form_start_time (user hasn't started a form yet)
 *    are intentionally excluded — nothing to monitor yet.
 *  - Killed versions (off_time set) are intentionally NOT filtered out:
 *    historical truth — a user on a now-killed version still belongs to
 *    whichever survey_name owned that version when they started.
 *  - Canonical resolution rule lives in formcentral (shortcode + timestamp
 *    -> surveyid). This SQL mirrors it; keep in sync if that rule changes.
 *  - Account ID lookup is platform-agnostic: credentials.key holds the
 *    platform account ID (page_id for Messenger, phone_number_id for WhatsApp)
 *    filtered by entity type. Served index-only by unique_messaging_account.
 */

// Pre-filter on shortcode (uses states indexes) + scalar-subquery version
// resolution. Params: $1 email, $2 surveyName, $3 shortcodes (string[]).
//
// We use a scalar subquery (rather than `JOIN LATERAL`) because CockroachDB's
// planner rewrites the LATERAL form into a surveys×states cross product that
// scanned ~1M KV rows and ran in ~46s for a real survey (28 versions, 14
// shortcodes). The scalar form is evaluated per state row and runs in ~5s
// on the same input. Both forms are semantically equivalent — same result
// set verified against production.
//
// `detail` uses the same shape but is fast either way — the userid = $4
// filter reduces to a single row, so resolution only runs once per call.
const SCOPE_SQL = `
  FROM states
  WHERE states.current_form = ANY($3)
    AND states.pageid IN (
      SELECT credentials.key
      FROM credentials
      JOIN users u ON credentials.userid = u.id
      WHERE u.email = $1
        AND credentials.entity IN ('facebook_page', 'whatsapp_business')
    )
    AND (
      SELECT s.survey_name
      FROM surveys s
      JOIN users u ON s.userid = u.id
      WHERE u.email = $1
        AND s.shortcode = states.current_form
        AND s.created <= states.form_start_time
      ORDER BY s.created DESC
      LIMIT 1
    ) = $2
`;

async function summary(email, surveyName, shortcodes) {
  const query = `
    SELECT
      states.current_state,
      states.current_form,
      COUNT(*)::int as count
    ${SCOPE_SQL}
    GROUP BY states.current_state, states.current_form
    ORDER BY states.current_state, states.current_form
  `;

  const { rows } = await this.query(query, [email, surveyName, shortcodes]);
  const summary = rows.map(row => ({
    ...row,
    count: parseInt(row.count, 10),
  }));
  return { summary };
}

async function list(email, surveyName, shortcodes, { state, errorTag, form, search, limit = 50, offset = 0 } = {}) {
  let extraConditions = [];
  let params = [email, surveyName, shortcodes];
  let paramIndex = 4;

  if (state) {
    extraConditions.push(`states.current_state = $${paramIndex}`);
    params.push(state);
    paramIndex++;
  }

  if (errorTag) {
    extraConditions.push(`states.error_tag ILIKE $${paramIndex}`);
    params.push(`%${errorTag}%`);
    paramIndex++;
  }

  if (form) {
    extraConditions.push(`states.current_form = $${paramIndex}`);
    params.push(form);
    paramIndex++;
  }

  if (search) {
    extraConditions.push(`states.userid LIKE $${paramIndex}`);
    params.push(`%${search}%`);
    paramIndex++;
  }

  const extraWhere = extraConditions.length ? `AND ${extraConditions.join(' AND ')}` : '';

  const listQuery = `
    SELECT
      states.userid,
      states.pageid,
      states.current_state,
      states.current_form,
      states.updated,
      states.error_tag,
      states.stuck_on_question,
      states.timeout_date,
      states.form_start_time
    ${SCOPE_SQL}
    ${extraWhere}
    ORDER BY states.updated DESC
    LIMIT $${paramIndex}
    OFFSET $${paramIndex + 1}
  `;

  const countQuery = `
    SELECT COUNT(*)::int as total
    ${SCOPE_SQL}
    ${extraWhere}
  `;

  const [listResult, countResult] = await Promise.all([
    this.query(listQuery, [...params, limit, offset]),
    this.query(countQuery, params),
  ]);

  return {
    states: listResult.rows,
    total: countResult.rows[0].total,
  };
}

// Window for the dashboard Health card. Distinct from sql_exporter's 1h
// alerting window: alerting cares about "now"; the card covers "since I
// last looked". The states table is current-state per user (sticky until
// the user recovers), so the updated filter scopes the card to now-ish and
// ages out ancient testing noise.
const HEALTH_WINDOW_HOURS = 24;

// KEEP IN SYNC with the state machine (botserver-core). Every current_state
// value that can appear in the states table must be listed here — the
// health query constrains on this list so CockroachDB can build tight
// (current_state, updated > t) index spans instead of scanning every
// historical row for the survey's shortcodes (measured on prod: 124ms vs
// ~4s / 144MiB KV read without the constraint; there is no index leading
// with current_form+updated, and the team intentionally keeps the hot
// states table's index count down). A state missing from this list is
// INVISIBLE to the health card — silently excluded from counts and the
// active_users denominator — so treat additions to the state machine as
// requiring an update here.
const STATE_MACHINE_STATES = [
  'START',
  'RESPONDING',
  'QOUT',
  'END',
  'BLOCKED',
  'ERROR',
  'WAIT_EXTERNAL_EVENT',
  'USER_BLOCKED',
  'RESET',
  'OFF',
];

// One grouped round-trip feeding the health aggregate bag (see
// api/health/aggregate.js). The CASE bucketing mirrors the taxonomy
// contract in documentation/study-error-alerting.md — the sql_exporter
// ConfigMap (devops/sql-exporter/templates/configmap.yaml) is the other
// consumer; keep both in sync with the contract.
//
// Each state row lands in exactly one (form, state, error_tag,
// fb_category) group; stuck/expired are FILTER counts within the group so
// the fold can sum them independently of the grouping dimensions.
async function healthSummary(email, surveyName, shortcodes) {
  const query = `
    SELECT
      states.current_form AS form,
      states.current_state AS state,
      COALESCE(states.error_tag, 'none') AS error_tag,
      CASE
        WHEN states.fb_error_code IN ('10','190','551') THEN 'attrition'
        WHEN states.fb_error_code = '100'  THEN 'template_missing'
        WHEN states.fb_error_code = '2022' THEN 'rate_limit'
        WHEN states.fb_error_code = '200'  THEN 'unsupported'
        ELSE 'other'
      END AS fb_category,
      COUNT(*) FILTER (WHERE states.stuck_on_question IS NOT NULL)::int AS stuck,
      COUNT(*) FILTER (WHERE states.current_state = 'WAIT_EXTERNAL_EVENT'
                         AND states.timeout_date < NOW())::int AS expired,
      COUNT(*)::int AS count
    ${SCOPE_SQL}
      AND states.current_state = ANY($4)
      AND states.updated > NOW() - INTERVAL '${HEALTH_WINDOW_HOURS} hours'
    GROUP BY 1, 2, 3, 4
  `;

  const { rows } = await this.query(query, [
    email,
    surveyName,
    shortcodes,
    STATE_MACHINE_STATES,
  ]);
  return rows;
}

async function detail(email, surveyName, shortcodes, userid) {
  const query = `
    SELECT
      states.userid,
      states.pageid,
      states.updated,
      states.current_state,
      states.current_form,
      states.form_start_time,
      states.error_tag,
      states.fb_error_code,
      states.stuck_on_question,
      states.timeout_date,
      states.next_retry,
      states.payment_error_code,
      states.previous_is_followup,
      states.previous_with_token,
      states.state_json
    ${SCOPE_SQL}
    AND states.userid = $4
    LIMIT 1
  `;

  const { rows } = await this.query(query, [email, surveyName, shortcodes, userid]);
  return rows.length > 0 ? rows[0] : null;
}

module.exports = {
  name: 'States',
  HEALTH_WINDOW_HOURS,
  queries: pool => ({
    summary: summary.bind(pool),
    list: list.bind(pool),
    detail: detail.bind(pool),
    healthSummary: healthSummary.bind(pool),
  }),
};
