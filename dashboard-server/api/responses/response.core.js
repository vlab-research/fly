'use strict';

/*
 * The optional filters on the responses stream, parsed once for GET /responses
 * and the MCP get_responses tool.
 */

// A date, or a date-time with an explicit zone. A zone-less time is refused
// rather than read in whatever zone the database session happens to use.
const SINCE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}))?$/;

const validSince = since => typeof since === 'string'
  && SINCE.test(since)
  && !Number.isNaN(Date.parse(since))
  // Date.parse rolls 2026-02-30 over to March instead of refusing it.
  && new Date(since.slice(0, 10)).toISOString().startsWith(since.slice(0, 10));

/*
 * -> { ok: true, filters: { questionRef: string|null, since: string|null } }
 *  | { ok: false, error }
 */
function parseResponseFilters({ question_ref, since } = {}) {
  if (question_ref !== undefined && question_ref !== null && typeof question_ref !== 'string') {
    return { ok: false, error: 'question_ref must be a single string' };
  }

  if (since && !validSince(since)) {
    return {
      ok: false,
      error: `since must be an ISO 8601 timestamp with a zone, e.g. 2026-09-30T12:00:00Z, or a date, e.g. 2026-09-30; got ${JSON.stringify(since)}`,
    };
  }

  const midnight = since && since.length === 10 ? `${since}T00:00:00Z` : since;
  return { ok: true, filters: { questionRef: question_ref || null, since: midnight || null } };
}

module.exports = { parseResponseFilters };
