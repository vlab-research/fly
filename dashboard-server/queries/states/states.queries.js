'use strict';

/**
 * States Queries
 *
 * Database queries for the states table. States track participant progress through surveys,
 * including current state machine position (RESPONDING, ERROR, WAIT_EXTERNAL_EVENT, etc.),
 * the form they're on, error details, and full conversation context.
 *
 * Pattern: queries are bound to the pool via this.query(), following response.queries.js pattern.
 * All queries use parameterized inputs ($1, $2, etc.) for SQL injection protection.
 */

/**
 * Get aggregated state counts grouped by current_state and current_form
 *
 * @param {string[]} shortcodes - Array of survey shortcodes to filter by
 * @returns {Promise<Array>} Array of objects with current_state, current_form, and count
 */
async function summary(shortcodes) {
  const query = `
    SELECT
      current_state,
      current_form,
      COUNT(*)::int as count
    FROM states
    WHERE current_form = ANY($1)
    GROUP BY current_state, current_form
    ORDER BY current_state, current_form
  `;

  const { rows } = await this.query(query, [shortcodes]);
  // Ensure count is a number (pg driver may return it as string)
  const summary = rows.map(row => ({
    ...row,
    count: parseInt(row.count, 10),
  }));
  return { summary };
}

/**
 * Get paginated list of participant states with optional filtering
 *
 * @param {string[]} shortcodes - Array of survey shortcodes to filter by
 * @param {Object} options - Query options
 * @param {string} [options.state] - Filter by current_state (e.g., 'ERROR', 'RESPONDING')
 * @param {string} [options.errorTag] - Filter by error_tag
 * @param {string} [options.search] - Search by userid (LIKE match)
 * @param {number} [options.limit=50] - Page size
 * @param {number} [options.offset=0] - Pagination offset
 * @returns {Promise<{states: Array, total: number}>} Paginated states and total count
 */
async function list(shortcodes, { state, errorTag, search, limit = 50, offset = 0 } = {}) {
  // Build dynamic WHERE clause
  let whereConditions = ['current_form = ANY($1)'];
  let params = [shortcodes];
  let paramIndex = 2;

  if (state) {
    whereConditions.push(`current_state = $${paramIndex}`);
    params.push(state);
    paramIndex++;
  }

  if (errorTag) {
    whereConditions.push(`error_tag = $${paramIndex}`);
    params.push(errorTag);
    paramIndex++;
  }

  if (search) {
    whereConditions.push(`userid LIKE $${paramIndex}`);
    params.push(`%${search}%`);
    paramIndex++;
  }

  const whereClause = whereConditions.join(' AND ');

  // Query for list of states
  const listQuery = `
    SELECT
      userid,
      pageid,
      current_state,
      current_form,
      updated,
      error_tag,
      stuck_on_question,
      timeout_date,
      form_start_time
    FROM states
    WHERE ${whereClause}
    ORDER BY updated DESC
    LIMIT $${paramIndex}
    OFFSET $${paramIndex + 1}
  `;

  // Query for total count
  const countQuery = `
    SELECT COUNT(*)::int as total
    FROM states
    WHERE ${whereClause}
  `;

  // Execute both queries
  const [listResult, countResult] = await Promise.all([
    this.query(listQuery, [...params, limit, offset]),
    this.query(countQuery, params),
  ]);

  return {
    states: listResult.rows,
    total: countResult.rows[0].total,
  };
}

/**
 * Get full state detail for a single participant (includes state_json)
 *
 * @param {string[]} shortcodes - Array of survey shortcodes to filter by
 * @param {string} userid - Participant's Facebook user PSID
 * @returns {Promise<Object|null>} Full state object including state_json, or null if not found
 */
async function detail(shortcodes, userid) {
  const query = `
    SELECT
      userid,
      pageid,
      updated,
      current_state,
      current_form,
      form_start_time,
      error_tag,
      fb_error_code,
      stuck_on_question,
      timeout_date,
      next_retry,
      payment_error_code,
      previous_is_followup,
      previous_with_token,
      state_json
    FROM states
    WHERE current_form = ANY($1)
      AND userid = $2
    LIMIT 1
  `;

  const { rows } = await this.query(query, [shortcodes, userid]);
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
