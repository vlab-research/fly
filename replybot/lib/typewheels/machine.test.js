const mocha = require('mocha')
const chai = require('chai')
const should = chai.should()
const fs = require('fs')
const _ = require('lodash')
const { parseLogJSON } = require('./utils')
const { followUpMessage, offMessage } = require('../generic-validator')
const { _initialState, getMessage, exec, act, apply, getState, getCurrentForm, getWatermark, makeEventMetadata, categorizeEvent } = require('./machine')
const form = JSON.parse(fs.readFileSync('mocks/sample.json'))
const { echo, tyEcho, statementEcho, repeatEcho, delivery, read, qr, text, sticker, multipleChoice, referral, USER_ID, PAGE_ID, reaction, syntheticBail, syntheticPR, optin, payloadReferral, syntheticRedo, synthetic, handover, whatsappReferral, WA_USER_ID, WA_PHONE_NUMBER_ID } = require('./events.test')
const { parseEvent } = require('../event-normalizer')

const _echo = md => ({ ...echo, payload: { ...echo.payload, metadata: md.ref ? md : { ref: md } } })


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
    const event = { source: { type: 'synthetic' }, event_type: 'synthetic_external', payload: { type: 'linksniffer:click', url: 'foobar' } }
    const md = makeEventMetadata(event)
    md.should.eql({ e_linksniffer_click_url: 'foobar' })
  })

  it('should get multiple key/value pairs if they exist', () => {
    const event = { source: { type: 'synthetic' }, event_type: 'synthetic_external', payload: { type: 'random', id: 'foo', foo: 'bar' } }
    const md = makeEventMetadata(event)
    md.should.eql({ e_random_id: 'foo', e_random_foo: 'bar' })
  })

  it('should unnest kv pairs if they exist', () => {
    const event = { source: { type: 'synthetic' }, event_type: 'synthetic_external', payload: { type: 'payment:reloadly', success: false, error: { message: 'foobar', code: 'BAR', doublenest: { foo: 'baz' } } } }

    const md = makeEventMetadata(event)
    md.should.eql({
      e_payment_reloadly_success: false,
      e_payment_reloadly_error_message: 'foobar',
      e_payment_reloadly_error_doublenest_foo: 'baz',
      e_payment_reloadly_error_code: 'BAR'
    })
  })

  it('should work with array values and key them out by index', () => {
    const event = { source: { type: 'synthetic' }, event_type: 'synthetic_external', payload: { type: 'random', list: ['foo', 'bar'] } }

    const md = makeEventMetadata(event)
    md.should.eql({
      e_random_list_0: 'foo',
      e_random_list_1: 'bar'
    })
  })

  it('should work with number values', () => {
    const event = { source: { type: 'synthetic' }, event_type: 'synthetic_external', payload: { type: 'random', foo: 1234 } }
    const md = makeEventMetadata(event)
    md.should.eql({ e_random_foo: 1234 })
  })

  it('should work with boolean values', () => {
    const event = { source: { type: 'synthetic' }, event_type: 'synthetic_external', payload: { type: 'random', foo: false } }
    const md = makeEventMetadata(event)
    md.should.eql({ e_random_foo: false })
  })

  it('should set null but not undefined values', () => {
    const event = { source: { type: 'synthetic' }, event_type: 'synthetic_external', payload: { type: 'random', foo: undefined, bar: null } }
    const md = makeEventMetadata(event)
    md.should.eql({ e_random_bar: null })
  })

  it('should return undefined if an event not properly formatted', () => {
    const event = { source: { type: 'synthetic' }, event_type: 'synthetic_external', payload: {} }
    const md = makeEventMetadata(event)
    should.not.exist(md)
  })

  it('should convert camelCase keys to snake_case', () => {
    const event = {
      source: { type: 'synthetic' },
      event_type: 'synthetic_external',
      payload: {
        type: 'payment:status',
        userId: '123',
        paymentMethod: 'card',
        transactionId: 'tx_456'
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
      source: { type: 'synthetic' },
      event_type: 'synthetic_external',
      payload: {
        type: 'api:response',
        errorDetails: {
          errorCode: 'INVALID_REQUEST',
          errorMessage: 'Bad input'
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
      source: { type: 'synthetic' },
      event_type: 'synthetic_external',
      payload: {
        type: 'existing:event',
        user_id: '123',
        already_snake: 'value'
      }
    }
    const md = makeEventMetadata(event)
    md.should.eql({
      e_existing_event_user_id: '123',
      e_existing_event_already_snake: 'value'
    })
  })

  it('should flatten handover metadata under e_handover_metadata_* (production key contract)', () => {
    // The normalizer passes pass_thread_control.metadata through as the raw JSON
    // string from the webhook. Flattened keys must keep the e_handover_metadata_*
    // shape that main's production pipeline produced and live surveys reference.
    const event = {
      event_type: 'handover',
      payload: {
        type: 'handover',
        previous_owner_app_id: '976665718578167',
        new_owner_app_id: '123456789',
        metadata: '{"smoke_echo":"ok","echo_text":"hello"}'
      }
    }
    const md = makeEventMetadata(event)
    md.should.eql({
      e_handover_target_app_id: '976665718578167',
      e_handover_metadata_smoke_echo: 'ok',
      e_handover_metadata_echo_text: 'hello'
    })
  })

  it('should flatten nested and array handover metadata under e_handover_metadata_', () => {
    const event = {
      event_type: 'handover',
      payload: {
        type: 'handover',
        previous_owner_app_id: '976665718578167',
        metadata: '{"assessment_results":{"reading_level":6},"recommendations":["a","b"]}'
      }
    }
    const md = makeEventMetadata(event)
    md.should.eql({
      e_handover_target_app_id: '976665718578167',
      e_handover_metadata_assessment_results_reading_level: 6,
      e_handover_metadata_recommendations_0: 'a',
      e_handover_metadata_recommendations_1: 'b'
    })
  })

  it('should store plain-string handover metadata as e_handover_metadata', () => {
    const event = {
      event_type: 'handover',
      payload: {
        type: 'handover',
        previous_owner_app_id: '976665718578167',
        metadata: 'End of handoff'
      }
    }
    const md = makeEventMetadata(event)
    md.should.eql({
      e_handover_target_app_id: '976665718578167',
      e_handover_metadata: 'End of handoff'
    })
  })

  it('should only set target_app_id when handover has no metadata', () => {
    const event = {
      event_type: 'handover',
      payload: {
        type: 'handover',
        previous_owner_app_id: '976665718578167'
      }
    }
    const md = makeEventMetadata(event)
    md.should.eql({ e_handover_target_app_id: '976665718578167' })
  })

  it('should convert camelCase keys in handover metadata to snake_case', () => {
    const event = {
      event_type: 'handover',
      payload: {
        type: 'handover',
        previous_owner_app_id: '976665718578167',
        metadata: JSON.stringify({ echoText: 'hi' })
      }
    }
    const md = makeEventMetadata(event)
    md.should.eql({
      e_handover_target_app_id: '976665718578167',
      e_handover_metadata_echo_text: 'hi'
    })
  })

  it('should drop a key literally named "type" at every nesting level of handover metadata', () => {
    // _eventMetadata filters out `type` keys before recursing/flattening, so a
    // `type` key anywhere in the returned metadata tree (top-level or nested)
    // must never surface as e_handover_metadata_type / e_handover_metadata_*_type.
    const event = {
      event_type: 'handover',
      payload: {
        type: 'handover',
        previous_owner_app_id: '976665718578167',
        metadata: JSON.stringify({
          type: 'top_level_should_be_dropped',
          echo_text: 'hello',
          nested: { type: 'nested_should_be_dropped', value: 'ok' }
        })
      }
    }
    const md = makeEventMetadata(event)
    md.should.eql({
      e_handover_target_app_id: '976665718578167',
      e_handover_metadata_echo_text: 'hello',
      e_handover_metadata_nested_value: 'ok'
    })
  })

  // REGRESSION PIN for 826f37fb: production once flattened returned handover
  // metadata one level too shallow (e_handover_echo_text instead of
  // e_handover_metadata_echo_text), silently breaking every survey's
  // {{hidden:e_handover_metadata_*}} references. Keep this assertion explicit
  // and never "simplify" it back to the shallower shape.
  it('REGRESSION (826f37fb): flattens returned handover metadata under e_handover_metadata_*, not e_handover_*', () => {
    const previousOwnerAppId = '976665718578167'
    const event = {
      event_type: 'handover',
      payload: {
        type: 'handover',
        previous_owner_app_id: previousOwnerAppId,
        metadata: JSON.stringify({ echo_text: 'hello', smoke_echo: 'ok' })
      }
    }
    const md = makeEventMetadata(event)

    md.e_handover_metadata_echo_text.should.equal('hello')
    md.e_handover_metadata_smoke_echo.should.equal('ok')
    md.e_handover_target_app_id.should.equal(previousOwnerAppId)

    // Explicitly assert the bug does NOT reproduce: no shallower e_handover_*
    // keys for the metadata fields (only the unrelated target_app_id key is
    // expected directly under e_handover_).
    should.not.exist(md.e_handover_echo_text)
    should.not.exist(md.e_handover_smoke_echo)
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
    const qrReferral = {
      ...qr,
      event_type: 'conversation_started',
      payload: { type: 'conversation_started', trigger: 'referral', referral: { ref: "form.FOO.foo.bar" } }
    }
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


  // No pointer, deliberately: the pointer is what made blocks evaporate on
  // refold. md is asserted because a blocked user without it husks in getForm.
  it('Gets ignores texts after block_user, but keeps forms and md, sets no pointer', () => {

    const log = [referral, text, echo, multipleChoice, synthetic({ type: 'block_user', value: null })]

    const state = getState(log)
    state.forms.should.eql(['FOO'])
    state.state.should.equal('USER_BLOCKED')
    should.not.exist(state.pointer)
    state.md.should.have.property('startTime')

    const state1 = getState([...log, text])
    state1.forms.should.eql(['FOO'])
    state1.state.should.equal('USER_BLOCKED')
    should.not.exist(state1.pointer)
    state1.md.should.have.property('startTime')
  })

  // No START guard: it is what let a pointer-truncated refold erase the block.
  it('block_user on a START state is a real block', () => {
    const state = getState([synthetic({ type: 'block_user', value: null })])
    state.state.should.equal('USER_BLOCKED')
    state.forms.should.eql([])
    should.not.exist(state.pointer)

    // and the machine stays blocked from there
    const state1 = getState([synthetic({ type: 'block_user', value: null }), text, multipleChoice])
    state1.state.should.equal('USER_BLOCKED')
    state1.qa.should.eql([])
  })

  // The durability property: a from-scratch refold reproduces the live blocked state.
  it('a full refold from scratch of a log with post-block events lands on USER_BLOCKED with md and forms', () => {
    const postbackAfterBlock = { ...multipleChoice, timestamp: 30 }
    const externalAfterBlock = {
      source: { type: 'synthetic' },
      event_type: 'synthetic_external',
      timestamp: 31,
      payload: { type: 'payment:complete', id: 'foo' }
    }
    const log = [
      referral, text, echo, multipleChoice,
      synthetic({ type: 'block_user', value: null }),
      { ...text, timestamp: 29 }, postbackAfterBlock, externalAfterBlock
    ]

    const live = getState(log.slice(0, 5))
    const refolded = getState(log)

    refolded.state.should.equal('USER_BLOCKED')
    refolded.forms.should.eql(['FOO'])
    refolded.md.should.have.property('startTime')
    refolded.md.should.eql(live.md)
    refolded.qa.should.eql([])
    should.not.exist(refolded.externalEvents)
    should.not.exist(refolded.pointer)
  })

  // Unblock is unchanged: restore_state sets its own pointer.
  it('restore_state after a block restores the snapshot and carries a pointer (the unblock path)', () => {
    const snapshot = { state: 'QOUT', question: 'q2', qa: [['q1', 'yes']], forms: ['FOO'], md: { startTime: 100 } }
    const log = [
      referral, text, echo, multipleChoice,
      synthetic({ type: 'block_user', value: null }),
      { ...text, timestamp: 29 },
      synthetic({ type: 'restore_state', value: { state: snapshot } }, { timestamp: 9999 })
    ]

    getState(log.slice(0, -1)).state.should.equal('USER_BLOCKED')

    const state = getState(log)
    state.state.should.equal('QOUT')
    state.question.should.equal('q2')
    state.qa.should.eql([['q1', 'yes']])
    state.forms.should.eql(['FOO'])
    state.md.should.eql({ startTime: 100 })
    state.pointer.should.equal(9999)
  })

  it('Ignores POSTBACK events after block_user', () => {
    const log = [referral, text, echo, multipleChoice, synthetic({ type: 'block_user', value: null })]

    const state = getState(log)
    state.state.should.equal('USER_BLOCKED')

    // A postback (button click) after being blocked should be ignored
    const postbackAfterBlock = {
      ...multipleChoice,
      timestamp: 30
    }
    const state1 = getState([...log, postbackAfterBlock])
    state1.state.should.equal('USER_BLOCKED')
    state1.qa.should.eql([]) // qa should remain empty, not record the postback
  })

  it('Ignores QUICK_REPLY events after block_user', () => {
    const log = [referral, text, echo, multipleChoice, synthetic({ type: 'block_user', value: null })]

    const state = getState(log)
    state.state.should.equal('USER_BLOCKED')

    // A quick reply after being blocked should be ignored
    const qrAfterBlock = {
      ...qr,
      timestamp: 30
    }
    const state1 = getState([...log, qrAfterBlock])
    state1.state.should.equal('USER_BLOCKED')
    state1.qa.should.eql([]) // qa should remain empty
  })

  it('Ignores REFERRAL for new form after block_user', () => {
    const log = [referral, text, echo, multipleChoice, synthetic({ type: 'block_user', value: null })]

    const state = getState(log)
    state.state.should.equal('USER_BLOCKED')
    state.forms.should.eql(['FOO'])

    // A referral for a NEW form (BAR) after being blocked should be ignored
    const newFormReferral = {
      ...referral,
      payload: { ...referral.payload, referral: { ...referral.payload.referral, ref: 'form.BAR' } },
      timestamp: 30
    }
    const state1 = getState([...log, newFormReferral])
    state1.state.should.equal('USER_BLOCKED')
    state1.forms.should.eql(['FOO']) // Should NOT add BAR to forms
  })

  it('Ignores EXTERNAL_EVENT after block_user', () => {
    const log = [referral, text, echo, multipleChoice, synthetic({ type: 'block_user', value: null })]

    const state = getState(log)
    state.state.should.equal('USER_BLOCKED')

    const externalEvent = {
      source: { type: 'synthetic' },
      event_type: 'synthetic_external',
      timestamp: 30,
      payload: { type: 'payment:complete', id: 'foo' }
    }
    const state1 = getState([...log, externalEvent])
    state1.state.should.equal('USER_BLOCKED')
    // externalEvents should not accumulate after block
    should.not.exist(state1.externalEvents)
  })

  it('Ignores ECHO after block_user', () => {
    const log = [referral, text, echo, multipleChoice, synthetic({ type: 'block_user', value: null })]

    const state = getState(log)
    state.state.should.equal('USER_BLOCKED')

    const echoAfterBlock = { ...echo, timestamp: 30 }
    const state1 = getState([...log, echoAfterBlock])
    state1.state.should.equal('USER_BLOCKED')
  })

  // Completes the enumeration above. HANDOVER_EVENT was the one external-event
  // path with no USER_BLOCKED guard, so a Messenger thread passback could still
  // wake a blocked participant -- the production trigger for 9 of the 12 traced
  // getForm/INTERNAL states on 2026-07-30.
  it('Ignores HANDOVER_EVENT after block_user', () => {
    const log = [referral, text, echo, multipleChoice, synthetic({ type: 'block_user', value: null })]

    const state = getState(log)
    state.state.should.equal('USER_BLOCKED')

    const state1 = getState([...log, handover({ metadata: 'new message' }, { timestamp: 30 })])
    state1.state.should.equal('USER_BLOCKED')
    // the handover must not accumulate, nor overwrite md with its own metadata
    should.not.exist(state1.externalEvents)
    state1.md.should.have.property('startTime')
    state1.md.should.not.have.property('e_handover_metadata')
  })

  // Watermarks would otherwise reach actionsResponses, fatal for the md-less capped state.
  it('Ignores read/delivery WATERMARK events after block_user', () => {
    const log = [referral, text, echo, multipleChoice, synthetic({ type: 'block_user', value: null })]
    const blocked = getState(log)
    blocked.state.should.equal('USER_BLOCKED')

    exec(blocked, { ...read, timestamp: 30, payload: { ...read.payload, watermark: 1e15 } }).action.should.equal('NONE')
    exec(blocked, { ...delivery, timestamp: 30, payload: { ...delivery.payload, watermark: 1e15 } }).action.should.equal('NONE')

    const state1 = getState([...log, { ...read, timestamp: 30 }, { ...delivery, timestamp: 31 }])
    state1.should.eql(blocked)
  })

  it('Changes form with new referral', () => {
    const ref2 = { ...referral, payload: { ...referral.payload, referral: { ...referral.payload.referral, ref: 'form.BAR' } } }

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

// The recovery event: overwrites unconditionally and sets the pointer to itself,
// both live and on a Redis-miss reload.
describe('RESTORE_STATE (recovery event)', () => {

  const P = {
    state: 'QOUT',
    question: 'q2',
    qa: [['q1', 'yes'], ['q2', 'blue']],
    forms: ['FOO'],
    md: { startTime: 100, seed: 42 },
    pointer: 500
  }

  const restore = (more = {}) =>
    synthetic({ type: 'restore_state', value: { state: P } }, { timestamp: 9999, ...more })

  const blockUser = synthetic({ type: 'block_user', value: null })

  it('restores the full snapshot from USER_BLOCKED and advances the pointer to the event timestamp', () => {
    const log = [referral, text, echo, multipleChoice, blockUser, restore()]

    getState(log.slice(0, -1)).state.should.equal('USER_BLOCKED')
    getState(log.slice(0, -1)).qa.should.eql([])

    const state = getState(log)
    state.state.should.equal('QOUT')
    state.question.should.equal('q2')
    state.qa.should.eql([['q1', 'yes'], ['q2', 'blue']])
    state.forms.should.eql(['FOO'])
    state.md.should.eql({ startTime: 100, seed: 42 })
    state.pointer.should.equal(9999)
  })

  it('restores the full snapshot when folded from START (durability on Redis-miss reload)', () => {
    const state = getState([restore()])
    state.state.should.equal('QOUT')
    state.question.should.equal('q2')
    state.qa.should.eql([['q1', 'yes'], ['q2', 'blue']])
    state.forms.should.eql(['FOO'])
    state.pointer.should.equal(9999)
  })

  it('does not survive as a stray field: starts from a clean initial state', () => {
    const priorLog = [referral, text, echo, multipleChoice]
    const before = getState(priorLog)
    should.exist(before.previousOutput)
    const state = getState([...priorLog, restore()])
    should.not.exist(state.previousOutput)
  })

  it('emits no outbound message on restore', () => {
    const log = [referral, text, echo, multipleChoice, blockUser, restore()]
    const { messages } = getMessage(log, form, { id: USER_ID }, { id: PAGE_ID })
    messages.should.eql([])
  })

  it('produces a RESTORE_STATE output carrying the snapshot with the new pointer', () => {
    const output = exec({ state: 'USER_BLOCKED', qa: [], forms: ['FOO'] }, restore())
    output.action.should.equal('RESTORE_STATE')
    output.stateUpdate.state.should.equal('QOUT')
    output.stateUpdate.qa.should.eql([['q1', 'yes'], ['q2', 'blue']])
    output.stateUpdate.pointer.should.equal(9999)
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
      event_id: 'evt_test_unknown',
      user_id: '123',
      timestamp: 1605980769303,
      source: { type: 'messenger', account_id: '345' },
      event_type: 'unknown',
      payload: { type: 'unknown' }
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
    const log = [referral, echo, { ...text, payload: { ...text.payload, text: 0 } }, _echo('bar'), { ...text, payload: { ...text.payload, text: '' } }]
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


  it('Responds while waiting with response and gets fresh waitstart on new wait', () => {

    const wait = { type: 'timeout', value: '2 days' }

    const log = [referral, echo, delivery,
      text,
      _echo({ wait, ref: 'foo' }),
      text,
      echo,
      { ...echo, timestamp: 10, payload: { ...echo.payload, metadata: { wait } } }
    ]
    const state = getState(log)
    state.state.should.equal('WAIT_EXTERNAL_EVENT')
    state.waitStart.should.equal(10)
  })


  it('Responds when it gets external events that fulfills timeout conditions', () => {
    const wait = { type: 'timeout', value: '1 hour' }

    const externalEvent = {
      source: { type: 'synthetic' },
      event_type: 'synthetic_timeout',
      timestamp: Date.now() + 1000 * 60 * 60,
      payload: Date.now() + 1000 * 60 * 60
    }

    const d = Date.now()
    const log = [referral, text, { ...echo, timestamp: d, payload: { ...echo.payload, metadata: { wait } } }, externalEvent]

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
      source: { type: 'synthetic' },
      event_type: 'synthetic_external',
      timestamp: Date.now(),
      payload: { type: 'moviehouse:play', id: 'foobar' }
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
      source: { type: 'synthetic' },
      event_type: 'synthetic_external',
      payload: { type: 'moviehouse:play', id: 'foobar' }
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
      source: { type: 'synthetic' },
      event_type: 'synthetic_external',
      payload: { type: 'moviehouse:play', id: 'foobar' }
    }

    const externalEventB = {
      source: { type: 'synthetic' },
      event_type: 'synthetic_timeout',
      timestamp: Date.now() + 1000 * 60 * 120,
      payload: Date.now() + 1000 * 60 * 120
    }

    const log = [referral, { ...echo, timestamp: Date.now(), payload: { ...echo.payload, metadata: { wait } } }, externalEventA, externalEventB]

    const state = getState(log)
    state.state.should.equal('RESPONDING')

    // and stores metadata
    state.md.should.have.property('e_moviehouse_play_id', 'foobar')
    state.md.should.have.property('form', 'FOO')
  })



  it('Adds event to metadata if not waiting external event and leaves the rest the same', () => {
    const externalEvent = {
      source: { type: 'synthetic' },
      event_type: 'synthetic_external',
      timestamp: Date.now(),
      payload: { type: 'moviehouse:play', id: 'foobar' }
    }

    const log = [referral, echo, text, externalEvent]
    const state = getState(log)

    state.state.should.equal('RESPONDING')
    state.md.should.have.property('e_moviehouse_play_id')
    state.md.form.should.eql("FOO")
    state.externalEvents.should.contain(externalEvent)
  })


  it('Resets all state on reset form and adds pointer', () => {

    const resetReferral = { ...referral, payload: { ...referral.payload, referral: { ...referral.payload.referral, ref: 'form.reset' } } }
    const log = [referral, echo, text, resetReferral]

    const state = getState(log)

    state.state.should.equal('START')
    state.forms.should.eql([])
    state.qa.should.eql([])
    state.pointer.should.equal(resetReferral.timestamp)
  })


  it('It switches forms after a form stitch message is sent, keeps metadata', () => {

    const metadata = { "type": "stitch", "stitch": { "form": "BAR" }, "ref": "foo" }
    const log = [referral, { ...echo, payload: { ...echo.payload, metadata } }]

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
      source: { type: 'synthetic' },
      event_type: 'synthetic_external',
      payload: { type: 'moviehouse:play', id: 'foobar' }
    }

    const metadata = { "type": "stitch", "stitch": { "form": "BAR" }, "ref": "foo" }
    const log = [referral, _echo({ wait, ref: 'foo' }), externalEvent, { ...echo, payload: { ...echo.payload, metadata } }]

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
    const log = [referral, { ...echo, payload: { ...echo.payload, metadata } }]

    const oldState = getState([referral])
    const state = getState(log)
    state.state.should.equal('RESPONDING')
    state.forms[1].should.equal('BAR')
    state.md.form.should.equal('FOO')
    state.md.bar_md.should.equal('hello metadata')
  })


  it('It keeps tokens when it stitches forms together', () => {
    const metadata = { "type": "stitch", "stitch": { "form": "BAR" }, "ref": "foo" }
    const log = [referral, optin, { ...echo, payload: { ...echo.payload, metadata } }]

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

  it('stamps error.ts with the triggering event timestamp on entry', () => {
    const report = synthetic({ type: 'machine_report', value: { error: { tag: 'INTERNAL', code: 'FOO', message: 'boom' } } }, { timestamp: 111 })
    const state = getState([referral, echo, text, report])
    state.state.should.equal('ERROR')
    state.error.ts.should.equal(111)
  })

  it('persists only the thin error on state (tag/code/message/ts), dropping stack/state/event', () => {
    // The heavy context (stack, pre-error state snapshot, raw event) stays on
    // the machine_report event → messages → errors projection; it must NOT be
    // duplicated onto the states row.
    const report = synthetic({ type: 'machine_report', value: { error: { tag: 'STATE_ACTIONS', code: 'X', message: 'm', stack: 'deep\nstack\ntrace', state: { big: 'snapshot' }, event: { raw: 1 } } } }, { timestamp: 7 })
    const state = getState([referral, echo, text, report])
    Object.keys(state.error).sort().should.eql(['code', 'message', 'tag', 'ts'])
    state.error.should.not.have.property('stack')
    state.error.should.not.have.property('state')
    state.error.should.not.have.property('event')
  })

  it('preserves error.ts (onset) across a Dean retry that re-fails', () => {
    // reportA breaks the user; a redo retries (RESPONDING blip, error kept);
    // reportB re-fails with different content. Same episode → onset ts is
    // preserved, content updated to the latest failure.
    const reportA = synthetic({ type: 'machine_report', value: { error: { tag: 'INTERNAL', code: 'A', message: 'a' } } }, { timestamp: 100 })
    const reportB = synthetic({ type: 'machine_report', value: { error: { tag: 'INTERNAL', code: 'B', message: 'b' } } }, { timestamp: 200 })
    const state = getState([referral, echo, text, reportA, synthetic({ type: 'redo' }), reportB])
    state.state.should.equal('ERROR')
    state.error.code.should.equal('B')
    state.error.ts.should.equal(100)
  })

  it('gets into a blocked state when given a bad platform response', () => {

    const pr = { ...syntheticPR, payload: { response: { error: { code: 2022 } } } }
    const log = [referral, echo, text, pr]
    const state = getState(log)

    state.state.should.equal('BLOCKED')
  })

  it('gets out of a blocked state if an echo follows a bad platform response', () => {

    const pr = { ...syntheticPR, payload: { response: { error: { code: 2022 } } } }
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
    const pr = { ...syntheticPR, payload: { response: { error: { code: 2022 } } } }
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

    const externalEvent = {
      source: { type: 'synthetic' },
      event_type: 'synthetic_timeout',
      timestamp: Date.now() + 1000 * 60 * 60 * 25,
      payload: Date.now() + 1000 * 60 * 60 * 25
    }

    const d = Date.now()

    const log = [referral, optin, text, { ...echo, timestamp: d, payload: { ...echo.payload, metadata: { wait } } }, externalEvent]

    const state = getState(log)
    state.state.should.equal('RESPONDING')
    state.tokens.should.eql([])
  })


  it('removes tokens to the state when it needs to use them for a bailout', () => {
    const wait = { type: 'timeout', value: '25 hours', notifyPermission: true }

    const externalEvent = {
      source: { type: 'synthetic' },
      event_type: 'synthetic_bailout',
      timestamp: Date.now() + 1000 * 60 * 60 * 25,
      payload: { form: 'BAR' }
    }

    const d = Date.now()

    const log = [referral, optin, text, { ...echo, timestamp: d, payload: { ...echo.payload, metadata: { wait } } }]

    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'barbaz', ref: 'barbaz' }]
    }


    const state = getState(log)
    const output = exec(state, externalEvent)
    const actions = act({ form, user: {} }, state, output)
    output.action.should.equal('SWITCH_FORM')
    output.form.should.equal('BAR')
    actions.messages[0].token.should.equal('FOOBAR')
    actions.messages[0].text.should.equal('barbaz')
  })

  describe('transient field cleanup', () => {

    it('clears error on REDO but keeps retries accumulating', () => {
      const report = synthetic({ type: 'machine_report', value: { error: { tag: 'INTERNAL', code: 'FOO' } } })
      const redo = synthetic({ type: 'redo' })
      const log = [referral, echo, text, report, redo]
      const state = getState(log)
      state.state.should.equal('RESPONDING')
      should.not.exist(state.error)
      state.retries.should.exist
      state.retries.length.should.equal(1)
    })

    it('parks the episode onset (not the error) on the RESPONDING blip of a REDO', () => {
      // The retry must not leave an `error` on a RESPONDING state — that would
      // show a not-currently-broken user as broken in Monitor / error_tag. But
      // the episode is not over yet, so the onset is kept aside on errorOnset.
      const report = synthetic({ type: 'machine_report', value: { error: { tag: 'INTERNAL', code: 'FOO' } } }, { timestamp: 100 })
      const redo = synthetic({ type: 'redo' })
      const log = [referral, echo, text, report, redo]
      const state = getState(log)
      state.state.should.equal('RESPONDING')
      should.not.exist(state.error)
      state.errorOnset.should.equal(100)
    })

    it('ends the episode when a retry succeeds, so the next error gets a fresh onset', () => {
      const reportA = synthetic({ type: 'machine_report', value: { error: { tag: 'INTERNAL', code: 'A' } } }, { timestamp: 100 })
      const reportB = synthetic({ type: 'machine_report', value: { error: { tag: 'INTERNAL', code: 'B' } } }, { timestamp: 300 })
      // referral breaks; a redo retries; the echo proves the question went out
      // (retry succeeded → episode over); a later, unrelated failure is a NEW
      // episode and must be stamped with its own onset.
      const log = [referral, reportA, synthetic({ type: 'redo' }), echo]
      const recovered = getState(log)
      recovered.state.should.equal('QOUT')
      should.not.exist(recovered.error)
      should.not.exist(recovered.errorOnset)

      const state = getState([...log, reportB])
      state.state.should.equal('ERROR')
      state.error.code.should.equal('B')
      state.error.ts.should.equal(300)
    })

    it('clears error and retries when user responds from ERROR state', () => {
      const report = synthetic({ type: 'machine_report', value: { error: { tag: 'INTERNAL', code: 'FOO' } } })
      const log = [referral, echo, text, report, text]
      const state = getState(log)
      state.state.should.equal('RESPONDING')
      should.not.exist(state.error)
      should.not.exist(state.retries)
    })

    it('clears wait when entering ERROR from WAIT_EXTERNAL_EVENT', () => {
      const wait = { type: 'timeout', value: '2 days' }
      const report = synthetic({ type: 'machine_report', value: { error: { tag: 'INTERNAL', code: 'FOO' } } })
      const log = [referral, echo, text, _echo({ wait, ref: 'bar' }), report]
      const state = getState(log)
      state.state.should.equal('ERROR')
      should.not.exist(state.wait)
      should.not.exist(state.waitStart)
      state.error.code.should.equal('FOO')
    })

    it('clears wait when entering BLOCKED from WAIT_EXTERNAL_EVENT', () => {
      const wait = { type: 'timeout', value: '2 days' }
      const fbReport = synthetic({ type: 'machine_report', value: { error: { tag: 'FB', code: 200, message: 'foo' } } })
      const log = [referral, echo, text, _echo({ wait, ref: 'bar' }), fbReport]
      const state = getState(log)
      state.state.should.equal('BLOCKED')
      should.not.exist(state.wait)
      should.not.exist(state.waitStart)
    })

    it('clears error, wait, and retries on END', () => {
      const report = synthetic({ type: 'machine_report', value: { error: { tag: 'INTERNAL', code: 'FOO' } } })
      const log = [referral, echo, text, report, tyEcho]
      const state = getState(log)
      state.state.should.equal('END')
      should.not.exist(state.error)
      should.not.exist(state.wait)
      should.not.exist(state.retries)
    })

    it('clears wait and waitStart when user responds while waiting', () => {
      const wait = { type: 'timeout', value: '2 days' }
      const log = [referral, echo, delivery, text, _echo({ wait, ref: 'bar' }), text]
      const state = getState(log)
      state.state.should.equal('RESPONDING')
      should.not.exist(state.wait)
      should.not.exist(state.waitStart)
    })
  })
})


describe('Machine', () => {
  let user = { id: '123' }

  it('gets the correct start field even with no referral', () => {
    const output = exec(_initialState(), text)
    const actions = act({ user, form, log: [text] }, _initialState(), output)
    actions.messages[0].question_text.should.equal(form.fields[0].title)
  })

  it('sends the first message when it gets a referral', () => {
    const output = exec(_initialState(), referral)
    const actions = act({ user, form, log: [referral] }, _initialState(), output)

    actions.messages[0].question_text.should.equal(form.fields[0].title)
  })

  it('Validates answers via postback', () => {
    const form = {
      logic: [],
      fields: [{ type: 'legal', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const log = [referral, echo, delivery, multipleChoice]
    const actions = getMessage(log, form, user)
    actions.messages[0].metadata.should.deep.equal({ ref: 'bar', type: 'short_text' })
    actions.messages[0].text.should.equal('bar')
  })

  it('Invalidates answers to legal when not in set', () => {
    const form = {
      logic: [],
      fields: [{ type: 'legal', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const log = [referral, echo, delivery, text]
    const actions = getMessage(log, form, user)
    actions.messages[0].metadata.repeat.should.be.true
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
    actions.messages[0].metadata.repeat.should.be.true
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
    actions.messages[0].metadata.should.deep.equal({ ref: 'bar', type: 'short_text' })
    actions.messages[0].text.should.equal('bar')
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
    actions.messages.forEach((a, i) => a.text.should.equal(form.fields[i].title))
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
    actions.messages[0].text.should.equal('bar')
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
    actions.messages.forEach((a, i) => a.text.should.equal(form.fields[i].title))
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
    actions.messages.forEach((a, i) => a.text.should.equal(form.fields[i].title))
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
    actions.messages[0].metadata.url.should.equal('foo.com')
    actions.messages[1].text.should.equal('foo')
  })


  it('Parses a webview url properly', () => {
    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'bar', ref: 'bar', properties: { description: '{"type": "webview", url: { "base": "foo.com", "params": {"q": "hello"}}, "buttonText": "Start"}' } }]
    }

    const log = [referral]
    const actions = getMessage(log, form, user)
    actions.messages.length.should.equal(1)
    actions.messages[0].metadata.url.should.equal('https://foo.com/?q=hello')
  })

/*
  it('Parses a webview url properly with funkyness from typeform', () => {
    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'bar', ref: 'bar', properties: { description: '{\n \"type\": \"webview\",\n \"url\": {\n \"base\": \"[columbiangwu.co1.qualtrics.com/jfe/form/SV\\_8k7acmuWQAZjERE](https://columbiangwu.co1.qualtrics.com/jfe/form/SV_8k7acmuWQAZjERE)\",\n \"params\": {\n \"vlab\\_id\": \"{{hidden:id}}\"\n }\n },\n \"buttonText\": \"Start\",\n \"extensions\": false\n}' } }]
    }

    const log = [referral]
    const actions = getMessage(log, form, user)
    actions.messages.length.should.equal(1)

    console.log(actions.messages[0])
    actions.messages[0].metadata.url.should.equal('https://https//columbiangwu.co1.qualtrics.com/jfe/form/SV_8k7acmuWQAZjERE?vlab_id=123')
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

    const log = [referral, echo, delivery, { ...text, payload: { ...text.payload, text: 0 } }]
    const actions = getMessage(log, form, user)
    actions.messages[0].text.should.equal('bar')
  })


  it('Does not resend a statement at the end', () => {
    const echo2 = { ...statementEcho, payload: { ...statementEcho.payload, metadata: { ref: "foo", type: "statement" } } }

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
    actions.messages[0].metadata.repeat.should.be.true
    actions.messages[1].metadata.isRepeat.should.be.true
  })

  it('Responds to is_echos that come after the delivery watermark', () => {
    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'foo', ref: 'foo' },
      { type: 'thankyou_screen', title: 'baz', ref: 'baz' }]
    }


    const log = [referral, delivery, { ...echo, timestamp: delivery.payload.watermark }, text]
    const actions = getMessage(log, form, user)
    actions.messages[0].text.should.equal('baz')
  })

  it('Responds to is_echos that come before the delivery watermark', () => {
    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'foo', ref: 'foo' },
      { type: 'thankyou_screen', title: 'baz', ref: 'baz' }]
    }


    const log = [referral, echo, delivery, text]
    const actions = getMessage(log, form, user)
    actions.messages[0].text.should.equal('baz')
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
    actions.messages[0].metadata.should.deep.equal({ ref: 'baz', type: 'number' })
    actions.messages[0].text.should.equal('baz')
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
    actions.messages[0].metadata.should.deep.equal({ ref: 'baz', type: 'number' })
    actions.messages[0].text.should.equal('baz')
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
    actions.messages[1].metadata.should.deep.equal({ ref: 'qux', type: 'number' })
    actions.messages[1].text.should.equal('qux')
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
    actions.messages[0].metadata.should.deep.equal({ repeat: true, ref: 'foo' })
    actions.messages[0].text.should.contain('Sorry')

    actions.messages[1].metadata.isRepeat.should.be.true
    actions.messages[1].metadata.ref.should.equal('foo')
    actions.messages[1].metadata.type.should.equal('multiple_choice')
  })


  it('repeats when it misses validation and tags custom types as isRepeat', () => {

    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'foo', ref: 'foo', properties: { description: '{"type": "wait"}' } }]
    }

    const log = [referral, echo, delivery, text]
    const actions = getMessage(log, form, user)

    // repeat ref foo with sorry message...
    actions.messages[0].metadata.should.deep.equal({ repeat: true, ref: 'foo' })
    actions.messages[0].text.should.contain('Sorry, I can\'t accept any responses')

    actions.messages[1].metadata.isRepeat.should.be.true
    actions.messages[1].metadata.type.should.equal('wait')
    actions.messages[1].metadata.ref.should.equal('foo')
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
    actions.messages[0].metadata.should.deep.equal({ repeat: true, ref: 'foo' })
    actions.messages[0].text.should.equal('baz error')
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
    actions.messages[0].metadata.should.deep.equal({ repeat: true, ref: 'foo' })
    actions.messages[0].text.should.equal('baz error')
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
    actions.messages[0].metadata.should.deep.equal({ repeat: true, ref: 'foo' })
    actions.messages[0].text.should.contain('baz')
    actions.messages[1].text.should.contain('foo')
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
    actions.messages[0].metadata.should.deep.equal({ repeat: true, ref: 'foo' })
    actions.messages[0].text.should.contain('Sorry, I can\'t accept any responses')
    actions.messages[1].text.should.contain('foo')
  })

  it('sends the messages to the token if a token is needed', () => {
    const wait = { type: 'timeout', value: '25 hours', notifyPermission: true }

    const externalEvent = {
      source: { type: 'synthetic' },
      event_type: 'synthetic_timeout',
      timestamp: Date.now() + 1000 * 60 * 60 * 25,
      payload: Date.now() + 1000 * 60 * 60 * 25
    }

    const d = Date.now()

    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'foo', ref: 'foo', properties: { description: '' } },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }


    const log = [referral, optin, { ...echo, timestamp: d, payload: { ...echo.payload, metadata: { wait, ref: 'foo' } } }, externalEvent]

    const actions = getMessage(log, form, user)
    actions.messages.length.should.equal(1)
    actions.messages[0].token.should.equal('FOOBAR')
    actions.messages[0].text.should.equal('bar')
  })


  it('sends the messages with an update tag if asked for', () => {

    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'bar', ref: 'bar', properties: { description: '{"sendParams": {"tag": "CONFIRMED_EVENT_UPDATE", "messaging_type": "MESSAGE_TAG"}}' } }]
    }

    const log = [referral]
    const actions = getMessage(log, form, user)
    actions.messages.length.should.equal(1)

    actions.messages[0].metadata.sendParams.messaging_type.should.equal("MESSAGE_TAG")
    actions.messages[0].metadata.sendParams.tag.should.equal("CONFIRMED_EVENT_UPDATE")
    actions.messages[0].text.should.equal('bar')
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
    actions.messages[0].metadata.type.should.equal('stitch')
    actions.messages[0].metadata.stitch.form.should.equal('BAR')
  })



  it('It recieves payload referrals and starts chatting', () => {

    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'foo', ref: 'foo' }]
    }

    const log = [payloadReferral]
    const actions = getMessage(log, form, user)

    actions.messages[0].text.should.equal('foo')
  })


  it('moves onward when validation succeeds', () => {
    const form = {
      logic: [],
      fields: [{ type: 'multiple_choice', title: 'foo', ref: 'foo', properties: { choices: [{ label: 'foo' }, { label: 'quux' }] } },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const log = [referral, echo, delivery, text]

    const actions = getMessage(log, form, user)
    actions.messages[0].metadata.should.deep.equal({ ref: 'bar', type: 'short_text' })
    actions.messages[0].text.should.equal('bar')
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
    const log = [referral, { ...echo, payload: { ...echo.payload, metadata: { wait, ref: 'foo' } } }, referral]
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
    actions.messages[0].metadata.repeat.should.be.true
    actions.messages[1].question_text.should.equal('foo')
  })

  it('ignores referrals when the person is the referrer ', () => {

    const secondRef = {
      ...referral, payload: {
        ...referral.payload,
        referral: {
          ...referral.payload.referral,
          ref: `form.BAR.referrer.${USER_ID}`
        }
      }
    }
    should.not.exist(getMessage([referral, echo, secondRef], form).messages[0])
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

    const response = { ...qr, payload: { ...qr.payload, value: "quux", source_message_id: "foo" } }
    const log = [referral, echo, delivery, response]
    const actions = getMessage(log, form, user)
    actions.messages[0].text.should.equal('bar')
  })

  it('Validates a quick reply with 0 value', () => {
    const form = {
      logic: [],
      fields: [{ type: 'multiple_choice', title: 'foo', ref: 'foo', properties: { choices: [{ label: '0' }, { label: '1' }] } },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const response = { ...qr, payload: { ...qr.payload, value: 0, source_message_id: "foo" } }
    const log = [referral, echo, delivery, response]
    const actions = getMessage(log, form, user)
    actions.messages[0].text.should.equal('bar')
  })

  it('Validates a quick reply when payload is string (as in email)', () => {
    const form = {
      logic: [],
      fields: [{ type: 'email', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const response = { ...qr, payload: { ...qr.payload, value: "foo@gmail.com" } }
    const log = [referral, echo, delivery, response]
    const actions = getMessage(log, form, user)
    actions.messages[0].text.should.equal('bar')
  })

  it('Invalidates an attachment as a respones to a quick reply', () => {
    const form = {
      logic: [],
      fields: [{ type: 'email', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const response = {
      event_id: 'evt_test_media_resp',
      user_id: USER_ID,
      timestamp: 20,
      source: { type: 'messenger', account_id: PAGE_ID },
      event_type: 'user_media',
      payload: {
        type: 'user_media',
        attachments: [{ "type": "image", "payload": { "url": "https://scontent.xx.fbcdn.net/v/t1.15752-9/461148037_759263159639423_7161323123727879546_n.jpg?_nc_cat=102&ccb=1-7&_nc_sid=fc17b8&_nc_ohc=zkDCMxo0pTsQ7kNvgGA_H8d&_nc_ad=z-m&_nc_cid=0&_nc_ht=scontent.xx&_nc_gid=AEZgev0WN3sV8E56pu3IELa&oh=03_Q7cD1QHpWUMM_ryYpocqe5jG_MF5bg12hw79eHeTmvbg8jVNHg&oe=67222F34" } }],
        stickerId: null
      }
    }

    const log = [referral, echo, delivery, response]
    const actions = getMessage(log, form, user)
    actions.messages[0].text.should.equal('Sorry, please enter a valid email address.')
  })


  it('Invalidates a quick reply when invalid', () => {
    const del1 = { ...delivery, payload: { ...delivery.payload, watermark: 5 } }

    const form = {
      logic: [],
      fields: [{ type: 'multiple_choice', title: 'foo', ref: 'foo', properties: { choices: [{ label: 'foo' }, { label: 'quux' }] } },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const response = { ...qr, payload: { ...qr.payload, value: "qux", source_message_id: "foo" } }

    const log = [referral, del1, echo, delivery, response]

    const actions = getMessage(log, form, user)
    actions.messages[0].metadata.repeat.should.be.true
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
    actions.messages[0].text.should.equal('bar')
  })

  it('Invalidates an optin when it comes from nowhere', () => {

    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'bar', ref: 'bar' }]
    }


    const log = [referral, _echo('bar'), optin]

    const actions = getMessage(log, form, user)
    actions.messages[0].metadata.repeat.should.be.true
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
    actions.messages[0].text.should.equal(followUpMessage({}))
    actions.messages[1].text.should.equal('foo')
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


  // ---------------------------------------------------------------------
  // Repeats of utility_message fields (VIR-15)
  //
  // A utility_message field's copy is a fixed, pre-approved Meta template --
  // the only mechanism that still reaches a user outside the 24-hour window.
  // The nudge / validation-failure line is free-form text, so out of window it
  // fails with "(#10) This message is sent outside of allowed window" and
  // BLOCKs exactly the population these re-contact flows exist to reach. There
  // is also nowhere to put the nudge: approved template copy cannot be edited
  // per send. So a repeat of a utility_message field re-sends the approved
  // template, alone.
  // ---------------------------------------------------------------------

  const UTILITY_MD = 'type: utility_message\ntemplate: recontact_digitalinsights\nlanguage: en_US\nparams:\n  - "5"'

  const utilityFormWithButtons = {
    logic: [],
    fields: [{
      type: 'multiple_choice',
      title: 'Welcome back!',
      ref: 'welcome_back',
      properties: {
        description: UTILITY_MD,
        choices: [{ label: 'Yes' }, { label: 'No' }]
      }
    }]
  }

  const utilityFormTextOnly = {
    logic: [],
    fields: [{
      type: 'statement',
      title: 'Welcome back!',
      ref: 'welcome_back',
      properties: { description: UTILITY_MD }
    }]
  }

  const shouldBeTheApprovedTemplate = messages => {
    messages.length.should.equal(1)

    const [msg] = messages
    msg.metadata.type.should.equal('utility_message')
    msg.metadata.template.should.equal('recontact_digitalinsights')
    msg.metadata.language.should.equal('en_US')
    msg.metadata.params.should.deep.equal(['5'])
    msg.metadata.ref.should.equal('welcome_back')
    msg.metadata.isRepeat.should.be.true

    // the free-form nudge cannot leave the 24h window -- it must not be sent
    should.not.exist(msg.metadata.repeat)
    messages
      .some(m => m.text === followUpMessage({}) || (m.text && /^Sorry/.test(m.text)))
      .should.be.false
  }

  it('Repeats a utility_message field as its approved template on follow_up', () => {
    const fu = synthetic({ type: 'follow_up', value: 'welcome_back' })
    const log = [referral, _echo('welcome_back'), fu]

    const actions = getMessage(log, utilityFormWithButtons, user)

    shouldBeTheApprovedTemplate(actions.messages)
    actions.messages[0].type.should.equal('question')
    actions.messages[0].options.map(o => o.label).should.deep.equal(['Yes', 'No'])
  })

  it('Repeats a text-only utility_message field as its approved template on follow_up', () => {
    const fu = synthetic({ type: 'follow_up', value: 'welcome_back' })
    const log = [referral, _echo('welcome_back'), fu]

    const actions = getMessage(log, utilityFormTextOnly, user)

    shouldBeTheApprovedTemplate(actions.messages)
    // base type is text; metadata.type is the discriminator message-worker
    // routes on -- see documentation/utility-messages.md
    actions.messages[0].type.should.equal('text')
    actions.messages[0].text.should.equal('Welcome back!')
  })

  it('Repeats a utility_message field as its approved template on failed validation', () => {
    const log = [referral, _echo('welcome_back'), text]

    const actions = getMessage(log, utilityFormWithButtons, user)

    shouldBeTheApprovedTemplate(actions.messages)
  })

  it('Repeats a text-only utility_message field as its approved template on failed validation', () => {
    const log = [referral, _echo('welcome_back'), text]

    const actions = getMessage(log, utilityFormTextOnly, user)

    shouldBeTheApprovedTemplate(actions.messages)
  })

  it('Repeats a utility_message field as its approved template on WhatsApp too', () => {
    // replybot emits one platform-neutral message; message-worker renders the
    // Messenger vs WhatsApp template shape off metadata.type. Same code path,
    // so the WhatsApp conversation must produce the identical message.
    const waEcho = {
      event_id: 'evt_test_wa_echo',
      user_id: WA_USER_ID,
      timestamp: 5,
      source: { type: 'whatsapp', account_id: WA_PHONE_NUMBER_ID },
      event_type: 'bot_message_sent',
      payload: {
        type: 'bot_message_sent',
        is_echo: true,
        metadata: { ref: 'welcome_back' },
        text: 'Welcome back!'
      }
    }

    const fu = synthetic(
      { type: 'follow_up', value: 'welcome_back' },
      { user_id: WA_USER_ID, source: { type: 'synthetic', platform: 'whatsapp' } }
    )

    const log = [whatsappReferral, waEcho, fu]
    const actions = getMessage(log, utilityFormWithButtons, user)

    shouldBeTheApprovedTemplate(actions.messages)
  })

  it('Still sends the nudge before repeating an ordinary field on follow_up', () => {
    const form = {
      logic: [],
      fields: [{ type: 'short_text', title: 'foo', ref: 'foo' }]
    }

    const fu = synthetic({ type: 'follow_up', value: 'foo' })
    const log = [referral, echo, fu]

    const actions = getMessage(log, form, user)

    actions.messages.length.should.equal(2)
    actions.messages[0].type.should.equal('text')
    actions.messages[0].text.should.equal(followUpMessage({}))
    actions.messages[0].metadata.should.deep.equal({ repeat: true, ref: 'foo' })
    actions.messages[1].metadata.isRepeat.should.be.true
    actions.messages[1].metadata.ref.should.equal('foo')
    actions.messages[1].metadata.type.should.equal('short_text')
  })

  it('Still sends the error message before repeating an ordinary field on failed validation', () => {
    const form = {
      logic: [],
      fields: [{ type: 'multiple_choice', title: 'foo', ref: 'foo', properties: { choices: [{ label: 'qux' }] } }]
    }

    const log = [referral, echo, delivery, text]
    const actions = getMessage(log, form, user)

    actions.messages.length.should.equal(2)
    actions.messages[0].metadata.should.deep.equal({ repeat: true, ref: 'foo' })
    actions.messages[0].text.should.contain('Sorry')
    actions.messages[1].metadata.isRepeat.should.be.true
    actions.messages[1].metadata.type.should.equal('multiple_choice')
  })

  it('Still throws when an ordinary repeat has no text to send', () => {
    const form = {
      logic: [],
      custom_messages: { 'label.buttonHint.default': '' },
      fields: [{ type: 'short_text', title: 'foo', ref: 'foo' }]
    }

    const fu = synthetic({ type: 'follow_up', value: 'foo' })
    const log = [referral, echo, fu];

    (() => getMessage(log, form, user)).should.throw(TypeError)
  })

  it('Resends a waiting message with a redo event', () => {
    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const log = [referral, synthetic({ type: 'redo' })]
    const actions = getMessage(log, form, user)
    actions.messages[0].text.should.equal('foo')
    actions.messages[1].text.should.equal('bar')

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
    actions.messages[0].text.should.equal('bar')

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

    const response = {
      event_id: 'evt_test_upload',
      user_id: USER_ID,
      timestamp: 20,
      source: { type: 'messenger', account_id: PAGE_ID },
      event_type: 'user_media',
      payload: {
        type: 'user_media',
        attachments: [{ "type": "image", "payload": { "url": "https://scontent.xx.fbcdn.net/v/t1.15752-9/461148037_759263159639423_7161323123727879546_n.jpg?_nc_cat=102&ccb=1-7&_nc_sid=fc17b8&_nc_ohc=zkDCMxo0pTsQ7kNvgGA_H8d&_nc_ad=z-m&_nc_cid=0&_nc_ht=scontent.xx&_nc_gid=AEZgev0WN3sV8E56pu3IELa&oh=03_Q7cD1QHpWUMM_ryYpocqe5jG_MF5bg12hw79eHeTmvbg8jVNHg&oe=67222F34" } }],
        stickerId: null
      }
    }

    const log = [referral, echo, delivery, response]
    const actions = getMessage(log, form, user)
    actions.messages[0].text.should.equal('bar')

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
    actions.messages[0].text.should.equal('foo')
    actions.messages[1].text.should.equal('bar')
  })


  it('Redo event resends the same token if redo sent after wait time', () => {
    const wait = { type: 'timeout', value: '25 hours', notifyPermission: true }

    const externalEvent = {
      source: { type: 'synthetic' },
      event_type: 'synthetic_timeout',
      timestamp: Date.now() + 1000 * 60 * 60 * 25,
      payload: Date.now() + 1000 * 60 * 60 * 25
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
    actions.messages[0].token.should.equal('FOOBAR')
    actions.messages[0].text.should.equal('bar')
  })


  it('repeats again when redo sent on missed validation', () => {

    const form = {
      logic: [],
      fields: [{ type: 'multiple_choice', title: 'foo', ref: 'foo', properties: { choices: [{ label: 'qux' }, { label: 'quux' }] } }]
    }

    const log = [referral, echo, text, synthetic({ type: 'redo' })]
    const actions = getMessage(log, form, user)

    actions.messages[0].metadata.should.deep.equal({ repeat: true, ref: 'foo' })
    actions.messages[0].text.should.contain('Sorry')
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
    actions.messages[0].text.should.equal('foo')
    actions.messages[1].text.should.equal('bar')
  })


  it('It redoes when blocked as reported in platform response and gets redo event', () => {
    const form = {
      logic: [],
      fields: [{ type: 'statement', title: 'foo', ref: 'foo' },
      { type: 'short_text', title: 'bar', ref: 'bar' }]
    }

    const pr = _.set(syntheticPR, 'payload.response', { error: { code: 2022 } })
    const log = [referral, echo, pr, synthetic({ type: 'redo' })]

    const actions = getMessage(log, form, user)
    actions.messages.length.should.equal(2)
    actions.messages[0].text.should.equal('foo')
    actions.messages[1].text.should.equal('bar')
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

    const echoBar = _.set(echo, 'payload.metadata.ref', 'bar')

    const log = [referral, statementEcho, echoBar, synthetic({ type: 'redo' })]
    const actions = getMessage(log, form, user)

    should.not.exist(actions.messages[0])
  })

  // TODO: it would be good to add a reset message...
  it('Sends no reset message on reset form', () => {
    const form = {}

    const resetReferral = { ...referral, payload: { ...referral.payload, referral: { ...referral.payload.referral, ref: 'form.reset' } } }

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
    const md = actions.messages[0].metadata

    // NOTE: do we still need the payment in the metadata? Doesn't hurt...
    md.should.eql({ ref: 'foo', type: 'statement', payment: { type: 'reloadly', details: { foo: 'bar' } } })
    actions.messages[0].text.should.equal('foo')

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

    actions.messages[0].text.should.equal("We're sorry, but this survey is now over and closed.")

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

    actions.messages[0].text.should.equal("foo")

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

    actions.messages[0].text.should.equal("We're sorry, but this survey is now over and closed.")
    actions.messages[0].metadata.ref.should.equal('bar')
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
    actions.messages[0].text.should.equal("We're sorry, but this survey is now over and closed.")

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

    const newReferral = { ...referral, payload: { ...referral.payload, referral: { ...referral.payload.referral, ref: 'form.BAR' } } }

    const log = [referral, _echo('bar'), { ...text, timestamp: now }, newReferral]

    const actions = getMessage(log, form, user, { id: 'bar' })

    actions.messages[0].text.should.equal("bar")
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

  before(() => {
    process.env.FACEBOOK_APP_ID = '123456789'
  })

  it('should send handoff message without handoff action when answering question before handoff field', () => {
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
              type: 'handoff',
              handoff: {
                target_app_id: '123456789',
                mode: 'wait',
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
    const md = actions.messages[0].metadata
    md.type.should.equal('handoff')
    md.handoff.should.deep.equal({ target_app_id: '123456789', mode: 'wait', metadata: { reason: 'customer_support' } })
    should.not.exist(actions.handoff)
  })

  it('should fire handoff action when echo of handoff message arrives', () => {
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
              type: 'handoff',
              handoff: {
                target_app_id: '123456789',
                mode: 'wait',
                metadata: { reason: 'customer_support' }
              }
            })
          }
        },
        { type: 'short_text', title: 'after', ref: 'after' }
      ]
    }

    const log = [
      referral,
      _echo('bar'),
      text,
      _echo({ ref: 'foo', type: 'handoff', handoff: { target_app_id: '123456789', mode: 'wait', metadata: { reason: 'customer_support' } } })
    ]
    const actions = getMessage(log, form, user, { id: '1855355231229529' })

    should.not.exist(actions.messages[0])
    actions.handoff.should.exist
    actions.handoff.target_app_id.should.equal('123456789')
    actions.handoff.metadata.should.deep.equal({ reason: 'customer_support' })
    actions.handoff.userid.should.equal('1989430067808669')
    actions.handoff.pageid.should.equal('1855355231229529')
    actions.handoff.timestamp.should.equal(echo.timestamp)
  })

  it('should fire handoff action with minimal metadata', () => {
    const form = {
      logic: [],
      fields: [
        {
          type: 'statement',
          title: 'foo',
          ref: 'foo',
          properties: {
            description: JSON.stringify({
              type: 'handoff',
              handoff: { target_app_id: '987654321' }
            })
          }
        }
      ]
    }

    const log = [referral, _echo({ ref: 'foo', type: 'handoff', handoff: { target_app_id: '987654321' } })]
    const actions = getMessage(log, form, user, { id: '1855355231229529' })

    actions.handoff.should.exist
    actions.handoff.target_app_id.should.equal('987654321')
    actions.handoff.userid.should.equal('1989430067808669')
  })

  it('should throw for unsupported handoff mode', () => {
    const form = {
      logic: [],
      fields: [
        {
          type: 'statement',
          title: 'foo',
          ref: 'foo',
          properties: {
            description: JSON.stringify({
              type: 'handoff',
              handoff: { target_app_id: '123456789', mode: 'nowait' }
            })
          }
        }
      ]
    }

    const log = [referral, _echo({ ref: 'foo', type: 'handoff', handoff: { target_app_id: '123456789', mode: 'nowait' } })]
    ;(() => getMessage(log, form, user, { id: '1855355231229529' })).should.throw(/handoff mode 'nowait' is not supported yet/)
  })

  it('should resume survey after handover event', () => {
    const form = {
      logic: [],
      fields: [
        {
          type: 'statement',
          title: 'foo',
          ref: 'foo',
          properties: {
            description: JSON.stringify({
              type: 'handoff',
              handoff: { target_app_id: '976665718578167', mode: 'wait' }
            })
          }
        },
        { type: 'short_text', title: 'after', ref: 'after' }
      ]
    }

    const handoverEvent = {
      event_type: 'handover',
      payload: {
        type: 'handover',
        new_owner_app_id: '123456789',
        previous_owner_app_id: '976665718578167',
        metadata: 'End of handoff'
      },
      source: { type: 'messenger', account_id: '1855355231229529' },
      user_id: '1989430067808669',
      timestamp: Date.now()
    }

    const log = [
      referral,
      _echo({ ref: 'foo', type: 'handoff', handoff: { target_app_id: '976665718578167', mode: 'wait' } }),
      handoverEvent
    ]
    const actions = getMessage(log, form, user, { id: '1855355231229529' })

    actions.messages[0].metadata.should.deep.equal({ ref: 'after', type: 'short_text' })
    actions.messages[0].text.should.equal('after')
  })

  it('should render returned handover metadata in hidden fields through the raw event pipeline', () => {
    // Regression test for the staging smoke-test failure: the events below are
    // RAW webhook shapes (as botserver forwards them to Kafka) mapped through the
    // real event-normalizer — mirroring production, where parseEvent runs per
    // Kafka message. The flattened keys must be e_handover_metadata_* (the
    // contract main's pipeline produced and deployed surveys reference), not the
    // one-level-shallower e_handover_*.
    const form = {
      logic: [],
      fields: [
        {
          type: 'statement',
          title: 'foo',
          ref: 'foo',
          properties: {
            description: JSON.stringify({
              type: 'handoff',
              handoff: { target_app_id: '976665718578167', mode: 'wait' }
            })
          }
        },
        {
          type: 'statement',
          title: 'Handoff complete! The echo app heard you say "{{hidden:e_handover_metadata_echo_text}}" (status: {{hidden:e_handover_metadata_smoke_echo}}) and handed control back to me.',
          ref: 'handoff_result'
        },
        { type: 'short_text', title: 'after', ref: 'after' }
      ]
    }

    const rawReferral = {
      source: 'messenger',
      sender: { id: user.id },
      recipient: { id: '1855355231229529' },
      timestamp: 1542123799219,
      referral: { ref: 'form.FOO.foo.bar', source: 'SHORTLINK', type: 'OPEN_THREAD' }
    }
    const rawHandoffEcho = {
      source: 'messenger',
      sender: { id: '1855355231229529' },
      recipient: { id: user.id },
      timestamp: 1542123799225,
      message: {
        is_echo: true,
        metadata: JSON.stringify({ ref: 'foo', type: 'handoff', handoff: { target_app_id: '976665718578167', mode: 'wait' } }),
        text: 'foo'
      }
    }
    const rawHandover = {
      source: 'messenger',
      sender: { id: user.id },
      recipient: { id: '1855355231229529' },
      timestamp: 1542123799300,
      pass_thread_control: {
        new_owner_app_id: 123456789, // Facebook sends app ids as numbers
        previous_owner_app_id: 976665718578167,
        metadata: '{"smoke_echo":"ok","echo_text":"hello"}'
      }
    }

    const log = [rawReferral, rawHandoffEcho, rawHandover].map(parseEvent)
    const actions = getMessage(log, form, user, { id: '1855355231229529' })

    actions.messages[0].text.should.equal('Handoff complete! The echo app heard you say "hello" (status: ok) and handed control back to me.')
  })
})

describe('Thread passback functionality', () => {
  let user = { id: '1989430067808669' }

  before(() => {
    process.env.FACEBOOK_APP_ID = '123456789'
  })

  it('should handle handover event and fulfill wait condition', () => {
    const wait = { type: 'handover', value: { target_app_id: '123456789' } }

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
      event_type: 'handover',
      payload: {
        type: 'handover',
        new_owner_app_id: '123456789',
        previous_owner_app_id: '987654321',
        metadata: '{"reason":"customer_support"}'
      },
      source: { type: 'messenger', account_id: '1855355231229529' },
      user_id: '1989430067808669',
      timestamp: Date.now()
    }

    const log = [referral, _echo({ ref: 'foo', type: 'wait', wait }), handoverEvent]
    const actions = getMessage(log, form, user)

    // Should proceed to next question after handover
    actions.messages[0].metadata.should.deep.equal({ ref: 'bar', type: 'short_text' })
    actions.messages[0].text.should.equal('bar')
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
      event_type: 'handover',
      payload: {
        type: 'handover',
        new_owner_app_id: '123456789',
        previous_owner_app_id: '987654321',
        metadata: '{"reason":"escalation","priority":"high"}'
      },
      source: { type: 'messenger', account_id: '1855355231229529' },
      user_id: '1989430067808669',
      timestamp: Date.now()
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
    actions.messages[0].metadata.should.deep.equal({ ref: 'bar', type: 'short_text' })
    actions.messages[0].text.should.equal('bar')
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
      event_type: 'handover',
      payload: {
        type: 'handover',
        new_owner_app_id: '999999999',
        previous_owner_app_id: '987654321',
        metadata: '{"reason":"customer_support"}'
      },
      source: { type: 'messenger', account_id: '1855355231229529' },
      user_id: '1989430067808669',
      timestamp: Date.now()
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

  it('should fulfill wait condition when new_owner_app_id is missing', () => {
    const wait = {
      op: 'or',
      vars: [
        { type: 'handover' },  // Accept any handover (value is optional)
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

    // Create a handover event without new_owner_app_id (Messenger API sometimes omits this)
    const handoverEvent = {
      event_type: 'handover',
      payload: {
        type: 'handover',
        previous_owner_app_id: '987654321',
        metadata: '{"reason":"customer_support"}'
      },
      source: { type: 'messenger', account_id: '1855355231229529' },
      user_id: '1989430067808669',
      timestamp: Date.now()
    }

    const waitCondition = {
      op: 'or',
      vars: [
        { type: 'handover' },
        { type: 'timeout', value: '60m' }
      ]
    }
    const log = [referral, _echo({ ref: 'foo', type: 'wait', wait: waitCondition }), handoverEvent]
    const actions = getMessage(log, form, user)

    // Should proceed to next question when new_owner_app_id is missing (accept handover)
    actions.messages[0].metadata.should.deep.equal({ ref: 'bar', type: 'short_text' })
    actions.messages[0].text.should.equal('bar')
  })

  it('should fulfill wait condition when new_owner_app_id is a number matching our string app id', () => {
    // Regression: real Messenger webhooks deliver new_owner_app_id as a JSON
    // *number*, while FACEBOOK_APP_ID is a string env var. A strict !== between
    // them is always true, which would drop every handover that includes
    // the field (observed in production: AI-chatbot handovers silently ignored,
    // surveys never resuming). The comparison must be type-agnostic.
    const wait = {
      op: 'or',
      vars: [
        { type: 'handover' },
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

    // new_owner_app_id as a NUMBER (123456789), exactly as JSON.parse yields it
    // from the webhook; process.env.FACEBOOK_APP_ID is the string '123456789'.
    const handoverEvent = {
      event_type: 'handover',
      payload: {
        type: 'handover',
        new_owner_app_id: 123456789,
        previous_owner_app_id: 987654321,
        metadata: 'End of AI chatbot session – handing back to Virtual Lab'
      },
      source: { type: 'messenger', account_id: '1855355231229529' },
      user_id: '1989430067808669',
      timestamp: Date.now()
    }

    const log = [referral, _echo({ ref: 'foo', type: 'wait', wait }), handoverEvent]
    const actions = getMessage(log, form, user)

    // Should accept the handover and proceed to the next question
    actions.messages[0].metadata.should.deep.equal({ ref: 'bar', type: 'short_text' })
    actions.messages[0].text.should.equal('bar')
  })


})

describe('Statement with wait should not gather next responses', () => {
  let user = { id: '1989430067808669' }

  it('should NOT gather next question when statement has wait condition', () => {
    const wait = { type: 'handover', value: { target_app_id: '123456789' } }

    const form = {
      logic: [],
      fields: [
        { type: 'short_text', title: 'First question', ref: 'first' },
        {
          type: 'statement',
          title: 'Please wait, passing control...',
          ref: 'wait_statement',
          properties: {
            description: JSON.stringify({ wait })
          }
        },
        { type: 'short_text', title: 'This should not be sent yet', ref: 'next_question' }
      ]
    }

    const log = [referral, _echo('first'), text]
    const actions = getMessage(log, form, user, { id: '1855355231229529' })

    // Should only send ONE message (the statement), not the next question
    actions.messages.length.should.equal(1)
    const md = actions.messages[0].metadata
    md.ref.should.equal('wait_statement')
    md.type.should.equal('statement')
    md.wait.should.deep.equal(wait)
  })

  it('should NOT gather next question when handoff field is reached', () => {
    const form = {
      logic: [],
      fields: [
        { type: 'short_text', title: 'First question', ref: 'first' },
        {
          type: 'statement',
          title: 'Passing you to support...',
          ref: 'handoff_field',
          properties: {
            description: JSON.stringify({
              type: 'handoff',
              handoff: { target_app_id: '123456789', mode: 'wait' }
            })
          }
        },
        { type: 'short_text', title: 'Welcome back!', ref: 'after_handoff' }
      ]
    }

    const log = [referral, _echo('first'), text]
    const actions = getMessage(log, form, user, { id: '1855355231229529' })

    actions.messages.length.should.equal(1)
    const md = actions.messages[0].metadata
    md.type.should.equal('handoff')
    md.handoff.should.deep.equal({ target_app_id: '123456789', mode: 'wait' })
    should.not.exist(actions.handoff)
  })
})

// Regression: entering without a referral used to build an `md` husk -- `{}` or
// e_*-only keys, no startTime -- which passed transition.js's `!md` guard and then
// threw inside getForm. See replybot/README.md.
describe('md must always carry startTime', () => {

  const step = (state, event) => apply(state, exec(state, event))

  // Behavior change, not only a crash fix: a stray quick_reply from an old
  // broadcast now starts the fallback form rather than erroring.
  it('blank-starts a form when a quick_reply is the first event', () => {
    const next = step(_initialState(), qr)

    next.forms.should.eql(['fallback'])
    should.exist(next.md)
    next.md.should.have.property('startTime', qr.timestamp)
    next.md.should.have.property('form', 'fallback')
  })

  it('blank-starts a form when a postback is the first event', () => {
    const next = step(_initialState(), multipleChoice)

    next.forms.should.eql(['fallback'])
    should.exist(next.md)
    next.md.should.have.property('startTime', multipleChoice.timestamp)
    next.md.should.have.property('form', 'fallback')
  })

  it('blank-starts a form when an external event arrives for a user with no conversation', () => {
    // A Messenger thread-control handover is a REAL PLATFORM EVENT, not a
    // synthetic one, and blank-starting on it is deliberate: in prod the
    // handover races the user's own first message by a second or two, so starting
    // the form is the right outcome and the referral that follows switches them
    // onto the referred form (see the handover-race test below).
    //
    // This is the case that makes "an external event must never blank-start"
    // wrong as a rule. The discriminator is `source.type === 'synthetic'`, not
    // "arrived via _handleExternalEvent" -- see the no-op describe below.
    const next = step(_initialState(), handover({ metadata: 'new message' }))

    next.forms.should.eql(['fallback'])
    should.exist(next.md)
    next.md.should.have.property('startTime', 3000)
    next.md.should.have.property('form', 'fallback')
  })
})

// A SYNTHETIC event on a conversation that reconstructs as START is
// self-contradictory, and blank-starting FALLBACK_FORM there is a silent
// re-entry onto a different live survey in the same account, misattributing
// the participant's answers to it.
//
// Why it is self-contradictory: every synthetic external event exists only
// BECAUSE a conversation already exists. A dean `timeout` is selected from a
// `states` row sitting in WAIT_EXTERNAL_EVENT; a dinersclub payment result
// requires the machine to have issued a payment; a linksniffer click and a
// moviehouse video event require a field to have been rendered and sent. So
// `state === 'START'` on one of these does not mean "new participant", it means
// "the log we just replayed is not the conversation's log" -- either because the
// scribble messages sink has not archived it yet, or because the account the
// event named is not the account the conversation lives on.
//
// Neither is a reason to enter a survey. See documentation/states-debugging.md.
describe('a synthetic event must not blank-start a conversation', () => {

  const step = (state, event) => apply(state, exec(state, event))

  const timeout = synthetic({ type: 'timeout', value: 1000 })
  const click = synthetic({
    type: 'external',
    value: { type: 'linksniffer:click', url: 'https://example.com' }
  })
  const video = synthetic({
    type: 'external',
    value: { type: 'moviehouse:play', id: 'vid1' }
  })

  it('no-ops a dean timeout that arrives on an empty conversation', () => {
    exec(_initialState(), timeout).action.should.equal('NONE')
  })

  it('no-ops a linksniffer click that arrives on an empty conversation', () => {
    exec(_initialState(), click).action.should.equal('NONE')
  })

  it('no-ops a moviehouse video event that arrives on an empty conversation', () => {
    exec(_initialState(), video).action.should.equal('NONE')
  })

  // The whole point: no FALLBACK_FORM, no md, no forms entry, no message.
  it('leaves the state untouched rather than entering FALLBACK_FORM', () => {
    const next = step(_initialState(), timeout)

    next.should.eql(_initialState())
    next.state.should.equal('START')
    next.forms.should.eql([])
    should.not.exist(next.md)
  })

  it('does not enter FALLBACK_FORM for any of the three producers', () => {
    for (const e of [timeout, click, video]) {
      const next = step(_initialState(), e)
      next.forms.should.eql([])
      should.not.exist(next.md)
    }
  })

  // The refusal must be a pure no-op in the FOLD, not a throw. `exec` runs during
  // replay as well as live (machine.getState folds the archived log with it), so
  // a throw here would make any log whose first archived event is a synthetic
  // one permanently unreplayable -- turning a transient archive lag into a
  // permanently dead conversation. That is a worse failure than the one being
  // fixed, so the fold must stay total.
  it('replays a log that OPENS with a synthetic event without throwing', () => {
    const state = getState([click, video, timeout])

    state.state.should.equal('START')
    state.forms.should.eql([])
    should.not.exist(state.md)
  })

  it('still starts the referred form when the referral arrives after the deferred events', () => {
    const state = getState([click, timeout, referral, echo])

    state.forms.should.eql(['FOO'])
    state.md.form.should.equal('FOO')
    state.md.form.should.not.equal(process.env.FALLBACK_FORM)
  })

  // Once the conversation exists, synthetic external events behave exactly as
  // before. The guard is scoped to START and nothing else.
  it('does not change behaviour once the conversation is established', () => {
    const established = getState([referral, echo])
    established.state.should.not.equal('START')

    const output = exec(established, click)
    output.action.should.equal('UPDATE_STATE')
    output.stateUpdate.externalEvents.length.should.equal(1)
  })

  it('leaves a blocked participant on the existing USER_BLOCKED no-op', () => {
    const blocked = { ..._initialState(), state: 'USER_BLOCKED' }
    exec(blocked, timeout).action.should.equal('NONE')
  })

  // DELIBERATELY NOT REFUSED. An exodus bailout names the form it wants the
  // participant switched onto, so it does not resolve through FALLBACK_FORM and
  // honouring it on a short replay still does the thing it was asked to do --
  // degraded (no seed, no md.pageid) but not wrong. Dropping it would silently
  // un-bail a participant exodus decided to bail, and exodus has no re-sweep.
  // Recorded here so the scope of the guard is a decision, not an oversight.
  it('does not defer an exodus bailout, which names its own form', () => {
    const output = exec(_initialState(), syntheticBail)

    output.action.should.equal('SWITCH_FORM')
    output.form.should.equal('BAR')
  })
})

// FALLBACK_FORM MAY START A CONVERSATION; IT MAY NEVER RE-ENTER ONE.
//
// Messenger's bare "Get Started" postback normalizes to `conversation_started`
// with NO referral (event-normalizer.js), so it routes to the REFERRAL case and
// resolves FALLBACK_FORM -- and the REFERRAL case was the one entry path with no
// START guard, because a referral naming a form is SUPPOSED to switch a live
// participant onto it. So a bare Get Started pushed FALLBACK_FORM onto a live
// conversation's stack at any state and replaced `md` wholesale.
//
// 3,732 production `states` rows, continuously 2020-06 to 2026-08 at 10-90/month.
// Replaying 561 of their real logs puts them, at the moment of the append, in END
// 50% / QOUT 22% / RESPONDING 14% / WAIT_EXTERNAL_EVENT 7% / BLOCKED 6% -- 44%
// mid-survey. The sequence below is the traced production one, from
// `chatroach.messages` on the Bauchi MNCH page:
//
//   13:16:00.474  referral  ref="creative.Static Hausa -parents. ... .form.mnchweeklanguage"
//   13:16:01.653  {"postback":{"title":"Get Started","payload":"get_started"}}   <- 1.2s later
//   13:16:03.524  forms:["mnchweeklanguage","305"]   md:{form:"305", ...}
//   13:16:04.53   ERROR
//
// RAW webhook shapes driven through the real event-normalizer, because the
// ambiguity is created in normalization (`referral: undefined`) and only resolved
// in the machine; a pre-normalized fixture would not exercise the pair.
describe('a form-less entry event must not re-enter a live conversation', () => {

  const step = (state, event) => apply(state, exec(state, event))

  const REAL_REF = 'creative.Static Hausa -parents.Age.Age.State.Bauchi State.form.mnchweeklanguage'
  const T = 1755000000474

  const raw = (extra, timestamp) => ({
    source: 'messenger',
    sender: { id: USER_ID },
    recipient: { id: PAGE_ID },
    timestamp,
    ...extra
  })

  const adReferral = raw({ referral: { ref: REAL_REF, type: 'OPEN_THREAD' } }, T)
  // The third webhook in the ad-click race, 1.2s after the referral.
  const getStartedPostback = raw({ postback: { title: 'Get Started', payload: 'get_started' } }, T + 1179)
  // A referral that DOES carry a ref, which names no form. Production values.
  const refWithoutForm = raw({ referral: { ref: 'clickToMessengerAds', type: 'OPEN_THREAD' } }, T + 1179)

  // A live conversation: entered by the ad, question sent, awaiting an answer.
  const liveLog = [parseEvent(adReferral), echo]

  it('routes the bare postback to REFERRAL carrying no referral at all', () => {
    // Why it reaches this case rather than POSTBACK, which already guards START.
    const event = parseEvent(getStartedPostback)

    event.event_type.should.equal('conversation_started')
    should.not.exist(event.payload.referral)
    categorizeEvent(event).should.equal('REFERRAL')
  })

  it('leaves the live conversation byte-for-byte untouched', () => {
    const before = getState(liveLog)
    const after = getState([...liveLog, parseEvent(getStartedPostback)])

    before.state.should.equal('QOUT')
    before.forms.should.eql(['mnchweeklanguage'])
    after.should.eql(before)
  })

  it('does not append FALLBACK_FORM and does not wipe the targeting metadata', () => {
    const after = getState([...liveLog, parseEvent(getStartedPostback)])

    after.forms.should.not.include(process.env.FALLBACK_FORM)
    after.md.form.should.equal('mnchweeklanguage')
    after.md.creative.should.equal('Static Hausa -parents')
    after.md.State.should.equal('Bauchi State')
  })

  it('no-ops rather than re-entering the live conversation', () => {
    exec(getState(liveLog), parseEvent(getStartedPostback)).action.should.equal('NONE')
  })

  // 44% of the measured population. A bare Get Started arriving here is a race
  // artefact, not an intent to start another survey.
  it('refuses mid-survey from every state a live conversation can be in', () => {
    for (const s of ['QOUT', 'RESPONDING', 'WAIT_EXTERNAL_EVENT', 'BLOCKED', 'ERROR']) {
      const live = { ...getState(liveLog), state: s }
      const output = exec(live, parseEvent(getStartedPostback))

      output.action.should.equal('NONE')
      step(live, parseEvent(getStartedPostback)).should.eql(live)
    }
  })

  // NAMED BEHAVIOUR CHANGE, half the population. Someone who finished a survey
  // and taps Get Started again must not be entered on FALLBACK_FORM -- another
  // researcher's live survey, where their answers were recorded. They now get
  // nothing at all. The documented restart mechanism is REPLYBOT_RESET_SHORTCODE,
  // not a bare Get Started, so this is a refusal to guess rather than a lost
  // feature -- and it is what every other post-END interaction already does.
  it('refuses a participant who taps Get Started again after finishing', () => {
    const ended = getState([parseEvent(adReferral), tyEcho])
    ended.state.should.equal('END')

    const after = getState([parseEvent(adReferral), tyEcho, parseEvent(getStartedPostback)])
    after.should.eql(ended)
  })

  it('refuses a referral whose ref carries no form pair', () => {
    exec(getState(liveLog), parseEvent(refWithoutForm)).action.should.equal('NONE')
  })

  // The WhatsApp shape of the same defect. A CTWA referral object routinely
  // carries no `ref`; with no matching autofill text there is nothing to resolve,
  // so it lands on FALLBACK_FORM. Accepted cost, stated: on WhatsApp the refused
  // event IS the participant's message, so dropping it drops that message. Still
  // strictly better than misattributing their answers to a different survey, and
  // they recover by sending anything else.
  it('refuses a CTWA referral that carries no ref, on a live WhatsApp conversation', () => {
    const ctwa = {
      source: 'whatsapp',
      phone_number_id: WA_PHONE_NUMBER_ID,
      from: WA_USER_ID,
      timestamp: T + 1179,
      type: 'text',
      text: { body: 'Hello' },
      referral: { source_id: '120210000', ctwa_clid: 'ARaBcD', headline: 'ad' }
    }
    const live = getState([whatsappReferral, echo])
    live.forms.should.eql(['FOO'])

    exec(live, parseEvent(ctwa)).action.should.equal('NONE')
  })

  // ---- everything that must keep working -------------------------------------

  it('still enters FALLBACK_FORM when the bare get_started is the first event', () => {
    // 35% of production's 162,148 fallback conversations start on exactly this.
    const state = getState([parseEvent(getStartedPostback)])

    state.state.should.equal('RESPONDING')
    state.forms.should.eql([process.env.FALLBACK_FORM])
    state.md.form.should.equal(process.env.FALLBACK_FORM)
    state.md.startTime.should.equal(getStartedPostback.timestamp)
    state.md.pageid.should.equal(PAGE_ID)
  })

  it('still enters FALLBACK_FORM from a referral whose ref names no form', () => {
    getState([parseEvent(refWithoutForm)]).forms.should.eql([process.env.FALLBACK_FORM])
  })

  // WHY THE DISCRIMINATOR IS `forms.length` AND NOT `state.state !== 'START'`.
  // A machine_report error arriving before entry leaves the conversation in ERROR
  // with an empty stack. There is no conversation to protect there, so entry must
  // still work -- a START-name test would strand this participant forever.
  it('still enters FALLBACK_FORM on a non-START state that has no form yet', () => {
    const errored = { ..._initialState(), state: 'ERROR' }
    const next = step(errored, parseEvent(getStartedPostback))

    next.forms.should.eql([process.env.FALLBACK_FORM])
  })

  // The case a `getForm(nxt) === FALLBACK_FORM` test would have broken: three
  // live production rows entered on `?ref=form.305.country.iraq`. An explicit ref
  // is an explicit ref even when it names the fallback shortcode.
  it('still switches a live participant onto a form the ref NAMES, fallback or not', () => {
    const explicit = raw({
      referral: { ref: `form.${process.env.FALLBACK_FORM}.country.iraq`, type: 'OPEN_THREAD' }
    }, T + 1179)
    const next = getState([...liveLog, parseEvent(explicit)])

    next.forms.should.eql(['mnchweeklanguage', process.env.FALLBACK_FORM])
    next.md.form.should.equal(process.env.FALLBACK_FORM)
    next.md.country.should.equal('iraq')
  })

  it('still repeats the pending question when the live form IS the fallback form', () => {
    // Reached before the new guard, via _hasForm -- a page that legitimately
    // enters on FALLBACK_FORM keeps its Get-Started-repeats-the-question
    // affordance.
    const onFallback = getState([parseEvent(getStartedPostback), echo])
    onFallback.state.should.equal('QOUT')

    const output = exec(onFallback, parseEvent(raw(
      { postback: { title: 'Get Started', payload: 'get_started' } }, T + 5000)))

    output.action.should.equal('RESPOND')
    output.validation.valid.should.be.false
  })

  it('no-ops for a USER_BLOCKED participant', () => {
    const blocked = { ...getState(liveLog), state: 'USER_BLOCKED' }

    exec(blocked, parseEvent(getStartedPostback)).action.should.equal('NONE')
  })

  it('still honours the reset shortcode on a live conversation', () => {
    const resetRef = raw({
      referral: { ref: `form.${process.env.REPLYBOT_RESET_SHORTCODE}` }
    }, T + 1179)

    exec(getState(liveLog), parseEvent(resetRef)).action.should.equal('RESET')
  })

  // The two webhooks in the ad-click race that were ALREADY handled. The handover
  // blank-starts FALLBACK_FORM, the referral switches to the referred form, and a
  // get_started in that ordering is absorbed by _hasForm rather than the new
  // guard. If this breaks, the guard has been widened past form-less entries.
  it('does not disturb the handover-then-referral ordering', () => {
    const rawHandover = raw({
      pass_thread_control: { previous_owner_app_id: 263902037430900, metadata: 'new message' }
    }, T - 1500)
    const state = getState([rawHandover, adReferral, getStartedPostback].map(parseEvent))

    state.md.form.should.equal('mnchweeklanguage')
    state.forms.should.eql([process.env.FALLBACK_FORM, 'mnchweeklanguage'])
  })

  // The refusal must stay a pure no-op in the FOLD. `exec` runs during replay as well
  // as live, and these logs are historical: every one of the 3,732 rows replays
  // through this branch on every cache miss.
  it('replays a log containing refused entries without throwing', () => {
    const state = getState([adReferral, getStartedPostback, getStartedPostback].map(parseEvent))

    state.forms.should.eql(['mnchweeklanguage'])
    state.md.form.should.equal('mnchweeklanguage')
  })
})

// VIR-17 / VIR-19. Ads whose welcome message carries a quick-reply button
// deliver the referral INSIDE that button's payload, and Messenger sends the
// payload as a JSON string. These are RAW webhook shapes run through the real
// event-normalizer, mirroring production where parseEvent runs per Kafka
// message -- a normalized fixture would not exercise the defect.
describe('Referral delivered inside a quick_reply payload string', () => {
  const REAL_REF = 'creative.3b.gender.men.geography.other_states2.form.hpvintrotriple'

  const rawQuickReplyReferral = {
    source: 'messenger',
    sender: { id: USER_ID },
    recipient: { id: PAGE_ID },
    timestamp: 1542123799219,
    message: {
      mid: 'm_hpv_intro',
      text: 'Get Started',
      quick_reply: { payload: `{"referral": {"ref": "${REAL_REF}"}}` }
    }
  }

  it('starts the referred form, not FALLBACK_FORM', () => {
    const state = getState([rawQuickReplyReferral].map(parseEvent))

    state.md.form.should.equal('hpvintrotriple')
    state.md.form.should.not.equal(process.env.FALLBACK_FORM)
    state.forms.should.eql(['hpvintrotriple'])
  })

  it('carries the referral targeting metadata into state.md', () => {
    const state = getState([rawQuickReplyReferral].map(parseEvent))

    state.md.creative.should.equal('3b')
    state.md.gender.should.equal('men')
    state.md.geography.should.equal('other_states2')
  })

  // A single ad click produces more than one webhook: the thread-control
  // handover typically lands ~1.5s before the quick_reply carrying the referral,
  // and the handover blank-starts FALLBACK_FORM. Once the referral normalizes
  // correctly the REFERRAL handler switches the user onto the referred form, so
  // the race is no longer terminal -- but `forms` keeps the transient fallback
  // entry, so the user still looks like they touched it.
  it('recovers the referred form when a handover blank-started FALLBACK_FORM first', () => {
    const rawHandover = {
      source: 'messenger',
      sender: { id: USER_ID },
      recipient: { id: PAGE_ID },
      timestamp: 1542123797000,
      pass_thread_control: { previous_owner_app_id: 263902037430900, metadata: 'new message' }
    }
    const state = getState([rawHandover, rawQuickReplyReferral].map(parseEvent))

    state.md.form.should.equal('hpvintrotriple')
    state.forms.should.eql(['fallback', 'hpvintrotriple'])
  })

  it('still starts FALLBACK_FORM for a quick_reply that carries no referral', () => {
    const rawAnswer = {
      source: 'messenger',
      sender: { id: USER_ID },
      recipient: { id: PAGE_ID },
      timestamp: 1542123799219,
      message: {
        mid: 'm_answer',
        text: 'Yes',
        quick_reply: { payload: '{"value":"1","ref":"intro_1"}' }
      }
    }
    const state = getState([rawAnswer].map(parseEvent))

    state.md.form.should.equal('fallback')
  })

  describe('WhatsApp inbound media validation and responseValue', () => {
    let user = { id: '123' }

    const whatsappMediaEvent = (mediaType, mediaData) => ({
      event_id: 'evt_test_whatsapp_media',
      user_id: '27123456789',
      timestamp: Date.now(),
      source: { type: 'whatsapp', account_id: 'PHONE_ID_1' },
      event_type: 'user_media',
      payload: {
        type: 'user_media',
        attachments: [{
          type: mediaType,
          payload: mediaData
        }],
        stickerId: null
      }
    })

    it('captures WhatsApp media id as responseValue', () => {
      const imageEvent = whatsappMediaEvent('image', {
        id: 'wamedia_abc123',
        url: 'https://media-server.example.com/img',
        mime_type: 'image/jpeg',
        sha256: 'hash123'
      })

      const output = exec(getState([referral, echo, delivery].map(parseEvent)), imageEvent)
      output.action.should.equal('RESPOND')
      output.responseValue.should.equal('wamedia_abc123')
    })

    it('captures WhatsApp video id as responseValue', () => {
      const videoEvent = whatsappMediaEvent('video', {
        id: 'vid_xyz789',
        url: 'https://media-server.example.com/video',
        mime_type: 'video/mp4',
        sha256: 'videohash'
      })

      const output = exec(getState([referral, echo, delivery].map(parseEvent)), videoEvent)
      output.action.should.equal('RESPOND')
      output.responseValue.should.equal('vid_xyz789')
    })

    it('regression: Messenger attachment yields url as responseValue when no id present', () => {
      // Messenger-native attachment shape: has url, no id
      const messengerMediaEvent = {
        event_id: 'evt_test_messenger_media',
        user_id: USER_ID,
        timestamp: 20,
        source: { type: 'messenger', account_id: PAGE_ID },
        event_type: 'user_media',
        payload: {
          type: 'user_media',
          attachments: [{
            type: 'image',
            payload: {
              url: 'https://scontent.xx.fbcdn.net/image.jpg'
            }
          }],
          stickerId: null
        }
      }

      const output = exec(getState([referral, echo, delivery].map(parseEvent)), messengerMediaEvent)
      output.action.should.equal('RESPOND')
      // Messenger has no id, so falls back to url
      output.responseValue.should.equal('https://scontent.xx.fbcdn.net/image.jpg')
    })

    it('all six WhatsApp media types capture their id as responseValue', () => {
      const mediaTypes = ['image', 'video', 'audio', 'voice', 'document', 'sticker']

      for (const mediaType of mediaTypes) {
        const mediaEvent = whatsappMediaEvent(mediaType, {
          id: `media_${mediaType}_123`,
          url: `https://media.example.com/${mediaType}`,
          mime_type: `media/${mediaType}`,
          sha256: `${mediaType}_sha256`
        })

        const output = exec(getState([referral, echo, delivery].map(parseEvent)), mediaEvent)
        output.action.should.equal('RESPOND')
        output.responseValue.should.equal(`media_${mediaType}_123`)
      }
    })

    it('still works when media has both id and url (prefers id)', () => {
      const mediaEvent = whatsappMediaEvent('image', {
        id: 'media_with_both_123',
        url: 'https://media.example.com/image',
        mime_type: 'image/jpeg',
        sha256: 'hash123'
      })

      const output = exec(getState([referral, echo, delivery].map(parseEvent)), mediaEvent)
      output.action.should.equal('RESPOND')
      // When both id and url present, responseValue should be id
      output.responseValue.should.equal('media_with_both_123')
    })
  })
})

// WhatsApp has no `ref` query param (see documentation/whatsapp-onboarding.md,
// "Entry links: there is no `ref` on WhatsApp"). The only carrier for entry
// metadata is prefilled text: wa.me/<number>?text=form.ABC.creative.x.gender.men
// arrives as an ordinary text.body. This drives a RAW WhatsApp webhook through
// the real event-normalizer (parseEvent), mirroring the Messenger
// string-payload-referral test above, to prove bare-text entry now carries
// Messenger-parity targeting metadata into state.md.
describe('WhatsApp bare-text entry carries Messenger-parity metadata', () => {
  const rawWhatsAppTextReferral = {
    source: 'whatsapp',
    from: WA_USER_ID,
    phone_number_id: WA_PHONE_NUMBER_ID,
    timestamp: 1542123799219,
    type: 'text',
    text: { body: 'form.hpvintrotriple.creative.3b.gender.men.geography.other_states2' }
  }

  it('starts the referred form, not FALLBACK_FORM', () => {
    const state = getState([rawWhatsAppTextReferral].map(parseEvent))

    state.md.form.should.equal('hpvintrotriple')
    state.md.form.should.not.equal(process.env.FALLBACK_FORM)
    state.forms.should.eql(['hpvintrotriple'])
  })

  it('carries the targeting metadata into state.md', () => {
    const state = getState([rawWhatsAppTextReferral].map(parseEvent))

    state.md.creative.should.equal('3b')
    state.md.gender.should.equal('men')
    state.md.geography.should.equal('other_states2')
  })

  it('still starts FALLBACK_FORM for plain WhatsApp text carrying no ref', () => {
    const rawPlainText = {
      source: 'whatsapp',
      from: WA_USER_ID,
      phone_number_id: WA_PHONE_NUMBER_ID,
      timestamp: 1542123799219,
      type: 'text',
      text: { body: 'Hi there' }
    }
    const state = getState([rawPlainText].map(parseEvent))

    state.md.form.should.equal('fallback')
  })
})

// The production ad path. A real CTWA referral object carries no form ref --
// every documented field is Meta-assigned -- so before this was handled, an ad
// click resolved to FALLBACK_FORM: the VIR-19 failure, and equally invisible
// because the fallback is a real survey that looks like a completion. The ad's
// autofill_message puts the entry token on text.body, so the form is recovered
// from there. Driven as a RAW webhook through parseEvent to prove the whole
// chain, not just the regex.
describe('WhatsApp CTWA ad entry resolves the form from the autofill message', () => {
  const ctwaReferral = {
    source_url: 'https://fb.me/3cr4Wqqkv',
    source_id: '120226305854810726',
    source_type: 'ad',
    headline: 'Take our survey',
    body: 'Tap to start',
    media_type: 'image',
    ctwa_clid: 'AAbbCCddEE'
  }

  const rawCtwaArrival = {
    source: 'whatsapp',
    from: WA_USER_ID,
    phone_number_id: WA_PHONE_NUMBER_ID,
    timestamp: 1542123799219,
    type: 'text',
    text: { body: 'form.hpvintrotriple.creative.3b.gender.men.geography.other_states2' },
    referral: ctwaReferral
  }

  it('starts the advertised form, not FALLBACK_FORM', () => {
    const state = getState([rawCtwaArrival].map(parseEvent))

    state.md.form.should.equal('hpvintrotriple')
    state.md.form.should.not.equal(process.env.FALLBACK_FORM)
    state.forms.should.eql(['hpvintrotriple'])
  })

  it('carries the ad targeting metadata into state.md', () => {
    const state = getState([rawCtwaArrival].map(parseEvent))

    state.md.creative.should.equal('3b')
    state.md.gender.should.equal('men')
    state.md.geography.should.equal('other_states2')
  })

  it('falls back when the ad sends no resolvable ref, without erroring', () => {
    const rawUnresolvable = { ...rawCtwaArrival, text: { body: 'hello' } }
    const state = getState([rawUnresolvable].map(parseEvent))

    state.md.form.should.equal('fallback')
  })
})

// WHATSAPP_ENTRY_REF percent-escape widening, end-to-end: raw webhook ->
// parseEvent (event-normalizer) -> getState (machine), not just the pattern
// or getMetadata in isolation. vlab's targeting metadata contains spaces and
// punctuation ("Static English - Girls", "Bauchi State"); on WhatsApp CTWA
// there is no advertiser-settable `ref`, so vlab percent-encodes those values
// into the ad's autofill message text. See event-normalizer.js
// (WHATSAPP_ENTRY_REF) and typewheels/utils.js (_decodeToken) for the two
// halves of this fix.
describe('WhatsApp percent-encoded metadata resolves end-to-end through getState', () => {
  const ctwaAdReferral = {
    source_url: 'https://fb.me/3cr4Wqqkv',
    source_id: '120226305854810726',
    source_type: 'ad',
    headline: 'Take our survey',
    body: 'Tap to start',
    media_type: 'image',
    ctwa_clid: 'AAbbCCddEE'
  }

  const rawWa = body => ({
    source: 'whatsapp',
    from: WA_USER_ID,
    phone_number_id: WA_PHONE_NUMBER_ID,
    timestamp: 1542123799219,
    type: 'text',
    text: { body }
  })

  it('round-trips a percent-encoded value with spaces and a literal hyphen', () => {
    const state = getState([rawWa('form.hpvintrotriple.creative.Static%20English%20-%20Girls')].map(parseEvent))

    state.md.form.should.equal('hpvintrotriple')
    state.md.creative.should.equal('Static English - Girls')
  })

  it('decodes multiple percent-encoded key.value pairs', () => {
    const state = getState([rawWa('form.hpvintrotriple.state.Bauchi%20State.region.South%20East')].map(parseEvent))

    state.md.form.should.equal('hpvintrotriple')
    state.md.state.should.equal('Bauchi State')
    state.md.region.should.equal('South East')
  })

  it('decodes the same percent-encoded ref arriving as a CTWA referral (the ad path, not wa.me)', () => {
    const rawCtwa = {
      ...rawWa('form.hpvintrotriple.creative.Static%20English%20-%20Girls'),
      referral: ctwaAdReferral
    }
    const state = getState([rawCtwa].map(parseEvent))

    state.md.form.should.equal('hpvintrotriple')
    state.md.creative.should.equal('Static English - Girls')
  })

  // A syntactically malformed escape is rejected by WHATSAPP_ENTRY_REF itself,
  // before decodeURIComponent is ever reached. The text then falls through
  // exactly like any other non-matching bare text: no referred-form entry, so
  // the conversation lands on FALLBACK_FORM instead of the advertised form.
  it('does not start the referred form when the ref contains a malformed escape (%zz)', () => {
    const state = getState([rawWa('form.hpvintrotriple.k.%zz')].map(parseEvent))

    state.md.form.should.equal('fallback')
    state.md.form.should.not.equal('hpvintrotriple')
  })

  // The containment case: %FF is a well-formed %XX escape (passes the
  // pattern) but is not valid UTF-8, so decodeURIComponent throws on it.
  // Before _decodeToken, that throw was uncaught within getMetadata's
  // try/catch around the WHOLE ref parse, so one bad token discarded the
  // entire md -- including `form` -- and the user lost their survey to
  // FALLBACK_FORM. Now the bad token survives raw and the rest of the ref,
  // `form` especially, still resolves normally.
  it('keeps a malformed-UTF-8-but-well-formed escape raw without losing the form', () => {
    const state = getState([rawWa('form.hpvintrotriple.k.%FF')].map(parseEvent))

    state.md.form.should.equal('hpvintrotriple')
    state.md.k.should.equal('%FF')
  })

  it('leaves plain unencoded wa.me entry unaffected', () => {
    const state = getState([rawWa('form.hpvintrotriple')].map(parseEvent))

    state.md.form.should.equal('hpvintrotriple')
  })
})

// md.ad_id — see the "Ad identity" block comment in lib/typewheels/utils.js.
// vlab keys ad attribution on this opaque id and owns the (network, ad_id)
// mapping itself; fly's only job is to capture it off the referral and carry
// it in state.md, untouched. adIdFromReferral is unit-tested exhaustively in
// utils.test.js as a pure function -- these tests instead drive RAW webhooks
// through the real event-normalizer (parseEvent) into getState, exactly like
// the CTWA / bare-text blocks above, to prove the whole chain: normalizer ->
// getMetadata -> state.md, not just the resolver function in isolation.
describe('md.ad_id — ad attribution identity captured from the referral', () => {
  const ctwaAdReferral = {
    source_url: 'https://fb.me/3cr4Wqqkv',
    source_id: '120226305854810726',
    source_type: 'ad',
    headline: 'Take our survey',
    body: 'Tap to start',
    media_type: 'image',
    ctwa_clid: 'AAbbCCddEE'
  }

  const rawCtwaAdArrival = {
    source: 'whatsapp',
    from: WA_USER_ID,
    phone_number_id: WA_PHONE_NUMBER_ID,
    timestamp: 1542123799219,
    type: 'text',
    text: { body: 'form.hpvintrotriple.creative.3b.gender.men.geography.other_states2' },
    referral: ctwaAdReferral
  }

  it('messenger: referral.ad_id lands on state.md.ad_id, and state.md.form still resolves as before', () => {
    const rawMessengerAdReferral = {
      source: 'messenger',
      sender: { id: USER_ID },
      recipient: { id: PAGE_ID },
      timestamp: 1542123799219,
      referral: { ref: 'form.hpvintrotriple', source: 'ADS', type: 'OPEN_THREAD', ad_id: '6041234567890' }
    }
    const state = getState([rawMessengerAdReferral].map(parseEvent))

    state.md.ad_id.should.equal('6041234567890')
    state.md.form.should.equal('hpvintrotriple')
  })

  it('messenger: an older referral with no ad_id field leaves state.md.ad_id entirely absent', () => {
    // Not falsy -- ABSENT. A present-but-undefined/null `ad_id` key would
    // still serialize into persisted state and confuse consumers that only
    // check `'ad_id' in md`.
    const rawMessengerReferralNoAdId = {
      source: 'messenger',
      sender: { id: USER_ID },
      recipient: { id: PAGE_ID },
      timestamp: 1542123799219,
      referral: { ref: 'form.hpvintrotriple', source: 'SHORTLINK', type: 'OPEN_THREAD' }
    }
    const state = getState([rawMessengerReferralNoAdId].map(parseEvent))

    state.md.should.not.have.property('ad_id')
    state.md.form.should.equal('hpvintrotriple')
  })

  it('whatsapp: CTWA source_type "ad" + source_id lands on state.md.ad_id', () => {
    const state = getState([rawCtwaAdArrival].map(parseEvent))

    state.md.ad_id.should.equal('120226305854810726')
    state.md.form.should.equal('hpvintrotriple')
  })

  // THE regression that matters most. An organic reshare of a page post
  // carries the exact same source_id shape as a CTWA ad click -- source_type
  // is the ONLY signal that tells them apart. If this gate is ever weakened
  // to accept post-sourced referrals, post ids get written into md.ad_id,
  // can never match vlab's (network, ad_id) mapping, and pile up forever in
  // the "unmapped" bucket that exists to catch real bugs -- silently and
  // permanently, because the conversation itself proceeds completely
  // normally otherwise (form still resolves, targeting metadata still
  // captured).
  it('whatsapp: source_type "post" must NOT produce an ad_id', () => {
    const rawCtwaPostArrival = {
      source: 'whatsapp',
      from: WA_USER_ID,
      phone_number_id: WA_PHONE_NUMBER_ID,
      timestamp: 1542123799219,
      type: 'text',
      text: { body: 'form.hpvintrotriple.creative.3b.gender.men.geography.other_states2' },
      referral: {
        source_url: 'https://fb.me/somepost',
        source_id: '999888777666', // a POST id, not an ad id
        source_type: 'post',
        headline: 'Someone shared this',
        body: 'Check it out',
        media_type: 'image'
      }
    }
    const state = getState([rawCtwaPostArrival].map(parseEvent))

    state.md.should.not.have.property('ad_id')
    state.md.form.should.equal('hpvintrotriple')
  })

  it('whatsapp: a referral with no source fields at all resolves no ad_id, form still resolves', () => {
    const rawWhatsAppReferralNoSourceFields = {
      source: 'whatsapp',
      from: WA_USER_ID,
      phone_number_id: WA_PHONE_NUMBER_ID,
      timestamp: 1542123799219,
      type: 'text',
      text: { body: 'hello' },
      referral: { ref: 'form.hpvintrotriple' }
    }
    const state = getState([rawWhatsAppReferralNoSourceFields].map(parseEvent))

    state.md.should.not.have.property('ad_id')
    state.md.form.should.equal('hpvintrotriple')
  })

  it('whatsapp: bare-text wa.me entry (no referral object at all) has no ad_id', () => {
    const rawBareTextEntry = {
      source: 'whatsapp',
      from: WA_USER_ID,
      phone_number_id: WA_PHONE_NUMBER_ID,
      timestamp: 1542123799219,
      type: 'text',
      text: { body: 'form.hpvintrotriple' }
    }
    const state = getState([rawBareTextEntry].map(parseEvent))

    state.md.should.not.have.property('ad_id')
    state.md.form.should.equal('hpvintrotriple')
  })

  // fly owns the `ad_id` key. getMetadata's `_group` parses the ref's dotted
  // path into md BEFORE the ad_id resolution step runs, so a ref token
  // literally spelled `ad_id` (e.g. a study author's creative naming
  // collides with our key) would otherwise land in md.ad_id as a string like
  // 'injected'. getMetadata deletes it first so fly's resolved value always
  // wins the collision.
  it('messenger: a ref token literally named ad_id never wins over the real ad_id field', () => {
    const rawCollision = {
      source: 'messenger',
      sender: { id: USER_ID },
      recipient: { id: PAGE_ID },
      timestamp: 1542123799219,
      referral: { ref: 'form.hpvintrotriple.ad_id.injected', source: 'ADS', type: 'OPEN_THREAD', ad_id: '999888777' }
    }
    const state = getState([rawCollision].map(parseEvent))

    state.md.ad_id.should.equal('999888777')
    state.md.ad_id.should.not.equal('injected')
  })

  it('messenger: a ref token named ad_id with NO real ad_id field leaves ad_id absent, not "injected"', () => {
    const rawCollision = {
      source: 'messenger',
      sender: { id: USER_ID },
      recipient: { id: PAGE_ID },
      timestamp: 1542123799219,
      referral: { ref: 'form.hpvintrotriple.ad_id.injected', source: 'SHORTLINK', type: 'OPEN_THREAD' }
    }
    const state = getState([rawCollision].map(parseEvent))

    state.md.should.not.have.property('ad_id')
  })

  // Verify persistence: md is stamped once at conversation_started (inside
  // getMetadata, called from the REFERRAL transition) and rides along in
  // state as later events are folded in -- it is not re-derived or dropped
  // on every subsequent event.
  it('ad_id is stamped once at conversation_started and survives a later user reply', () => {
    const rawReply = {
      source: 'whatsapp',
      from: WA_USER_ID,
      phone_number_id: WA_PHONE_NUMBER_ID,
      timestamp: 1542123800000,
      type: 'text',
      text: { body: 'Yes' }
    }
    const state = getState([rawCtwaAdArrival, rawReply].map(parseEvent))

    state.md.ad_id.should.equal('120226305854810726')
  })
})
