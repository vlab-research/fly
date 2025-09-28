const mocha = require('mocha')
const chai = require('chai')
const should = chai.should()
const fs = require('fs')
const _ = require('lodash')
const { parseLogJSON } = require('./utils')
const { followUpMessage, offMessage } = require('@vlab-research/translate-typeform')
const { _initialState, getMessage, exec, act, apply, getState, getCurrentForm, getWatermark, makeEventMetadata } = require('./machine')
const form = JSON.parse(fs.readFileSync('mocks/sample.json'))
const { echo, tyEcho, statementEcho, repeatEcho, delivery, read, qr, text, sticker, multipleChoice, referral, USER_ID, reaction, syntheticBail, syntheticPR, optin, payloadReferral, syntheticRedo, synthetic } = require('./events.test')

const _echo = md => ({ ...echo, message: { ...echo.message, metadata: md.ref ? md : { ref: md } } })


process.env.FALLBACK_FORM = 'fallback'
process.env.REPLYBOT_RESET_SHORTCODE = 'reset'

describe('getWatermark', () => {
  it('should work with both marks', () => {
    getWatermark(read).should.deep.equal({ type: 'read', mark: 10 })
    getWatermark(delivery).should.deep.equal({ type: 'delivery', mark: 15 })
  })
  it('should return undefined if not a read or delivery message', () => {
    should.not.exist(getWatermark(echo))
  })
})


describe('makeEventMetadata', () => {
  it('should get the metadata for a simple linksniffer event', () => {
    const event = { event: { type: 'external', value: { type: 'linksniffer:click', url: 'foobar' } } }
    const md = makeEventMetadata(event)
    md.should.eql({ e_linksniffer_click_url: 'foobar' })
  })

  it('should get multiple key/value pairs if they exist', () => {
    const event = { event: { type: 'external', value: { type: 'random', id: 'foo', foo: 'bar' } } }
    const md = makeEventMetadata(event)
    md.should.eql({ e_random_id: 'foo', e_random_foo: 'bar' })
  })

  it('should unnest kv pairs if they exist', () => {
    const event = { event: { type: 'external', value: { type: 'payment:reloadly', success: false, error: { message: 'foobar', code: 'BAR', doublenest: { foo: 'baz' } } } } }

    const md = makeEventMetadata(event)
    md.should.eql({
      e_payment_reloadly_success: false,
      e_payment_reloadly_error_message: 'foobar',
      e_payment_reloadly_error_doublenest_foo: 'baz',
      e_payment_reloadly_error_code: 'BAR'
    })
  })

  it('should work with array values and key them out by index', () => {
    const event = { event: { type: 'external', value: { type: 'random', list: ['foo', 'bar'] } } }

    const md = makeEventMetadata(event)
    md.should.eql({
      e_random_list_0: 'foo',
      e_random_list_1: 'bar'
    })
  })

  it('should work with number values', () => {
    const event = { event: { type: 'external', value: { type: 'random', foo: 1234 } } }
    const md = makeEventMetadata(event)
    md.should.eql({ e_random_foo: 1234 })
  })

  it('should work with boolean values', () => {
    const event = { event: { type: 'external', value: { type: 'random', foo: false } } }
    const md = makeEventMetadata(event)
    md.should.eql({ e_random_foo: false })
  })

  it('should set null but not undefined values', () => {
    const event = { event: { type: 'external', value: { type: 'random', foo: undefined, bar: null } } }
    const md = makeEventMetadata(event)
    md.should.eql({ e_random_bar: null })
  })

  it('should return undefined if an event not properly formatted', () => {
    const event = { event: { type: 'external', value: {} } }
    const md = makeEventMetadata(event)
    should.not.exist(md)
  })

  it('should convert camelCase keys to snake_case', () => {
    const event = {
      event: {
        type: 'external',
        value: {
          type: 'payment:status',
          userId: '123',
          paymentMethod: 'card',
          transactionId: 'tx_456'
        }
      }
    }
    const md = makeEventMetadata(event)
    md.should.eql({
      e_payment_status_user_id: '123',
      e_payment_status_payment_method: 'card',
      e_payment_status_transaction_id: 'tx_456'
    })
  })

  it('should handle nested camelCase keys', () => {
    const event = {
      event: {
        type: 'external',
        value: {
          type: 'api:response',
          errorDetails: {
            errorCode: 'INVALID_REQUEST',
            errorMessage: 'Bad input'
          }
        }
      }
    }
    const md = makeEventMetadata(event)
    md.should.eql({
      e_api_response_error_details_error_code: 'INVALID_REQUEST',
      e_api_response_error_details_error_message: 'Bad input'
    })
  })

  it('should leave snake_case keys unchanged', () => {
    const event = {
      event: {
        type: 'external',
        value: {
          type: 'existing:event',
          user_id: '123',
          already_snake: 'value'
        }
      }
    }
    const md = makeEventMetadata(event)
    md.should.eql({
      e_existing_event_user_id: '123',
      e_existing_event_already_snake: 'value'
    })
  })
})

describe('getCurrentForm', () => {
  let prevFallback

  before(() => {
    prevFallback = process.env.FALLBACK_FORM
    process.env.FALLBACK_FORM = 'fallback'
  })
  after(() => {
    process.env.FALLBACK_FORM = prevFallback
  })

  it('Gets the first form with an initial referral', () => {
    const log = [referral]
    const state = getState(log)
    state.forms[0].should.equal('FOO')
  })

  it('Gets the first form with an initial payload referral', () => {
    const log = [payloadReferral]
    const state = getState(log)
    state.forms[0].should.equal('FOO')
  })

  it('Gets the first form with an initial qr payload referral', () => {
    const qrReferral = { ...qr, message: { quick_reply: { value: "accept", payload: { referral: { ref: "form.FOO.foo.bar" } } } } }
    const log = [qrReferral]
    const state = getState(log)
    state.forms[0].should.equal('FOO')
  })

  it('Gets default form state if no form or referral', () => {
    const log = [text]
    const state = getState(log)
    state.forms[0].should.equal('fallback')
  })

  it('Gets default form state if no form or referral from sticker', () => {
    const log = [sticker]
    const state = getState(log)
    state.forms[0].should.equal('fallback')
  })

  it('Gets default form state even after repeated messages in history', () => {
    const log = [text, text, text]
    const state = getState(log)
    state.forms[0].should.equal('fallback')
  })


  it('Gets ignores texts after block_user, but keeps forms and pointer', () => {

    const log = [referral, text, echo, multipleChoice, synthetic({ type: 'block_user', value: null })]

    const state = getState(log)
    state.forms.should.eql(['FOO'])
    state.state.should.equal('USER_BLOCKED')
    state.pointer.should.equal(20)

    const state1 = getState([...log, text])
    state1.forms.should.eql(['FOO'])
    state1.state.should.equal('USER_BLOCKED')
    state1.pointer.should.equal(20)
  })

  it('Changes form with new referral', () => {
    const ref2 = { ...referral, referral: { ...referral.referral, ref: 'form.BAR' } }

    const log = [referral, text, echo, delivery, multipleChoice, ref2]
    const state = getState(log)
    state.forms[0].should.equal('FOO')
    state.forms.pop().should.equal('BAR')
  })

  it('Ignores additional referrals for the same form ', () => {
    const log = [referral, text, echo, delivery, multipleChoice, referral]
    const state = getState(log)
    state.forms.length.should.equal(1)
    state.forms.slice(-1)[0].should.equal('FOO')
  })

})

