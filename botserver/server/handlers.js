const util = require('util')
const { getUserFromEvent } = require('@vlab-research/utils')

const normalizeTimestamp = (t) => {
  // 2020 in milliseconds
  if (t < 1577836800000) {
    // Assume it's in seconds, so make it milliseconds
    return t * 1000
  }
  return t
}

const verifyToken = ctx => {
  if (ctx.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
    ctx.body = ctx.query['hub.challenge']
    ctx.status = 200
  } else {
    ctx.body = 'invalid verify token'
    ctx.status = 401
  }
}

// TODO: Add validation with APP SECRET!!!
const handleMessengerEvents = async (ctx, producer, producerReady, eventTopic) => {
  await producerReady

  for (const entry of ctx.request.body.entry) {
    try {
      console.log(util.inspect(entry, null, 8))

      // Process all event types (messaging and messaging_handovers)
      const eventTypes = ['messaging', 'messaging_handovers']
      
      for (const eventType of eventTypes) {
        if (entry[eventType]) {
          for (const eventData of entry[eventType]) {
            const event = { ...eventData, source: 'messenger' }
            event.timestamp = normalizeTimestamp(event.timestamp)
            const user = getUserFromEvent(event)
            const data = Buffer.from(JSON.stringify(event))
            producer.produce(eventTopic, null, data, user)
          }
        }
      }

    } catch (error) {
      console.error('[ERR] handleEvents: ', error)
    }
  }
  ctx.status = 200
}

// TODO: move into another service?
// TODO: secure!
const handleSyntheticEvents = async (ctx, producer, producerReady, eventTopic) => {
  await producerReady

  try {
    const { body } = ctx.request
    console.log(util.inspect(body, null, 8))

    // TODO: timestamp is all over the place right now.
    // FB sends a timestamp, then Botserver makes the timestamp for synthetic
    // events. So far, so good.
    // However then Scribble takes the kafka timestamp, which
    // is good because then it's replied in the same order its recieved

    // but then what should report.timestamp have?

    const message = { ...body, source: 'synthetic', timestamp: Date.now() }
    const data = Buffer.from(JSON.stringify(message))

    if (!message.user) {
      console.log(body)
      throw new Error('No user!')
    }

    // message.page

    producer.produce(eventTopic, null, data, message.user)
    ctx.status = 200
  } catch (error) {
    console.error(error)
    ctx.status = 500
  }
}

module.exports = {
  handleMessengerEvents,
  handleSyntheticEvents,
  verifyToken,
  normalizeTimestamp
}
