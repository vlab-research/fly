const util = require('util')
const _ = require('lodash')
const { getForm, getMetadata } = require('./utils')
const { validator, defaultMessage, followUpMessage, offMessage } = require('@vlab-research/translate-typeform')
const { translateField, getField, getNextField, addCustomType, interpolateField } = require('./form')
const { waitConditionFulfilled } = require('./waiting')



function _eventMetadata(prefix, value) {
  if (typeof value !== 'object' || value == null) return { [prefix]: value }

  return _.toPairs(value)
    .filter(([k, __]) => k !== 'type')
    .filter(([__, v]) => v !== undefined)
    .reduce((d, [k, v]) => ({ ...d, ..._eventMetadata(`${prefix}_${k}`, v) }), {})
}

function makeEventMetadata(event) {
  const { type, value } = event.event

  // We don't want to make metadata with
  // timeout events
  if (type !== 'external' || !value.type) return

  const base = value.type.split(':').join('_')
  const prefix = `e_${base}`

  return _eventMetadata(prefix, value)
}

function repeatResponse(question, text) {
  if (!text) {
    throw new TypeError(`Repeat response attempted without valid text: ${text}\nquestion: ${question}`)
  }

  return {
    message: {
      text,
      metadata: JSON.stringify({ repeat: true, ref: question })
    }
  }
}


function offResponse(previousQuestion, text) {

  return {
    message: {
      text,
      metadata: JSON.stringify({ off: true, ref: previousQuestion })
    }
  }
}


function getWatermark(event) {
  if (!event.read && !event.delivery) return undefined

  const type = event.read ? 'read' : 'delivery'
  const mark = event[type].watermark

  return { type, mark }
}


function _hasForm(state, form) {
  return state.forms.indexOf(form) !== -1
}


function _currentForm(state) {
  return state.forms[state.forms.length - 1]
}

function _currentUserIsReferrer(event) {
  const md = getMetadata(event)
  return '' + event.sender.id === md.referrer
}


function _synth(type, event) {
  return (event.source === 'synthetic') && (event.event.type === type)
}

function _externalEvent(event) {
  return (event.source === 'synthetic') &&
    ((event.event.type === 'timeout') ||
      (event.event.type === 'external'))
}


function categorizeEvent(nxt) {
  if (nxt.referral ||
    (nxt.postback && nxt.postback.referral) ||
    (nxt.postback && nxt.postback.payload === 'get_started') ||
    _.get(nxt, ['postback', 'payload', 'referral']) ||
    _.get(nxt, ['message', 'quick_reply', 'payload', 'referral'])) {
    return 'REFERRAL'
  }

  if (nxt.optin) return 'OPTIN'
  if (_synth('unblock', nxt)) return 'UNBLOCK'
  if (_synth('follow_up', nxt)) return 'FOLLOW_UP'
  if (_synth('repeat_payment', nxt)) return 'REPEAT_PAYMENT'
  if (_synth('redo', nxt)) return 'REDO'
  if (_synth('platform_response', nxt)) return 'PLATFORM_RESPONSE'
  if (_synth('machine_report', nxt)) return 'MACHINE_REPORT'
  if (_synth('bailout', nxt)) return 'BAILOUT'
  if (_synth('block_user', nxt)) return 'BLOCK_USER'
  if (_externalEvent(nxt)) return 'EXTERNAL_EVENT'
  if (getWatermark(nxt)) return 'WATERMARK'
  if (nxt.message && nxt.message.is_echo) return 'ECHO'
  if (nxt.postback) return 'POSTBACK'
  if (nxt.message && nxt.message.quick_reply) return 'QUICK_REPLY'
  if (nxt.message && nxt.message.text !== undefined) return 'TEXT'
  if (nxt.message && nxt.message.attachments) return 'MEDIA'
  if (nxt.reaction) return 'REACTION'

  console.log(`Machine could not categorize event!
        	       \nEvent: ${util.inspect(nxt, null, 8)}`)

  return 'UNKNOWN'

}

