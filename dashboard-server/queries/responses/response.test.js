const { Pool } = require('pg');
require('chai').should();
require('mocha');
const axios = require('axios');

const responseModel = require('./response.queries');
const surveyModel = require('../surveys/survey.queries');
const userModel = require('../users/user.queries');

const { DATABASE_CONFIG } = require('../../config');

describe('Response queries', () => {
  let pool;
  let Response;
  let Survey;
  let User;

  before(async () => {
    pool = new Pool(DATABASE_CONFIG);
    Response = responseModel.queries(pool);
    Survey = surveyModel.queries(pool);
    User = userModel.queries(pool);
  });

  beforeEach(async () => {
    await axios.get('http://system/resetdb');
  });

  describe('.all()', () => {
    it('should get the list of the first and last responses for each user', async () => {
      const user1 = await User.create({
        token: 'AAAA',
        email: 'test1@vlab.com',
      });

      const user2 = await User.create({
        token: 'BBBB',
        email: 'test2@vlab.com',
      });

      const user3 = await User.create({
        token: 'CCCC',
        email: 'test3@vlab.com',
      });

      const survey1 = await Survey.create({
        created: new Date(),
        formid: 'DDD',
        form: '{"form": "form detail 1"}',
        shortcode: 123,
        userid: user1.id,
        title: 'New User Title 1',
        metadata: '{}',
        survey_name: "test 1",
        translation_conf: '{}',
      });

      const survey2 = await Survey.create({
        created: new Date(),
        formid: 'EEE',
        form: '{"form": "form detail 2"}',
        shortcode: 567,
        userid: user2.id,
        title: 'New User Title 2',
        metadata: '{}',
        survey_name: "test 2",
        translation_conf: '{}',
      });

      const MOCK_QUERY = `
      	INSERT INTO responses(parent_surveyid, parent_shortcode, surveyid, shortcode, flowid, userid, question_ref, question_idx, question_text, response, seed, timestamp)
      	VALUES
        	('${survey1.id}', '${survey1.shortcode}', '${survey1.id}', '${survey1.shortcode}', 100001, '${user1.id}', 'ref', 10, 'text', '{ "text": "last" }', '6789', '2019-05-29T14:00:01.00Z'),
       		('${survey2.id}', '${survey2.shortcode}', '${survey2.id}', '${survey2.shortcode}', 100003, '${user2.id}', 'ref', 10, 'text', '{ "text": "last" }', '6789', '2010-05-29T12:00:01.00Z'),
       		('${survey1.id}', '${survey1.shortcode}', '${survey1.id}', '${survey1.shortcode}', 100004, '${user1.id}', 'ref', 10, 'text', '{ "text": "first" }', '6789', '2019-05-29T10:20:01.00Z'),
       		('${survey2.id}', '${survey2.shortcode}', '${survey2.id}', '${survey2.shortcode}', 100005, '${user2.id}', 'ref', 10, 'text', '{ "text": "first" }', '6789', '2010-05-29T08:00:01.00Z'),
       		('${survey2.id}', '${survey2.shortcode}', '${survey2.id}', '${survey2.shortcode}', 100003, '${user3.id}', 'ref', 10, 'text', '{ "text": "last" }', '6789', '2010-05-29T12:00:01.00Z'),
       		('${survey1.id}', '${survey1.shortcode}', '${survey1.id}', '${survey1.shortcode}', 100004, '${user3.id}', 'ref', 10, 'text', '{ "text": "first" }', '6789', '2010-05-29T10:00:01.00Z'),
       		('${survey2.id}', '${survey2.shortcode}', '${survey2.id}', '${survey2.shortcode}', 100005, '${user3.id}', 'ref', 10, 'text', '{ "text": "first" }', '6789', '2010-05-29T08:00:01.00Z'),
       		('${survey1.id}', '${survey1.shortcode}', '${survey1.id}', '${survey1.shortcode}', 100006, '${user1.id}', 'ref', 10, 'text', '{ "text": "middle" }', '6789', '2019-05-29T12:00:01.00Z')
      `;

      await pool.query(MOCK_QUERY);
      const responses = await Response.all();

      responses[0].first_response.should.equal('{ "text": "first" }');
      responses[0].last_response.should.equal('{ "text": "last" }');
      responses[0].surveyid.should.equal(survey1.id);
      responses[1].first_response.should.equal('{ "text": "first" }');
      responses[1].last_response.should.equal('{ "text": "last" }');
      responses[1].surveyid.should.equal(survey2.id);
    });
  });
});
