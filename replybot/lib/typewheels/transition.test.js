const nock = require('nock')
const mocha = require('mocha')
const chai = require('chai')
const sinon = require('sinon')
const should = chai.should()
const utils = require('@vlab-research/utils')
const {Machine} = require('./transition')
const { echo, tyEcho, statementEcho, repeatEcho, delivery, read, qr, text, sticker, multipleChoice, referral, USER_ID, reaction, syntheticBail, syntheticPR, optin, payloadReferral, syntheticRedo, synthetic } = require('./events.test')
const {MachineIOError} = require('../errors')

nock(process.env.FORMCENTRAL_URL)
.get('/metadata?surveyid=foo')
.reply(404)
.persist();

describe('machine.run', () => {
  before(() => {
    sinon.stub(utils, "getPageFromEvent").returns('foo');
  });

  after(() => {
    sinon.restore();
  });

  it('returns STATE_TRANSITION error if transition throws', async () => {

    const m = new Machine()
    m.getForm = () => Promise.resolve([{}, 'foo'])
    m.transition = () => { throw new Error('foo')}
    const timestamp = Date.now()
    const report = await m.run({state: 'QOUT', md: {}, forms: [] }, 'bar', { event: 'hello', timestamp})
    report.user.should.equal('bar')
    report.error.message.should.equal('foo')
    report.timestamp.should.equal(timestamp)
    report.error.tag.should.equal('STATE_TRANSITION')
    report.error.state.should.eql({state: 'QOUT', md: {}, forms: [] })
    report.publish.should.be.false
  })


  it('returns STATE_ACTIONS error if run throws for unknown reason', async () => {

    const m = new Machine()
    m.transition = () => ({newState: {}, output: {}})
    m.getForm = () => Promise.resolve([{}, 'foo'])
    m.actionsResponses = () => ({})
    m.act = () => Promise.reject(new Error('foo'))
    const timestamp = Date.now()
    const report = await m.run({state: 'QOUT', md: {}, forms: [] }, 'bar', { event: 'hello', timestamp})
    report.user.should.equal('bar')
    report.timestamp.should.equal(timestamp)
    report.error.message.should.equal('foo')
    report.error.tag.should.equal('STATE_ACTIONS')
    report.publish.should.be.true
  })

  it('returns specific tag error if run throws MachineIOError', async () => {

    const m = new Machine()
    m.transition = () => ({newState: {}, output: {}})
    m.getForm = () => Promise.resolve([{}, 'foo'])
    m.actionsResponses = () => ({})
    m.act = () => Promise.reject(new MachineIOError('BAZ', 'foo', { code: 'FB' }))
    const timestamp = Date.now()
    const report = await m.run({state: 'QOUT', md: {}, forms: [] }, 'bar', { event: 'hello', timestamp})
    report.user.should.equal('bar')
    report.timestamp.should.equal(timestamp)
    report.error.message.should.equal('foo')
    report.error.tag.should.equal('BAZ')
    report.error.code.should.equal('FB')
    report.publish.should.be.true
  })



  it('returns specific tag error if actionsResponses throws MachineIOError', async () => {

    const m = new Machine()
    m.transition = () => ({newState: {}, output: {}})
    m.getForm = () => Promise.resolve([{}, 'foo'])
    m.actionsResponses = () => Promise.reject(new MachineIOError('BAZ', 'foo', { code: 'FB' }))
    m.act = () => ({})
    const timestamp = Date.now()
    const report = await m.run({state: 'QOUT', md: {}, forms: [] }, 'bar', { event: 'hello', timestamp })
    report.user.should.equal('bar')
    report.timestamp.should.equal(timestamp)
    report.error.message.should.equal('foo')
    report.error.tag.should.equal('BAZ')
    report.error.code.should.equal('FB')
    report.publish.should.be.true
  })




  it('returns a report with actions if all goes well', async () => {
    const m = new Machine()
    m.getForm = () => Promise.resolve([{}, 'foo'])
    m.transition = () => ({newState: {}, output: {}})
    m.actionsResponses = () => ({ actions: [{foo: 'qux'}]})
    m.act = () => ({})

    const timestamp = Date.now()
    const report = await m.run({state: 'QOUT', md: {}, forms: [] }, 'bar', { event: 'hello', timestamp})
    report.user.should.equal('bar')
    report.timestamp.should.equal(timestamp)
    should.not.exist(report.error)
    report.actions[0].should.eql({foo: 'qux'})
    report.publish.should.be.true
  })


})

