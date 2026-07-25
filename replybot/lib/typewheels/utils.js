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
  eventPlatform
}
