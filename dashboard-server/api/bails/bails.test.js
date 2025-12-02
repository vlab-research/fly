'use strict';

const request = require('supertest');
const { Pool } = require('pg');
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
  before(async () => {
    authToken = await makeAPIToken({ email });
    vlabPool = new Pool(DATABASE_CONFIG);

    // Create test user
    const user = await User.create({ email });

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
    await vlabPool.end();
  });

  describe('POST /surveys/:surveyId/bails', () => {
    it('returns 401 without authentication', async () => {
      await request(app)
        .post(`/api/v1/surveys/${surveyId}/bails`)
        .send({ name: 'test', definition: {} })
        .expect(401);
    });

    it('returns 400 when name is missing', async () => {
      await request(app)
        .post(`/api/v1/surveys/${surveyId}/bails`)
        .send({ definition: { conditions: { type: 'form', value: 'test' } } })
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(400);
    });

    it('returns 400 when definition is missing', async () => {
      await request(app)
        .post(`/api/v1/surveys/${surveyId}/bails`)
        .send({ name: 'test-bail' })
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(400);
    });

    it('returns 403 for survey user does not own', async () => {
      await request(app)
        .post(`/api/v1/surveys/non-existent-survey/bails`)
        .send({ name: 'test', definition: {} })
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(403);
    });
  });

  describe('GET /surveys/:surveyId/bails', () => {
    it('returns 401 without authentication', async () => {
      await request(app)
        .get(`/api/v1/surveys/${surveyId}/bails`)
        .expect(401);
    });

    it('returns 403 for survey user does not own', async () => {
      await request(app)
        .get(`/api/v1/surveys/non-existent-survey/bails`)
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(403);
    });
  });

  describe('POST /surveys/:surveyId/bails/preview', () => {
    it('returns 400 when definition is missing', async () => {
      await request(app)
        .post(`/api/v1/surveys/${surveyId}/bails/preview`)
        .send({})
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(400);
    });

    it('returns 403 for survey user does not own', async () => {
      await request(app)
        .post(`/api/v1/surveys/non-existent-survey/bails/preview`)
        .send({ definition: {} })
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(403);
    });
  });

  describe('PUT /surveys/:surveyId/bails/:bailId', () => {
    it('returns 401 without authentication', async () => {
      await request(app)
        .put(`/api/v1/surveys/${surveyId}/bails/some-bail-id`)
        .send({ name: 'updated' })
        .expect(401);
    });

    it('returns 403 for survey user does not own', async () => {
      await request(app)
        .put(`/api/v1/surveys/non-existent-survey/bails/some-bail-id`)
        .send({ name: 'updated' })
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(403);
    });
  });

  describe('DELETE /surveys/:surveyId/bails/:bailId', () => {
    it('returns 401 without authentication', async () => {
      await request(app)
        .delete(`/api/v1/surveys/${surveyId}/bails/some-bail-id`)
        .expect(401);
    });

    it('returns 403 for survey user does not own', async () => {
      await request(app)
        .delete(`/api/v1/surveys/non-existent-survey/bails/some-bail-id`)
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(403);
    });
  });

  describe('GET /surveys/:surveyId/bail-events', () => {
    it('returns 401 without authentication', async () => {
      await request(app)
        .get(`/api/v1/surveys/${surveyId}/bail-events`)
        .expect(401);
    });

    it('returns 403 for survey user does not own', async () => {
      await request(app)
        .get(`/api/v1/surveys/non-existent-survey/bail-events`)
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(403);
    });
  });
});
