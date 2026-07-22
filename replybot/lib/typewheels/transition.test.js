const mocha = require('mocha')
const chai = require('chai')
const should = chai.should()
const { Machine } = require('./transition')
const { echo, tyEcho, statementEcho, repeatEcho, delivery, read, qr, text, sticker, multipleChoice, referral, USER_ID, PAGE_ID, reaction, syntheticBail, syntheticPR, optin, payloadReferral, syntheticRedo, synthetic, whatsappReferral, WA_USER_ID, WA_PHONE_NUMBER_ID } = require('./events.test')

process.env.FALLBACK_FORM = 'fallback'
process.env.REPLYBOT_RESET_SHORTCODE = 'reset'

describe('machine.run', () => {
  it('returns STATE_TRANSITION error if transition throws', async () => {

    const m = new Machine()
    m.transition = () => { throw new Error('foo') }
    const timestamp = Date.now()
    const report = await m.run({ state: 'QOUT' }, 'bar', { event: 'hello', timestamp })
    report.user.should.equal('bar')
    report.error.message.should.equal('foo')
    report.timestamp.should.equal(timestamp)
    report.error.tag.should.equal('STATE_TRANSITION')
    report.error.state.should.eql({ state: 'QOUT' })
    report.publish.should.be.false
  })


  it('returns STATE_ACTIONS error if run throws for unknown reason', async () => {

    const m = new Machine()
    m.transition = () => ({ newState: {}, output: {} })
    m.actionsResponses = () => { throw new Error('foo') }
    const timestamp = Date.now()
    const report = await m.run({ state: 'QOUT' }, 'bar', { event: 'hello', timestamp })
    report.user.should.equal('bar')
    report.timestamp.should.equal(timestamp)
    report.error.message.should.equal('foo')
    report.error.tag.should.equal('STATE_ACTIONS')
    report.publish.should.be.true
  })

  it('returns STATE_ACTIONS error if actionsResponses throws an error', async () => {

    const m = new Machine()
    m.transition = () => ({ newState: {}, output: {} })
    m.actionsResponses = () => Promise.reject(new Error('foo'))
    const timestamp = Date.now()
    const report = await m.run({ state: 'QOUT' }, 'bar', { event: 'hello', timestamp })
    report.user.should.equal('bar')
    report.timestamp.should.equal(timestamp)
    report.error.message.should.equal('foo')
    report.error.tag.should.equal('STATE_ACTIONS')
    report.publish.should.be.true
  })


  it('returns a report with commands if all goes well', async () => {
    const m = new Machine()
    m.transition = () => ({ newState: {}, output: {} })
    m.actionsResponses = () => ({ actions: [{ type: 'text', text: 'qux' }] })

    const timestamp = Date.now()
    const report = await m.run({ state: 'QOUT' }, 'bar', { event: 'hello', timestamp })
    report.user.should.equal('bar')
    report.timestamp.should.equal(timestamp)
    should.not.exist(report.error)
    report.commands.should.be.an('array')
    report.commands[0].should.have.property('command_id')
    report.commands[0].should.have.property('message')
    report.commands[0].message.should.have.property('type', 'text')
    report.commands[0].message.text.should.equal('qux')
    report.publish.should.be.true
  })


})

