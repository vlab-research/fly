const util = require('util')
const r2 = require('r2')
const {recursiveJSONParser, parseLogJSON, splitLogsByForm} = require('./utils')
const {translator, validator}= require('../translate-typeform')
const {translateField, getField, getNextField } = require('./form')



function repeatResponse(question, text) {
  if (!text) {
    throw new TypeError(`Repeat response attempted without valid text: ${question}` )
  }

  return {
    text,
    metadata: JSON.stringify({ repeat: true, ref: question })
  }
}

function getWatermark(event) {
  if (!event.read && !event.delivery) return undefined

  const type = event.read ? 'read' : 'delivery'
  const mark = event[type].watermark

  return {type, mark}
}


function exec (state, nxt) {
  const {type, mark} = getWatermark(nxt) || {}

  if (state.state === 'START') {
    return { action: 'RESPOND' }
  }

  if (mark && !(state[type] > mark)) {
    return { action: 'WATERMARK', update: {[type]: mark} }
  }

  if (nxt.message && nxt.message.is_echo) {

    if (nxt.message.metadata.repeat) {
      return { action: 'SEND_QUESTION', question: state.question }
    }

    if (nxt.message.metadata.type === 'statement') {
      return { action: 'RESPOND',
               validation: {valid: true},
               question: nxt.message.metadata.ref }
    }

    return { action: 'WAIT_RESPONSE', question: nxt.message.metadata.ref }
  }

  else if (nxt.postback) {
    const { value, ref } = nxt.postback.payload

    // If it is a postback to the current question, it's valid
    if (state.question === ref && state.state == 'QOUT') {
      return { action: 'RESPOND',
               validation: { valid: true},
               response: value,
               question: state.question }
    }

    // otherwise, it's invalid
    return { action: 'RESPOND',
             validation: {valid: false,
                          message: 'Please respond to the question:'},
             question: state.question }
  }

  // Must be something from user, validate it against our last outstanding question
  if (nxt.message && nxt.message.text) {
    return { action: 'RESPOND', response: nxt.message.text, question: state.question }
  }

  throw new TypeError(`Machine did not produce output!\nState: ${state}\nEvent: ${util.inspect(nxt, null, 8)}`)
}


function apply (state, output) {
  switch(output.action) {

  case 'WATERMARK':
    return {...state, ...output.update }

  case 'RESPOND':
    return {...state, state: 'RESPONDING', question: output.question || state.question }

  case 'WAIT_RESPONSE':
    return {...state, state: 'QOUT', question: output.question }

  case 'SEND_QUESTION':
    return {...state, state: 'QOUT', question: output.question }
  }
}

// ctx { form, log, user }

function act (ctx, state, output) {
  switch(output.action) {

  case 'RESPOND':
    return respond(ctx, output)

  case 'SEND_QUESTION':
    return translateField(ctx, getField(ctx, state.question))

  default:
    return
  }
}


function sendNextQuestion(ctx, question) {
  const field = getNextField(ctx, question)
  return field ? translateField(ctx, field) : null
}

function respond (ctx, {question, validation, response}) {
  // if we haven't asked anything, it must be the first question!
  if (!question) {
    return translateField(ctx, ctx.form.fields[0])
  }

  // otherwise, validate the response
  const {valid, message} = validation || validator(getField(ctx, question))(response)

  if (!valid) {
    // Note: this could be abstracted to be more flexible
    return repeatResponse(question, message)
  }
  return sendNextQuestion(ctx, question)
}


function getCurrentForm(log) {
  const current = splitLogsByForm(parseLogJSON(log)).pop()
  const [form, currentLog] = current || [undefined, undefined]

  return [form, currentLog]
}


function getState(log) {
  if (!log || !log.length) {
    return { state: 'START' }
  }

  const [form, currentLog] = getCurrentForm(log)
  return currentLog.reduce((s,e)=> apply(s, exec(s,e)), { state: 'START' })
}

function getMessage(log, form, user) {
  const event = log.slice(-1)[0]
  const state = getState(log.slice(0,-1))
  const output = exec(state, event)
  return act({ log, form, user }, state, output)
}


module.exports = {
  getWatermark,
  getCurrentForm,
  getState,
  exec,
  apply,
  act,
  getMessage
}