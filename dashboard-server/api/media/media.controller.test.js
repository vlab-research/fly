'use strict';

/*
 * Unit tests for the media controller's shell.
 *
 * These cover the sequencing and the failure semantics — what happens when
 * fan-out fails, when there are no accounts, when the same bytes arrive twice.
 * The bytes-and-rows behaviour that only a real object store and a real
 * database can show (metadata on the stored object, the dedupe asymmetry under
 * UNIQUE (userid, content_hash)) lives in media.integration.test.js.
 *
 * Deliberately NOT tested: that env vars parse, or that config fields exist
 * (§10 — configuration is owned by the deploy gates, logic by the suites).
 */

const chai = require('chai');
chai.should();
const { expect } = chai;

const { makeHandlers } = require('./media.controller');
const { MEDIA_TYPE_LIMITS } = require('./media.core');

// A real 1x1 8-bit PNG. Real bytes rather than a fixture string because
// validateUpload sniffs magic bytes and reads the IHDR — a fake would be
// rejected, and the test would then be testing the fake.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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

function fileReq(overrides = {}) {
  return {
    user: { email: 'test@vlab.com' },
    body: {},
    params: {},
    file: { buffer: PNG, originalname: 'welcome.png', mimetype: 'image/png', size: PNG.length },
    ...overrides,
  };
}

