const { exec, apply, act, update } = require('./machine')
const { getForm } = require('./ourform')
const { getUserInfo } = require('../messenger')
const { responseVals } = require('../responses/responser')
const { parseEvent, getPageFromEvent } = require('@vlab-research/utils')
const { MachineIOError, iowrap } = require('../errors')
const _ = require('lodash')
const util = require('util')
const Cacheman = require('cacheman')
const crypto = require('crypto')


class Machine {
  constructor(ttl, tokenStore) {
    const cache = new Cacheman()
    this.cache = cache

    // add timestamp
    this.getForm = (pageid, shortcode, timestamp) => {
      return cache.wrap(`form:${pageid}:${shortcode}:${timestamp}`, () => getForm(pageid, shortcode, timestamp), ttl)
    }
    this.getUser = (id, pageToken) => {
      return cache.wrap(`user:${id}`, () => getUserInfo(id, pageToken), ttl)
    }

    this.getPageToken = page => {
      return cache.wrap(`pagetoken:${page}`, () => tokenStore.get(page), ttl)
    }
  }

  transition(state, parsedEvent) {
    const page = getPageFromEvent(parsedEvent)
    const output = exec(state, parsedEvent)
    const newState = apply(state, output)
    return { newState, output, page }
  }

  async actionsResponses(state, userId, timestamp, pageId, newState, output) {
    const upd = output && update(output)
    const shortcode = newState.forms.slice(-1)[0]

    if (!newState.md) {
      throw new Error(`User without metadata: ${userId}. State: ${util.inspect(newState, null, 8)}`)
    }
    const { startTime } = newState.md

    const pageToken = await iowrap('getPageToken', 'INTERNAL', this.getPageToken, pageId)

    const [form, surveyId, formSettings] = await iowrap('getForm', 'INTERNAL', this.getForm,
      pageId, shortcode, startTime)

    const user = await this.getUser(userId, pageToken)

    // TODO: add user to metadata???

    const { messages, payment, handoff } = act({ form, user, page: { id: pageId }, timestamp }, state, output)

    const responses = responseVals(newState, upd, form, surveyId, pageId, user, timestamp)

    return { actions: messages, responses, pageToken, timestamp, payment, handoff }
  }

  act(messages) {
    // Just return the messages — they'll be published to Kafka by run()
    return messages || []
  }

  buildCommands(messages, handoff, user, page) {
    // Build command list: messages + optional handoff
    const commands = messages.map(msg => ({
      command_id: crypto.randomBytes(8).toString('hex'),
      issued_at: Date.now(),
      conversation_id: user,
      user_id: user,
      platform: 'messenger',
      platform_account_id: page,
      message: {
        type: 'native',
        native_payload: msg  // The Facebook-native payload (recipient + message)
      }
    }))

    // If there's a handoff action, add it as a command too
    if (handoff) {
      commands.push({
        command_id: crypto.randomBytes(8).toString('hex'),
        issued_at: Date.now(),
        conversation_id: user,
        user_id: user,
        platform: 'messenger',
        platform_account_id: page,
        message: {
          type: 'pass_thread_control',
          target_app_id: handoff.target_app_id,
          handoff_metadata: JSON.stringify(handoff.metadata || {})
        }
      })
    }

    return commands
  }


  async run(state, user, rawEvent) {
    let newState, output, page
    const event = parseEvent(rawEvent)
    const timestamp = event.timestamp

    if (!timestamp) {
      return { publish: true, timestamp: Date.now(), user, error: { tag: 'CORRUPTED_MESSAGE', event } }
    }

    try {
      const t = this.transition(state, event)
      newState = t.newState
      output = t.output
      page = t.page

      if (output.action === 'NONE') {

        // if not action, don't publish report, because the state doesn't change
        return {
          publish: false,
          timestamp,
          user,
          page,
          newState
        }
      }

      if (output.action === 'RESET' || output.action === 'RESTORE_STATE') {

        // publish a report, but don't do anything else, state is reset/restored,
        // no messages or responses. For RESTORE_STATE this also deliberately skips
        // the getPageToken/getForm/getUser IO in actionsResponses -- the snapshot
        // is self-contained, so no form lookup is needed and nothing is sent to
        // the user. newState is published to the state topic and written to Redis.
        return {
          publish: true,
          timestamp,
          user,
          page,
          newState
        }
      }

    } catch (e) {
      return {
        publish: false,
        timestamp,
        user,
        page,
        error: { tag: 'STATE_TRANSITION', message: e.message, stack: e.stack, state, event }
      }
    }
    try {

      // Create successful report
      const { actions, pageToken, responses, payment, handoff } = await this.actionsResponses(state, user, timestamp, page, newState, output)

      // Get messages (act() is now synchronous)
      const messages = this.act(actions)

      // Build Kafka commands from messages and handoff
      const commands = this.buildCommands(messages, handoff, user, page)

      return {
        publish: true,
        timestamp,
        user,
        page,
        responses,
        payment,
        commands,
        newState
      }

    } catch (e) {
      if (e instanceof MachineIOError) {
        return {
          publish: true,
          timestamp,
          user,
          page,
          newState,
          error: { ...e.details, tag: e.tag, message: e.message, stack: e.stack }
        }
      }
      return {
        publish: true,
        timestamp,
        user,
        page,
        newState,
        error: { tag: 'STATE_ACTIONS', message: e.message, stack: e.stack }
      }
    }
  }
}

module.exports = { Machine }
