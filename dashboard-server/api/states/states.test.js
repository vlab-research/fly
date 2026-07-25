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

    // Create credentials so the pageid scoping (states.pageid IN credentials
    // owned by this user) includes our test page. Invariant: for messaging
    // entities, key IS the account id (= details->>'id').
    await vlabPool.query(
      `INSERT INTO credentials (userid, entity, key, details) VALUES ($1, 'facebook_page', 'page-123', $2)`,
      [user.id, JSON.stringify({ id: 'page-123' })]
    );

    // Anchor times: surveys created BEFORE state start times so the lateral
    // version-resolution join (created <= form_start_time) matches.
    const surveyCreated = new Date(Date.now() - 60000);
    const formStartMs = Date.now() - 30000;
    const formStartJson = { md: { startTime: String(formStartMs) } };

    // Create two test surveys with the same survey_name but different shortcodes
    await Survey.create({
      created: surveyCreated,
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
      created: surveyCreated,
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

    // Insert test state rows. state_json carries forms (for current_form
    // computed column), md.startTime (for form_start_time), error.tag (for
    // error_tag), and qa arrays (for stuck_on_question) so all computed
    // columns derive correctly.
    const stateRows = [
      {
        userid: 'test-user-1',
        pageid: 'page-123',
        current_state: 'RESPONDING',
        state_json: { ...formStartJson, forms: [shortcode1], qa: [['Q1', 'A1']] },
        updated: new Date(),
      },
      {
        userid: 'test-user-2',
        pageid: 'page-123',
        current_state: 'ERROR',
        // stuck_on_question derives to 'Q2' (last 3 qa entries all Q2)
        state_json: { ...formStartJson, forms: [shortcode1], qa: [['Q1', 'A1'], ['Q2', 'A2'], ['Q2', 'A3'], ['Q2', 'A4']], error: { tag: 'VALIDATION_ERROR' } },
        updated: new Date(),
      },
      {
        userid: 'test-user-3',
        pageid: 'page-123',
        current_state: 'WAIT_EXTERNAL_EVENT',
        // timeout_date derives from wait.type='timeout' + value.type='absolute'
        state_json: { ...formStartJson, forms: [shortcode2], qa: [['Q1', 'A1']], wait: { type: 'timeout', value: { type: 'absolute', timeout: new Date(Date.now() + 86400000).toISOString() } } },
        updated: new Date(),
      },
      {
        userid: 'test-user-4',
        pageid: 'page-123',
        current_state: 'END',
        state_json: { ...formStartJson, forms: [shortcode2], qa: [['Q1', 'A1'], ['Q2', 'A2']] },
        updated: new Date(),
      },
      {
        userid: 'test-user-5',
        pageid: 'page-123',
        current_state: 'ERROR',
        state_json: { ...formStartJson, forms: [shortcode1], qa: [], error: { tag: 'TIMEOUT_ERROR' } },
        updated: new Date(),
      },
      {
        userid: 'test-user-6',
        pageid: 'page-123',
        current_state: 'BLOCKED',
        state_json: { ...formStartJson, forms: [shortcode1], qa: [['Q1', 'A1']], error: { tag: 'FB' } },
        updated: new Date(),
      },
    ];

    for (const row of stateRows) {
      testUserIds.push(row.userid);
      await vlabPool.query(
        `INSERT INTO states (userid, pageid, current_state, state_json, updated)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          row.userid,
          row.pageid,
          row.current_state,
          row.state_json,
          row.updated,
        ]
      );
    }
  });

  after(async () => {
    // Clean up test data
    for (const userid of testUserIds) {
      await vlabPool.query(`DELETE FROM states WHERE userid = $1`, [userid]);
    }
    await vlabPool.query(`DELETE FROM credentials WHERE entity = 'facebook_page' AND details->>'id' = 'page-123'`);
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

      response.body.should.have.property('summary');
      response.body.summary.should.be.an('array');
      response.body.summary.length.should.be.greaterThan(0);

      // Check structure of results
      const firstItem = response.body.summary[0];
      firstItem.should.have.property('current_state');
      firstItem.should.have.property('current_form');
      firstItem.should.have.property('count');

      // Verify we have counts for our test data
      const errorInShortcode1 = response.body.summary.find(
        item => item.current_state === 'ERROR' && item.current_form === shortcode1
      );
      errorInShortcode1.should.be.an('object');
      parseInt(errorInShortcode1.count, 10).should.equal(2); // test-user-2 and test-user-5
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
      parseInt(response.body.total, 10).should.equal(6);

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
      parseInt(response.body.total, 10).should.equal(2); // test-user-2 and test-user-5
      response.body.states.forEach(state => {
        state.current_state.should.equal('ERROR');
      });
    });

    it('filters by error_tag with partial match (case-insensitive ILIKE)', async () => {
      const response = await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent(surveyName)}/states`)
        .query({ error_tag: 'validation' })
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(200);

      response.body.states.should.be.an('array');
      parseInt(response.body.total, 10).should.equal(1); // test-user-2
      response.body.states[0].userid.should.equal('test-user-2');
      response.body.states[0].error_tag.should.equal('VALIDATION_ERROR');
    });

    it('filters by error_tag across all states (FB tag is in BLOCKED, not ERROR)', async () => {
      const response = await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent(surveyName)}/states`)
        .query({ error_tag: 'FB' })
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(200);

      response.body.states.should.be.an('array');
      parseInt(response.body.total, 10).should.equal(1); // test-user-6 in BLOCKED state
      response.body.states[0].userid.should.equal('test-user-6');
      response.body.states[0].error_tag.should.equal('FB');
      response.body.states[0].current_state.should.equal('BLOCKED');
    });

    it('filters by search (userid) correctly', async () => {
      const response = await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent(surveyName)}/states`)
        .query({ search: 'user-3' })
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(200);

      response.body.states.should.be.an('array');
      parseInt(response.body.total, 10).should.equal(1);
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
      parseInt(page1.body.total, 10).should.equal(6);

      // Get second page
      const page2 = await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent(surveyName)}/states`)
        .query({ limit: 2, offset: 2 })
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(200);

      page2.body.states.length.should.equal(2);
      parseInt(page2.body.total, 10).should.equal(6);

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
        `INSERT INTO states (userid, pageid, current_state, state_json, updated)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          otherUserId,
          'page-123',
          'RESPONDING',
          { md: { startTime: String(Date.now()) }, forms: [otherShortcode], qa: [] },
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

  describe('cross-survey shortcode isolation', () => {
    // Same owner, same shortcode reused across two survey_names, with
    // different versions over time. Monitor must attribute each state row
    // to the correct survey_name via timestamp-based version resolution.
    const collisionEmail = 'states-collision@vlab.com';
    const sharedShortcode = 'collision-shortcode';
    const surveyNameA = 'Collision Survey A';
    const surveyNameB = 'Collision Survey B';
    const userInA = 'collision-user-a';
    const userInB = 'collision-user-b';
    let collisionToken;

    before(async () => {
      collisionToken = await makeAPIToken({ email: collisionEmail });
      const u = await User.create({ email: collisionEmail });

      // Credentials so pageid scoping includes page-c (key = account id invariant)
      await vlabPool.query(
        `INSERT INTO credentials (userid, entity, key, details) VALUES ($1, 'facebook_page', 'page-c', $2)`,
        [u.id, JSON.stringify({ id: 'page-c' })]
      );

      // v1 belongs to survey_name A (older)
      const v1Created = new Date(Date.now() - 120000);
      // v2 belongs to survey_name B (newer)
      const v2Created = new Date(Date.now() - 60000);

      await Survey.create({
        created: v1Created,
        formid: 'collision-v1',
        form: { fields: [] },
        messages: {},
        shortcode: sharedShortcode,
        userid: u.id,
        title: surveyNameA,
        survey_name: surveyNameA,
        metadata: {},
        translation_conf: {},
      });

      await Survey.create({
        created: v2Created,
        formid: 'collision-v2',
        form: { fields: [] },
        messages: {},
        shortcode: sharedShortcode,
        userid: u.id,
        title: surveyNameB,
        survey_name: surveyNameB,
        metadata: {},
        translation_conf: {},
      });

      // User A started while only v1 existed -> belongs to survey_name A
      const userAStart = new Date(Date.now() - 90000).getTime();
      // User B started after v2 was created -> belongs to survey_name B
      const userBStart = new Date(Date.now() - 30000).getTime();

      await vlabPool.query(
        `INSERT INTO states (userid, pageid, current_state, state_json, updated)
         VALUES ($1, $2, $3, $4, $5)`,
        [userInA, 'page-c', 'RESPONDING', { md: { startTime: String(userAStart) }, forms: [sharedShortcode], qa: [] }, new Date()],
      );
      await vlabPool.query(
        `INSERT INTO states (userid, pageid, current_state, state_json, updated)
         VALUES ($1, $2, $3, $4, $5)`,
        [userInB, 'page-c', 'RESPONDING', { md: { startTime: String(userBStart) }, forms: [sharedShortcode], qa: [] }, new Date()],
      );
    });

    after(async () => {
      await vlabPool.query(`DELETE FROM states WHERE userid = ANY($1)`, [[userInA, userInB]]);
      await vlabPool.query(`DELETE FROM credentials WHERE entity = 'facebook_page' AND details->>'id' = 'page-c'`);
      await vlabPool.query(`DELETE FROM surveys WHERE shortcode = $1`, [sharedShortcode]);
      await vlabPool.query(`DELETE FROM users WHERE email = $1`, [collisionEmail]);
    });

    it('list scoped to survey_name A returns only the v1-era user', async () => {
      const response = await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent(surveyNameA)}/states`)
        .set('Authorization', `Bearer ${collisionToken}`)
        .set('Accept', 'application/json')
        .expect(200);

      parseInt(response.body.total, 10).should.equal(1);
      response.body.states[0].userid.should.equal(userInA);
    });

    it('list scoped to survey_name B returns only the v2-era user', async () => {
      const response = await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent(surveyNameB)}/states`)
        .set('Authorization', `Bearer ${collisionToken}`)
        .set('Accept', 'application/json')
        .expect(200);

      parseInt(response.body.total, 10).should.equal(1);
      response.body.states[0].userid.should.equal(userInB);
    });

    it('detail rejects a user that belongs to the other survey_name as 404', async () => {
      // userInB exists but is attributed to survey_name B, so a lookup
      // under survey_name A must not find them.
      await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent(surveyNameA)}/states/${userInB}`)
        .set('Authorization', `Bearer ${collisionToken}`)
        .set('Accept', 'application/json')
        .expect(404);
    });
  });

  describe('unattributable states (form_start_time NULL)', () => {
    // A state row that hasn't started a form yet — e.g. user is in START
    // and state_json has no md.startTime — must not appear under any
    // survey_name (intentional: nothing meaningful to monitor yet).
    const unattribUser = 'unattributable-user';

    before(async () => {
      await vlabPool.query(
        `INSERT INTO states (userid, pageid, current_state, state_json, updated)
         VALUES ($1, $2, $3, $4, $5)`,
        [unattribUser, 'page-123', 'START', { qa: [] }, new Date()],
      );
    });

    after(async () => {
      await vlabPool.query(`DELETE FROM states WHERE userid = $1`, [unattribUser]);
    });

    it('excludes state rows with NULL form_start_time from list', async () => {
      const response = await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent(surveyName)}/states`)
        .query({ search: unattribUser })
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(200);

      parseInt(response.body.total, 10).should.equal(0);
    });
  });
});
