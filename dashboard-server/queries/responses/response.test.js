const { Pool } = require('pg');
require('chai').should();
require('mocha');
const userModel = require('../users/user.queries');
const surveyModel = require('../surveys/survey.queries');
const model = require('./response.queries');

const { DATABASE_CONFIG } = require('../../config');

const router = require('./../../api/responses/response.routes');

// hack to avoid bootstrapping the entire
// server with all its env vars, just test
// this router in isolation
const express = require('express');
const app = express();
app.use('/', router);

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
    it('should get a list of the first and last responses for each survey created by a user', async () => {
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

      await vlabPool.query(MOCK_QUERY); // inserts mock data into the db
      const responses = await Response.firstAndLast();

      responses[0].first_response.should.equal('{ "text": "first" }');
      responses[0].last_response.should.equal('{ "text": "last" }');
      responses[0].surveyid.should.equal(survey2.id);
      responses[1].first_response.should.equal('{ "text": "first" }');
      responses[1].last_response.should.equal('{ "text": "last" }');
      responses[1].surveyid.should.equal(survey.id);
    });
  });
});
