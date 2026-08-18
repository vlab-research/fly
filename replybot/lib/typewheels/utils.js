const farmhash = require('farmhash')

function recursiveJSONParser(obj) {
  function traverse(obj) {
    if (typeof obj !== 'object' || obj === null) return obj
    for (let key in obj) {
      obj[key] = recursiveJSONParser(obj[key])
    }
    return obj
  }

  try {
    const o = JSON.parse(obj)
    if (o === +obj) {
      return traverse(obj)
    }
    return traverse(o)
  }
  catch (e) {
    return traverse(obj)
  }
}

function parseLogJSON(log) {
  return recursiveJSONParser(log)
}

function _group(pairs) {
  const arr = pairs.reduce((a, b, i) => {
    if (i % 2) {
      a[a.length - 1].push(b)
      return a
    }
    return [...a, [b]]
  }, [])

  const d = {}
  for (let [k, v] of arr) {
    d[k] = v
  }
  return d
}

function hash(s) {
  return farmhash.fingerprint32(s + '')
}


function randomSeed(event, md) {
  const userId = event.user_id
  const { form } = md

  if (!form || !userId) return null

  const s = form + userId
  return { seed: hash(s) }
}

const MESSAGING_PLATFORMS = ['messenger', 'whatsapp']

// Greppable tag for "this event did not tell us its platform, so we guessed".
// Post-§7.3 every event carries `platform`, so every occurrence of this tag is
// a producer bug. See the sequencing note below.
const PLATFORM_GUESSED_TAG = 'EVENT_PLATFORM_GUESSED'

// Pure, total. A single component of the conversation identity, normalized to
// "the value, or null". Only a NON-EMPTY STRING names anything: an empty string
// is a poisoned key rather than a name -- which is why hermes stamps a field
// "only when it derives to a non-empty string" (documentation/event-envelope.md,
// §4.2) -- and a non-string is a malformed producer, not an identity.
function identityComponent(v) {
  return typeof v === 'string' && v !== '' ? v : null
}

// The conversation an event belongs to: { platform, account }, each component
// either a non-empty string or null, or null when the event names neither.
// Total: never throws, for any input. Used only for conversation keying, so it
// must NOT adopt parseEvent's error contract -- a corrupt event is machine.run's
// problem, and this function's only job is to answer "what does this event tell
// us about which conversation it belongs to?".
//
// THE THREE-CASE CONTRACT (§7.1; pinned by statestore.test.js B10-9a/b/c and by
// the tests below). The function returns everything the event carried and
// decides nothing; the two gates downstream are what differ:
//
//   | Event carries        | returns                   | cache (isNamed) | replay (conv.account) |
//   |----------------------|---------------------------|-----------------|-----------------------|
//   | platform + account   | { platform, account }     | keyed, r/w      | account-scoped        |
//   | account, no platform | { platform: null, account}| bypassed        | account-scoped        |
//   | no account           | { platform, account: null}| bypassed        | unscoped, loud        |
//   |                      |   or null when neither    |                 |                       |
//
// The middle row is the whole point, and it is why this function must NOT
// collapse a partial conversation to null. The CACHE KEY needs the full triple
// -- `state:{platform}:{account}:{user}` cannot be built without a platform --
// but the REPLAY needs only the account: `db.get({ userid, account }, limit)`
// takes no platform. A gate of "return null unless both are present" reads as
// the natural simplification and is wrong: it discards an account the event
// actually carried and degrades that event to an UNSCOPED replay, which reads
// `ORDER BY timestamp ASC LIMIT STATE_STORE_LIMIT` -- the OLDEST events, across
// every account this participant has ever messaged. For a heavy two-account
// participant the window can be consumed entirely by the other conversation and
// never reach this one's recent events, so the failure is silent truncation,
// not mere imprecision. That alternative was considered and rejected; §7.1's
// "Clarified as implemented" note and B10-9b pin it.
//
// Keeping the platform on the third row is deliberate too: it costs nothing
// (both gates already fail on a null account) and it makes the
// CONVERSATION_TUPLE_MISSING line say WHICH component was missing.
//
// Reads the normalized top-level `platform` / `account_id` fields the envelope
// carries (documentation/event-envelope.md, §4.2 -- note chat-events has TWO
// LIVE PRODUCERS, hermes and message-worker, each stamping its own events) and
// nothing else: no per-shape extraction (recipient.id / phone_number_id / page), no md
// fallback. A fallback would silently paper over a producer that stopped
// sending the fields, which is exactly the failure the conversation key exists
// to make impossible.
//
// NOTE ON LOCATION: §7.1 specifies event-normalizer.js as the home for this
// function. It lives here because that file is owned by another work stream;
// moving it is a cut-and-paste plus a re-export.
function conversationFromRawEvent(raw) {
  let parsed = raw

  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      return null
    }
  }

  if (!parsed || typeof parsed !== 'object') return null

  const platform = identityComponent(parsed.platform)
  const account = identityComponent(parsed.account_id)

  // The event named no component of the conversation at all. null and
  // { platform: null, account: null } are equivalent to both gates downstream;
  // null is returned because "we learned nothing" is worth being able to say in
  // one check at a call site.
  if (!platform && !account) return null

  return { platform, account }
}

