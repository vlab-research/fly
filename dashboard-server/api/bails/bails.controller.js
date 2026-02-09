'use strict';

const { BailsUtil } = require('../../utils');
const { User } = require('../../queries');

function handle(err, res) {
  console.error('Bails API Error:', err);
  const status = err.status || 500;
  res.status(status).json({ error: { message: err.message } });
}

// Middleware to validate that the authenticated user matches the userId param
async function validateUserAccess(req, res, next) {
  try {
    const { email } = req.user;
    const { userId } = req.params;

    if (!email) {
      return res.status(401).json({ error: { message: 'Authentication required' } });
    }

    const user = await User.user({ email });

    if (!user || user.id !== userId) {
      return res.status(403).json({ error: { message: 'Access denied' } });
    }

    req.vlabUser = user;
    next();
  } catch (err) {
    handle(err, res);
  }
}

// List all bails for a user
exports.listBails = async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await BailsUtil.listBails(userId);
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

// Get a single bail
exports.getBail = async (req, res) => {
  try {
    const { userId, bailId } = req.params;
    const result = await BailsUtil.getBail(userId, bailId);
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

// Create a new bail
exports.createBail = async (req, res) => {
  try {
    const { userId } = req.params;
    const { name, description, definition, destination_form } = req.body;

    if (!name || !definition) {
      return res.status(400).json({ error: { message: 'name and definition are required' } });
    }

    const result = await BailsUtil.createBail(userId, {
      name,
      description,
      definition,
      destination_form,
    });
    res.status(201).json(result);
  } catch (err) {
    handle(err, res);
  }
};

// Update an existing bail
exports.updateBail = async (req, res) => {
  try {
    const { userId, bailId } = req.params;
    const { name, description, definition, enabled, destination_form } = req.body;

    const result = await BailsUtil.updateBail(userId, bailId, {
      name,
      description,
      definition,
      enabled,
      destination_form,
    });
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

// Delete a bail
exports.deleteBail = async (req, res) => {
  try {
    const { userId, bailId } = req.params;
    await BailsUtil.deleteBail(userId, bailId);
    res.status(204).send();
  } catch (err) {
    handle(err, res);
  }
};

// Preview bail (dry-run query)
exports.previewBail = async (req, res) => {
  try {
    const { userId } = req.params;
    const { definition } = req.body;

    if (!definition) {
      return res.status(400).json({ error: { message: 'definition is required' } });
    }

    const result = await BailsUtil.previewBail(userId, definition);
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

// Get events for a specific bail
exports.getBailEvents = async (req, res) => {
  try {
    const { userId, bailId } = req.params;
    const result = await BailsUtil.getBailEvents(userId, bailId);
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

// Get all bail events for a user
exports.getUserEvents = async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit } = req.query;
    const result = await BailsUtil.getUserEvents(userId, limit ? parseInt(limit) : 100);
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

exports.validateUserAccess = validateUserAccess;
