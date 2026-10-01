'use strict';

const request = require('supertest');
const proxyquire = require('proxyquire');
const { Pool } = require('pg');
const { expect } = require('chai');
require('chai').should();

const { DATABASE_CONFIG } = require('../../config');
const { User, Survey } = require('../../queries');
const { AuthUtil } = require('../../utils');
const { makeAPIToken } = AuthUtil;

const app = require('../../server');

const email = 'bails-test@vlab.com';
const surveyId = 'test-survey-shortcode';

describe('Bails API', () => {
  let authToken;
  let vlabPool;
  let userId;
  let anotherUserId;

  before(async () => {
    authToken = await makeAPIToken({ email });
    vlabPool = new Pool(DATABASE_CONFIG);

    // Create test user
    const user = await User.create({ email });
    userId = user.id;

    // Create another user for testing access control
    const anotherUser = await User.create({ email: 'another-user@vlab.com' });
    anotherUserId = anotherUser.id;

    // Create a test survey for the user
    await Survey.create({
      created: new Date(),
      formid: 'test-form-id',
      form: { fields: [] },
      messages: {},
      shortcode: surveyId,
      userid: user.id,
      title: 'Test Survey',
      survey_name: 'Test Survey',
      metadata: {},
      translation_conf: {},
    });
  });

  after(async () => {
    // Clean up test data
    await vlabPool.query(`DELETE FROM surveys WHERE shortcode = $1`, [surveyId]);
    await vlabPool.query(`DELETE FROM users WHERE email = $1`, [email]);
    await vlabPool.query(`DELETE FROM users WHERE email = $1`, ['another-user@vlab.com']);
    await vlabPool.end();
  });

  describe('POST /users/:userId/bails', () => {
    it('returns 401 without authentication', async () => {
      await request(app)
        .post(`/api/v1/users/${userId}/bails`)
        .send({ name: 'test', definition: {} })
        .expect(401);
    });

    it('returns 400 when name is missing', async () => {
      await request(app)
        .post(`/api/v1/users/${userId}/bails`)
        .send({ definition: { conditions: { type: 'form', value: 'test' } } })
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(400);
    });

    it('returns 400 when definition is missing', async () => {
      await request(app)
        .post(`/api/v1/users/${userId}/bails`)
        .send({ name: 'test-bail' })
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(400);
    });

    it('returns 403 for user that is not the authenticated user', async () => {
      await request(app)
        .post(`/api/v1/users/${anotherUserId}/bails`)
        .send({ name: 'test', definition: {} })
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(403);
    });
  });

  describe('GET /users/:userId/bails', () => {
    it('returns 401 without authentication', async () => {
      await request(app)
        .get(`/api/v1/users/${userId}/bails`)
        .expect(401);
    });

    it('returns 403 for user that is not the authenticated user', async () => {
      await request(app)
        .get(`/api/v1/users/${anotherUserId}/bails`)
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(403);
    });
  });

  describe('POST /users/:userId/bails/preview', () => {
    it('returns 400 when definition is missing', async () => {
      await request(app)
        .post(`/api/v1/users/${userId}/bails/preview`)
        .send({})
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(400);
    });

    it('returns 403 for user that is not the authenticated user', async () => {
      await request(app)
        .post(`/api/v1/users/${anotherUserId}/bails/preview`)
        .send({ definition: {} })
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(403);
    });
  });

  describe('PUT /users/:userId/bails/:bailId', () => {
    it('returns 401 without authentication', async () => {
      await request(app)
        .put(`/api/v1/users/${userId}/bails/some-bail-id`)
        .send({ name: 'updated' })
        .expect(401);
    });

    it('returns 403 for user that is not the authenticated user', async () => {
      await request(app)
        .put(`/api/v1/users/${anotherUserId}/bails/some-bail-id`)
        .send({ name: 'updated' })
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(403);
    });
  });

  describe('DELETE /users/:userId/bails/:bailId', () => {
    it('returns 401 without authentication', async () => {
      await request(app)
        .delete(`/api/v1/users/${userId}/bails/some-bail-id`)
        .expect(401);
    });

    it('returns 403 for user that is not the authenticated user', async () => {
      await request(app)
        .delete(`/api/v1/users/${anotherUserId}/bails/some-bail-id`)
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(403);
    });
  });

  describe('GET /users/:userId/bail-events', () => {
    it('returns 401 without authentication', async () => {
      await request(app)
        .get(`/api/v1/users/${userId}/bail-events`)
        .expect(401);
    });

    it('returns 403 for user that is not the authenticated user', async () => {
      await request(app)
        .get(`/api/v1/users/${anotherUserId}/bail-events`)
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(403);
    });
  });
});

