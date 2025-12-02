'use strict';

const r2 = require('r2');
const Config = require('../../config');

const baseUrl = Config.EXODUS.url;

// Helper for making requests to Exodus API
async function exodusRequest(method, path, body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };

  if (body) {
    opts.body = JSON.stringify(body);
  }

  const res = await r2(`${baseUrl}${path}`, opts).response;

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    const err = new Error(error.message || `Exodus API error: ${res.status}`);
    err.status = res.status;
    throw err;
  }

  // Handle 204 No Content
  if (res.status === 204) {
    return null;
  }

  return res.json();
}

// List all bails for a survey
async function listBails(surveyId) {
  return exodusRequest('GET', `/surveys/${surveyId}/bails`);
}

// Get a single bail
async function getBail(surveyId, bailId) {
  return exodusRequest('GET', `/surveys/${surveyId}/bails/${bailId}`);
}

// Create a new bail
async function createBail(surveyId, bail) {
  return exodusRequest('POST', `/surveys/${surveyId}/bails`, bail);
}

// Update an existing bail
async function updateBail(surveyId, bailId, bail) {
  return exodusRequest('PUT', `/surveys/${surveyId}/bails/${bailId}`, bail);
}

// Delete a bail
async function deleteBail(surveyId, bailId) {
  return exodusRequest('DELETE', `/surveys/${surveyId}/bails/${bailId}`);
}

// Preview bail (dry-run query)
async function previewBail(surveyId, definition) {
  return exodusRequest('POST', `/surveys/${surveyId}/bails/preview`, { definition });
}

// Get events for a specific bail
async function getBailEvents(surveyId, bailId) {
  return exodusRequest('GET', `/surveys/${surveyId}/bails/${bailId}/events`);
}

// Get all bail events for a survey
async function getSurveyEvents(surveyId, limit = 100) {
  return exodusRequest('GET', `/surveys/${surveyId}/bail-events?limit=${limit}`);
}

module.exports = {
  listBails,
  getBail,
  createBail,
  updateBail,
  deleteBail,
  previewBail,
  getBailEvents,
  getSurveyEvents,
};
