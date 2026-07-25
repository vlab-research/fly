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

/**
 * Subscribes our app to a customer WABA's webhooks. Without this, messages to
 * the WABA's numbers never reach our webhook — the credential would be a
 * silently-broken integration.
 *
 * @param {string} wabaId - WhatsApp Business Account id (from Embedded Signup)
 * @param {string} accessToken - Business token from the code exchange
 * @returns {Promise<Object>} - Facebook's JSON response { success: true } or { error: {...} }
 */
async function facebookSubscribeWaba(wabaId, accessToken) {
  const url = `${fb.url}/${wabaId}/subscribed_apps?access_token=${encodeURIComponent(accessToken)}`;
  try {
    return await r2.post(url).json;
  } catch (err) {
    // Sanitize: never leak the access token in error messages
    const safeMsg = (err.message || '').replace(/access_token=[^&\s]+/g, 'access_token=REDACTED');
    throw new Error(safeMsg);
  }
}

module.exports = { facebookExchangeCode, facebookSubscribeWaba };
