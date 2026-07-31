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

  // provider_unreachable: we never reached the messaging provider at all
  // (usually a missing page token). Deliberately NOT phrased as self-healing:
  // dean retries via `fb_error_code = ANY(...)` and SQL `= ANY` never matches
  // NULL, so these respondents are structurally unrecoverable and will sit
  // BLOCKED until someone intervenes. Telling the researcher to wait would be
  // false. See documentation/study-error-alerting.md (ProviderErrors runbook).
  {
    id: 'provider-unreachable',
    when: { metric: 'blocked.provider_unreachable', count_gte: 1 },
    level: 'action',
    message:
      '{count} respondent(s) could not be reached at all — the platform failed to connect to the messaging provider. This is not caused by your survey configuration, and these respondents will not recover on their own. Please contact support.',
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

  // NOTE: `stuck_users` deliberately has NO rule (removed 2026-07-29). The
  // aggregate is still computed and returned (visible via the `aggregates`
  // payload, and per-respondent via the states list's `stuck_on_question`
  // column) — it just no longer produces a finding, because:
  //  - the signal was not actionable on its own (repeating the same question
  //    is often normal respondent behavior, not a validation loop), and
  //  - `stuck_on_question` is not a filterable dimension in StatesList, so the
  //    finding's CTA had `filter: {}` and dumped the researcher on an
  //    unfiltered list — a call to action that led nowhere.
  // Reinstating it requires a real drill-down first (a `stuck=true` filter on
  // the states-list query-param convention), not just a rule.
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

  // provider_error (-1): the provider accepted the request and failed its own
  // way. Genuinely transient and dean DOES retry these, so unlike
  // provider-unreachable this is stochastic — a trickle is noise, a spike is
  // a channel problem worth surfacing.
  {
    id: 'provider-error-spike',
    when: { metric: 'blocked.provider_error', ratio_gte: 0.05, count_gte: 3 },
    level: 'action',
    message:
      '{count} of {active} respondents ({ratio}) could not be messaged because the messaging provider returned errors. This is a provider-side issue, not your configuration; delivery is retried automatically.',
    action: {
      label: 'View affected respondents',
      dest: 'states-list',
      filter: { state: 'BLOCKED' },
    },
  },

  {
    id: 'provider-error-trickle',
    when: { metric: 'blocked.provider_error', count_gte: 1 },
    level: 'note',
    message:
      '{count} respondent(s) hit a transient messaging-provider error; delivery is retried automatically.',
    action: { label: 'View', dest: 'states-list', filter: { state: 'BLOCKED' } },
  },

  // Catch-all notes for the remaining blocked buckets. Before these, both
  // 'other' and 'unsupported' were classified but read by NO rule, so a
  // respondent blocked for an unrecognized reason produced a completely clean
  // Monitor tab. Any future category added to the taxonomy without a rule of
  // its own still falls into 'other' and at least surfaces here.
  {
    id: 'blocked-unsupported',
    when: { metric: 'blocked.unsupported', count_gte: 1 },
    level: 'note',
    message:
      '{count} respondent(s) could not be messaged because the channel rejected the message type.',
    action: { label: 'View', dest: 'states-list', filter: { state: 'BLOCKED' } },
  },

  {
    id: 'blocked-other',
    when: { metric: 'blocked.other', count_gte: 1 },
    level: 'note',
    message:
      '{count} respondent(s) blocked for an unrecognized reason. If this number is growing, please contact support.',
    action: { label: 'View', dest: 'states-list', filter: { state: 'BLOCKED' } },
  },
];

// Platform notices whitelist + translation table for the AlertManager proxy
// (GET /platform/notices). Keys are AlertManager alertnames; anything not
// listed here (all infra alerts) is dropped. Values are researcher-facing
// copy — calm, no-blame, no platform jargon.
//
// ⚠️ These keys are a hand-maintained coupling to the `alert:` names in
// devops/alerts/templates/study-health.yaml. notices.js DROPS any alert not
// listed here, so renaming an alert there removes a researcher-facing notice
// with no error anywhere. Verified against that file 2026-07-30.
//
// ⚠️ A NOTICE IS NOT A PAGE. Whitelisting an alert here shows it to every survey
// owner, whose only available response is to stop their surveys. So an alert
// belongs here ONLY if its threshold is calibrated for that audience. Paging
// thresholds are deliberately low noise gates for an on-call who can triage;
// reusing one here cries wolf and trains researchers to ignore the banner.
// When the two audiences need different bars, add a second alert rule (see
// PlatformInternalErrorsSevere) rather than whitelisting the paging one.
module.exports.platformNotices = {
  ProviderErrors:
    'The platform is currently unable to deliver messages on one or more channels. Your survey may be affected; this is not caused by your configuration. The team has been alerted.',
  // NOTE: keyed on PlatformInternalErrorsSevere, NOT PlatformInternalErrors.
  // The paging alert fires at >=5 affected users — inside the flat 1-6 background
  // of the known lost-`md` stuck population — so it flapped through 4 firing
  // episodes in the 4 days to 2026-07-30, each one lighting this banner for every
  // researcher. The Severe variant additionally requires >=25 users, >=25% of all
  // active users, and >=50 active users for 30m, and would not have fired once in
  // that window. Do NOT re-add the paging alert here.
  PlatformInternalErrorsSevere:
    'The platform is currently experiencing elevated internal errors. Your survey may be affected; this is not caused by your configuration.',
  PlatformRateLimited:
    'Facebook is currently rate-limiting the platform. Message delivery may be delayed across surveys.',
  MultiSurveyErrorRegression:
    'The platform is currently experiencing elevated errors across multiple surveys. The team has been alerted.',
  DeanExpiredWaits:
    'Scheduled/externally-triggered messages are currently delayed platform-wide.',
};
