'use strict';

// moviehouse's conversation-identity core -- the pure half of the seventh
// synthetic producer.
//
// Every event on `chat-events` must carry the conversation triple
// `(platform, account_id, user_id)`. moviehouse POSTs to hermes' `/synthetic`
// endpoint on every video event AND a heartbeat every 30 seconds, so it is a
// producer under that contract like any other. See
// `../documentation/event-envelope.md` and `../moviehouse/README.md`.
//
// Nothing here touches the DOM, the network or a global. Both functions are pure
// and total, which is what makes them unit-testable under `node --test` with no
// browser and no mocking. The imperative shell is `script.js`.
//
// Loaded two ways from one file: as a browser global (`MoviehouseIdentity`) via a
// `<script>` tag in index.html, and as a CommonJS module by identity.test.js.
(function (root, factory) {
  var api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.MoviehouseIdentity = api;
  }
}(typeof self !== 'undefined' ? self : this, function () {

  // The transports a conversation can run on. `platform` is NEVER 'synthetic' --
  // that is a `source`, which answers a different question. Casing is not
  // normalized: a mis-cased value is a researcher authoring mistake, and treating
  // it as valid would let 'Messenger' become a distinct cache key downstream.
  var KNOWN_PLATFORMS = ['messenger', 'whatsapp'];

  // What an absent platform resolves to. Messenger is the only live transport,
  // and legacy URLs carry no platform at all.
  var ASSUMED_PLATFORM = 'messenger';

  // THE canonical query params. replybot builds every `moviehouse` field's URL
  // from config and writes exactly these
  // (`replybot/lib/generic-translator.js` IDENTITY_PARAMS / VIDEO_PARAM), and
  // `linksniffer/server.go` reads the same three identity names. One set, both
  // ends owned by replybot.
  //
  // The `vlab_` prefix is what makes the old collision impossible rather than
  // merely avoided: `id` used to mean "the Vimeo video" here and "the
  // participant" on linksniffer, and reconciling those needed a per-service
  // param scheme that had to be got right in two repositories at once. The video
  // now has its own unambiguous name.
  var PARAM_USER = 'vlab_user';
  var PARAM_ACCOUNT = 'vlab_account';
  var PARAM_PLATFORM = 'vlab_platform';
  var PARAM_VIDEO = 'vlab_video';

  function trimmed(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  // Pure. First non-empty trimmed value among the named params.
  //
  // Every resolver below is the canonical name followed by the legacy names.
  // The legacy names are load-bearing, not courtesy: moviehouse ships from
  // Netlify and replybot ships to the cluster, so the deploy order is not
  // guaranteed in either direction, AND Messenger's 24-hour window means URLs
  // built before the change are clicked after it. A moviehouse that stopped
  // reading `id` would render "we couldn't find that video" for every link
  // already delivered.
  function pick(params, names) {
    var p = params || {};
    for (var i = 0; i < names.length; i++) {
      var v = trimmed(p[names[i]]);
      if (v !== '') return v;
    }
    return '';
  }

  // Pure. The participant. Canonical `vlab_user`, legacy `userId`.
  function resolveUser(params) {
    return pick(params, [PARAM_USER, 'userId']);
  }

  // Pure. The Vimeo video. Canonical `vlab_video`, legacy `id`.
  function resolveVideoId(params) {
    return pick(params, [PARAM_VIDEO, 'id']);
  }

  // Pure. Resolve the conversation identity out of moviehouse's own query params.
  //
  // Two paths produce those params and only one is trustworthy:
  //   - a `moviehouse` field -- replybot builds the whole URL and writes
  //     `vlab_user`, `vlab_account` and `vlab_platform` from the live
  //     conversation. Always correct, and there is nowhere for a researcher to
  //     put a wrong account.
  //   - a legacy hand-authored `webview` pointing here -- may carry a hardcoded
  //     `pageId` and carry no `platform` at all. On 2026-08-13 exactly that sent
  //     a WhatsApp participant's play event to a Messenger page, producing a
  //     phantom conversation still BLOCKED in production.
  //
  // AN ABSENT PLATFORM IS ASSUMED 'messenger', matching linksniffer. Changed
  // 2026-08-22, reversing the earlier decision recorded here and in
  // `../planning/moviehouse-conversation-identity.md`.
  //
  // The earlier reasoning was that an absent platform degrades safely (hermes
  // stamps the account, replybot falls back to an account-scoped replay, the
  // conversation still advances) while a WRONG one addresses a conversation that
  // does not exist -- and that at one heartbeat every 30 seconds a wrong platform
  // is a continuous stream of mis-addressed events, not a one-shot risk. The
  // 2026-08-13 incident, where a legacy hand-authored `webview` carrying a
  // hardcoded `pageId` sent a WhatsApp participant's play event to a Messenger
  // page and left a phantom conversation BLOCKED in production, is what that
  // caution was built on.
  //
  // It is assumed anyway because MESSENGER IS THE ONLY LIVE TRANSPORT. WhatsApp
  // carries a handful of test users, so the assumption is correct for
  // effectively all traffic, and backwards compatibility for URLs already in
  // participants' inboxes is worth more than the residual.
  //
  // THE RESIDUAL IS REAL AND IS THE THING TO REVISIT: the moment WhatsApp
  // carries production traffic, a legacy moviehouse URL clicked by a WhatsApp
  // participant reproduces 2026-08-13 exactly. Before that happens, either the
  // legacy URLs must be gone or the platform must come from a lookup rather than
  // an assumption -- `credentials.entity` maps an account to its transport
  // (`facebook_page` -> messenger, `whatsapp_business` -> whatsapp) and is what
  // formcentral already resolves surveys by.
  //
  // An INVALID platform is still never assumed: it is reported and omitted, so a
  // value we do not recognise stays findable instead of being coerced.
  //
  // Returns { account_id, platform, invalidPlatform, missing } where each string
  // is '' when unresolved and `missing` names the unresolved components.
  function resolveConversation(params) {
    // Canonical first, then the two legacy account names in the order they
    // appeared: `account_id` was the normalized name, `pageId` the original.
    var accountId = pick(params, [PARAM_ACCOUNT, 'account_id', 'pageId']);

    var supplied = pick(params, [PARAM_PLATFORM, 'platform']);
    var known = supplied !== '' && KNOWN_PLATFORMS.indexOf(supplied) !== -1;
    var invalidPlatform = (supplied !== '' && !known) ? supplied : '';

    // ABSENT -> assume messenger, matching linksniffer's
    // `[LINKSNIFFER_PLATFORM_ASSUMED]`. Backwards compatibility for URLs already
    // delivered: every moviehouse link built before `vlab_platform` existed
    // carries no platform, Messenger's 24h window means they are clicked after
    // the deploy, and messenger is the only live transport.
    //
    // INVALID -> still NOT assumed. A value we do not recognise is a bug, not a
    // legacy URL, and it is reported so it is findable rather than coerced.
    var platform = known ? supplied : (supplied === '' ? ASSUMED_PLATFORM : '');
    var platformAssumed = (supplied === '');

    var missing = [];
    if (accountId === '') missing.push('account_id');
    if (platform === '') missing.push('platform');

    return {
      account_id: accountId,
      platform: platform,
      platformAssumed: platformAssumed,
      invalidPlatform: invalidPlatform,
      missing: missing
    };
  }

  // Pure. Build the `/synthetic` POST body for one moviehouse event.
  //
  // `page` is retained alongside `account_id` as a deliberate deprecated alias:
  // the historical `messages` backfill reads the account out of archived
  // `messages.content` under the per-shape name, so keeping it means old and new
  // rows share one extraction path. See event-envelope.md "Nothing was removed".
  //
  // A component that did not resolve is omitted rather than sent empty. Hermes
  // stamps a field only when it derives to a non-empty string, so an empty string
  // would be a poisoned key rather than a countable gap.
  //
  // spec = { user, conversation, videoId, eventType, data }
  function buildSyntheticBody(spec) {
    var conversation = spec.conversation || {};
    var body = { user: spec.user };

    if (conversation.account_id) {
      body.account_id = conversation.account_id;
      body.page = conversation.account_id;
    }

    if (conversation.platform) {
      body.platform = conversation.platform;
    }

    body.data = spec.data;
    body.event = {
      type: 'external',
      value: { type: 'moviehouse:' + spec.eventType, id: spec.videoId }
    };

    return body;
  }

  return {
    KNOWN_PLATFORMS: KNOWN_PLATFORMS,
    PARAM_USER: PARAM_USER,
    PARAM_ACCOUNT: PARAM_ACCOUNT,
    PARAM_PLATFORM: PARAM_PLATFORM,
    PARAM_VIDEO: PARAM_VIDEO,
    resolveUser: resolveUser,
    resolveVideoId: resolveVideoId,
    resolveConversation: resolveConversation,
    buildSyntheticBody: buildSyntheticBody
  };
}));
