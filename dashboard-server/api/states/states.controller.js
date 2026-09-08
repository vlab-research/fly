'use strict';

const { resolveSurvey, statesSummary, listStates, stateDetail } = require('./states.service');

function handle(err, res) {
  console.error('States API Error:', err);
  const status = err.status || 500;
  res.status(status).json({ error: { message: err.message } });
}

// Middleware: verify ownership of the survey_name and collect the shortcodes
// it uses. The lookup itself is `resolveSurvey` in states.service.js, shared
// with the MCP tools, so REST and MCP cannot disagree about whose survey this
// is. The shortcodes are passed to queries as a pre-filter so the version
// resolution doesn't have to scan every row in states. (Same shortcode shared
// with a sibling survey_name is fine — resolution then disambiguates by
// version.)
async function validateSurveyNameAccess(req, res, next) {
  try {
    const { email } = req.user;
    const { surveyName } = req.params;

    if (!email) {
      return res.status(401).json({ error: { message: 'Authentication required' } });
    }

    const resolved = await resolveSurvey({ email, survey_name: surveyName });

    if (!resolved.ok) {
      return res.status(403).json({ error: { message: 'Access denied to this survey' } });
    }

    req.surveyEmail = resolved.email;
    req.surveyName = resolved.surveyName;
    req.surveyShortcodes = resolved.shortcodes;
    next();
  } catch (err) {
    handle(err, res);
  }
}

// The resolved-survey shape states.service takes, rebuilt from what the
// middleware left on the request.
const surveyOf = req => ({
  email: req.surveyEmail,
  surveyName: req.surveyName,
  shortcodes: req.surveyShortcodes,
});

exports.getSummary = async (req, res) => {
  try {
    const result = await statesSummary(surveyOf(req));
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

exports.listStates = async (req, res) => {
  try {
    const { state, error_tag, form, search, limit, offset } = req.query;
    const filters = {
      state,
      errorTag: error_tag,
      form,
      search,
      limit: limit ? parseInt(limit) : 50,
      offset: offset ? parseInt(offset) : 0,
    };
    const result = await listStates(surveyOf(req), filters);
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

exports.getStateDetail = async (req, res) => {
  try {
    const { userid } = req.params;
    const result = await stateDetail(surveyOf(req), userid);

    if (!result) {
      return res.status(404).json({ error: { message: 'State not found' } });
    }

    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

exports.validateSurveyNameAccess = validateSurveyNameAccess;
