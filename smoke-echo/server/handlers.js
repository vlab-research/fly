const { sendMessage, passThreadControl } = require('./messenger')

const ECHO_APP_ID = process.env.FACEBOOK_APP_ID
const FLY_APP_ID = process.env.FLY_APP_ID

const INTRO_MESSAGE = "🔄 Thread control handed off to the Smoke Echo app! Send me any message and I'll echo it back, then hand you back to the survey."
const ECHO_PREFIX = '📣 You said: '
const RETURN_SUFFIX = ' — handing control back to the survey now!'

// Users currently mid-handoff with this app, waiting for their first reply.
// In-memory only: this service is stateless across restarts by design — a
// smoke test that gets interrupted just needs to be re-run from the top.
const awaitingReply = new Set()

// Tiny structured logger. Everything in this service is a smoke-test aid, so
// verbosity is a feature: we want to *see* every webhook, every branch taken,
// and every Facebook call, because the whole point is observing the handover.
const log = (msg, data) => {
  if (data !== undefined) {
    console.log(`[smoke-echo] ${msg} ${JSON.stringify(data)}`)
  } else {
    console.log(`[smoke-echo] ${msg}`)
  }
}

log('startup config', {
  ECHO_APP_ID,
  FLY_APP_ID,
  graphUrl: process.env.FACEBOOK_GRAPH_URL || 'https://graph.facebook.com/v22.0 (default)',
  hasPageToken: !!process.env.PAGE_ACCESS_TOKEN,
  hasVerifyToken: !!process.env.FACEBOOK_VERIFY_TOKEN,
})
if (!ECHO_APP_ID) log('WARNING: FACEBOOK_APP_ID is unset — cannot recognize handovers meant for this app')
if (!FLY_APP_ID) log('WARNING: FLY_APP_ID is unset — cannot hand control back to Fly')

const verifyToken = ctx => {
  const ok = ctx.query['hub.verify_token'] === process.env.FACEBOOK_VERIFY_TOKEN
  log('GET /webhook verify handshake', { matched: ok, challenge: ctx.query['hub.challenge'] })
  if (ok) {
    ctx.body = ctx.query['hub.challenge']
    ctx.status = 200
  } else {
    ctx.status = 401
  }
}

async function onHandover(handover) {
  const { sender, pass_thread_control: passControl } = handover
  if (!passControl || !sender) {
    log('onHandover: ignoring — missing pass_thread_control or sender', { hasPassControl: !!passControl, hasSender: !!sender })
    return
  }

  const newOwner = passControl.new_owner_app_id
  log('onHandover: received pass_thread_control', {
    userId: sender.id,
    new_owner_app_id: newOwner,
    new_owner_app_id_type: typeof newOwner,
    previous_owner_app_id: passControl.previous_owner_app_id,
    our_app_id: ECHO_APP_ID,
    metadata: passControl.metadata,
  })

  // Only react when control was passed to us specifically.
  //
  // Compare as STRINGS: real Messenger webhooks deliver `new_owner_app_id` as a
  // JSON *number* (e.g. 976665718578167), while ECHO_APP_ID is a string env
  // var. A strict `!==` between a number and a string is always true, which
  // silently dropped every real handover — the echo app never greeted, so the
  // smoke test's round trip never even started, even though the string-vs-string
  // unit tests passed. This is the same coercion bug that bit Fly's own
  // HANDOVER_EVENT handler; keep both sides type-agnostic.
  if (String(newOwner) !== String(ECHO_APP_ID)) {
    log('onHandover: ignoring — control was passed to a different app', { new_owner_app_id: newOwner, our_app_id: ECHO_APP_ID })
    return
  }

  const userId = sender.id
  awaitingReply.add(userId)
  log('onHandover: WE OWN THE THREAD — greeting user and awaiting their reply', { userId, awaitingReplyCount: awaitingReply.size })
  await sendMessage(userId, INTRO_MESSAGE)
  log('onHandover: intro message sent', { userId })
}

