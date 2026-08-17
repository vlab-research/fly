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

// The platform a conversation runs on, derived from the triggering event.
// Real platform events carry it as source.type. Synthetic events have
// source.type 'synthetic' but may carry the real platform as a hint on
// source.platform (surfaced by the event-normalizer from the payload's
// optional top-level "platform" field, which dean sends). NEVER returns
// 'synthetic' — falls back to 'messenger', which is exact for all
// conversations predating WhatsApp support.
function eventPlatform(event) {
  const source = (event && event.source) || {}
  if (MESSAGING_PLATFORMS.includes(source.type)) return source.type
  if (MESSAGING_PLATFORMS.includes(source.platform)) return source.platform
  return 'messenger'
}

// ---------------------------------------------------------------------------
// Ad identity (md.ad_id)
//
// vlab keys ad attribution on an opaque ad id and owns the
// (network, ad_id) -> stratum mapping itself. Fly's entire job is to capture
// that one identifier off the referral and carry it in the conversation's
// metadata. It does NOT parse it, interpret it, or join on it — the dotted
// `creative.X.form.Y` ref path above is untouched and stays exactly as it is.
//
// There is no `ad_network` key: md.platform already holds 'messenger' /
// 'whatsapp' and vlab derives the network from that.
// ---------------------------------------------------------------------------

// Which referral field marks the surface the user arrived from, and which
// values of it mean "an ad".
//
// Empirically it is `source_type: 'ad'` — singular key, singular value. That is
// what a live production CTWA arrival carried (2026-08-16), and what the CTWA
// fixtures in event-normalizer.test.js and machine.test.js already use. Our own
// prose docs additionally claimed `source: 'ads'`; no production payload,
// hermes type, or fixture anywhere has ever carried that spelling, and it looks
// like a transcription of *Messenger's* referral `source` field (`'ADS'`,
// `'SHORTLINK'`). Both keys are read anyway so that a replay of the historical
// event log cannot silently miss an ad arrival — reading a key that never
// appears costs nothing, while missing one loses attribution permanently.
//
// Keep the accepted key/value sets here, in one place: this is the gate that
// decides whether an id is trusted enough to be called an ad id.
const AD_SOURCE_KEYS = ['source_type', 'source']
const AD_SOURCE_VALUES = new Set(['ad', 'ads'])

function _isAdSourced(referral) {
  return AD_SOURCE_KEYS.some(k => {
    const v = referral[k]
    return typeof v === 'string' && AD_SOURCE_VALUES.has(v.trim().toLowerCase())
  })
}

// Meta sends ids as strings, but normalize defensively so a numeric id does not
// land in the metadata as a number and compare unequal to vlab's string keys.
// Empty / whitespace-only is the same as absent.
function _id(v) {
  if (v === null || v === undefined) return undefined
  const s = String(v).trim()
  return s === '' ? undefined : s
}

// Resolve the opaque ad identifier a conversation arrived from, or undefined.
// Pure — unit-testable in isolation, no IO, no env.
//
// The two platforms name it differently, and only one of them needs a gate:
//
//   Messenger — `referral.ad_id`. Already an ad id by definition; Messenger
//     populates it only on ad-sourced referrals. Older events simply lack it.
//
//   WhatsApp — `referral.source_id`, ONLY when the referral says the source is
//     an ad. This gate is the critical correctness detail. `source_id` is not
//     an ad-specific field: on an organic reshare of a page post the source is
//     a *post* and `source_id` is then a post id. Capturing it unconditionally
//     would write post ids into the ad_id field, where they can never match
//     vlab's mapping and would pile up forever in the "unmapped" bucket that
//     exists to catch real bugs. A post-sourced arrival is an organic entrant
//     and must fall through with no ad_id at all.
function adIdFromReferral(referral, platform) {
  if (!referral || typeof referral !== 'object') return undefined

  if (platform === 'whatsapp') {
    return _isAdSourced(referral) ? _id(referral.source_id) : undefined
  }

  return _id(referral.ad_id)
}

function getMetadata(event) {
  let md = {}
  let referral = null

  try {
    if (event.event_type === 'conversation_started') {
      referral = event.payload.referral
    }

    if (referral && referral.ref) {
      const pairs = referral.ref.split('.')
      md = _group(pairs.map(decodeURIComponent))
    }
  } catch (e) {
    md = {}
    referral = null
  }

  md.form = md.form || process.env.FALLBACK_FORM
  md.startTime = event.timestamp
  md.pageid = event.source.account_id
  // Persisted with the state at conversation start so synthetic re-entry
  // events (dean timeouts / follow-ups) can recover the conversation's real
  // platform (see transition.js). Holds 'messenger' or 'whatsapp' — never
  // 'synthetic'.
  md.platform = eventPlatform(event)

  // Fly-owned synthetic key, assigned after _group exactly like pageid /
  // platform / startTime above, so fly's value wins any collision with a ref
  // token. The `delete` is that rule applied to the *absent* case too: fly owns
  // this key outright, so a ref token literally named `ad_id` must never inject
  // a value here even when fly resolves nothing. This column feeds vlab's
  // (network, ad_id) join and has to be trustworthy — a study author who could
  // write into it would pollute the very "unmapped" bucket the gate protects.
  delete md.ad_id
  const adId = adIdFromReferral(referral, md.platform)
  if (adId !== undefined) md.ad_id = adId

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
  adIdFromReferral
}
