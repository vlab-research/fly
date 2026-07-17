const util = require('util')
const _ = require('lodash')
const { getForm, getMetadata } = require('./utils')
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
        parsed = JSON.parse(metadata)
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


function _handleExternalEvent(state, nxt, includeMetadata = false) {
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

      return _blankStart(nxt)
    }

    // TODO: platform_response is deprecated????
    case 'PLATFORM_RESPONSE': {
      const { response } = nxt.payload

      if (response && response.error && state.state !== 'BLOCKED') {
        return { action: 'BLOCKED', error: response.error }
      }
      return _noop()
    }

    case 'MACHINE_REPORT': {
      const report = nxt.payload

      if (state.state === 'ERROR' || state.state === 'BLOCKED') {
        return _noop()
      }

      if (report && report.error && report.error.tag === 'FB') {
        return { action: 'BLOCKED', error: report.error }
      }

      if (report && report.error) {
        return { action: 'ERROR', error: report.error }
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
        stateUpdate: { state: "USER_BLOCKED", pointer: nxt.timestamp, forms: state.forms }
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
      if (nxt.payload.type !== 'one_time_notif_req') {
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
      return {
        action: 'RESPOND',
        response: nxt.payload.value,
        responseValue: nxt.payload.value,
        question: state.question
      }
    }

    case 'QUICK_REPLY': {
      if (state.state === 'RESPONDING' || state.state === 'USER_BLOCKED' || _isHandoffWait(state)) return _noop()

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
        responseValue: attachment && attachment.payload && attachment.payload.url,
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

    case 'WATERMARK':
      return { ...state, ...output.update }

    case 'UPDATE_STATE':
      return {
        ...state,
        ...output.stateUpdate
      }

    case 'RESPOND':

      // NOTE: by removing errors/retries on RESPOND, we are "resetting"
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
        retries: undefined, // remove retries when responding
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
        state: 'RESPONDING'
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
        question: output.question
      }

    case 'HANDOFF':
      return {
        ...state,
        state: 'WAIT_EXTERNAL_EVENT',
        md: { ...state.md, ...output.md },
        question: output.question,
        wait: output.wait,
        externalEvents: output.externalEvents || state.externalEvents,
        waitStart: output.waitStart
      }

    case 'WAIT_EXTERNAL_EVENT':
      return {
        ...state,
        state: 'WAIT_EXTERNAL_EVENT',
        md: { ...state.md, ...output.md },
        question: output.question,
        wait: output.wait,
        externalEvents: output.externalEvents || state.externalEvents,
        waitStart: output.waitStart
      }


    case 'END':
      return { ...state, state: 'END', question: output.question }

    case 'BLOCKED':
      return { ...state, state: 'BLOCKED', error: output.error }

    case 'UNBLOCK':
      return { ...state, ...output.stateUpdate }

    case 'ERROR':
      return { ...state, state: 'ERROR', error: output.error }

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
      const payment = _wrapSideEffect(ctx, getPayment(ctx, qa, output.question))
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

function getSideEffectFromMessage(ctx, message, type) {
  const metadata = message.metadata
  if (metadata && metadata[type]) {
    return _wrapSideEffect(ctx, metadata[type])
  }
  return undefined
}

function getPaymentFromMessage(ctx, message) {
  return getSideEffectFromMessage(ctx, message, 'payment')
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


function _gatherResponses(ctx, qa, q, previous = []) {
  const md = q && q.metadata

  if (md && md.repeat) {

    const f = getField(ctx, md.ref)
    f.md = { isRepeat: true }

    const repeat = translateField(ctx, qa, f)
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