describe('Machine integrated', () => {

  it('returns a report with actions when given send actions', async () => {
    const m = new Machine()
    m.getPageToken = () => Promise.resolve('footoken')
    m.getForm = () => Promise.resolve([{ logic: [],
                                          fields: [{type: 'short_text', title: 'foo', ref: 'foo'},
                                                   {type: 'short_text', title: 'bar', ref: 'bar'}]}, 'foo'])
    m.getUser = () => Promise.resolve(({ 'id': 'bar' }))
    m.sendMessage = () => Promise.resolve({})

    const report = await m.run({ state: 'START', md: {}, forms: [] }, 'bar', referral)
    report.user.should.equal('bar')
    should.not.exist(report.error)
    report.timestamp.should.equal(referral.timestamp)
    report.actions[0].should.eql({ message: { 'metadata': '{"ref":"foo"}', text: 'foo'},
                                   recipient: { id: 'bar' }})
    report.publish.should.be.true
  })


  it('returns a report with payment when given payment to send', async () => {
    const _echo = md => ({...echo, message: { ...echo.message, metadata: md }})
    const m = new Machine()
    m.getPageToken = () => Promise.resolve('footoken')
    m.getForm = () => Promise.resolve([{}, 'foo'])

    const md = { ref: 'foo', type: 'payment', payment: { provider: 'reloadly', details: { foo: 'bar'}}}

    const event = _echo(md)

    m.getUser = () => Promise.resolve(({ 'id': 'bar' }))
    m.sendMessage = () => Promise.resolve({})

    const report = await m.run({ state: 'RESPONDING', md: {}, forms: [] }, 'bar', event)

    report.user.should.equal('bar')
    should.not.exist(report.error)
    report.timestamp.should.equal(event.timestamp)
    report.actions.should.eql([])
    report.publish.should.be.true
    report.payment.should.eql({
      userid: 'bar',
      pageid: '1051551461692797',
      timestamp: 5,
      provider: 'reloadly',
      details: { foo: 'bar' }
    })
  })



  it('returns an error report with INTERNAL when internal network failures happen', async () => {
    const m = new Machine()
    m.getPageToken = () => Promise.resolve('footoken')
    m.getForm = () => Promise.reject(new Error('Ah'))
    m.getUser = () => Promise.resolve(({ 'id': 'bar' }))
    m.sendMessage = () => Promise.resolve({})

    const report = await m.run({ state: 'START', md: {}, forms: [] }, 'bar', referral)
    report.user.should.equal('bar')
    report.error.tag.should.equal('INTERNAL')
    report.publish.should.be.true
  })

  it('returns a report with publish false when there is no update', async () => {
    const m = new Machine()
    m.getPageToken = () => Promise.resolve('footoken')
    m.getForm = () => Promise.resolve([{}, 'foo'])
    m.getUser = () => Promise.resolve(({ 'id': 'bar' }))
    m.sendMessage = () => Promise.resolve({})

    const state = { state: 'RESPONDING', md: {}, forms: [] }

    const report = await m.run(state, 'bar', text)

    report.user.should.equal('bar')
    should.not.exist(report.error)
    report.timestamp.should.equal(text.timestamp)
    report.publish.should.be.false
    report.newState.should.eql(state)
    should.not.exist(report.actions)
  })


  it('doesnt publish machine report when recieves machine report and currently in error state', async () => {
    const m = new Machine()
    m.getPageToken = () => Promise.resolve('footoken')
    m.getForm = () => Promise.resolve([{}, 'foo'])
    m.getUser = () => Promise.resolve(({ 'id': 'bar' }))
    m.sendMessage = () => Promise.resolve({})

    const state = { state: 'ERROR', md: {}, forms: [] }

    const event = synthetic({ type: 'machine_report', value: {error: { tag: 'INTERNAL', status: 404}}})
    const report = await m.run(state, 'bar', event)

    report.user.should.equal('bar')
    should.not.exist(report.error)
    report.timestamp.should.equal(event.timestamp)
    report.publish.should.be.false
    report.newState.should.eql(state)
    should.not.exist(report.actions)
  })


  it('returns an error report when no timestamp in message', async () => {
    const m = new Machine()
    m.getPageToken = () => Promise.resolve('footoken')
    m.getForm = () => Promise.reject(new Error('Ah'))
    m.getUser = () => Promise.resolve(({ 'id': 'bar' }))
    m.sendMessage = () => Promise.resolve({})

    const report = await m.run({ state: 'START' }, 'bar', "{foo--:;{-bar}")
    report.user.should.equal('bar')
    report.error.tag.should.equal('CORRUPTED_MESSAGE')
    report.publish.should.be.true
  })

  it('survey is closed', async () => {
    nock(process.env.FORMCENTRAL_URL)
    .get('/metadata?surveyid=bar')
    .reply(200, {'surveyid': 'bar', 'off_date': 1})

    const m = new Machine()
    m.getPageToken = () => Promise.resolve('bartoken')
    m.getForm = () => Promise.resolve([{}, 'bar'])
    m.sendMessage = () => Promise.resolve({})

    const report = await m.run({ state: 'START', md: {}, forms: [] }, 'foo', referral)
    report.user.should.equal('foo')
    should.not.exist(report.error)
    report.timestamp.should.equal(referral.timestamp)
    report.actions[0].should.eql({ message: { 'metadata': '{}', text: 'Sorry, the survey is closed.'},
                                   recipient: { id: 'foo' }})
    report.publish.should.be.true
  })
})
