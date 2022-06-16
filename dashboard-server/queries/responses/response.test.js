const { Pool } = require('pg');
require('chai').should();
require('mocha');
const userModel = require('../users/user.queries');
const surveyModel = require('../surveys/survey.queries');
const model = require('./response.queries');
const request = require('supertest');
const router = require('./../../api/responses/response.routes');

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
      }', '101', 100001, '124', 'ref', 10, 'text', '{ "text": "last" }', '6789', current_date::timestamptz + interval '14 hour')
           ,('${survey2.id}', '202', '${
        survey2.id
      }', '202', 100003, '123', 'ref', 10, 'text', '{ "text": "last" }', '6789', (date '2019-04-18')::timestamptz + interval '12 hour')
           ,('${survey.id}', '101', '${
        survey.id
      }', '101', 100004, '124', 'ref', 10, 'text', '{ "text": "first" }', '6789', current_date::timestamptz + interval '10 hour')
           ,('${survey2.id}', '202', '${
        survey2.id
      }', '202', 100005, '123', 'ref', 10, 'text', '{ "text": "first" }', '6789', (date '2019-04-18')::timestamptz + interval '8 hour')
           ,('${survey2.id}', '202', '${
        survey2.id
      }', '202', 100003, '125', 'ref', 10, 'text', '{ "text": "last" }', '6789', (date '2019-04-18')::timestamptz + interval '12 hour')
           ,('${survey.id}', '101', '${
        survey.id
      }', '101', 100004, '125', 'ref', 10, 'text', '{ "text": "first" }', '6789', (date '2019-04-18')::timestamptz + interval '10 hour')
           ,('${survey2.id}', '202', '${
        survey2.id
      }', '202', 100005, '125', 'ref', 10, 'text', '{ "text": "first" }', '6789', (date '2019-04-18')::timestamptz + interval '8 hour')
           ,('${survey.id}', '101', '${
        survey.id
      }', '101', 100006, '124', 'ref', 10, 'text', '{ "text": "middle" }', '6789', current_date::timestamptz + interval '12 hour')`;

      await vlabPool.query(MOCK_QUERY);
      const responses = await Response.firstAndLast();

      responses[0].first_response.should.equal('{ "text": "first" }');
      responses[0].last_response.should.equal('{ "text": "last" }');
      responses[0].surveyid.should.equal(survey2.id);
      responses[1].first_response.should.equal('{ "text": "first" }');
      responses[1].last_response.should.equal('{ "text": "last" }');
      responses[1].surveyid.should.equal(survey.id);
    });
  });

  describe('all()', () => {
    it('should return all responses for a survey created by a user', async () => {
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

      const timestamps = {
        1: '2022-06-06 09:58:00+00:00',
        2: '2022-06-06 10:00:00+00:00',
        3: '2022-06-06 10:02:00+00:00',
      };

      const mockData = (
        email = user.email,
        survey = 'Survey123',
        timestamp = timestamps[2],
        userid = '126',
        ref = 'ref',
        pageSize = 25, // default
      ) => {
        return {
          email,
          survey,
          timestamp,
          userid,
          ref,
          pageSize,
        };
      };

      const MOCK_QUERY = `INSERT INTO responses(parent_surveyid, parent_shortcode, surveyid, shortcode, flowid, userid, question_ref, question_idx, question_text, response, seed, timestamp)
      VALUES
        ('${survey.id}', '101', '${
        survey.id
      }', '101', 100001, '127', 'ref', 10, 'text', '{ "text": "last" }', '6789', '${
        timestamps[1]
      }')
       ,('${survey2.id}', '202', '${
        survey2.id
      }', '202', 100003, '126', 'ref', 10, 'text', '{ "text": "last" }', '6789', '${
        timestamps[1]
      }')
       ,('${survey.id}', '101', '${
        survey.id
      }', '101', 100004, '127', 'ref', 10, 'text', '{ "text": "first" }', '6789', '${
        timestamps[2]
      }')
       ,('${survey.id}', '202', '${
        survey.id
      }', '202', 100005, '126', 'ref', 10, 'text', '{ "text": "first" }', '6789', '${
        timestamps[3]
      }')
       ,('${survey2.id}', '202', '${
        survey2.id
      }', '202', 100003, '128', 'ref', 10, 'text', '{ "text": "last" }', '6789', '${
        timestamps[1]
      }')
       ,('${survey.id}', '101', '${
        survey.id
      }', '101', 100004, '128', 'ref', 10, 'text', '{ "text": "first" }', '6789', '${
        timestamps[2]
      }')
       ,('${survey2.id}', '202', '${
        survey2.id
      }', '202', 100005, '128', 'ref', 10, 'text', '{ "text": "do not return me" }', '6789', '${
        timestamps[3]
      }')`;

      await vlabPool.query(MOCK_QUERY);

      // give me all responses after 2022-06-06 10:00:00+00:00, '126', 'ref'
      const responses = await Response.all(mockData());

      responses.should.eql([
        {
          parent_surveyid: survey.id,
          parent_shortcode: '101',
          surveyid: survey.id,
          flowid: '100004',
          userid: '127',
          question_ref: 'ref',
          question_idx: '10',
          question_text: 'text',
          response: '{ "text": "first" }',
          timestamp: timestamps[2],
          metadata: null,
          pageid: null,
          translated_response: null,
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
          response: '{ "text": "first" }',
          timestamp: timestamps[2],
          metadata: null,
          pageid: null,
          translated_response: null,
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
          response: '{ "text": "first" }',
          timestamp: timestamps[3],
          metadata: null,
          pageid: null,
          translated_response: null,
        },
      ]);

      describe('userNotFound', () => {
        it('should return no responses if the user email is not found', async () => {
          const userNotFound = await Response.all(mockData('test4@vlab.com'));
          userNotFound.length.should.equal(0);
        });

        it('should return a response if the user email is found', async () => {
          const userFound = await Response.all(mockData());
          userFound.length.should.equal(3);
        });
      });

      describe('surveyNotFound', () => {
        it('should return no responses if the survey name is not found', async () => {
          const surveyNotFound = await Response.all(
            mockData('test3@vlab.com', 'this survey does not exist!'),
          );
          surveyNotFound.length.should.equal(0);
        });

        it('should return a response if the survey is found', async () => {
          const userFound = await Response.all(
            mockData('test3@vlab.com', survey.survey_name),
          );
          userFound.length.should.equal(3);
        });
      });

      describe('responsesNotReturned', () => {
        it('should only return responses for the given survey', async () => {
          const responses = await Response.all(
            mockData('test3@vlab.com', survey.survey_name),
          );

          const goodSurvey = survey;
          const badSurvey = survey2;

          responses.forEach(el => el.surveyid.should.equal(goodSurvey.id));

          responses.forEach(el => el.surveyid.should.not.equal(badSurvey.id));

          responses.forEach(el =>
            el.response.should.not.equal('Do not return me!'),
          );
        });
      });

      describe('pageSize', () => {
        it('should return the specified maximum number of responses', async () => {
          const maxResponses = await Response.all(
            mockData(
              'test3@vlab.com',
              survey.survey_name,
              timestamps[2],
              '126',
              'ref',
              2,
            ),
          );
          maxResponses.length.should.equal(2);
        });
      });

      describe('after', () => {
        it('should return all responses after a given timestamp/userid/ref (will be updated to token)', async () => {
          const responsesAfterToken = await Response.all(
            mockData('test3@vlab.com', survey.survey_name, timestamps[1]),
          );
          responsesAfterToken.length.should.equal(4);
        });

        it('should return less responses for a later timestamp', async () => {
          const responsesAfterToken = await Response.all(
            mockData('test3@vlab.com', survey.survey_name, timestamps[2]),
          );
          responsesAfterToken.length.should.equal(3);
        });

        it('should return no responses when on the last token', async () => {
          const responsesAfterToken = await Response.all(
            mockData('test3@vlab.com', survey.survey_name, timestamps[3]),
          );
          responsesAfterToken.length.should.equal(0);
        });
      });
    });
  });
});

describe('GET /all', function() {
  it('responds with all responses in json', async () => {
    const response = await request(app)
      .get(`/all?survey=Survey123&after=1000&limit=100`)
      .set('Accept', 'application/json')
      .expect('Content-Type', /json/)
      .expect(200);
    response.statusCode.should.equal(200);
    response.headers['content-type'].should.equal(
      'application/json; charset=utf-8',
    );
  });
});