const ASSET_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('media.controller (makeHandlers)', () => {
  let puts;
  let deletes;
  let handleUpserts;
  let createdRows;

  function fakeStorage() {
    return {
      publicUrl: (id, filename) => `https://media.vlab.digital/a/${id}/${filename}`,
      async put(args) { puts.push(args); return { key: `a/${args.assetId}`, stored: true }; },
      async delete(args) { deletes.push(args); return { key: `a/${args.assetId}`, deleted: true }; },
    };
  }

  function fakeMediaQuery(overrides = {}) {
    return Object.assign(
      {
        findByHash: async () => undefined,
        create: async row => {
          createdRows.push(row);
          return {
            id: row.id,
            content_hash: row.contentHash,
            media_type: row.mediaType,
            mime_type: row.mimeType,
            byte_size: row.byteSize,
            filename: row.filename,
            created: '2026-08-10T00:00:00Z',
          };
        },
        list: async () => [],
        remove: async () => undefined,
        upsertHandle: async row => { handleUpserts.push(row); return row; },
      },
      overrides,
    );
  }

  function fakeCredentialQuery(accounts) {
    return { getMessagingAccounts: async () => accounts };
  }

  function okUpload() {
    return async ({ platform, accountId }) => ({
      ok: true,
      platform,
      platformMediaId: `mid-${accountId}`,
      uploadedAt: new Date('2026-08-10T00:00:00Z'),
      expiresAt: new Date('2026-11-08T00:00:00Z'),
    });
  }

  function build(deps = {}) {
    return makeHandlers({
      credentialQuery: deps.credentialQuery || fakeCredentialQuery([]),
      mediaQuery: deps.mediaQuery || fakeMediaQuery(),
      storage: deps.storage || fakeStorage(),
      platformUpload: deps.platformUpload || okUpload(),
      newId: deps.newId || (() => ASSET_ID),
    });
  }

  beforeEach(() => {
    puts = [];
    deletes = [];
    handleUpserts = [];
    createdRows = [];
  });

  // -------------------------------------------------------
  // Validation — the error must name the problem AND the fix
  // -------------------------------------------------------
  describe('uploadMedia validation', () => {
    it('rejects an oversize image with the actionable per-type error, not a generic one', async () => {
      // 6 MB of PNG: past the image cap (5 MB), well under the multer cap
      // (100 MB, the largest per-type limit), so the message must come from the
      // core and name both sizes. A multer-level cap below 100 MB would preempt
      // this and say "file too large" instead — the regression §11.5 is about.
      const big = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]);
      const res = mockRes();
      await build().uploadMedia(fileReq({
        file: { buffer: big, originalname: 'big.png', mimetype: 'image/png', size: big.length },
      }), res);

      res.statusCode.should.equal(400);
      res.body.error.should.match(/^image is 6\.\d MB, maximum is 5\.0 MB$/);
      puts.should.have.length(0);
      createdRows.should.have.length(0);
    });

    it('rejects an ineligible type by naming it and the accepted alternatives', async () => {
      const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(64)]);
      const res = mockRes();
      await build().uploadMedia(fileReq({
        file: { buffer: gif, originalname: 'anim.gif', mimetype: 'image/gif', size: gif.length },
      }), res);

      res.statusCode.should.equal(400);
      res.body.error.should.equal('GIF is not supported; use JPEG or PNG');
    });

    it('never stores bytes it refused', async () => {
      const html = Buffer.from('<html><script>alert(1)</script></html>');
      const res = mockRes();
      await build().uploadMedia(fileReq({
        file: { buffer: html, originalname: 'evil.png', mimetype: 'image/png', size: html.length },
      }), res);

      res.statusCode.should.equal(400);
      puts.should.have.length(0);
    });

    it('the multer cap is the largest per-type limit, so it can never preempt a per-type error', () => {
      // Pins the derivation in media.routes.js rather than the number: the cap
      // must be >= every per-type limit, or the core stops being the thing that
      // decides eligibility.
      const routes = require('./media.routes');
      const largest = Math.max(...Object.values(MEDIA_TYPE_LIMITS).map(l => l.maxBytes));
      routes.MAX_UPLOAD_BYTES.should.equal(largest);
    });
  });

  // -------------------------------------------------------
  // The happy path and its ordering
  // -------------------------------------------------------
  describe('uploadMedia', () => {
    it('returns 201 with a public URL, and stores the bytes with the sniffed type', async () => {
      const res = mockRes();
      await build().uploadMedia(fileReq(), res);

      res.statusCode.should.equal(201);
      res.body.id.should.equal(ASSET_ID);
      res.body.url.should.equal(`https://media.vlab.digital/a/${ASSET_ID}/welcome.png`);
      res.body.mediaType.should.equal('image');

      puts.should.have.length(1);
      puts[0].assetId.should.equal(ASSET_ID);
      puts[0].contentType.should.equal('image/png');
      puts[0].filename.should.equal('welcome.png');
    });

    it('never returns a platform identifier or handle state to the author', async () => {
      // §3: attachment_id disappears from the authoring interface, and handle
      // state is our problem, not the researcher's.
      const res = mockRes();
      await build({ credentialQuery: fakeCredentialQuery([
        { entity: 'facebook_page', key: 'page-1', details: { access_token: 't' } },
      ]) }).uploadMedia(fileReq(), res);

      Object.keys(res.body).should.deep.equal(
        ['id', 'filename', 'mediaType', 'mimeType', 'byteSize', 'created', 'url'],
      );
    });

    it('does not trust the claimed content type', async () => {
      const res = mockRes();
      await build().uploadMedia(fileReq({
        file: { buffer: PNG, originalname: 'welcome.png', mimetype: 'text/html', size: PNG.length },
      }), res);

      res.statusCode.should.equal(201);
      puts[0].contentType.should.equal('image/png');
    });

    it('returns the existing asset for identical bytes, with no second row and no second object', async () => {
      const existing = {
        id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        content_hash: 'h',
        media_type: 'image',
        mime_type: 'image/png',
        byte_size: PNG.length,
        filename: 'welcome.png',
        created: '2026-08-01T00:00:00Z',
      };
      const res = mockRes();
      await build({ mediaQuery: fakeMediaQuery({ findByHash: async () => existing }) })
        .uploadMedia(fileReq(), res);

      res.statusCode.should.equal(200);
      res.body.id.should.equal(existing.id);
      puts.should.have.length(0);
      createdRows.should.have.length(0);
    });

    it('returns 500 without a response body leak when storage fails', async () => {
      const storage = fakeStorage();
      storage.put = async () => { throw new Error('MinIO unreachable'); };
      const res = mockRes();
      await build({ storage }).uploadMedia(fileReq(), res);

      res.statusCode.should.equal(500);
      createdRows.should.have.length(0);
    });
  });

  // -------------------------------------------------------
  // Fan-out — best-effort, and keyed on credentials.key
  // -------------------------------------------------------
  describe('uploadMedia fan-out', () => {
    const accounts = [
      { entity: 'facebook_page', key: 'page-111', details: { access_token: 'tok-a', page_id: 'IGNORED' } },
      { entity: 'facebook_page', key: 'page-222', details: { access_token: 'tok-b' } },
      { entity: 'whatsapp_business', key: '15550001111', details: { access_token: 'tok-c' } },
    ];

    it('writes account_id = credentials.key for every one of the owner\'s accounts', async () => {
      // THE SEAM THAT MATTERS. message-worker looks a handle up by
      // (asset_id, account_id) alone; account_id is credentials.key. Writing
      // the entity, or details.page_id, would produce handles nothing ever
      // reads — and the failure would be INVISIBLE, because a lookup miss is
      // the designed URL fallback rather than an error.
      const res = mockRes();
      await build({ credentialQuery: fakeCredentialQuery(accounts) }).uploadMedia(fileReq(), res);

      handleUpserts.map(h => h.accountId).sort()
        .should.deep.equal(['15550001111', 'page-111', 'page-222']);
      handleUpserts.every(h => h.assetId === ASSET_ID).should.equal(true);
    });

    it('records the canonical platform, not the credentials.entity spelling', async () => {
      // platform is descriptive only and never a lookup key, but the two
      // spellings in this codebase are exactly the trap the account_id-only key
      // exists to avoid, so the one written is normalised.
      const res = mockRes();
      await build({ credentialQuery: fakeCredentialQuery(accounts) }).uploadMedia(fileReq(), res);

      const byAccount = new Map(handleUpserts.map(h => [h.accountId, h.platform]));
      byAccount.get('page-111').should.equal('messenger');
      byAccount.get('15550001111').should.equal('whatsapp');
    });

    it('never writes a handle with no expiry', async () => {
      // A handle with no expiry is one the reconciler can never refresh: it
      // dies silently and every send falls back to URL forever. Messenger was
      // wrongly recorded as never expiring until 2026-08-10 (§2).
      const res = mockRes();
      await build({ credentialQuery: fakeCredentialQuery(accounts) }).uploadMedia(fileReq(), res);

      handleUpserts.forEach(h => expect(h.expiresAt).to.be.an.instanceOf(Date));
    });

    it('succeeds with ZERO connected accounts', async () => {
      // §3: dropping the connected-page requirement for asset creation is the
      // point. The reconciler backfills handles when an account is connected.
      const res = mockRes();
      await build({ credentialQuery: fakeCredentialQuery([]) }).uploadMedia(fileReq(), res);

      res.statusCode.should.equal(201);
      res.body.url.should.contain('/a/');
      handleUpserts.should.have.length(0);
    });

    it('a failure on one account does not fail the upload, and the others still get handles', async () => {
      const res = mockRes();
      await build({
        credentialQuery: fakeCredentialQuery(accounts),
        platformUpload: async ({ platform, accountId }) =>
          accountId === 'page-222'
            ? { ok: false, error: 'Invalid OAuth access token' }
            : {
              ok: true,
              platform,
              platformMediaId: `mid-${accountId}`,
              uploadedAt: new Date(),
              expiresAt: new Date(Date.now() + 1000),
            },
      }).uploadMedia(fileReq(), res);

      res.statusCode.should.equal(201);
      res.body.url.should.contain(ASSET_ID);
      handleUpserts.map(h => h.accountId).sort().should.deep.equal(['15550001111', 'page-111']);
    });

    it('a thrown platform error does not fail the upload', async () => {
      const res = mockRes();
      await build({
        credentialQuery: fakeCredentialQuery(accounts),
        platformUpload: async () => { throw new Error('ETIMEDOUT'); },
      }).uploadMedia(fileReq(), res);

      res.statusCode.should.equal(201);
      handleUpserts.should.have.length(0);
    });

    it('an account lookup failure does not fail the upload', async () => {
      const res = mockRes();
      await build({
        credentialQuery: { getMessagingAccounts: async () => { throw new Error('DB down'); } },
      }).uploadMedia(fileReq(), res);

      res.statusCode.should.equal(201);
    });

    it('a handle write failure does not fail the upload', async () => {
      const res = mockRes();
      await build({
        credentialQuery: fakeCredentialQuery(accounts),
        mediaQuery: fakeMediaQuery({ upsertHandle: async () => { throw new Error('write failed'); } }),
      }).uploadMedia(fileReq(), res);

      res.statusCode.should.equal(201);
    });

    it('does not fan out on a dedupe hit — the reconciler owns existing assets', async () => {
      const existing = {
        id: ASSET_ID, content_hash: 'h', media_type: 'image', mime_type: 'image/png',
        byte_size: 1, filename: 'welcome.png', created: 'now',
      };
      const res = mockRes();
      await build({
        credentialQuery: fakeCredentialQuery(accounts),
        mediaQuery: fakeMediaQuery({ findByHash: async () => existing }),
      }).uploadMedia(fileReq(), res);

      res.statusCode.should.equal(200);
      handleUpserts.should.have.length(0);
    });
  });

  // -------------------------------------------------------
  // listMedia
  // -------------------------------------------------------
  describe('listMedia', () => {
    it('returns each asset with a derived URL and no userid', async () => {
      const rows = [{
        id: ASSET_ID, content_hash: 'h', media_type: 'image', mime_type: 'image/png',
        byte_size: 4096, filename: 'welcome.png', created: '2026-08-10T00:00:00Z',
        userid: 'MUST NOT LEAK',
      }];
      const res = mockRes();
      await build({ mediaQuery: fakeMediaQuery({ list: async () => rows }) })
        .listMedia({ user: { email: 'test@vlab.com' } }, res);

      res.statusCode.should.equal(200);
      res.body.should.have.length(1);
      res.body[0].should.not.have.property('userid');
      res.body[0].url.should.equal(`https://media.vlab.digital/a/${ASSET_ID}/welcome.png`);
      res.body[0].byteSize.should.equal(4096);
    });

    it('returns an empty array when there is no media', async () => {
      const res = mockRes();
      await build().listMedia({ user: { email: 'test@vlab.com' } }, res);
      res.statusCode.should.equal(200);
      res.body.should.deep.equal([]);
    });

    it('returns 500 when the query throws', async () => {
      const res = mockRes();
      await build({ mediaQuery: fakeMediaQuery({ list: async () => { throw new Error('DB down'); } }) })
        .listMedia({ user: { email: 'test@vlab.com' } }, res);
      res.statusCode.should.equal(500);
    });
  });

});
