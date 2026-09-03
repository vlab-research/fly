const request = require('supertest');
const { Pool } = require('pg');
const chai = require('chai');
const should = chai.should(); // eslint-disable-line no-unused-vars
const { expect } = chai;

const { DATABASE_CONFIG } = require('../../config');
const { User, Credential } = require('../../queries');
const { SERVER_JWT: serverConfig } = require('../../config');
const jwt = require('jsonwebtoken')

const app = require('../../server');
const authMiddleware = require('../../middleware/auth');
const { AuthUtil } = require('../../utils');
const { NAME_CLAIM, SCOPES_CLAIM } = require('./auth.core');
const { makeAPIToken, insertIntoCredentials } = AuthUtil;
const email = 'test@vlab.com'

const decode = token => new Promise((resolve, reject) => {
  jwt.verify(token, serverConfig.secret, (err, payload) => {
    if (err) return reject(err)

    resolve(payload)
  })
})

// A path no route claims. It reaches server.js's 404 handler only if the auth
// layer let it through, which makes it a clean probe for "was this allowed"
// with no route behaviour mixed in.
const UNCLAIMED = '/api/v1/nothing-claims-this'

const mint = (token, body) => request(app)
  .post('/api/v1/auth/api-token')
  .send(body)
  .set('Authorization', `Bearer ${token}`)
  .set('Accept', 'application/json')

const revoke = (token, name) => request(app)
  .delete(`/api/v1/auth/api-token?name=${encodeURIComponent(name)}`)
  .set('Authorization', `Bearer ${token}`)
  .set('Accept', 'application/json')

const probe = (token, path = UNCLAIMED, method = 'get') => request(app)[method](path)
  .set('Authorization', `Bearer ${token}`)
  .set('Accept', 'application/json')

// Writes are probed for "not denied" rather than for a status: POST /surveys
// with no body is the auth layer's business only up to the point it hands off.
const allowed = async (...args) => {
  const res = await probe(...args)
  res.status.should.not.be.oneOf([401, 403])
}

const clearApiTokens = pool => pool.query(`DELETE FROM credentials WHERE entity = 'api_token'`)


describe('POST /auth/api-token', () => {
  let authToken;
  let vlabPool;

  before(async () => {
    authToken = await makeAPIToken({ email })

    vlabPool = new Pool(DATABASE_CONFIG);
    await User.create({ email });
  })

  beforeEach(() => authMiddleware.clearCredentialCache())

  afterEach(async () => {
    await clearApiTokens(vlabPool);
  })

  it('returns a token with an email and name inside', async () => {
    const response = await mint(authToken, { name: 'foo' }).expect(201);

    const { token } = response.body;
    const payload = await decode(token)

    payload.email.should.equal('test@vlab.com')
    payload[NAME_CLAIM].should.equal('foo')

    // Check that credentials exist!
    const res = await Credential.get({ email })
    res.length.should.equal(1)
    const creds = res[0]
    creds.key.should.equal('foo')
    creds.details.name.should.equal('foo')
  })

  it('mints the token with a jti that resolves to the credentials row', async () => {
    const response = await mint(authToken, { name: 'foo' }).expect(201);
    const payload = await decode(response.body.token)

    payload.should.have.property('jti')

    const row = await Credential.getApiTokenByJti({ jti: payload.jti })
    row.key.should.equal('foo')
    row.email.should.equal(email)
    row.details.jti.should.equal(payload.jti)
  })

  it('gives newly minted tokens an expiry', async () => {
    const response = await mint(authToken, { name: 'foo' }).expect(201);
    const payload = await decode(response.body.token)

    payload.should.have.property('exp')
    payload.exp.should.be.above(payload.iat)
    response.body.expiresAt.should.be.a('string')
  })

  it('Sends a 400 if the token name already exists', async () => {
    await insertIntoCredentials(email, 'foo')

    await mint(authToken, { name: 'foo' })
      .expect('Content-Type', /json/)
      .expect(400);
  })

  it('Sends a 400 if no name is given', async () => {
    await mint(authToken, {}).expect(400);
  })

  it('writes requested scopes onto both the token and the row', async () => {
    const response = await mint(authToken, { name: 'mcp', scopes: ['surveys:read'] }).expect(201);
    const payload = await decode(response.body.token)

    payload[SCOPES_CLAIM].should.deep.equal(['surveys:read'])
    response.body.scopes.should.deep.equal(['surveys:read'])

    const row = await Credential.getApiTokenByName({ email, name: 'mcp' })
    row.details.scopes.should.deep.equal(['surveys:read'])
  })

  it('rejects an unknown scope rather than minting a key that denies everything', async () => {
    const res = await mint(authToken, { name: 'typo', scopes: ['surveys:reed'] }).expect(400);
    res.body.error.should.match(/unknown scope/)
  })

  it('refuses to let a scoped key mint a more powerful one', async () => {
    const created = await mint(authToken, { name: 'weak', scopes: ['auth:write'] }).expect(201);
    const { token } = created.body

    await mint(token, { name: 'strong' }).expect(403);
    await mint(token, { name: 'strong', scopes: ['surveys:read'] }).expect(403);
    await mint(token, { name: 'equal', scopes: ['auth:write'] }).expect(201);
  })
})


