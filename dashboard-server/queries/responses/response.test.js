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

    const MOCK_QUERY = `INSERT INTO responses(parent_surveyid, parent_shortcode, surveyid, shortcode, flowid, userid, question_ref, question_idx, question_text, response, seed, timestamp)
      VALUES
        ('${survey.id}', '101', '${survey.id
      }', '101', 100001, '127', 'ref', 10, 'text', 'last', '6789', '${timestamps[1]
      }')
       ,('${survey2.id}', '202', '${survey2.id
      }', '202', 100003, '126', 'ref', 10, 'text', 'last', '6789', '${timestamps[1]
      }')
       ,('${survey.id}', '101', '${survey.id
      }', '101', 100004, '127', 'ref', 10, 'text', 'first', '6789', '${timestamps[2]
      }')
       ,('${survey.id}', '202', '${survey.id
      }', '202', 100005, '126', 'ref', 10, 'text', 'first', '6789', '${timestamps[3]
      }')
       ,('${survey2.id}', '202', '${survey2.id
      }', '202', 100003, '128', 'ref', 10, 'text', 'last', '6789', '${timestamps[1]
      }')
       ,('${survey.id}', '101', '${survey.id
      }', '101', 100004, '128', 'ref', 10, 'text', 'first', '6789', '${timestamps[2]
      }')
       ,('${survey2.id}', '202', '${survey2.id
      }', '202', 100005, '128', 'ref', 10, 'text', 'do not return me', '6789', '${timestamps[3]
      }')`;


    await vlabPool.query(MOCK_QUERY);
  });

  const timestamps = {
    1: '2022-06-06 09:58:00+00:00',
    2: '2022-06-06 10:00:00+00:00',
    3: '2022-06-06 10:02:00+00:00',
  };

  describe('all()', () => {
    it('should return a list of responses for a survey created by a user', async () => {
      console.log('BEFORE FIRST')
      const res = await Response.all(email, surveyName, afterParam);
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
      });

      it('should return no new responses when on the last token', async () => {
        const afterParam = token.encoded([timestamps[3], '126', 'ref']);
        const res = await Response.all(email, surveyName, afterParam);
        res.responses.length.should.equal(0); // this shouldn't throw an error
      });
    });

    describe('GET /responses', () => {
      it('responds with a list of responses after a given token', async () => {
        // first request
        let response = await request(app)
          .get(`/?survey=${surveyName}&pageSize=25`) // no token needed here
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
          `/?survey=${surveyName}&after=${token}&pageSize=25`,
        );

        responses = response.body.responses;
        responses.length.should.equal(3);

        // third request
        token = responses[0].token;
        response = await request(app).get(
          `/?survey=${surveyName}&after=${token}&pageSize=25`,
        );
        responses = response.body.responses;
        responses.length.should.equal(2);
      });
    });
  });
});
