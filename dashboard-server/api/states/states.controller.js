'use strict';

const { Survey } = require('../../queries');
const statesQueries = require('../../queries/states');

function handle(err, res) {
  console.error('States API Error:', err);
  const status = err.status || 500;
  res.status(status).json({ error: { message: err.message } });
}

// Middleware to validate survey name access
async function validateSurveyNameAccess(req, res, next) {
  try {
    const { email } = req.user;
    const { surveyName } = req.params;

    if (!email) {
      return res.status(401).json({ error: { message: 'Authentication required' } });
    }

    // Verify user owns this survey_name and collect all shortcodes
    const surveys = await Survey.retrieve({ email });
    const matchingSurveys = surveys.filter(s => s.survey_name === surveyName);

    if (matchingSurveys.length === 0) {
      return res.status(403).json({ error: { message: 'Access denied to this survey' } });
    }

    // Collect all shortcodes for this survey_name
    req.surveyShortcodes = matchingSurveys.map(s => s.shortcode);
    next();
  } catch (err) {
    handle(err, res);
  }
}

// Get summary of states for a survey
exports.getSummary = async (req, res) => {
  try {
    const result = await statesQueries.summary(req.surveyShortcodes);
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

// List states with filters
exports.listStates = async (req, res) => {
  try {
    const { state, error_tag, search, limit, offset } = req.query;
    const filters = {
      state,
      errorTag: error_tag,
      search,
      limit: limit ? parseInt(limit) : 50,
      offset: offset ? parseInt(offset) : 0,
    };
    const result = await statesQueries.list(req.surveyShortcodes, filters);
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

// Get state detail for a specific user
exports.getStateDetail = async (req, res) => {
  try {
    const { userid } = req.params;
    const result = await statesQueries.detail(req.surveyShortcodes, userid);

    if (!result) {
      return res.status(404).json({ error: { message: 'State not found' } });
    }

    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

exports.validateSurveyNameAccess = validateSurveyNameAccess;
