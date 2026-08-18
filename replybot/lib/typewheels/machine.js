const util = require('util')
const _ = require('lodash')
const { getForm, getMetadata, _group } = require('./utils')
const { validator, defaultMessage, followUpMessage, offMessage } = require('../generic-validator')
const { translateField, getField, getNextField, addCustomType, interpolateField } = require('./form')
const { waitConditionFulfilled } = require('./waiting')



function _eventMetadata(prefix, value) {
  if (typeof value !== 'object' || value == null) return { [prefix]: value }

  return _.toPairs(value)
    .filter(([k, __]) => k !== 'type')
    .filter(([__, v]) => v !== undefined)
    .reduce((d, [k, v]) => ({ ...d, ..._eventMetadata(`${prefix}_${_.snakeCase(k)}`, v) }), {})
}

function makeEventMetadata(event) {
  if (event.event_type === 'handover') {
    const { previous_owner_app_id, metadata } = event.payload
    let parsed = {}

    if (metadata) {
      try {
        // Wrap under `metadata` to preserve the production flattening contract:
        // main's pipeline (recursiveJSONParser) pre-parsed this string into an
        // object, so its JSON.parse threw and the catch below wrapped the payload
        // — flattened keys have always been e_handover_metadata_* in production
        // and live surveys reference them. Don't flatten one level shallower.
        parsed = { metadata: JSON.parse(metadata) }
      } catch (e) {
        parsed = { metadata }
      }
    }

    const prefix = 'e_handover'

    return _eventMetadata(prefix, {
      target_app_id: previous_owner_app_id,
      ...parsed
    })
  }

  if (event.source && event.source.type === 'synthetic' && event.event_type === 'synthetic_external') {
    const value = event.payload
    if (!value || !value.type) return

    const base = value.type.split(':').join('_')
    const prefix = `e_${base}`

    return _eventMetadata(prefix, value)
  }

  return undefined
}

function repeatResponse(question, text) {
  if (!text) {
    throw new TypeError(`Repeat response attempted without valid text: ${text}\nquestion: ${question}`)
  }

  return {
    type: 'text',
    text,
    metadata: { repeat: true, ref: question }
  }
}


function offResponse(previousQuestion, text) {

  return {
    type: 'text',
    text,
    metadata: { off: true, ref: previousQuestion }
  }
}


function getWatermark(event) {
  if (event.event_type === 'bot_message_read') {
    return { type: 'read', mark: event.payload.watermark }
  }
  if (event.event_type === 'bot_message_delivered') {
    return { type: 'delivery', mark: event.payload.watermark }
  }
  return undefined
}


function _hasForm(state, form) {
  return state.forms.indexOf(form) !== -1
}

function _currentUserIsReferrer(event) {
  const md = getMetadata(event)
  return '' + event.user_id === md.referrer
}


// Pure, total. Did this event come in through /synthetic rather than off a
// messaging platform? `source.type` is set once, by the event-normalizer:
// 'messenger' | 'whatsapp' for real platform events, 'synthetic' for POSTed
// ones (event-normalizer.js `parseSyntheticEvent`). A synthetic event's real
// transport lives on `source.platform`, so `source.type` is a clean
// discriminator and never overlaps with a platform.
function _isSynthetic(event) {
  return !!(event && event.source && event.source.type === 'synthetic')
}


// WHY a DEFER happened.
//
// To the FOLD both reasons mean one thing -- "this event cannot be interpreted
// against this state" -- and `apply` treats them identically. To whoever is
// watching production they are different failures with different rates and
// different owners, so `transition.js` turns each into its own greppable tag and
// its own log line. They are string constants rather than free text for the same
// reason the tags themselves are: each one is the entire instrument for a failure
// mode that is otherwise silent, so nothing else in the codebase may use these
// strings.
//
// They live here, not in transition.js, because `exec` is what decides them, and
// transition.js already imports from this module (the reverse would be a cycle).
const DEFER_SYNTHETIC_NO_CONVERSATION = 'SYNTHETIC_EVENT_NO_CONVERSATION'
const DEFER_FALLBACK_ENTRY_ON_LIVE_CONVERSATION = 'FALLBACK_ENTRY_ON_LIVE_CONVERSATION'


