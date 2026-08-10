'use strict';

/*
 * The reconciler SHELL against a REAL MinIO and a REAL CockroachDB.
 *
 *   docker compose up -d          (from dashboard-server/)
 *   npm run test:media:reconcile
 *
 * WHAT THIS DOES NOT TEST. `planReconcile` is pure, clock-injected and already
 * covered in media.core.test.js; `prioritiseActions` is pure and covered in
 * media.reconcile.test.js. Re-asserting either here would be slow and would
 * prove nothing new. This suite tests the properties that ONLY EXIST IN THE
 * SHELL, and every one of them is a property of real IO:
 *
 *   - idempotence, which rests on ON CONFLICT (asset_id, account_id) being a
 *     real primary key rather than query discipline
 *   - the restamp of uploaded_at, without which a refreshed handle looks due
 *     again on the very next tick, forever
 *   - failure isolation, which is the whole reason fan-out at upload is allowed
 *     to be best-effort (§2, §13)
 *   - the per-run bound and the fact that what it deferred is NAMED in the log,
 *     because a silent cap reads as "covered everything" when it did not (§10)
 *
 * NOTHING HERE TALKS TO META. platformUpload is stubbed, exactly as in
 * media.integration.test.js. The bytes are real, the rows are real, the failure
 * modes are injected.
 *
 * RUN IN ITS OWN MOCHA PROCESS (see package.json). The query layer is a
 * singleton over one pg Pool, and media.integration.test.js closes that pool in
 * its `after` hook, so sharing a process would give this suite a dead
 * connection rather than a test failure.
 */

const chai = require('chai');
chai.should();
const { expect } = chai;

const { Media, Credential, pool } = require('../../queries');
const { STORAGE } = require('../../config');
const { makeStorage } = require('./storage');
const { reconcile } = require('./media.reconcile');
const { DEFAULT_RECONCILE_POLICY } = require('./media.core');

const storage = makeStorage(STORAGE);

const DAY = 24 * 3600 * 1000;
const SUFFIX = Date.now();
const OWNER = `recon-owner-${SUFFIX}@vlab.test`;
const EMAILS = [OWNER];

const PAGE_A = `recon-page-a-${SUFFIX}`;
const PAGE_B = `recon-page-b-${SUFFIX}`;
const WABA = `recon-wa-${SUFFIX}`;

// The clock every assertion is written against. Injected, so "89 days old" is a
// row we insert rather than 89 days of waiting.
const NOW = new Date('2026-06-01T12:00:00.000Z');

/*
 * The reconciler's outer loop is `every user who owns an asset`, which in a
 * shared local database means every user any other run ever left behind. Wrap
 * that ONE query to scope the pass to this suite's owners, and every summary
 * count below is exact. The rest of the query layer is the real thing.
 */
const scopedMedia = Object.assign({}, Media, {
  listAssetOwners: async () => (await Media.listAssetOwners()).filter(o => EMAILS.includes(o.email)),
});

/** Collects log lines so the deferral message can be asserted, not assumed. */
function makeLog() {
  const lines = [];
  const log = (level, message, fields) => lines.push({ level, message, fields });
  log.lines = lines;
  log.find = re => lines.find(l => re.test(l.message));
  return log;
}

let uploadCalls = [];

/**
 * A stub platform upload. `fail(accountId, assetId)` injects a per-account or
 * per-asset failure; the returned handle facts mirror media.platform-upload's
 * real shape, including the TTL read from DEFAULT_RECONCILE_POLICY.
 */
function stubUpload(fail = () => false) {
  return async ({ platform, accountId, file, now }) => {
    uploadCalls.push({ platform, accountId, bytes: file.buffer.length });
    if (fail(accountId)) return { ok: false, error: 'Invalid OAuth access token' };
    const at = now instanceof Date ? now : new Date();
    return {
      ok: true,
      platform,
      platformMediaId: `fresh-${accountId}-${at.getTime()}`,
      uploadedAt: at,
      expiresAt: new Date(at.getTime() + DEFAULT_RECONCILE_POLICY.ttlMs[platform]),
    };
  };
}

