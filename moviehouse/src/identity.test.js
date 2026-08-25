'use strict';

// Unit tests for moviehouse's pure conversation-identity core.
//
// moviehouse has no test framework of its own -- no mocha, no jest, no karma, no
// `test` script -- so these run on Node's built-in runner (`node --test`), which
// adds zero dependencies to a three-file static site. See moviehouse/README.md
// "Testing".

const test = require('node:test');
const assert = require('node:assert');

const {
  KNOWN_PLATFORMS,
  PARAM_USER,
  PARAM_ACCOUNT,
  PARAM_PLATFORM,
  PARAM_VIDEO,
  resolveUser,
  resolveVideoId,
  resolveConversation,
  buildSyntheticBody
} = require('./identity');

test('KNOWN_PLATFORMS is the two real transports, never "synthetic"', () => {
  assert.deepStrictEqual(KNOWN_PLATFORMS, ['messenger', 'whatsapp']);
});

// These four names are a contract shared with replybot's generic-translator.js
// (IDENTITY_PARAMS / VIDEO_PARAM) and, for the identity three, with
// linksniffer/server.go. Changing one without the others silently breaks the
// link between the page and the conversation, so pin them literally.
test('the canonical param names are the vlab_* set', () => {
  assert.strictEqual(PARAM_USER, 'vlab_user');
  assert.strictEqual(PARAM_ACCOUNT, 'vlab_account');
  assert.strictEqual(PARAM_PLATFORM, 'vlab_platform');
  assert.strictEqual(PARAM_VIDEO, 'vlab_video');
});

test.describe('resolveVideoId', () => {
  test('reads the canonical vlab_video', () => {
    assert.strictEqual(resolveVideoId({ vlab_video: '164118668' }), '164118668');
  });

  test('falls back to the legacy id for links already in flight', () => {
    assert.strictEqual(resolveVideoId({ id: '164118668' }), '164118668');
  });

  test('prefers the canonical name when both are present', () => {
    assert.strictEqual(resolveVideoId({ vlab_video: 'new', id: 'old' }), 'new');
  });

  // The collision that used to force two param schemes. A URL replybot builds
  // carries the participant under vlab_user, so it can never be mistaken for
  // the video no matter what else is on the query string.
  test('a participant id can never be mistaken for the video', () => {
    const params = { vlab_video: '164118668', vlab_user: 'psid-1' };
    assert.strictEqual(resolveVideoId(params), '164118668');
    assert.strictEqual(resolveUser(params), 'psid-1');
  });

  test('is empty when neither name is present', () => {
    assert.strictEqual(resolveVideoId({ userId: 'psid-1' }), '');
  });

  test('treats whitespace as absent', () => {
    assert.strictEqual(resolveVideoId({ vlab_video: '   ', id: '164118668' }), '164118668');
  });
});

test.describe('resolveUser', () => {
  test('reads the canonical vlab_user', () => {
    assert.strictEqual(resolveUser({ vlab_user: 'psid-1' }), 'psid-1');
  });

  test('falls back to the legacy userId', () => {
    assert.strictEqual(resolveUser({ userId: 'psid-1' }), 'psid-1');
  });

  test('prefers the canonical name when both are present', () => {
    assert.strictEqual(resolveUser({ vlab_user: 'new', userId: 'old' }), 'new');
  });

  // 411 of 570 stored fields omit userId, and since commit 126cbc7e that
  // hard-fails the page. A `moviehouse` field cannot reproduce it: replybot
  // always writes vlab_user.
  test('is empty when neither name is present', () => {
    assert.strictEqual(resolveUser({ id: '164118668' }), '');
  });

  test('treats whitespace as absent', () => {
    assert.strictEqual(resolveUser({ vlab_user: ' ', userId: 'psid-1' }), 'psid-1');
  });
});

