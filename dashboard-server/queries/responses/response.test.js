const { Pool } = require('pg');
require('chai').should();
require('mocha');

const userModel = require('../users/user.queries');
const surveyModel = require('../surveys/survey.queries');
const model = require('./response.queries');
const router = require('./../../api/responses/response.routes');
const token = require('./token');
const request = require('supertest');
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const expect = chai.expect;
chai.use(chaiAsPromised);

// hack to avoid bootstrapping the entire
// server with all its env vars, just test
// this router in isolation
const express = require('express');
const app = express();

const fakeAuthMiddleware = (req, res, next) => {
  req.user = { email: 'test3@vlab.com' };
  next();
};

app.use('/', fakeAuthMiddleware, router);

const { DATABASE_CONFIG } = require('../../config');

describe('Response queries', () => {
  let Response;
  let vlabPool;
  let User;
  let Survey;

  before(async () => {
    vlabPool = new Pool(DATABASE_CONFIG);
    User = userModel.queries(vlabPool);
    Survey = surveyModel.queries(vlabPool);
    await vlabPool.query('DELETE FROM responses');

    Response = model.queries(vlabPool);
  });

  afterEach(async () => {
    await vlabPool.query('DELETE FROM responses');
  });

  describe('.firstAndLast()', () => {
    it('should get the first and last responses for each survey created by a user', async () => {
      const user = {
        email: 'test2@vlab.com',
      };
      const newUser = await User.create(user);

      const survey = await Survey.create({
        created: new Date(),
        formid: 'biy23',
        form: '{"form": "form detail"}',
        messages: '{"foo": "bar"}',
        shortcode: 231,
        userid: newUser.id,
        title: 'Second Survey',
        metadata: '{}',
        survey_name: 'Survey',
        translation_conf: '{}',
      });

      const survey2 = await Survey.create({
        created: new Date(),
        formid: '3hu23',
        form: '{"form": "form detail"}',
        messages: '{"foo": "bar"}',
        shortcode: 123,
        userid: newUser.id,
        title: 'Other survey',
        metadata: '{}',
        survey_name: 'Survey',
        translation_conf: '{}',
      });

      const MOCK_QUERY = `INSERT INTO responses(parent_surveyid, parent_shortcode, surveyid, shortcode, flowid, userid, question_ref, question_idx, question_text, response, seed, timestamp)
          VALUES
            ('${survey.id}', '101', '${
        survey.id
      }', '101', 100001, '124', 'ref', 10, 'text', 'last', '6789', current_date::timestamptz + interval '14 hour')
           ,('${survey2.id}', '202', '${
        survey2.id
      }', '202', 100003, '123', 'ref', 10, 'text', 'last', '6789', (date '2019-04-18')::timestamptz + interval '12 hour')
           ,('${survey.id}', '101', '${
        survey.id
      }', '101', 100004, '124', 'ref', 10, 'text', 'first', '6789', current_date::timestamptz + interval '10 hour')
           ,('${survey2.id}', '202', '${
        survey2.id
      }', '202', 100005, '123', 'ref', 10, 'text', 'first', '6789', (date '2019-04-18')::timestamptz + interval '8 hour')
           ,('${survey2.id}', '202', '${
        survey2.id
      }', '202', 100003, '125', 'ref', 10, 'text', 'last', '6789', (date '2019-04-18')::timestamptz + interval '12 hour')
           ,('${survey.id}', '101', '${
        survey.id
      }', '101', 100004, '125', 'ref', 10, 'text', 'first', '6789', (date '2019-04-18')::timestamptz + interval '10 hour')
           ,('${survey2.id}', '202', '${
        survey2.id
      }', '202', 100005, '125', 'ref', 10, 'text', 'first', '6789', (date '2019-04-18')::timestamptz + interval '8 hour')
           ,('${survey.id}', '101', '${
        survey.id
      }', '101', 100006, '124', 'ref', 10, 'text', 'middle', '6789', current_date::timestamptz + interval '12 hour')`;

      await vlabPool.query(MOCK_QUERY);
      const responses = await Response.firstAndLast();

      responses[0].first_response.should.equal('first');
      responses[0].last_response.should.equal('last');
      responses[0].surveyid.should.equal(survey2.id);
      responses[1].first_response.should.equal('first');
      responses[1].last_response.should.equal('last');
      responses[1].surveyid.should.equal(survey.id);
    });
  });

  const timestamps = {
    1: '2022-06-06 09:58:00+00:00',
    2: '2022-06-06 10:00:00+00:00',
    3: '2022-06-06 10:02:00+00:00',
  };

  describe('all()', () => {
    it('should return a list of responses for a survey created by a user', async () => {
      const user = {
        email: 'test3@vlab.com',
      };
      const newUser = await User.create(user);

      const survey = await Survey.create({
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

      const survey2 = await Survey.create({
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

      const MOCK_QUERY = `INSERT INTO responses(parent_surveyid, parent_shortcode, surveyid, shortcode, flowid, userid, question_ref, question_idx, question_text, response, seed, timestamp)
      VALUES
        ('${survey.id}', '101', '${
        survey.id
      }', '101', 100001, '127', 'ref', 10, 'text', 'last', '6789', '${
        timestamps[1]
      }')
       ,('${survey2.id}', '202', '${
        survey2.id
      }', '202', 100003, '126', 'ref', 10, 'text', 'last', '6789', '${
        timestamps[1]
      }')
       ,('${survey.id}', '101', '${
        survey.id
      }', '101', 100004, '127', 'ref', 10, 'text', 'first', '6789', '${
        timestamps[2]
      }')
       ,('${survey.id}', '202', '${
        survey.id
      }', '202', 100005, '126', 'ref', 10, 'text', 'first', '6789', '${
        timestamps[3]
      }')
       ,('${survey2.id}', '202', '${
        survey2.id
      }', '202', 100003, '128', 'ref', 10, 'text', 'last', '6789', '${
        timestamps[1]
      }')
       ,('${survey.id}', '101', '${
        survey.id
      }', '101', 100004, '128', 'ref', 10, 'text', 'first', '6789', '${
        timestamps[2]
      }')
       ,('${survey2.id}', '202', '${
        survey2.id
      }', '202', 100005, '128', 'ref', 10, 'text', 'do not return me', '6789', '${
        timestamps[3]
      }')`;

      await vlabPool.query(MOCK_QUERY);

      const mockData = {
        email: user.email,
        surveyName: survey.survey_name,
        after: null,
      };

      const { email, surveyName, after } = mockData;

      const res = await Response.all(email, surveyName, after);

      res.responses.should.eql([
        {
          parent_surveyid: survey.id,
          parent_shortcode: '101',
          surveyid: survey.id,
          flowid: '100001',
          userid: '127',
          question_ref: 'ref',
          question_idx: '10',
          question_text: 'text',
          response: 'last',
          timestamp: timestamps[1],
          metadata: null,
          pageid: null,
          translated_response: null,
          token: token.encoded([timestamps[1], '127', 'ref']),
        },
        {
          parent_surveyid: survey.id,
          parent_shortcode: '101',
          surveyid: survey.id,
          flowid: '100004',
          userid: '127',
          question_ref: 'ref',
          question_idx: '10',
          question_text: 'text',
          response: 'first',
          timestamp: timestamps[2],
          metadata: null,
          pageid: null,
          translated_response: null,
          token: token.encoded([timestamps[2], '127', 'ref']),
        },
        {
          parent_surveyid: survey.id,
          parent_shortcode: '101',
          surveyid: survey.id,
          flowid: '100004',
          userid: '128',
          question_ref: 'ref',
          question_idx: '10',
          question_text: 'text',
          response: 'first',
          timestamp: timestamps[2],
          metadata: null,
          pageid: null,
          translated_response: null,
          token: token.encoded([timestamps[2], '128', 'ref']),
        },
        {
          parent_surveyid: survey.id,
          parent_shortcode: '202',
          surveyid: survey.id,
          flowid: '100005',
          userid: '126',
          question_ref: 'ref',
          question_idx: '10',
          question_text: 'text',
          response: 'first',
          timestamp: timestamps[3],
          metadata: null,
          pageid: null,
          translated_response: null,
          token: token.encoded([timestamps[3], '126', 'ref']),
        },
      ]);

      describe('surveyNotFound', () => {
        it('should catch an error', async () => {
          const surveyNotFound = 'this survey does not exist';
          return expect(
            Response.all(email, surveyNotFound, after),
          ).to.be.rejectedWith(
            `No responses were found for survey: ${surveyNotFound} for user: ${email}`,
          );
        });

        it('should return a list of responses when the survey is found', async () => {
          const surveyFound = await Response.all(email, surveyName, after);
          surveyFound.responses.should.have.length(4);
        });
      });

      describe('userNotFound', () => {
        it('should catch an error', async () => {
          const userNotFound = 'unknownuser@vlab.com';
          return expect(
            Response.all(userNotFound, surveyName, after),
          ).to.be.rejectedWith(
            `No responses were found for survey: ${surveyName} for user: ${userNotFound}`,
          );
        });

        it('should return a list of responses when the user is found', async () => {
          const userFound = await Response.all(email, surveyName, after);
          userFound.responses.should.have.length(4);
        });
      });

      describe('responsesNotReturned', () => {
        it('should only return responses for the given survey', async () => {
          const res = await Response.all(email, surveyName, after);

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
          let res = await Response.all(email, surveyName, after, pageSize);
          res.responses.length.should.equal(2);

          pageSize = 1;
          res = await Response.all(email, surveyName, after, pageSize);
          res.responses.length.should.equal(1);
        });
      });

      describe('after', () => {
        it('should return all new responses after a given token', async () => {
          const after = token.encoded([timestamps[2], '126', 'ref']);
          const res = await Response.all(email, surveyName, after);
          res.responses.length.should.equal(3);
        });

        it('should return no new responses when on the last token', async () => {
          const after = token.encoded([timestamps[3], '126', 'ref']);
          const res = await Response.all(email, surveyName, after);
          res.responses.length.should.equal(0); // this shouldn't throw an error
        });
      });

      describe('ROUTE /all', () => {
        it('responds with a list of responses after a given token', async () => {
          // first request
          let response = await request(app)
            .get(`/all?survey=${surveyName}&pageSize=25`) // no token needed here
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
            `/all?survey=${surveyName}&after=${token}&pageSize=25`,
          );

          responses = response.body.responses;
          responses.length.should.equal(3);

          // third request
          token = responses[0].token;
          response = await request(app).get(
            `/all?survey=${surveyName}&after=${token}&pageSize=25`,
          );
          responses = response.body.responses;
          responses.length.should.equal(2);
        });
      });
    });
  });
});
