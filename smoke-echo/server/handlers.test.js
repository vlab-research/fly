const chai = require('chai')
const sinon = require('sinon')
const sinonChai = require('sinon-chai')
const proxyquire = require('proxyquire')
chai.use(sinonChai)
chai.should()

process.env.FACEBOOK_VERIFY_TOKEN = 'test-verify-token'
process.env.FACEBOOK_APP_ID = 'echo-app-id'
process.env.FLY_APP_ID = 'fly-app-id'
// Per-page config: both test pages hand back to 'fly-app-id'. Tokens are
// irrelevant here (messenger is stubbed), but a page must be configured for its
// flyAppId (handback target) to resolve.
process.env.SMOKE_ECHO_PAGES = JSON.stringify({
  'test-page': { token: 'test-token', flyAppId: 'fly-app-id' },
  '1855355231229529': { token: 'test-token', flyAppId: 'fly-app-id' },
})

const PAGE = 'test-page'

describe('smoke-echo handlers', () => {
  let sendMessage
  let passThreadControl
  let handlers

  beforeEach(() => {
    sendMessage = sinon.stub().resolves({})
    passThreadControl = sinon.stub().resolves({})
    handlers = proxyquire('./handlers', {
      './messenger': { sendMessage, passThreadControl }
    })
  })

  afterEach(() => sinon.restore())

  describe('verifyToken', () => {
    it('echoes the challenge when the verify token matches', () => {
      const ctx = { query: { 'hub.verify_token': 'test-verify-token', 'hub.challenge': 'abc123' }, status: 0 }
      handlers.verifyToken(ctx)
      ctx.status.should.equal(200)
      ctx.body.should.equal('abc123')
    })

    it('rejects when the verify token does not match', () => {
      const ctx = { query: { 'hub.verify_token': 'wrong' }, status: 0 }
      handlers.verifyToken(ctx)
      ctx.status.should.equal(401)
    })
  })

  describe('handleWebhook', () => {
    const handover = (newOwnerAppId, userId = 'user123') => ({
      request: {
        body: {
          entry: [{
            id: PAGE,
            messaging_handovers: [{
              sender: { id: userId },
              recipient: { id: PAGE },
              pass_thread_control: { new_owner_app_id: newOwnerAppId, previous_owner_app_id: 'fly-app-id', metadata: '{}' }
            }]
          }]
        }
      },
      status: 0
    })

    const message = (text, userId = 'user123') => ({
      request: {
        body: { entry: [{ id: PAGE, messaging: [{ sender: { id: userId }, recipient: { id: PAGE }, message: { text } }] }] }
      },
      status: 0
    })

    it('greets the user and starts waiting when control is passed to us', async () => {
      await handlers.handleWebhook(handover('echo-app-id'))

      sendMessage.should.have.been.calledOnce
      const [pageId, userId, text] = sendMessage.firstCall.args
      pageId.should.equal(PAGE)
      userId.should.equal('user123')
      text.should.match(/handed off/i)
    })

    it('ignores handovers meant for a different app', async () => {
      await handlers.handleWebhook(handover('someone-elses-app-id'))
      sendMessage.should.not.have.been.called
    })

    // Real Facebook payload: pass_thread_control is delivered inside the
    // `messaging` array (NOT `messaging_handovers`), alongside normal messages,
    // and the page id is the webhook entry's `id`.
    const handoverInMessaging = (newOwnerAppId, userId = 'user123') => ({
      request: {
        body: {
          object: 'page',
          entry: [{
            id: '1855355231229529',
            messaging: [{
              sender: { id: userId },
              recipient: { id: '1855355231229529' },
              pass_thread_control: { new_owner_app_id: newOwnerAppId, previous_owner_app_id: 'fly-app-id', metadata: '{"check":"smoke_test"}' }
            }]
          }]
        }
      },
      status: 0
    })

    it('greets when pass_thread_control arrives in the messaging[] array (real FB shape)', async () => {
      // Regression: Facebook puts handover events in entry.messaging[], not
      // entry.messaging_handovers[]. Routing by array name sent them to
      // onMessage, which dropped them for having no `.message` — the handover
      // was received but silently ignored, so the round trip never started.
      await handlers.handleWebhook(handoverInMessaging('echo-app-id'))
      sendMessage.should.have.been.calledOnce
      // args: [pageId, userId, text]
      sendMessage.firstCall.args[0].should.equal('1855355231229529')
      sendMessage.firstCall.args[2].should.match(/handed off/i)
    })

    it('ignores non-message, non-handover events (e.g. referral) without erroring', async () => {
      const referral = {
        request: { body: { entry: [{ id: PAGE, messaging: [{ sender: { id: 'user123' }, recipient: { id: PAGE }, referral: { ref: 'form.flysmoke' } }] }] } },
        status: 0
      }
      await handlers.handleWebhook(referral)
      sendMessage.should.not.have.been.called
      passThreadControl.should.not.have.been.called
    })

    it('matches our app id even when Facebook sends new_owner_app_id as a number', async () => {
      // Regression: real Messenger webhooks deliver new_owner_app_id as a JSON
      // *number* (e.g. 976665718578167), while FACEBOOK_APP_ID is a string env
      // var. A strict !== between them is always true, which silently dropped
      // every real handover — the echo app never greeted, so the smoke test's
      // round trip never started, even though the string-vs-string tests above
      // passed. Re-require handlers with a numeric app id and send the number.
      const prevAppId = process.env.FACEBOOK_APP_ID
      process.env.FACEBOOK_APP_ID = '976665718578167'
      try {
        const numericHandlers = proxyquire('./handlers', {
          './messenger': { sendMessage, passThreadControl }
        })
        const ctx = {
          request: {
            body: {
              entry: [{
                id: PAGE,
                messaging_handovers: [{
                  sender: { id: 'user123' },
                  recipient: { id: PAGE },
                  pass_thread_control: { new_owner_app_id: 976665718578167, previous_owner_app_id: 699455733740842, metadata: '{}' }
                }]
              }]
            }
          },
          status: 0
        }
        await numericHandlers.handleWebhook(ctx)
        sendMessage.should.have.been.calledOnce
        sendMessage.firstCall.args[2].should.match(/handed off/i)
      } finally {
        process.env.FACEBOOK_APP_ID = prevAppId
      }
    })

    it('echoes the reply and hands control back once a waiting user responds', async () => {
      await handlers.handleWebhook(handover('echo-app-id'))
      sendMessage.resetHistory()

      await handlers.handleWebhook(message('hello there'))

      sendMessage.should.have.been.calledOnce
      sendMessage.firstCall.args[0].should.equal(PAGE)
      sendMessage.firstCall.args[1].should.equal('user123')
      sendMessage.firstCall.args[2].should.match(/hello there/)

      passThreadControl.should.have.been.calledOnce
      const [pageId, userId, targetAppId, metadata] = passThreadControl.firstCall.args
      pageId.should.equal(PAGE)
      userId.should.equal('user123')
      targetAppId.should.equal('fly-app-id')
      metadata.should.deep.equal({ smoke_echo: 'ok', echo_text: 'hello there' })
    })

    it('ignores messages from users we are not waiting on', async () => {
      await handlers.handleWebhook(message('unsolicited'))
      sendMessage.should.not.have.been.called
      passThreadControl.should.not.have.been.called
    })

    it('only reacts to the first reply from a waiting user', async () => {
      await handlers.handleWebhook(handover('echo-app-id'))
      await handlers.handleWebhook(message('first'))

      sendMessage.resetHistory()
      passThreadControl.resetHistory()

      await handlers.handleWebhook(message('second'))
      sendMessage.should.not.have.been.called
      passThreadControl.should.not.have.been.called
    })

    it('tracks waiting users per page (same user id on another page is independent)', async () => {
      // A handover on 1855... must not make us echo that user's reply on test-page.
      await handlers.handleWebhook(handoverInMessaging('echo-app-id'))
      sendMessage.resetHistory()
      passThreadControl.resetHistory()

      // Reply arrives on a DIFFERENT page for the same user id — not awaited there.
      await handlers.handleWebhook(message('reply on wrong page'))
      passThreadControl.should.not.have.been.called
    })
  })

  describe('passback (manual recovery)', () => {
    it('hands control back to Fly for the given user and page', async () => {
      const ctx = { request: { body: { userId: '1989430067808669', pageId: PAGE } }, query: {}, status: 0 }
      await handlers.passback(ctx)

      ctx.status.should.equal(200)
      ctx.body.ok.should.equal(true)
      passThreadControl.should.have.been.calledOnce
      const [pageId, userId, targetAppId, metadata] = passThreadControl.firstCall.args
      pageId.should.equal(PAGE)
      userId.should.equal('1989430067808669')
      targetAppId.should.equal('fly-app-id')
      metadata.should.deep.equal({ smoke_echo: 'manual_passback' })
    })

    it('accepts userId and pageId from the query string (GET)', async () => {
      const ctx = { request: { body: {} }, query: { userId: '1989430067808669', pageId: PAGE }, status: 0 }
      await handlers.passback(ctx)
      ctx.status.should.equal(200)
      passThreadControl.firstCall.args[0].should.equal(PAGE)
      passThreadControl.firstCall.args[1].should.equal('1989430067808669')
    })

    it('rejects when no userId is provided', async () => {
      const ctx = { request: { body: { pageId: PAGE } }, query: {}, status: 0 }
      await handlers.passback(ctx)
      ctx.status.should.equal(400)
      passThreadControl.should.not.have.been.called
    })

    it('rejects when no pageId is provided', async () => {
      const ctx = { request: { body: { userId: '1989430067808669' } }, query: {}, status: 0 }
      await handlers.passback(ctx)
      ctx.status.should.equal(400)
      passThreadControl.should.not.have.been.called
    })

    it('rejects when the page is not configured', async () => {
      const ctx = { request: { body: { userId: '1989430067808669', pageId: 'unconfigured-page' } }, query: {}, status: 0 }
      await handlers.passback(ctx)
      ctx.status.should.equal(400)
      passThreadControl.should.not.have.been.called
    })

    it('reports a Facebook error as a 502', async () => {
      passThreadControl.rejects(new Error('Facebook API error on /me/pass_thread_control: boom'))
      const ctx = { request: { body: { userId: 'user123', pageId: PAGE } }, query: {}, status: 0 }
      await handlers.passback(ctx)
      ctx.status.should.equal(502)
      ctx.body.ok.should.equal(false)
    })
  })
})