function run({ platformUpload, limits, log, policy, now } = {}) {
  return reconcile({
    mediaQuery: scopedMedia,
    credentialQuery: Credential,
    storage,
    platformUpload: platformUpload || stubUpload(),
    policy: policy || DEFAULT_RECONCILE_POLICY,
    limits,
    log: log || (() => {}),
    now: now || NOW,
  });
}

/** A distinct, genuinely sniffable PDF per tag, so every asset has real bytes. */
function bytesFor(tag) {
  return Buffer.from(`%PDF-1.4\n% ${tag} ${SUFFIX}\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n`, 'latin1');
}

const seeded = [];

/**
 * Puts real bytes in MinIO and a real row in media_asset, in that order — the
 * same ordering the upload path uses, and for the same reason (§5): an object
 * with no row is garbage, a row with no object is a broken image.
 *
 * `storeBytes: false` seeds the row WITHOUT the object, to exercise the
 * unreadable-asset path.
 */
async function seedAsset(tag, { storeBytes = true, buffer } = {}) {
  const bytes = buffer || bytesFor(tag);
  const { rows } = await pool.query('SELECT gen_random_uuid() AS id');
  const id = rows[0].id;
  if (storeBytes) {
    await storage.put({ assetId: id, buffer: bytes, contentType: 'application/pdf', filename: `${tag}.pdf` });
  }
  await Media.create({
    id,
    email: OWNER,
    contentHash: `hash-${tag}-${SUFFIX}`,
    mediaType: 'file',
    mimeType: 'application/pdf',
    byteSize: bytes.length,
    filename: `${tag}.pdf`,
  });
  seeded.push({ id, storeBytes });
  return id;
}

async function addAccount(entity, key, token) {
  await pool.query(
    `INSERT INTO credentials(userid, entity, key, details)
     VALUES ((SELECT id FROM users WHERE email = $1), $2, $3, $4)
     ON CONFLICT (entity, key) DO NOTHING`,
    [OWNER, entity, key, JSON.stringify({ access_token: token })],
  );
}

async function dropAccount(key) {
  await pool.query('DELETE FROM credentials WHERE key = $1', [key]);
}

async function handlesFor(assetId) {
  return Media.listHandles({ assetId });
}