// Pure, total. Did this entry event NAME a form, or is its form about to come
// from FALLBACK_FORM?
//
// This is a question about the REF, deliberately not about the resolved form.
// `getForm(event) === process.env.FALLBACK_FORM` reads as the obvious equivalent
// and is wrong: a ref may name the fallback shortcode EXPLICITLY, and production
// has such refs -- `?ref=form.305.country.iraq` on the Iraq vaccination page,
// three live `states` rows. Those are real referrals and must keep switching a
// live participant's form like any other referral. Only an entry that names no
// form at all is refused below.
//
// Mirrors `getMetadata`'s own extraction (utils.js) exactly: the same
// `r && r.ref` guard and the same `_group(split('.').map(decodeURIComponent))`,
// with `_group` REUSED rather than reimplemented -- so the two cannot come to
// different conclusions about whether a ref carries a form, and the even-token-
// boundary rule (`creative.form.ABC` names no form) is automatically the same one.
//
// Total by construction: a malformed ref answers "no form", which routes to the
// conservative branch rather than throwing on the hot path.
function _refNamesForm(event) {
  try {
    if (event.event_type !== 'conversation_started') return false

    const r = event.payload && event.payload.referral
    if (!r || !r.ref) return false

    return _group(r.ref.split('.').map(decodeURIComponent)).form !== undefined
  } catch (e) {
    return false
  }
}

function _handleExternalEvent(state, nxt, includeMetadata = false) {
  // In START there is no conversation to attach this to, and no md. Start a
  // form, as TEXT/MEDIA do -- otherwise makeEventMetadata() gets merged into a
  // missing md ({ ...undefined, ...{...} }), producing a truthy husk with no
  // startTime that passes transition.js's `!md` guard and then throws in
  // getForm.
  //
  // ...but ONLY for a real platform event. The two callers are not equivalent:
  //
  //   HANDOVER_EVENT  -- a Messenger thread-control passback. A genuine
  //     first-contact event: an ad click emits the handover ~1.5s BEFORE the
  //     quick_reply carrying the referral, so blank-starting FALLBACK_FORM here
  //     and letting the referral switch forms afterwards is the designed
  //     behaviour (documentation/referral-form-resolution.md §6b).
  //
  //   EXTERNAL_EVENT  -- a SYNTHETIC event: a dean `timeout`, a dinersclub
  //     payment result, a linksniffer click, a moviehouse video event. Every one
  //     of these exists only BECAUSE a conversation already exists -- dean
  //     selects from a `states` row in WAIT_EXTERNAL_EVENT, a payment result
  //     requires an issued payment, a click or a video event requires a field to
  //     have been rendered and sent. So `state === 'START'` here is
  //     self-contradictory. It does not mean "new participant"; it means the log
  //     we just replayed is not this conversation's log -- either the scribble
  //     messages sink has not archived it yet (replybot and scribble consume
  //     `chat-events` in parallel, so scribble is systematically behind for a
  //     brand-new conversation), or the account the event named is not the
  //     account the conversation lives on (linksniffer and moviehouse read a
  //     researcher-authored `pageid` out of a webview URL; see plan §8.4).
  //
  // Neither of those is a reason to enter a survey, and entering one is not
  // untidy but severe: FALLBACK_FORM is a real, live survey belonging to another
  // researcher whose misrouted participants look like completions, which is the
  // exact failure signature of VIR-19 and of the CTWA defect in the plan's
  // Appendix A. So we DEFER instead: fold to nothing, publish nothing, cache
  // nothing, and let the producer's own sweep re-deliver the event once the log
  // is whole. See planning/conversation-identity.md §7.1 (CORRECTED).
  if (state.state === 'START') {
    if (_isSynthetic(nxt)) {
      return {
        action: 'DEFER',
        reason: DEFER_SYNTHETIC_NO_CONVERSATION,
        event_type: nxt.event_type
      }
    }
    return _blankStart(nxt)
  }

  const externalEvents = [...(state.externalEvents || []), nxt]
  const md = includeMetadata ? makeEventMetadata(nxt) : null

  if (state.state !== 'WAIT_EXTERNAL_EVENT') {
    const stateUpdate = { externalEvents }
    if (md) {
      stateUpdate.md = { ...state.md, ...md }
    }
    return {
      action: 'UPDATE_STATE',
      stateUpdate
    }
  }

  const fulfilled = waitConditionFulfilled(state.wait, externalEvents, state.waitStart)

  if (!fulfilled) {
    const result = {
      action: 'WAIT_EXTERNAL_EVENT',
      question: state.question,
      wait: state.wait,
      waitStart: state.waitStart,
      externalEvents
    }
    if (md) {
      result.md = md
    }
    return result
  }

  return tokenWrap(state, nxt, {
    action: 'RESPOND',
    stateUpdate: { wait: null, waitStart: null },
    question: state.question,
    validation: { valid: true },
    response: null,
    ...(md && { md })
  })
}


