'use strict';

/*
 * Functional core of API-key authentication (VIR-37 phase 1).
 *
 * PURE ONLY. No database, no network, no `Date.now()` — every function that
 * needs the clock takes `now`. The shell is `middleware/auth.js` (verification)
 * and `api/auth/auth.routes.js` (minting and revocation).
 *
 * THE MODEL
 *
 * A researcher API key is an HS256 JWT plus a `credentials` row. The token is
 * never stored, so the row is the only revocable thing: validity is POSITIVE —
 * a key is live iff its row is live — rather than a denylist of dead tokens.
 * The `jti` claim is what ties one to the other, so deleting a key and creating
 * a new one with the same name does not resurrect the old token.
 *
 * THREE KINDS OF TOKEN reach this code, all signed with the same secret:
 *
 *   1. jti tokens      — minted after this migration. Row required, scopes honoured.
 *   2. legacy api keys — minted before it. No jti, but they DO carry the
 *                        token-name claim, which is what makes them revocable
 *                        by (email, name) instead of not at all.
 *   3. internal service JWTs — replybot signs `{}`, hermes signs `{iat, exp}`.
 *                        No name, no jti, no scopes: no lookup, full access.
 *
 * Kind 3 is why `exp` is not required by the verifier and why an absent scopes
 * claim means UNRESTRICTED rather than "no permissions".
 */

// Namespaced to match the existing token-name claim, and so nothing here can
// ever collide with Auth0's own `scope`/`permissions` claims on RS256 tokens.
const NAME_CLAIM = 'https://vlab.digital/token-name';
const SCOPES_CLAIM = 'https://vlab.digital/scopes';

// Newly minted researcher keys only. Never applied to internal service JWTs.
const API_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

// How long a credentials-row lookup is cached in-process. Revocation therefore
// takes effect within this window, per replica — eviction on revoke is local
// and other replicas wait out the TTL. Short enough that a leaked key is dead
// in well under a minute; long enough that a busy agent is not one DB
// round-trip per request.
const CREDENTIAL_CACHE_TTL_MS = 30 * 1000;

const ANY = '*';
const READ = 'read';
const WRITE = 'write';
const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/*
 * Top-level /api/v1 path segment -> scope resource.
 *
 * `responses` is deliberately NOT folded into `surveys`: survey definitions are
 * the researcher's own configuration, responses are respondent data. A key that
 * reads study structure without reading people's answers is the distinction
 * worth being able to express.
 *
 * A segment absent from this map has no scope, and a scoped token is DENIED on
 * it (fail closed). New routes must be added here to be reachable by scoped
 * keys; unscoped keys and internal services are unaffected.
 */
const ROUTE_RESOURCES = {
  surveys: 'surveys',
  /*
   * Typeform is where survey content is authored, so it belongs to `surveys`
   * rather than to `credentials`: a survey key must be able to GET
   * /typeform/form to check a formid before registering it, which is the step
   * that catches a bad id before it becomes a silently broken survey. It reads
   * and spends only the caller's own typeform_token, which stays unreadable
   * through /credentials.
   */
  typeform: 'surveys',
  responses: 'responses',
  exports: 'exports',
  media: 'media',
  credentials: 'credentials',
  facebook: 'credentials',
  whatsapp: 'credentials',
  'message-templates': 'templates',
  tickets: 'tickets',
  users: 'users',
  platform: 'platform',
  // Key management. Never implicitly granted: a scoped key that could mint an
  // unscoped one is not scoped at all.
  auth: 'auth',
};

/*
 * Paths whose authorization this layer cannot decide, and must hand downstream.
 *
 * /mcp is a JSON-RPC tunnel: one POST reaches every tool and the tool name is
 * in the BODY, so no path-based map can see what is being asked for. Giving it
 * its own `mcp:*` resource was worse than useless — a `surveys:read` key could
 * not call list_surveys, while an `mcp:write` key could call every tool there
 * is. That is the opposite of scoping.
 *
 * So the route lets any authenticated key through and the MCP dispatcher
 * enforces the real scope per tool (TOOL_SCOPES in api/mcp/mcp.tools.js) from
 * the scopes this middleware leaves on req.apiScopes. That check is NOT
 * optional: it is the only scope enforcement /mcp gets.
 */