describe('API key scopes', () => {
  let unscopedToken;
  let vlabPool;

  before(async () => {
    unscopedToken = await makeAPIToken({ email })
    vlabPool = new Pool(DATABASE_CONFIG);
    await User.create({ email });
  })

  beforeEach(() => authMiddleware.clearCredentialCache())

  afterEach(async () => {
    await clearApiTokens(vlabPool);
  })

  /*
   * THE BACKWARD-COMPATIBILITY TEST. Every API key minted before VIR-37 and
   * every internal service JWT carries no scopes claim, and must keep the full
   * access it has today. If this fails, replybot and hermes are broken too.
   */
  it('gives a token with no scopes claim full access', async () => {
    await probe(unscopedToken).expect(404);
    await probe(unscopedToken, '/api/v1/surveys').expect(200);
    await allowed(unscopedToken, '/api/v1/responses');
    await allowed(unscopedToken, '/api/v1/surveys', 'post');
  })

  it('lets an internal service JWT with no claims at all through', async () => {
    const internal = await makeAPIToken({})
    await probe(internal).expect(404);
  })

  it('does not require exp, so a non-expiring internal JWT still works', async () => {
    const internal = await makeAPIToken({ iat: Math.floor(Date.now() / 1000) })
    const payload = await decode(internal)

    payload.should.not.have.property('exp')
    await probe(internal).expect(404);
  })

  it('lets a survey-only key read surveys', async () => {
    const created = await mint(unscopedToken, { name: 'mcp', scopes: ['surveys:read'] }).expect(201);
    await probe(created.body.token, '/api/v1/surveys').expect(200);
  })

  it('stops a survey-only key reaching respondent data, credentials or writes', async () => {
    const created = await mint(unscopedToken, { name: 'mcp', scopes: ['surveys:read'] }).expect(201);
    const { token } = created.body

    await probe(token, '/api/v1/responses').expect(403);
    await probe(token, '/api/v1/credentials').expect(403);
    await probe(token, '/api/v1/surveys', 'post').expect(403);
  })

  it('fails closed for a scoped key on a route no scope covers', async () => {
    const created = await mint(unscopedToken, { name: 'mcp', scopes: ['surveys:read'] }).expect(201);
    await probe(created.body.token, UNCLAIMED).expect(403);
  })

  it('lets the credentials row narrow a token that is already in the wild', async () => {
    const created = await mint(unscopedToken, { name: 'mcp', scopes: ['surveys:write'] }).expect(201);
    const { token } = created.body

    await allowed(token, '/api/v1/surveys', 'post');

    const row = await Credential.getApiTokenByName({ email, name: 'mcp' })
    await Credential.update({
      entity: 'api_token',
      key: 'mcp',
      email,
      details: Object.assign({}, row.details, { scopes: ['surveys:read'] }),
    })
    authMiddleware.clearCredentialCache();

    await probe(token, '/api/v1/surveys').expect(200);
    await probe(token, '/api/v1/surveys', 'post').expect(403);
  })
})


describe('DELETE /auth/api-token', () => {
  let authToken;
  let vlabPool;

  before(async () => {
    authToken = await makeAPIToken({ email })
    vlabPool = new Pool(DATABASE_CONFIG);
    await User.create({ email });
  })

  beforeEach(() => authMiddleware.clearCredentialCache())

  afterEach(async () => {
    await clearApiTokens(vlabPool);
  })

  it('deletes the credentials row and kills the token', async () => {
    const created = await mint(authToken, { name: 'doomed' }).expect(201);
    const { token } = created.body

    await probe(token).expect(404);

    await revoke(authToken, 'doomed').expect(200);

    expect(await Credential.getApiTokenByName({ email, name: 'doomed' })).to.equal(undefined)

    const res = await probe(token).expect(401);
    res.body.error.message.should.match(/revoked/)
  })

  /*
   * The reason a jti exists at all. Revoking by name alone would mean a new key
   * with the same name silently brings the revoked one back to life.
   */
  it('does not resurrect a revoked token when the name is reused', async () => {
    const first = await mint(authToken, { name: 'reused' }).expect(201);

    await revoke(authToken, 'reused').expect(200);
    const second = await mint(authToken, { name: 'reused' }).expect(201);

    await probe(second.body.token).expect(404);
    await probe(first.body.token).expect(401);
  })

  it('revokes a legacy key that has no jti, by name', async () => {
    await insertIntoCredentials(email, 'legacy')
    const legacyToken = await makeAPIToken({ email, [NAME_CLAIM]: 'legacy' })

    await probe(legacyToken).expect(404);

    await revoke(authToken, 'legacy').expect(200);

    await probe(legacyToken).expect(401);
  })

  it('404s on a name that is not there', async () => {
    await revoke(authToken, 'never-existed').expect(404);
  })

  it('400s when no name is given', async () => {
    await request(app)
      .delete('/api/v1/auth/api-token')
      .set('Authorization', `Bearer ${authToken}`)
      .set('Accept', 'application/json')
      .expect(400);
  })

  it('cannot revoke another account\'s key of the same name', async () => {
    const other = 'other@vlab.com'
    await User.create({ email: other })
    await insertIntoCredentials(other, 'theirs')

    await revoke(authToken, 'theirs').expect(404);

    const still = await Credential.getApiTokenByName({ email: other, name: 'theirs' })
    still.key.should.equal('theirs')
  })
})
