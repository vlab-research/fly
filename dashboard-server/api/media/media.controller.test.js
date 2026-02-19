'use strict';

const chai = require('chai');
chai.should();

const { makeHandlers } = require('./media.controller');

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

describe('media.controller (makeHandlers)', () => {
  // Default mock dependencies
  const defaultCredentialQuery = {
    getOne: async () => ({ entity: 'facebook_page', key: 'page1', details: { access_token: 'tok123', id: 'page1', name: 'Test Page' } }),
    get: async () => [
      { entity: 'facebook_page', details: { id: 'p1', name: 'Page One', access_token: 'tok' } },
    ],
  };
  const defaultMediaQuery = {
    create: async (record) => ({ id: 'uuid-new', ...record, created: '2026-01-01T00:00:00Z' }),
    list: async () => [],
  };
  const defaultFacebookClient = async () => ({ attachment_id: '9876543210' });

  function makeTestHandlers(overrides = {}) {
    return makeHandlers({
      credentialQuery: overrides.credentialQuery || defaultCredentialQuery,
      mediaQuery: overrides.mediaQuery || defaultMediaQuery,
      facebookClient: overrides.facebookClient || defaultFacebookClient,
    });
  }

  // -------------------------------------------------------
  // uploadMedia
  // -------------------------------------------------------
  describe('uploadMedia', () => {
    const validReq = {
      user: { email: 'test@vlab.com' },
      body: { pageId: 'page1', mediaType: 'image' },
      file: { buffer: Buffer.from('data'), originalname: 'pic.jpg', mimetype: 'image/jpeg', size: 1024 },
    };

    it('returns 400 when validation fails (missing pageId)', async () => {
      const handlers = makeTestHandlers();
      const req = { ...validReq, body: { mediaType: 'image' } };
      const res = mockRes();

      await handlers.uploadMedia(req, res);
      res.statusCode.should.equal(400);
      res.body.error.should.include('pageId');
    });

    it('returns 404 when page credential is not found', async () => {
      const handlers = makeTestHandlers({
        credentialQuery: { ...defaultCredentialQuery, getOne: async () => null },
      });
      const res = mockRes();

      await handlers.uploadMedia(validReq, res);
      res.statusCode.should.equal(404);
      res.body.error.should.include('Page not found');
    });

    it('returns 502 when Facebook returns an error', async () => {
      const fbError = { message: 'Invalid token', type: 'OAuthException', code: 190 };
      const handlers = makeTestHandlers({
        facebookClient: async () => ({ error: fbError }),
      });
      const res = mockRes();

      await handlers.uploadMedia(validReq, res);
      res.statusCode.should.equal(502);
      res.body.error.should.deep.equal(fbError);
    });

    it('returns 201 with saved record on success', async () => {
      const handlers = makeTestHandlers();
      const res = mockRes();

      await handlers.uploadMedia(validReq, res);
      res.statusCode.should.equal(201);
      res.body.should.have.property('id');
      res.body.should.have.property('attachmentId', '9876543210');
    });

    it('passes correct token to facebookClient', async () => {
      let capturedToken;
      const handlers = makeTestHandlers({
        facebookClient: async (token) => { capturedToken = token; return { attachment_id: '111' }; },
      });
      const res = mockRes();

      await handlers.uploadMedia(validReq, res);
      capturedToken.should.equal('tok123');
    });

    it('passes correct record to mediaQuery.create', async () => {
      let capturedRecord;
      const handlers = makeTestHandlers({
        mediaQuery: {
          ...defaultMediaQuery,
          create: async (record) => { capturedRecord = record; return { id: 'uuid', ...record }; },
        },
      });
      const res = mockRes();

      await handlers.uploadMedia(validReq, res);
      capturedRecord.email.should.equal('test@vlab.com');
      capturedRecord.facebookPageId.should.equal('page1');
      capturedRecord.attachmentId.should.equal('9876543210');
      capturedRecord.mediaType.should.equal('image');
      capturedRecord.filename.should.equal('pic.jpg');
    });

    it('returns 500 when credentialQuery throws', async () => {
      const handlers = makeTestHandlers({
        credentialQuery: { ...defaultCredentialQuery, getOne: async () => { throw new Error('DB down'); } },
      });
      const res = mockRes();

      await handlers.uploadMedia(validReq, res);
      res.statusCode.should.equal(500);
      res.body.should.have.property('error');
    });

    it('returns 500 when facebookClient throws (network error)', async () => {
      const handlers = makeTestHandlers({
        facebookClient: async () => { throw new Error('ETIMEDOUT'); },
      });
      const res = mockRes();

      await handlers.uploadMedia(validReq, res);
      res.statusCode.should.equal(500);
      res.body.error.should.include('ETIMEDOUT');
    });

    it('returns 500 when mediaQuery.create throws', async () => {
      const handlers = makeTestHandlers({
        mediaQuery: {
          ...defaultMediaQuery,
          create: async () => { throw new Error('DB connection lost'); },
        },
      });
      const res = mockRes();

      await handlers.uploadMedia(validReq, res);
      res.statusCode.should.equal(500);
      res.body.should.have.property('error');
    });
  });

  // -------------------------------------------------------
  // listMedia
  // -------------------------------------------------------
  describe('listMedia', () => {
    it('returns formatted media list', async () => {
      const rows = [
        { id: '1', facebook_page_id: 'p', attachment_id: 'a', media_type: 'image', filename: 'f.jpg', created: 't', userid: 'stripped' },
      ];
      const handlers = makeTestHandlers({
        mediaQuery: { ...defaultMediaQuery, list: async () => rows },
      });
      const res = mockRes();

      await handlers.listMedia({ user: { email: 'test@vlab.com' } }, res);
      res.statusCode.should.equal(200);
      res.body.should.have.length(1);
      res.body[0].should.not.have.property('userid');
    });

    it('returns empty array when no media exists', async () => {
      const handlers = makeTestHandlers();
      const res = mockRes();

      await handlers.listMedia({ user: { email: 'test@vlab.com' } }, res);
      res.statusCode.should.equal(200);
      res.body.should.deep.equal([]);
    });
  });

  // -------------------------------------------------------
  // listPages
  // -------------------------------------------------------
  describe('listPages', () => {
    it('returns filtered page list from credentials', async () => {
      const handlers = makeTestHandlers();
      const res = mockRes();

      await handlers.listPages({ user: { email: 'test@vlab.com' } }, res);
      res.statusCode.should.equal(200);
      res.body.should.deep.equal([{ id: 'p1', name: 'Page One' }]);
    });

    it('does not expose access_token', async () => {
      const handlers = makeTestHandlers();
      const res = mockRes();

      await handlers.listPages({ user: { email: 'test@vlab.com' } }, res);
      res.body[0].should.not.have.property('access_token');
    });
  });
});
