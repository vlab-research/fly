'use strict';

const chai = require('chai');
const should = chai.should(); // eslint-disable-line no-unused-vars

const {
  NAME_CLAIM,
  SCOPES_CLAIM,
  API_TOKEN_TTL_SECONDS,
  CREDENTIAL_CACHE_TTL_MS,
  RESOURCES,
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
} = require('./auth.core');

describe('auth.core: route -> required scope', () => {
  it('maps a method and path onto one scope', () => {
    requiredScope('GET', '/surveys/foo').should.equal('surveys:read');
    requiredScope('POST', '/surveys').should.equal('surveys:write');
    requiredScope('GET', '/responses?form=x').should.equal('responses:read');
    requiredScope('DELETE', '/message-templates/1').should.equal('templates:write');
  });

  it('treats survey sub-resources as surveys, not as their own thing', () => {
    requiredScope('GET', '/surveys/mysurvey/states').should.equal('surveys:read');
    requiredScope('GET', '/surveys/mysurvey/health').should.equal('surveys:read');
  });

  it('keeps responses separate from surveys — respondent data is not study structure', () => {
    requiredScope('GET', '/responses').should.not.equal(requiredScope('GET', '/surveys'));
  });

  it('counts GET, HEAD and OPTIONS as reads and everything else as writes', () => {
    actionForMethod('get').should.equal('read');
    actionForMethod('HEAD').should.equal('read');
    actionForMethod('OPTIONS').should.equal('read');
    ['POST', 'PUT', 'PATCH', 'DELETE'].forEach(m => actionForMethod(m).should.equal('write'));
  });

  it('returns null for a path that maps to no known resource', () => {
    should.equal(requiredScope('GET', '/nonsense'), null);
    should.equal(requiredScope('GET', '/'), null);
    should.equal(requiredScope('GET', ''), null);
  });
});

describe('auth.core: scopeGrants', () => {
  it('grants an exact match', () => {
    scopeGrants('surveys:read', 'surveys:read').should.equal(true);
  });

  it('does not leak across resources', () => {
    scopeGrants('surveys:read', 'responses:read').should.equal(false);
    scopeGrants('surveys:write', 'exports:write').should.equal(false);
  });

  it('lets write imply read on the same resource, but never the reverse', () => {
    scopeGrants('surveys:write', 'surveys:read').should.equal(true);
    scopeGrants('surveys:read', 'surveys:write').should.equal(false);
  });

  it('honours resource and global wildcards', () => {
    scopeGrants('surveys:*', 'surveys:write').should.equal(true);
    scopeGrants('*', 'anything:write').should.equal(true);
    scopeGrants('surveys:write', 'surveys:*').should.equal(false);
    scopeGrants('surveys:*', 'responses:read').should.equal(false);
  });
});

describe('auth.core: normalizeScopes', () => {
  it('reads an absent claim as unrestricted', () => {
    should.equal(normalizeScopes(undefined), null);
    should.equal(normalizeScopes(null), null);
  });

  it('reads an empty array as restricted-to-nothing, NOT as unrestricted', () => {
    normalizeScopes([]).should.deep.equal([]);
  });

  it('accepts a space-delimited string', () => {
    normalizeScopes('surveys:read responses:read').should.deep.equal(['surveys:read', 'responses:read']);
  });

  it('fails closed on a value that is neither absent nor a scope list', () => {
    normalizeScopes(42).should.deep.equal([]);
    normalizeScopes({ surveys: true }).should.deep.equal([]);
  });
});

