'use strict';

const chai = require('chai');
chai.should();

const { makeHandlers } = require('./whatsapp.controller');

// Helper: create a mock Express response
function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(data) { res.body = data; return res; },
    send(data) { res.body = data; return res; },
  };
  return res;
}

describe('whatsapp.controller (makeHandlers)', () => {
  const defaultFacebookClient = async () => ({ access_token: 'token123', token_type: 'bearer' });

  function makeTestHandlers(overrides = {}) {
    return makeHandlers({
      facebookClient: overrides.facebookClient || defaultFacebookClient,
    });
  }

  // -------------------------------------------------------
  // exchangeCode
  // -------------------------------------------------------
  describe('exchangeCode', () => {
    const validReq = {
      user: { email: 'test@vlab.com' },
      body: { code: 'auth_code_123', phone_number_id: '1234567890' },
    };

    it('returns 400 when code is missing', async () => {
      const handlers = makeTestHandlers();
      const req = { ...validReq, body: { phone_number_id: '1234567890' } };
      const res = mockRes();

      await handlers.exchangeCode(req, res);
      res.statusCode.should.equal(400);
      res.body.error.should.include('code');
    });

    it('returns 400 when phone_number_id is missing', async () => {
      const handlers = makeTestHandlers();
      const req = { ...validReq, body: { code: 'auth_code_123' } };
      const res = mockRes();

      await handlers.exchangeCode(req, res);
      res.statusCode.should.equal(400);
      res.body.error.should.include('phone_number_id');
    });

    it('returns 400 when code is empty string', async () => {
      const handlers = makeTestHandlers();
      const req = { ...validReq, body: { code: '', phone_number_id: '1234567890' } };
      const res = mockRes();

      await handlers.exchangeCode(req, res);
      res.statusCode.should.equal(400);
      res.body.error.should.include('code');
    });

    it('returns 400 when phone_number_id is empty string', async () => {
      const handlers = makeTestHandlers();
      const req = { ...validReq, body: { code: 'auth_code_123', phone_number_id: '' } };
      const res = mockRes();

      await handlers.exchangeCode(req, res);
      res.statusCode.should.equal(400);
      res.body.error.should.include('phone_number_id');
    });

    it('returns 400 when Facebook returns an error', async () => {
      const fbError = { message: 'Invalid code', type: 'OAuthException', code: 100 };
      const handlers = makeTestHandlers({
        facebookClient: async () => ({ error: fbError }),
      });
      const res = mockRes();

      await handlers.exchangeCode(validReq, res);
      res.statusCode.should.equal(400);
      res.body.error.should.deep.equal(fbError);
    });

    it('returns 200 with access_token and phone_number_id on success', async () => {
      const handlers = makeTestHandlers();
      const res = mockRes();

      await handlers.exchangeCode(validReq, res);
      res.statusCode.should.equal(200);
      res.body.should.have.property('access_token', 'token123');
      res.body.should.have.property('phone_number_id', '1234567890');
    });

    it('passes correct code to facebookClient', async () => {
      let capturedCode;
      const handlers = makeTestHandlers({
        facebookClient: async (code) => { capturedCode = code; return { access_token: 'token' }; },
      });
      const res = mockRes();

      await handlers.exchangeCode(validReq, res);
      capturedCode.should.equal('auth_code_123');
    });

    it('returns 500 when facebookClient throws', async () => {
      const handlers = makeTestHandlers({
        facebookClient: async () => { throw new Error('Network error'); },
      });
      const res = mockRes();

      await handlers.exchangeCode(validReq, res);
      res.statusCode.should.equal(500);
      res.body.should.have.property('error');
    });

    it('does not log the access_token on success', async () => {
      let loggedOutput = '';
      const originalError = console.error;
      console.error = (msg) => { loggedOutput += msg; };

      const handlers = makeTestHandlers();
      const res = mockRes();

      await handlers.exchangeCode(validReq, res);

      console.error = originalError;
      loggedOutput.should.not.include('token123');
    });
  });
});
