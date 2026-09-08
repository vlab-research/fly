'use strict';

/*
 * Response reads, req-free, shared by GET /responses and the MCP get_responses
 * tool. Cursor paging is the query's own: every row carries an opaque `token`
 * encoding (timestamp, userid, question_ref), and passing the last row's token
 * as `after` fetches the next page. The token is stable, so a caller can stop
 * and resume later.
 */

const { Response } = require('../../queries');
const { RequestError } = require('../../queries/responses/response.queries');

/*
 * `Response.all` throws its RequestError when the survey has no responses at
 * all (or the account is gone) — a legacy of answering the CSV download. For a
 * paged read that is simply an empty page, so it is reported as one.
 * Ownership is enforced inside the query: it joins on the caller's email.
 */
async function getResponses({ email, survey_name, after = null, pageSize = 25 }) {
  try {
    const { responses } = await Response.all(email, survey_name, after, pageSize);
    return { responses };
  } catch (err) {
    if (err instanceof RequestError) return { responses: [] };
    throw err;
  }
}

module.exports = { getResponses };
