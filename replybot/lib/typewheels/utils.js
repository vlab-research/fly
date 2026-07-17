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
  getMetadata
}