describe('auth.core: isAuthorized', () => {
  /*
   * THE BACKWARD-COMPATIBILITY INVARIANT. Every API key minted before VIR-37
   * and every internal service JWT (replybot's `{}`, hermes' `{iat, exp}`) has
   * no scopes claim. If this ever flips to deny, every one of them breaks.
   */
  it('gives a token with NO scopes full access', () => {
    isAuthorized(null, 'GET', '/surveys').should.equal(true);
    isAuthorized(null, 'DELETE', '/credentials/x').should.equal(true);
    isAuthorized(null, 'PATCH', '/message-templates').should.equal(true);
    isAuthorized(null, 'POST', '/auth/api-token').should.equal(true);
    isAuthorized(undefined, 'GET', '/nonsense').should.equal(true);
  });

  it('restricts a survey-only key to reading surveys', () => {
    const scopes = SURVEY_READONLY_SCOPES;
    isAuthorized(scopes, 'GET', '/surveys').should.equal(true);
    isAuthorized(scopes, 'GET', '/surveys/abc/states').should.equal(true);
    isAuthorized(scopes, 'POST', '/surveys').should.equal(false);
    isAuthorized(scopes, 'GET', '/responses').should.equal(false);
    isAuthorized(scopes, 'GET', '/credentials').should.equal(false);
  });

  /*
   * The JSON-RPC tunnel is one POST for every tool, so this layer cannot decide
   * it at all and delegates: any key gets through the route, and TOOL_SCOPES in
   * api/mcp/mcp.tools.js decides which tools it may actually run. A survey key
   * must reach list_surveys — that is the point of the endpoint — so gating the
   * route on its own `mcp:*` resource was backwards.
   */
  it('delegates the MCP endpoint rather than gating it on a scope', () => {
    isAuthorized(['surveys:read'], 'POST', '/mcp').should.equal(true);
    isAuthorized([], 'POST', '/mcp').should.equal(true);
  });

  it('no longer knows mcp as a resource, so no key can be minted for it', () => {
    validateScopes(['mcp:write']).ok.should.equal(false);
  });

  it('never lets a scoped key reach key management implicitly', () => {
    isAuthorized(['surveys:*', 'responses:*'], 'POST', '/auth/api-token').should.equal(false);
    isAuthorized(['auth:write'], 'POST', '/auth/api-token').should.equal(true);
  });

  it('denies a scoped key on any path it cannot map to a resource', () => {
    isAuthorized(['*'], 'GET', '/nonsense').should.equal(true);
    isAuthorized(['surveys:read'], 'GET', '/nonsense').should.equal(false);
    isAuthorized([], 'GET', '/surveys').should.equal(false);
  });
});

describe('auth.core: canGrantScopes', () => {
  it('lets an unscoped key grant anything', () => {
    canGrantScopes(null, ['*']).should.equal(true);
    canGrantScopes(null, ['surveys:read']).should.equal(true);
  });

  it('reads a request for NO scopes as a request for full access', () => {
    canGrantScopes(['surveys:read'], null).should.equal(false);
    canGrantScopes(['auth:write'], undefined).should.equal(false);
    canGrantScopes(null, null).should.equal(true);
  });

  it('refuses to let a scoped key mint a more powerful one', () => {
    canGrantScopes(['surveys:read'], ['*']).should.equal(false);
    canGrantScopes(['surveys:read'], ['surveys:write']).should.equal(false);
    canGrantScopes(['surveys:read'], ['responses:read']).should.equal(false);
  });

  it('lets a scoped key mint an equal or narrower one', () => {
    canGrantScopes(['surveys:*'], ['surveys:read']).should.equal(true);
    canGrantScopes(['surveys:write'], ['surveys:read']).should.equal(true);
    canGrantScopes(['surveys:read', 'responses:read'], ['surveys:read']).should.equal(true);
  });
});

describe('auth.core: validateScopes', () => {
  it('accepts an absent list as "unscoped, full access"', () => {
    const r = validateScopes(undefined);
    r.ok.should.equal(true);
    should.equal(r.scopes, null);
  });

  it('accepts and dedupes a known list', () => {
    const r = validateScopes(['surveys:read', 'surveys:read', 'responses:read']);
    r.ok.should.equal(true);
    r.scopes.should.deep.equal(['surveys:read', 'responses:read']);
  });

  it('rejects a typo instead of silently minting a key that denies everything', () => {
    const r = validateScopes(['surveys:reed']);
    r.ok.should.equal(false);
    r.error.should.match(/unknown scope/);
  });

  it('rejects an unknown resource', () => {
    validateScopes(['banking:write']).ok.should.equal(false);
  });

  it('rejects an empty list and a non-list', () => {
    validateScopes([]).ok.should.equal(false);
    validateScopes(7).ok.should.equal(false);
    validateScopes({ a: 1 }).ok.should.equal(false);
  });

  it('names every valid resource in its error, so the message is actionable', () => {
    const r = validateScopes(['nope:read']);
    RESOURCES.forEach(resource => r.error.should.contain(resource));
  });
});

