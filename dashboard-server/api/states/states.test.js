'use strict';

const request = require('supertest');
const { Pool } = require('pg');
require('chai').should();

const { DATABASE_CONFIG } = require('../../config');
const { User, Survey } = require('../../queries');
const { AuthUtil } = require('../../utils');
const { makeAPIToken } = AuthUtil;

const app = require('../../server');

const email = 'states-test@vlab.com';
const surveyName = 'Test States Survey';
const shortcode1 = 'test-states-shortcode-1';
const shortcode2 = 'test-states-shortcode-2';

describe('States API', () => {
  let authToken;
  let vlabPool;
  let testUserIds;

  before(async () => {
    authToken = await makeAPIToken({ email });
    vlabPool = new Pool(DATABASE_CONFIG);
    testUserIds = [];

    // Create test user
    const user = await User.create({ email });

    // Create two test surveys with the same survey_name but different shortcodes
    await Survey.create({
      created: new Date(),
      formid: 'test-form-id-1',
      form: { fields: [] },
      messages: {},
      shortcode: shortcode1,
      userid: user.id,
      title: surveyName,
      survey_name: surveyName,
      metadata: {},
      translation_conf: {},
    });

    await Survey.create({
      created: new Date(),
      formid: 'test-form-id-2',
      form: { fields: [] },
      messages: {},
      shortcode: shortcode2,
      userid: user.id,
      title: surveyName,
      survey_name: surveyName,
      metadata: {},
      translation_conf: {},
    });

    // Insert test state rows with various states
    const stateRows = [
      {
        userid: 'test-user-1',
        pageid: 'page-123',
        current_state: 'RESPONDING',
        current_form: shortcode1,
        state_json: { qa: [{ question: 'Q1', answer: 'A1' }] },
        updated: new Date(),
      },
      {
        userid: 'test-user-2',
        pageid: 'page-123',
        current_state: 'ERROR',
        current_form: shortcode1,
        error_tag: 'VALIDATION_ERROR',
        stuck_on_question: 'Q2',
        state_json: { qa: [{ question: 'Q1', answer: 'A1' }], error: 'Validation failed' },
        updated: new Date(),
      },
      {
        userid: 'test-user-3',
        pageid: 'page-123',
        current_state: 'WAIT_EXTERNAL_EVENT',
        current_form: shortcode2,
        timeout_date: new Date(Date.now() + 86400000), // 1 day from now
        state_json: { qa: [{ question: 'Q1', answer: 'A1' }], wait_condition: 'payment' },
        updated: new Date(),
      },
      {
        userid: 'test-user-4',
        pageid: 'page-123',
        current_state: 'END',
        current_form: shortcode2,
        state_json: { qa: [{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: 'A2' }] },
        updated: new Date(),
      },
      {
        userid: 'test-user-5',
        pageid: 'page-123',
        current_state: 'ERROR',
        current_form: shortcode1,
        error_tag: 'TIMEOUT_ERROR',
        state_json: { qa: [], error: 'Timeout occurred' },
        updated: new Date(),
      },
    ];

    for (const row of stateRows) {
      testUserIds.push(row.userid);
      await vlabPool.query(
        `INSERT INTO states (userid, pageid, current_state, current_form, state_json, updated, error_tag, stuck_on_question, timeout_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          row.userid,
          row.pageid,
          row.current_state,
          row.current_form,
          row.state_json,
          row.updated,
          row.error_tag || null,
          row.stuck_on_question || null,
          row.timeout_date || null,
        ]
      );
    }
  });

  after(async () => {
    // Clean up test data
    for (const userid of testUserIds) {
      await vlabPool.query(`DELETE FROM states WHERE userid = $1`, [userid]);
    }
    await vlabPool.query(`DELETE FROM surveys WHERE shortcode = ANY($1)`, [[shortcode1, shortcode2]]);
    await vlabPool.query(`DELETE FROM users WHERE email = $1`, [email]);
    await vlabPool.end();
  });

  describe('GET /surveys/:surveyName/states/summary', () => {
    it('returns 401 without authentication', async () => {
      await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent(surveyName)}/states/summary`)
        .expect(401);
    });

    it('returns 403 for survey user does not own', async () => {
      await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent('Non-Existent Survey')}/states/summary`)
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(403);
    });

    it('returns grouped counts by state and form', async () => {
      const response = await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent(surveyName)}/states/summary`)
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(200);

      response.body.should.be.an('array');
      response.body.length.should.be.greaterThan(0);

      // Check structure of results
      const firstItem = response.body[0];
      firstItem.should.have.property('current_state');
      firstItem.should.have.property('current_form');
      firstItem.should.have.property('count');

      // Verify we have counts for our test data
      const errorInShortcode1 = response.body.find(
        item => item.current_state === 'ERROR' && item.current_form === shortcode1
      );
      errorInShortcode1.should.be.an('object');
      errorInShortcode1.count.should.equal(2); // test-user-2 and test-user-5
    });
  });

  describe('GET /surveys/:surveyName/states', () => {
    it('returns 401 without authentication', async () => {
      await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent(surveyName)}/states`)
        .expect(401);
    });

    it('returns 403 for survey user does not own', async () => {
      await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent('Non-Existent Survey')}/states`)
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(403);
    });

    it('returns paginated results with correct structure', async () => {
      const response = await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent(surveyName)}/states`)
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(200);

      response.body.should.have.property('states');
      response.body.should.have.property('total');
      response.body.states.should.be.an('array');
      response.body.total.should.equal(5);

      // Check structure of state objects
      const firstState = response.body.states[0];
      firstState.should.have.property('userid');
      firstState.should.have.property('current_state');
      firstState.should.have.property('current_form');
      firstState.should.have.property('updated');
      firstState.should.not.have.property('state_json'); // state_json not in list view
    });

    it('filters by state correctly', async () => {
      const response = await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent(surveyName)}/states`)
        .query({ state: 'ERROR' })
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(200);

      response.body.states.should.be.an('array');
      response.body.total.should.equal(2); // test-user-2 and test-user-5
      response.body.states.forEach(state => {
        state.current_state.should.equal('ERROR');
      });
    });

    it('filters by error_tag correctly', async () => {
      const response = await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent(surveyName)}/states`)
        .query({ error_tag: 'VALIDATION_ERROR' })
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(200);

      response.body.states.should.be.an('array');
      response.body.total.should.equal(1); // test-user-2
      response.body.states[0].userid.should.equal('test-user-2');
      response.body.states[0].error_tag.should.equal('VALIDATION_ERROR');
    });

    it('filters by search (userid) correctly', async () => {
      const response = await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent(surveyName)}/states`)
        .query({ search: 'user-3' })
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(200);

      response.body.states.should.be.an('array');
      response.body.total.should.equal(1);
      response.body.states[0].userid.should.equal('test-user-3');
    });

    it('paginates correctly', async () => {
      // Get first page
      const page1 = await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent(surveyName)}/states`)
        .query({ limit: 2, offset: 0 })
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(200);

      page1.body.states.length.should.equal(2);
      page1.body.total.should.equal(5);

      // Get second page
      const page2 = await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent(surveyName)}/states`)
        .query({ limit: 2, offset: 2 })
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(200);

      page2.body.states.length.should.equal(2);
      page2.body.total.should.equal(5);

      // Ensure different results
      page1.body.states[0].userid.should.not.equal(page2.body.states[0].userid);
    });
  });

  describe('GET /surveys/:surveyName/states/:userid', () => {
    it('returns 401 without authentication', async () => {
      await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent(surveyName)}/states/test-user-1`)
        .expect(401);
    });

    it('returns 403 for survey user does not own', async () => {
      await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent('Non-Existent Survey')}/states/test-user-1`)
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(403);
    });

    it('returns full state detail including state_json', async () => {
      const response = await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent(surveyName)}/states/test-user-2`)
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(200);

      // Check for all expected fields
      response.body.should.have.property('userid', 'test-user-2');
      response.body.should.have.property('pageid');
      response.body.should.have.property('current_state', 'ERROR');
      response.body.should.have.property('current_form', shortcode1);
      response.body.should.have.property('error_tag', 'VALIDATION_ERROR');
      response.body.should.have.property('stuck_on_question', 'Q2');
      response.body.should.have.property('state_json');

      // Verify state_json is present and has expected structure
      response.body.state_json.should.be.an('object');
      response.body.state_json.should.have.property('qa');
      response.body.state_json.qa.should.be.an('array');
    });

    it('returns 404 for nonexistent userid', async () => {
      await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent(surveyName)}/states/nonexistent-user-id`)
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(404);
    });

    it('returns 403 for userid in unauthorized survey', async () => {
      // Create another user and survey
      const otherEmail = 'states-other-test@vlab.com';
      const otherUser = await User.create({ email: otherEmail });
      const otherShortcode = 'test-states-other-shortcode';
      const otherSurveyName = 'Other Test Survey';

      await Survey.create({
        created: new Date(),
        formid: 'other-form-id',
        form: { fields: [] },
        messages: {},
        shortcode: otherShortcode,
        userid: otherUser.id,
        title: otherSurveyName,
        survey_name: otherSurveyName,
        metadata: {},
        translation_conf: {},
      });

      // Insert a state for the other user's survey
      const otherUserId = 'test-user-other';
      await vlabPool.query(
        `INSERT INTO states (userid, pageid, current_state, current_form, state_json, updated)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          otherUserId,
          'page-123',
          'RESPONDING',
          otherShortcode,
          { qa: [] },
          new Date(),
        ]
      );

      // Try to access with original user's token - should get 403
      await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent(otherSurveyName)}/states/${otherUserId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(403);

      // Cleanup
      await vlabPool.query(`DELETE FROM states WHERE userid = $1`, [otherUserId]);
      await vlabPool.query(`DELETE FROM surveys WHERE shortcode = $1`, [otherShortcode]);
      await vlabPool.query(`DELETE FROM users WHERE email = $1`, [otherEmail]);
    });
  });
});
