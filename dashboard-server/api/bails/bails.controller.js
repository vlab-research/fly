'use strict';

/*
 * HTTP shell over bails.service.js. The Exodus calls and the 4xx-versus-ours
 * distinction live there; this file validates the body the dashboard sends,
 * enforces that :userId is the caller, and maps outcomes onto status codes.
 */

const { User } = require('../../queries');
const service = require('./bails.service');

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
    res.status(200).json(await service.listBails(req.vlabUser));
  } catch (err) {
    handle(err, res);
  }
};

// Get a single bail
exports.getBail = async (req, res) => {
  try {
    res.status(200).json(await service.getBail(req.vlabUser, req.params.bailId));
  } catch (err) {
    handle(err, res);
  }
};

// Create a new bail
exports.createBail = async (req, res) => {
  try {
    const { name, description, definition, destination_form } = req.body;

    if (!name || !definition) {
      return res.status(400).json({ error: { message: 'name and definition are required' } });
    }

    const result = await service.createBail(req.vlabUser, {
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
    const { name, description, definition, enabled, destination_form } = req.body;

    const result = await service.updateBail(req.vlabUser, req.params.bailId, {
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
    await service.deleteBail(req.vlabUser, req.params.bailId);
    res.status(204).send();
  } catch (err) {
    handle(err, res);
  }
};

// Preview bail (dry-run query)
exports.previewBail = async (req, res) => {
  try {
    const { definition } = req.body;

    if (!definition) {
      return res.status(400).json({ error: { message: 'definition is required' } });
    }

    res.status(200).json(await service.previewBail(req.vlabUser, definition));
  } catch (err) {
    handle(err, res);
  }
};

// Get events for a specific bail
exports.getBailEvents = async (req, res) => {
  try {
    res.status(200).json(await service.bailEvents(req.vlabUser, req.params.bailId));
  } catch (err) {
    handle(err, res);
  }
};

// Get all bail events for a user
exports.getUserEvents = async (req, res) => {
  try {
    const { limit } = req.query;
    const result = await service.userBailEvents(req.vlabUser, limit ? parseInt(limit) : 100);
    res.status(200).json(result);
  } catch (err) {
    handle(err, res);
  }
};

exports.validateUserAccess = validateUserAccess;
