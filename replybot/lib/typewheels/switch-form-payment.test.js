const mocha = require('mocha')
const chai = require('chai')
const should = chai.should()
const fs = require('fs')
const { exec, act, apply } = require('./machine')
const { parseEvent } = require('../event-normalizer')

// Every act() branch that renders messages must publish the payment carried by
// any of them. A stitch into a form whose first field is a payment, and a redo
// that regenerates a payment message, are the two paths besides RESPOND.
const F = JSON.parse(fs.readFileSync('mocks/switch-form-payment-events.json'))

const PAYMENT_MD = JSON.stringify({
  type: 'wait',
  wait: { type: 'external', value: { type: 'payment:dingconnect', id: 'p1' } },
  payment: {
    provider: 'dingconnect',
    key: 'DINGCONNECT_API_KEY',
    details: { id: 'p1', account_number: '+59171234567', amount: 5 }
  }
})

const sendField = {
  id: 'f1', ref: 'p1_send', type: 'statement', title: 'Sending…',
  properties: { description: PAYMENT_MD }
}
const gateField = {
  id: 'g1', ref: 'pay_1_ready', type: 'multiple_choice',
  title: 'We are ready to send your payment.',
  properties: { choices: [{ ref: 'OK', label: 'OK' }] }
}

const ctxFor = fields => ({
  form: { id: 'PAYFORM', title: 'pay', fields, thankyou_screens: [] },
  user: { id: 'U1' }, page: { id: 'P1' },
  timestamp: 1788566896445, platform: 'whatsapp'
})

// End of the previous part, about to receive the stitch echo into the pay form.
const priorState = () => ({
  state: 'RESPONDING', question: 'q22_phone', qa: [], forms: ['lacbo1es'],
  md: { form: 'lacbo1es', phone: '+59171234567' }
})

const redo = {
  event_id: 'evt_redo', user_id: '15419799714', timestamp: 1788567000000,
  source: { type: 'synthetic' }, event_type: 'synthetic_redo', payload: null
}

describe('payments generated outside RESPOND', () => {

  it('a stitch resolves to SWITCH_FORM', () => {
    exec(priorState(), parseEvent(F.stitchEcho)).action.should.equal('SWITCH_FORM')
  })

  it('publishes the payment when the payment field is first in the stitched-into form', () => {
    const state = priorState()
    const output = exec(state, parseEvent(F.stitchEcho))
    const result = act(ctxFor([sendField]), state, output)

    result.messages.should.have.length(1)
    should.exist(result.payment)
    result.payment.provider.should.equal('dingconnect')
    result.payment.details.id.should.equal('p1')
    result.payment.userid.should.equal('U1')
    result.payment.pageid.should.equal('P1')
    result.payment.platform.should.equal('whatsapp')
  })

  it('publishes the payment once, from the RESPOND, when an acknowledged statement comes first', () => {
    const fields = [gateField, sendField]
    const ctx = ctxFor(fields)
    let state = priorState()

    const o1 = exec(state, parseEvent(F.stitchEcho))
    const r1 = act(ctx, state, o1)
    state = apply(state, o1)
    o1.action.should.equal('SWITCH_FORM')
    should.not.exist(r1.payment)

    const o2 = exec(state, parseEvent(F.gateEcho))
    state = apply(state, o2)
    state.state.should.equal('QOUT')
    state.question.should.equal('pay_1_ready')

    const o3 = exec(state, parseEvent(F.tap))
    const r3 = act(ctx, state, o3)
    o3.action.should.equal('RESPOND')
    should.exist(r3.payment)
    r3.payment.provider.should.equal('dingconnect')
    r3.payment.details.id.should.equal('p1')
  })

  it('publishes the payment again when a redo regenerates the payment message', () => {
    const ctx = ctxFor([gateField, sendField])
    const state = [F.stitchEcho, F.gateEcho, F.tap]
      .map(parseEvent)
      .reduce((s, e) => apply(s, exec(s, e)), priorState())

    const output = exec(state, parseEvent(redo))
    const result = act(ctx, state, output)

    output.action.should.equal('RESPOND_AGAIN')
    result.messages.map(m => m.metadata && m.metadata.ref).should.include('p1_send')
    should.exist(result.payment)
    result.payment.details.id.should.equal('p1')
  })
})
