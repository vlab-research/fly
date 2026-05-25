'use strict';

const { Survey, States: statesQueries } = require('../../queries');

function handle(err, res) {
  console.error('States API Error:', err);
  const status = err.status || 500;
  res.status(status).json({ error: { message: err.message } });
}

// Middleware: verify ownership of the survey_name and collect the shortcodes
// it uses. The shortcodes are passed to queries as a pre-filter so the
// lateral version-resolution join doesn't have to scan every row in states.
// (Same shortcode shared with a sibling survey_name is fine — the lateral
// then disambiguates by version.)
async function validateSurveyNameAccess(req, res, next) {
  try {
    const { email } = req.user;
    const { surveyName } = req.params;

    if (!email) {
      return res.status(401).json({ error: { message: 'Authentication required' } });
    }

    const surveys = await Survey.retrieve({ email });
    const matching = surveys.filter(s => s.survey_name === surveyName);

    if (matching.length === 0) {
      return res.status(403).json({ error: { message: 'Access denied to this survey' } });
    }

    req.surveyEmail = email;
    req.surveyName = surveyName;
    req.surveyShortcodes = [...new Set(matching.map(s => s.shortcode))];
    next();
  } catch (err) {
    handle(err, res);
  }
}

exports.getSummary = async (req, res) => {
  try {
    const result = await statesQueries.summary(req.surveyEmail, req.surveyName, req.surveyShortcodes);
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
    const result = await statesQueries.list(req.surveyEmail, req.surveyName, req.surveyShortcodes, filters);
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

exports.getStateDetail = async (req, res) => {
  try {
    const { userid } = req.params;
    const result = await statesQueries.detail(req.surveyEmail, req.surveyName, req.surveyShortcodes, userid);

    if (!result) {
      return res.status(404).json({ error: { message: 'State not found' } });
    }

    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

exports.validateSurveyNameAccess = validateSurveyNameAccess;
