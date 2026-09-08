'use strict';

/*
 * Health operations, req-free, shared by the REST controller and the MCP
 * tools. Both are IO -> pure -> pure pipelines; the pure halves
 * (buildAggregates, evaluate, translateAlerts) already lived in this module,
 * and this file is the thin shell that feeds them.
 */

const fetch = require('node-fetch');

const { States } = require('../../queries');
const { HEALTH_WINDOW_HOURS } = require('../../queries/states/states.queries');
const { ALERTMANAGER } = require('../../config');
const { buildAggregates } = require('./aggregate');
const { evaluate } = require('./evaluate');
const { rules, platformNotices: noticeTable } = require('./rules');
const { translateAlerts } = require('./notices');

// Takes a resolved survey (states.service#resolveSurvey's `ok: true` shape) so
// the ownership check cannot be bypassed. Returns exactly what
// GET /surveys/:surveyName/health returns.
async function healthFindings({ email, surveyName, shortcodes }) {
  const rows = await States.healthSummary(email, surveyName, shortcodes);
  const aggregates = buildAggregates(rows, HEALTH_WINDOW_HOURS);
  const findings = evaluate(aggregates, rules);
  return { window_hours: HEALTH_WINDOW_HOURS, findings, aggregates };
}

const ALERTMANAGER_TIMEOUT_MS = 2000;

// Platform-wide, no survey scoping — platform alerts have no form label and
// apply to everyone. Fail-soft everywhere: monitoring being down or
// unconfigured must never break the researcher dashboard, so every failure
// path returns { notices: [] }. That is the endpoint's contract and the MCP
// tool inherits it.
async function platformNotices() {
  if (!ALERTMANAGER.url) {
    // Feature cleanly off in dev / if monitoring moves.
    return { notices: [] };
  }

  try {
    const response = await fetch(
      `${ALERTMANAGER.url}/api/v2/alerts?active=true&silenced=false&inhibited=false`,
      { timeout: ALERTMANAGER_TIMEOUT_MS },
    );
    if (!response.ok) {
      throw new Error(`AlertManager responded ${response.status}`);
    }
    const alerts = await response.json();
    return { notices: translateAlerts(alerts, noticeTable) };
  } catch (err) {
    console.error('Platform notices unavailable:', err.message);
    return { notices: [] };
  }
}

module.exports = { healthFindings, platformNotices, ALERTMANAGER_TIMEOUT_MS };
