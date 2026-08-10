'use strict';

/*
 * The reconciler's own pure logic: the per-run bound and its ordering.
 *
 * `planReconcile` is NOT re-tested here — it is covered in media.core.test.js
 * and this suite deliberately treats its output as an input. What is new in
 * media.reconcile.js, and what is worth a table test, is the decision about
 * WHICH planned actions run this tick and which are deferred. That decision is
 * invisible in production (a deferred action just looks like a slightly stale
 * handle) and it has two failure modes that a count-only assertion would miss:
 * starving one class of action forever, and letting one oversized asset
 * deadlock the queue.
 *
 * No IO, no clock of its own — runs under `npm test`.
 */

const chai = require('chai');
chai.should();

const { prioritiseActions, parseDuration, handleKey, DEFAULT_LIMITS } = require('./media.reconcile');

const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 0, 1);

function asset(id, byteSize, createdOffsetDays = 0) {
  return [id, { byteSize, created: new Date(T0 + createdOffsetDays * DAY) }];
}

function handle(assetId, accountId, expiresInDays) {
  return [handleKey(assetId, accountId), {
    uploadedAt: new Date(T0),
    expiresAt: new Date(T0 + expiresInDays * DAY),
  }];
}

function act(type, assetId, accountId, reason, platform = 'messenger') {
  return { type, assetId, accountId, platform, reason };
}

const NO_LIMIT = { maxActions: 1000, maxBytes: Number.MAX_SAFE_INTEGER };