function categorizeEvent(nxt) {
  const et = nxt.event_type

  if (et === 'conversation_started') return 'REFERRAL'
  if (et === 'optin') return 'OPTIN'
  if (et === 'synthetic_unblock') return 'UNBLOCK'
  if (et === 'synthetic_follow_up') return 'FOLLOW_UP'
  if (et === 'synthetic_repeat_payment') return 'REPEAT_PAYMENT'
  if (et === 'synthetic_redo') return 'REDO'
  if (et === 'synthetic_platform_response') return 'PLATFORM_RESPONSE'
  if (et === 'synthetic_machine_report') return 'MACHINE_REPORT'
  if (et === 'synthetic_bailout') return 'BAILOUT'
  if (et === 'synthetic_block_user') return 'BLOCK_USER'
  if (et === 'synthetic_restore_state') return 'RESTORE_STATE'
  if (et === 'handover') return 'HANDOVER_EVENT'
  if (et === 'synthetic_timeout' || et === 'synthetic_external') return 'EXTERNAL_EVENT'
  if (et === 'bot_message_read' || et === 'bot_message_delivered') return 'WATERMARK'
  if (et === 'bot_message_sent') return 'ECHO'
  if (et === 'user_interaction' && nxt.payload && nxt.payload.interaction_type === 'postback') return 'POSTBACK'
  if (et === 'user_interaction' && nxt.payload && nxt.payload.interaction_type === 'quick_reply') return 'QUICK_REPLY'
  if (et === 'user_text') return 'TEXT'
  if (et === 'user_media') return 'MEDIA'
  if (et === 'user_reaction') return 'REACTION'

  console.log(`Machine could not categorize event!
        	       \nEvent: ${util.inspect(nxt, null, 8)}`)

  return 'UNKNOWN'

}

function _noop() {
  return { action: 'NONE' }
}

function _isHandoffWait(state) {
  return state.state === 'WAIT_EXTERNAL_EVENT' && state.wait && state.wait.type === 'handover'
}

function _repeat(state, message) {
  return {
    action: 'RESPOND',
    question: state.question,
    validation: { valid: false, message },
    response: null
  }
}

function _blankStart(event) {
  return {
    action: 'SWITCH_FORM',
    form: getForm(event),
    md: getMetadata(event)
  }
}

// reset form
// form: getForm(event)
// + initialState...

function _stitch(state, stitch, nxt) {

  // retains metadata (seed)
  // and metadata (form) -- which is the initial form
  // but creates new startTime in metedata.
  // TODO: clean this up, differentiate between "permanent"
  // and "temporary" metadata.
  return tokenWrap(state, nxt, {
    action: 'SWITCH_FORM',
    stateUpdate: { tokens: state.tokens },
    form: stitch.form,
    md: { ...state.md, ...stitch.metadata, startTime: nxt.timestamp }
  })
}

function tokenWrap(state, nxt, output) {

  if (!state.wait) return output

  if (!state.wait.notifyPermission || !state.tokens) {
    return output
  }

  const [token, ...tokens] = state.tokens

  return { ...output, token, stateUpdate: { ...output.stateUpdate, tokens } }
}

// Persist only the minimal error onto the live state: what it is (tag/code),
// a human message, and WHEN it occurred (ts). The full context — stack, the
// pre-error state snapshot, the triggering event — stays on the machine_report
// event (→ messages → the errors projection); we don't duplicate it onto the
// hot `states` row (which keeps rows small and feeds the error_tag/fb_error_code
// computed columns from tag/code).
//
// `ts` is the occurrence time (the triggering event's timestamp), stamped once
// per error EPISODE rather than once per error event: a genuine recovery ends
// the episode so the next error gets a fresh ts, while a Dean retry that
// re-fails keeps the original onset. That makes `errored_at` an honest "when
// did this user break", immune to retry churn.
function thinError(err, onset, ts) {
  return {
    tag: err.tag,
    code: err.code,
    message: err.message,
    ts: onset || ts,
  }
}

// The onset of the error episode currently in flight, if there is one.
//
// While the user sits in ERROR/BLOCKED it lives on `state.error.ts`. A Dean
// retry (REDO → RESPOND_AGAIN) blips the user through RESPONDING, where an
// `error` must NOT linger — a lingering error makes a state that is not
// currently broken look broken in the Monitor view and in the
// error_tag/fb_error_code computed columns (fix 57bc567e). So the retry drops
// the error but parks the onset on `state.errorOnset`: a bare timestamp, no
// tag/code, invisible to those columns, with exactly the same lifetime as
// `retries` (the other piece of retry-episode bookkeeping RESPONDING keeps).
//
// If the retry re-fails, the onset comes back out of `errorOnset` and the
// episode continues with its original ts. If the retry succeeds, the
// transition that proves it (WAIT_RESPONSE/HANDOFF/WAIT_EXTERNAL_EVENT/END, or
// the user answering: RESPOND) clears `errorOnset` along with the other
// transient fields, so the episode is genuinely over.
function episodeOnset(state) {
  return (state.error && state.error.ts) || state.errorOnset
}

