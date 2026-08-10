'use strict';

/*
 * Media upload against a REAL MinIO and a REAL CockroachDB.
 *
 *   docker compose up -d          (from dashboard-server/)
 *   npm run test:media
 *
 * Excluded from the default `npm test` glob (*.integration.test.js), because
 * these need the local stack up and failing loudly beats a suite that silently
 * skips the only tests that touch bytes.
 *
 * WHY THESE CANNOT BE UNIT TESTS. Two of the three properties here are
 * properties of the infrastructure, not of the code:
 *
 *   - The Content-Type and Content-Disposition on the STORED OBJECT are what
 *     media-proxy reads back, and reading them back is exactly what keeps the
 *     proxy database-free (§4.4). A mock storage client asserts that we called
 *     `put` with the right arguments, which is a different and much weaker
 *     claim than that S3 recorded them as the object's own metadata.
 *   - The dedupe asymmetry — same user gets the existing row, a DIFFERENT user
 *     uploading identical bytes gets their own — is enforced by
 *     UNIQUE (userid, content_hash) plus a per-user lookup. That is a database
 *     property (§5), and it is worth pinning because the plausible-looking
 *     alternative (global dedupe) would hide the second researcher's file from
 *     their own media tab.
 *
 * NOTHING HERE TALKS TO META. platformUpload is stubbed: fan-out's job in these
 * tests is to prove which account_id gets written, and a real Graph call would
 * make that untestable as well as unrunnable offline.
 */

const chai = require('chai');
chai.should();
const { expect } = chai;

const { Media, Credential, pool } = require('../../queries');
const { STORAGE } = require('../../config');
const { makeStorage } = require('./storage');
const { makeHandlers } = require('./media.controller');
const { hashContent } = require('./media.core');

const storage = makeStorage(STORAGE);

// Same bytes for every user in this suite: the dedupe tests turn on identity of
// content, so the buffer must be shared rather than recreated.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const SUFFIX = Date.now();
const OWNER = `media-owner-${SUFFIX}@vlab.test`;
const OTHER = `media-other-${SUFFIX}@vlab.test`;
const PAGE_A = `page-a-${SUFFIX}`;
const PAGE_B = `page-b-${SUFFIX}`;
const WABA_NUMBER = `wa-${SUFFIX}`;

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

function req(email, buffer = PNG, originalname = 'welcome.png', mimetype = 'image/png') {
  return {
    user: { email },
    body: {},
    params: {},
    file: { buffer, originalname, mimetype, size: buffer.length },
  };
}

function stubUpload(fail = () => false) {
  return async ({ platform, accountId }) => {
    if (fail(accountId)) return { ok: false, error: 'Invalid OAuth access token' };
    return {
      ok: true,
      platform,
      platformMediaId: `mid-${accountId}`,
      uploadedAt: new Date(),
      expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
    };
  };
}

function build(platformUpload) {
  return makeHandlers({
    credentialQuery: Credential,
    mediaQuery: Media,
    storage,
    platformUpload: platformUpload || stubUpload(),
  });
}

async function statObject(assetId) {
  return storage.client.statObject(storage.bucket, `a/${assetId}`);
}

async function objectExists(assetId) {
  try {
    await statObject(assetId);
    return true;
  } catch (e) {
    if (e.code === 'NotFound' || e.code === 'NoSuchKey') return false;
    throw e;
  }
}

