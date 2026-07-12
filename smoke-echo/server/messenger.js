const { getPageConfig } = require('./config')

const BASE_URL = process.env.FACEBOOK_GRAPH_URL || 'https://graph.facebook.com/v22.0'

const log = (msg, data) => {
  if (data !== undefined) {
    console.log(`[smoke-echo][fb] ${msg} ${JSON.stringify(data)}`)
  } else {
    console.log(`[smoke-echo][fb] ${msg}`)
  }
}

// Every call is scoped to a specific page: `/me/...` resolves to whichever page
// the bearer token belongs to, so we pick the token for `pageId` from the
// per-page config. Passing the wrong page's token is exactly what made the
// shared smoke-echo unable to act on the staging page — it only held the prod
// token, so staging calls failed with "No matching user found".
async function post(pageId, endpoint, body) {
  const cfg = getPageConfig(pageId)
  if (!cfg || !cfg.token) {
    throw new Error(`No page access token configured for page ${pageId}`)
  }
  const url = `${BASE_URL}${endpoint}`
  const headers = {
    Authorization: `Bearer ${cfg.token}`,
    'Content-Type': 'application/json'
  }
  log(`POST ${endpoint} (page ${pageId}) ->`, body)
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  const json = await res.json()
  log(`POST ${endpoint} (page ${pageId}) <- (status ${res.status})`, json)
  if (json.error) {
    throw new Error(`Facebook API error on ${endpoint}: ${json.error.message}`)
  }
  return json
}

function sendMessage(pageId, userId, text) {
  return post(pageId, '/me/messages', { recipient: { id: userId }, message: { text } })
}

function passThreadControl(pageId, userId, targetAppId, metadata) {
  return post(pageId, '/me/pass_thread_control', {
    recipient: { id: userId },
    target_app_id: targetAppId,
    metadata: JSON.stringify(metadata || {})
  })
}

module.exports = { sendMessage, passThreadControl }