function exec(state, nxt) {
  switch (categorizeEvent(nxt)) {

    case 'REFERRAL': {

      const form = getForm(nxt)

      if (form === process.env.REPLYBOT_RESET_SHORTCODE) {
        return { action: "RESET", stateUpdate: { pointer: nxt.timestamp } }
      }

      // Blocked users cannot start new forms
      if (state.state === 'USER_BLOCKED') return _noop()

      // if current form in entire history of forms, repeat previous question
      if (_hasForm(state, form)) {
        if (state.state === 'QOUT') return _repeat(state)
        return _noop()
      }

      // if form is in ignore_form, ignore the referral.


      // ignore referral if the person is the referrer
      // this is useful for sharing
      if (_currentUserIsReferrer(nxt)) return _noop()

      // FALLBACK_FORM MAY START A CONVERSATION. IT MAY NEVER RE-ENTER ONE.
      //
      // An entry event that names no form resolves to FALLBACK_FORM (§6 of
      // documentation/referral-form-resolution.md). Two shapes reach here:
      // Messenger's bare `get_started` postback, which the normalizer maps to
      // `conversation_started` with `referral: undefined`, and a referral whose
      // ref carries no `form` pair (`clickToMessengerAds`, `homescreenpwa`, a
      // CTWA referral object with no `ref` at all).
      //
      // Until now this case blank-started at ANY state -- alone among the entry
      // paths, because TEXT/MEDIA/QUICK_REPLY/POSTBACK all guard on
      // `state.state === 'START'`. The REFERRAL case does not, deliberately: a
      // referral naming a form is SUPPOSED to switch a live participant onto it.
      // That rule is right for a ref that names a form and catastrophic for an
      // entry that names none, because `_blankStart` then pushes FALLBACK_FORM
      // onto a live conversation's stack and replaces `md` wholesale.
      //
      // Measured in production 2026-08-17, and it is not a corner: 3,732 `states`
      // rows have FALLBACK_FORM appended to an existing stack, continuously from
      // 2020-06 to now at 10-90/month. Replaying 561 of their real logs through
      // this machine puts them, at the moment of the append, in END (50%), QOUT
      // (22%), RESPONDING (14%), WAIT_EXTERNAL_EVENT (7%), BLOCKED (6%) and ERROR
      // -- 44% mid-survey. 96% were appended by a bare `get_started`. `305` is a
      // real live survey belonging to another researcher, so the participants
      // whose answers land on it look like completions rather than errors: on the
      // `ecd` page a language answer was recorded as `shortcode:'305',
      // question_ref:'end'` and the participant was told "Sorry, I can't accept
      // any responses now."
      //
      // THE DISCRIMINATOR IS "THE CONVERSATION ALREADY HAS A FORM", not
      // `state.state !== 'START'`. The two agree on every row measured -- all
      // 3,732 appends were onto a non-empty stack, and all 450 replayed genuine
      // fallback entries happened on the first event the machine acted on, so
      // `forms: []` and `state: 'START'` coincided there -- and `forms.length` is
      // the safer of the two in the states where they can diverge. A conversation
      // can sit in a non-START state with an empty stack (a machine_report error
      // arriving before entry leaves `ERROR` with `forms: []`), and refusing entry
      // there would strand a participant who has no conversation at all. The
      // converse divergence, `START` with a non-empty stack, is reachable through
      // RESTORE_STATE, and that participant genuinely does have a conversation.
      //
      // ENTRY IS PRESERVED, AND THAT IS THE POINT. 162,148 `states` rows are
      // FALLBACK_FORM conversations with a length-1 stack; replaying a
      // 452-conversation sample shows what enters them: plain text 42%,
      // `get_started` 35%, media 18%, referral-without-a-form 3%, quick_reply,
      // handover. So `get_started` is not the sole organic entry signal but it is
      // roughly a third of them -- some 57,000 conversations -- and 158 of those
      // 159 `get_started` entries had no referral anywhere in their log. Ignoring
      // `get_started` outright would have broken organic Messenger entry; this
      // guard cannot, because every one of those entries has `forms: []`.
      //
      // WHY DEFER RATHER THAN _noop(). `_noop` returns `newState`, so lib/index.js
      // publishes it and `scribble/state.go` UPSERTs it over the conversation's
      // real `states` row -- the row every recovery sweep selects on -- and bumps
      // `updated`, by which dean and the dashboard age conversations. Nothing
      // happened here, so nothing should be written: DEFER returns without
      // `newState` and writes neither `states` nor the cache. Same mechanism, and
      // the same reasoning, as the synthetic deferral above.
      //
      // NOT DONE, deliberately: a `get_started` at QOUT could re-send the pending
      // question, which is what the `_hasForm` branch above already does and would
      // serve the 22% who tap Get Started mid-question. That is a product decision
      // with its own state write, so it is recorded as a choice rather than taken
      // in a bug fix. Doing nothing is the safe half of it.
      if (!_refNamesForm(nxt) && state.forms.length) {
        return {
          action: 'DEFER',
          reason: DEFER_FALLBACK_ENTRY_ON_LIVE_CONVERSATION,
          event_type: nxt.event_type
        }
      }

      return _blankStart(nxt)
    }

    // TODO: platform_response is deprecated????
    case 'PLATFORM_RESPONSE': {
      const { response } = nxt.payload

      if (response && response.error && state.state !== 'BLOCKED') {
        return { action: 'BLOCKED', error: thinError(response.error, episodeOnset(state), nxt.timestamp) }
      }
      return _noop()
    }

    case 'MACHINE_REPORT': {
      const report = nxt.payload

      if (state.state === 'ERROR' || state.state === 'BLOCKED') {
        return _noop()
      }

      if (report && report.error && report.error.tag === 'FB') {
        return { action: 'BLOCKED', error: thinError(report.error, episodeOnset(state), nxt.timestamp) }
      }

      if (report && report.error) {
        return { action: 'ERROR', error: thinError(report.error, episodeOnset(state), nxt.timestamp) }
      }

      return _noop()
    }

    case 'RESTORE_STATE': {
      // Recovery-only. The event carries a full, self-contained state
      // snapshot (nxt.payload.state) produced by folding the user's log
      // offline. We overwrite state from it and advance the pointer to the
      // event's timestamp so any future reload starts AT this event and
      // re-hydrates the snapshot without re-folding the events before it
      // (notably the block_user that this recovers from).
      //
      // Unconditional by design: on a live restore the fold starts from
      // USER_BLOCKED, but on a subsequent Redis-miss reload the fold starts
      // from START at message_pointer = this timestamp. Gating on any
      // particular incoming state would break durability on reload.
      const restored = nxt.payload.state
      return {
        action: 'RESTORE_STATE',
        stateUpdate: { ...restored, pointer: nxt.timestamp }
      }
    }

    case 'WATERMARK': {
      const { type, mark } = getWatermark(nxt)
      // ignore if mark already higher
      if (state[type] >= mark) return _noop()
      return { action: 'WATERMARK', update: { [type]: mark } }
    }

    case 'REDO': {

      // TODO: Handle a special case with async func redos ( not user-facing redo needed)
      // --> different action... side effect only...

      const dontRedo = ['QOUT', 'END']

      if (dontRedo.includes(state.state)) return _noop()

      const newRetries = [...(state.retries || []), nxt.timestamp]

      return {
        ...state.previousOutput,
        action: 'RESPOND_AGAIN',
        stateUpdate: { retries: newRetries }
      }
    }

    case 'REPEAT_PAYMENT': {

      return {
        action: 'MAKE_PAYMENT',
        question: nxt.payload.question
      }
    }

    case 'FOLLOW_UP': {
      if (state.state !== 'QOUT') return _noop()
      if (state.question !== nxt.payload) return _noop()

      return {
        action: 'RESPOND',
        followUp: true,
        question: state.question
      }
    }

    case 'HANDOVER_EVENT': {
      // Blocked is a dead end for every other inbound event type -- TEXT,
      // MEDIA, POSTBACK, QUICK_REPLY, REFERRAL, ECHO and EXTERNAL_EVENT all
      // no-op here. Without this, a thread passback was the one thing that
      // could still wake a blocked participant, which is how the getForm husk
      // was reached in production.
      if (state.state === 'USER_BLOCKED') return _noop()

      const { new_owner_app_id } = nxt.payload
      const ourAppId = process.env.FACEBOOK_APP_ID
      if (new_owner_app_id && ourAppId && String(new_owner_app_id) !== String(ourAppId)) {
        console.log(`Ignoring handover to different app: ${new_owner_app_id}`)
        return _noop()
      }

      return _handleExternalEvent(state, nxt, true)
    }

    case 'EXTERNAL_EVENT': {
      if (state.state === 'USER_BLOCKED') return _noop()
      return _handleExternalEvent(state, nxt, true)
    }

    case 'BAILOUT': {
      return _stitch(state, nxt.payload, nxt)
    }

    case 'UNBLOCK': {
      if (state.state !== 'BLOCKED') return _noop()
      return {
        action: 'UNBLOCK',
        stateUpdate: {
          state: nxt.payload.state,
          error: undefined
        }
      }
    }

    case 'BLOCK_USER': {
      if (state.state === 'START') {
        return _noop()
      }

      return {
        action: 'RESET',
        // md is carried across for the same reason forms is: apply()'s RESET
        // rebuilds from _initialState(), so anything not named here is lost.
        // Dropping md leaves a blocked participant with no startTime, and the
        // next event that wakes them merges into `undefined` and produces a
        // husk that throws in getForm. See documentation/states-debugging.md.
        stateUpdate: { state: "USER_BLOCKED", pointer: nxt.timestamp, forms: state.forms, md: state.md }
      }
    }

    case 'ECHO': {
      const md = nxt.payload.metadata

      if (state.state === 'USER_BLOCKED') return _noop()

      if (state.state === 'START') {
        return _noop()
      }

      if (!md || md.repeat || md.type === 'statement' || md.keepMoving) {
        return _noop()
      }

      if (md.type === 'thankyou_screen') {
        return { action: 'END', question: md.ref }
      }

      if (md.stitch) {
        return _stitch(state, md.stitch, nxt)
      }

      if (md.type === 'handoff') {
        const { mode = 'wait' } = md.handoff
        if (mode !== 'wait') {
          throw new Error(`handoff mode '${mode}' is not supported yet (only 'wait')`)
        }
        return {
          action: 'HANDOFF',
          question: md.ref,
          wait: { type: 'handover' },
          waitStart: state.waitStart || nxt.timestamp,
          handoff: md.handoff
        }
      }

      if (md.wait) {
        const waitStart = state.waitStart || nxt.timestamp
        return {
          action: 'WAIT_EXTERNAL_EVENT',
          question: md.ref,
          wait: md.wait,
          waitStart
        }
      }

      return {
        action: 'WAIT_RESPONSE',
        question: md.ref
      }
    }

    case 'OPTIN': {
      // payload.type is always 'optin'; the Messenger optin subtype
      // (e.g. 'one_time_notif_req') lives in payload.optin_type.
      if (nxt.payload.optin_type !== 'one_time_notif_req') {
        return _noop()
      }

      const { token, payload } = nxt.payload
      const tokens = state.tokens ? [...state.tokens, token] : [token]

      return {
        action: 'RESPOND',
        stateUpdate: { tokens },
        response: payload,
        responseValue: 'optin',
        question: state.question
      }
    }

    case 'POSTBACK': {
      if (state.state === 'RESPONDING' || state.state === 'USER_BLOCKED' || _isHandoffWait(state)) return _noop()

      if (state.state === 'START') {
        return _blankStart(nxt)
      }

      return {
        action: 'RESPOND',
        response: nxt.payload.value,
        responseValue: nxt.payload.value,
        question: state.question
      }
    }

    case 'QUICK_REPLY': {
      if (state.state === 'RESPONDING' || state.state === 'USER_BLOCKED' || _isHandoffWait(state)) return _noop()

      if (state.state === 'START') {
        return _blankStart(nxt)
      }

      return {
        action: 'RESPOND',
        response: nxt.payload.value,
        responseValue: nxt.payload.value,
        question: state.question
      }
    }

    case 'TEXT': {
      if (state.state === 'RESPONDING' || state.state === 'USER_BLOCKED' || _isHandoffWait(state)) return _noop()

      if (state.state === 'START') {
        return _blankStart(nxt)
      }

      return {
        action: 'RESPOND',
        response: nxt.payload.text,
        responseValue: nxt.payload.text,
        question: state.question
      }
    }
    case 'MEDIA': {
      if (state.state === 'RESPONDING' || state.state === 'USER_BLOCKED' || _isHandoffWait(state)) return _noop()

      if (state.state === 'START') {
        return _blankStart(nxt)
      }

      const attachment = nxt.payload.attachments && nxt.payload.attachments[0]

      return {
        action: 'RESPOND',
        response: attachment,
        responseValue: attachment && attachment.payload && (attachment.payload.id || attachment.payload.url),
        question: state.question
      }
    }

    case 'REACTION': {
      // ignore people "reacting" to messages with emojis and such
      return _noop()

    }

    case 'UNKNOWN': {

      return _noop()
    }


    default:
      throw new TypeError(`Machine did not produce output!\nState: ${util.inspect(state, null, 8)}\nEvent: ${util.inspect(nxt, null, 8)}`)

  }
}


