'use strict';

// Declarative health ruleset — the "interpretation plane".
//
// Data-only: no functions in rule objects, so the set stays serializable and
// per-survey overrides can slot in later without rearchitecting. Rules map
// conditions over the aggregate bag (see aggregate.js) to findings.
//
// Semantics (implemented in evaluate.js):
//  - `when.metric` is a dot-path into the aggregate bag (e.g.
//    'blocked.template_missing').
//  - `when.count_gte` — absolute floor on the metric's count.
//  - `when.ratio_gte` — floor on count / max(active_users, 1). Optional.
//  - All conditions present must hold for the rule to match.
//  - Rules are grouped implicitly by metric: all are evaluated, but only the
//    highest matching level per metric survives ('action' > 'note'), so
//    a spike rule supersedes its trickle sibling.
//
// Severity philosophy (see documentation/dashboard-study-health.md):
//  - Deterministic blockers (machinery broken; every user on the path hits
//    it): alarm at count >= 1. 1-in-1000 here is proof the door is locked.
//  - Stochastic degradation (distributed over the population): alarm on
//    proportion + small absolute floor; below that, a muted note.
//
// Thresholds are v1 proposals — revisit after seeing real traffic.

module.exports.rules = [
  // ---- deterministic blockers: existence == broken -------------------
  {
    id: 'template-missing',
    when: { metric: 'blocked.template_missing', count_gte: 1 },
    level: 'action',
    message:
      '{count} respondent(s) blocked: your Facebook message template appears to be missing or unapproved.',
    action: { label: 'Check message templates', dest: 'message-templates' },
  },

  {
    id: 'rate-limited',
    when: { metric: 'blocked.rate_limit', count_gte: 1 },
    level: 'action',
    message:
      '{count} respondent(s) blocked by Facebook rate limits. This is a platform-side issue; delivery resumes automatically when the limit lifts.',
    action: {
      label: 'View affected respondents',
      dest: 'states-list',
      filter: { state: 'BLOCKED' },
    },
  },

  {
    id: 'platform-errors',
    when: { metric: 'error.platform', count_gte: 1 },
    level: 'action',
    message:
      '{count} respondent(s) hit platform errors (not caused by your survey configuration). The platform team is notified automatically.',
    action: {
      label: 'View affected respondents',
      dest: 'states-list',
      filter: { state: 'ERROR' },
    },
  },

  // ---- stochastic degradation: proportion + floor --------------------
  {
    id: 'error-spike',
    when: { metric: 'error.study', ratio_gte: 0.05, count_gte: 3 },
    level: 'action',
    message:
      '{count} of {active} respondents ({ratio}) hit errors in the last 24h — this may indicate a form configuration problem.',
    action: {
      label: 'View affected respondents',
      dest: 'states-list',
      filter: { state: 'ERROR' },
    },
  },

  {
    id: 'error-trickle',
    when: { metric: 'error.study', count_gte: 1 },
    level: 'note',
    message: '{count} respondent(s) hit an error ({ratio}).',
    action: { label: 'View', dest: 'states-list', filter: { state: 'ERROR' } },
  },

  {
    id: 'stuck-spike',
    when: { metric: 'stuck_users', ratio_gte: 0.05, count_gte: 3 },
    level: 'action',
    message:
      '{count} respondents appear stuck on a question — possibly a validation loop or confusing wording.',
    action: { label: 'View stuck respondents', dest: 'states-list', filter: {} },
  },

  {
    id: 'stuck-trickle',
    when: { metric: 'stuck_users', count_gte: 1 },
    level: 'note',
    message: '{count} respondent(s) stuck on a question.',
    action: { label: 'View', dest: 'states-list', filter: {} },
  },

  {
    id: 'expired-waits',
    when: { metric: 'expired_waits', count_gte: 1 },
    level: 'note',
    message:
      '{count} respondent(s) waiting on an external event past its timeout.',
    action: {
      label: 'View',
      dest: 'states-list',
      filter: { state: 'WAIT_EXTERNAL_EVENT' },
    },
  },
];

// Platform notices whitelist + translation table for the AlertManager proxy
// (GET /platform/notices). Keys are AlertManager alertnames; anything not
// listed here (all infra alerts) is dropped. Values are researcher-facing
// copy — calm, no-blame, no platform jargon.
module.exports.platformNotices = {
  PlatformInternalErrors:
    'The platform is currently experiencing elevated internal errors. Your survey may be affected; this is not caused by your configuration.',
  PlatformRateLimited:
    'Facebook is currently rate-limiting the platform. Message delivery may be delayed across surveys.',
  MultiSurveyErrorRegression:
    'The platform is currently experiencing elevated errors across multiple surveys. The team has been alerted.',
  DeanExpiredWaits:
    'Scheduled/externally-triggered messages are currently delayed platform-wide.',
};
