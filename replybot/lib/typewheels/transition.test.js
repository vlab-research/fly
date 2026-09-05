const mocha = require('mocha')
const chai = require('chai')
const should = chai.should()
const { Machine } = require('./transition')
const { _initialState } = require('./machine')
const { echo, tyEcho, statementEcho, repeatEcho, delivery, read, qr, text, sticker, multipleChoice, referral, USER_ID, PAGE_ID, reaction, syntheticBail, syntheticPR, optin, payloadReferral, syntheticRedo, synthetic, handover, whatsappReferral, WA_USER_ID, WA_PHONE_NUMBER_ID } = require('./events.test')

process.env.FALLBACK_FORM = 'fallback'
process.env.REPLYBOT_RESET_SHORTCODE = 'reset'

describe('machine.run', () => {

  // The HISTORY_LIMIT capped state (statestore.js cappedState) is USER_BLOCKED
  // with NO md. That is safe only if every event a capped conversation can
  // receive no-ops before actionsResponses, whose `!newState.md` check throws
  // untagged (STATE_ACTIONS) and would convert the capped state into an ERROR
  // that dean retries every 30 minutes. Pin the realistic arrivals: inbound
  // text, a postback, and a late read/delivery watermark for a pre-cap message.
  describe('a USER_BLOCKED state with no md (the HISTORY_LIMIT capped state)', () => {
    const capped = {
      state: 'USER_BLOCKED', qa: [], forms: [],
      error: { tag: 'HISTORY_LIMIT', message: 'history exceeds 10000 events', ts: 1 }
    }

    const arrivals = { text, multipleChoice, qr, read, delivery, echo }

    for (const [name, ev] of Object.entries(arrivals)) {
      it(`no-ops a ${name} event without touching getForm and keeps the capped state`, async () => {
        const m = new Machine()
        let getFormCalls = 0
        m.getForm = async () => { getFormCalls++; return [{}, 'survey'] }

        const report = await m.run(capped, USER_ID, JSON.stringify({ ...ev, timestamp: 5000 }))

        should.not.exist(report.error)
        report.publish.should.be.false
        report.newState.should.eql(capped)
        getFormCalls.should.equal(0)
      })
    }
  })

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


  // Mistakes in the study's own form config used to land in the STATE_ACTIONS
  // catch-all, which every consumer reads as "platform fault": it paged the
  // platform on-call, dean retried it forever, and the dashboard told the
  // researcher it was "not caused by your survey configuration".
  describe('study form-config errors carry their own tag', () => {

    const stubForm = (fields) => {
      const m = new Machine()
      m.getForm = async () => [{ id: 'FOO', fields }, 'survey-id']
      return m
    }

    // The respondent is sitting on a field the study owner has since deleted.
    it('returns FIELD_NOT_FOUND when the form no longer has the field', async () => {
      const m = stubForm([{ ref: 'still-here', type: 'short_text', title: 'hi', properties: {} }])

      const state = {
        state: 'QOUT',
        question: 'deleted-field',
        qa: [],
        forms: ['FOO'],
        md: { startTime: 1, form: 'FOO', pageid: PAGE_ID }
      }

      const report = await m.run(state, USER_ID, text)
      report.error.tag.should.equal('FIELD_NOT_FOUND')
      report.error.message.should.match(/Could not find the requested field, deleted-field/)
    })

    // A title referencing an answer the respondent never gave -- questions
    // reordered, or the branch that asks it was skipped.
    it('returns INTERPOLATION_ERROR when a title references a missing answer', async () => {
      const m = stubForm([{
        ref: 'a',
        type: 'short_text',
        title: 'Hi {{field:never-answered}}',
        properties: {}
      }])

      const report = await m.run(_initialState(), USER_ID, referral)
      report.error.tag.should.equal('INTERPOLATION_ERROR')
      report.error.message.should.match(/non-existent value/)
    })
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
  // (dean timeouts / follow-ups) carry source.type 'synthetic', so the outbound
  // platform has to come from somewhere else, or WhatsApp conversations get
  // 'messenger' send commands and message-worker rejects them.
  //
  // It comes from THE EVENT, not from the persisted state.md.platform: a
  // participant messaging two accounts can hold a state blob whose md names the
  // OTHER conversation's platform. The md below is deliberately left in place and
  // is deliberately not what makes this pass.
  it('produces whatsapp commands for a synthetic timeout on a whatsapp conversation', async () => {
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
      source: { type: 'synthetic', account_id: WA_PHONE_NUMBER_ID, platform: 'whatsapp' },
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

  // The response row archived into chatroach.responses must carry the
  // conversation's platform. It is threaded from the event through transition()
  // into actionsResponses() -> responseVals(), and scribble writes it to the
  // nullable `platform` column (migration 26). Nothing else populates it.
  it('includes the conversation platform on the response row', async () => {
    const m = new Machine()

    m.getForm = () => Promise.resolve([{
      logic: [],
      fields: [
        { type: 'short_text', title: 'foo', ref: 'foo' },
        { type: 'short_text', title: 'bar', ref: 'bar' }
      ]
    }, 'foo'])

    const report = await m.run({ state: 'QOUT', md: {}, question: 'foo', qa: [], forms: ['someform'] }, 'bar', text)

    should.not.exist(report.error)
    should.exist(report.responses)
    report.responses.platform.should.equal('messenger')
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


  // A synthetic event on a conversation that replayed as START. The machine
  // no-ops, so the state that reaches `states` and the cache must be the one it
  // came in with -- unchanged, still START, still empty.
  describe('synthetic event, no conversation', () => {
    const timeout = synthetic({ type: 'timeout', value: 1000 })
    const click = synthetic({
      type: 'external',
      value: { type: 'linksniffer:click', url: 'https://example.com' }
    })

    const refused = async event => {
      const m = new Machine()
      // Would throw if it were ever reached; the no-op must short-circuit before
      // actionsResponses, which is where the 305 lookup and the send would happen.
      m.getForm = () => Promise.reject(new Error('getForm must not be reached'))
      return m.run(_initialState(), 'bar', event)
    }

    it('leaves the state untouched, so `states` is not advanced', async () => {
      const report = await refused(timeout)

      report.newState.should.eql(_initialState())
    })

    it('caches nothing but the state it started from', async () => {
      const report = await refused(click)

      report.newState.state.should.equal('START')
      report.newState.forms.should.eql([])
    })

    it('publishes no machine_report and sends no message', async () => {
      const report = await refused(timeout)

      report.publish.should.be.false
      should.not.exist(report.commands)
      should.not.exist(report.responses)
      should.not.exist(report.error)
    })

    it('still reports the conversation the event named', async () => {
      const event = synthetic({ type: 'timeout', value: 1000 }, {
        source: { type: 'synthetic', account_id: PAGE_ID, platform: 'whatsapp' }
      })
      const report = await refused(event)

      report.user.should.equal('bar')
      report.timestamp.should.equal(event.timestamp)
      report.page.should.equal(PAGE_ID)
      report.platform.should.equal('whatsapp')
    })

    // The contrast case: a Messenger handover on the same empty state is NOT
    // refused, so the shell publishes normally. If this ever starts failing,
    // the guard has been widened from "synthetic" to "external" and the
    // documented handover race is broken.
    it('does not refuse a Messenger handover on the same empty state', async () => {
      const m = new Machine()
      m.getForm = () => Promise.resolve([{ logic: [], fields: [{ type: 'short_text', title: 'foo', ref: 'foo' }] }, 'surveyid'])

      const report = await m.run(_initialState(), 'bar', handover({ metadata: 'new message' }))

      report.publish.should.be.true
      should.exist(report.newState)
      report.newState.forms.should.eql(['fallback'])
    })
  })


  // A form-less entry event (Messenger's bare `get_started`, or a referral whose
  // ref names no form) arriving on a conversation that already has a form. The
  // machine no-ops it (machine.js's REFERRAL case), so the live conversation
  // must come back out of the shell exactly as it went in.
  describe('form-less entry on a live conversation', () => {
    const rawGetStarted = {
      source: 'messenger',
      sender: { id: USER_ID },
      recipient: { id: PAGE_ID },
      timestamp: 1755000001653,
      postback: { title: 'Get Started', payload: 'get_started' }
    }

    // A live conversation on a different form in the same account, awaiting an answer.
    const live = { ..._initialState(), state: 'QOUT', forms: ['mnchweeklanguage'], question: 'foo' }

    const refused = async () => {
      const m = new Machine()
      // Would throw if reached: the no-op must short-circuit before the
      // FALLBACK_FORM lookup and the send.
      m.getForm = () => Promise.reject(new Error('getForm must not be reached'))
      return m.run(live, USER_ID, rawGetStarted)
    }

    it('leaves the live conversation exactly as it was', async () => {
      const report = await refused()

      report.newState.should.eql(live)
    })

    it('does not switch the participant onto FALLBACK_FORM', async () => {
      const report = await refused()

      report.newState.state.should.equal('QOUT')
      report.newState.forms.should.eql(['mnchweeklanguage'])
    })

    it('publishes no machine_report, sends no message, records no response', async () => {
      const report = await refused()

      report.publish.should.be.false
      should.not.exist(report.commands)
      should.not.exist(report.responses)
      should.not.exist(report.error)
    })

    it('still reports the conversation the event was refused for', async () => {
      const report = await refused()

      report.user.should.equal(USER_ID)
      report.timestamp.should.equal(rawGetStarted.timestamp)
      report.page.should.equal(PAGE_ID)
      report.platform.should.equal('messenger')
    })

    // The contrast case, and the 162,148-row half of the behaviour: the same
    // webhook on an empty conversation is an ENTRY and must still be served.
    it('does not defer the same postback on an empty conversation', async () => {
      const m = new Machine()
      m.getForm = () => Promise.resolve([{ logic: [], fields: [{ type: 'short_text', title: 'foo', ref: 'foo' }] }, 'surveyid'])

      const report = await m.run(_initialState(), USER_ID, rawGetStarted)

      report.publish.should.be.true
      should.exist(report.newState)
      report.newState.forms.should.eql(['fallback'])
      report.commands.length.should.equal(1)
    })
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
