'use strict';

/**
 * Validates that code exchange input contains required fields.
 *
 * @param {Object} input
 * @param {string|undefined} input.code - OAuth authorization code from FB.login
 * @param {string|undefined} input.phone_number_id - WhatsApp Business Account phone number ID
 * @returns {{ valid: true } | { valid: false, error: string }}
 */
function validateExchangeInput({ code, phone_number_id }) {
  if (!code || typeof code !== 'string' || code.trim() === '') {
    return { valid: false, error: 'code is required' };
  }
  if (!phone_number_id || typeof phone_number_id !== 'string' || phone_number_id.trim() === '') {
    return { valid: false, error: 'phone_number_id is required' };
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

module.exports = {
  validateExchangeInput,
  parseExchangeResponse,
};
