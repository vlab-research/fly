'use strict';

// Pure fold from healthSummary query rows into the aggregate bag — the
// "data plane" output that the declarative ruleset (rules.js) is evaluated
// against. No IO, no Date, no config: rows in, bag out.
//
// Taxonomy contract: documentation/study-error-alerting.md ("Taxonomy
// contract" section) is the single source of truth. The fb_error_code
// bucketing happens in SQL (queries/states/states.queries.js healthSummary);
// the error_tag bucketing happens here.
//
// The classification is hand-maintained in SIX places across four languages —
// do NOT change a mapping here without walking the "Consumer inventory" table
// in that doc. This file is sites 2 (FB_CATEGORIES) and 3
// (PLATFORM_ERROR_TAGS). FB_CATEGORIES is an allow-list that must agree with
// the SQL CASE in healthSummary, which is a separate file: that seam is
// exactly where the 2026-07-26 provider_error/provider_unreachable drift
// went unnoticed.
//
// error_tag classes:
//  - INTERNAL / STATE_ACTIONS / NETWORK -> error.platform (deterministic,
//    the platform's fault — surfaced as a no-blame notice).
//  - everything else (FORM_NOT_FOUND, 'none'/NULL, and any unrecognized
//    tag) -> error.study (stochastic). Unknown tags default to study
//    because platform classification must be explicit — an unrecognized
//    tag is not proof of platform fault.

const PLATFORM_ERROR_TAGS = ['INTERNAL', 'STATE_ACTIONS', 'NETWORK'];

// Must agree with the CASE in queries/states/states.queries.js healthSummary
// (site 1) — this list is only an allow-list, so a category the SQL emits but
// this array omits is silently folded into 'other'.
const FB_CATEGORIES = [
  'attrition',
  'template_missing',
  'rate_limit',
  'unsupported',
  'provider_error',
  'provider_unreachable',
  'other',
];

function emptyBag() {
  const blocked = {};
  FB_CATEGORIES.forEach(c => {
    blocked[c] = 0;
  });
  return {
    active_users: 0,
    error: { platform: 0, study: 0, by_tag: {} },
    blocked,
    stuck_users: 0,
    expired_waits: 0,
  };
}

function foldRow(bag, row) {
  // pg returns INT8 aggregates as strings — coerce defensively.
  const count = Number(row.count) || 0;
  bag.active_users += count;
  bag.stuck_users += Number(row.stuck) || 0;
  bag.expired_waits += Number(row.expired) || 0;

  if (row.state === 'ERROR') {
    const tag = row.error_tag || 'none';
    bag.error.by_tag[tag] = (bag.error.by_tag[tag] || 0) + count;
    if (PLATFORM_ERROR_TAGS.includes(tag)) {
      bag.error.platform += count;
    } else {
      bag.error.study += count;
    }
  }

  if (row.state === 'BLOCKED') {
    const category = FB_CATEGORIES.includes(row.fb_category)
      ? row.fb_category
      : 'other';
    bag.blocked[category] += count;
  }

  return bag;
}

// rows: [{ form, state, error_tag, fb_category, stuck, expired, count }]
// -> aggregate bag (top-level totals + the same shape per form under
// by_form, for copy like "in form XYZ12").
function buildAggregates(rows, windowHours) {
  const bag = emptyBag();
  bag.window_hours = windowHours;
  bag.by_form = {};

  rows.forEach(row => {
    foldRow(bag, row);
    if (row.form) {
      if (!bag.by_form[row.form]) bag.by_form[row.form] = emptyBag();
      foldRow(bag.by_form[row.form], row);
    }
  });

  return bag;
}

module.exports = { buildAggregates, PLATFORM_ERROR_TAGS };
