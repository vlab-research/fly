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
// Every occurrence is a producer bug.
const PLATFORM_GUESSED_TAG = 'EVENT_PLATFORM_GUESSED'

// One component of the conversation identity, normalized to "the value, or null".
// Only a non-empty string names anything: an empty string is a poisoned key, and a
// non-string is a malformed producer.
function identityComponent(v) {
  return typeof v === 'string' && v !== '' ? v : null
}

// The conversation an event belongs to: { platform, account }, or null when it
// names neither. Total -- never throws, for any input. A corrupt event is
// machine.run's problem; this only answers "which conversation is this?".
//
// It returns everything the event carried and decides nothing. The two gates
// downstream differ, which is why a partial conversation must NOT collapse to null:
//
//   | Event carries        | cache (isNamed) | replay (conv.account) |
//   |----------------------|-----------------|-----------------------|
//   | platform + account   | keyed, r/w      | account-scoped        |
//   | account, no platform | bypassed        | account-scoped        |
//   | no account           | bypassed        | unscoped, loud        |
//
// The middle row is the point. The cache key needs the full triple; the replay
// needs only the account. Returning null unless both are present reads as the
// natural simplification and is wrong -- it discards an account the event carried
// and degrades to an unscoped replay, which reads the OLDEST STATE_STORE_LIMIT
// events across every account the participant has messaged. For a heavy
// two-account participant that window never reaches this conversation, so the
// failure is silent truncation rather than imprecision.
//
// Keeping the platform on the third row costs nothing and lets the
// CONVERSATION_TUPLE_MISSING line say which component was missing.
//
// Reads only the normalized top-level `platform` / `account_id` fields, never a
// per-shape extraction or an md fallback: a fallback would paper over a producer
// that stopped sending them, which is the failure this key exists to prevent.
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

// The platform a conversation runs on, derived from the triggering event. Real
// platform events carry it as source.type; synthetic ones carry it on
// source.platform. NEVER returns 'synthetic'.
//
// The 'messenger' guess below is a temporary fallback, kept only until every
// synthetic poster sends a platform. It is wrong for WhatsApp -- those outbound
// commands get rejected by message-worker as an unsupported platform -- so it is
// logged loudly rather than taken silently. When EVENT_PLATFORM_GUESSED reads zero
// for 24h, set STRICT_EVENT_PLATFORM=1 (staging first), then delete the fallback.
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
