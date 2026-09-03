const crypto = require('crypto');
const router = require('express').Router();
const { AuthUtil } = require('../../utils');
const { Credential } = require('../../queries');
const authMiddleware = require('../../middleware/auth');
const {
  API_TOKEN_TTL_SECONDS,
  buildApiTokenClaims,
  buildApiTokenDetails,
  canGrantScopes,
  jtiCacheKey,
  nameCacheKey,
  scopesFromClaims,
  validateScopes,
} = require('./auth.core');
const { makeAPIToken, insertIntoCredentials } = AuthUtil;


async function createApiToken(req, res) {
  const { email } = req.user;
  const { name, scopes: requested } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'You must provide a name for the API Key' })
  }

  const validated = validateScopes(requested)
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error })
  }

  // Attenuation: a key may only mint a key no more powerful than itself.
  // Without this, a scoped key holding auth:write could mint an unscoped one
  // and scoping would be decoration.
  //
  // req.apiScopes is what the middleware actually authorized this request with,
  // which is the credentials row's scopes when they differ from the token's.
  // Reading the claim instead would let a key narrowed by editing its row keep
  // minting at its original breadth.
  const callerScopes = req.apiScopes !== undefined ? req.apiScopes : scopesFromClaims(req.user)
  if (!canGrantScopes(callerScopes, validated.scopes)) {
    return res.status(403).json({ error: 'You cannot grant scopes beyond those of the key you are using' })
  }

  const jti = crypto.randomUUID()
  const details = buildApiTokenDetails({ name, jti, scopes: validated.scopes, now: Date.now() })

  const token = await makeAPIToken(
    buildApiTokenClaims({ email, name, jti, scopes: validated.scopes }),
    { expiresIn: API_TOKEN_TTL_SECONDS }
  )

  try {
    // The row is written after the token is signed and is what makes it valid:
    // if this insert fails, the minted token matches no row and is already dead.
    const cred = await insertIntoCredentials(email, name, details)
    res.status(201).json({
      name: cred.details.name,
      token,
      scopes: cred.details.scopes || null,
      expiresAt: cred.details.expires_at,
    })
  } catch (e) {

    if (e.code === '23505') {
      res.status(400).json({ error: 'Sorry, there is already an API Key with that name' })
    } else {
      res.status(500).json({ error: e })
    }
  }

}

/*
 * Revocation, by NAME rather than by token.
 *
 * The name is the only handle a researcher durably has: the token is shown once
 * and never stored, so `?token=` — what the previous stub took — could only ever
 * revoke a key you still possess, which is the opposite of the case revocation
 * exists for. It also puts the secret in a URL, and morgan logs URLs.
 *
 * The row IS the credential, so deleting it is the revocation. Every replica
 * honours that within the credential cache TTL; this one honours it at once.
 */
async function revokeApiToken(req, res) {
  const { email } = req.user;
  const name = req.query.name || (req.body && req.body.name);

  if (!name) {
    return res.status(400).json({ error: 'You must provide the name of the API Key to revoke' })
  }

  const deleted = await Credential.deleteApiToken({ email, name })

  if (!deleted) {
    return res.status(404).json({ error: 'No API Key with that name' })
  }

  const details = deleted.details || {}
  authMiddleware.forgetCredential(nameCacheKey(email, name))
  if (details.jti) authMiddleware.forgetCredential(jtiCacheKey(details.jti))

  res.status(200).json({ name: deleted.key, revoked: true })
}

router.post('/api-token', createApiToken);
router.delete('/api-token', revokeApiToken);

module.exports = router;