describe('getState', () => {

  it('Gets start state with empty log', () => {
    const log = []
    getState(log).state.should.equal('START')
  })

  it('Responds to a referral', () => {
    const log = [referral]
    const state = getState(log)
    state.state.should.equal('RESPONDING')
    should.not.exist(state.question)
  })

  it('Gets a question responding state before delivered', () => {
    const log = [referral, text]
    const state = getState(log)
    state.state.should.equal('RESPONDING')
    should.not.exist(state.question)
  })

  it('Gets a question responding state to unnanounced message', () => {
    const log = [text]
    const state = getState(log)
    state.state.should.equal('RESPONDING')
    should.not.exist(state.question)
  })

  it('Gets a question outstanding state if delivered', () => {
    const log = [referral, text, echo]
    const state = getState(log)
    state.state.should.equal('QOUT')
    state.question.should.equal('foo')
  })


  it('Ignores unknown event (message event)', () => {
    const e = {
      sender: { id: '123' },
      recipient: { id: '345' },
      timestamp: 1605980769303,
      message: { mid: 'foo' },
      source: 'messenger'
    }

    const log = [referral, text, echo, e]
    const state = getState(log)
    state.state.should.equal('QOUT')
    state.question.should.equal('foo')
  })

  it('Responds to postback', () => {
    const log = [referral, text, echo, multipleChoice]
    const state = getState(log)
    state.state.should.equal('RESPONDING')
  })

  it('Responds to quick reply', () => {
    const log = [referral, echo, qr]
    const state = getState(log)
    state.state.should.equal('RESPONDING')
  })

  it('Responds to freetext', () => {
    const log = [referral, echo, text]
    const state = getState(log)
    state.state.should.equal('RESPONDING')
  })

  it('Responds to own statements', () => {
    const log = [referral, echo, delivery, text, statementEcho]
    const state = getState(log)
    state.state.should.equal('RESPONDING')
  })


  it('QOUT after question repeated', () => {
    const log = [referral, echo, delivery, text, repeatEcho, echo, delivery]
    const state = getState(log)
    state.state.should.equal('QOUT')
    state.question.should.equal('foo') // should this be the case?
  })


  it('Updates the qa of the state even with falsey answers', () => {
    const log = [referral, echo, { ...text, message: { text: 0 } }, _echo('bar'), { ...text, message: { text: '' } }]
    const qa = getState(log).qa

    qa[0][0].should.equal('foo')
    qa[0][1].should.equal(0)
    qa[1][0].should.equal('bar')
    qa[1][1].should.equal('')
    qa.length.should.equal(2)
  })


  it('Updates the qa of the state with correct answers', () => {
    const echo2 = _echo('bar')

    const log = [referral, echo, delivery, text, echo2, delivery, text]

    const qa = getState(log).qa

    qa[0][0].should.equal('foo')
    qa[0][1].should.equal('foo')
    qa[1][0].should.equal('bar')
    qa[1][1].should.equal('foo')
    qa.length.should.equal(2)
  })

  // it('Updates the qa of the state with repeats', () => {
  //   const form = { logic: [],
  //                  fields: [{type: 'multiple_choice', title: 'foo', ref: 'foo', properties: {choices: [{label: 'foo'}, {label: 'quux'}]}},
  //                           {type: 'short_text', title: 'bar', ref: 'bar'}]}

  //   const response = {...qr, message: { quick_reply: { payload: { value:"quux",ref:"foo" }}}}
  //   const response2 = {...qr, message: { quick_reply: { payload: { value:"qux",ref:"foo" }}}}

  //   const log = [referral, echo, delivery, response, repeatEcho, echo, delivery, response2]
  //   const qa = getState(log).qa


  //   qa[0][1].should.equal('quux')
  //   qa[1][1].should.equal('qux')
  //   qa.length.should.equal(2)
  // })

  it('Waits for external events when wait is present in echo metadata', () => {

    const wait = { type: 'timeout', value: '2 days' }


    const log = [referral, echo, text, _echo({ wait, ref: 'bar' })]
    const state = getState(log)
    state.state.should.equal('WAIT_EXTERNAL_EVENT')
  })

  it('Responds while waiting with response and repeats', () => {

    const wait = { type: 'timeout', value: '2 days' }

    const log = [referral, echo, delivery, text, _echo({ wait, ref: 'bar' }), text]
    const state = getState(log)
    state.state.should.equal('RESPONDING')
  })


  it('Responds while waiting with response and repeats with old waitstart', () => {

    const wait = { type: 'timeout', value: '2 days' }

    const log = [referral, echo, delivery,
      text,
      _echo({ wait, ref: 'foo' }),
      text,
      echo,
      { ...echo, timestamp: 10, message: { ...echo.message, metadata: { wait } } }
    ]
    const state = getState(log)
    state.state.should.equal('WAIT_EXTERNAL_EVENT')
    state.waitStart.should.equal(5)
  })


  it('Responds when it gets external events that fulfills timeout conditions', () => {
    const wait = { type: 'timeout', value: '1 hour' }

    // value should be...?
    const externalEvent = {
      source: 'synthetic',
      event: { type: 'timeout', value: Date.now() + 1000 * 60 * 60 }
    }

    const d = Date.now()
    const log = [referral, text, { ...echo, timestamp: d, message: { ...echo.message, metadata: { wait } } }, externalEvent]

    const state = getState(log)
    state.state.should.equal('RESPONDING')
  })


  it('Responds when it gets external events that fulfill other conditions', () => {

    const wait = {
      op: 'or',
      vars:
        [{ type: 'timeout', value: '2 days' },
        { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } }]
    }

    const externalEvent = {
      source: 'synthetic',
      timestamp: Date.now(),
      event: { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } }
    }


    const log = [referral, _echo({ wait, ref: 'foo' }), externalEvent]

    const state = getState(log)
    state.state.should.equal('RESPONDING')
    state.question.should.equal('foo')

    // and stores metadata
    state.md.should.have.property('e_moviehouse_play_id', 'foobar')
    state.md.should.have.property('form', 'FOO')
  })


  it('continues to wait when it gets external events that partially fulfill conditions', () => {

    const wait = {
      op: 'and',
      vars:
        [{ type: 'timeout', value: '2 days' },
        { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } }]
    }

    const externalEvent = {
      source: 'synthetic',
      event: { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } }
    }

    const log = [referral, _echo({ wait, ref: 'foo' }), externalEvent]

    const state = getState(log)
    state.state.should.equal('WAIT_EXTERNAL_EVENT')

    // and stores metadata
    state.md.should.have.property('e_moviehouse_play_id', 'foobar')
    state.md.should.have.property('form', 'FOO')
  })


  it('Responds when it gets multiple events that fulfill all conditions', () => {

    const wait = {
      op: 'and',
      vars:
        [{ type: 'timeout', value: '2 hours' },
        { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } }]
    }

    const externalEventA = {
      source: 'synthetic',
      event: { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } }
    }

    // value should be...?
    const externalEventB = {
      source: 'synthetic',
      event: { type: 'timeout', value: Date.now() + 1000 * 60 * 120 }
    }

    const log = [referral, { ...echo, timestamp: Date.now(), message: { ...echo.message, metadata: { wait } } }, externalEventA, externalEventB]

    const state = getState(log)
    state.state.should.equal('RESPONDING')

    // and stores metadata
    state.md.should.have.property('e_moviehouse_play_id', 'foobar')
    state.md.should.have.property('form', 'FOO')
  })



  it('Adds event to metadata if not waiting external event and leaves the rest the same', () => {
    const externalEvent = {
      source: 'synthetic',
      timestamp: Date.now(),
      event: { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } }
    }

    const log = [referral, echo, text, externalEvent]
    const state = getState(log)

    state.state.should.equal('RESPONDING')
    state.md.should.have.property('e_moviehouse_play_id')
    state.md.form.should.eql("FOO")
    state.externalEvents.should.contain(externalEvent)
  })


  it('Resets all state on reset form and adds pointer', () => {

    const resetReferral = { ...referral, referral: { ...referral.referral, ref: 'form.reset' } }
    const log = [referral, echo, text, resetReferral]

    const state = getState(log)

    state.state.should.equal('START')
    state.forms.should.eql([])
    state.qa.should.eql([])
    state.pointer.should.equal(resetReferral.timestamp)
  })


  it('It switches forms after a form stitch message is sent, keeps metadata', () => {

    const metadata = { "type": "stitch", "stitch": { "form": "BAR" }, "ref": "foo" }
    const log = [referral, { ...echo, message: { ...echo.message, metadata } }]

    const oldState = getState([referral])
    const state = getState(log)
    state.state.should.equal('RESPONDING')
    state.forms[1].should.equal('BAR')
    state.md.form.should.equal('FOO')
    state.md.seed.should.equal(oldState.md.seed)
    state.md.startTime.should.not.equal(referral.timestamp)
    state.md.startTime.should.equal(echo.timestamp)
  })


  it('It switches forms after a form stitch message is sent, keeps metadata from previous events', () => {


    const wait = { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } }

    const externalEvent = {
      source: 'synthetic',
      event: { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } }
    }

    const metadata = { "type": "stitch", "stitch": { "form": "BAR" }, "ref": "foo" }
    const log = [referral, _echo({ wait, ref: 'foo' }), externalEvent, { ...echo, message: { ...echo.message, metadata } }]

    const oldState = getState([referral])
    const state = getState(log)
    state.state.should.equal('RESPONDING')
    state.forms[1].should.equal('BAR')
    state.md.form.should.equal('FOO')
    state.md.seed.should.equal(oldState.md.seed)
    state.md.startTime.should.not.equal(referral.timestamp)
    state.md.startTime.should.equal(echo.timestamp)

    state.md.should.have.property('e_moviehouse_play_id', 'foobar')
    state.md.should.have.property('form', 'FOO')
  })


  it('It switches forms after a form stitch message is sent and includes new metadata', () => {

    const metadata = { "type": "stitch", "stitch": { "form": "BAR", "metadata": { "bar_md": "hello metadata" } }, "ref": "foo" }
    const log = [referral, { ...echo, message: { ...echo.message, metadata } }]

    const oldState = getState([referral])
    const state = getState(log)
    state.state.should.equal('RESPONDING')
    state.forms[1].should.equal('BAR')
    state.md.form.should.equal('FOO')
    state.md.bar_md.should.equal('hello metadata')
  })


  it('It keeps tokens when it stitches forms together', () => {
    const metadata = { "type": "stitch", "stitch": { "form": "BAR" }, "ref": "foo" }
    const log = [referral, optin, { ...echo, message: { ...echo.message, metadata } }]

    const state = getState(log)
    state.state.should.equal('RESPONDING')
    state.forms[1].should.equal('BAR')
    state.tokens.should.eql(['FOOBAR'])
  })

  it('It moves to next form on bailout when response never sent', () => {

    const log = [referral, echo, text, syntheticBail]
    const state = getState(log)

    state.state.should.equal('RESPONDING')
    state.forms[1].should.equal('BAR')
  })

  it('ignores a good platform response', () => {

    let log = [referral]
    let state1 = getState(log)
    let state2 = getState([...log, syntheticPR])
    state2.state.should.equal(state1.state)

    log = [referral, echo]
    state1 = getState(log)
    state2 = getState([...log, syntheticPR])
    state2.state.should.equal(state1.state)
  })

  it('gets into a blocked state when given a report with a FB error', () => {
    const report = synthetic({ type: 'machine_report', value: { error: { tag: 'FB', code: 200, message: 'foo' } } })

    const log = [referral, echo, text, report]
    const state = getState(log)
    state.state.should.equal('BLOCKED')
    state.error.code.should.equal(200)
    state.error.message.should.equal('foo')
  })


  it('gets into a new blocked state when given a new report with a new FB error', () => {
    const reportA = synthetic({ type: 'machine_report', value: { error: { tag: 'FB', code: 200, message: 'foo' } } })
    const reportB = synthetic({ type: 'machine_report', value: { error: { tag: 'FB', code: 300, message: 'bar' } } })
    const log = [referral, echo, text, reportA, synthetic({ type: 'redo' }), reportB]
    const state = getState(log)
    state.state.should.equal('BLOCKED')
    state.error.code.should.equal(300)
    state.error.message.should.equal('bar')
  })

  it('gets into an error state when given a report with a different error', () => {
    const report = synthetic({ type: 'machine_report', value: { error: { tag: 'INTERNAL', code: 'FOO' } } })
    const log = [referral, echo, text, report]
    const state = getState(log)
    state.state.should.equal('ERROR')
    state.error.code.should.equal('FOO')
  })

  it('gets into a blocked state when given a bad platform response', () => {

    const pr = { ...syntheticPR, event: { ...syntheticPR.event, value: { response: { error: { code: 2022 } } } } }
    const log = [referral, echo, text, pr]
    const state = getState(log)

    state.state.should.equal('BLOCKED')
  })

  it('gets out of a blocked state if an echo follows a bad platform response', () => {
    // TODO: Is this what we want??? Race conditions???

    const pr = { ...syntheticPR, event: { ...syntheticPR.event, value: { response: { error: { code: 2022 } } } } }
    const log = [referral, echo, text, pr, echo]
    const state = getState(log)

    state.state.should.equal('QOUT')
  })

  it('gets out of a blocked state if a user responds', () => {
    // TODO: Is this what we want???
    const pr = { ...syntheticPR, event: { ...syntheticPR.event, value: { response: { error: { code: 2022 } } } } }
    const log = [referral, echo, text, pr, text]
    const state = getState(log)

    state.state.should.equal('RESPONDING')
    state.question.should.equal('foo')
  })

  it('gets out of a blocked state with an unblock event', () => {
    const e = synthetic({ type: 'unblock', value: { state: 'WAIT_EXTERNAL_EVENT' } })
    const pr = { ...syntheticPR, event: { ...syntheticPR.event, value: { response: { error: { code: 2022 } } } } }
    const log = [referral, echo, text, pr, e]
    const state = getState(log)

    state.state.should.equal('WAIT_EXTERNAL_EVENT')
    state.question.should.equal('foo')
    should.not.exist(state.error)
  })


  it('ignores an unblock event if not blocked', () => {
    const e = synthetic({ type: 'unblock', value: { state: 'WAIT_EXTERNAL_EVENT' } })
    const log = [referral, echo, text, e]
    const state = getState(log)
    state.state.should.equal('RESPONDING')
    state.question.should.equal('foo')
  })

  it('adds tokens to the state from an optin event and records response', () => {

    // TODO: Is this what we want???
    const log = [referral, echo, optin]
    const state = getState(log)

    state.state.should.equal('RESPONDING')
    state.tokens.should.eql(['FOOBAR'])
    state.question.should.equal('foo')
    state.qa.should.eql([['foo', 'optin']])
  })

  it('removes tokens to the state when it needs to use them for timeout', () => {
    const wait = { type: 'timeout', value: '25 hours', notifyPermission: true }

    // value should be...?
    const externalEvent = {
      source: 'synthetic',
      timestamp: Date.now() + 1000 * 60 * 60 * 25,
      event: { type: 'timeout', value: Date.now() + 1000 * 60 * 60 * 25 }
    }

    const d = Date.now()

    const log = [referral, optin, text, { ...echo, timestamp: d, message: { ...echo.message, metadata: { wait } } }, externalEvent]

    const state = getState(log)
    state.state.should.equal('RESPONDING')
    state.tokens.should.eql([])
  })


  it('removes tokens to the state when it needs to use them for a bailout', () => {
    const wait = { type: 'timeout', value: '25 hours', notifyPermission: true }

    const externalEvent = {
      source: 'synthetic',
      timestamp: Date.now() + 1000 * 60 * 60 * 25,
      event: { type: 'bailout', value: { form: 'BAR' } }
    }

    const d = Date.now()

    const log = [referral, optin, text, { ...echo, timestamp: d, message: { ...echo.message, metadata: { wait } } }]

    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'barbaz', ref: 'barbaz' }]
    }


    const state = getState(log)
    const output = exec(state, externalEvent)
    const actions = act({ form, user: {} }, state, output)
    output.action.should.equal('SWITCH_FORM')
    output.form.should.equal('BAR')
    actions.messages[0].recipient.one_time_notif_token.should.equal('FOOBAR')
    actions.messages[0].message.text.should.equal('barbaz')
  })
})