describe('media upload (real MinIO + CockroachDB)', function () {
  this.timeout(30000);

  const createdAssets = [];

  before(async () => {
    // Fail loudly and immediately rather than 20 confusing assertion errors.
    if (storage.backend !== 's3') {
      throw new Error('media integration tests need STORAGE_BACKEND=s3 — is docker compose up?');
    }
    const exists = await storage.client.bucketExists(storage.bucket);
    if (!exists) {
      throw new Error(`bucket "${storage.bucket}" is missing — run: docker compose up -d`);
    }

    for (const email of [OWNER, OTHER]) {
      await pool.query('INSERT INTO users(email) VALUES ($1) ON CONFLICT (email) DO NOTHING', [email]);
    }
    // The owner's three messaging accounts. `key` is what must reach
    // media_handle.account_id; `details.id` and `details.page_id` are decoys
    // that a plausible-looking wrong implementation would pick instead.
    const accounts = [
      [OWNER, 'facebook_page', PAGE_A, { access_token: 'tok-a', id: PAGE_A, page_id: 'NOT-THE-KEY' }],
      [OWNER, 'facebook_page', PAGE_B, { access_token: 'tok-b', id: PAGE_B, page_id: 'NOT-THE-KEY' }],
      [OWNER, 'whatsapp_business', WABA_NUMBER, { access_token: 'tok-c', waba_id: 'NOT-THE-KEY' }],
      // A non-messaging credential, which must NOT be a fan-out target.
      [OWNER, 'typeform', `tf-${SUFFIX}`, { key: 'irrelevant' }],
    ];
    for (const [email, entity, key, details] of accounts) {
      await pool.query(
        `INSERT INTO credentials(userid, entity, key, details)
         VALUES ((SELECT id FROM users WHERE email = $1), $2, $3, $4)
         ON CONFLICT (entity, key) DO NOTHING`,
        [email, entity, key, JSON.stringify(details)],
      );
    }
  });

  after(async () => {
    for (const id of createdAssets) {
      try { await storage.delete({ assetId: id }); } catch (e) { /* already gone */ }
    }
    await pool.query('DELETE FROM users WHERE email = ANY($1)', [[OWNER, OTHER]]);
    await pool.end();
  });

  function track(res) {
    if (res.body && res.body.id) createdAssets.push(res.body.id);
    return res;
  }

  // -----------------------------------------------------------------
  // The object, and the metadata media-proxy serves back off it
  // -----------------------------------------------------------------
  it('lands an object carrying the Content-Type and Content-Disposition the proxy serves', async () => {
    const res = mockRes();
    await build().uploadMedia(req(OWNER), res);
    track(res);

    res.statusCode.should.equal(201);
    res.body.url.should.equal(`${STORAGE.publicBase}/a/${res.body.id}/welcome.png`);

    const stat = await statObject(res.body.id);
    // These two are the whole reason the proxy needs no database. If they stop
    // being written, the proxy serves media with no content type, browsers
    // sniff, and an uploaded payload becomes active content on our own domain.
    stat.metaData['content-type'].should.equal('image/png');
    stat.metaData['content-disposition'].should.contain('inline');
    stat.metaData['content-disposition'].should.contain('filename="welcome.png"');
    stat.size.should.equal(PNG.length);
  });

  it('keys the object on the uuid alone — the filename is cosmetic', async () => {
    // §5: the filename is in the URL for humans and for WhatsApp document
    // sends, but out of the key, so it can change without touching storage and
    // cannot collide.
    const res = mockRes();
    await build().uploadMedia(req(OWNER, PNG, 'a totally different name.png'), res);

    // Same bytes as the first test, same user: this is a dedupe hit, so it
    // returns the FIRST asset — filename and all.
    res.statusCode.should.equal(200);
    res.body.filename.should.equal('welcome.png');
  });

  // -----------------------------------------------------------------
  // Dedupe — per researcher, never global
  // -----------------------------------------------------------------
  it('returns the existing asset when the same user re-uploads identical bytes', async () => {
    // A distinct real image — a 1x1 JPEG — so the sniffer names it and the
    // hash differs from the PNG the other tests use.
    const jpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
      'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
      'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
      'base64',
    );

    const first = mockRes();
    await build().uploadMedia(req(OWNER, jpeg, 'chart.jpg', 'image/jpeg'), first);
    track(first);
    first.statusCode.should.equal(201);

    const second = mockRes();
    await build().uploadMedia(req(OWNER, jpeg, 'chart-again.jpg', 'image/jpeg'), second);

    second.statusCode.should.equal(200);
    second.body.id.should.equal(first.body.id);

    const { rows } = await pool.query(
      `SELECT count(*)::INT AS n FROM media_asset m JOIN users u ON m.userid = u.id
       WHERE u.email = $1 AND m.content_hash = $2`,
      [OWNER, hashContent(jpeg)],
    );
    // pg returns INT8 as a string; the count is what matters, not its type.
    Number(rows[0].n).should.equal(1);
  });

  it('gives a DIFFERENT user their own row for identical bytes', async () => {
    // Global dedupe would give both users one row, and the second
    // researcher's media tab — which filters by userid — would not show their
    // own file (§5).
    const res = mockRes();
    await build().uploadMedia(req(OTHER), res);
    track(res);

    res.statusCode.should.equal(201);

    const { rows } = await pool.query(
      'SELECT id FROM media_asset WHERE content_hash = $1 ORDER BY created ASC',
      [hashContent(PNG)],
    );
    rows.length.should.equal(2);
    rows.map(r => r.id).should.contain(res.body.id);

    // And each user sees exactly one.
    const listRes = mockRes();
    await build().listMedia({ user: { email: OTHER } }, listRes);
    listRes.body.should.have.length(1);
  });

  // -----------------------------------------------------------------
  // Fan-out
  // -----------------------------------------------------------------
  it('writes account_id = credentials.key for every one of the owner\'s messaging accounts', async () => {
    const res = mockRes();
    await build().uploadMedia(req(OWNER, pdf('fanout'), 'guide.pdf', 'application/pdf'), res);
    track(res);
    res.statusCode.should.equal(201);

    const handles = await Media.listHandles({ assetId: res.body.id });
    handles.map(h => h.account_id).sort()
      .should.deep.equal([PAGE_A, PAGE_B, WABA_NUMBER].sort());

    // Not the entity, not details->>'page_id'.
    handles.forEach(h => {
      h.account_id.should.not.equal('NOT-THE-KEY');
      h.account_id.should.not.equal('facebook_page');
      expect(h.expires_at).to.be.an.instanceOf(Date);
      h.platform_media_id.should.equal(`mid-${h.account_id}`);
    });

    const platforms = new Map(handles.map(h => [h.account_id, h.platform]));
    platforms.get(PAGE_A).should.equal('messenger');
    platforms.get(WABA_NUMBER).should.equal('whatsapp');
  });

  it('does not fail the upload when fan-out fails on one account', async () => {
    const res = mockRes();
    await build(stubUpload(id => id === PAGE_B))
      .uploadMedia(req(OWNER, pdf('partial'), 'partial.pdf', 'application/pdf'), res);
    track(res);

    // The asset exists and has a URL. The handle layer failing is not the
    // researcher's problem, and the reconciler backfills PAGE_B on its tick.
    res.statusCode.should.equal(201);
    res.body.url.should.contain(`/a/${res.body.id}/`);
    (await objectExists(res.body.id)).should.equal(true);

    const handles = await Media.listHandles({ assetId: res.body.id });
    handles.map(h => h.account_id).sort().should.deep.equal([PAGE_A, WABA_NUMBER].sort());
  });

  it('succeeds with zero connected accounts', async () => {
    // OTHER has no credentials at all: §3's real UX gain is that a researcher
    // can upload before connecting anything.
    const res = mockRes();
    await build().uploadMedia(req(OTHER, pdf('lonely'), 'lonely.pdf', 'application/pdf'), res);
    track(res);

    res.statusCode.should.equal(201);
    res.body.url.should.contain('/a/');
    (await objectExists(res.body.id)).should.equal(true);
    (await Media.listHandles({ assetId: res.body.id })).should.have.length(0);
  });

  it('is idempotent on repeated fan-out — one handle per (asset, account)', async () => {
    const res = mockRes();
    await build().uploadMedia(req(OWNER, pdf('idem'), 'idem.pdf', 'application/pdf'), res);
    track(res);

    const handlers = build();
    await handlers.fanOutHandles({
      email: OWNER,
      assetId: res.body.id,
      file: { buffer: PNG, filename: 'idem.pdf', contentType: 'application/pdf', mediaType: 'file' },
    });

    // The PRIMARY KEY (asset_id, account_id) is what enforces this, rather than
    // query discipline — which is why reconcile is idempotent by construction.
    (await Media.listHandles({ assetId: res.body.id })).should.have.length(3);
  });

  // -----------------------------------------------------------------
  // Rejection, with the actionable message
  // -----------------------------------------------------------------
  it('rejects an oversize video with the per-type error and stores nothing', async () => {
    const before = await countAssets(OWNER);
    // A real MP4 ftyp box then padding past the 16 MB video cap.
    const head = Buffer.from('000000206674797069736f6d', 'hex');
    const big = Buffer.concat([head, Buffer.alloc(17 * 1024 * 1024)]);

    const res = mockRes();
    await build().uploadMedia(req(OWNER, big, 'clip.mp4', 'video/mp4'), res);

    res.statusCode.should.equal(400);
    res.body.error.should.match(/^video is 17\.0 MB, maximum is 16\.0 MB$/);
    (await countAssets(OWNER)).should.equal(before);
  });

  // -----------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------
  it('deletes the row, the object, and cascades the handles', async () => {
    const res = mockRes();
    await build().uploadMedia(req(OWNER, pdf('doomed'), 'doomed.pdf', 'application/pdf'), res);
    const id = res.body.id;
    (await Media.listHandles({ assetId: id })).should.have.length(3);

    const del = mockRes();
    await build().deleteMedia({ user: { email: OWNER }, params: { id } }, del);

    del.statusCode.should.equal(204);
    (await objectExists(id)).should.equal(false);
    expect(await Media.get({ email: OWNER, id })).to.equal(undefined);
    (await Media.listHandles({ assetId: id })).should.have.length(0);
  });

  it('refuses to delete another user\'s asset', async () => {
    const res = mockRes();
    await build().uploadMedia(req(OWNER, pdf('mine'), 'mine.pdf', 'application/pdf'), res);
    track(res);

    const del = mockRes();
    await build().deleteMedia({ user: { email: OTHER }, params: { id: res.body.id } }, del);

    del.statusCode.should.equal(404);
    (await objectExists(res.body.id)).should.equal(true);
  });

  async function countAssets(email) {
    const { rows } = await pool.query(
      'SELECT count(*)::INT AS n FROM media_asset m JOIN users u ON m.userid = u.id WHERE u.email = $1',
      [email],
    );
    return Number(rows[0].n);
  }
});

/** A minimal but genuinely sniffable PDF, made unique by `tag` so each upload is a new asset. */
function pdf(tag) {
  return Buffer.from(`%PDF-1.4\n% ${tag} ${SUFFIX}\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'latin1');
}
