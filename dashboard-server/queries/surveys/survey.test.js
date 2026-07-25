/* eslint-disable no-unused-expressions */
const { Pool } = require('pg');
const chai = require('chai');
chai.should();
const expect = chai.expect;

require('mocha');

const surveyModel = require('./survey.queries');
const userModel = require('../users/user.queries');

const { DATABASE_CONFIG } = require('../../config');

describe('Survey queries', () => {
  let Survey;
  let User;
  let vlabPool;

  before(async () => {
    vlabPool = new Pool(DATABASE_CONFIG);

    User = userModel.queries(vlabPool);
    Survey = surveyModel.queries(vlabPool);

    await vlabPool.query('DELETE FROM responses');
    await vlabPool.query('DELETE FROM survey_settings');
    await vlabPool.query('DELETE FROM surveys');
    await vlabPool.query('DELETE FROM users');
  });

  afterEach(async () => {
    await vlabPool.query('DELETE FROM responses');
    await vlabPool.query('DELETE FROM survey_settings');
    await vlabPool.query('DELETE FROM surveys');
    await vlabPool.query('DELETE FROM users');
  });


  describe('.create()', () => {
    it('should insert a new survey and return the newly created record', async () => {
      const user = {
        email: 'test@vlab.com',
      };
      const newUser = await User.create(user);

      const survey = {
        created: new Date(),
        formid: 'S8yR4',
        form: '{"form": "form detail"}',
        messages: '{"foo": "bar"}',
        shortcode: 123,
        userid: newUser.id,
        title: 'New User Title',
        metadata: '{}',
        survey_name: 'Survey',
        translation_conf: '{}'
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
    it('should return everything created and updated, with settings across all with same shortcode', async () => {
      const user2 = {
        email: 'test2@vlab.com',
      };
      const newUser = await User.create(user2);

      const survey = {
        created: new Date(),
        formid: 'biy23',
        form: '{"form": "form detail"}',
        messages: '{"foo": "bar"}',
        shortcode: "231",
        userid: newUser.id,
        title: 'Second Survey',
        metadata: '{}',
        survey_name: 'Survey',
        translation_conf: '{}'
      };
      await Survey.create(survey);

      const survey2 = {
        created: new Date(),
        formid: '3hu23',
        form: '{"form": "form detail"}',
        messages: '{"foo": "bar"}',
        shortcode: "123",
        userid: newUser.id,
        title: 'Other survey',
        metadata: '{}',
        survey_name: 'Survey',
        translation_conf: '{}'
      };
      const createdSurvey2 = await Survey.create(survey2);


      const survey3 = {
        created: new Date(),
        formid: '4hu24',
        form: '{"form": "form detail"}',
        messages: '{"foo": "bar"}',
        shortcode: "123",
        userid: newUser.id,
        title: 'Other survey',
        metadata: '{}',
        survey_name: 'Survey',
        translation_conf: '{}'
      };
      const createdSurvey3 = await Survey.create(survey3);

      const offTime = "2023-06-26T18:17:03.054Z"
      // Update both survey2 and survey3 (both have shortcode "123")
      await Survey.update({ surveyid: createdSurvey2.id, timeouts: undefined, off_time: offTime })
      await Survey.update({ surveyid: createdSurvey3.id, timeouts: undefined, off_time: offTime })

      const rows = await Survey.retrieve({ email: 'test2@vlab.com' });
      rows.length.should.be.equal(3);

      // Rows are ordered by created DESC, so survey3 first, then survey2, then survey1
      rows[0].shortcode.should.equal("123")
      rows[0].off_time.toISOString().should.equal(offTime)
      rows[1].shortcode.should.equal("123")
      rows[1].off_time.toISOString().should.equal(offTime)
      rows[2].shortcode.should.equal("231")
      expect(rows[2].off_time).to.not.exist;
    });
  });

  describe('.update()', () => {

    it('should insert new settings if it does not exist', async () => {
      const user2 = {
        email: 'test2@vlab.com',
      };
      const newUser = await User.create(user2);

      const survey = {
        created: new Date(),
        formid: 'test-form',
        form: '{"form": "form detail"}',
        messages: '{"foo": "bar"}',
        shortcode: "foo",
        userid: newUser.id,
        title: 'Test Survey',
        metadata: '{}',
        survey_name: 'Test',
        translation_conf: '{}'
      };
      const createdSurvey = await Survey.create(survey);

      const offTime = "2023-06-26T18:17:03.054Z"
      const update = await Survey.update({ surveyid: createdSurvey.id, timeouts: undefined, off_time: offTime })

      update.surveyid.should.eql(createdSurvey.id)
      update.off_time.toISOString().should.equal(offTime)
      expect(update.timeouts).to.be.null;
    });


    it('should overwrite settings if they do exist', async () => {
      const user2 = {
        email: 'test2@vlab.com',
      };
      const newUser = await User.create(user2);

      const survey = {
        created: new Date(),
        formid: 'test-form',
        form: '{"form": "form detail"}',
        messages: '{"foo": "bar"}',
        shortcode: "foo",
        userid: newUser.id,
        title: 'Test Survey',
        metadata: '{}',
        survey_name: 'Test',
        translation_conf: '{}'
      };
      const createdSurvey = await Survey.create(survey);

      const offTime1 = "2023-06-26T18:17:03.054Z"
      await Survey.update({ surveyid: createdSurvey.id, timeouts: undefined, off_time: offTime1 })

      const offTime2 = "2023-06-26T18:17:03.054Z"
      const timeouts = [{ foo: 'bar' }]
      const update = await Survey.update({ surveyid: createdSurvey.id, timeouts: timeouts, off_time: offTime2 })

      update.off_time.toISOString().should.equal(offTime2)
      // timeouts is stored as JSON string in the database
      const storedTimeouts = typeof update.timeouts === 'string' ? JSON.parse(update.timeouts) : update.timeouts;
      storedTimeouts.should.eql(timeouts)
    });
  });
});
