const { sendMessage, passThreadControl } = require('./messenger')
const { getPageConfig, configuredPageIds } = require('./config')

const ECHO_APP_ID = process.env.FACEBOOK_APP_ID
// Legacy global fallback for the passback target when a page has no configured
// flyAppId (e.g. a pure single-page deploy). Per-page config is preferred.
const FLY_APP_ID = process.env.FLY_APP_ID

const INTRO_MESSAGE = "🔄 Thread control handed off to the Smoke Echo app! Send me any message and I'll echo it back, then hand you back to the survey."
const ECHO_PREFIX = '📣 You said: '
const RETURN_SUFFIX = ' — handing control back to the survey now!'

// Users currently mid-handoff with this app, waiting for their first reply.
// Keyed by `pageId:userId` — smoke-echo now serves multiple pages (prod +
// staging share this one app), and the same Messenger user id could appear on
// more than one page, so the page must be part of the key.
// In-memory only: this service is stateless across restarts by design — a
// smoke test that gets interrupted just needs to be re-run from the top.
const awaitingReply = new Set()
const waitKey = (pageId, userId) => `${pageId}:${userId}`

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
  configuredPages: configuredPageIds(),
  graphUrl: process.env.FACEBOOK_GRAPH_URL || 'https://graph.facebook.com/v22.0 (default)',
  hasLegacyPageToken: !!process.env.PAGE_ACCESS_TOKEN,
  hasVerifyToken: !!process.env.FACEBOOK_VERIFY_TOKEN,
})
if (!ECHO_APP_ID) log('WARNING: FACEBOOK_APP_ID is unset — cannot recognize handovers meant for this app')
if (!configuredPageIds().length && !process.env.PAGE_ACCESS_TOKEN) {
  log('WARNING: no pages configured — set SMOKE_ECHO_PAGES (or legacy PAGE_ACCESS_TOKEN); cannot send or hand back control')
}

// The Fly (Primary Receiver) app id to hand control back to for a given page.
const flyAppIdFor = pageId => {
  const cfg = getPageConfig(pageId)
  return (cfg && cfg.flyAppId) || FLY_APP_ID
}

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

async function onHandover(pageId, handover) {
  const { sender, pass_thread_control: passControl } = handover
  if (!passControl || !sender) {
    log('onHandover: ignoring — missing pass_thread_control or sender', { hasPassControl: !!passControl, hasSender: !!sender })
    return
  }

  const newOwner = passControl.new_owner_app_id
  log('onHandover: received pass_thread_control', {
    pageId,
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
  awaitingReply.add(waitKey(pageId, userId))
  log('onHandover: WE OWN THE THREAD — greeting user and awaiting their reply', { pageId, userId, awaitingReplyCount: awaitingReply.size })
  await sendMessage(pageId, userId, INTRO_MESSAGE)
  log('onHandover: intro message sent', { pageId, userId })
}

async function onMessage(pageId, messaging) {
  const { sender, message } = messaging
  if (!sender || !message) {
    log('onMessage: ignoring — missing sender or message', { hasSender: !!sender, hasMessage: !!message })
    return
  }
  if (message.is_echo) {
    log('onMessage: ignoring — echo of our own message', { pageId, userId: sender.id })
    return
  }

  const userId = sender.id
  if (!awaitingReply.has(waitKey(pageId, userId))) {
    log('onMessage: ignoring — not awaiting a reply from this user', { pageId, userId, awaitingReplyKeys: [...awaitingReply] })
    return
  }

  awaitingReply.delete(waitKey(pageId, userId))
  const flyAppId = flyAppIdFor(pageId)
  const text = message.text || '(a non-text message)'
  log('onMessage: got the awaited reply — echoing and handing control back to Fly', { pageId, userId, text, flyAppId })
  await sendMessage(pageId, userId, `${ECHO_PREFIX}"${text}"${RETURN_SUFFIX}`)
  log('onMessage: echo message sent', { pageId, userId })
  await passThreadControl(pageId, userId, flyAppId, { smoke_echo: 'ok', echo_text: text })
  log('onMessage: passThreadControl back to Fly complete', { pageId, userId, flyAppId, metadata: { smoke_echo: 'ok', echo_text: text } })
}

// Manual recovery endpoint. If a smoke run is interrupted while smoke-echo owns
// the thread, the page gets stuck ("another app is controlling this thread
// now") because Fly can no longer send. Since smoke-echo IS the current owner,
// it can hand control back on demand:
//
//   curl -X POST https://fly-smoke-echo.vlab.digital/admin/passback \
//        -H 'content-type: application/json' \
//        -d '{"userId":"1989430067808669","pageId":"1855355231229529"}'
//
// (a GET with ?userId=...&pageId=... works too). `pageId` selects which page's
// token to use and defaults the target to that page's Fly app; pass
// `targetAppId` to override.
const passback = async ctx => {
  const body = (ctx.request && ctx.request.body) || {}
  const userId = body.userId || ctx.query.userId
  const pageId = body.pageId || ctx.query.pageId
  const targetAppId = body.targetAppId || ctx.query.targetAppId || flyAppIdFor(pageId)

  if (!userId) {
    log('admin/passback: rejected — missing userId')
    ctx.status = 400
    ctx.body = { ok: false, error: 'userId is required (JSON body or ?userId= query)' }
    return
  }
  if (!pageId) {
    log('admin/passback: rejected — missing pageId')
    ctx.status = 400
    ctx.body = { ok: false, error: 'pageId is required (JSON body or ?pageId= query)' }
    return
  }
  if (!getPageConfig(pageId)) {
    log('admin/passback: rejected — page not configured', { pageId, configuredPages: configuredPageIds() })
    ctx.status = 400
    ctx.body = { ok: false, error: `page ${pageId} is not configured (no token)`, configuredPages: configuredPageIds() }
    return
  }
  if (!targetAppId) {
    log('admin/passback: rejected — no targetAppId and no flyAppId configured for page', { pageId })
    ctx.status = 400
    ctx.body = { ok: false, error: 'targetAppId is required (no flyAppId configured for this page)' }
    return
  }

  log('admin/passback: manually handing control back', { pageId, userId, targetAppId })
  try {
    const result = await passThreadControl(pageId, userId, targetAppId, { smoke_echo: 'manual_passback' })
    awaitingReply.delete(waitKey(pageId, userId))
    log('admin/passback: success — control handed back', { pageId, userId, targetAppId, result })
    ctx.status = 200
    ctx.body = { ok: true, userId, pageId, targetAppId, facebook: result }
  } catch (error) {
    log('admin/passback: FAILED', { pageId, userId, targetAppId, error: error.message })
    ctx.status = 502
    ctx.body = { ok: false, userId, pageId, targetAppId, error: error.message }
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
      pageId: entry.id,
      messagingCount: entry.messaging ? entry.messaging.length : 0,
      handoverCount: entry.messaging_handovers ? entry.messaging_handovers.length : 0,
    })
    for (const event of events) {
      // The page id is the webhook entry's id; fall back to the event recipient
      // (the page is the recipient of a user's message / handover).
      const pageId = entry.id || (event.recipient && event.recipient.id)
      try {
        if (event.pass_thread_control) {
          await onHandover(pageId, event)
        } else if (event.message) {
          await onMessage(pageId, event)
        } else {
          log('skipping event — neither pass_thread_control nor message', { pageId, keys: Object.keys(event) })
        }
      } catch (error) {
        console.error('[smoke-echo][ERR] webhook event: ', error)
      }
    }
  }

  ctx.status = 200
}

module.exports = { verifyToken, handleWebhook, passback }