describe('Machine integrated', () => {

  it('returns a report with commands when given send actions', async () => {
    const m = new Machine()

    m.getForm = () => Promise.resolve([{
      logic: [],
      fields: [{ type: 'short_text', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' }],
      offTime: referral.timestamp + 1000 * 60 * 60 * 24
    }, 'foo'])

    const report = await m.run({ state: 'START', qa: [], forms: [] }, 'bar', referral)
    report.user.should.equal('bar')
    should.not.exist(report.error)
    report.timestamp.should.equal(referral.timestamp)
    report.commands.should.be.an('array')
    report.commands.length.should.be.greaterThan(0)
    report.commands[0].should.have.property('message')
    report.commands[0].message.should.have.property('text')
    report.commands[0].message.text.should.equal('foo')
    report.publish.should.be.true
  })

  // Locks the replybot-side sendParams (message-tag) contract at the actual
  // pre-Kafka seam: Machine.run() -> transition() -> actionsResponses() ->
  // act() -> buildCommands(). A field whose `properties.description` carries
  // `sendParams: { messaging_type, tag }` gets merged into `field.md` by
  // `addCustomType` (form.js), survives into the translated message's
  // `metadata.sendParams` (generic-translator.js), and is still there,
  // untouched, on the outbound `send_message` command's `message.metadata`.
  // Message tags are in real production use (97 forms / 3,078 participants,
  // last 3-6mo) — this is not a legacy/dead path.
  //
  // BOUNDARY (documented, not asserted here — that's message-worker's/
  // facebot's territory, not replybot's): `@vlab-research/translate-typeform`'s
  // `formatResponse` (translate-fields.js:386) spreads `metadata.sendParams`
  // onto the *top level* of the object next to `message`
  // (i.e. `{ messaging_type, tag, message }`), but replybot's actual send
  // pipeline (`generic-translator.js` + `transition.js`) does not use that
  // translator and does not perform this promotion — `sendParams` stays
  // nested under `command.message.metadata.sendParams` all the way to Kafka.
  // Separately, the V2 Go message-worker's `SendMessageCommand` struct
  // (message-worker/types/command.go) has no top-level `messaging_type`/`tag`
  // field, and its outbound `FacebookSendRequest` (messenger_client.go:27)
  // only carries `{Recipient, Message}` — so even though replybot correctly
  // emits the tag on the command, it does not currently reach the Facebook
  // Send API. That gap lives entirely on the message-worker side and is
  // tracked separately; this test only locks the replybot half (the tag
  // data survives intact to the edge of replybot's own output).
  it('carries sendParams (message-tag) through to the outbound command, nested under message.metadata, never promoted to the top level', async () => {
    const m = new Machine()

    m.getForm = () => Promise.resolve([{
      logic: [],
      fields: [{
        type: 'short_text',
        title: 'foo',
        ref: 'foo',
        properties: { description: '{"sendParams": {"tag": "CONFIRMED_EVENT_UPDATE", "messaging_type": "MESSAGE_TAG"}}' }
      },
      { type: 'short_text', title: 'bar', ref: 'bar' }],
      offTime: referral.timestamp + 1000 * 60 * 60 * 24
    }, 'foo'])

    const report = await m.run({ state: 'START', qa: [], forms: [] }, 'bar', referral)
    should.not.exist(report.error)
    report.publish.should.be.true
    report.commands.should.be.an('array')
    report.commands.length.should.be.greaterThan(0)

    const command = report.commands[0]
    command.message.text.should.equal('foo')

    // The contract: sendParams survives, nested under message.metadata.
    command.message.metadata.sendParams.messaging_type.should.equal('MESSAGE_TAG')
    command.message.metadata.sendParams.tag.should.equal('CONFIRMED_EVENT_UPDATE')

    // The boundary: replybot never promotes it to the top level of the
    // command (that's translate-typeform's formatResponse behavior, which
    // this pipeline does not use) — so downstream consumers relying on a
    // top-level messaging_type/tag would get nothing.
    should.not.exist(command.messaging_type)
    should.not.exist(command.tag)
  })


  it('returns a report with payment when given payment to send', async () => {
    const _echo = md => ({ ...echo, payload: { ...echo.payload, metadata: md } })
    const m = new Machine()

    m.getForm = () => Promise.resolve([{
      logic: [],
      fields: [
        { type: 'short_text', title: 'foo', ref: 'foo' },
        { type: 'short_text', title: 'bar', ref: 'bar', properties: { description: JSON.stringify({ payment: { provider: 'reloadly', details: { foo: 'bar' } } }) } }
      ]
    }, 'foo'])

    const event = text

    const report = await m.run({ state: 'QOUT', md: {}, question: 'foo', qa: [], forms: ['someform'] }, 'bar', event)

    report.user.should.equal('bar')

    should.not.exist(report.error)
    report.timestamp.should.equal(event.timestamp)
    report.commands[0].message.text.should.eql('bar')
    report.publish.should.be.true

    report.payment.should.eql({
      userid: 'bar',
      pageid: '1051551461692797',
      timestamp: event.timestamp,
      provider: 'reloadly',
      details: { foo: 'bar' },
      platform: 'messenger'
    })
  })



  it('persists md.platform and emits whatsapp commands on a whatsapp conversation start', async () => {
    const m = new Machine()

    m.getForm = () => Promise.resolve([{
      logic: [],
      fields: [{ type: 'short_text', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' }],
      offTime: whatsappReferral.timestamp + 1000 * 60 * 60 * 24
    }, 'foo'])

    const report = await m.run({ state: 'START', qa: [], forms: [] }, WA_USER_ID, whatsappReferral)

    should.not.exist(report.error)
    report.publish.should.be.true

    // The platform is persisted with the state so synthetic re-entry events
    // can recover it (the state_json is what scribble writes to the DB).
    report.newState.md.platform.should.equal('whatsapp')
    report.newState.md.pageid.should.equal(WA_PHONE_NUMBER_ID)

    report.commands[0].platform.should.equal('whatsapp')
    report.commands[0].platform_account_id.should.equal(WA_PHONE_NUMBER_ID)
  })

  it('persists md.platform from a synthetic referral carrying platform whatsapp — never synthetic', async () => {
    // Synthetic conversation starts (Track A staging testing) carry
    // source.type 'synthetic' plus an optional platform hint surfaced by the
    // event-normalizer as source.platform. md.platform must hold the real
    // platform, never 'synthetic'.
    const syntheticReferral = {
      ...whatsappReferral,
      source: { type: 'synthetic', account_id: WA_PHONE_NUMBER_ID, platform: 'whatsapp' }
    }

    const m = new Machine()

    m.getForm = () => Promise.resolve([{
      logic: [],
      fields: [{ type: 'short_text', title: 'foo', ref: 'foo' }],
      offTime: syntheticReferral.timestamp + 1000 * 60 * 60 * 24
    }, 'foo'])

    const report = await m.run({ state: 'START', qa: [], forms: [] }, WA_USER_ID, syntheticReferral)

    should.not.exist(report.error)
    report.newState.md.platform.should.equal('whatsapp')
    report.commands[0].platform.should.equal('whatsapp')
  })

  // Regression test for the wrong-platform bug: synthetic re-entry events
  // (dean timeouts / follow-ups) carry source.type 'synthetic', so the
  // outbound platform must come from the persisted md.platform — before that
  // was persisted, WhatsApp conversations got 'messenger' send commands.
  it('produces whatsapp commands for a synthetic timeout on a state with md.platform whatsapp', async () => {
    const m = new Machine()

    m.getForm = () => Promise.resolve([{
      logic: [],
      fields: [{ type: 'short_text', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' }],
      offTime: Date.now() + 1000 * 60 * 60 * 24
    }, 'foo'])

    const now = Date.now()
    const state = {
      state: 'WAIT_EXTERNAL_EVENT',
      question: 'foo',
      wait: { type: 'timeout', value: '1 hour' },
      waitStart: now - 1000 * 60 * 61,
      externalEvents: [],
      forms: ['FOO'],
      qa: [],
      md: { form: 'FOO', startTime: now - 1000 * 60 * 61, pageid: WA_PHONE_NUMBER_ID, platform: 'whatsapp' }
    }

    const timeoutEvent = {
      event_id: 'evt_test_wa_timeout',
      user_id: WA_USER_ID,
      timestamp: now,
      source: { type: 'synthetic', account_id: WA_PHONE_NUMBER_ID },
      event_type: 'synthetic_timeout',
      payload: now
    }

    const report = await m.run(state, WA_USER_ID, timeoutEvent)

    should.not.exist(report.error)
    report.publish.should.be.true
    report.commands.length.should.be.greaterThan(0)
    report.commands.forEach(c => {
      c.platform.should.equal('whatsapp')
      c.platform_account_id.should.equal(WA_PHONE_NUMBER_ID)
    })
  })

  it('includes platform whatsapp on payment events from a whatsapp conversation', async () => {
    const m = new Machine()

    m.getForm = () => Promise.resolve([{
      logic: [],
      fields: [
        { type: 'short_text', title: 'foo', ref: 'foo' },
        { type: 'short_text', title: 'bar', ref: 'bar', properties: { description: JSON.stringify({ payment: { provider: 'reloadly', details: { foo: 'bar' } } }) } }
      ]
    }, 'foo'])

    const waText = {
      ...text,
      user_id: WA_USER_ID,
      source: { type: 'whatsapp', account_id: WA_PHONE_NUMBER_ID }
    }

    const state = {
      state: 'QOUT',
      md: { platform: 'whatsapp', pageid: WA_PHONE_NUMBER_ID },
      question: 'foo',
      qa: [],
      forms: ['someform']
    }

    const report = await m.run(state, WA_USER_ID, waText)

    should.not.exist(report.error)
    report.payment.should.eql({
      userid: WA_USER_ID,
      pageid: WA_PHONE_NUMBER_ID,
      timestamp: waText.timestamp,
      provider: 'reloadly',
      details: { foo: 'bar' },
      platform: 'whatsapp'
    })
  })

  it('returns no payment when the message is a repeat', async () => {
    const _echo = md => ({ ...echo, payload: { ...echo.payload, metadata: md } })
    const m = new Machine()

    m.getForm = () => Promise.resolve([{
      logic: [],
      fields: [{ type: 'statement', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }, 'foo'])


    const md = { ref: 'foo', type: 'payment', payment: { provider: 'reloadly', details: { foo: 'bar' } }, isRepeat: true }

    const event = _echo(md)

    const report = await m.run({ state: 'RESPONDING', md: {}, question: 'foo', qa: [], forms: ['someform'] }, 'bar', event)

    report.user.should.equal('bar')

    should.not.exist(report.error)
    report.timestamp.should.equal(event.timestamp)
    report.commands.should.eql([])
    report.publish.should.be.true
    should.not.exist(report.payment)
  })



  it('returns an error report with INTERNAL when internal network failures happen', async () => {
    const m = new Machine()

    m.getForm = () => Promise.reject(new Error('Ah'))

    const report = await m.run({ state: 'START', qa: [], forms: [] }, 'bar', referral)
    report.user.should.equal('bar')
    report.error.tag.should.equal('INTERNAL')
    report.publish.should.be.true
  })

  it('returns a report with publish false when there is no update', async () => {
    const m = new Machine()

    m.getForm = () => Promise.resolve([{
      logic: [],
      fields: [{ type: 'short_text', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }, 'foo'])

    const state = { state: 'RESPONDING', qa: [], forms: ['foo'] }

    const report = await m.run(state, 'bar', text)

    report.user.should.equal('bar')
    should.not.exist(report.error)
    report.timestamp.should.equal(text.timestamp)
    report.publish.should.be.false
    report.newState.should.eql(state)
    should.not.exist(report.commands)
  })


  it('returns a report with publish true when there is a reset state', async () => {
    const m = new Machine()
    const state = { state: 'QOUT', qa: [], forms: ['foo'] }
    const resetReferral = { ...referral, payload: { ...referral.payload, referral: { ...referral.payload.referral, ref: 'form.reset' } } }
    const report = await m.run(state, 'bar', resetReferral)

    report.user.should.equal('bar')

    should.not.exist(report.error)

    report.timestamp.should.equal(referral.timestamp)
    report.publish.should.be.true

    report.newState.state.should.eql("START")
    should.not.exist(report.commands)
  })


  it('returns a report with publish true and responds to message correctly if offTime past', async () => {

    const now = Date.now()
    const m = new Machine()

    m.getForm = () => Promise.resolve([{
      logic: [],
      fields: [{ type: 'short_text', title: 'foo', ref: 'foo' }],
      offTime: now - 1000 * 60,
    }, 'foo'])

    const state = { state: 'START', qa: [], forms: ['foo'], md: { startTime: 123 } }

    const report = await m.run(state, 'bar', { ...text, timestamp: now })

    report.user.should.equal('bar')
    should.not.exist(report.error)

    report.timestamp.should.equal(now)
    report.publish.should.be.true

    report.newState.state.should.eql("RESPONDING")
    report.commands.length.should.equal(1)
    report.commands[0].message.text.should.eql("We're sorry, but this survey is now over and closed.")
  })


  it('doesnt publish machine report when recieves machine report and currently in error state', async () => {
    const m = new Machine()

    m.getForm = () => Promise.resolve([{
      logic: [],
      fields: [{ type: 'short_text', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }, 'foo'])

    const state = { state: 'ERROR', qa: [], forms: ['foo'] }

    const event = synthetic({ type: 'machine_report', value: { error: { tag: 'INTERNAL', status: 404 } } })
    const report = await m.run(state, 'bar', event)

    report.user.should.equal('bar')
    should.not.exist(report.error)
    report.timestamp.should.equal(event.timestamp)
    report.publish.should.be.false
    report.newState.should.eql(state)
    should.not.exist(report.commands)
  })


  it('returns an error report when no timestamp in message', async () => {
    const m = new Machine()

    m.getForm = () => Promise.reject(new Error('Ah'))

    const report = await m.run({ state: 'START', qa: [], forms: [] }, 'bar', { event_type: 'user_text', source: { type: 'messenger', account_id: '1051551461692797' }, payload: { type: 'user_text', text: 'hi' } })
    report.user.should.equal('bar')
    report.error.tag.should.equal('CORRUPTED_MESSAGE')
    report.publish.should.be.true
  })

  describe('handoff functionality', () => {
    it('should include handoff command when handoff data is present', async () => {
      const m = new Machine()
      m.transition = () => ({ newState: {}, output: { action: 'RESPOND' } })
      m.getForm = () => Promise.resolve([{ fields: [] }, 'survey123', {}])

      const handoffData = {
        userid: 'bar',
        target_app_id: '987654321',
        metadata: { reason: 'test' }
      }

      m.actionsResponses = () => Promise.resolve({
        actions: [],
        responses: [],
        payment: undefined,
        handoff: handoffData
      })

      const report = await m.run({ state: 'START', qa: [], forms: [] }, 'bar', { event: 'hello', timestamp: Date.now() })

      report.user.should.equal('bar')
      should.not.exist(report.error)
      report.publish.should.be.true
      report.commands.should.be.an('array')
      report.commands.length.should.equal(1)
      report.commands[0].type.should.equal('handoff')
      report.commands[0].target_app_id.should.equal('987654321')
    })

    it('should not include handoff command when no handoff data is present', async () => {
      const m = new Machine()
      m.transition = () => ({ newState: {}, output: { action: 'RESPOND' } })
      m.getForm = () => Promise.resolve([{ fields: [] }, 'survey123', {}])

      m.actionsResponses = () => Promise.resolve({
        actions: [],
        responses: [],
        payment: undefined,
        handoff: undefined
      })

      const report = await m.run({ state: 'START', qa: [], forms: [] }, 'bar', { event: 'hello', timestamp: Date.now() })

      report.user.should.equal('bar')
      should.not.exist(report.error)
      report.publish.should.be.true
      report.commands.should.eql([])
    })
  })
})
