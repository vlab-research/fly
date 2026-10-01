'use strict';

/*
 * Bail events, pure: parsing the read's parameters and shaping what Exodus
 * returns. Shared by GET /bails/events and the MCP list_bail_events tool.
 */

const { parseTimestamp } = require('../../utils/timestamp');

const BAIL_EVENTS_LIMIT = { default: 100, max: 500 };
// A bail that matched thousands of people lists thousands of ids. Events are a
// debugging aid, not an export, so each one carries a sample plus the count.
const BAIL_EVENT_USER_SAMPLE = 50;

/*
 * The REST query string -> { ok: true, query: { bailId, limit, since } }
 *                        | { ok: false, error }
 * An out-of-range limit is refused rather than clamped, so a caller asking for
 * 1000 learns that it got at most 500.
 */
function parseBailEventsQuery({ bail_id, limit, since } = {}) {
  if (bail_id !== undefined && (typeof bail_id !== 'string' || !bail_id)) {
    return { ok: false, error: 'bail_id must be a single non-empty string' };
  }

  let n = BAIL_EVENTS_LIMIT.default;
  if (limit !== undefined && limit !== '') {
    n = Number(limit);
    if (!/^\d+$/.test(String(limit)) || n < 1 || n > BAIL_EVENTS_LIMIT.max) {
      return { ok: false, error: `limit must be an integer 1..${BAIL_EVENTS_LIMIT.max}` };
    }
  }

  const parsedSince = parseTimestamp(since, 'since');
  if (!parsedSince.ok) return parsedSince;

  return { ok: true, query: { bailId: bail_id || null, limit: n, since: parsedSince.value } };
}

/*
 * An event's `definition_snapshot` is the whole tree as it was at run time and
 * is dropped: it is the largest field by far, and get_bail answers "what does
 * this bail say" better than a copy inside every event does.
 */
function shapeBailEvent(event) {
  const results = event.execution_results || {};
  const ids = Array.isArray(results.user_ids) ? results.user_ids : [];

  return {
    id: event.id,
    bail_id: event.bail_id,
    bail_name: event.bail_name || null,
    event_type: event.event_type,
    timestamp: event.timestamp,
    users_matched: event.users_matched,
    users_bailed: event.users_bailed,
    error: event.error || null,
    bailed_user_ids: ids.slice(0, BAIL_EVENT_USER_SAMPLE),
    bailed_user_id_count: ids.length,
  };
}

/*
 * Exodus applies `since` before its limit on the user-wide feed. The per-bail
 * feed returns the whole history and takes neither, so both are applied here;
 * re-applying `since` to the user-wide feed costs nothing.
 */
function shapeBailEvents(events, limit, since = null) {
  const floor = since ? Date.parse(since) : null;
  const rows = (Array.isArray(events) ? events : [])
    .filter(e => floor === null || Date.parse(e.timestamp) >= floor);
  const page = rows.slice(0, limit);

  return {
    count: page.length,
    truncated: rows.length > page.length,
    items: page.map(shapeBailEvent),
  };
}

module.exports = {
  BAIL_EVENTS_LIMIT,
  BAIL_EVENT_USER_SAMPLE,
  parseBailEventsQuery,
  shapeBailEvent,
  shapeBailEvents,
};