const DELEGATED_RESOURCES = ['mcp'];

function isDelegatedPath(path) {
  const segment = String(path || '').split('?')[0].split('/').filter(Boolean)[0];
  return DELEGATED_RESOURCES.includes(segment);
}

const RESOURCES = Array.from(new Set(Object.values(ROUTE_RESOURCES)));
const ACTIONS = [READ, WRITE, ANY];

// What the MCP work needs: study structure, no respondent data, no writes.
const SURVEY_READONLY_SCOPES = ['surveys:read'];

function parseScope(scope) {
  const [resource, action] = String(scope).split(':');
  return { resource, action };
}

function isKnownScope(scope) {
  if (scope === ANY) return true;
  const { resource, action } = parseScope(scope);
  return RESOURCES.includes(resource) && ACTIONS.includes(action);
}

/*
 * Does holding `granted` satisfy a need for `required`?
 *
 * `write` implies `read` on the same resource: every write route in this
 * codebase reads its own object back, and a key that can edit a survey but not
 * see it is not a permission anyone means to hand out.
 */
function scopeGrants(granted, required) {
  if (granted === ANY) return true;
  if (required === ANY) return false;

  const g = parseScope(granted);
  const r = parseScope(required);
  if (g.resource !== r.resource) return false;
  if (g.action === ANY) return true;
  if (r.action === ANY) return false;
  return g.action === r.action || (g.action === WRITE && r.action === READ);
}

function actionForMethod(method) {
  return READ_METHODS.includes(String(method || '').toUpperCase()) ? READ : WRITE;
}

/*
 * The scope a request needs, or null when the path maps to no known resource.
 * `path` is the URL as seen inside the middleware mounted on /api/v1, so it has
 * already been stripped of that prefix.
 */
function requiredScope(method, path) {
  // Strips a query string so this is correct whether it is handed req.path or
  // req.url — the difference is invisible until a scoped key hits a 403.
  const segment = String(path || '').split('?')[0].split('/').filter(Boolean)[0];
  const resource = segment && ROUTE_RESOURCES[segment];
  if (!resource) return null;
  return `${resource}:${actionForMethod(method)}`;
}

/*
 * null   -> unrestricted (no scopes claim: legacy keys and internal services)
 * array  -> restricted to exactly these, even when empty
 *
 * Anything that is neither absent nor a recognisable scope list becomes `[]`,
 * which denies everything, rather than falling back to unrestricted.
 */
function normalizeScopes(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value)) return value.map(String);
  return [];
}

function scopesFromClaims(claims) {
  return normalizeScopes(claims && claims[SCOPES_CLAIM]);
}

function scopesFromDetails(details) {
  return normalizeScopes(details && details.scopes);
}

// The credentials row wins when it has scopes, so narrowing a key's scopes
// takes effect without reissuing it. Our own mint path writes both sides
// identically, so they only diverge if someone edits the row.
function effectiveScopes(claimScopes, rowScopes) {
  return rowScopes !== null && rowScopes !== undefined ? rowScopes : claimScopes;
}

function isAuthorized(scopes, method, path) {
  if (scopes === null || scopes === undefined) return true;
  // `*` means exactly what an absent claim means, including on routes that
  // ROUTE_RESOURCES does not know about yet.
  if (scopes.includes(ANY)) return true;

  // Deferred to the handler, which can see the tool name. An empty scope list
  // still reaches the dispatcher and is denied by every tool there.
  if (isDelegatedPath(path)) return true;

  const required = requiredScope(method, path);
  if (!required) return false;
  return scopes.some(granted => scopeGrants(granted, required));
}

/*
 * Attenuation: a key may only mint a key no more powerful than itself.
 *
 * `callerScopes === null` is today's unscoped researcher key and can grant
 * anything. A `requested` of null is the same thing on the other side —
 * "no scopes" is a request for FULL ACCESS, not for nothing, so it is checked
 * as `*`. Reading it as an empty list instead would let any scoped key mint an
 * unscoped one and make the whole scheme decorative.
 */
