const request = require('supertest');
const { Pool } = require('pg');
require('chai').should();

const { DATABASE_CONFIG } = require('../../config');
const { User, Credential } = require('../../queries');
const { SERVER_JWT: serverConfig } = require('../../config');
const jwt = require('jsonwebtoken')

const app = require('../../server');
const { AuthUtil } = require('../../utils');
const { makeAPIToken, insertIntoCredentials } = AuthUtil;
const email = 'test@vlab.com'

describe('POST /auth/api-token', () => {
  let authToken;
  let vlabPool;

  before(async () => {
    authToken = await makeAPIToken({ email })

    vlabPool = new Pool(DATABASE_CONFIG);
    await User.create({ email });
  })

  afterEach(async () => {
    const query = `DELETE FROM credentials`
    await vlabPool.query(query);
  })

  it('returns a token with an email and name inside', async () => {
    let response = await request(app)
      .post(`/api/v1/auth/api-token`)
      .send({ name: 'foo' })
      .set('Authorization', `Bearer ${authToken}`)
      .set('Accept', 'application/json')
      // .expect('Content-Type', /json/)
      .expect(201);

    // console.log(response)

    const { token } = response.body;

    const payload = await new Promise((resolve, reject) => {
      jwt.verify(token, serverConfig.secret, (err, payload) => {
        if (err) return reject(err)

        resolve(payload)
      })
    })

    payload.email.should.equal('test@vlab.com')
    payload['https://vlab.digital/token-name'].should.equal('foo')

    // Check that credentials exist!
    const res = await Credential.get({ email })
    res.length.should.equal(1)
    const creds = res[0]
    creds.key.should.equal('foo')
    creds.details.name.should.equal('foo')
  })


  it('Sends a 400 if the token name already exists', async () => {
    await insertIntoCredentials(email, 'foo')

    await request(app)
      .post(`/api/v1/auth/api-token`)
      .send({ name: 'foo' })
      .set('Authorization', `Bearer ${authToken}`)
      .set('Accept', 'application/json')
      .expect('Content-Type', /json/)
      .expect(400);
  })
})


describe('DELETE /auth/api-token', () => {
  let authToken;

  before(async () => {
    authToken = await makeAPIToken({ email })
  })

  it('adds tokens to revoke table', async () => {
    const token = 'testtoken'

    await request(app)
      .delete(`/api/v1/auth/api-token?token=${token}`)
      .set('Authorization', `Bearer ${authToken}`)
      .set('Accept', 'application/json')
      .expect('Content-Type', /json/)
      .expect(200);



    // check database has new token added to blacklist

  })
})
