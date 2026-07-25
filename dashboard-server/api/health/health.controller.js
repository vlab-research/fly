'use strict';

const fetch = require('node-fetch');

const { States } = require('../../queries');
const { HEALTH_WINDOW_HOURS } = require('../../queries/states/states.queries');
const { ALERTMANAGER } = require('../../config');
const { buildAggregates } = require('./aggregate');
const { evaluate } = require('./evaluate');
const { rules, platformNotices } = require('./rules');
const { translateAlerts } = require('./notices');

function handle(err, res) {
  console.error('Health API Error:', err);
  const status = err.status || 500;
  res.status(status).json({ error: { message: err.message } });
}

// GET /surveys/:surveyName/health
// Scoped by validateSurveyNameAccess (reused from api/states). The pipeline
// is IO -> pure -> pure: SQL rows -> aggregate bag -> findings. Aggregates
// are included in the response for debuggability and future client uses.
exports.getHealth = async (req, res) => {
  try {
    const rows = await States.healthSummary(
      req.surveyEmail,
      req.surveyName,
      req.surveyShortcodes
    );
    const aggregates = buildAggregates(rows, HEALTH_WINDOW_HOURS);
    const findings = evaluate(aggregates, rules);
    res.status(200).json({ window_hours: HEALTH_WINDOW_HOURS, findings, aggregates });
  } catch (err) {
    handle(err, res);
  }
};

const ALERTMANAGER_TIMEOUT_MS = 2000;

// GET /platform/notices
// Auth required (server-level middleware), no survey scoping — platform
// alerts have no form label and apply to everyone. Fail-soft everywhere:
// monitoring being down or unconfigured must never break the researcher
// dashboard, so any failure path returns { notices: [] }.
exports.getPlatformNotices = async (req, res) => {
  if (!ALERTMANAGER.url) {
    // Feature cleanly off in dev / if monitoring moves.
    return res.status(200).json({ notices: [] });
  }

  try {
    const response = await fetch(
      `${ALERTMANAGER.url}/api/v2/alerts?active=true&silenced=false&inhibited=false`,
      { timeout: ALERTMANAGER_TIMEOUT_MS }
    );
    if (!response.ok) {
      throw new Error(`AlertManager responded ${response.status}`);
    }
    const alerts = await response.json();
    res.status(200).json({ notices: translateAlerts(alerts, platformNotices) });
  } catch (err) {
    console.error('Platform notices unavailable:', err.message);
    res.status(200).json({ notices: [] });
  }
};