/*
 * What actually reaches Exodus, and what comes back.
 *
 * Only `r2` is stubbed, so the controller, the service and utils/bails all run:
 * the request body asserted here is the JSON an Exodus would have received, and
 * the status and message are carried back through the same three layers.
 */
function loadBails(reply) {
  const sent = [];

  const r2Stub = (url, opts) => {
    sent.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
    return {
      response: Promise.resolve({
        ok: reply.status < 400,
        status: reply.status,
        statusText: '',
        json: async () => reply.body,
      }),
    };
  };
  r2Stub['@noCallThru'] = true;

  const BailsUtil = proxyquire('../../utils/bails/bails.util', { r2: r2Stub });
  const service = proxyquire('./bails.service', {
    '../../utils': { BailsUtil, '@noCallThru': true },
  });

  return { controller: proxyquire('./bails.controller', { './bails.service': service }), sent };
}

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return res; };
  res.send = () => res;
  return res;
}

describe('Bails: the Exodus request', () => {
  const definition = {
    type: 'user_list',
    user_list: { users: [{ userid: 'u1', pageid: 'p1', shortcode: 'dest' }] },
    execution: { timing: 'immediate' },
  };

  const created = { status: 201, body: { bail: { id: 'b1' } } };

  async function create(body, reply = created) {
    const { controller, sent } = loadBails(reply);
    const res = fakeRes();
    await controller.createBail({ vlabUser: { id: 'user-1' }, body }, res);
    return { res, sent };
  }

  it('forwards enabled: true on create', async () => {
    const { res, sent } = await create({ name: 'b', definition, enabled: true });

    expect(res.statusCode).to.equal(201);
    expect(sent[0].body.enabled).to.equal(true);
  });

  it('forwards enabled: false on create', async () => {
    const { sent } = await create({ name: 'b', definition, enabled: false });
    expect(sent[0].body.enabled).to.equal(false);
  });

  // Exodus decides what an absent `enabled` means; sending one would take that
  // decision away from it.
  it('sends no enabled at all when the caller omits it', async () => {
    const { sent } = await create({ name: 'b', definition });
    expect(sent[0].body).to.not.have.property('enabled');
  });

  it('sends the definition through untouched', async () => {
    const { sent } = await create({ name: 'b', definition });
    expect(sent[0].body.definition).to.eql(definition);
  });

  // The pageid check is Exodus's: it resolves each entry's platform from the
  // credential behind the account and refuses one the caller does not own.
  it('relays an invalid_pageids rejection with its status and message', async () => {
    const message =
      'no messaging account owned by this user for pageids: p1, p2 ' +
      '(connect them in the dashboard, or use one of your own)';

    const { res } = await create(
      { name: 'b', definition },
      { status: 400, body: { error: 'invalid_pageids', message } },
    );

    expect(res.statusCode).to.equal(400);
    expect(res.body.error.message).to.equal(message);
  });

  it('relays the same rejection from preview', async () => {
    const message = 'no messaging account owned by this user for pageids: p1';
    const { controller } = loadBails({ status: 400, body: { error: 'invalid_pageids', message } });
    const res = fakeRes();

    await controller.previewBail({ vlabUser: { id: 'user-1' }, body: { definition } }, res);

    expect(res.statusCode).to.equal(400);
    expect(res.body.error.message).to.equal(message);
  });
});