function apply(state, output) {
  switch (output.action) {

    // "This event cannot be interpreted against this state; do not interpret it."
    //
    // Explicit rather than left to the default branch, because DEFER must be a
    // pure no-op IN THE FOLD and that is load-bearing. `exec` runs during replay
    // as well as live -- getState() folds the archived log with it -- so making
    // DEFER throw, or making it record anything, would either make a log that
    // opens with a synthetic event permanently unreplayable or make the replayed
    // state diverge from the live one. The refusal is enacted by the SHELL
    // (transition.js `run`), which declines to publish or cache anything; the
    // core just declines to move.
    case 'DEFER':
      return state

    case 'WATERMARK':
      return { ...state, ...output.update }

    case 'UPDATE_STATE':
      return {
        ...state,
        ...output.stateUpdate
      }

    case 'RESPOND':

      // NOTE: by removing errors/retries/waits on RESPOND, we are "resetting"
      // our retry-on-error process (and exponential backoff) whenever
      // the user responds. I think this is reasonable. But it's implicit here.
      return {
        ...state,
        state: 'RESPONDING',
        ...output.stateUpdate,
        md: { ...state.md, ...output.md },
        question: output.question,
        previousOutput: output,
        error: undefined, // remove error when responding
        errorOnset: undefined, // user responded: the error episode is over
        retries: undefined, // remove retries when responding
        wait: undefined, // remove wait when user responds
        waitStart: undefined, // remove waitStart when user responds
        qa: updateQA(state.qa, update(output))
      }

    case 'RESPOND_AND_RESET':
      return {
        ..._initialState(),
        ...output.stateUpdate,
      }

    case 'RESET':
      return {
        ..._initialState(),
        ...output.stateUpdate,
      }

    case 'RESTORE_STATE':
      return {
        ..._initialState(),
        ...output.stateUpdate,
      }

    case 'RESPOND_AGAIN':
      return {
        ...state,
        ...output.stateUpdate,
        state: 'RESPONDING',
        error: undefined, // remove stale error on retry (keep retries for backoff)
        errorOnset: episodeOnset(state), // ...but remember when the episode began
        wait: undefined, // remove stale wait on retry
      }


    case 'SWITCH_FORM':
      return {
        ..._initialState(),
        ...output.stateUpdate,
        state: 'RESPONDING',
        forms: [...state.forms, output.form],
        pointer: state.pointer, // keep pointer always!
        md: output.md
      }

    case 'WAIT_RESPONSE':
      return {
        ...state,
        state: 'QOUT',
        question: output.question,
        error: undefined, // question sent, no error context
        errorOnset: undefined, // question sent: any retry succeeded, episode over
        retries: undefined, // question sent, no retry context
      }

    case 'HANDOFF':
      return {
        ...state,
        state: 'WAIT_EXTERNAL_EVENT',
        md: { ...state.md, ...output.md },
        question: output.question,
        wait: output.wait,
        externalEvents: output.externalEvents || state.externalEvents,
        waitStart: output.waitStart,
        error: undefined, // entering wait, clear prior error
        errorOnset: undefined, // question sent: any retry succeeded, episode over
        retries: undefined, // entering wait, clear prior retries
      }

    case 'WAIT_EXTERNAL_EVENT':
      return {
        ...state,
        state: 'WAIT_EXTERNAL_EVENT',
        md: { ...state.md, ...output.md },
        question: output.question,
        wait: output.wait,
        externalEvents: output.externalEvents || state.externalEvents,
        waitStart: output.waitStart,
        error: undefined, // entering/continuing wait, clear prior error
        errorOnset: undefined, // question sent: any retry succeeded, episode over
        retries: undefined, // entering/continuing wait, clear prior retries
      }


    case 'END':
      return {
        ...state,
        state: 'END',
        question: output.question,
        error: undefined, // completed, no error context
        errorOnset: undefined, // completed: episode over
        wait: undefined, // completed, no wait context
        retries: undefined, // completed, no retry context
      }

    case 'BLOCKED':
      return {
        ...state,
        state: 'BLOCKED',
        error: output.error,
        errorOnset: undefined, // consumed: the onset now lives on error.ts
        wait: undefined, // blocked, clear prior wait
        waitStart: undefined, // blocked, clear prior waitStart
      }

    case 'UNBLOCK':
      return { ...state, ...output.stateUpdate }

    case 'ERROR':
      return {
        ...state,
        state: 'ERROR',
        error: output.error,
        errorOnset: undefined, // consumed: the onset now lives on error.ts
        wait: undefined, // errored, clear prior wait
        waitStart: undefined, // errored, clear prior waitStart
      }

    default:
      return state
  }
}

