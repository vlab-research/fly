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

  // afterEach(async () => {
  //   await vlabPool.query('DELETE FROM responses');
  // });

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

  describe('.all()', () => {
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

      const MOCK_QUERY = `INSERT INTO responses(parent_surveyid, parent_shortcode, surveyid, shortcode, flowid, userid, question_ref, question_idx, question_text, response, seed, timestamp)
      VALUES
        ('${survey.id}', '101', '${
        survey.id
      }', '101', 100001, '126', 'ref', 10, 'text', '{ "text": "last" }', '6789', current_date::timestamptz + interval '14 hour')
       ,('${survey2.id}', '202', '${
        survey2.id
      }', '202', 100003, '124', 'ref', 10, 'text', '{ "text": "do not return me" }', '6789', (date '2019-04-18')::timestamptz + interval '12 hour')
       ,('${survey.id}', '101', '${
        survey.id
      }', '101', 100004, '126', 'ref', 10, 'text', '{ "text": "first" }', '6789', current_date::timestamptz + interval '10 hour')`;

      await vlabPool.query(MOCK_QUERY);

      const responses = await Response.all({
        email: user.email,
        survey: survey.survey_name,
      });

      responses.should.equal([
        {
          parent_surveyid: 'c741ab33-330a-4b75-b96f-ce390ac8c1d3',
          parent_shortcode: '101',
          surveyid: 'c741ab33-330a-4b75-b96f-ce390ac8c1d3',
          flowid: '100004',
          userid: '126',
          question_ref: 'ref',
          question_idx: '10',
          question_text: 'text',
          response: '{ "text": "first" }',
          timestamp: '2022-06-06 10:00:00+00:00',
          metadata: null,
          pageid: null,
          translated_response: null,
        },
        {
          parent_surveyid: 'c741ab33-330a-4b75-b96f-ce390ac8c1d3',
          parent_shortcode: '101',
          surveyid: 'c741ab33-330a-4b75-b96f-ce390ac8c1d3',
          flowid: '100001',
          userid: '126',
          question_ref: 'ref',
          question_idx: '10',
          question_text: 'text',
          response: '{ "text": "last" }',
          timestamp: '2022-06-06 14:00:00+00:00',
          metadata: null,
          pageid: null,
          translated_response: null,
        },
      ]);

      responses[0].userid.should.equal('126');
      responses[0].response.should.equal('{ "text": "first" }');
      responses[1].userid.should.equal('126');
      responses[1].response.should.equal('{ "text": "last" }');

      it('should return no responses if the user email is not found', async () => {
        const userNotFound = await Response.all({
          email: 'test4@vlab.com',
          survey: survey.survey_name,
        });
        userNotFound.length.should.equal(0);
      });

      it('should return no responses if the survey name is not found', async () => {
        const surveyNotFound = await Response.all({
          email: user.email,
          survey: 'Survey!',
        });
        surveyNotFound.length.should.equal(0);
      });

      it('should only return responses for the given survey', async () => {
        const goodResponses = await Response.all({
          email: user.email,
          survey: survey.survey,
        });
        const badResponses = await Response.all({
          email: user.email,
          survey: survey2.survey,
        });

        badResponses.length.should.equal(1);
        goodResponses.length.should.equal(2);
        goodResponses.forEach(el => el.userid.should.equal(126));
        goodResponses.forEach(el =>
          el.response.should.not.equal({ text: 'do not return me' }),
        );
      });
    });
  });

  describe('GET /all', function() {
    it('responds with all responses in json', async () => {
      const response = await request(app)
        .get('/all?survey=Survey123&after=2000&limit=100')
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(200);
      response.statusCode.should.equal(200);
      response.headers['content-type'].should.equal(
        'application/json; charset=utf-8',
      );
    });
  });
});