describe('Machine', () => {
  let user = { id: '123' }

  it('gets the correct start field even with no referral', () => {
    const output = exec(_initialState(), text)
    const actions = act({ user, form, log: [text] }, _initialState(), output)
    actions.messages[0].message.text.should.equal(form.fields[0].title)
  })

  it('sends the first message when it gets a referral', () => {
    const output = exec(_initialState(), referral)
    const actions = act({ user, form, log: [referral] }, _initialState(), output)

    actions.messages[0].message.text.should.equal(form.fields[0].title)
  })

  it('Validates answers via postback', () => {
    const form = {
      logic: [],
      fields: [{ type: 'legal', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const log = [referral, echo, delivery, multipleChoice]
    const actions = getMessage(log, form, user)
    actions.messages[0].message.should.deep.equal({ text: 'bar', metadata: '{"ref":"bar"}' })
  })

  it('Invalidates answers to legal when not in set', () => {
    const form = {
      logic: [],
      fields: [{ type: 'legal', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const log = [referral, echo, delivery, text]
    const actions = getMessage(log, form, user)
    JSON.parse(actions.messages[0].message.metadata).repeat.should.be.true
  })


  it('Invalidates answers to short_text when a previous postback is sent', () => {
    const form = {
      logic: [],
      fields: [{ type: 'legal', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' },
      { type: 'thankyou_screen', title: 'baz', ref: 'baz' }]
    }

    const log = [referral, echo, multipleChoice, _echo('bar'), multipleChoice]
    const actions = getMessage(log, form, user)
    JSON.parse(actions.messages[0].message.metadata).repeat.should.be.true
  })


  it('Validates answers via qr', () => {
    const log = [referral, text, echo, delivery, qr]
    const state = getState(log.slice(0, -1))
    const output = exec(state, qr)
    should.not.exist(output.validation)
  })

  it('It switches forms on bailout when response never sent', () => {

    const log = [referral, echo, text]
    const state = getState(log)
    const output = exec(state, syntheticBail)

    output.action.should.equal('SWITCH_FORM')
    output.form.should.equal('BAR')
    output.md.seed.should.equal(state.md.seed)
    output.md.startTime.should.not.equal(state.md.startTime)
    output.md.startTime.should.equal(syntheticBail.timestamp)
  })

  it('It ignores platform response errors when in blocked state', () => {
    const report = synthetic({ type: 'platform_response', value: { response: { error: { tag: 'FB', code: 200 } } } })
    const log = [referral, echo, text, report]
    const state = getState(log)
    const output = exec(state, report)
    output.action.should.equal('NONE')
  })

  it('It ignores machine report errors when in blocked state', () => {
    const report = synthetic({ type: 'machine_report', value: { error: { tag: 'FB', code: 200 } } })
    const log = [referral, echo, text, report]
    const state = getState(log)
    const output = exec(state, report)
    output.action.should.equal('NONE')
  })

  it('It ignores machine report errors when in error state', () => {
    const report = synthetic({ type: 'machine_report', value: { error: { tag: 'INTERNAL', code: 200 } } })
    const log = [referral, echo, text, report]
    const state = getState(log)
    const output = exec(state, report)
    output.action.should.equal('NONE')
  })

  it('It ignores machine reports for error when in blocked state', () => {
    const report = synthetic({ type: 'machine_report', value: { error: { tag: 'FB', code: 200 } } })
    const report2 = synthetic({ type: 'machine_report', value: { error: { tag: 'INTERNAL', code: 200 } } })
    const log = [referral, echo, text, report]
    const state = getState(log)
    state.state.should.equal('BLOCKED')
    const output = exec(state, report2)
    output.action.should.equal('NONE')
  })

  it('It can move from a blocked state to an error state after a redo event', () => {
    const report = synthetic({ type: 'machine_report', value: { error: { tag: 'FB', code: 200 } } })
    const report2 = synthetic({ type: 'machine_report', value: { error: { tag: 'INTERNAL', code: 200 } } })
    const log = [referral, echo, text, report, synthetic({ type: 'redo' })]
    const state = getState(log)
    state.state.should.equal('RESPONDING')
    const output = exec(state, report2)
    output.action.should.equal('ERROR')
  })


  it('previousOutput has followUp prop when given follow_up event', () => {
    const fu = synthetic({ type: 'follow_up', value: 'foo' })
    const log = [referral, echo, fu]
    const state = getState(log)
    state.state.should.equal('RESPONDING')
    state.previousOutput.followUp.should.be.true
  })


  it('previousOutput has no followUp prop when user continue after follow_up event', () => {
    const fu = synthetic({ type: 'follow_up', value: 'foo' })
    const log = [referral, echo, fu, echo, text, echo]
    const state = getState(log)
    state.state.should.equal('QOUT')
    should.not.exist(state.previousOutput.followUp)
  })

  it('it gets the next question when there is a next', () => {
    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const log = [referral, echo, delivery, text]
    const actions = getMessage(log, form, user)
    actions.messages[0].message.should.deep.equal({ text: 'bar', metadata: '{"ref":"bar"}' })
  })

  it('Responds to opening text without referral', () => {
    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'bar', ref: 'bar' },
      { type: 'short_text', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'qux', ref: 'qux' }]
    }

    const log = [text]
    const actions = getMessage(log, form, user)
    actions.messages.length.should.equal(2)
    actions.messages.forEach((a, i) => a.message.text.should.equal(form.fields[i].title))
  })

  it('Keeps metadata from opening form switch', () => {
    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: '{{hidden:foo}}', ref: 'qux' }]
    }

    const log = [referral, echo, text]
    const actions = getMessage(log, form, user)
    actions.messages.length.should.equal(1)
    actions.messages[0].message.text.should.equal('bar')
  })

  it('Responds to opening sticker without referral', () => {
    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'bar', ref: 'bar' },
      { type: 'short_text', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'qux', ref: 'qux' }]
    }

    const log = [text]
    const actions = getMessage(log, form, user)
    actions.messages.length.should.equal(2)
    actions.messages.forEach((a, i) => a.message.text.should.equal(form.fields[i].title))
  })

  it('Sends multiple questions if first is statement', () => {
    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'bar', ref: 'bar' },
      { type: 'statement', title: 'baz', ref: 'baz' },
      { type: 'short_text', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'qux', ref: 'qux' }]
    }

    const log = [referral]
    const actions = getMessage(log, form, user)
    actions.messages.length.should.equal(3)
    actions.messages.forEach((a, i) => a.message.text.should.equal(form.fields[i].title))
  })

  it('Sends multiple questions if first is moveOn', () => {
    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'bar', ref: 'bar', properties: { description: 'type: webview\nurl: foo.com\nbuttonText: WTF\nkeepMoving: true' } },
      { type: 'short_text', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'qux', ref: 'qux' }]
    }

    const log = [referral]
    const actions = getMessage(log, form, user)
    actions.messages.length.should.equal(2)
    actions.messages[0].message.attachment.payload.buttons[0].url.should.equal('foo.com')
    actions.messages[1].message.text.should.equal('foo')
  })


  it('Parses a webview url properly', () => {
    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'bar', ref: 'bar', properties: { description: '{"type": "webview", url: { "base": "foo.com", "params": {"q": "hello"}}, "buttonText": "Start"}' } }]
    }

    const log = [referral]
    const actions = getMessage(log, form, user)
    actions.messages.length.should.equal(1)
    actions.messages[0].message.attachment.payload.buttons[0].url.should.equal('https://foo.com/?q=hello')
  })

