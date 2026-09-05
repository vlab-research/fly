const jwt = require('express-jwt');

const { JWT: clientConfig, SERVER_JWT: serverConfig } = require('../config');
const { Credential } = require('../queries');
const {
  CREDENTIAL_CACHE_TTL_MS,
  apiTokenLookup,
  effectiveScopes,
  isAuthorized,
  makeTtlCache,
  requiredScope,
  scopesFromClaims,
  scopesFromDetails,
} = require('../api/auth/auth.core');

/*
 * cache key -> {email, scopes} for a live key, or null for one that is gone.
 * Both outcomes are cached: without negative caching, replaying random jtis is
 * one database read per request.
 *
 * Eviction on revoke is process-local, so in a multi-replica deployment a
 * revoked key stays usable on the OTHER replicas for up to
 * CREDENTIAL_CACHE_TTL_MS (30s). That window is the price of not doing a
 * round-trip per request.
 */
const credentialCache = makeTtlCache({ ttlMs: CREDENTIAL_CACHE_TTL_MS });

async function loadCredential(lookup) {
  const cached = credentialCache.get(lookup.cacheKey, Date.now());
  if (cached !== undefined) return cached;

  const row = lookup.kind === 'jti'
    ? await Credential.getApiTokenByJti({ jti: lookup.jti })
    : await Credential.getApiTokenByName({ email: lookup.email, name: lookup.name });

  const value = row ? { email: row.email, scopes: scopesFromDetails(row.details) } : null;
  credentialCache.set(lookup.cacheKey, value, Date.now());
  return value;
}

function unauthorized(res, message) {
  return res.status(401).json({ error: { message } });
}

/*
 * Everything that happens AFTER a token verifies against the server secret.
 *
 * ON THE SHARED SIGNING SECRET: researcher API keys and internal service JWTs
 * (replybot signs `{}`, hermes signs `{iat, exp}`) are signed with the same
 * AUTH0_DASHBOARD_SECRET and are indistinguishable here except by their claims.
 * Splitting the secrets is the real fix and is deliberately NOT done on this
 * branch — the secret is deployed to replybot, hermes and the dashboard, so
 * separating them is a cross-service deploy-coordination problem rather than a
 * code change. Two consequences follow, and both are load-bearing:
 *
 *   - `exp` MUST NOT be required by the verifier. Internal JWTs carry none.
 *   - an ABSENT scopes claim MUST mean unrestricted. Internal JWTs carry none,
 *     and neither does any API key minted before VIR-37.
 */
async function checkServerToken(req, res, next) {
  const claims = req.user;
  const lookup = apiTokenLookup(claims);

  let scopes = scopesFromClaims(claims);

  if (lookup) {
    let credential;
    try {
      credential = await loadCredential(lookup);
    } catch (e) {
      // Fail closed. A key we cannot verify is a key we do not honour.
      return res.status(503).json({ error: { message: 'Could not verify API key.' } });
    }

    if (!credential) return unauthorized(res, 'API key has been revoked.');
    if (claims.email && credential.email !== claims.email) {
      return unauthorized(res, 'API key does not belong to this account.');
    }

    scopes = effectiveScopes(scopes, credential.scopes);
  }

  // Handlers on delegated paths (/mcp) enforce their own scope and need this.
  // `null` means unrestricted here exactly as it does everywhere else.
  req.apiScopes = scopes;

  if (isAuthorized(scopes, req.method, req.path)) return next();

  // Answered here rather than through next(err): server.js's error handler only
  // writes a response for UnauthorizedError, so anything else would hang.
  return res.status(403).json({
    error: {
      message: `This API key is not permitted to ${req.method} ${req.path}.`,
      required: requiredScope(req.method, req.path),
      scopes,
    },
  });
}

// make middleware that tries auth0 client then if that fails
// tries auth0 server application...
function auth(req, res, next) {
  jwt(clientConfig)(req, res, err => {
    if (!err) return next();
    if (err.name !== 'UnauthorizedError') return next(err);

    return jwt(serverConfig)(req, res, err2 => {
      if (err2) return next(err2);

      return checkServerToken(req, res, next);
    });
  });
}

// Revocation evicts locally so the researcher's own next request is denied
// immediately rather than after the TTL.
auth.forgetCredential = cacheKey => credentialCache.delete(cacheKey);
auth.clearCredentialCache = () => credentialCache.clear();

module.exports = auth;