test.describe('resolveConversation - canonical params', () => {
  test('reads a url replybot built', () => {
    const c = resolveConversation({
      vlab_video: '164118668',
      vlab_user: 'psid-1',
      vlab_account: 'acct-1',
      vlab_platform: 'whatsapp'
    });

    assert.strictEqual(c.account_id, 'acct-1');
    assert.strictEqual(c.platform, 'whatsapp');
    assert.deepStrictEqual(c.missing, []);
  });

  test('prefers vlab_account over both legacy account names', () => {
    const c = resolveConversation({
      vlab_account: 'canonical',
      account_id: 'legacy',
      pageId: 'older'
    });

    assert.strictEqual(c.account_id, 'canonical');
  });

  test('prefers vlab_platform over the legacy platform', () => {
    const c = resolveConversation({
      vlab_account: 'a',
      vlab_platform: 'whatsapp',
      platform: 'messenger'
    });

    assert.strictEqual(c.platform, 'whatsapp');
  });

  // The 2026-08-13 incident: a hardcoded Messenger pageId on a WhatsApp
  // conversation. A url replybot built carries the real account under
  // vlab_account, so a stray legacy pageId cannot win.
  test('a stale hardcoded pageId cannot override the real account', () => {
    const c = resolveConversation({
      vlab_account: '1265380589988964',
      vlab_platform: 'whatsapp',
      pageId: '101435865704727'
    });

    assert.strictEqual(c.account_id, '1265380589988964');
    assert.strictEqual(c.platform, 'whatsapp');
  });

  test('an invalid canonical platform is still rejected, not passed through', () => {
    const c = resolveConversation({ vlab_account: 'a', vlab_platform: 'Messenger' });

    assert.strictEqual(c.platform, '');
    assert.strictEqual(c.platformAssumed, false);
    assert.strictEqual(c.invalidPlatform, 'Messenger');
    assert.deepStrictEqual(c.missing, ['platform']);
  });
});

test.describe('resolveConversation', () => {
  test('reads a complete tracked identity', () => {
    const c = resolveConversation({
      id: '164118668',
      userId: 'psid-1',
      account_id: 'acct-1',
      pageId: 'acct-1',
      platform: 'whatsapp'
    });

    assert.strictEqual(c.account_id, 'acct-1');
    assert.strictEqual(c.platform, 'whatsapp');
    assert.strictEqual(c.invalidPlatform, '');
    assert.deepStrictEqual(c.missing, []);
  });

  test('prefers account_id over the legacy pageId', () => {
    const c = resolveConversation({ account_id: 'new', pageId: 'legacy' });
    assert.strictEqual(c.account_id, 'new');
  });

  test('falls back to the legacy pageId when account_id is absent', () => {
    const c = resolveConversation({ pageId: 'legacy' });
    assert.strictEqual(c.account_id, 'legacy');
  });

  test('treats empty and whitespace-only params as absent', () => {
    const c = resolveConversation({ account_id: '', pageId: '   ', platform: '  ' });
    assert.strictEqual(c.account_id, '');
    assert.strictEqual(c.platform, 'messenger');
    assert.strictEqual(c.platformAssumed, true);
    assert.deepStrictEqual(c.missing, ['account_id']);
  });

  // THE decision. A moviehouse event is a heartbeat every 30 seconds, and a
  // wrong platform builds outbound commands for the wrong transport, so an
  // absent platform is reported and omitted -- never assumed to be messenger.
  // Contrast linksniffer's [LINKSNIFFER_PLATFORM_ASSUMED].
  // CHANGED 2026-08-22: an absent platform is now assumed 'messenger', matching
  // linksniffer, so that moviehouse URLs already delivered to participants keep
  // resolving. Messenger is the only live transport.
  test('assumes messenger when the platform param is absent', () => {
    const c = resolveConversation({ vlab_account: 'acct-1' });
    assert.strictEqual(c.platform, 'messenger');
    assert.strictEqual(c.platformAssumed, true);
    assert.deepStrictEqual(c.missing, []);
  });

  test('accepts messenger and whatsapp', () => {
    assert.strictEqual(resolveConversation({ platform: 'messenger' }).platform, 'messenger');
    assert.strictEqual(resolveConversation({ platform: 'whatsapp' }).platform, 'whatsapp');
  });

  // A platform becomes a component of the conversation identity downstream, so a
  // typo would be a poisoned cache key addressing a conversation that does not
  // exist. Reject rather than forward -- and reject rather than fall back.
  test('rejects an unknown platform and reports the rejected value', () => {
    const c = resolveConversation({ pageId: 'acct-1', platform: 'sms' });
    assert.strictEqual(c.platform, '');
    assert.strictEqual(c.invalidPlatform, 'sms');
    assert.deepStrictEqual(c.missing, ['platform']);
  });

  test('rejects a casing mismatch rather than normalizing it', () => {
    assert.strictEqual(resolveConversation({ platform: 'Messenger' }).platform, '');
    assert.strictEqual(resolveConversation({ platform: 'Messenger' }).invalidPlatform, 'Messenger');
  });

  test('rejects "synthetic", which is a source and never a platform', () => {
    const c = resolveConversation({ platform: 'synthetic' });
    assert.strictEqual(c.platform, '');
    assert.strictEqual(c.invalidPlatform, 'synthetic');
  });

  test('is total: no params, null, undefined', () => {
    [undefined, null, {}].forEach(input => {
      const c = resolveConversation(input);
      assert.strictEqual(c.account_id, '');
      // Platform is assumed even here; the ACCOUNT is what cannot be invented.
      assert.strictEqual(c.platform, 'messenger');
      assert.strictEqual(c.platformAssumed, true);
      assert.deepStrictEqual(c.missing, ['account_id']);
    });
  });

  test('does not mistake the Vimeo video id for the account or the user', () => {
    const c = resolveConversation({ id: '164118668' });
    assert.strictEqual(c.account_id, '');
    // The video id must not leak into the account. Platform is assumed, as ever.
    assert.strictEqual(c.platform, 'messenger');
  });
});