describe('media reconciler (real MinIO + CockroachDB)', function () {
  this.timeout(60000);

  before(async () => {
    if (storage.backend !== 's3') {
      throw new Error('the reconciler tests need STORAGE_BACKEND=s3 — is docker compose up?');
    }
    if (!(await storage.client.bucketExists(storage.bucket))) {
      throw new Error(`bucket "${storage.bucket}" is missing — run: docker compose up -d`);
    }

    await pool.query('INSERT INTO users(email) VALUES ($1) ON CONFLICT (email) DO NOTHING', [OWNER]);
    await addAccount('facebook_page', PAGE_A, 'tok-a');
    await addAccount('whatsapp_business', WABA, 'tok-c');
    // A non-messaging credential, which must never be a reconcile target.
    await addAccount('typeform', `recon-tf-${SUFFIX}`, 'tok-tf');
  });

  after(async () => {
    for (const { id } of seeded) {
      try { await storage.delete({ assetId: id }); } catch (e) { /* already gone */ }
    }
    await pool.query('DELETE FROM credentials WHERE userid = (SELECT id FROM users WHERE email = $1)', [OWNER]);
    await pool.query('DELETE FROM users WHERE email = $1', [OWNER]);
    await pool.end();
  });

  beforeEach(() => { uploadCalls = []; });

  /*
   * EVERY TEST STARTS FROM AN EMPTY LIBRARY. The reconciler's outer loop is
   * "every asset this owner has", so an asset left behind by an earlier test is
   * not inert scenery — it is extra desired state, and every summary count in
   * this file would drift by however many tests ran before it. Handles cascade
   * with the asset row; the extra page goes too, so each test declares its own
   * account set.
   */
  afterEach(async () => {
    for (const { id } of seeded) {
      try { await storage.delete({ assetId: id }); } catch (e) { /* already gone */ }
    }
    seeded.length = 0;
    await pool.query('DELETE FROM media_asset WHERE userid = (SELECT id FROM users WHERE email = $1)', [OWNER]);
    await pool.query('DELETE FROM credentials WHERE key = $1', [PAGE_B]);
  });

  // ------------------------------------------------------------------
  // Idempotence — the property that makes it safe to run on a tick
  // ------------------------------------------------------------------
  it('creates every missing handle, then does NOTHING on a second identical run', async () => {
    const assetId = await seedAsset('idem');

    const first = await run();
    first.created.should.equal(2); // PAGE_A + WABA. Not the typeform credential.
    first.refreshed.should.equal(0);
    first.failed.should.equal(0);
    (await handlesFor(assetId)).map(h => h.account_id).sort()
      .should.deep.equal([PAGE_A, WABA].sort());

    uploadCalls = [];
    const second = await run();

    // The whole point. Same clock, same state: nothing planned, nothing
    // uploaded, no second row per (asset, account).
    second.planned.should.equal(0);
    second.created.should.equal(0);
    second.refreshed.should.equal(0);
    second.pruned.should.equal(0);
    second.failed.should.equal(0);
    uploadCalls.should.have.length(0);
    (await handlesFor(assetId)).should.have.length(2);
  });

  // ------------------------------------------------------------------
  // The three cases one mechanism covers (§2)
  // ------------------------------------------------------------------
  it('backfills an account connected AFTER the asset was uploaded', async () => {
    // No credential-creation hook anywhere: the handle simply appears on the
    // next tick, because desired state is computed, not subscribed to.
    const assetId = await seedAsset('backfill');
    await run();
    (await handlesFor(assetId)).should.have.length(2);

    await addAccount('facebook_page', PAGE_B, 'tok-b');

    uploadCalls = [];
    const summary = await run();

    summary.created.should.equal(1);
    summary.refreshed.should.equal(0);
    uploadCalls.map(c => c.accountId).should.deep.equal([PAGE_B]);
    (await handlesFor(assetId)).map(h => h.account_id).sort()
      .should.deep.equal([PAGE_A, PAGE_B, WABA].sort());
  });

  it('refreshes a near-expiry handle AND restamps uploaded_at', async () => {
    const assetId = await seedAsset('expiring');

    // A Messenger handle two days from death, under a 3-day refresh margin.
    const staleUpload = new Date(NOW.getTime() - 88 * DAY);
    await Media.upsertHandle({
      assetId,
      accountId: PAGE_A,
      platform: 'messenger',
      platformMediaId: 'about-to-die',
      uploadedAt: staleUpload,
      expiresAt: new Date(NOW.getTime() + 2 * DAY),
    });
    // ...and a WhatsApp handle with a month left, which must NOT be touched.
    await Media.upsertHandle({
      assetId,
      accountId: WABA,
      platform: 'whatsapp',
      platformMediaId: 'still-good',
      uploadedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 29 * DAY),
    });

    const summary = await run();

    summary.refreshed.should.equal(1);
    summary.created.should.equal(0);
    uploadCalls.map(c => c.accountId).should.deep.equal([PAGE_A]);

    const handles = new Map((await handlesFor(assetId)).map(h => [h.account_id, h]));

    // THE RESTAMP IS THE LOAD-BEARING ASSERTION. Age-based expiry measures from
    // uploaded_at (§2), so leaving the original timestamp would make this
    // handle look due again on the very next tick — a re-upload every hour,
    // forever, with the row never looking any fresher.
    handles.get(PAGE_A).platform_media_id.should.not.equal('about-to-die');
    handles.get(PAGE_A).uploaded_at.getTime().should.equal(NOW.getTime());
    handles.get(PAGE_A).expires_at.getTime()
      .should.equal(NOW.getTime() + DEFAULT_RECONCILE_POLICY.ttlMs.messenger);

    // Untouched, byte for byte.
    handles.get(WABA).platform_media_id.should.equal('still-good');
    handles.get(WABA).uploaded_at.getTime().should.equal(NOW.getTime());

    // And it is now idempotent again: refreshing did not leave it due.
    uploadCalls = [];
    (await run()).planned.should.equal(0);
    uploadCalls.should.have.length(0);
  });

  it('prunes a handle for an account the owner no longer has', async () => {
    const assetId = await seedAsset('prune');
    await addAccount('facebook_page', PAGE_B, 'tok-b');
    await run();
    (await handlesFor(assetId)).should.have.length(3);

    await dropAccount(PAGE_B);
    const summary = await run();

    summary.pruned.should.equal(1);
    (await handlesFor(assetId)).map(h => h.account_id).sort()
      .should.deep.equal([PAGE_A, WABA].sort());
  });

  it('leaves a handle alone when the credential came back under it', async () => {
    // The reconciler's one genuine read-then-write race: it decided to prune
    // from a snapshot, and by the time the DELETE runs the credential has been
    // reconnected and fan-out has written a FRESH handle. Matching on the
    // uploaded_at we read makes that DELETE a no-op instead of throwing away a
    // good handle.
    const assetId = await seedAsset('prune-race');
    await Media.upsertHandle({
      assetId,
      accountId: PAGE_B, // no credential -> planReconcile will plan a prune
      platform: 'messenger',
      platformMediaId: 'stale',
      uploadedAt: new Date(NOW.getTime() - DAY),
      expiresAt: new Date(NOW.getTime() + 89 * DAY),
    });

    const racingMedia = Object.assign({}, scopedMedia, {
      listHandlesForOwner: async args => {
        const rows = await Media.listHandlesForOwner(args);
        // ...and now the world changes underneath the snapshot.
        await Media.upsertHandle({
          assetId,
          accountId: PAGE_B,
          platform: 'messenger',
          platformMediaId: 'reconnected',
          uploadedAt: NOW,
          expiresAt: new Date(NOW.getTime() + 90 * DAY),
        });
        return rows;
      },
    });

    const summary = await reconcile({
      mediaQuery: racingMedia,
      credentialQuery: Credential,
      storage,
      platformUpload: stubUpload(),
      policy: DEFAULT_RECONCILE_POLICY,
      log: () => {},
      now: NOW,
    });

    summary.pruned.should.equal(0);
    summary.failed.should.equal(0);
    const handles = new Map((await handlesFor(assetId)).map(h => [h.account_id, h]));
    handles.get(PAGE_B).platform_media_id.should.equal('reconnected');
  });

  // ------------------------------------------------------------------
  // Failure isolation — §13's "the handle layer can fail entirely"
  // ------------------------------------------------------------------
  it('does not abort the run when a platform upload fails — every other action still completes', async () => {
    const failing = await seedAsset('fails');
    const healthy = await seedAsset('healthy');

    const summary = await run({ platformUpload: stubUpload(id => id === PAGE_A) });

    // One failure per asset on PAGE_A; WABA succeeded on both.
    summary.failed.should.equal(2);
    summary.created.should.equal(2);

    for (const assetId of [failing, healthy]) {
      (await handlesFor(assetId)).map(h => h.account_id).should.deep.equal([WABA]);
    }

    // And it is self-healing: the next tick retries what failed, with no
    // error-driven invalidation anywhere in the loop (§8.4).
    const retry = await run();
    retry.created.should.equal(2);
    retry.failed.should.equal(0);
    for (const assetId of [failing, healthy]) {
      (await handlesFor(assetId)).should.have.length(2);
    }
  });

  it('does not abort the run when an asset\'s bytes cannot be fetched', async () => {
    // A row whose object is missing (MinIO briefly down, or an upload that died
    // between put and insert). Its actions fail; the run continues.
    const missing = await seedAsset('no-object', { storeBytes: false });
    const present = await seedAsset('has-object');

    const log = makeLog();
    const summary = await run({ log });

    summary.failed.should.equal(2); // both of the unreadable asset's accounts
    summary.created.should.equal(2); // both of the readable one's
    (await handlesFor(missing)).should.have.length(0);
    (await handlesFor(present)).should.have.length(2);
    expect(log.find(/could not fetch bytes/)).to.not.equal(undefined);
  });

  it('fetches an asset\'s bytes ONCE and reuses them across its accounts', async () => {
    // For the 29-account user (§11.1b) this is 1 storage read instead of 29.
    const assetId = await seedAsset('shared-bytes');
    await addAccount('facebook_page', PAGE_B, 'tok-b');

    let fetches = 0;
    const countingStorage = Object.assign({}, storage, {
      get: async args => { fetches += 1; return storage.get(args); },
    });

    const summary = await reconcile({
      mediaQuery: scopedMedia,
      credentialQuery: Credential,
      storage: countingStorage,
      platformUpload: stubUpload(),
      policy: DEFAULT_RECONCILE_POLICY,
      log: () => {},
      now: NOW,
    });

    summary.created.should.equal(3);
    fetches.should.equal(1);
    uploadCalls.should.have.length(3);
    // The same bytes reached every account.
    new Set(uploadCalls.map(c => c.bytes)).size.should.equal(1);
    (await handlesFor(assetId)).should.have.length(3);
  });

  // ------------------------------------------------------------------
  // The bound — and saying out loud what it deferred
  // ------------------------------------------------------------------
  it('honours the per-run cap and NAMES what it deferred', async () => {
    const a1 = await seedAsset('cap-1');
    const a2 = await seedAsset('cap-2');

    const log = makeLog();
    // Four actions are planned (2 assets x 2 accounts); allow three.
    const summary = await run({ limits: { maxActions: 3 }, log });

    summary.planned.should.equal(4);
    summary.created.should.equal(3);
    summary.deferred.should.equal(1);
    uploadCalls.should.have.length(3);

    const total = (await handlesFor(a1)).length + (await handlesFor(a2)).length;
    total.should.equal(3);

    // §10: a silent cap reads as "covered everything" when it did not. The
    // count alone is not enough — the deferred action has to be identifiable
    // from the log, or an operator cannot tell a healthy backlog from a stuck
    // one.
    const line = log.find(/deferred 1 action/);
    expect(line).to.not.equal(undefined);
    line.level.should.equal('warn');
    line.fields.maxActions.should.equal(3);
    line.fields.deferredBytes.should.be.above(0);
    line.fields.examples.should.have.length(1);
    line.fields.examples[0].should.match(/^create:missing [0-9a-f-]+\//);

    // The deferral is a backlog, not a loss: the next unbounded tick clears it.
    const next = await run();
    next.created.should.equal(1);
    next.deferred.should.equal(0);
    ((await handlesFor(a1)).length + (await handlesFor(a2)).length).should.equal(4);
  });

  it('honours the byte budget too, and reports the bytes it deferred', async () => {
    // Count is the wrong unit on its own — 200 actions is a few seconds of
    // thumbnails or 20 GB of documents.
    const big = Buffer.concat([bytesFor('big'), Buffer.alloc(200 * 1024)]);
    await seedAsset('byte-cap-a', { buffer: big });
    await seedAsset('byte-cap-b', { buffer: big });

    const log = makeLog();
    const summary = await run({ limits: { maxActions: 1000, maxBytes: 250 * 1024 }, log });

    summary.planned.should.equal(4);
    // The first action alone is always admitted; the rest do not fit.
    summary.created.should.equal(1);
    summary.deferred.should.equal(3);
    summary.deferredBytes.should.be.above(250 * 1024);
    expect(log.find(/deferred 3 action/)).to.not.equal(undefined);
  });
});