// The platform a conversation runs on, derived from the triggering event.
// Real platform events carry it as source.type. Synthetic events have
// source.type 'synthetic' and carry the real platform on source.platform
// (surfaced by the event-normalizer from the payload's top-level "platform"
// field, which every poster now sends -- §7.3.1). NEVER returns 'synthetic'.
//
// SEQUENCING (§7.1 deliverable 2). The old comment justified the silent
// 'messenger' default as "exact for all conversations predating WhatsApp
// support". That was true when written and is false now: a WhatsApp
// conversation whose event lost its platform would be guessed as Messenger and
// its outbound commands rejected by message-worker as an unsupported platform.
// This must become a hard failure, but not before the last synthetic posters
// land -- linksniffer is being fixed in parallel and will send
// platform=messenger explicitly. Until then the guess is kept and made LOUD,
// which is what turns "silent wrong answer" into a measurable one: grep for
// EVENT_PLATFORM_GUESSED, and when it reads zero for 24h, set
// STRICT_EVENT_PLATFORM=1 (staging first) and then delete the fallback.
function eventPlatform(event) {
  const source = (event && event.source) || {}
  if (MESSAGING_PLATFORMS.includes(source.type)) return source.type
  if (MESSAGING_PLATFORMS.includes(source.platform)) return source.platform

  const detail = `source.type=${source.type} source.platform=${source.platform}`

  if (process.env.STRICT_EVENT_PLATFORM === '1') {
    throw new Error(`${PLATFORM_GUESSED_TAG} no platform on event: ${detail}`)
  }

  console.warn(PLATFORM_GUESSED_TAG, 'defaulting to messenger:', detail)
  return 'messenger'
}

function getMetadata(event) {
  let md = {}

  try {
    let r
    if (event.event_type === 'conversation_started') {
      r = event.payload.referral
    }

    if (r && r.ref) {
      const pairs = r.ref.split('.')
      md = _group(pairs.map(decodeURIComponent))
    }
  } catch (e) {
    md = {}
  }

  md.form = md.form || process.env.FALLBACK_FORM
  md.startTime = event.timestamp
  md.pageid = event.source.account_id
  // Persisted with the state at conversation start so synthetic re-entry
  // events (dean timeouts / follow-ups) can recover the conversation's real
  // platform (see transition.js). Holds 'messenger' or 'whatsapp' — never
  // 'synthetic'.
  md.platform = eventPlatform(event)

  return {
    ...md,
    ...randomSeed(event, md)
  }
}

function getForm(event) {
  const { form } = getMetadata(event)
  return form
}

module.exports = {
  recursiveJSONParser,
  parseLogJSON,
  getForm,
  hash,
  _group,
  getMetadata,
  eventPlatform,
  conversationFromRawEvent,
  identityComponent,
  PLATFORM_GUESSED_TAG
}
