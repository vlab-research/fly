const farmhash = require('farmhash')
const { RefDecodeError } = require('../errors')

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

// decodeURIComponent, but a token it cannot decode is kept verbatim instead of
// throwing.
//
// This is a containment rule, not a convenience. getMetadata's whole ref parse
// sits inside one try/catch, so a SINGLE undecodable token used to discard the
// entire md — including `form` — and the conversation fell through to
// FALLBACK_FORM, a real survey whose misrouted users look like completions
// (the VIR-19 shape). One malformed targeting value must not cost a user their
// survey.
//
// The WhatsApp entry gate (event-normalizer.js WHATSAPP_ENTRY_REF) already
// rejects syntactically malformed escapes (`%zz`, a trailing `%`, a truncated
// `%2`). It cannot reject the rest: `%FF`, `%C3`, `%80` and `%E2%82` are all
// well-formed `%XX` octets that decodeURIComponent still throws on, because
// they are not valid UTF-8 — and UTF-8 well-formedness is not practically
// expressible as a regex. This is where that residual is absorbed.
//
// It also covers the Messenger path, which has the identical exposure today: a
// single bad escape in an `m.me?ref=` link currently discards the whole md.
//
// Failure stays visible rather than silent — the raw `%FF` survives into
// state.md, so the value is debuggable instead of vanishing.
function _decodeToken(s) {
  try {
    return decodeURIComponent(s)
  } catch (e) {
    return s
  }
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

// ---------------------------------------------------------------------------
// The encoded recruitment ref: `r.<base64url>`
//
// An OPTIONAL second ref format, alongside the legacy dotted
// `creative.X.form.Y` one. The legacy format is untouched and permanent —
// every existing Messenger study depends on it and none will migrate.
//
// WHY IT EXISTS. The dotted ref carries a study's stratum vocabulary in clear
// text, and on WhatsApp that text sits in the respondent's compose box where
// they can read it: being shown `gender.men.age.25_34` about yourself before a
// survey starts is a disclosure, not a transport detail. The alternative
// already in the codebase — shipping only `form.<shortcode>` and recovering the
// stratum from the ad id — does not work: Meta sends the referral webhook that
// carries an ad id for only about a third of Messenger ad entrants (measured
// 2,475 of 7,983 over 30 days to 2026-08-18), so two thirds would have no
// stratum at all. An encoded ref is carried by the quick-reply payload and the
// autofill text, which every entrant has, and discloses nothing.
//
// WHY AN ENCODING AND NOT A LOOKUP KEY. Routing happens synchronously at the
// first inbound message and cannot wait on anything; attribution is a batch
// join done afterwards and can. If the shortcode were only recoverable from a
// vlab-side mapping, a respondent could arrive before that mapping propagated
// and we would have no survey to start them on. Encoding it keeps the ref
// self-describing: fly decodes locally, with no shared state, no network call,
// and no ordering assumption between vlab creating an ad and someone tapping it.
//
// WIRE FORMAT — this is a CROSS-REPO CONTRACT. vlab encodes, fly decodes, and
// neither can change it alone. base64url (RFC 4648 §5), unpadded, of:
//
//     byte 0      version, currently 0x01
//     byte 1      shortcode length in bytes, 1..255
//     bytes 2..   the shortcode, UTF-8
//     remainder   the opaque token, >= 1 byte, surfaced as lowercase hex
//
// The token identifies a (stratum x creative) pair in vlab's own mapping. It is
// deliberately opaque: encoding the stratum id itself would be self-describing
// for vlab too, but stratum ids routinely spell out the strata
// ("gender_women_age_25_34"), which would put the disclosure straight back.
//
// base64url's alphabet is [A-Za-z0-9_-], which is already inside the WhatsApp
// entry gate's token class and contains no `.`, so an encoded ref can never be
// mistaken for the dotted grammar or split by it.
const B64URL = /^[A-Za-z0-9_-]+$/
const ENCODED_REF_VERSION = 1

// Decode an encoded ref body, or THROW RefDecodeError. Pure: no IO, no env.
//
// Every failure is a throw rather than a null return, because the caller cannot
// do anything useful with a null — see RefDecodeError's comment. Validation is
// deliberately exhaustive: Node's base64 decoder is LENIENT and silently skips
// characters it does not recognise, so `Buffer.from(x, 'base64url')` on garbage
// returns a short buffer instead of failing. The charset check and the
// round-trip check below are what turn that silence into an error.
function decodeRecruitmentRef(encoded) {
  if (typeof encoded !== 'string' || !B64URL.test(encoded)) {
    throw new RefDecodeError('encoded ref is not base64url', { encoded })
  }

  const buf = Buffer.from(encoded, 'base64url')

  // Round-trip: catches inputs whose length is impossible in base64 (a lone
  // trailing character), which the lenient decoder otherwise absorbs.
  if (buf.toString('base64url') !== encoded) {
    throw new RefDecodeError('encoded ref is not canonical base64url', { encoded })
  }

  // version + length + >=1 shortcode byte + >=1 token byte
  if (buf.length < 4) {
    throw new RefDecodeError('encoded ref is too short', { encoded })
  }

  const version = buf[0]
  if (version !== ENCODED_REF_VERSION) {
    throw new RefDecodeError('unknown encoded ref version', { encoded, version })
  }

  const len = buf[1]
  if (len < 1 || buf.length < 2 + len + 1) {
    throw new RefDecodeError('encoded ref shortcode length is out of range', {
      encoded, len, bytes: buf.length
    })
  }

  const form = buf.subarray(2, 2 + len).toString('utf8')
  const token = buf.subarray(2 + len).toString('hex')

  // A shortcode that survived the length check but decoded to nothing usable
  // means the payload is not what it claims to be. Guessing here would put a
  // respondent in an arbitrary survey.
  if (!form.trim()) {
    throw new RefDecodeError('encoded ref carries an empty shortcode', { encoded })
  }

  return { form, token }
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
      md = _group(pairs.map(_decodeToken))
    }
  } catch (e) {
    md = {}
    referral = null
  }

  // DELIBERATELY OUTSIDE the catch above. That catch exists to stop one
  // malformed metadata token costing a user their survey — it discards md and
  // lets `form` fall through. Here that reasoning inverts: the encoded ref is
  // the ONLY carrier of the shortcode, so a failure to decode means we do not
  // know the survey. Swallowing it would route the respondent into
  // FALLBACK_FORM, which is the exact silent misroute this format prevents.
  //
  // `r` and `vt` are both fly-owned on the way out: `r` is consumed into
  // `form` and `vt`, and neither is left in the metadata for downstream to see
  // half-parsed. `vt` is deleted before the decode branch stamps it for the
  // same reason `ad_id` is (below): a dotted ref like `creative.foo.vt.bar`
  // would set `md.vt = "bar"` via `_group`, and since there is no `md.r` the
  // decode branch never fires to overwrite it. That author-injected `vt` would
  // then be the join key vlab attributes the respondent by -- a silent mis-join
  // onto any row whose token is "bar". The delete is UNCONDITIONAL and before
  // the branch, so it runs for a dotted ref too (where the branch does not);
  // the branch then sets `vt` only from the decode. Same defence-in-depth
  // `ad_id` gets.
  delete md.vt
  if (md.r !== undefined) {
    const { form, token } = decodeRecruitmentRef(md.r)
    delete md.r
    md.form = form
    md.vt = token
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
  adIdFromReferral,
  decodeRecruitmentRef
}
