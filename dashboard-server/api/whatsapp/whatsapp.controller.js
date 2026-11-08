'use strict';

const {
  validateExchangeInput,
  parseExchangeResponse,
  parseSubscribeResponse,
  parsePhoneNumberIds,
} = require('./whatsapp.core');

/**
 * Factory that creates handler functions with injected IO dependencies.
 *
 * @param {Object} deps
 * @param {Function} deps.facebookClient - async (code) => fbResponseBody
 * @param {Function} deps.subscribeClient - async (wabaId, accessToken) => fbResponseBody
 * @param {Function} deps.numberHealth - whatsapp.service#makeNumberHealth's function
 * @param {Function} deps.registerNumber - whatsapp.service#makeRegisterNumber's function
 * @returns {Object} - Express handler functions
 */
function makeHandlers({ facebookClient, subscribeClient, numberHealth, registerNumber }) {

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

  async function getNumberHealth(req, res) {
    try {
      const result = await numberHealth({
        email: req.user.email,
        phoneNumberIds: parsePhoneNumberIds(req.query.phone_number_id),
      });
      if (!result.ok) return res.status(404).json({ error: result.error, known: result.known });
      return res.status(200).json({ numbers: result.numbers });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: e.message || 'Internal server error' });
    }
  }

  // 200 when the number is registered (now or already); 502 when Meta refused
  // the registration or the health read, with the number's health either way.
  async function postRegisterNumber(req, res) {
    const phoneNumberId = req.body && req.body.phone_number_id;
    if (!phoneNumberId || typeof phoneNumberId !== 'string' || phoneNumberId.trim() === '') {
      return res.status(400).json({ error: 'phone_number_id is required' });
    }
    try {
      const result = await registerNumber({ email: req.user.email, phoneNumberId: phoneNumberId.trim() });
      if (!result.ok) return res.status(404).json({ error: result.error, known: result.known });
      const { registration, registration_error, number } = result;
      const status = registration_error ? 502 : 200;
      return res.status(status).json({ registration, registration_error, number });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: e.message || 'Internal server error' });
    }
  }

  return { exchangeCode, getNumberHealth, postRegisterNumber };
}

module.exports = { makeHandlers };
