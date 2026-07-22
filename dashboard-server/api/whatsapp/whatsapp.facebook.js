'use strict';

const r2 = require('r2');
const fb = require('../../config').FACEBOOK;

/**
 * Exchanges an OAuth authorization code for a WhatsApp Business Account access token.
 * This is the IO boundary -- it makes the actual HTTP request to Facebook.
 *
 * @param {string} code - OAuth authorization code from FB.login callback
 * @returns {Promise<Object>} - Facebook's JSON response { access_token, token_type } or { error: {...} }
 */
async function facebookExchangeCode(code) {
  const params = new URLSearchParams({
    client_id: fb.id,
    client_secret: fb.secret,
    code,
  });

  const url = `${fb.url}/oauth/access_token?${params.toString()}`;
  try {
    // Same r2 usage as api/facebook/facebook.controller.js
    return await r2.get(url).json;
  } catch (err) {
    // Sanitize: never leak the client_secret in error messages
    const safeMsg = (err.message || '').replace(/client_secret=[^&\s]+/g, 'client_secret=REDACTED');
    throw new Error(safeMsg);
  }
}

module.exports = { facebookExchangeCode };