async function onMessage(messaging) {
  const { sender, message } = messaging
  if (!sender || !message) {
    log('onMessage: ignoring — missing sender or message', { hasSender: !!sender, hasMessage: !!message })
    return
  }
  if (message.is_echo) {
    log('onMessage: ignoring — echo of our own message', { userId: sender.id })
    return
  }

  const userId = sender.id
  if (!awaitingReply.has(userId)) {
    log('onMessage: ignoring — not awaiting a reply from this user', { userId, awaitingReplyUsers: [...awaitingReply] })
    return
  }

  awaitingReply.delete(userId)
  const text = message.text || '(a non-text message)'
  log('onMessage: got the awaited reply — echoing and handing control back to Fly', { userId, text, flyAppId: FLY_APP_ID })
  await sendMessage(userId, `${ECHO_PREFIX}"${text}"${RETURN_SUFFIX}`)
  log('onMessage: echo message sent', { userId })
  await passThreadControl(userId, FLY_APP_ID, { smoke_echo: 'ok', echo_text: text })
  log('onMessage: passThreadControl back to Fly complete', { userId, flyAppId: FLY_APP_ID, metadata: { smoke_echo: 'ok', echo_text: text } })
}

// Manual recovery endpoint. If a smoke run is interrupted while smoke-echo owns
// the thread, the page gets stuck ("another app is controlling this thread
// now") because Fly can no longer send. Since smoke-echo IS the current owner,
// it can hand control back on demand:
//
//   curl -X POST https://fly-smoke-echo.vlab.digital/admin/passback \
//        -H 'content-type: application/json' -d '{"userId":"1989430067808669"}'
//
// (a GET with ?userId=... works too, for convenience from a browser). Defaults
// the target to FLY_APP_ID; pass targetAppId to override.
const passback = async ctx => {
  const body = (ctx.request && ctx.request.body) || {}
  const userId = body.userId || ctx.query.userId
  const targetAppId = body.targetAppId || ctx.query.targetAppId || FLY_APP_ID

  if (!userId) {
    log('admin/passback: rejected — missing userId')
    ctx.status = 400
    ctx.body = { ok: false, error: 'userId is required (JSON body or ?userId= query)' }
    return
  }
  if (!targetAppId) {
    log('admin/passback: rejected — no targetAppId and FLY_APP_ID is unset')
    ctx.status = 400
    ctx.body = { ok: false, error: 'targetAppId is required (FLY_APP_ID is unset)' }
    return
  }

  log('admin/passback: manually handing control back', { userId, targetAppId })
  try {
    const result = await passThreadControl(userId, targetAppId, { smoke_echo: 'manual_passback' })
    awaitingReply.delete(userId)
    log('admin/passback: success — control handed back', { userId, targetAppId, result })
    ctx.status = 200
    ctx.body = { ok: true, userId, targetAppId, facebook: result }
  } catch (error) {
    log('admin/passback: FAILED', { userId, targetAppId, error: error.message })
    ctx.status = 502
    ctx.body = { ok: false, userId, targetAppId, error: error.message }
  }
}

const handleWebhook = async ctx => {
  const entries = (ctx.request.body && ctx.request.body.entry) || []
  log('POST /webhook received', { entryCount: entries.length, body: ctx.request.body })

  for (const [i, entry] of entries.entries()) {
    // Route by the event's CONTENT, not by which array it arrived in. Facebook
    // delivers handover-protocol events (pass_thread_control) inside
    // `entry.messaging[]` — the same array as normal messages — even though you
    // subscribe to them via the `messaging_handovers` webhook field. Some
    // payloads also populate `entry.messaging_handovers[]`, so we read both and
    // dispatch on the keys present. Keying off the array name (as we did
    // before) silently dropped every real handover: it landed in messaging[],
    // got sent to onMessage, and was discarded for having no `.message`.
    const events = [...(entry.messaging || []), ...(entry.messaging_handovers || [])]
    log(`processing entry ${i}`, {
      messagingCount: entry.messaging ? entry.messaging.length : 0,
      handoverCount: entry.messaging_handovers ? entry.messaging_handovers.length : 0,
    })
    for (const event of events) {
      try {
        if (event.pass_thread_control) {
          await onHandover(event)
        } else if (event.message) {
          await onMessage(event)
        } else {
          log('skipping event — neither pass_thread_control nor message', { keys: Object.keys(event) })
        }
      } catch (error) {
        console.error('[smoke-echo][ERR] webhook event: ', error)
      }
    }
  }

  ctx.status = 200
}

module.exports = { verifyToken, handleWebhook, passback }
