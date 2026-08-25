const { Pool } = require('pg');
require('chai').should();
require('mocha');

const userModel = require('../users/user.queries');
const surveyModel = require('../surveys/survey.queries');
const model = require('./response.queries');
const token = require('./token');
const request = require('supertest');
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const expect = chai.expect;
chai.use(chaiAsPromised);

const { AuthUtil } = require('../../utils');
const { makeAPIToken } = AuthUtil;
const app = require('../../server');
const { DATABASE_CONFIG } = require('../../config');

describe('Response queries', () => {
  let Response;
  let vlabPool;
  let User;
  let Survey;
  let survey;
  let survey2;
  let surveyName;
  let email;
  let afterParam;


  after(async () => {
    await vlabPool.query("DELETE FROM responses");
    await vlabPool.query("DELETE FROM surveys");
    await vlabPool.query("DELETE FROM users");
  })

  before(async () => {

    vlabPool = new Pool(DATABASE_CONFIG);
    User = userModel.queries(vlabPool);
    Survey = surveyModel.queries(vlabPool);

    await vlabPool.query("DELETE FROM responses");
    await vlabPool.query("DELETE FROM surveys");
    await vlabPool.query("DELETE FROM users");


    Response = model.queries(vlabPool);

    const user = {
      email: 'test3@vlab.com',
    };

    // create and get user, in case already exists
    await User.create(user);
    const newUser = await User.user(user);

    survey = await Survey.create({
      created: new Date(),
      formid: 'biy23',
      form: '{"form": "form detail"}',
      messages: '{"foo": "bar"}',
      shortcode: 231,
      userid: newUser.id,
      title: 'Survey',
      metadata: '{}',
      survey_name: 'Survey123',
      translation_conf: '{}',
    });

    survey2 = await Survey.create({
      created: new Date(),
      formid: '3hu23',
      form: '{"form": "form detail"}',
      messages: '{"foo": "bar"}',
      shortcode: 123,
      userid: newUser.id,
      title: 'Other survey',
      metadata: '{}',
      survey_name: 'Survey321',
      translation_conf: '{}',
    });

    email = user.email
    surveyName = survey.survey_name
    afterParam = null

    // `pageid` is the messaging account, and it became part of the responses primary
    // key in devops/migrations/28a-responses-account-scoped-key.sql -- a conversation
    // is (platform, account_id, user_id), not a user id on its own. The column is
    // NOT NULL with no default, so a fixture has to name the account explicitly;
    // omitting it raises 23502 rather than quietly recording an unattributed
    // response. These rows previously omitted it and asserted `pageid: null`.
    const MOCK_QUERY = `INSERT INTO responses(parent_surveyid, parent_shortcode, surveyid, shortcode, flowid, userid, pageid, question_ref, question_idx, question_text, response, seed, timestamp)
      VALUES
        ('${survey.id}', '231', '${survey.id
      }', '231', 100001, '127', 'page1', 'ref', 10, 'text', 'last', '6789', '${timestamps[1]
      }')
       ,('${survey2.id}', '123', '${survey2.id
      }', '123', 100003, '126', 'page1', 'ref', 10, 'text', 'last', '6789', '${timestamps[1]
      }')
       ,('${survey.id}', '231', '${survey.id
      }', '231', 100004, '127', 'page1', 'ref', 10, 'text', 'first', '6789', '${timestamps[2]
      }')
       ,('${survey.id}', '231', '${survey.id
      }', '231', 100005, '126', 'page1', 'ref', 10, 'text', 'first', '6789', '${timestamps[3]
      }')
       ,('${survey2.id}', '123', '${survey2.id
      }', '123', 100003, '128', 'page1', 'ref', 10, 'text', 'last', '6789', '${timestamps[1]
      }')
       ,('${survey.id}', '231', '${survey.id
      }', '231', 100004, '128', 'page1', 'ref', 10, 'text', 'first', '6789', '${timestamps[2]
      }')
       ,('${survey2.id}', '123', '${survey2.id
      }', '123', 100005, '128', 'page1', 'ref', 10, 'text', 'do not return me', '6789', '${timestamps[3]
      }')`;


    await vlabPool.query(MOCK_QUERY);
  });

  const timestamps = {
    1: '2022-06-06 09:58:00+00:00',
    2: '2022-06-06 10:00:00+00:00',
    3: '2022-06-06 10:02:00+00:00',
  };

  // The query returns `timestamp` as an ISO string (new Date(...).toISOString())
  // while the pagination token encodes CockroachDB's raw ::string rendering,
  // which prints the UTC offset as '+00' rather than '+00:00'.
  const iso = ts => new Date(ts).toISOString();
  const dbText = ts => ts.replace('+00:00', '+00');

  describe('all()', () => {
    it('should return a list of responses for a survey created by a user', async () => {

      const res = await Response.all(email, surveyName, afterParam);
      res.responses.should.eql([
        {
          parent_surveyid: survey.id,
          parent_shortcode: '231',
          shortcode: '231',
          surveyid: survey.id,
          flowid: '100001',
          userid: '127',
          question_ref: 'ref',
          question_idx: '10',
          question_text: 'text',
          response: 'last',
          timestamp: iso(timestamps[1]),
          metadata: null,
          // The MOCK_QUERY insert above omits the metadata column entirely,
          // so it is SQL NULL for every seeded row here — this pins that
          // `responses.metadata->>'ad_id'` on a NULL metadata column comes
          // back as null rather than erroring.
          ad_id: null,
          pageid: 'page1',
          translated_response: null,
          token: token.encoded([dbText(timestamps[1]), '127', 'ref']),
        },
        {
          parent_surveyid: survey.id,
          parent_shortcode: '231',
          shortcode: '231',
          surveyid: survey.id,
          flowid: '100004',
          userid: '127',
          question_ref: 'ref',
          question_idx: '10',
          question_text: 'text',
          response: 'first',
          timestamp: iso(timestamps[2]),
          metadata: null,
          ad_id: null,
          pageid: 'page1',
          translated_response: null,
          token: token.encoded([dbText(timestamps[2]), '127', 'ref']),
        },
        {
          parent_surveyid: survey.id,
          parent_shortcode: '231',
          shortcode: '231',
          surveyid: survey.id,
          flowid: '100004',
          userid: '128',
          question_ref: 'ref',
          question_idx: '10',
          question_text: 'text',
          response: 'first',
          timestamp: iso(timestamps[2]),
          metadata: null,
          ad_id: null,
          pageid: 'page1',
          translated_response: null,
          token: token.encoded([dbText(timestamps[2]), '128', 'ref']),
        },
        {
          parent_surveyid: survey.id,
          parent_shortcode: '231',
          shortcode: '231',
          surveyid: survey.id,
          flowid: '100005',
          userid: '126',
          question_ref: 'ref',
          question_idx: '10',
          question_text: 'text',
          response: 'first',
          timestamp: iso(timestamps[3]),
          metadata: null,
          ad_id: null,
          pageid: 'page1',
          translated_response: null,
          token: token.encoded([dbText(timestamps[3]), '126', 'ref']),
        },
      ]);
    })

    describe('surveyNotFound', () => {
      it('should catch an error', async () => {
        const surveyNotFound = 'this survey does not exist';
        return expect(
          Response.all(email, surveyNotFound, afterParam),
        ).to.be.rejectedWith(
          `No responses were found for survey: ${surveyNotFound} for user: ${email}`,
        );
      });

      it('should return a list of responses when the survey is found', async () => {
        const surveyFound = await Response.all(email, surveyName, afterParam);
        surveyFound.responses.should.have.length(4);
      });
    });

    describe('userNotFound', () => {
      it('should catch an error', async () => {
        const userNotFound = 'unknownuser@vlab.com';
        return expect(
          Response.all(userNotFound, surveyName, afterParam),
        ).to.be.rejectedWith(
          `No responses were found for survey: ${surveyName} for user: ${userNotFound}`,
        );
      });

      it('should return a list of responses when the user is found', async () => {
        const userFound = await Response.all(email, surveyName, afterParam);
        userFound.responses.should.have.length(4);
      });
    });

    describe('responsesNotReturned', () => {
      it('should only return responses for the given survey', async () => {
        const res = await Response.all(email, surveyName, afterParam);

        const goodSurvey = survey;
        const badSurvey = survey2;

        res.responses.forEach(el => el.surveyid.should.equal(goodSurvey.id));
        res.responses.forEach(el =>
          el.surveyid.should.not.equal(badSurvey.id),
        );
        res.responses.forEach(el =>
          el.response.should.not.equal('Do not return me!'),
        );
      });
    });

    describe('pageSize', () => {
      it('should return the specified maximum number of responses', async () => {
        let pageSize = 2;
        let res = await Response.all(email, surveyName, afterParam, pageSize);
        res.responses.length.should.equal(2);

        pageSize = 1;
        res = await Response.all(email, surveyName, afterParam, pageSize);
        res.responses.length.should.equal(1);
      });
    });

    describe('after', () => {
      it('should return all new responses after a given token', async () => {
        const afterParam = token.encoded([timestamps[2], '126', 'ref']);
        const res = await Response.all(email, surveyName, afterParam);
        res.responses.length.should.equal(3);
        // Adding the ad_id projection must not disturb the pagination
        // cursor: the token is still built from (timestamp, userid,
        // question_ref), and every row still carries an ad_id key.
        res.responses.forEach(r => r.should.have.property('ad_id'));
      });

      it('should return no new responses when on the last token', async () => {
        const afterParam = token.encoded([timestamps[3], '126', 'ref']);
        const res = await Response.all(email, surveyName, afterParam);
        res.responses.length.should.equal(0); // this shouldn't throw an error
      });
    });

    describe('GET /responses', () => {
      let authToken;

      before(async () => {
        authToken = await makeAPIToken({ email })
      })

      it('responds with a list of responses after a given token', async () => {
        // first request
        let response = await request(app)
          .get(`/api/v1/responses?survey=${surveyName}&pageSize=25`) // no token needed here
          .set('Authorization', `Bearer ${authToken}`)
          .set('Accept', 'application/json')
          .expect('Content-Type', /json/)
          .expect(200);

        response.statusCode.should.equal(200);
        response.headers['content-type'].should.equal(
          'application/json; charset=utf-8',
        );

        let responses = response.body.responses;

        responses.length.should.equal(4); // all responses
        responses.map(r => r.should.have.property('token'));

        // second request
        let token = responses[0].token;
        response = await request(app).get(
          `/api/v1/responses?survey=${surveyName}&after=${token}&pageSize=25`,
        ).set('Authorization', `Bearer ${authToken}`);

        responses = response.body.responses;
        responses.length.should.equal(3);

        // third request
        token = responses[0].token;
        response = await request(app).get(
          `/api/v1/responses?survey=${surveyName}&after=${token}&pageSize=25`,
        ).set('Authorization', `Bearer ${authToken}`);
        responses = response.body.responses;
        responses.length.should.equal(2);
      });

      it('responds with json error on bad token', async () => {
        let response = await request(app)
          .get(`/api/v1/responses?survey=${surveyName}&pageSize=25`) // no token needed here
          .set('Authorization', `Bearer notatoken`)
          .set('Accept', 'application/json')
          .expect('Content-Type', /json/)
          .expect(401);

        response.body.error.message.should.equal('Invalid Token.')
      });
    });
  });

  // Coverage for `responses.metadata->>'ad_id' AS ad_id`, added to both
  // `_all` (Response.all/GET /responses) and `responsesQuery`
  // (Response.formResponses, the CSV download path) in response.queries.js.
  // Uses a dedicated survey/rows so counts asserted elsewhere in this file
  // (against `survey`/`surveyName`) are untouched.
  describe('ad_id projection', () => {
    let adSurvey;
    const adSurveyName = 'SurveyAdId';
    const withAdUserid = '200';
    const withoutAdUserid = '201';

    before(async () => {
      const user = await User.user({ email });

      adSurvey = await Survey.create({
        created: new Date(),
        formid: 'adid1',
        form: '{"form": "form detail"}',
        messages: '{"foo": "bar"}',
        shortcode: 999,
        userid: user.id,
        title: 'AdId survey',
        metadata: '{}',
        survey_name: adSurveyName,
        translation_conf: '{}',
      });

      // Row whose metadata JSONB contains an ad_id key.
      await vlabPool.query(
        `INSERT INTO responses(parent_surveyid, parent_shortcode, surveyid, shortcode, flowid, userid, pageid, question_ref, question_idx, question_text, response, seed, timestamp, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          adSurvey.id, '999', adSurvey.id, '999',
          200001, withAdUserid, 'page1', 'adref', 10, 'text', 'withad', '6789',
          timestamps[1], JSON.stringify({ ad_id: 'ad-12345' }),
        ],
      );

      // Row whose metadata JSONB exists but has no ad_id key.
      await vlabPool.query(
        `INSERT INTO responses(parent_surveyid, parent_shortcode, surveyid, shortcode, flowid, userid, pageid, question_ref, question_idx, question_text, response, seed, timestamp, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          adSurvey.id, '999', adSurvey.id, '999',
          200002, withoutAdUserid, 'page1', 'adref', 10, 'text', 'withoutad', '6789',
          timestamps[1], JSON.stringify({ utm_source: 'fb' }),
        ],
      );
    });

    after(async () => {
      await vlabPool.query('DELETE FROM responses WHERE surveyid = $1', [adSurvey.id]);
      await vlabPool.query('DELETE FROM surveys WHERE id = $1', [adSurvey.id]);
    });

    it('returns the ad_id value for a response whose metadata contains it', async () => {
      const res = await Response.all(email, adSurveyName, null);
      const row = res.responses.find(r => r.userid === withAdUserid);
      row.ad_id.should.equal('ad-12345');
    });

    it('returns null (and does not error) when metadata has no ad_id key', async () => {
      const res = await Response.all(email, adSurveyName, null);
      const row = res.responses.find(r => r.userid === withoutAdUserid);
      expect(row.ad_id).to.equal(null);
    });

    it('returns null (and does not error) when metadata itself is SQL NULL', async () => {
      // `survey`'s four seeded rows (top of this file) all have SQL NULL
      // metadata, since the MOCK_QUERY insert omits the column entirely.
      const res = await Response.all(email, surveyName, null);
      res.responses.forEach(r => {
        expect(r.ad_id).to.equal(null);
        expect(r.metadata).to.equal(null);
      });
    });

    it('does not disturb the pagination cursor when ad_id is present in the row', async () => {
      const res = await Response.all(email, adSurveyName, null);
      res.responses.should.have.length(2);

      const [first] = res.responses;
      first.userid.should.equal(withAdUserid);
      first.token.should.equal(
        token.encoded([dbText(timestamps[1]), withAdUserid, 'adref']),
      );

      const page2 = await Response.all(email, adSurveyName, first.token);
      page2.responses.should.have.length(1);
      page2.responses[0].userid.should.equal(withoutAdUserid);
      expect(page2.responses[0].ad_id).to.equal(null);
    });

    describe('formResponses (CSV/stream path)', () => {
      it('includes ad_id on every streamed row', (done) => {
        Response.formResponses(email, adSurveyName).then(stream => {
          const rows = [];
          stream.on('data', row => rows.push(row));
          stream.on('error', done);
          stream.on('end', () => {
            try {
              rows.should.have.length(2);
              const withAd = rows.find(r => r.userid === withAdUserid);
              const withoutAd = rows.find(r => r.userid === withoutAdUserid);
              withAd.ad_id.should.equal('ad-12345');
              expect(withoutAd.ad_id).to.equal(null);
              done();
            } catch (e) {
              done(e);
            }
          });
        }, done);
      });
    });
  });
});
