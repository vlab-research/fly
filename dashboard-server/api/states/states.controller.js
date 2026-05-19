'use strict';

const { Survey, States: statesQueries } = require('../../queries');

function handle(err, res) {
  console.error('States API Error:', err);
  const status = err.status || 500;
  res.status(status).json({ error: { message: err.message } });
}

// Middleware: verify the authenticated user owns at least one survey under
// the requested survey_name. Version resolution (which states actually
// belong to this survey_name) is done at query time in states.queries.js.
async function validateSurveyNameAccess(req, res, next) {
  try {
    const { email } = req.user;
    const { surveyName } = req.params;

    if (!email) {
      return res.status(401).json({ error: { message: 'Authentication required' } });
    }

    const surveys = await Survey.retrieve({ email });
    const owns = surveys.some(s => s.survey_name === surveyName);

    if (!owns) {
      return res.status(403).json({ error: { message: 'Access denied to this survey' } });
    }

    req.surveyEmail = email;
    req.surveyName = surveyName;
    next();
  } catch (err) {
    handle(err, res);
  }
}

exports.getSummary = async (req, res) => {
  try {
    const result = await statesQueries.summary(req.surveyEmail, req.surveyName);
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

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
    const result = await statesQueries.list(req.surveyEmail, req.surveyName, filters);
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

exports.getStateDetail = async (req, res) => {
  try {
    const { userid } = req.params;
    const result = await statesQueries.detail(req.surveyEmail, req.surveyName, userid);

    if (!result) {
      return res.status(404).json({ error: { message: 'State not found' } });
    }

    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

exports.validateSurveyNameAccess = validateSurveyNameAccess;
