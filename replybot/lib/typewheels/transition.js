const { exec, apply, act, update,
  DEFER_SYNTHETIC_NO_CONVERSATION,
  DEFER_FALLBACK_ENTRY_ON_LIVE_CONVERSATION } = require('./machine')
const { eventPlatform } = require('./utils')
const { getForm } = require('./ourform')
const { responseVals } = require('../responses/responser')
const { parseEvent } = require('../event-normalizer')
const { iowrap, MachineIOError } = require('../errors')
const util = require('util')
const Cacheman = require('cacheman')
const crypto = require('crypto')

// The greppable tag for "a synthetic event arrived for a conversation that is not
// there". It is the whole instrument for this failure mode -- nothing is written
// to `states` and nothing reaches a dashboard -- so it is emitted exactly once
// per deferred event and nothing else in the codebase may use this string.
//
// A non-zero count means one of two things, and the logged `page`/`platform` tell
// them apart:
//   - the scribble messages sink is behind live traffic (the account is right and
//     the participant has a real conversation on it), or
//   - the event named an account the conversation does not live on -- a
//     researcher-authored webview `pageid` (plan §8.4).
// Neither is tolerable steady state; both are invisible without this line.
const SYNTHETIC_NO_CONVERSATION_TAG = DEFER_SYNTHETIC_NO_CONVERSATION

// The greppable tag for "an entry event that names no form arrived on a
// conversation that already has one". Same role as the tag above and the same
// reason for existing: the fix is a refusal, so nothing is written to `states`,
// nothing reaches a dashboard, and the log line is the ONLY way to measure the
// rate after deploy. Emitted exactly once per refused event; nothing else in the
// codebase may use this string.
//
// A non-zero count is expected and is the point -- it is the live rate of the
// defect that used to switch these participants onto FALLBACK_FORM (3,732
// historical `states` rows). The logged `state`/`form` say which conversation was
// protected, so the count can be split into the ad-click race (`state:
// "RESPONDING"`, arriving 1-4s after a referral) and re-engagement (`state:
// "END"`). It should fall roughly to the historical 10-90/month, not to zero.
//
// The historical population, and the detector for new ones, is in
// documentation/referral-form-resolution.md ("A form-less entry event may not
// re-enter a live conversation").
const FALLBACK_ENTRY_ON_LIVE_CONVERSATION_TAG = DEFER_FALLBACK_ENTRY_ON_LIVE_CONVERSATION


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
    //
    // Both used to fall back to the persisted metadata -- `state.md.pageid` and
    // `state.md.platform`. That is the same defect as the user-keyed state cache
    // (§7.1), one layer down, and worse in consequence: `page` is what getForm()
    // and every outbound command are built from, so a conversation served a
    // cached state from another account routed its *outbound* messages to the
    // other researcher's page. Synthetic events now carry the account and the
    // platform (§7.3.1), so there is nothing left to recover.
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
    // event by transition() -- the same rule as `page`. It used to be read from
    // newState.md.platform, which is a field that bleeds between conversations.
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

      // DEFER: the machine refused to interpret this event (a synthetic event
      // against a conversation that replayed as START -- machine.js
      // `_handleExternalEvent`). Return WITHOUT `newState`, which is the whole
      // mechanism: lib/index.js publishes state and writes the Redis key only
      // `if (report.newState)`, so omitting it means
      //
      //   - nothing is UPSERTed into `chatroach.states`, and
      //   - nothing is written to the state cache.
      //
      // Both matter. `scribble/state.go` writes with a bare UPSERT, so ANY state
      // we publish here overwrites the conversation's real row -- and that row is
      // the substrate every recovery sweep reads. Dean's `Timeouts()` re-fires
      // only while `current_state = 'WAIT_EXTERNAL_EVENT'` and `Payments()` only
      // while the same holds, so writing a START row (or an ERROR row) in place of
      // it does not merely lose this event, it destroys the retry that would have
      // re-delivered it. Leaving `states` alone IS the retry path:
      //
      //   | Producer | Recovery after a DEFER |
      //   |---|---|
      //   | dean `timeout`  | `Timeouts()` re-fires; cron */10min, window DEAN_TIMEOUT_MAX_PAST=72h, attempt cap counts only externalEvents entries actually recorded -- a DEFER records none |
      //   | dinersclub payment result | dean `Payments()` re-issues `repeat_payment` after DEAN_PAYMENT_GRACE=2h; cron every 6h, cap 30 |
      //   | moviehouse video | the webview heartbeats again within HEARTBEAT_INTERVAL_MS (30s) |
      //   | linksniffer click | NO retry -- the click analytic is lost. Still strictly better than switching the participant onto FALLBACK_FORM |
      //
      // Deliberately NOT an ERROR state with a retryable tag. That was the
      // obvious-looking design and it is worse three ways: it clobbers the row
      // above; a new tag is not in DEAN_ERROR_TAGS so nothing sweeps it (the
      // FIELD_NOT_FOUND lesson, devops/values/production.yaml); and even in the
      // tag set, dean's redo re-reads a CACHED corrupt state and re-fails forever
      // (the same file records a sweep of 40 participants recovering exactly
      // zero). See planning/conversation-identity.md §7.1 (CORRECTED).
      //
      // `publish: false` keeps this off the machine_report path too -- a report
      // would be posted back through /synthetic as another synthetic event, and
      // publishing one for an event we just declined to interpret is a loop with
      // nothing at the end of it.
      //
      // TWO REASONS, TWO TAGS. Both are the same refusal and take the same exit,
      // but they are separate failure modes with separate rates -- and the
      // synthetic one is the entire instrument for the §7.1 canary ("watch 24h,
      // expect zero"), so it must not be inflated by a defect that is expected to
      // register non-zero. The lines are emitted separately rather than through a
      // shared formatter so the synthetic line stays byte-identical to what
      // documentation/states-debugging.md documents.
      if (output.action === 'DEFER') {
        if (output.reason === FALLBACK_ENTRY_ON_LIVE_CONVERSATION_TAG) {
          console.warn(FALLBACK_ENTRY_ON_LIVE_CONVERSATION_TAG,
            'refusing to re-enter a live conversation on FALLBACK_FORM; dropping the entry event',
            JSON.stringify({
              user,
              page: page || null,
              platform: platform || null,
              event_type: output.event_type || event.event_type,
              state: state.state,
              form: (state.forms && state.forms.slice(-1)[0]) || null
            }))
        } else {
          console.warn(SYNTHETIC_NO_CONVERSATION_TAG,
            'refusing to blank-start FALLBACK_FORM from a synthetic event; dropping it',
            JSON.stringify({
              user,
              page: page || null,
              platform: platform || null,
              event_type: output.event_type || event.event_type
            }))
        }

        return { publish: false, timestamp, user, page, platform }
      }

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

      if (output.action === 'RESET') {
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

module.exports = { Machine, SYNTHETIC_NO_CONVERSATION_TAG, FALLBACK_ENTRY_ON_LIVE_CONVERSATION_TAG }
