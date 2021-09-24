/* eslint-disable no-unused-expressions */
const { Pool } = require('pg');
const chai = require('chai');
chai.should();

require('mocha');

const surveyModel = require('./survey.queries');
const userModel = require('../users/user.queries');

const { DATABASE_CONFIG } = require('../../config');

describe('Survey queries', () => {
  let Survey;
  let User;
  let vlabPool;

  before(async () => {
    let pool = new Pool({
      user: 'root',
      host: 'localhost',
      database: 'defaultdb',
      password: undefined,
      port: 5432,
    });

    try {
      await pool.query('CREATE DATABASE chatroach;');
    } catch (e) {}

    vlabPool = new Pool(DATABASE_CONFIG);

    await vlabPool.query(
      `CREATE TABLE chatroach.users(
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       token VARCHAR NOT NULL,
       email VARCHAR NOT NULL UNIQUE
      )`,
    );

    await vlabPool.query(
      `CREATE TABLE chatroach.facebook_pages(
       pageid VARCHAR PRIMARY KEY,
       userid UUID REFERENCES chatroach.users(id) ON DELETE CASCADE
       );`,
    );

    await vlabPool.query(
      `CREATE TABLE chatroach.surveys(
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       created TIMESTAMPTZ NOT NULL,
       formid VARCHAR NOT NULL,
       form VARCHAR NOT NULL,
       messages VARCHAR,
       shortcode INT4 NOT NULL,
       title VARCHAR NOT NULL,
       userid UUID NOT NULL REFERENCES chatroach.users(id) ON DELETE CASCADE
      )`,
    );

    User = userModel.queries(vlabPool);
    Survey = surveyModel.queries(vlabPool);
  });

  afterEach(async () => {
    await vlabPool.query('DELETE FROM users');
    await vlabPool.query('DELETE FROM surveys');
  });

  after(async () => {
    await vlabPool.query('DROP TABLE users CASCADE');
    await vlabPool.query('DROP TABLE facebook_pages');
    await vlabPool.query('DROP TABLE surveys');
  });

  describe('.create()', () => {
    it('should insert a new survey and return the newly created record', async () => {
      const user = {
        token: 'HxpnYoykme73Jz1c9DdAxPws77GzH9jLqE1wu1piSqJj',
        email: 'test@vlab.com',
      };
      const newUser = await User.create(user);

      newUser.token.should.equal(user.token);
      newUser.email.should.equal(user.email);

      const survey = {
        created: new Date(),
        formid: 'S8yR4',
        form: '{"form": "form detail"}',
        messages: '{"foo": "bar"}',
        shortcode: 123,
        userid: newUser.id,
        title: 'New User Title',
      };
      const newSurvey = await Survey.create(survey);
      newSurvey.formid.should.equal('S8yR4');
      newSurvey.form.should.equal('{"form": "form detail"}');
      newSurvey.shortcode.should.equal(123);
      newSurvey.userid.should.equal(newUser.id);
      newSurvey.title.should.equal('New User Title');
    });
  });

  describe('.retrieve()', () => {
    it('should insert a new survey and return the newly created record', async () => {
      const user2 = {
        token: 'dasfYoykme73Jz1c93d1xPws77GzuhNU0f1wu1pHeh91',
        email: 'test2@vlab.com',
      };
      const newUser = await User.create(user2);

      const survey = {
        created: new Date(),
        formid: 'biy23',
        form: '{"form": "form detail"}',
        messages: '{"foo": "bar"}',
        shortcode: 231,
        userid: newUser.id,
        title: 'Second Survey',
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
      };
      await Survey.create(survey2);

      const rows = await Survey.retrieve({ email: 'test2@vlab.com' });
      rows.length.should.be.equal(2);
    });
  });
});
