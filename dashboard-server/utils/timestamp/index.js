'use strict';

/*
 * Parsing for the `since` parameters, pure.
 *
 * Accepts a date (midnight UTC) or an RFC 3339 date-time with seconds and an
 * explicit zone. A zone-less time is refused rather than guessed: it would be
 * read in the server's zone by one consumer and in UTC by another. The value
 * handed on is RFC 3339, which both CockroachDB and Exodus (Go's time.RFC3339)
 * parse, and it keeps the caller's sub-millisecond digits.
 */

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/;

// Date.parse rolls 2026-02-30 over to March rather than refusing it.
function isCalendarDate(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/*
 * -> { ok: true, value: string | null }  (null when absent)
 *  | { ok: false, error }
 */
function parseTimestamp(raw, name = 'since') {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };

  const match = typeof raw === 'string' && ISO.exec(raw);
  const valid = match
    && isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))
    && !Number.isNaN(Date.parse(raw));

  if (!valid) {
    return {
      ok: false,
      error: `${name} must be an ISO 8601 timestamp with a zone, e.g. 2026-09-30T12:00:00Z, or a date, e.g. 2026-09-30; got ${JSON.stringify(raw)}`,
    };
  }

  return { ok: true, value: raw.length === 10 ? `${raw}T00:00:00Z` : raw };
}

module.exports = { parseTimestamp };