describe('prioritiseActions', () => {
  describe('ordering by urgency', () => {
    it('runs expiring refreshes before anything already degraded', () => {
      // An 'expiring' handle WORKS today and stops working soon — refreshing it
      // prevents a degradation. 'missing' and 'dead' are already sending by
      // URL, which is correct and invisible to the respondent, so they wait.
      const assets = new Map([asset('a1', 10), asset('a2', 10), asset('a3', 10)]);
      const handles = new Map([handle('a2', 'p2', 1), handle('a3', 'p3', 1)]);
      const actions = [
        act('create', 'a1', 'p1', 'missing'),
        act('refresh', 'a2', 'p2', 'dead'),
        act('refresh', 'a3', 'p3', 'expiring'),
      ];

      const { todo } = prioritiseActions(actions, assets, handles, NO_LIMIT);

      todo.map(a => a.reason).should.deep.equal(['expiring', 'dead', 'missing']);
    });

    it('orders expiring refreshes by expires_at, not by upload time', () => {
      // THE REGRESSION THIS PINS. A WhatsApp handle (30-day TTL) uploaded 28
      // days ago is more urgent than a Messenger one (90-day TTL) uploaded 60
      // days ago. Ordering on uploaded_at gets that exactly backwards, and the
      // symptom would be WhatsApp handles quietly dying under load while the
      // reconciler refreshed Messenger ones that had a month left.
      const assets = new Map([asset('a1', 10), asset('a2', 10)]);
      const handles = new Map([
        // Uploaded long ago, but not due for ages.
        [handleKey('a1', 'messenger-page'), { uploadedAt: new Date(T0 - 60 * DAY), expiresAt: new Date(T0 + 30 * DAY) }],
        // Uploaded recently, but dies tomorrow.
        [handleKey('a2', 'whatsapp-number'), { uploadedAt: new Date(T0 - 28 * DAY), expiresAt: new Date(T0 + 2 * DAY) }],
      ]);
      const actions = [
        act('refresh', 'a1', 'messenger-page', 'expiring'),
        act('refresh', 'a2', 'whatsapp-number', 'expiring', 'whatsapp'),
      ];

      const { todo } = prioritiseActions(actions, assets, handles, NO_LIMIT);

      todo.map(a => a.accountId).should.deep.equal(['whatsapp-number', 'messenger-page']);
    });

    it('serves the longest-waiting asset first among creates', () => {
      // Anti-starvation. Without this an asset uploaded before a busy period
      // sits behind every newer upload on every tick and never gets a handle.
      const assets = new Map([asset('new', 10, 10), asset('old', 10, 0), asset('mid', 10, 5)]);
      const actions = [
        act('create', 'new', 'p', 'missing'),
        act('create', 'old', 'p', 'missing'),
        act('create', 'mid', 'p', 'missing'),
      ];

      const { todo } = prioritiseActions(actions, assets, new Map(), NO_LIMIT);

      todo.map(a => a.assetId).should.deep.equal(['old', 'mid', 'new']);
    });
  });

  describe('the bound', () => {
    it('never defers a prune — it costs one DELETE, not an upload', () => {
      const assets = new Map([asset('a1', 10), asset('a2', 10)]);
      const actions = [
        act('prune', 'a1', 'gone-1', 'account_disconnected'),
        act('prune', 'a2', 'gone-2', 'account_disconnected'),
        act('create', 'a1', 'p', 'missing'),
        act('create', 'a2', 'p', 'missing'),
      ];

      // A cap of ONE, and both prunes still run.
      const { prunes, todo, deferred } = prioritiseActions(actions, assets, new Map(), {
        maxActions: 1,
        maxBytes: Number.MAX_SAFE_INTEGER,
      });

      prunes.should.have.length(2);
      todo.should.have.length(1);
      deferred.should.have.length(1);
    });

    it('caps the number of uploads and defers the rest', () => {
      const assets = new Map([asset('a1', 10, 0), asset('a2', 10, 1), asset('a3', 10, 2)]);
      const actions = [
        act('create', 'a1', 'p', 'missing'),
        act('create', 'a2', 'p', 'missing'),
        act('create', 'a3', 'p', 'missing'),
      ];

      const { todo, deferred } = prioritiseActions(actions, assets, new Map(), {
        maxActions: 2,
        maxBytes: Number.MAX_SAFE_INTEGER,
      });

      todo.map(a => a.assetId).should.deep.equal(['a1', 'a2']);
      deferred.map(a => a.assetId).should.deep.equal(['a3']);
    });

    it('caps bytes, because 200 actions is either a few seconds or 20 GB', () => {
      // Count is the wrong unit on its own: the cost of an action is the bytes
      // it re-uploads to Meta, and documents go to 100 MB (§11.5).
      const assets = new Map([asset('big1', 100, 0), asset('big2', 100, 1), asset('big3', 100, 2)]);
      const actions = [
        act('create', 'big1', 'p', 'missing'),
        act('create', 'big2', 'p', 'missing'),
        act('create', 'big3', 'p', 'missing'),
      ];

      const { todo, deferred } = prioritiseActions(actions, assets, new Map(), {
        maxActions: 1000,
        maxBytes: 250,
      });

      todo.map(a => a.assetId).should.deep.equal(['big1', 'big2']);
      deferred.map(a => a.assetId).should.deep.equal(['big3']);
    });

    it('always admits the first action, so one oversized asset cannot deadlock the queue', () => {
      // Skipping it instead would look reasonable and be a permanent stall: the
      // same asset is first in priority order on every subsequent tick too.
      const assets = new Map([asset('huge', 100 * 1024 * 1024, 0)]);
      const actions = [act('create', 'huge', 'p', 'missing')];

      const { todo, deferred } = prioritiseActions(actions, assets, new Map(), {
        maxActions: 10,
        maxBytes: 1024,
      });

      todo.should.have.length(1);
      deferred.should.have.length(0);
    });

    it('defers a contiguous tail rather than filtering by size', () => {
      // Stopping at the first action that does not fit — instead of skipping it
      // to squeeze smaller ones in behind — is what keeps large assets from
      // being reordered to the back forever. The small action here is NOT
      // promoted past the big one it sits behind.
      const assets = new Map([asset('a1', 100, 0), asset('a2', 900, 1), asset('a3', 1, 2)]);
      const actions = [
        act('create', 'a1', 'p', 'missing'),
        act('create', 'a2', 'p', 'missing'),
        act('create', 'a3', 'p', 'missing'),
      ];

      const { todo, deferred } = prioritiseActions(actions, assets, new Map(), {
        maxActions: 1000,
        maxBytes: 500,
      });

      todo.map(a => a.assetId).should.deep.equal(['a1']);
      deferred.map(a => a.assetId).should.deep.equal(['a2', 'a3']);
    });

    it('does nothing when there is nothing to do', () => {
      const { prunes, todo, deferred } = prioritiseActions([], new Map(), new Map(), NO_LIMIT);
      prunes.should.have.length(0);
      todo.should.have.length(0);
      deferred.should.have.length(0);
    });

    it('has defaults, so an unconfigured run is still bounded', () => {
      DEFAULT_LIMITS.maxActions.should.be.a('number').and.be.above(0);
      DEFAULT_LIMITS.maxBytes.should.be.a('number').and.be.above(0);
    });
  });
});

describe('parseDuration', () => {
  it('parses the operator-facing spellings used in devops/values', () => {
    parseDuration('72h').should.equal(72 * 3600 * 1000);
    parseDuration('30m').should.equal(30 * 60 * 1000);
    parseDuration('7d').should.equal(7 * 86400 * 1000);
    parseDuration('500ms').should.equal(500);
  });

  it('REFUSES a bare number', () => {
    // Read as milliseconds, "72" is a 72ms refresh margin — refresh-ahead
    // silently disabled, every handle left to die between ticks, nothing
    // erroring. Failing at startup is the only safe reading of an ambiguous
    // value.
    (parseDuration('72') === null).should.equal(true);
    (parseDuration('banana') === null).should.equal(true);
    (parseDuration('') === null).should.equal(true);
    (parseDuration(undefined) === null).should.equal(true);
  });
});
