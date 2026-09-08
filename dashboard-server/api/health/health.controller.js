'use strict';

const { healthFindings, platformNotices } = require('./health.service');

function handle(err, res) {
  console.error('Health API Error:', err);
  const status = err.status || 500;
  res.status(status).json({ error: { message: err.message } });
}

// GET /surveys/:surveyName/health
// Scoped by validateSurveyNameAccess (reused from api/states). The pipeline
// is IO -> pure -> pure: SQL rows -> aggregate bag -> findings, in
// health.service.js#healthFindings, shared with the MCP get_survey_health tool.
exports.getHealth = async (req, res) => {
  try {
    const result = await healthFindings({
      email: req.surveyEmail,
      surveyName: req.surveyName,
      shortcodes: req.surveyShortcodes,
    });
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

// GET /platform/notices
// Auth required (server-level middleware), no survey scoping. Fail-soft is
// inside platformNotices(): it never throws, it returns { notices: [] }.
exports.getPlatformNotices = async (req, res) => {
  res.status(200).json(await platformNotices());
};
