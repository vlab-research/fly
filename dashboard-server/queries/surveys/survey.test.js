/* eslint-disable no-unused-expressions */
const { Pool } = require('pg');
const chai = require('chai');
const axios = require('axios');
chai.should();

require('mocha');

const surveyModel = require('./survey.queries');
const userModel = require('../users/user.queries');

const { DATABASE_CONFIG } = require('../../config');

describe('Survey queries', () => {
  let Survey;
  let User;
  let pool;

  before(async () => {
    pool = new Pool(DATABASE_CONFIG);
    User = userModel.queries(pool);
    Survey = surveyModel.queries(pool);
  });

  beforeEach(async () => {
    await axios.get('http://system/resetdb');
  });

  describe('.create()', () => {
    it('should insert a new survey and return the newly created record', async () => {
      const user = {
        token: 'HxpnYoykme73Jz1c9DdAxPws77GzH9jLqE1wu1piSqJj',
        email: 'test@vlab.com',
      };
      const newUser = await User.create(user);
      newUser.email.should.equal(user.email);

      const survey = {
        created: new Date(),
        formid: 'S8yR4',
        form: '{"form": "form detail"}',
        messages: '{"foo": "bar"}',
        shortcode: 123,
        userid: newUser.id,
        title: 'New User Title',
        metadata: '{}',
        survey_name: "test",
        translation_conf: '{}',
      };
      const newSurvey = await Survey.create(survey);
      newSurvey.formid.should.equal('S8yR4');
      newSurvey.form.should.equal('{"form": "form detail"}');
      newSurvey.shortcode.should.equal('123');
      newSurvey.userid.should.equal(newUser.id);
      newSurvey.title.should.equal('New User Title');
    });
  });

  describe('.retrieve()', () => {
    it('should insert a new survey and return the newly created record', async () => {
      const user = {
        token: 'dasfYoykme73Jz1c93d1xPws77GzuhNU0f1wu1pHeh91',
        email: 'test2@vlab.com',
      };
      const newUser = await User.create(user);

      const survey = {
        created: new Date(),
        formid: 'biy23',
        form: '{"form": "form detail"}',
        messages: '{"foo": "bar"}',
        shortcode: 231,
        userid: newUser.id,
        title: 'Second Survey',
        metadata: '{}',
        survey_name: "test",
        translation_conf: '{}',
      };
      await Survey.create(survey);

      const survey2 = {
        created: new Date(),
        formid: '3hu23',
        form: '{"form": "form detail"}',
        messages: '{"foo": "bar"}',
        shortcode: 123,
        userid: newUser.id,
        title: 'Other survey',
        metadata: '{}',
        survey_name: "test",
        translation_conf: '{}',
      };
      await Survey.create(survey2);

      const rows = await Survey.retrieve({ email: 'test2@vlab.com' });
      rows.length.should.be.equal(2);
    });
  });
});
