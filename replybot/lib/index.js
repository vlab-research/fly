const util = require('util')

const { BotSpine } = require('@vlab-research/botspine')

const { producer, producerReady } = require('./producer')
const { SpineSupervisor } = require('./spine-supervisor/spine-supervisor')
const { conversationFromRawEvent } = require('./typewheels/utils')
const KAFKA_COMMANDS_TOPIC = process.env.KAFKA_COMMANDS_TOPIC || 'commands'

// TODO: Add /ready endpoint that has await producerReady
// and /health endpoint that checks kafka connection somehow!

async function publishReport(report, conv) {
  const url = process.env.BOTSERVER_URL

  // The envelope is the source for the conversation we post this report back into.
  // `report.page`/`report.platform` are a fallback ONLY here, on the outbound side:
  // the /synthetic contract requires the triple, so posting a slightly less-trusted
  // name beats posting a null one. The cache key takes no such fallback -- there a
  // wrong name is a poisoned conversation.
  const account_id = (conv && conv.account) || report.page || null
  const platform = (conv && conv.platform) || report.platform || null

  // Log warnings when components are missing, so they surface in pod logs
  // during the rollout window before the 400 gate is turned on.
  if (!account_id) {
    console.warn('MISSING_CONVERSATION_ON_REPORT account_id missing for user', report.user)
  }
  if (!platform) {
    console.warn('MISSING_CONVERSATION_ON_REPORT platform missing for user', report.user)
  }

  const json = {
    user: report.user,
    account_id,
    platform,
    event: { type: 'machine_report', value: report }
  }

  // TODO: secure!!
  return fetch(`${url}/synthetic`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Vlab-Poster': 'replybot'
    },
    body: JSON.stringify(json),
  })
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

function publishCommands(commands) {
  if (!commands || commands.length === 0) return
  for (const cmd of commands) {
    produce(KAFKA_COMMANDS_TOPIC, cmd, cmd.user_id)
  }
}


// Does all the work
function processor(machine, stateStore) {
  return async function _processor({ key: userId, value: event }) {
    try {
      console.log('EVENT: ', event)

      // The conversation this event belongs to -- (platform, account_id) from
      // the envelope, user id from the Kafka key. This parses the event a second
      // time (machine.run parses it again below) and that is deliberate: it
      // keeps machine.run's CORRUPTED_MESSAGE contract intact, and a JSON.parse
      // is cheap next to the Redis round trip it guards.
      const conv = conversationFromRawEvent(event)

      const state = await stateStore.getState(conv, userId, event)
      console.log('STATE: ', state)
      const report = await machine.run(state, userId, event)
      console.log('REPORT: ', report)

      if (report.publish) {
        await publishReport(report, conv)
      }
      if (report.newState) {
        await publishState(report.user, report.page, report.timestamp, report.newState)
        await stateStore.updateState(conv, userId, report.newState)
      }
      if (report.responses) {
        await publishResponses(report.responses)
      }
      if (report.payment) {
        await publishPayment(report.payment)
      }
      if (report.commands && report.commands.length > 0) {
        await publishCommands(report.commands)
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