// change what is returned
// actions can be: responses, payments, reports...?
function act(ctx, state, output) {
  switch (output.action) {

    case 'RESPOND': {
      const ctxWithMd = { ...ctx, md: { ...state.md, ...output.md } }
      const qa = apply(state, output).qa
      const messages = respond(ctxWithMd, qa, output)
      const payment = messages.map(m => getPaymentFromMessage(ctx, m)).find(p => p)

      return { messages, payment }
    }

    case 'RESPOND_AND_RESET': {
      const qa = state.qa
      const messages = respond({ ...ctx, md: { ...state.md, ...output.md } }, qa, output)

      return { messages }
    }

    case 'RESPOND_AGAIN': {
      const qa = state.qa
      const messages = respond({ ...ctx, md: { ...state.md, ...output.md } }, qa, output)

      return { messages }
    }

    case 'SWITCH_FORM': {

      return {
        messages: respond({ ...ctx, md: output.md }, [], output)
      }
    }

    case 'MAKE_PAYMENT': {
      const qa = state.qa
      const payment = _wrapPayment(ctx, getPayment(ctx, qa, output.question))
      return {
        messages: [],
        payment
      }
    }


    case 'HANDOFF': {
      return { messages: [], handoff: _wrapSideEffect(ctx, output.handoff) }
    }

    default:
      return { messages: [] }
  }
}

