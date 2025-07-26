const util = require('util')
const r2 = require('r2')
const { Machine } = require('./typewheels/transition')
const { StateStore } = require('./typewheels/statestore')
const { BotSpine } = require('@vlab-research/botspine')
const { pipeline } = require('stream')
const { TokenStore } = require('./typewheels/tokenstore')
const { producer, producerReady } = require('./producer')
const { SpineSupervisor } = require('./spine-supervisor/spine-supervisor')

const REPLYBOT_STATESTORE_TTL = process.env.REPLYBOT_STATESTORE_TTL || '24h'
const REPLYBOT_MACHINE_TTL = process.env.REPLYBOT_MACHINE_TTL || '60m'

// TODO: Add /ready endpoint that has await producerReady
// and /health endpoint that checks kafka connection somehow!

async function publishReport(report) {
  const url = process.env.BOTSERVER_URL
  const json = {
    user: report.user,
    page: report.page,
    event: { type: 'machine_report', value: report }
  }

  // TODO: secure!!
  const headers = {}
  return r2.post(`${url}/synthetic`, { headers, json }).response
}

async function produce(topic, message, userid) {
  await producerReady
  const data = Buffer.from(JSON.stringify(message))
  producer.produce(topic, null, data, userid)
}

function publishState(userid, pageid, updated, state) {
  const message = { userid, pageid, updated, current_state: state.state, state_json: state }
  return produce(process.env.VLAB_STATE_TOPIC, message, userid)
}

function publishResponses(message) {
  if (!message) return
  return produce(process.env.VLAB_RESPONSE_TOPIC, message, message.userid)
}

function publishPayment(message) {
  return produce(process.env.VLAB_PAYMENT_TOPIC, message, message.userid)
}

// Does all the work
function processor(machine, stateStore) {
  return async function _processor({ key: userId, value: event }) {
    try {
      console.log('EVENT: ', event)
      const state = await stateStore.getState(userId, event)
      console.log('STATE: ', state)
      const report = await machine.run(state, userId, event)
      console.log('REPORT: ', report)

      if (report.publish) {
        await publishReport(report)
      }
      if (report.newState) {
        await publishState(report.user, report.page, report.timestamp, report.newState)
        await stateStore.updateState(userId, report.newState)
      }
      if (report.responses) {
        await publishResponses(report.responses)
      }
      if (report.payment) {
        await publishPayment(report.payment)
      }
    }
    catch (e) {
      console.error('Error from ReplyBot: \n',
        e.message,
        '\n Error occured during event: ', util.inspect(JSON.parse(event), null, 8))
      console.error(e.stack)
    }
  }
}

const NUM_SPINES = process.env.NUM_SPINES
if (!NUM_SPINES) {
  throw new Error('NUM_SPINES environment variable must be set')
}

const numSpines = parseInt(NUM_SPINES)
if (isNaN(numSpines) || numSpines < 1) {
  throw new Error('NUM_SPINES must be a positive integer')
}

process.setMaxListeners(numSpines * 3 + 5)

const supervisor = new SpineSupervisor(numSpines, 5, 5 * 60 * 1000, null, BotSpine)
supervisor.start(processor)