function canGrantScopes(callerScopes, requested) {
  if (callerScopes === null || callerScopes === undefined) return true;
  const wanted = requested === null || requested === undefined ? [ANY] : requested;
  return wanted.every(r => callerScopes.some(granted => scopeGrants(granted, r)));
}

/*
 * Validate a scopes list supplied at mint time. Unknown scopes are rejected
 * rather than ignored: `surveys:reed` that silently denied every request would
 * be indistinguishable from a broken key.
 */
function validateScopes(requested) {
  if (requested === null || requested === undefined) return { ok: true, scopes: null };

  const scopes = normalizeScopes(requested);
  if (!Array.isArray(requested) && typeof requested !== 'string') {
    return { ok: false, error: 'scopes must be an array of strings' };
  }
  if (!scopes.length) return { ok: false, error: 'scopes must not be empty' };

  const unknown = scopes.filter(s => !isKnownScope(s));
  if (unknown.length) {
    return {
      ok: false,
      error: `unknown scope(s): ${unknown.join(', ')}. Valid resources: ${RESOURCES.join(', ')}; valid actions: ${ACTIONS.join(', ')}`,
    };
  }
  return { ok: true, scopes: Array.from(new Set(scopes)) };
}

/*
 * Cache keys, derived here so the verifier that fills the cache and the revoke
 * route that evicts from it cannot disagree about a key's identity.
 */
function jtiCacheKey(jti) {
  return `jti:${jti}`;
}

function nameCacheKey(email, name) {
  return `name:${email} ${name}`;
}

/*
 * What the verifier has to look up for a token, or null when there is nothing
 * to look up (an internal service JWT).
 */
function apiTokenLookup(claims) {
  if (!claims) return null;
  if (claims.jti) return { kind: 'jti', jti: claims.jti, cacheKey: jtiCacheKey(claims.jti) };

  const name = claims[NAME_CLAIM];
  const email = claims.email;
  if (name && email) {
    return { kind: 'name', email, name, cacheKey: nameCacheKey(email, name) };
  }
  return null;
}

function buildApiTokenClaims({ email, name, jti, scopes }) {
  const claims = { email, [NAME_CLAIM]: name, jti };
  if (scopes) claims[SCOPES_CLAIM] = scopes;
  return claims;
}

function buildApiTokenDetails({ name, jti, scopes, now, ttlSeconds = API_TOKEN_TTL_SECONDS }) {
  const details = {
    name,
    jti,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlSeconds * 1000).toISOString(),
  };
  if (scopes) details.scopes = scopes;
  return details;
}

/*
 * Bounded TTL cache. Stateful but IO-free and clock-injected, so its expiry and
 * eviction behaviour is asserted by passing `now` rather than by sleeping.
 *
 * `get` returns `undefined` for a miss and the stored value otherwise, so a
 * cached `null` (token known not to exist) is distinguishable from a miss.
 * Negative caching is the point: an attacker replaying random jtis must not
 * turn into one database read per request.
 */
function makeTtlCache({ ttlMs, maxEntries = 5000 }) {
  const entries = new Map();

  return {
    get(key, now) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now >= entry.expiresAt) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, now) {
      // Map iterates in insertion order, so the first key is the oldest write.
      if (!entries.has(key) && entries.size >= maxEntries) {
        entries.delete(entries.keys().next().value);
      }
      entries.set(key, { value, expiresAt: now + ttlMs });
    },
    delete(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
    size() {
      return entries.size;
    },
  };
}

module.exports = {
  NAME_CLAIM,
  SCOPES_CLAIM,
  API_TOKEN_TTL_SECONDS,
  CREDENTIAL_CACHE_TTL_MS,
  ROUTE_RESOURCES,
  DELEGATED_RESOURCES,
  isDelegatedPath,
  RESOURCES,
  ACTIONS,
  SURVEY_READONLY_SCOPES,
  actionForMethod,
  requiredScope,
  scopeGrants,
  normalizeScopes,
  scopesFromClaims,
  scopesFromDetails,
  effectiveScopes,
  isAuthorized,
  canGrantScopes,
  validateScopes,
  jtiCacheKey,
  nameCacheKey,
  apiTokenLookup,
  buildApiTokenClaims,
  buildApiTokenDetails,
  makeTtlCache,
};
