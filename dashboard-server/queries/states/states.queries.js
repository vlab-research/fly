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
 * Notes:
 *  - State rows with NULL form_start_time (user hasn't started a form yet)
 *    are intentionally excluded — nothing to monitor yet.
 *  - Killed versions (off_time set) are intentionally NOT filtered out:
 *    historical truth — a user on a now-killed version still belongs to
 *    whichever survey_name owned that version when they started.
 *  - Canonical resolution rule lives in formcentral (shortcode + timestamp
 *    -> surveyid). This SQL mirrors it; keep in sync if that rule changes.
 */

const RESOLVE_VERSION_SQL = `
  JOIN LATERAL (
    SELECT s.survey_name
    FROM surveys s
    JOIN users u ON s.userid = u.id
    WHERE u.email = $1
      AND s.shortcode = states.current_form
      AND s.created <= states.form_start_time
    ORDER BY s.created DESC
    LIMIT 1
  ) v ON v.survey_name = $2
`;

async function summary(email, surveyName) {
  const query = `
    SELECT
      states.current_state,
      states.current_form,
      COUNT(*)::int as count
    FROM states
    ${RESOLVE_VERSION_SQL}
    GROUP BY states.current_state, states.current_form
    ORDER BY states.current_state, states.current_form
  `;

  const { rows } = await this.query(query, [email, surveyName]);
  const summary = rows.map(row => ({
    ...row,
    count: parseInt(row.count, 10),
  }));
  return { summary };
}

async function list(email, surveyName, { state, errorTag, search, limit = 50, offset = 0 } = {}) {
  let whereConditions = [];
  let params = [email, surveyName];
  let paramIndex = 3;

  if (state) {
    whereConditions.push(`states.current_state = $${paramIndex}`);
    params.push(state);
    paramIndex++;
  }

  if (errorTag) {
    whereConditions.push(`states.error_tag = $${paramIndex}`);
    params.push(errorTag);
    paramIndex++;
  }

  if (search) {
    whereConditions.push(`states.userid LIKE $${paramIndex}`);
    params.push(`%${search}%`);
    paramIndex++;
  }

  const extraWhere = whereConditions.length ? `WHERE ${whereConditions.join(' AND ')}` : '';

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
    FROM states
    ${RESOLVE_VERSION_SQL}
    ${extraWhere}
    ORDER BY states.updated DESC
    LIMIT $${paramIndex}
    OFFSET $${paramIndex + 1}
  `;

  const countQuery = `
    SELECT COUNT(*)::int as total
    FROM states
    ${RESOLVE_VERSION_SQL}
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

async function detail(email, surveyName, userid) {
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
    FROM states
    ${RESOLVE_VERSION_SQL}
    WHERE states.userid = $3
    LIMIT 1
  `;

  const { rows } = await this.query(query, [email, surveyName, userid]);
  return rows.length > 0 ? rows[0] : null;
}

module.exports = {
  name: 'States',
  queries: pool => ({
    summary: summary.bind(pool),
    list: list.bind(pool),
    detail: detail.bind(pool),
  }),
};
