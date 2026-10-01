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

// List all bails for a user
async function listBails(userId) {
  return exodusRequest('GET', `/users/${userId}/bails`);
}

// Get a single bail
async function getBail(userId, bailId) {
  return exodusRequest('GET', `/users/${userId}/bails/${bailId}`);
}

// Create a new bail
async function createBail(userId, bail) {
  return exodusRequest('POST', `/users/${userId}/bails`, bail);
}

// Update an existing bail
async function updateBail(userId, bailId, bail) {
  return exodusRequest('PUT', `/users/${userId}/bails/${bailId}`, bail);
}

// Delete a bail
async function deleteBail(userId, bailId) {
  return exodusRequest('DELETE', `/users/${userId}/bails/${bailId}`);
}

// Preview bail (dry-run query)
async function previewBail(userId, definition) {
  return exodusRequest('POST', `/users/${userId}/bails/preview`, { definition });
}

// Get events for a specific bail
async function getBailEvents(userId, bailId) {
  return exodusRequest('GET', `/users/${userId}/bails/${bailId}/events`);
}

// Get all bail events for a user
async function getUserEvents(userId, limit = 100) {
  return exodusRequest('GET', `/users/${userId}/bail-events?limit=${limit}`);
}

module.exports = {
  listBails,
  getBail,
  createBail,
  updateBail,
  deleteBail,
  previewBail,
  getBailEvents,
  getUserEvents,
};