/* 
  it.only('Parses a webview url properly with funkyness from typeform', () => {
    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'bar', ref: 'bar', properties: { description: '{\n \"type\": \"webview\",\n \"url\": {\n \"base\": \"[columbiangwu.co1.qualtrics.com/jfe/form/SV\\_8k7acmuWQAZjERE](https://columbiangwu.co1.qualtrics.com/jfe/form/SV_8k7acmuWQAZjERE)\",\n \"params\": {\n \"vlab\\_id\": \"{{hidden:id}}\"\n }\n },\n \"buttonText\": \"Start\",\n \"extensions\": false\n}' } }]
    }

    const log = [referral]
    const actions = getMessage(log, form, user)
    actions.messages.length.should.equal(1)

    console.log(actions.messages[0])
    actions.messages[0].message.attachment.payload.buttons[0].url.should.equal('https://https//columbiangwu.co1.qualtrics.com/jfe/form/SV_8k7acmuWQAZjERE?vlab_id=123')
  }) */



  it('Ignores responses to a statement if it is moving on to another question', () => {
    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'bar', ref: 'bar' },
      { type: 'short_text', title: 'foo', ref: 'foo' }]
    }

    const log = [referral, statementEcho, delivery, text]
    const actions = getMessage(log, form, user)
    should.not.exist(actions.messages[0])
  })

  it('Responds to 0 as a text input', () => {
    const form = {
      logic: [],
      fields: [{ type: 'number', title: 'foo', ref: 'foo' },
      { type: 'statement', title: 'bar', ref: 'bar' }]
    }

    const log = [referral, echo, delivery, { ...text, message: { text: 0 } }]
    const actions = getMessage(log, form, user)
    actions.messages[0].message.text.should.equal('bar')
  })


  it('Does not resend a statement at the end', () => {
    const echo2 = { ...statementEcho, message: { ...statementEcho.message, metadata: { ref: "foo", type: "statement" } } }

    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'bar', ref: 'bar' },
      { type: 'statement', title: 'foo', ref: 'foo' }]
    }

    const log = [referral, statementEcho, delivery, echo2]
    const actions = getMessage(log, form, user)
    should.not.exist(actions.messages[0])
  })

  it('Sends a repeat message after an answer to a statement in the end', () => {
    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'foo', ref: 'foo' },
      { type: 'thankyou_screen', title: 'baz', ref: 'baz' }]
    }

    const log = [referral, tyEcho, delivery, text]
    const actions = getMessage(log, form, user)
    JSON.parse(actions.messages[0].message.metadata).repeat.should.be.true
    JSON.parse(actions.messages[1].message.metadata).isRepeat.should.be.true
  })

  it('Responds to is_echos that come after the delivery watermark', () => {
    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'foo', ref: 'foo' },
      { type: 'thankyou_screen', title: 'baz', ref: 'baz' }]
    }


    const log = [referral, delivery, { ...echo, timestamp: delivery.delivery.watermark }, text]
    const actions = getMessage(log, form, user)
    actions.messages[0].message.text.should.equal('baz')
  })

  it('Responds to is_echos that come before the delivery watermark', () => {
    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'foo', ref: 'foo' },
      { type: 'thankyou_screen', title: 'baz', ref: 'baz' }]
    }


    const log = [referral, echo, delivery, text]
    const actions = getMessage(log, form, user)
    actions.messages[0].message.text.should.equal('baz')
  })


  it('it follows logic jumps when there are some to follow', () => {
    const logic = {
      type: 'field',
      ref: 'foo',
      actions: [{
        action: 'jump',
        details:
          { to: { type: 'field', value: 'baz' } },
        condition:
        {
          op: 'is',
          vars: [{ type: 'field', value: 'foo' },
          { type: 'constant', value: 'foo' }]
        }
      }]
    }

    const form = {
      logic: [logic],
      fields: [{ type: 'short_text', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' },
      { type: 'number', title: 'baz', ref: 'baz' }]
    }

    const log = [referral, echo, delivery, text]
    const actions = getMessage(log, form, user)
    actions.messages[0].message.should.deep.equal({ text: 'baz', metadata: '{"ref":"baz"}' })
  })

  it('it follows logic jumps from postbacks', () => {
    const logic = {
      type: 'field',
      ref: 'foo',
      actions: [{
        action: 'jump',
        details:
          { to: { type: 'field', value: 'baz' } },
        condition:
        {
          op: 'is',
          vars: [{ type: 'field', value: 'foo' },

          // TODO: make sure this is a reasonable test.
          // boolean shouldnt be possible from typeform...
          { type: 'constant', value: true }]
        }
      }]
    }

    const form = {
      logic: [logic],
      fields: [{ type: 'legal', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' },
      { type: 'number', title: 'baz', ref: 'baz' }]
    }

    const log = [referral, echo, multipleChoice]
    const actions = getMessage(log, form, user)
    actions.messages[0].message.should.deep.equal({ text: 'baz', metadata: '{"ref":"baz"}' })
  })


  it('it follows logic jumps based on event data', () => {
    const logic = {
      type: 'field',
      ref: 'bar',
      actions: [{
        action: 'jump',
        details:
          { to: { type: 'field', value: 'qux' } },
        condition:
        {
          op: 'equal',
          vars: [{ type: 'hidden', value: 'e_payment_reloadly_success' },
          { type: 'constant', value: 'true' }]
        }
      }]
    }

    const form = {
      logic: [logic],
      fields: [{ type: 'statement', title: 'foo', ref: 'foo', properties: { description: 'type: wait\nwait:\n    type: external\n    value:\n      type: payment:reloadly' } },
      { type: 'statement', title: 'bar', ref: 'bar' },
      { type: 'number', title: 'baz', ref: 'baz' },
      { type: 'number', title: 'qux', ref: 'qux' }]
    }


    const event = synthetic({ type: 'external', value: { type: 'payment:reloadly', success: true } }) // deal with bool

    const log = [referral, _echo({ ref: 'foo', type: 'wait', wait: { type: 'external', value: { type: 'payment:reloadly' } } }), event]

    const actions = getMessage(log, form, user)
    actions.messages[1].message.should.deep.equal({ text: 'qux', metadata: '{"ref":"qux"}' })
  })

  it('repeats when it misses validation', () => {

    // TODO: this is not unit test, implicitly testing validation of multiple choice.
    // fix this by injecting mock!
    const form = {
      logic: [],
      fields: [{ type: 'multiple_choice', title: 'foo', ref: 'foo', properties: { choices: [{ label: 'qux' }, { label: 'quux' }] } }]
    }

    const log = [referral, echo, delivery, text]
    const actions = getMessage(log, form, user)

    // repeat ref foo with sorry message...
    actions.messages[0].message.metadata.should.equal('{"repeat":true,"ref":"foo"}')
    actions.messages[0].message.text.should.contain('Sorry')

    actions.messages[1].message.metadata.should.equal('{"isRepeat":true,"ref":"foo"}')
  })


  it('repeats when it misses validation and tags custom types as isRepeat', () => {

    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'foo', ref: 'foo', properties: { description: '{"type": "wait"}' } }]
    }

    const log = [referral, echo, delivery, text]
    const actions = getMessage(log, form, user)

    // repeat ref foo with sorry message...
    actions.messages[0].message.metadata.should.equal('{"repeat":true,"ref":"foo"}')
    actions.messages[0].message.text.should.contain('Sorry, I can\'t accept any responses')

    actions.messages[1].message.metadata.should.equal('{"isRepeat":true,"type":"wait","ref":"foo"}')
  })

  it('uses custom_messages when they exist', () => {

    // TODO: this is not unit test, implicitly testing validation of multiple choice.
    // fix this by injecting mock!
    const form = {
      logic: [],
      custom_messages: { 'label.error.mustSelect': 'baz error' },
      fields: [{ type: 'multiple_choice', title: 'foo', ref: 'foo', properties: { choices: [{ label: 'qux' }, { label: 'quux' }] } }]
    }

    const log = [referral, echo, delivery, text]
    const actions = getMessage(log, form, user)

    // repeat ref foo with sorry message...
    actions.messages[0].message.metadata.should.equal('{"repeat":true,"ref":"foo"}')
    actions.messages[0].message.text.should.equal('baz error')
  })


  it('uses custom_messages when they exist', () => {

    // TODO: this is not unit test, implicitly testing validation of multiple choice.
    // fix this by injecting mock!
    const form = {
      logic: [],
      custom_messages: { 'label.error.mustSelect': 'baz error' },
      fields: [{ type: 'multiple_choice', title: 'foo', ref: 'foo', properties: { choices: [{ label: 'qux' }, { label: 'quux' }] } }]
    }

    const log = [referral, echo, delivery, text]
    const actions = getMessage(log, form, user)

    // repeat ref foo with sorry message...
    actions.messages[0].message.metadata.should.equal('{"repeat":true,"ref":"foo"}')
    actions.messages[0].message.text.should.equal('baz error')
  })

  it('If a wait is a statement, it does not send multiple items', () => {

    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'foo', ref: 'foo', properties: { description: 'type: wait\nwait:\n    type: timeout\n    value: 1 minute' } },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const wait = { type: 'timeout', value: '1 minute', response: 'baz' }
    const log = [referral]

    const actions = getMessage(log, form, user)
    actions.messages.length.should.equal(1)
  })

  it('repeats with custom response when responding to a wait ', () => {

    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'foo', ref: 'foo', properties: { description: 'type: wait\nresponseMessage: baz\nwait:\n    type: timeout\n    value: 1 minute' } },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const log = [referral, echo, text]

    const actions = getMessage(log, form, user)
    actions.messages.length.should.equal(2)

    // repeat ref foo with sorry message...
    actions.messages[0].message.metadata.should.equal('{"repeat":true,"ref":"foo"}')
    actions.messages[0].message.text.should.contain('baz')
    actions.messages[1].message.text.should.contain('foo')
  })

  it('repeats with default response when responding to a wait without response', () => {

    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'foo', ref: 'foo', properties: { description: 'type: wait\nwait:\n    type: timeout\n    value: 1 minute' } },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }



    const log = [referral, echo, text]

    const actions = getMessage(log, form, user)

    actions.messages.length.should.equal(2)

    // repeat ref foo with sorry message...
    actions.messages[0].message.metadata.should.equal('{"repeat":true,"ref":"foo"}')
    actions.messages[0].message.text.should.contain('Sorry, I can\'t accept any responses')
    actions.messages[1].message.text.should.contain('foo')
  })

  it('sends the messages to the token if a token is needed', () => {
    const wait = { type: 'timeout', value: '25 hours', notifyPermission: true }

    // value should be...?
    const externalEvent = {
      source: 'synthetic',
      timestamp: Date.now() + 1000 * 60 * 60 * 25,
      event: { type: 'timeout', value: Date.now() + 1000 * 60 * 60 * 25 }
    }

    const d = Date.now()

    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'foo', ref: 'foo', properties: { description: '' } },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }


    const log = [referral, optin, { ...echo, timestamp: d, message: { ...echo.message, metadata: { wait, ref: 'foo' } } }, externalEvent]

    const actions = getMessage(log, form, user)
    actions.messages.length.should.equal(1)
    actions.messages[0].recipient.one_time_notif_token.should.equal('FOOBAR')
    actions.messages[0].message.text.should.equal('bar')
  })


  it('sends the messages with an update tag if asked for', () => {

    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'bar', ref: 'bar', properties: { description: '{"sendParams": {"tag": "CONFIRMED_EVENT_UPDATE", "messaging_type": "MESSAGE_TAG"}}' } }]
    }

    const log = [referral]
    const actions = getMessage(log, form, user)
    actions.messages.length.should.equal(1)

    actions.messages[0].messaging_type.should.equal("MESSAGE_TAG")
    actions.messages[0].tag.should.equal("CONFIRMED_EVENT_UPDATE")
    actions.messages[0].recipient.id.should.equal('123')
    actions.messages[0].message.text.should.equal('bar')
  })


  it('It creates a stitch type message when provided type stitch metadata', () => {

    const form = {
      logic: [],
      fields: [{
        type: 'statement', title: 'foo', ref: 'foo', properties:
          { description: 'type: stitch\nstitch:\n    form: BAR' }
      }]
    }

    const log = [referral]
    const actions = getMessage(log, form, user)
    JSON.parse(actions.messages[0].message.metadata)['type'].should.equal('stitch')
    JSON.parse(actions.messages[0].message.metadata)['stitch']['form'].should.equal('BAR')
  })



  it('It recieves payload referrals and starts chatting', () => {

    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'foo', ref: 'foo' }]
    }

    const log = [payloadReferral]
    const actions = getMessage(log, form, user)

    actions.messages[0].message.text.should.equal('foo')
  })


  it('moves onward when validation succeeds', () => {
    const form = {
      logic: [],
      fields: [{ type: 'multiple_choice', title: 'foo', ref: 'foo', properties: { choices: [{ label: 'foo' }, { label: 'quux' }] } },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const log = [referral, echo, delivery, text]

    const actions = getMessage(log, form, user)
    actions.messages[0].message.should.deep.equal({ text: 'bar', metadata: '{"ref":"bar"}' })
  })


  it('ignores referral sent when responding', () => {
    const form = {
      logic: [],
      fields: [{ type: 'multiple_choice', title: 'foo', ref: 'foo', properties: { choices: [{ label: 'foo' }, { label: 'quux' }] } },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    should.not.exist(getMessage([referral, referral], form, user).messages[0])
    should.not.exist(getMessage([referral, delivery, echo, text, referral], form, user).messages[0])
  })


  it('ignores referral sent when waiting', () => {
    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'foo', ref: 'foo', properties: { description: 'type: wait\nwait:\n    type: timeout\n    value: 1 minute' } },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const wait = { type: 'timeout', value: '1 minute' }
    const log = [referral, { ...echo, message: { ...echo.message, metadata: { wait, ref: 'foo' } } }, referral]
    const actions = getMessage(log, form, user)
    should.not.exist(actions.messages[0])
  })


  it('repeats questions on a repeat referral if unanswered question', () => {
    const form = {
      logic: [],
      fields: [{ type: 'multiple_choice', title: 'foo', ref: 'foo', properties: { choices: [{ label: 'foo' }, { label: 'quux' }] } },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const actions = getMessage([referral, delivery, echo, referral], form, user)
    JSON.parse(actions.messages[0].message.metadata).repeat.should.be.true
    actions.messages[1].message.text.should.equal('foo')
  })

  it('ignores referrals when the person is the referrer ', () => {

    const secondRef = {
      ...referral, referral: {
        ...referral.referral,
        ref: `form.BAR.referrer.${USER_ID}`
      }
    }
    should.not.exist(getMessage([referral, echo, secondRef], form)[0])
  })

  it('ignores reactions', () => {
    should.not.exist(getMessage([referral, delivery, echo, reaction], form)[0])
  })

  it('ignores multiple responses to a single question', () => {
    const form = {
      logic: [],
      fields: [{ type: 'multiple_choice', title: 'foo', ref: 'foo', properties: { choices: [{ label: 'foo' }, { label: 'quux' }] } },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }
    const log = [referral, delivery, echo, qr, qr]
    const actions = getMessage(log, form, user)
    should.not.exist(actions.messages[0])
  })


  it('Validates a quick reply when valid', () => {
    const form = {
      logic: [],
      fields: [{ type: 'multiple_choice', title: 'foo', ref: 'foo', properties: { choices: [{ label: 'foo' }, { label: 'quux' }] } },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const response = { ...qr, message: { quick_reply: { payload: { value: "quux", ref: "foo" } } } }
    const log = [referral, echo, delivery, response]
    const actions = getMessage(log, form, user)
    actions.messages[0].message.text.should.equal('bar')
  })

  it('Validates a quick reply with 0 value', () => {
    const form = {
      logic: [],
      fields: [{ type: 'multiple_choice', title: 'foo', ref: 'foo', properties: { choices: [{ label: '0' }, { label: '1' }] } },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const response = { ...qr, message: { quick_reply: { payload: { value: 0, ref: "foo" } } } }
    const log = [referral, echo, delivery, response]
    const actions = getMessage(log, form, user)
    actions.messages[0].message.text.should.equal('bar')
  })

  it('Validates a quick reply when payload is string (as in email)', () => {
    const form = {
      logic: [],
      fields: [{ type: 'email', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const response = { ...qr, message: { quick_reply: { payload: "foo@gmail.com" } } }
    const log = [referral, echo, delivery, response]
    const actions = getMessage(log, form, user)
    actions.messages[0].message.text.should.equal('bar')
  })

  it('Invalidates an attachment as a respones to a quick reply', () => {
    const form = {
      logic: [],
      fields: [{ type: 'email', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const response = { ...qr, message: { "mid": "m_xrl3G6Dt409ZEYrWWxfAEarfHyV7iKF62Oi5m6M4iPT8ncaQlpcbTZfyaM8MPmYp8VCBHfPYiQY5WrQ4xX-2QQ", "attachments": [{ "type": "image", "payload": { "url": "https://scontent.xx.fbcdn.net/v/t1.15752-9/461148037_759263159639423_7161323123727879546_n.jpg?_nc_cat=102&ccb=1-7&_nc_sid=fc17b8&_nc_ohc=zkDCMxo0pTsQ7kNvgGA_H8d&_nc_ad=z-m&_nc_cid=0&_nc_ht=scontent.xx&_nc_gid=AEZgev0WN3sV8E56pu3IELa&oh=03_Q7cD1QHpWUMM_ryYpocqe5jG_MF5bg12hw79eHeTmvbg8jVNHg&oe=67222F34" } }] } }

    const log = [referral, echo, delivery, response]
    const actions = getMessage(log, form, user)
    actions.messages[0].message.text.should.equal('Sorry, please enter a valid email address.')
  })


  it('Invalidates a quick reply when invalid', () => {
    const del1 = { ...delivery, delivery: { watermark: 5 } }

    const form = {
      logic: [],
      fields: [{ type: 'multiple_choice', title: 'foo', ref: 'foo', properties: { choices: [{ label: 'foo' }, { label: 'quux' }] } },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const response = { ...qr, message: { quick_reply: { payload: { value: "qux", ref: "foo" } } } }

    const log = [referral, del1, echo, delivery, response]

    const actions = getMessage(log, form, user)
    JSON.parse(actions.messages[0].message.metadata).repeat.should.be.true
  })


  it('Validates an optin when it is a response to a notify request', () => {
    const form = {
      logic: [],
      fields: [{
        type: 'statement', title: 'foo', ref: 'foo', properties:
          { description: 'type: notify' }
      },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }


    const log = [referral, echo, optin]

    const actions = getMessage(log, form, user)
    actions.messages[0].message.text.should.equal('bar')
  })

  it('Invalidates an optin when it comes from nowhere', () => {

    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'bar', ref: 'bar' }]
    }


    const log = [referral, _echo('bar'), optin]

    const actions = getMessage(log, form, user)
    JSON.parse(actions.messages[0].message.metadata).repeat.should.be.true
  })


  it('Resends a message with a follow_up event', () => {
    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'foo', ref: 'foo' }]
    }

    const fu = synthetic({ type: 'follow_up', value: 'foo' })
    const log = [referral, echo, fu]

    const actions = getMessage(log, form, user)
    actions.messages.length.should.equal(2)
    actions.messages[0].message.text.should.equal(followUpMessage({}))
    actions.messages[1].message.text.should.equal('foo')
  })


  it('ignores a follow_up event if not in QOUT state', () => {
    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'foo', ref: 'foo' }]
    }

    const fu = synthetic({ type: 'follow_up', value: 'foo' })
    const log = [referral, echo, text, fu]

    const actions = getMessage(log, form, user)
    actions.messages.length.should.equal(0)
  })


  it('ignores a follow_up event for a different question', () => {
    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const fu = synthetic({ type: 'follow_up', value: 'foo' })
    const log = [referral, _echo('foo'), text, _echo('bar'), fu]

    const actions = getMessage(log, form, user)
    actions.messages.length.should.equal(0)
  })

  it('Resends a waiting message with a redo event', () => {
    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const log = [referral, synthetic({ type: 'redo' })]
    const actions = getMessage(log, form, user)
    actions.messages[0].message.text.should.equal('foo')
    actions.messages[1].message.text.should.equal('bar')

    const state = getState(log)
    state.retries.should.eql([20])
  })

  it('Resends a waiting message with a redo event when blocked and keeps retry and qa', () => {
    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const report = synthetic({ type: 'machine_report', value: { error: { tag: 'FB', code: 200, message: 'foo' } } })

    const log = [referral, echo, text, report, synthetic({ type: 'redo' })]

    const actions = getMessage(log, form, user)
    actions.messages[0].message.text.should.equal('bar')

    const state = getState(log)
    state.retries.should.eql([20])
    state.qa.should.eql([['foo', 'foo']])
  })


  it('Adds the URL given an attachment as responseValue', () => {
    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'foo', ref: 'foo', properties: { description: JSON.stringify({ type: 'upload', upload: { 'type': 'image' } }) } },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const response = { ...qr, message: { "mid": "m_xrl3G6Dt409ZEYrWWxfAEarfHyV7iKF62Oi5m6M4iPT8ncaQlpcbTZfyaM8MPmYp8VCBHfPYiQY5WrQ4xX-2QQ", "attachments": [{ "type": "image", "payload": { "url": "https://scontent.xx.fbcdn.net/v/t1.15752-9/461148037_759263159639423_7161323123727879546_n.jpg?_nc_cat=102&ccb=1-7&_nc_sid=fc17b8&_nc_ohc=zkDCMxo0pTsQ7kNvgGA_H8d&_nc_ad=z-m&_nc_cid=0&_nc_ht=scontent.xx&_nc_gid=AEZgev0WN3sV8E56pu3IELa&oh=03_Q7cD1QHpWUMM_ryYpocqe5jG_MF5bg12hw79eHeTmvbg8jVNHg&oe=67222F34" } }] } }

    const log = [referral, echo, delivery, response]
    const actions = getMessage(log, form, user)
    actions.messages[0].message.text.should.equal('bar')

    const state = getState(log)
    state.qa.should.eql([["foo", "https://scontent.xx.fbcdn.net/v/t1.15752-9/461148037_759263159639423_7161323123727879546_n.jpg?_nc_cat=102&ccb=1-7&_nc_sid=fc17b8&_nc_ohc=zkDCMxo0pTsQ7kNvgGA_H8d&_nc_ad=z-m&_nc_cid=0&_nc_ht=scontent.xx&_nc_gid=AEZgev0WN3sV8E56pu3IELa&oh=03_Q7cD1QHpWUMM_ryYpocqe5jG_MF5bg12hw79eHeTmvbg8jVNHg&oe=67222F34"]])
  })



  it('Wipes the retries history when a message is finally sent', () => {
    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'foo', ref: 'foo' },
      { type: 'thankyou_screen', title: 'baz', ref: 'baz' }]
    }

    const now = Date.now() - 60000 * 60

    const log = [referral,
      synthetic({ type: 'redo' }, { timestamp: now }),
      synthetic({ type: 'redo' }, { timestamp: now + 60000 }),
      synthetic({ type: 'redo' }, { timestamp: now + 60000 * 10 }),
      synthetic({ type: 'redo' }, { timestamp: now + 60000 * 45 }),
      synthetic({ type: 'redo' }, { timestamp: now + 60000 * 60 }),
      echo,
      text
    ]

    const actions = getMessage(log, form, user)
    actions.messages.length.should.equal(1)

    const state = getState(log)
    should.not.exist(state.retries)
  })


  // NOTE: this isn't great from UX standpoint, but splitting up batch messages is
  // hard and rare edge case really...
  it('Resends all messages if some of a batch didnt get sent, when given a redo event', () => {
    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const log = [referral, statementEcho, synthetic({ type: 'redo' })]

    const actions = getMessage(log, form, user)
    actions.messages[0].message.text.should.equal('foo')
    actions.messages[1].message.text.should.equal('bar')
  })


  it('Redo event resends the same token if redo sent after wait time', () => {
    const wait = { type: 'timeout', value: '25 hours', notifyPermission: true }

    //   // value should be...?
    const externalEvent = {
      source: 'synthetic',
      timestamp: Date.now() + 1000 * 60 * 60 * 25,
      event: { type: 'timeout', value: Date.now() + 1000 * 60 * 60 * 25 }
    }

    const d = Date.now()

    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'foo', ref: 'foo', properties: { description: 'type: wait\nwait:\n    type: timeout\n    value: 25 hours' } },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const log = [referral, optin, _echo({ wait, ref: 'foo' }), externalEvent, synthetic({ type: 'redo' })]

    const actions = getMessage(log, form, user)

    actions.messages.length.should.equal(1)
    actions.messages[0].recipient.one_time_notif_token.should.equal('FOOBAR')
    actions.messages[0].message.text.should.equal('bar')
  })


  it('repeats again when redo sent on missed validation', () => {

    const form = {
      logic: [],
      fields: [{ type: 'multiple_choice', title: 'foo', ref: 'foo', properties: { choices: [{ label: 'qux' }, { label: 'quux' }] } }]
    }

    const log = [referral, echo, text, synthetic({ type: 'redo' })]
    const actions = getMessage(log, form, user)

    actions.messages[0].message.metadata.should.equal('{"repeat":true,"ref":"foo"}')
    actions.messages[0].message.text.should.contain('Sorry')
  })


  it('It switches forms again if redo sent after form switch', () => {
    const metadata = { "type": "stitch", "stitch": { "form": "BAR" }, "ref": "foo" }
    const log = [referral, _echo(metadata), synthetic({ type: 'redo' })]

    const state = getState(log)
    state.state.should.equal('RESPONDING')
    state.forms[1].should.equal('BAR')
    state.md.form.should.equal('FOO')
  })


  it('It re-creates stitch type message when redo comes after stitch', () => {
    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const metadata = { "type": "stitch", "stitch": { "form": "BAR" }, "ref": "foo" }
    const log = [referral, _echo(metadata), synthetic({ type: 'redo' })]

    const actions = getMessage(log, form, user)
    actions.messages.length.should.equal(2)
    actions.messages[0].message.text.should.equal('foo')
    actions.messages[1].message.text.should.equal('bar')
  })


  it('It redoes when blocked as reported in platform response and gets redo event', () => {
    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const pr = _.set(syntheticPR, 'event.value.response', { error: { code: 2022 } })
    const log = [referral, echo, pr, synthetic({ type: 'redo' })]

    const actions = getMessage(log, form, user)
    actions.messages.length.should.equal(2)
    actions.messages[0].message.text.should.equal('foo')
    actions.messages[1].message.text.should.equal('bar')
  })


  // NOTE: is this a good thing? Implies that we consider everything
  // after "echo" from Facebook a 100% sure thing... which it surely isn't...
  // but, we should do fine if user responds...
  it('ignores a redo event if the echo was recieved from facebook', () => {
    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const echoBar = _.set(echo, 'message.metadata.ref', 'bar')

    const log = [referral, statementEcho, echoBar, synthetic({ type: 'redo' })]
    const actions = getMessage(log, form, user)

    should.not.exist(actions.messages[0])
  })

  // TODO: it would be good to add a reset message...
  it('Sends no reset message on reset form', () => {
    const form = {}

    const resetReferral = { ...referral, referral: { ...referral.referral, ref: 'form.reset' } }

    const log = [referral, echo, text, resetReferral]

    const actions = getMessage(log, form, user)

    actions.messages.should.eql([])
  })



  it('Sends a payment event when payment in the description', () => {
    const form = {
      logic: [],
      fields: [
        { type: 'short_text', title: 'bar', ref: 'bar' },

        { type: 'statement', title: 'foo', ref: 'foo', properties: { description: JSON.stringify({ payment: { type: 'reloadly', details: { foo: 'bar' } } }) } },
      ]
    }

    const log = [referral, _echo('bar'), text]
    const actions = getMessage(log, form, user, { id: 'bar' })

    actions.messages.length.should.equal(1)
    const md = JSON.parse(actions.messages[0].message.metadata)

    // NOTE: do we still need the payment in the metadata? Doesn't hurt...
    md.should.eql({ ref: 'foo', type: 'statement', payment: { type: 'reloadly', details: { foo: 'bar' } } })
    actions.messages[0].message.text.should.equal('foo')

    actions.payment.details.should.eql({ foo: 'bar' })
    actions.payment.userid.should.eql(user.id)

    const state = getState(log)
    state.state.should.equal('RESPONDING')
    state.question.should.equal('bar')
  })

  it('Resends a payment event on repeat_payment synthetic event, without sending message', () => {
    const form = {
      logic: [],
      fields: [
        { type: 'statement', title: 'foo', ref: 'foo', properties: { description: JSON.stringify({ payment: { type: 'reloadly', details: { foo: 'bar' } } }) } },
        { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const log = [referral, _echo('foo'), synthetic({ type: 'repeat_payment', value: { question: "foo" } })]

    const actions = getMessage(log, form, user, { id: 'bar' })

    should.not.exist(actions.messages[0])

    actions.payment.details.should.eql({ foo: 'bar' })
    actions.payment.userid.should.eql(user.id)

    const state = getState(log)

    // keeps the same state question p
    state.state.should.equal('QOUT')
    state.question.should.equal('foo')
  })

  it('sends the off message if the form has an off_time that is past', () => {

    const now = Date.now()
    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'bar', ref: 'bar' }],
      offTime: now - 1000 * 60,
    }

    const log = [referral, _echo('bar'), { ...text, timestamp: now }]

    const actions = getMessage(log, form, user, { id: 'bar' })

    actions.messages[0].message.text.should.equal("We're sorry, but this survey is now over and closed.")

    const state = getState(log)
    state.state.should.equal('RESPONDING')
    state.question.should.equal('bar')
  });

  it('does not send an off message if the form has an off_time that is not past', () => {
    const now = Date.now()
    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'bar', ref: 'bar' }, { type: 'short_text', title: 'foo', ref: 'foo' }],
      offTime: now + 1000 * 60,
    }

    const log = [referral, _echo('bar'), { ...text, timestamp: now }]

    const actions = getMessage(log, form, user, { id: 'bar' })

    actions.messages[0].message.text.should.equal("foo")

    const state = getState(log)
    state.state.should.equal('RESPONDING')
  });

  it('sends off messages when off before referral', () => {
    const now = Date.now()
    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'bar', ref: 'bar' }],
      offTime: now - 1000 * 60,
    }    

    const log = [{...referral, timestamp: now}]

    const actions = getMessage(log, form, user, { id: 'bar' })

    actions.messages[0].message.text.should.equal("We're sorry, but this survey is now over and closed.")      
    JSON.parse(actions.messages[0].message.metadata).ref.should.equal('bar')
    const state = getState(log)
    state.state.should.equal('RESPONDING')    
  });

  it('sends multiple off messages if a person keeps writing', () => {
    const now = Date.now()
    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'bar', ref: 'bar' }],
      offTime: now - 1000 * 60,
    }    

    const log = [{...referral, timestamp: now}, _echo('bar'), { ...text, timestamp: now }]

    const actions = getMessage(log, form, user, { id: 'bar' })
    actions.messages[0].message.text.should.equal("We're sorry, but this survey is now over and closed.")
    
    const state = getState(log)
    state.state.should.equal('RESPONDING')    
  });

  it('allows off users to start a new survey', () => {

    const now = Date.now()
    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'bar', ref: 'bar' }],
      offTime: now + 1000 * 60,
    }

    const newReferral = { ...referral, referral: { ...referral.referral, ref: 'form.BAR' } }

    const log = [referral, _echo('bar'), { ...text, timestamp: now }, newReferral]

    const actions = getMessage(log, form, user, { id: 'bar' })

    actions.messages[0].message.text.should.equal("bar")
    const state = getState(log)
    state.state.should.equal('RESPONDING')
    state.md.form.should.equal('BAR')
  });

  it('should extract payment from first message after referral with empty qa array', () => {
    // This test replicates the scenario where a payment is not extracted from the first message after a referral
    const form = {
      logic: [],
      fields: [
        { 
          type: 'statement', 
          title: 'We are generating your gift card now. Please wait, this should take several minutes but could take up to 48 hours if your account is flagged as potentially fraudulent (outside of the US, etc.)', 
          ref: 'generating_gift_card', 
          properties: { 
            description: JSON.stringify({ 
              type: 'wait',
              responseMessage: 'Sorry, please wait a bit longer, we\'re working on it.',
              wait: {
                type: 'external',
                value: {
                  type: 'payment:http',
                  id: 'giftcard_2'
                }
              },
              payment: {
                provider: 'http',
                details: {
                  id: 'giftcard_2',
                  method: 'POST',
                  url: 'https://www.tremendous.com/api/v2/orders',
                  headers: {
                    'Authorization': 'Bearer << TREMENDOUS_PGP >>',
                    'Content-Type': 'application/json'
                  },
                  body: {
                    external_id: '1989430067808669_endline_minn_gen_pop',
                    payment: {
                      funding_source_id: 'FCHEGSW5S3LL'
                    },
                    rewards: [{
                      value: {
                        denomination: 5,
                        currency_code: 'USD'
                      },
                      delivery: {
                        method: 'LINK'
                      },
                      recipient: {
                        name: 'Study Participant'
                      },
                      products: ['OKMHM2X2OHYV']
                    }]
                  },
                  errorMessage: 'errors.message',
                  responsePath: 'order.rewards.0.delivery.link|@tostr'
                }
              },
              ref: 'generating_gift_card'
            }) 
          } 
        }
      ]
    }

    // Simulate the first message after a referral with empty qa array
    const initialState = _initialState()
    initialState.forms = ['pgpminnen2pay']
    initialState.md = {
      form: 'pgpminnen2pay',
      startTime: 1753250108000,
      pageid: '1855355231229529',
      seed: 2765619441
    }

    // Create a RESPOND output that would be generated for the first field
    const output = {
      action: 'RESPOND',
      question: 'generating_gift_card',
      stateUpdate: {},
      md: {}
    }

    const ctx = {
      form,
      user: { id: '1989430067808669' },
      page: { id: '1855355231229529' },
      timestamp: 1753250108000
    }

    // Test the act function directly with empty qa array
    const actions = act(ctx, initialState, output)

    // The payment should be extracted
    actions.payment.should.exist
    actions.payment.provider.should.equal('http')
    actions.payment.userid.should.equal('1989430067808669')
    actions.payment.pageid.should.equal('1855355231229529')
    actions.payment.details.id.should.equal('giftcard_2')
  })
})

