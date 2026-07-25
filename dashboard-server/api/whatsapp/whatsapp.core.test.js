'use strict';

const chai = require('chai');
const should = chai.should(); // eslint-disable-line no-unused-vars

const {
  validateExchangeInput,
  parseExchangeResponse,
  parseSubscribeResponse,
} = require('./whatsapp.core');

describe('whatsapp.core', () => {
  // -------------------------------------------------------
  // validateExchangeInput
  // -------------------------------------------------------
  describe('validateExchangeInput', () => {
    it('accepts valid code and phone_number_id', () => {
      validateExchangeInput({ code: 'abc123', phone_number_id: '1234567890', waba_id: 'waba_555' })
        .should.deep.equal({ valid: true });
    });

    it('rejects missing code', () => {
      const result = validateExchangeInput({ code: undefined, phone_number_id: '1234567890', waba_id: 'waba_555' });
      result.valid.should.equal(false);
      result.error.should.include('code');
    });

    it('rejects empty string code', () => {
      const result = validateExchangeInput({ code: '', phone_number_id: '1234567890', waba_id: 'waba_555' });
      result.valid.should.equal(false);
      result.error.should.include('code');
    });

    it('rejects whitespace-only code', () => {
      const result = validateExchangeInput({ code: '   ', phone_number_id: '1234567890', waba_id: 'waba_555' });
      result.valid.should.equal(false);
      result.error.should.include('code');
    });

    it('rejects missing phone_number_id', () => {
      const result = validateExchangeInput({ code: 'abc123', phone_number_id: undefined, waba_id: 'waba_555' });
      result.valid.should.equal(false);
      result.error.should.include('phone_number_id');
    });

    it('rejects empty string phone_number_id', () => {
      const result = validateExchangeInput({ code: 'abc123', phone_number_id: '', waba_id: 'waba_555' });
      result.valid.should.equal(false);
      result.error.should.include('phone_number_id');
    });

    it('rejects whitespace-only phone_number_id', () => {
      const result = validateExchangeInput({ code: 'abc123', phone_number_id: '   ', waba_id: 'waba_555' });
      result.valid.should.equal(false);
      result.error.should.include('phone_number_id');
    });

    it('rejects non-string code', () => {
      const result = validateExchangeInput({ code: 12345, phone_number_id: '1234567890', waba_id: 'waba_555' });
      result.valid.should.equal(false);
      result.error.should.include('code');
    });

    it('rejects non-string phone_number_id', () => {
      const result = validateExchangeInput({ code: 'abc123', phone_number_id: 12345, waba_id: 'waba_555' });
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

  // -------------------------------------------------------
  // validateExchangeInput: waba_id
  // -------------------------------------------------------
  describe('validateExchangeInput waba_id', () => {
    it('rejects missing waba_id', () => {
      const result = validateExchangeInput({ code: 'abc123', phone_number_id: '123', waba_id: undefined });
      result.valid.should.equal(false);
      result.error.should.include('waba_id');
    });

    it('rejects empty waba_id', () => {
      const result = validateExchangeInput({ code: 'abc123', phone_number_id: '123', waba_id: '  ' });
      result.valid.should.equal(false);
      result.error.should.include('waba_id');
    });

    it('rejects non-string waba_id', () => {
      const result = validateExchangeInput({ code: 'abc123', phone_number_id: '123', waba_id: 999 });
      result.valid.should.equal(false);
      result.error.should.include('waba_id');
    });
  });

  // -------------------------------------------------------
  // parseSubscribeResponse
  // -------------------------------------------------------
  describe('parseSubscribeResponse', () => {
    it('accepts { success: true }', () => {
      parseSubscribeResponse({ success: true }).should.deep.equal({ ok: true });
    });

    it('rejects an FB error response', () => {
      const error = { message: 'nope', code: 200 };
      const result = parseSubscribeResponse({ error });
      result.ok.should.equal(false);
      result.error.should.deep.equal(error);
    });

    it('rejects success: false', () => {
      const result = parseSubscribeResponse({ success: false });
      result.ok.should.equal(false);
      result.error.message.should.include('subscription');
    });

    it('rejects empty/null response', () => {
      parseSubscribeResponse(null).ok.should.equal(false);
      parseSubscribeResponse(undefined).ok.should.equal(false);
    });

    it('rejects a response with neither success nor error', () => {
      parseSubscribeResponse({}).ok.should.equal(false);
    });
  });
});
