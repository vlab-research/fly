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
app.use('/', router);

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
      const user2 = {
        email: 'test2@vlab.com',
      };
      const newUser = await User.create(user2);

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
      const responses = await Response.all({
        email: 'test2@vlab.com',
        survey: 'Survey',
      });

      const responses2 = await Response.all({
        email: 'test2@vlab.com',
        survey: 'Survey123',
      });

      const responses3 = await Response.all({
        email: 'test3@vlab.com',
        survey: 'Survey',
      });
      responses.length.should.equal(8);
      responses[0].userid.should.equal('123');
      responses[1].userid.should.equal('123');
      responses2.length.should.equal(0);
      responses3.length.should.equal(0);
    });
  });

  describe('GET /all', function() {
    it.only('responds with all responses in json', async function() {
      const response = await request(app)
        .get('/?after=2000&limit=100')
        .query({ email: 'test2@vlab.com', survey: 'Survey' })
        .set('Accept', 'application/json')
        .expect(200);
      console.log(response);
      response.body.length.should.equal(8);
      response.statusCode.should.equal(200);
      response.headers['content-type'].should.equal(
        'application/json; charset=utf-8',
      );
    });
  });
});
