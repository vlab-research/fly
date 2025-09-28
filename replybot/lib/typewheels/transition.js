const { exec, apply, act, update } = require('./machine')
const { getForm } = require('./ourform')
const { getUserInfo, sendMessage, passThreadControl } = require('../messenger')
const { responseVals } = require('../responses/responser')
const { parseEvent, getPageFromEvent } = require('@vlab-research/utils')
const { MachineIOError, iowrap } = require('../errors')
const _ = require('lodash')
const util = require('util')
const Cacheman = require('cacheman')


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

    this.sendMessage = sendMessage
    this.passThreadControl = passThreadControl
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

  async act(messages, pageToken) {

    for (const action of messages) {

      await this.sendMessage(action, pageToken)

    }
  }

  async handoff(handoff, pageToken) {
    await this.passThreadControl(handoff.userid, handoff.target_app_id, handoff.metadata, pageToken)
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

      if (output.action === 'RESET') {

        // publish a report, but don't do anything else, state is reset, no messages or responses
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

      await this.act(actions, pageToken)
      

      // Process handoff
      if (handoff) {
        await this.handoff(handoff, pageToken)
      }

      return {
        publish: true,
        timestamp,
        user,
        page,
        actions,
        responses,
        payment,
        handoff,
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
      } else {
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
}

module.exports = { Machine }