function _noop() {
  return { action: 'NONE' }
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
      const { response } = nxt.event.value

      // TODO: What to do if in state blocked
      // and get response from user???
      if (response.error && state.state !== 'BLOCKED') {
        return { action: 'BLOCKED', error: response.error }
      }
      return _noop()
    }

    case 'MACHINE_REPORT': {
      const report = nxt.event.value

      // right now machine_reports only put us in a blocked or error
      // state and we can't go from one to the other directly
      if (state.state === 'ERROR' || state.state === 'BLOCKED') {
        return _noop()
      }

      if (report.error && report.error.tag === 'FB') {
        return { action: 'BLOCKED', error: report.error }
      }

      if (report.error) {
        return { action: 'ERROR', error: report.error }
      }

      return _noop()
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
        question: nxt.event.value.question
      }
    }

    case 'FOLLOW_UP': {
      if (state.state !== 'QOUT') return _noop()
      if (state.question !== nxt.event.value) return _noop()

      return {
        action: 'RESPOND',
        followUp: true,
        question: state.question
      }
    }

    case 'EXTERNAL_EVENT': {
      const md = makeEventMetadata(nxt)

      const externalEvents = [...(state.externalEvents || []), nxt]

      if (state.state !== 'WAIT_EXTERNAL_EVENT') {

        return {
          action: 'UPDATE_STATE',
          stateUpdate: { md: { ...state.md, ...md }, externalEvents: externalEvents }
        }
      }

      const fulfilled = waitConditionFulfilled(state.wait, externalEvents, state.waitStart)

      if (!fulfilled) {
        return {
          action: 'WAIT_EXTERNAL_EVENT',
          question: state.question,
          wait: state.wait,
          md,
          waitStart: state.waitStart,
          externalEvents
        }
      }

      return tokenWrap(state, nxt, {
        action: 'RESPOND',
        md,
        stateUpdate: { wait: null, waitStart: null },
        question: state.question,
        validation: { valid: true },
        response: null
      })
    }

    case 'BAILOUT': {
      // { event: { type: 'bailout', value: {form: 'foo' }}
      return _stitch(state, nxt.event.value, nxt)
    }

    case 'UNBLOCK': {
      if (state.state !== 'BLOCKED') return _noop()
      return {
        action: 'UNBLOCK',
        stateUpdate: {
          state: nxt.event.value.state,
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
      // what happens when you're not in responding state?
      // it shouldn't happen but it does and indicates
      // an error
      const md = nxt.message.metadata

      // handles reset scenario
      if (state.state === 'START') {
        return _noop()
      }

      // If it hasn't been sent by the bot, ignore it
      // If it's a repeat or a statement, ignore it
      // add new send-multi type
      if (!md || md.repeat || md.type === 'statement' || md.keepMoving) {
        return _noop()
      }

      if (md.type === 'thankyou_screen') {
        return { action: 'END', question: nxt.message.metadata.ref }
      }

      if (md.stitch) {
        return _stitch(state, md.stitch, nxt)
      }

      if (md.wait) {
        return {
          action: 'WAIT_EXTERNAL_EVENT',
          question: md.ref,
          wait: md.wait,
          waitStart: state.waitStart || nxt.timestamp
        } // propogate if repeat
      }

      // if we receive the echo, we now assume that
      // the user has the question.
      // TODO: simulate problems. Can use timestamps?
      return {
        action: 'WAIT_RESPONSE',
        question: md.ref
      }
    }

    case 'OPTIN': {
      // only one type of optin supported for now
      if (nxt.optin.type !== 'one_time_notif_req') {
        return _noop()
      }

      const { one_time_notif_token: token, payload } = nxt.optin
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
      if (state.state === 'RESPONDING') return _noop()
      return {
        action: 'RESPOND',
        response: nxt.postback.payload,
        responseValue: nxt.postback.payload.value,
        question: state.question
      }
    }

    case 'QUICK_REPLY': {
      if (state.state === 'RESPONDING') return _noop()

      const qrResponse = nxt.message.quick_reply.payload.value === undefined ?
        nxt.message.quick_reply.payload :
        nxt.message.quick_reply.payload.value

      return {
        action: 'RESPOND',
        response: qrResponse,
        responseValue: qrResponse,
        question: state.question
      }
    }

    case 'TEXT': {
      if (state.state === 'RESPONDING' || state.state === 'USER_BLOCKED') return _noop()

      // Handles the case (testers) where they begin
      // texting without any other previous state or when off
      if (state.state === 'START') {
        return _blankStart(nxt)
      }

      return {
        action: 'RESPOND',
        response: nxt.message.text,
        responseValue: nxt.message.text,
        question: state.question
      }
    }
    case 'MEDIA': {
      if (state.state === 'RESPONDING' || state.state === 'USER_BLOCKED') return _noop()

      // Handles the odd case (testers) where they begin
      // texting without any other previous state
      if (state.state === 'START') {
        return _blankStart(nxt)
      }

      // Recieve first attachment only

      const attachment = nxt.message.attachments && nxt.message.attachments[0]

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
      const qa = apply(state, output).qa
      const messages = respond({ ...ctx, md: { ...state.md, ...output.md } }, qa, output)
      const payments = messages.map(m => getPaymentFromMessage(ctx, m)).filter(x => !!x)
      return { messages, payments }
    }

    case 'RESPOND_AND_RESET': {
      const qa = state.qa
      const messages = respond({ ...ctx, md: { ...state.md, ...output.md } }, qa, output)
      return { messages, payments: [] }
    }

    case 'RESPOND_AGAIN': {
      const qa = state.qa
      return {
        messages: respond({ ...ctx, md: { ...state.md, ...output.md } }, qa, output),
        payments: []
      }
    }

    case 'SWITCH_FORM': {

      return {
        messages: respond({ ...ctx, md: output.md }, [], output),
        payments: []
      }
    }

    case 'MAKE_PAYMENT': {
      const qa = state.qa
      const payment = _wrapPayment(ctx, getPayment(ctx, qa, output.question))
      return { messages: [], payments: [payment] }
    }

    default:
      return { messages: [], payments: [] }
  }
}