test.describe('buildSyntheticBody', () => {
  const complete = { account_id: 'acct-1', platform: 'whatsapp', invalidPlatform: '', missing: [] };

  test('posts the full triple, with `page` retained as a deprecated alias', () => {
    const body = buildSyntheticBody({
      user: 'psid-1',
      conversation: complete,
      videoId: '164118668',
      eventType: 'play',
      data: { duration: 12 }
    });

    assert.deepStrictEqual(body, {
      user: 'psid-1',
      account_id: 'acct-1',
      page: 'acct-1',
      platform: 'whatsapp',
      data: { duration: 12 },
      event: {
        type: 'external',
        value: { type: 'moviehouse:play', id: '164118668' }
      }
    });
  });

  test('omits platform entirely when it could not be resolved', () => {
    const body = buildSyntheticBody({
      user: 'psid-1',
      conversation: { account_id: 'acct-1', platform: '', invalidPlatform: '', missing: ['platform'] },
      videoId: '164118668',
      eventType: 'heartbeat',
      data: { currentTime: 45.23 }
    });

    assert.ok(!('platform' in body), 'platform must be absent, not empty, and never guessed');
    assert.strictEqual(body.account_id, 'acct-1');
    assert.strictEqual(body.page, 'acct-1');
  });

  test('omits account_id and page together when no account could be resolved', () => {
    const body = buildSyntheticBody({
      user: 'psid-1',
      conversation: { account_id: '', platform: 'messenger', invalidPlatform: '', missing: ['account_id'] },
      videoId: '1',
      eventType: 'ended',
      data: {}
    });

    assert.ok(!('account_id' in body));
    assert.ok(!('page' in body), 'the deprecated alias tracks account_id, never an empty string');
    assert.strictEqual(body.platform, 'messenger');
  });

  test('carries the heartbeat shape from HEARTBEAT_IMPLEMENTATION_PLAN unchanged', () => {
    const body = buildSyntheticBody({
      user: 'psid-1',
      conversation: complete,
      videoId: '164118668',
      eventType: 'heartbeat',
      data: { currentTime: 45.23 }
    });

    assert.strictEqual(body.event.value.type, 'moviehouse:heartbeat');
    assert.deepStrictEqual(body.data, { currentTime: 45.23 });
  });

  test('prefixes every event type with moviehouse:', () => {
    ['play', 'pause', 'ended', 'seeked', 'volumechange', 'playbackratechange', 'error']
      .forEach(eventType => {
        const body = buildSyntheticBody({
          user: 'u', conversation: complete, videoId: '1', eventType, data: {}
        });
        assert.strictEqual(body.event.value.type, 'moviehouse:' + eventType);
      });
  });

  test('is pure: does not mutate the conversation or the data it is handed', () => {
    const conversation = { account_id: 'a', platform: 'messenger', invalidPlatform: '', missing: [] };
    const data = { currentTime: 1 };
    const frozen = JSON.stringify({ conversation, data });

    buildSyntheticBody({ user: 'u', conversation, videoId: '1', eventType: 'play', data });

    assert.strictEqual(JSON.stringify({ conversation, data }), frozen);
  });

  test('serializes to JSON without an undefined key leaking through', () => {
    const body = buildSyntheticBody({
      user: 'psid-1',
      conversation: { account_id: '', platform: '', invalidPlatform: '', missing: ['account_id', 'platform'] },
      videoId: '1',
      eventType: 'play',
      data: {}
    });

    const parsed = JSON.parse(JSON.stringify(body));
    assert.deepStrictEqual(Object.keys(parsed), ['user', 'data', 'event']);
  });
});
