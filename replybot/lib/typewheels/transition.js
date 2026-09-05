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
    // The account and the platform come from THE EVENT, never from state.md.
    // `page` is what getForm() and every outbound command are built from, so a
    // state.md fallback routes a conversation's outbound messages to whichever
    // account the cached state came from.
    const page = parsedEvent.source.account_id
    if (!page) {
      // Greppable twin of EVENT_PLATFORM_GUESSED. Without this the symptom is a
      // confusing formcentral 404 for `undefined`, several layers away from the
      // producer that failed to stamp the account.
      console.warn('EVENT_ACCOUNT_MISSING', 'no account_id on event:', parsedEvent.event_type, parsedEvent.source.type)
    }
    // eventPlatform never returns 'synthetic': it reads source.type for real
    // platform events and source.platform for synthetic ones (see utils.js,
    // which is also where the missing-platform guess is logged).
    const platform = eventPlatform(parsedEvent)
    const output = exec(state, parsedEvent)
    const newState = apply(state, output)
    return { newState, output, page, platform }
  }

  async actionsResponses(state, userId, timestamp, pageId, newState, output, platform) {
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
    // conversation's platform. It arrives as an argument, derived from the
    // event by transition() -- the same rule as `page`. Never from newState.md, which
    // bleeds between a participant's conversations.
    const { messages, payment, handoff } = act({ form, user, page: { id: pageId }, timestamp, platform }, state, output)

    const responses = responseVals(newState, upd, form, surveyId, pageId, user, timestamp, platform)

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
          platform,
          newState
        }
      }

      if (output.action === 'RESET' || output.action === 'RESTORE_STATE') {

        // Publish a report, but do nothing else: the state is reset/restored, so
        // there are no messages and no responses. For RESTORE_STATE this also
        // deliberately skips the getPageToken/getForm/getUser IO in
        // actionsResponses -- the snapshot is self-contained, so no form lookup
        // is needed and nothing is sent to the participant.
        //
        // Without this arm a RESTORE_STATE falls into actionsResponses, where
        // the `!newState.md` guard throws and getForm(page, shortcode,
        // md.startTime) is exactly the lookup a damaged md fails on -- erroring
        // the participant the restore was rescuing. It was dropped by 675c31bd,
        // in a commit whose message claims it was preserved; see
        // planning/replybot-restore-state-transition-regression.md.
        return {
          publish: true,
          timestamp,
          user,
          page,
          platform,
          newState
        }
      }

    } catch (e) {
      // An error carrying its own tag routes itself, the same rule the actions
      // catch below follows. Publishing is what creates the error state: the
      // report goes back through Kafka and machine.js turns `report.error` into
      // action ERROR, which fills states.error_tag and feeds survey_error_states
      // — the metric the arrival-health alerts read. A tagged failure that is
      // not published is recorded nowhere.
      //
      // An untagged error is an unclassified crash: it takes the generic
      // STATE_TRANSITION tag and is not published, carrying the state and event
      // that produced it for debugging instead.
      if (e.tag) {
        return {
          publish: true,
          timestamp,
          user,
          page,
          error: { ...(e.details || {}), tag: e.tag, message: e.message, stack: e.stack }
        }
      }

      return {
        publish: false,
        timestamp,
        user,
        page,
        platform,
        error: { tag: 'STATE_TRANSITION', message: e.message, stack: e.stack, state, event }
      }
    }
    try {

      const { actions, responses, payment, handoff } = await this.actionsResponses(state, user, timestamp, page, newState, output, platform)

      const messages = this.act(actions)

      const commands = this.buildCommands(messages, handoff, user, page, platform)

      return {
        publish: true,
        timestamp,
        user,
        page,
        platform,
        responses,
        payment,
        commands,
        newState
      }

    } catch (e) {
      // Any error carrying its own tag routes itself -- MachineIOError, and the
      // study-config errors in form.js. STATE_ACTIONS is the untagged catch-all
      // and is read downstream as "platform fault", so only put things there
      // that really are ours.
      const tag = e.tag || 'STATE_ACTIONS'
      // Preserve MachineIOError details (e.g. status:404 for FORM_NOT_FOUND) on
      // the published error, matching main. The error report is fed back through
      // the machine, which transitions the user to the ERROR state.
      const details = (e instanceof MachineIOError && e.details) ? e.details : {}
      return {
        publish: true,
        timestamp,
        user,
        page,
        platform,
        newState,
        error: { ...details, tag, message: e.message, stack: e.stack }
      }
    }
  }
}

module.exports = { Machine }
