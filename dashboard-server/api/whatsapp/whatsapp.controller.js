'use strict';

const { validateExchangeInput, parseExchangeResponse } = require('./whatsapp.core');

/**
 * Factory that creates handler functions with injected IO dependencies.
 *
 * @param {Object} deps
 * @param {Function} deps.facebookClient - async (code) => fbResponseBody
 * @returns {Object} - Express handler functions
 */
function makeHandlers({ facebookClient }) {

  async function exchangeCode(req, res) {
    const { code, phone_number_id } = req.body;

    // 1. Validate inputs (pure)
    const validation = validateExchangeInput({ code, phone_number_id });
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

      // 4. Return access token and phone_number_id (both needed by frontend)
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
