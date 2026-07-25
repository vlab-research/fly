'use strict';

/**
 * Validates that code exchange input contains required fields.
 *
 * @param {Object} input
 * @param {string|undefined} input.code - OAuth authorization code from FB.login
 * @param {string|undefined} input.phone_number_id - WhatsApp Business Account phone number ID
 * @param {string|undefined} input.waba_id - WhatsApp Business Account id (webhook subscription target)
 * @returns {{ valid: true } | { valid: false, error: string }}
 */
function validateExchangeInput({ code, phone_number_id, waba_id }) {
  if (!code || typeof code !== 'string' || code.trim() === '') {
    return { valid: false, error: 'code is required' };
  }
  if (!phone_number_id || typeof phone_number_id !== 'string' || phone_number_id.trim() === '') {
    return { valid: false, error: 'phone_number_id is required' };
  }
  if (!waba_id || typeof waba_id !== 'string' || waba_id.trim() === '') {
    return { valid: false, error: 'waba_id is required' };
  }
  return { valid: true };
}

/**
 * Parses Facebook's OAuth access_token response.
 *
 * @param {Object} fbResponse - Raw JSON response from Facebook OAuth endpoint
 * @returns {{ ok: true, accessToken: string } | { ok: false, error: Object }}
 */
function parseExchangeResponse(fbResponse) {
  if (!fbResponse) {
    return { ok: false, error: { message: 'Empty response from Facebook' } };
  }
  if (fbResponse.error) {
    return { ok: false, error: fbResponse.error };
  }
  if (!fbResponse.access_token) {
    return { ok: false, error: { message: 'Facebook response missing access_token' } };
  }
  return { ok: true, accessToken: fbResponse.access_token };
}

/**
 * Parses Facebook's WABA subscribed_apps response.
 * Success shape is { success: true }.
 *
 * @param {Object} fbResponse - Raw JSON response from POST /{waba_id}/subscribed_apps
 * @returns {{ ok: true } | { ok: false, error: Object }}
 */
function parseSubscribeResponse(fbResponse) {
  if (!fbResponse) {
    return { ok: false, error: { message: 'Empty response from Facebook' } };
  }
  if (fbResponse.error) {
    return { ok: false, error: fbResponse.error };
  }
  if (fbResponse.success !== true) {
    return { ok: false, error: { message: 'WABA webhook subscription did not report success' } };
  }
  return { ok: true };
}

module.exports = {
  validateExchangeInput,
  parseExchangeResponse,
  parseSubscribeResponse,
};
