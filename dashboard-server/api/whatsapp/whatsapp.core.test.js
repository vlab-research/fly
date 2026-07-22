'use strict';

const chai = require('chai');
const should = chai.should(); // eslint-disable-line no-unused-vars

const {
  validateExchangeInput,
  parseExchangeResponse,
} = require('./whatsapp.core');

describe('whatsapp.core', () => {
  // -------------------------------------------------------
  // validateExchangeInput
  // -------------------------------------------------------
  describe('validateExchangeInput', () => {
    it('accepts valid code and phone_number_id', () => {
      validateExchangeInput({ code: 'abc123', phone_number_id: '1234567890' })
        .should.deep.equal({ valid: true });
    });

    it('rejects missing code', () => {
      const result = validateExchangeInput({ code: undefined, phone_number_id: '1234567890' });
      result.valid.should.equal(false);
      result.error.should.include('code');
    });

    it('rejects empty string code', () => {
      const result = validateExchangeInput({ code: '', phone_number_id: '1234567890' });
      result.valid.should.equal(false);
      result.error.should.include('code');
    });

    it('rejects whitespace-only code', () => {
      const result = validateExchangeInput({ code: '   ', phone_number_id: '1234567890' });
      result.valid.should.equal(false);
      result.error.should.include('code');
    });

    it('rejects missing phone_number_id', () => {
      const result = validateExchangeInput({ code: 'abc123', phone_number_id: undefined });
      result.valid.should.equal(false);
      result.error.should.include('phone_number_id');
    });

    it('rejects empty string phone_number_id', () => {
      const result = validateExchangeInput({ code: 'abc123', phone_number_id: '' });
      result.valid.should.equal(false);
      result.error.should.include('phone_number_id');
    });

    it('rejects whitespace-only phone_number_id', () => {
      const result = validateExchangeInput({ code: 'abc123', phone_number_id: '   ' });
      result.valid.should.equal(false);
      result.error.should.include('phone_number_id');
    });

    it('rejects non-string code', () => {
      const result = validateExchangeInput({ code: 12345, phone_number_id: '1234567890' });
      result.valid.should.equal(false);
      result.error.should.include('code');
    });

    it('rejects non-string phone_number_id', () => {
      const result = validateExchangeInput({ code: 'abc123', phone_number_id: 12345 });
      result.valid.should.equal(false);
      result.error.should.include('phone_number_id');
    });
  });

  // -------------------------------------------------------
  // parseExchangeResponse
  // -------------------------------------------------------
  describe('parseExchangeResponse', () => {
    it('extracts access_token from a successful Facebook response', () => {
      parseExchangeResponse({ access_token: 'token123', token_type: 'bearer' })
        .should.deep.equal({ ok: true, accessToken: 'token123' });
    });

    it('forwards the full Facebook error object on API errors', () => {
      const fbError = { message: 'Invalid code', type: 'OAuthException', code: 100 };
      const result = parseExchangeResponse({ error: fbError });
      result.ok.should.equal(false);
      result.error.should.deep.equal(fbError);
    });

    it('rejects null response', () => {
      const result = parseExchangeResponse(null);
      result.ok.should.equal(false);
      result.error.should.have.property('message');
    });

    it('rejects undefined response', () => {
      const result = parseExchangeResponse(undefined);
      result.ok.should.equal(false);
      result.error.should.have.property('message');
    });

    it('rejects response missing access_token', () => {
      const result = parseExchangeResponse({ token_type: 'bearer' });
      result.ok.should.equal(false);
      result.error.should.have.property('message');
    });

    it('prefers error field over missing access_token', () => {
      const fbError = { message: 'Already used code', code: 100 };
      const result = parseExchangeResponse({ error: fbError });
      result.error.should.deep.equal(fbError);
    });

    it('handles empty object response', () => {
      const result = parseExchangeResponse({});
      result.ok.should.equal(false);
      result.error.should.have.property('message');
    });
  });
});
