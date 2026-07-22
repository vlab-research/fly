const { exec, apply, act, update } = require('./machine')
const { eventPlatform } = require('./utils')
const { getForm } = require('./ourform')
const { responseVals } = require('../responses/responser')
const { parseEvent } = require('../event-normalizer')
const { iowrap, MachineIOError } = require('../errors')
const util = require('util')
const Cacheman = require('cacheman')
const crypto = require('crypto')


class Machine {
  constructor(ttl) {
    const cache = new Cacheman()
    this.cache = cache

    this.getForm = (pageid, shortcode, timestamp) => {
      return cache.wrap(`form:${pageid}:${shortcode}:${timestamp}`, () => getForm(pageid, shortcode, timestamp), ttl)
    }
  }

  transition(state, parsedEvent) {
    // Synthetic/external events (payment results, bailouts, moviehouse events)
    // may not carry the page on the event itself. The conversation's page is
    // authoritative and stable, so fall back to the persisted state metadata —
    // otherwise getForm() is called with an undefined pageid and the flow errors.
    const page = parsedEvent.source.account_id || (state && state.md && state.md.pageid)
    // A synthetic/external event's source.type is 'synthetic', not a real
    // platform. Outbound commands must target the conversation's actual platform
    // or message-worker rejects them as "unsupported platform". md.platform is
    // persisted at conversation start (utils.js getMetadata), so the state is
    // authoritative. For states predating that persistence, fall back to the
    // event's own platform hint when present (source.platform, sent by dean and
    // surfaced by the event-normalizer), else 'messenger' — exact for all
    // conversations predating WhatsApp support.
    const platform = parsedEvent.source.type === 'synthetic'
      ? ((state && state.md && state.md.platform) || eventPlatform(parsedEvent))
      : parsedEvent.source.type
    const output = exec(state, parsedEvent)
    const newState = apply(state, output)
    return { newState, output, page, platform }
  }

  async actionsResponses(state, userId, timestamp, pageId, newState, output) {
    const upd = output && update(output)
    const shortcode = newState.forms.slice(-1)[0]

    if (!newState.md) {
      throw new Error(`User without metadata: ${userId}. State: ${util.inspect(newState, null, 8)}`)
    }
    const { startTime } = newState.md

    const [form, surveyId] = await iowrap('getForm', 'INTERNAL', this.getForm,
      pageId, shortcode, startTime)

    const user = { id: userId }

    // Payment events are consumed off-pipeline (dinersclub) and carry the
    // conversation's platform. newState.md.platform is persisted at
    // conversation start; 'messenger' is exact for states predating that.
    const platform = (newState.md && newState.md.platform) || 'messenger'

    const { messages, payment, handoff } = act({ form, user, page: { id: pageId }, timestamp, platform }, state, output)

    const responses = responseVals(newState, upd, form, surveyId, pageId, user, timestamp)

    return { actions: messages, responses, timestamp, payment, handoff }
  }

  act(messages) {
    return (messages || []).map(({ token, ...messageContent }) => ({
      message: messageContent,
      token: token || null
    }))
  }

  buildCommands(messages, handoff, user, page, platform) {
    const commands = messages.map(({ message, token }) => ({
      type: 'send_message',
      command_id: crypto.randomBytes(8).toString('hex'),
      issued_at: Date.now(),
      conversation_id: user,
      user_id: user,
      platform: platform,
      platform_account_id: page,
      message: message,
      ...(token ? { platform_context: { one_time_notif_token: token } } : {})
    }))

    if (handoff) {
      commands.push({
        type: 'handoff',
        command_id: crypto.randomBytes(8).toString('hex'),
        issued_at: Date.now(),
        user_id: user,
        platform: platform,
        platform_account_id: page,
        target_app_id: handoff.target_app_id,
        metadata: handoff.metadata || {}
      })
    }

    return commands
  }


  async run(state, user, rawEvent) {
    let newState, output, page, platform

    let event
    try {
      event = parseEvent(rawEvent)
    } catch (e) {
      return { publish: true, timestamp: Date.now(), user, error: { tag: 'CORRUPTED_MESSAGE', message: e.message } }
    }

    const timestamp = event.timestamp

    if (!timestamp) {
      return { publish: true, timestamp: Date.now(), user, error: { tag: 'CORRUPTED_MESSAGE', event } }
    }

    try {
      const t = this.transition(state, event)
      newState = t.newState
      output = t.output
      page = t.page
      platform = t.platform

      if (output.action === 'NONE') {
        return {
          publish: false,
          timestamp,
          user,
          page,
          newState
        }
      }

      if (output.action === 'RESET') {
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

      const { actions, responses, payment, handoff } = await this.actionsResponses(state, user, timestamp, page, newState, output)

      const messages = this.act(actions)

      const commands = this.buildCommands(messages, handoff, user, page, platform)

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
      const tag = (e instanceof MachineIOError) ? e.tag : 'STATE_ACTIONS'
      // Preserve MachineIOError details (e.g. status:404 for FORM_NOT_FOUND) on
      // the published error, matching main. The error report is fed back through
      // the machine, which transitions the user to the ERROR state.
      const details = (e instanceof MachineIOError && e.details) ? e.details : {}
      return {
        publish: true,
        timestamp,
        user,
        page,
        newState,
        error: { ...details, tag, message: e.message, stack: e.stack }
      }
    }
  }
}

module.exports = { Machine }
