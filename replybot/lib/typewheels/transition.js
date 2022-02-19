const {exec, apply, act, update} = require('./machine')
const {getForm} = require('./ourform')
const {getUserInfo, sendMessage} = require('../messenger')
const {responseVals} = require('../responses/responser')
const utils = require('@vlab-research/utils')
const {MachineIOError, iowrap} = require('../errors')
const _ = require('lodash')
const util = require('util')
const Cacheman = require('cacheman')
const {getSurveyMetadata} = require('./metadata')


function getPayment(userid, pageid, timestamp, event) {
  const payment = _.get(event, 'message.metadata.payment')
  if (!payment) return

  // todo: handle errors from bad forms until
  // form validation exists
  const {provider, details} = payment
  if (!provider) return

  return {userid, pageid, timestamp, provider, details}
}

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
    this.getSurveyMetadata = (surveyId) => {
      return cache.wrap(`surveyMetadata:${surveyId}`, () => getSurveyMetadata(surveyId), ttl)
    }
    this.getPageToken = page => {
      return cache.wrap(`pagetoken:${page}`, () => tokenStore.get(page), ttl)
    }

    this.sendMessage = sendMessage
  }

  transition(state, parsedEvent, surveyMetadata) {
    const output = exec(state, parsedEvent, surveyMetadata)
    const newState = apply(state, output)
    return {newState, output}
  }

  async actionsResponses(state, userId, timestamp, pageId, newState, output) {
    const upd = output && update(output)

    if (!newState.md) {
      throw new Error(`User without metadata: ${userId}. State: ${util.inspect(newState, null, 8)}`)
    }

    const pageToken = await iowrap('getPageToken', 'INTERNAL', this.getPageToken, pageId)
    const [form, surveyId] = await this.getFormAndSurveyId(newState, pageId)
    
    const user = await this.getUser(userId, pageToken)
    const actions = act({form, user}, state, output)
    const responses = responseVals(newState, upd, form, surveyId, pageId, userId, timestamp)

    return { actions, responses, pageToken, timestamp }
  }

  async act(actions, pageToken) {

    for (const action of actions) {
      await this.sendMessage(action, pageToken)
    }
  }

  async getFormAndSurveyId(state, page) {
    const shortcode = state.forms.slice(-1)[0]
    return await iowrap('getForm', 'INTERNAL', this.getForm, 
                        page, shortcode, state.md.startTime)
  }

  async run(state, user, rawEvent) {
    let newState, output, page, payment, surveyId, surveyMetadata
    const event = utils.parseEvent(rawEvent)
    const timestamp = event.timestamp

    if (!timestamp) {
      return { publish: true, timestamp: Date.now(), user, error: { tag: 'CORRUPTED_MESSAGE',  event }}
    }

    try {
      page = utils.getPageFromEvent(event)
      surveyId = (await this.getFormAndSurveyId(state, page))[1]
      surveyMetadata = await this.getSurveyMetadata(surveyId)
    } catch(e) {
      return {
        publish: true,
        timestamp,
        user,
        page,
        payment,
        newState,
        error: { ...e.details, tag: e.tag, message: e.message, stack: e.stack }
      }
    }

    try {
      const t = this.transition(state, event, surveyMetadata)
      newState = t.newState
      output = t.output

      payment = getPayment(user, page, timestamp, event)

      if (output.action === 'NONE') {

        // if not action, don't publish report, because the state doesn't change
        return { publish: false,
                 timestamp,
                 user,
                 page,
                 newState,
                 payment }
      }

    } catch (e) {
      return { publish: false,
               timestamp,
               user,
               page,
               error: { tag: 'STATE_TRANSITION', message: e.message, stack: e.stack, state, event }}
    }
    try {

      // Create successful report
      const {actions, pageToken, responses} = await this.actionsResponses(state, user, timestamp, page, newState, output)
      await this.act(actions, pageToken)
      return { publish: true,
               timestamp,
               user,
               page,
               actions,
               responses,
               payment,
               newState }

    } catch (e) {
      if (e instanceof MachineIOError) {
        return { publish: true,
                 timestamp,
                 user,
                 page,
                 payment,
                 newState,
                 error: { ...e.details, tag: e.tag, message: e.message, stack: e.stack }}
      } else {
        return { publish: true,
                 timestamp,
                 user,
                 page,
                 payment,
                 newState,
                 error: { tag: 'STATE_ACTIONS', message: e.message, stack: e.stack }}
      }
    }
  }
}

module.exports = { Machine }