describe('auth.core: apiTokenLookup', () => {
  it('looks a jti token up by jti', () => {
    const lookup = apiTokenLookup({ jti: 'abc', email: 'a@b.com', [NAME_CLAIM]: 'k' });
    lookup.kind.should.equal('jti');
    lookup.cacheKey.should.equal(jtiCacheKey('abc'));
  });

  it('falls back to (email, name) for a legacy key, which is what makes it revocable', () => {
    const lookup = apiTokenLookup({ email: 'a@b.com', [NAME_CLAIM]: 'k' });
    lookup.kind.should.equal('name');
    lookup.email.should.equal('a@b.com');
    lookup.name.should.equal('k');
    lookup.cacheKey.should.equal(nameCacheKey('a@b.com', 'k'));
  });

  it('looks nothing up for an internal service JWT', () => {
    should.equal(apiTokenLookup({}), null);
    should.equal(apiTokenLookup({ iat: 1, exp: 2 }), null);
    should.equal(apiTokenLookup({ email: 'a@b.com' }), null);
    should.equal(apiTokenLookup(undefined), null);
  });
});

describe('auth.core: minted shape', () => {
  const now = Date.parse('2026-09-03T00:00:00.000Z');

  it('puts the jti and the namespaced claims on the token', () => {
    const claims = buildApiTokenClaims({ email: 'a@b.com', name: 'k', jti: 'j', scopes: ['surveys:read'] });
    claims.email.should.equal('a@b.com');
    claims.jti.should.equal('j');
    claims[NAME_CLAIM].should.equal('k');
    claims[SCOPES_CLAIM].should.deep.equal(['surveys:read']);
  });

  it('omits the scopes claim entirely for an unscoped key', () => {
    const claims = buildApiTokenClaims({ email: 'a@b.com', name: 'k', jti: 'j', scopes: null });
    claims.should.not.have.property(SCOPES_CLAIM);
    should.equal(scopesFromClaims(claims), null);
  });

  it('records the jti, scopes and a 90-day expiry on the row', () => {
    const details = buildApiTokenDetails({ name: 'k', jti: 'j', scopes: ['surveys:read'], now });
    details.name.should.equal('k');
    details.jti.should.equal('j');
    details.scopes.should.deep.equal(['surveys:read']);
    Date.parse(details.expires_at).should.equal(now + API_TOKEN_TTL_SECONDS * 1000);
  });

  it('omits scopes from the row for an unscoped key', () => {
    const details = buildApiTokenDetails({ name: 'k', jti: 'j', scopes: null, now });
    details.should.not.have.property('scopes');
    should.equal(scopesFromDetails(details), null);
  });
});

describe('auth.core: effectiveScopes', () => {
  it('lets the credentials row narrow a token without reissuing it', () => {
    effectiveScopes(['surveys:*'], ['surveys:read']).should.deep.equal(['surveys:read']);
    effectiveScopes(null, ['surveys:read']).should.deep.equal(['surveys:read']);
    effectiveScopes(['surveys:read'], []).should.deep.equal([]);
  });

  it('falls back to the claim when the row carries no scopes', () => {
    effectiveScopes(['surveys:read'], null).should.deep.equal(['surveys:read']);
    should.equal(effectiveScopes(null, null), null);
  });
});

describe('auth.core: makeTtlCache', () => {
  it('returns a hit before the TTL and a miss after it', () => {
    const cache = makeTtlCache({ ttlMs: 1000 });
    cache.set('k', { email: 'a@b.com' }, 0);
    cache.get('k', 999).email.should.equal('a@b.com');
    should.equal(cache.get('k', 1000), undefined);
  });

  it('distinguishes a cached negative from a miss', () => {
    const cache = makeTtlCache({ ttlMs: 1000 });
    cache.set('gone', null, 0);
    should.equal(cache.get('gone', 10), null);
    should.equal(cache.get('never-seen', 10), undefined);
  });

  it('evicts on delete, so revocation is immediate on this replica', () => {
    const cache = makeTtlCache({ ttlMs: 1000 });
    cache.set('k', { email: 'a@b.com' }, 0);
    cache.delete('k');
    should.equal(cache.get('k', 10), undefined);
  });

  it('is bounded, so replaying random jtis cannot grow it without limit', () => {
    const cache = makeTtlCache({ ttlMs: 1000, maxEntries: 3 });
    ['a', 'b', 'c', 'd', 'e'].forEach(k => cache.set(k, null, 0));
    cache.size().should.equal(3);
    should.equal(cache.get('a', 10), undefined);
    should.equal(cache.get('e', 10), null);
  });

  it('is configured with a short TTL, so a revoked key dies quickly', () => {
    CREDENTIAL_CACHE_TTL_MS.should.be.at.most(60 * 1000);
  });

  it('lets a survey key reach typeform, which is where survey content lives', () => {
    // GET /typeform/form is how you check a formid before registering it.
    isAuthorized(['surveys:read'], 'GET', '/typeform/form').should.equal(true);
    isAuthorized(['responses:read'], 'GET', '/typeform/form').should.equal(false);
  });
});
