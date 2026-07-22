'use strict';

const {
  validateExchangeInput,
  parseExchangeResponse,
  parseSubscribeResponse,
} = require('./whatsapp.core');

/**
 * Factory that creates handler functions with injected IO dependencies.
 *
 * @param {Object} deps
 * @param {Function} deps.facebookClient - async (code) => fbResponseBody
 * @param {Function} deps.subscribeClient - async (wabaId, accessToken) => fbResponseBody
 * @returns {Object} - Express handler functions
 */
function makeHandlers({ facebookClient, subscribeClient }) {

  async function exchangeCode(req, res) {
    const { code, phone_number_id, waba_id } = req.body;

    // 1. Validate inputs (pure)
    const validation = validateExchangeInput({ code, phone_number_id, waba_id });
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    try {
      // 2. Exchange code for access token (IO)
      const fbResponseBody = await facebookClient(code);

      // 3. Parse Facebook response (pure)
      const parsed = parseExchangeResponse(fbResponseBody);
      if (!parsed.ok) {
        console.error('Facebook OAuth error:', parsed.error);
        return res.status(400).json({ error: parsed.error });
      }

      // 4. Subscribe our app to the WABA's webhooks (IO). Fail loudly:
      // a credential without a webhook subscription receives no inbound
      // messages, which is a silently-broken integration.
      const subscribeBody = await subscribeClient(waba_id, parsed.accessToken);
      const subscribed = parseSubscribeResponse(subscribeBody);
      if (!subscribed.ok) {
        console.error('WABA subscribe error:', subscribed.error);
        return res.status(502).json({ error: subscribed.error });
      }

      // 5. Return access token and phone_number_id (both needed by frontend)
      return res.status(200).json({
        access_token: parsed.accessToken,
        phone_number_id,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: e.message || 'Internal server error' });
    }
  }

  return { exchangeCode };
}

module.exports = { makeHandlers };
