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

// Meta's phone-number fields for the number's sending health. health_status
// is returned as Meta sends it: its entities' errors and additional_info are
// the notes the WhatsApp Manager shows, and they hold no credential.
const HEALTH_FIELDS = [
  'display_phone_number', 'verified_name', 'quality_rating', 'health_status',
  'messaging_limit_tier', 'throughput', 'name_status', 'status',
];

/**
 * `?phone_number_id=` as Express parses it: absent, one value, a repeated
 * parameter (an array) or a comma-separated list.
 *
 * @returns {string[]}
 */
function parsePhoneNumberIds(query) {
  if (query === undefined) return [];
  return [].concat(query).flatMap(v => String(v).split(',')).map(v => v.trim()).filter(Boolean);
}

/**
 * Picks the caller's WhatsApp numbers to read. `requested` empty means all of
 * them; an id the caller does not own is refused with the ids they do own.
 *
 * @param {Array<{entity, key, details}>} rows - the caller's newest messaging credentials
 * @param {string[]} requested - phone_number_ids, possibly empty
 * @returns {{ ok: true, numbers: Array<{ id, accessToken }> } | { ok: false, error: string, known: string[] }}
 */
function selectNumbers(rows, requested) {
  const owned = rows.filter(r => r.entity === 'whatsapp_business');
  const known = owned.map(r => r.key);
  const missing = requested.filter(id => !known.includes(id));
  if (missing.length) {
    return {
      ok: false,
      error: `No WhatsApp number connected to your account with phone_number_id ${missing.join(', ')}`,
      known,
    };
  }
  const chosen = requested.length ? owned.filter(r => requested.includes(r.key)) : owned;
  return {
    ok: true,
    numbers: chosen.map(r => ({ id: r.key, accessToken: (r.details || {}).access_token })),
  };
}

/**
 * Shapes Graph's answer for one phone number. Every field is named, so nothing
 * Meta adds later passes through unseen; a Graph error is kept per number so
 * one broken credential does not hide the others.
 *
 * @param {string} phoneNumberId
 * @param {Object} body - Graph's JSON for GET /{phone_number_id}?fields=HEALTH_FIELDS
 */
function shapeNumberHealth(phoneNumberId, body) {
  const b = body || {};
  const pick = k => (b[k] === undefined ? null : b[k]);
  return {
    phone_number_id: phoneNumberId,
    ...Object.fromEntries(HEALTH_FIELDS.map(k => [k, pick(k)])),
    error: b.error
      ? { code: b.error.code || null, message: b.error.message || null }
      : body ? null : { code: null, message: 'Empty response from Facebook' },
  };
}

module.exports = {
  validateExchangeInput,
  parseExchangeResponse,
  parseSubscribeResponse,
  HEALTH_FIELDS,
  parsePhoneNumberIds,
  selectNumbers,
  shapeNumberHealth,
};