function getPayment(ctx, qa, ref) {
  const f = getField(ctx, ref)
  const message = translateField(ctx, qa, f)
  const { payment } = message.metadata || {}

  return payment
}

function _wrapSideEffect(ctx, data) {
  if (!data) return
  return {
    userid: ctx.user.id,
    pageid: ctx.page.id,
    timestamp: ctx.timestamp,
    ...data
  }
}

// Payment events are published off-pipeline (VLAB_PAYMENT_TOPIC, consumed by
// dinersclub) and carry the conversation's platform so downstream consumers
// can route/report by platform. ctx.platform is threaded from
// actionsResponses (transition.js), which now receives it from transition() --
// i.e. derived from THE EVENT. It used to read the persisted md.platform, one of
// the two fields that bled between a participant's conversations before the state
// cache was keyed by the conversation (§7.1).
function _wrapPayment(ctx, payment) {
  if (!payment) return
  return {
    ..._wrapSideEffect(ctx, payment),
    platform: ctx.platform || 'messenger'
  }
}

function getPaymentFromMessage(ctx, message) {
  const metadata = message.metadata
  if (metadata && metadata.payment) {
    return _wrapPayment(ctx, metadata.payment)
  }
  return undefined
}

function updateQA(qa, u) {
  return u ? [...qa, u] : qa
}

