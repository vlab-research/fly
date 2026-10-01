'use strict';

/*
 * The optional filters on the responses stream, parsed once for GET /responses
 * and the MCP get_responses tool.
 */

const { parseTimestamp } = require('../../utils/timestamp');

/*
 * -> { ok: true, filters: { questionRef: string|null, since: string|null } }
 *  | { ok: false, error }
 */
function parseResponseFilters({ question_ref, since } = {}) {
  if (question_ref !== undefined && question_ref !== null && typeof question_ref !== 'string') {
    return { ok: false, error: 'question_ref must be a single string' };
  }

  const parsedSince = parseTimestamp(since, 'since');
  if (!parsedSince.ok) return parsedSince;

  return {
    ok: true,
    filters: { questionRef: question_ref || null, since: parsedSince.value },
  };
}

module.exports = { parseResponseFilters };
