'use strict';

const chai = require('chai');
const should = chai.should(); // eslint-disable-line no-unused-vars

const {
  parseUserIds,
  validateCreate,
  validateReply,
} = require('./tickets.core');

describe('tickets.core', () => {
  // -------------------------------------------------------
  // parseUserIds — splits comma/newline/whitespace-separated input
  // -------------------------------------------------------
  describe('parseUserIds', () => {
    it('splits on commas', () => {
      parseUserIds('123,456,789').should.deep.equal(['123', '456', '789']);
    });

    it('splits on newlines', () => {
      parseUserIds('123\n456\n789').should.deep.equal(['123', '456', '789']);
    });

    it('splits on whitespace', () => {
      parseUserIds('123 456').should.deep.equal(['123', '456']);
    });

    it('drops empty entries and trims whitespace', () => {
      parseUserIds('  123 , , 456  ').should.deep.equal(['123', '456']);
    });

    it('drops duplicates, preserving first-seen order', () => {
      parseUserIds('123,456,123').should.deep.equal(['123', '456']);
    });

    it('returns [] for null/empty input', () => {
      parseUserIds(null).should.deep.equal([]);
      parseUserIds('').should.deep.equal([]);
      parseUserIds(undefined).should.deep.equal([]);
    });

    it('passes through an already-array input, trimmed and de-duplicated', () => {
      parseUserIds(['  123 ', '456', '123']).should.deep.equal(['123', '456']);
    });
  });

  // -------------------------------------------------------
  // validateCreate
  // -------------------------------------------------------
  describe('validateCreate', () => {
    const valid = { title: 'Form stuck', description: 'It broke', surveyName: 'HPV', userIds: '123,456' };

    it('accepts complete input and normalizes fields', () => {
      const r = validateCreate(valid);
      r.valid.should.equal(true);
      r.title.should.equal('Form stuck');
      r.description.should.equal('It broke');
      r.surveyName.should.equal('HPV');
      r.userIds.should.deep.equal(['123', '456']);
    });

    it('accepts input without optional survey/userIds', () => {
      const r = validateCreate({ title: 'T', description: 'D' });
      r.valid.should.equal(true);
      should.equal(r.surveyName, null);
      r.userIds.should.deep.equal([]);
    });

    it('rejects missing title', () => {
      validateCreate({ ...valid, title: undefined }).valid.should.equal(false);
    });

    it('rejects whitespace-only title', () => {
      validateCreate({ ...valid, title: '   ' }).valid.should.equal(false);
    });

    it('rejects missing description', () => {
      const r = validateCreate({ ...valid, description: undefined });
      r.valid.should.equal(false);
      r.error.should.include('description');
    });

    it('rejects title over the length cap', () => {
      const r = validateCreate({ ...valid, title: 'x'.repeat(257) });
      r.valid.should.equal(false);
      r.error.should.include('title');
    });

    it('rejects description over the length cap', () => {
      const r = validateCreate({ ...valid, description: 'x'.repeat(20001) });
      r.valid.should.equal(false);
      r.error.should.include('description');
    });

    it('rejects more than 200 impacted user IDs', () => {
      const r = validateCreate({ ...valid, userIds: Array.from({ length: 201 }, (_, i) => String(i)).join(',') });
      r.valid.should.equal(false);
      r.error.should.include('user IDs');
    });

    it('normalizes surveyName to null when blank', () => {
      const r = validateCreate({ ...valid, surveyName: '   ' });
      r.valid.should.equal(true);
      should.equal(r.surveyName, null);
    });
  });

  // -------------------------------------------------------
  // validateReply
  // -------------------------------------------------------
  describe('validateReply', () => {
    it('accepts a non-empty body', () => {
      validateReply({ body: 'Thanks' }).should.deep.equal({ valid: true, body: 'Thanks' });
    });

    it('rejects missing body', () => {
      const r = validateReply({ body: undefined });
      r.valid.should.equal(false);
      r.error.should.include('required');
    });

    it('rejects whitespace-only body', () => {
      validateReply({ body: '   ' }).valid.should.equal(false);
    });

    it('rejects body over the length cap', () => {
      const r = validateReply({ body: 'x'.repeat(20001) });
      r.valid.should.equal(false);
      r.error.should.include('reply');
    });

    it('trims a valid body', () => {
      validateReply({ body: '  hi  ' }).body.should.equal('hi');
    });
  });
});