function update({ action, question, responseValue }) {
  const hasResponse = responseValue !== undefined && responseValue !== null
  if (action === 'RESPOND' && question && hasResponse) {
    return [question, responseValue]
  }
}

function nextQuestion(ctx, qa, question) {
  const field = getNextField(ctx, qa, question)
  return field ? translateField(ctx, qa, field) : null
}

// TODO: make this work with token recipient


// A repeat is always the question itself, re-rendered through the normal
// translator (so template resolution, interpolation and choices come from one
// place) and stamped `isRepeat`.
function repeatField(ctx, qa, ref) {
  const f = getField(ctx, ref)
  f.md = { isRepeat: true }

  return translateField(ctx, qa, f)
}

function _gatherResponses(ctx, qa, q, previous = []) {
  const md = q && q.metadata

  if (md && md.repeat) {
    const repeat = repeatField(ctx, qa, md.ref)

    // A utility_message is a fixed, pre-approved template -- the only shape
    // that still reaches a user outside Messenger's/WhatsApp's 24-hour window,
    // and the reason re-contact flows open on one. The nudge (`q`) that
    // normally precedes a repeat is free-form text: out of window Meta rejects
    // it with "(#10) This message is sent outside of allowed window" and the
    // user lands in BLOCKED -- precisely the population these flows target.
    // The approved copy cannot carry the nudge either (templates are fixed at
    // approval time), so the repeat is the template, alone.
    //
    // `metadata.type` is the same discriminator message-worker routes on, for
    // both platforms -- see documentation/utility-messages.md.
    if (repeat.metadata && repeat.metadata.type === 'utility_message') {
      return [repeat]
    }

    return [q, repeat]
  }

  if (md && (md.type === 'statement' || md.keepMoving) && !md.wait) {
    const nq = nextQuestion(ctx, qa, md.ref)
    if (nq) return _gatherResponses(ctx, qa, nq, [...previous, q])
  }

  return [...previous, q]
}


function _response(
  ctx, qa, { question, validation, response, token, followUp }
) {

  if (ctx.form.offTime && ctx.timestamp > ctx.form.offTime) {
    const q = question || ctx.form.fields[0].ref;
    return offResponse(q, offMessage(ctx.form.custom_messages))
  }

  if (!question) {
    const message = translateField(ctx, qa, ctx.form.fields[0])

    if (token) {
      return { ...message, token }
    }

    return message
  }

  if (followUp) {
    return repeatResponse(question, followUpMessage(ctx.form.custom_messages))
  }

  const { valid, message } = validation ||
    validator(addCustomType(interpolateField(ctx, qa, getField(ctx, question))),
      ctx.form.custom_messages)(response)

  if (!valid) {

    const msg = message || defaultMessage(ctx.form.custom_messages)
    return repeatResponse(question, msg)
  }

  if (token) {
    return { ...nextQuestion(ctx, qa, question), token }
  }

  return nextQuestion(ctx, qa, question)
}

function respond(ctx, qa, output) {
  return _gatherResponses(ctx, qa, _response(ctx, qa, output))
    .filter(r => !!r)
}


function _initialState() {
  return { state: 'START', qa: [], forms: [] }
}

function getState(log) {
  if (!log || !log.length) {
    return _initialState()
  }
  return log.reduce((s, e) => apply(s, exec(s, e)), _initialState())
}

function getMessage(log, form, user, page) {
  const event = log.slice(-1)[0]
  const state = getState(log.slice(0, -1))
  return act({ form, user, page, timestamp: event.timestamp }, state, exec(state, event))
}

module.exports = {
  DEFER_SYNTHETIC_NO_CONVERSATION,
  DEFER_FALLBACK_ENTRY_ON_LIVE_CONVERSATION,
  categorizeEvent,
  makeEventMetadata,
  getWatermark,
  getState,
  exec,
  apply,
  act,
  update,
  getMessage,
  _initialState
}
