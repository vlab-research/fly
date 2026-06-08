const BASE_URL = process.env.FACEBOOK_GRAPH_URL || 'https://graph.facebook.com/v22.0'
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN

const log = (msg, data) => {
  if (data !== undefined) {
    console.log(`[smoke-echo][fb] ${msg} ${JSON.stringify(data)}`)
  } else {
    console.log(`[smoke-echo][fb] ${msg}`)
  }
}

async function post(endpoint, body) {
  const url = `${BASE_URL}${endpoint}`
  const headers = {
    Authorization: `Bearer ${PAGE_ACCESS_TOKEN}`,
    'Content-Type': 'application/json'
  }
  log(`POST ${endpoint} ->`, body)
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  const json = await res.json()
  log(`POST ${endpoint} <- (status ${res.status})`, json)
  if (json.error) {
    throw new Error(`Facebook API error on ${endpoint}: ${json.error.message}`)
  }
  return json
}

function sendMessage(userId, text) {
  return post('/me/messages', { recipient: { id: userId }, message: { text } })
}

function passThreadControl(userId, targetAppId, metadata) {
  return post('/me/pass_thread_control', {
    recipient: { id: userId },
    target_app_id: targetAppId,
    metadata: JSON.stringify(metadata || {})
  })
}

module.exports = { sendMessage, passThreadControl }
