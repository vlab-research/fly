'use strict';

const {
  selectNumbers,
  shapeNumberHealth,
  registrationNeeded,
  generatePin,
  parseRegisterResponse,
} = require('./whatsapp.core');

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

/**
 * Registers one of the caller's WhatsApp numbers with the Cloud API, shared by
 * the REST route and the MCP tool. Safe to repeat: a number already CONNECTED
 * is not registered again, and the PIN is created once and reused. Neither the
 * PIN nor the token is returned or logged.
 *
 * @param {Object} deps
 * @param {Function} deps.listAccounts - async ({ email }) => messaging credential rows
 * @param {Function} deps.healthClient - async (phoneNumberId, accessToken) => Graph JSON
 * @param {Function} deps.registerClient - async (phoneNumberId, pin, accessToken) => Graph JSON
 * @param {Object} deps.pinStore - { get({ email, phoneNumberId }) => pin | undefined,
 *   createIfAbsent({ email, phoneNumberId, pin }) }
 * @param {Function} deps.randomInt - crypto.randomInt
 * @returns {Function} async ({ email, phoneNumberId }) =>
 *   { ok: true, registration, registration_error, number } | { ok: false, error, known }
 */
function makeRegisterNumber({ listAccounts, healthClient, registerClient, pinStore, randomInt }) {
  async function readHealth(id, accessToken) {
    return shapeNumberHealth(id, await healthClient(id, accessToken));
  }

  // The insert is a no-op when a PIN already exists, so of two concurrent
  // first registrations both end up using whichever PIN was stored first.
  async function pinFor(email, phoneNumberId) {
    const existing = await pinStore.get({ email, phoneNumberId });
    if (existing) return existing;
    await pinStore.createIfAbsent({ email, phoneNumberId, pin: generatePin(randomInt) });
    const stored = await pinStore.get({ email, phoneNumberId });
    if (!stored) throw new Error(`No registration PIN could be stored for phone_number_id ${phoneNumberId}`);
    return stored;
  }

  return async function registerNumber({ email, phoneNumberId }) {
    const selected = selectNumbers(await listAccounts({ email }), [phoneNumberId]);
    if (!selected.ok) return selected;
    const [{ id, accessToken }] = selected.numbers;

    const before = await readHealth(id, accessToken);
    if (before.error) {
      return { ok: true, registration: 'health_unreadable', registration_error: before.error, number: before };
    }
    if (!registrationNeeded(before)) {
      return { ok: true, registration: 'already_registered', registration_error: null, number: before };
    }

    const pin = await pinFor(email, id);
    const registered = parseRegisterResponse(await registerClient(id, pin, accessToken), pin);
    const after = await readHealth(id, accessToken);
    return registered.ok
      ? { ok: true, registration: 'registered', registration_error: null, number: after }
      : { ok: true, registration: 'failed', registration_error: registered.error, number: after };
  };
}

module.exports = { makeNumberHealth, makeRegisterNumber };