describe('Handoff functionality', () => {
  let user = { id: '1989430067808669' }

  it('should extract handoff from message metadata and create handoff action', () => {
    const form = {
      logic: [],
      fields: [
        { type: 'short_text', title: 'bar', ref: 'bar' },
        { 
          type: 'statement', 
          title: 'foo', 
          ref: 'foo', 
          properties: { 
            description: JSON.stringify({ 
              handoff: { 
                target_app_id: '123456789', 
                metadata: { reason: 'customer_support' } 
              } 
            }) 
          } 
        }
      ]
    }

    const log = [referral, _echo('bar'), text]
    const actions = getMessage(log, form, user, { id: '1855355231229529' })

    actions.messages.length.should.equal(1)
    const md = JSON.parse(actions.messages[0].message.metadata)
    md.handoff.should.deep.equal({ target_app_id: '123456789', metadata: { reason: 'customer_support' } })

    // The handoff should be extracted
    actions.handoff.should.exist
    actions.handoff.target_app_id.should.equal('123456789')
    actions.handoff.metadata.should.deep.equal({ reason: 'customer_support' })
    actions.handoff.userid.should.equal('1989430067808669')
    actions.handoff.pageid.should.equal('1855355231229529')
    actions.handoff.timestamp.should.equal(text.timestamp)
  })

  it('should handle handoff with minimal metadata', () => {
    const form = {
      logic: [],
      fields: [
        { 
          type: 'statement', 
          title: 'foo', 
          ref: 'foo', 
          properties: { 
            description: JSON.stringify({ 
              handoff: { 
                target_app_id: '987654321'
              } 
            }) 
          } 
        }
      ]
    }

    const log = [referral, _echo('foo'), text]
    const actions = getMessage(log, form, user, { id: '1855355231229529' })

    actions.handoff.should.exist
    actions.handoff.target_app_id.should.equal('987654321')
    actions.handoff.userid.should.equal('1989430067808669')
    actions.handoff.pageid.should.equal('1855355231229529')
    actions.handoff.timestamp.should.equal(text.timestamp)
  })

  it('should not create handoff when no handoff metadata exists', () => {
    const form = {
      logic: [],
      fields: [
        { type: 'statement', title: 'foo', ref: 'foo' }
      ]
    }

    const log = [referral, _echo('foo')]
    const actions = getMessage(log, form, user, { id: '1855355231229529' })

    should.not.exist(actions.handoff)
  })
})

