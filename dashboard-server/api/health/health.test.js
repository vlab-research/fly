'use strict';

const request = require('supertest');
const { Pool } = require('pg');
require('chai').should();

const { DATABASE_CONFIG } = require('../../config');
const { User, Survey } = require('../../queries');
const { AuthUtil } = require('../../utils');
const { makeAPIToken } = AuthUtil;

const app = require('../../server');

const email = 'health-test@vlab.com';
const surveyName = 'Test Health Survey';
const shortcode1 = 'test-health-shortcode-1';
const shortcode2 = 'test-health-shortcode-2';

describe('Health API', () => {
  let authToken;
  let vlabPool;
  let testUserIds;

  before(async () => {
    authToken = await makeAPIToken({ email });
    vlabPool = new Pool(DATABASE_CONFIG);
    testUserIds = [];

    const user = await User.create({ email });

    // Credentials so the pageid scoping includes our test page. For
    // messaging-account entities, key IS the account id (= details->>'id').
    await vlabPool.query(
      `INSERT INTO credentials (userid, entity, key, details) VALUES ($1, 'facebook_page', 'page-health', $2)`,
      [user.id, JSON.stringify({ id: 'page-health' })]
    );

    // Surveys created BEFORE state start times so version resolution
    // (created <= form_start_time) matches.
    const surveyCreated = new Date(Date.now() - 60000);
    const formStartMs = Date.now() - 30000;
    const formStartJson = { md: { startTime: String(formStartMs) } };

    for (const shortcode of [shortcode1, shortcode2]) {
      await Survey.create({
        created: surveyCreated,
        formid: `health-form-${shortcode}`,
        form: { fields: [] },
        messages: {},
        shortcode,
        userid: user.id,
        title: surveyName,
        survey_name: surveyName,
        metadata: {},
        translation_conf: {},
      });
    }

    const now = new Date();
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000); // outside 24h window

    // One row per taxonomy case. error_tag derives from state_json.error.tag,
    // fb_error_code from state_json.error.code, stuck_on_question from the
    // last three qa entries sharing a question, timeout_date from wait.
    const stateRows = [
      // active, healthy
      {
        userid: 'health-user-responding',
        current_state: 'RESPONDING',
        state_json: { ...formStartJson, forms: [shortcode1], qa: [['Q1', 'A1']] },
        updated: now,
      },
      // platform error -> error.platform, action at count 1
      {
        userid: 'health-user-platform-error',
        current_state: 'ERROR',
        state_json: { ...formStartJson, forms: [shortcode1], qa: [], error: { tag: 'INTERNAL' } },
        updated: now,
      },
      // study error (no tag -> 'none') -> error.study, trickle note
      {
        userid: 'health-user-study-error',
        current_state: 'ERROR',
        state_json: { ...formStartJson, forms: [shortcode1], qa: [] },
        updated: now,
      },
      // blocked template_missing (code 100) -> action at count 1
      {
        userid: 'health-user-template',
        current_state: 'BLOCKED',
        state_json: { ...formStartJson, forms: [shortcode1], qa: [], error: { tag: 'FB', code: '100' } },
        updated: now,
      },
      // blocked attrition (code 551) -> excluded, no finding
      {
        userid: 'health-user-attrition',
        current_state: 'BLOCKED',
        state_json: { ...formStartJson, forms: [shortcode2], qa: [], error: { tag: 'FB', code: '551' } },
        updated: now,
      },
      // expired wait -> note
      {
        userid: 'health-user-expired',
        current_state: 'WAIT_EXTERNAL_EVENT',
        state_json: {
          ...formStartJson,
          forms: [shortcode2],
          qa: [],
          wait: { type: 'timeout', value: { type: 'absolute', timeout: new Date(Date.now() - 3600000).toISOString() } },
        },
        updated: now,
      },
      // stuck user (last 3 qa entries on Q2) -> note
      {
        userid: 'health-user-stuck',
        current_state: 'RESPONDING',
        state_json: { ...formStartJson, forms: [shortcode1], qa: [['Q1', 'A1'], ['Q2', 'A2'], ['Q2', 'A3'], ['Q2', 'A4']] },
        updated: now,
      },
      // stale platform error, outside the 24h window -> invisible
      {
        userid: 'health-user-stale-error',
        current_state: 'ERROR',
        state_json: { ...formStartJson, forms: [shortcode1], qa: [], error: { tag: 'INTERNAL' } },
        updated: stale,
      },
    ];

    for (const row of stateRows) {
      testUserIds.push(row.userid);
      await vlabPool.query(
        `INSERT INTO states (userid, pageid, current_state, state_json, updated)
         VALUES ($1, $2, $3, $4, $5)`,
        [row.userid, 'page-health', row.current_state, row.state_json, row.updated]
      );
    }

    // A row on a page this user does NOT own — must be invisible even
    // though it shares a shortcode.
    testUserIds.push('health-user-foreign');
    await vlabPool.query(
      `INSERT INTO states (userid, pageid, current_state, state_json, updated)
       VALUES ($1, $2, $3, $4, $5)`,
      ['health-user-foreign', 'page-not-owned', 'ERROR', { ...formStartJson, forms: [shortcode1], qa: [], error: { tag: 'INTERNAL' } }, now]
    );
  });

  after(async () => {
    for (const userid of testUserIds) {
      await vlabPool.query(`DELETE FROM states WHERE userid = $1`, [userid]);
    }
    await vlabPool.query(`DELETE FROM credentials WHERE entity = 'facebook_page' AND details->>'id' = 'page-health'`);
    await vlabPool.query(`DELETE FROM surveys WHERE shortcode = ANY($1)`, [[shortcode1, shortcode2]]);
    await vlabPool.query(`DELETE FROM users WHERE email = $1`, [email]);
    await vlabPool.end();
  });

  describe('GET /surveys/:surveyName/health', () => {
    it('returns 401 without authentication', async () => {
      await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent(surveyName)}/health`)
        .expect(401);
    });

    it('returns 403 for survey user does not own', async () => {
      await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent('Non-Existent Survey')}/health`)
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(403);
    });

    it('returns aggregates per the taxonomy, scoped and windowed', async () => {
      const response = await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent(surveyName)}/health`)
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(200);

      response.body.window_hours.should.equal(24);
      const agg = response.body.aggregates;

      // 7 in-window rows; the stale row and the foreign-page row are invisible.
      agg.active_users.should.equal(7);
      agg.error.platform.should.equal(1); // stale INTERNAL excluded
      agg.error.study.should.equal(1);
      agg.blocked.template_missing.should.equal(1);
      agg.blocked.attrition.should.equal(1);
      agg.blocked.rate_limit.should.equal(0);
      agg.stuck_users.should.equal(1);
      agg.expired_waits.should.equal(1);

      // by_form mirrors the shape per shortcode
      agg.by_form[shortcode1].error.platform.should.equal(1);
      agg.by_form[shortcode2].blocked.attrition.should.equal(1);
    });

    it('returns findings: deterministic actions, stochastic notes, attrition silent', async () => {
      const response = await request(app)
        .get(`/api/v1/surveys/${encodeURIComponent(surveyName)}/health`)
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(200);

      const findings = response.body.findings;
      const ids = findings.map(f => f.id);

      ids.should.include('template-missing');
      ids.should.include('platform-errors');
      ids.should.include('error-trickle'); // 1/7 -> note, not spike (count < 3)
      ids.should.include('stuck-trickle');
      ids.should.include('expired-waits');
      ids.should.not.include('error-spike');

      // attrition never produces a finding
      findings.every(f => !f.id.includes('attrition')).should.equal(true);

      // actions sorted before notes; messages resolved server-side
      findings[0].level.should.equal('action');
      const template = findings.find(f => f.id === 'template-missing');
      template.message.should.contain('1 respondent(s) blocked');
      template.action.dest.should.equal('message-templates');
    });
  });

  describe('GET /platform/notices', () => {
    it('returns 401 without authentication', async () => {
      await request(app)
        .get('/api/v1/platform/notices')
        .expect(401);
    });

    it('returns empty notices when ALERTMANAGER_URL is unset', async () => {
      const response = await request(app)
        .get('/api/v1/platform/notices')
        .set('Authorization', `Bearer ${authToken}`)
        .set('Accept', 'application/json')
        .expect(200);

      response.body.should.deep.equal({ notices: [] });
    });
  });
});
