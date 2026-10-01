'use strict';

const { selectNumbers, shapeNumberHealth } = require('./whatsapp.core');

/**
 * Live sending health of the caller's WhatsApp numbers, shared by the REST
 * route and the MCP tool. The access token is used here and never returned.
 *
 * @param {Object} deps
 * @param {Function} deps.listAccounts - async ({ email }) => messaging credential rows
 * @param {Function} deps.healthClient - async (phoneNumberId, accessToken) => Graph JSON
 * @returns {Function} async ({ email, phoneNumberIds }) =>
 *   { ok: true, numbers } | { ok: false, error, known }
 */
function makeNumberHealth({ listAccounts, healthClient }) {
  return async function numberHealth({ email, phoneNumberIds = [] }) {
    const selected = selectNumbers(await listAccounts({ email }), phoneNumberIds);
    if (!selected.ok) return selected;
    const numbers = await Promise.all(selected.numbers.map(async ({ id, accessToken }) =>
      shapeNumberHealth(id, await healthClient(id, accessToken))));
    return { ok: true, numbers };
  };
}

module.exports = { makeNumberHealth };
