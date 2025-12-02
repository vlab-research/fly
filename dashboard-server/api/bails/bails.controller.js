'use strict';

const { BailsUtil } = require('../../utils');
const { Survey } = require('../../queries');

function handle(err, res) {
  console.error('Bails API Error:', err);
  const status = err.status || 500;
  res.status(status).json({ error: { message: err.message } });
}

// Middleware to validate survey ownership
async function validateSurveyAccess(req, res, next) {
  try {
    const { email } = req.user;
    const { surveyId } = req.params;

    if (!email) {
      return res.status(401).json({ error: { message: 'Authentication required' } });
    }

    // Verify user owns this survey (surveyId is the shortcode)
    const surveys = await Survey.retrieve({ email });
    const survey = surveys.find(s => s.shortcode === surveyId || s.id === surveyId);

    if (!survey) {
      return res.status(403).json({ error: { message: 'Access denied to this survey' } });
    }

    req.survey = survey;
    next();
  } catch (err) {
    handle(err, res);
  }
}

// List all bails for a survey
exports.listBails = async (req, res) => {
  try {
    const { surveyId } = req.params;
    const result = await BailsUtil.listBails(surveyId);
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

// Get a single bail
exports.getBail = async (req, res) => {
  try {
    const { surveyId, bailId } = req.params;
    const result = await BailsUtil.getBail(surveyId, bailId);
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

// Create a new bail
exports.createBail = async (req, res) => {
  try {
    const { surveyId } = req.params;
    const { name, description, definition } = req.body;

    if (!name || !definition) {
      return res.status(400).json({ error: { message: 'name and definition are required' } });
    }

    const result = await BailsUtil.createBail(surveyId, { name, description, definition });
    res.status(201).json(result);
  } catch (err) {
    handle(err, res);
  }
};

// Update an existing bail
exports.updateBail = async (req, res) => {
  try {
    const { surveyId, bailId } = req.params;
    const { name, description, definition, enabled } = req.body;

    const result = await BailsUtil.updateBail(surveyId, bailId, {
      name,
      description,
      definition,
      enabled,
    });
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

// Delete a bail
exports.deleteBail = async (req, res) => {
  try {
    const { surveyId, bailId } = req.params;
    await BailsUtil.deleteBail(surveyId, bailId);
    res.status(204).send();
  } catch (err) {
    handle(err, res);
  }
};

// Preview bail (dry-run query)
exports.previewBail = async (req, res) => {
  try {
    const { surveyId } = req.params;
    const { definition } = req.body;

    if (!definition) {
      return res.status(400).json({ error: { message: 'definition is required' } });
    }

    const result = await BailsUtil.previewBail(surveyId, definition);
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

// Get events for a specific bail
exports.getBailEvents = async (req, res) => {
  try {
    const { surveyId, bailId } = req.params;
    const result = await BailsUtil.getBailEvents(surveyId, bailId);
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

// Get all bail events for a survey
exports.getSurveyEvents = async (req, res) => {
  try {
    const { surveyId } = req.params;
    const { limit } = req.query;
    const result = await BailsUtil.getSurveyEvents(surveyId, limit ? parseInt(limit) : 100);
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

exports.validateSurveyAccess = validateSurveyAccess;