describe('Thread passback functionality', () => {
  let user = { id: '1989430067808669' }
  
  before(() => {
    process.env.FACEBOOK_APP_ID = '123456789'
  })

  it('should handle handover event and fulfill wait condition', () => {
    const wait = { 
      op: 'or',
      vars: [
        { type: 'handover', value: { target_app_id: '123456789' } },
        { type: 'timeout', value: '60m' }
      ]
    }
    const form = {
      logic: [],
      fields: [
        { 
          type: 'statement', 
          title: 'foo', 
          ref: 'foo', 
          properties: { 
            description: JSON.stringify({ wait }) 
          } 
        },
        { type: 'short_text', title: 'bar', ref: 'bar' }
      ]
    }

    // Create a handover event (thread passback)
    const handoverEvent = {
      source: 'messenger',
      timestamp: Date.now(),
      recipient: { id: '1855355231229529' },
      sender: { id: '1989430067808669' },
      pass_thread_control: {
        new_owner_app_id: '123456789',
        previous_owner_app_id: '987654321',
        metadata: '{"reason":"customer_support"}'
      }
    }

    const log = [referral, _echo({ ref: 'foo', type: 'wait', wait }), handoverEvent]
    const actions = getMessage(log, form, user)

    // Should proceed to next question after handover
    actions.messages[0].message.should.deep.equal({ text: 'bar', metadata: '{"ref":"bar"}' })
  })

  it('should handle handover event with metadata', () => {
    const wait = { 
      op: 'or',
      vars: [
        { type: 'handover', value: { target_app_id: '123456789' } },
        { type: 'timeout', value: '60m' }
      ]
    }
    const form = {
      logic: [],
      fields: [ 
        { 
          type: 'statement', 
          title: 'foo', 
          ref: 'foo', 
          properties: { 
            description: JSON.stringify({ wait }) 
          } 
        },
        { type: 'short_text', title: 'bar', ref: 'bar' }
      ]
    }

    // Create a handover event with metadata
    const handoverEvent = {
      source: 'messenger',
      timestamp: Date.now(),
      recipient: { id: '1855355231229529' },
      sender: { id: '1989430067808669' },
      pass_thread_control: {
        new_owner_app_id: '123456789',
        previous_owner_app_id: '987654321',
        metadata: '{"reason":"escalation","priority":"high"}'
      }
    }

    const waitCondition = { 
      op: 'or', 
      vars: [
        { type: 'handover', value: { target_app_id: '123456789' } }, 
        { type: 'timeout', value: '60m' }
      ] 
    }
    const log = [referral, _echo({ ref: 'foo', type: 'wait', wait: waitCondition }), handoverEvent]
    const actions = getMessage(log, form, user)

    // Should proceed to next question after handover
    actions.messages[0].message.should.deep.equal({ text: 'bar', metadata: '{"ref":"bar"}' })
  })

  it('should not fulfill wait condition for wrong app ID', () => {
    const wait = { 
      op: 'or',
      vars: [
        { type: 'handover', value: { target_app_id: '123456789' } },
        { type: 'timeout', value: '60m' }
      ]
    }
    const form = {
      logic: [],
      fields: [
        { 
          type: 'statement', 
          title: 'foo', 
          ref: 'foo', 
          properties: { 
            description: JSON.stringify({ wait }) 
          } 
        },
        { type: 'short_text', title: 'bar', ref: 'bar' }
      ]
    }

    // Create a handover event with wrong app ID
    const handoverEvent = {
      source: 'messenger',
      timestamp: Date.now(),
      recipient: { id: '1855355231229529' },
      sender: { id: '1989430067808669' },
      pass_thread_control: {
        new_owner_app_id: '999999999', // Wrong app ID
        previous_owner_app_id: '987654321',
        metadata: '{"reason":"customer_support"}'
      }
    }

    const waitCondition = { 
      op: 'or', 
      vars: [
        { type: 'handover', value: { target_app_id: '123456789' } }, 
        { type: 'timeout', value: '60m' }
      ] 
    }
    const log = [referral, _echo({ ref: 'foo', type: 'wait', wait: waitCondition }), handoverEvent]
    const actions = getMessage(log, form, user)

    // Should not proceed - still waiting
    should.not.exist(actions.messages[0])
  })
})