function getPayment(ctx, qa, ref) {
  const f = getField(ctx, ref)
  const message = translateField(ctx, qa, f)
  const md = JSON.parse(message.message.metadata)
  const { payment } = md || {} // TODO: defensive??

  return payment
}

function _wrapPayment(ctx, payment) {
  if (!payment) return
  return { userid: ctx.user.id, pageid: ctx.page.id, timestamp: ctx.timestamp, ...payment }
}

function getPaymentFromMessage(ctx, message) {
  const { payment } = JSON.parse(message.message.metadata)
  return _wrapPayment(ctx, payment)
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
  const msg = q.message
  const md = msg && JSON.parse(msg.metadata)

  if (md.repeat) {

    // Add metadata to know if a repeated question
    // is a repeat or not
    const f = getField(ctx, md.ref)
    f.md = { isRepeat: true }

    const repeat = translateField(ctx, qa, f)
    return [q, repeat]
  }

  if (md.type === 'statement' || md.keepMoving) {
    // if question is statement, recursively
    // get the next question and send it too!
    const nq = nextQuestion(ctx, qa, md.ref)
    if (nq) return _gatherResponses(ctx, qa, nq, [...previous, q])
  }

  return [...previous, q]
}


function _response(
  ctx, qa, { question, validation, response, token, followUp, surveyOff }
) {

  // Check if form is off based on timestamp
  if (ctx.form.offTime && ctx.timestamp > ctx.form.offTime) {
    const q = question || ctx.form.fields[0].ref; // handles joining after off first question
    return offResponse(q, offMessage(ctx.form.custom_messages))
  }

  // if we haven't asked anything, it must be the first question!
  if (!question) {
    const message = translateField(ctx, qa, ctx.form.fields[0])

    if (token) {
      return { recipient: { one_time_notif_token: token }, ...message }
    }

    return message
  }

  if (followUp) {
    return repeatResponse(question, followUpMessage(ctx.form.custom_messages))
  }

  // otherwise, validate the response
  const { valid, message } = validation ||
    // add interpolation and customTypes to field given to validator...
    validator(addCustomType(interpolateField(ctx, qa, getField(ctx, question))),
      ctx.form.custom_messages)(response)

  if (!valid) {

    // Note: this could be abstracted to be more flexible
    const msg = message || defaultMessage(ctx.form.custom_messages)
    return repeatResponse(question, msg)
  }

  if (token) {
    return {
      recipient: { one_time_notif_token: token },
      ...nextQuestion(ctx, qa, question)
    }
  }

  return nextQuestion(ctx, qa, question)
}

function respond(ctx, qa, output) {
  const addRecipient = dat => ({ recipient: { id: ctx.user.id }, ...dat })

  return _gatherResponses(ctx, qa, _response(ctx, qa, output))
    .filter(r => !!r)
    .map(r => r.recipient ? r : addRecipient(r)) // ducktype has recipient
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
