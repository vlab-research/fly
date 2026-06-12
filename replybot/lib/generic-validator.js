const emailValidator = require('email-validator')

const defaultMessages = {
  'label.error.mustEnter': 'Sorry, that answer is not valid. Please try to answer the question again.',
  'label.error.mustSelect': 'Sorry, please use the buttons provided to answer the question.',
  'label.error.emailAddress': 'Sorry, please enter a valid email address.',
  'label.error.phoneNumber': 'Sorry, please enter a valid phone number.',
  'label.error.range': 'Sorry, please enter a valid number.',
  'label.buttonHint.default': "Hello, we just wanted to send a friendly follow up. If you would like to stop the survey, just ignore this message and we won't bother you again.",
  'label.error.mustAccept': "We're sorry, but this survey is now over and closed.",
  'block.shortText.placeholder': "Sorry, I can't accept any responses now.",
}

function _validationMessages(messages) {
  return { ...defaultMessages, ...messages }
}

function defaultMessage(messages) {
  return _validationMessages(messages)['label.error.mustEnter']
}

function followUpMessage(messages) {
  return _validationMessages(messages)['label.buttonHint.default']
}

function offMessage(messages) {
  return _validationMessages(messages)['label.error.mustAccept']
}

function _validateQuestion(r, validValues, messages) {
  const responseStr = '' + r
  return {
    message: messages['label.error.mustSelect'],
    valid: validValues.some(v => '' + v === responseStr)
  }
}

function validateQuestion(field, messages) {
  const choices = (field.properties && field.properties.choices) || []
  const validValues = choices.map(c => c.ref || c.label)
  return r => _validateQuestion(r, validValues, messages)
}

function validateYesNo(field, messages) {
  return r => _validateQuestion(r, ['Yes', 'No', true, false], messages)
}

function validateLegal(field, messages) {
  return r => _validateQuestion(r, ['I Accept', "I don't Accept", true, false], messages)
}

function validateRating(field, messages) {
  const steps = (field.properties && field.properties.steps) || 5
  const validValues = []
  for (let i = 1; i <= steps; i++) validValues.push(String(i))
  return r => _validateQuestion(r, validValues, messages)
}

function validateOpinionScale(field, messages) {
  const steps = (field.properties && field.properties.steps) || 5
  const startAtOne = (field.properties && field.properties.start_at_one) !== false
  const start = startAtOne ? 1 : 0
  const validValues = []
  for (let i = start; i <= steps; i++) validValues.push(String(i))
  return r => _validateQuestion(r, validValues, messages)
}

function validateWelcomeScreen(field, messages) {
  const buttonText = (field.properties && field.properties.button_text) || 'Continue'
  return r => _validateQuestion(r, [buttonText], messages)
}

function validateUtilityMessage(field, messages) {
  const choices = (field.properties && field.properties.choices) || []
  const labels = choices.map(c => c.label)

  return r => {
    if (labels.length === 0) {
      return validateStatement(field, messages)(r)
    }
    const responseValue = (r && typeof r === 'object' && r.value !== undefined) ? r.value : r
    return _validateQuestion(responseValue, labels, messages)
  }
}

function validateNotificationMessages(field, messages) {
  return validateStatement(field, messages)
}

function validateString(field, messages) {
  return r => ({
    message: messages['label.error.mustEnter'],
    valid: typeof r === 'string'
  })
}

function validateStatement(field, messages) {
  const md = field.md || {}
  const responseMessage = md.responseMessage
  return __ => ({
    message: responseMessage || messages['block.shortText.placeholder'],
    valid: false
  })
}

function validateNumber(field, messages) {
  const md = field.md || {}
  const validate = md.validate || {}
  const locale = validate.locale || md.locale || 'en-US'

  return r => {
    const num = _parseNumber(r, locale)
    if (num === null) {
      return { message: messages['label.error.range'], valid: false }
    }

    if (validate.integer && !Number.isInteger(num)) {
      return { message: messages['label.error.range'], valid: false }
    }
    if (validate.min !== undefined && num < validate.min) {
      return { message: messages['label.error.range'], valid: false }
    }
    if (validate.max !== undefined && num > validate.max) {
      return { message: messages['label.error.range'], valid: false }
    }

    return { message: messages['label.error.range'], valid: true }
  }
}

function _parseNumber(str, locale) {
  if (typeof str === 'number') return str
  if (typeof str === 'boolean') return null
  if (typeof str !== 'string') return null

  let value = str.trim()

  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(1234.5)
    const decimalPart = parts.find(p => p.type === 'decimal')
    const groupPart = parts.find(p => p.type === 'group')
    const decimal = (decimalPart && decimalPart.value) || '.'
    const group = (groupPart && groupPart.value) || ','

    if (group) value = value.split(group).join('')
    value = value.replace(/\s/g, '')
    if (decimal && decimal !== '.') value = value.replace(decimal, '.')
  } catch (e) {
    // fallback: simple parse
  }

  if (!/^[+-]?\d*\.?\d+$/.test(value) && !/^[+-]?\d+\.?$/.test(value)) return null

  const result = parseFloat(value)
  return isFinite(result) ? result : null
}

function validateEmail(field, messages) {
  return r => ({
    message: messages['label.error.emailAddress'],
    valid: emailValidator.validate(r)
  })
}

function validatePhone(field, messages) {
  return r => ({
    message: messages['label.error.phoneNumber'],
    valid: typeof r === 'string' && r.length > 0
  })
}

function validateUpload(field, messages) {
  const md = field.md || {}
  const validate = md.validate || md.upload || {}
  const uploadType = validate.type

  return r => {
    const url = r && r.payload && r.payload.url
    const validType = (r && r.type) === uploadType
    const valid = validType && !!url
    return { message: messages['label.error.mustEnter'], valid }
  }
}

function validateNotify(field, messages) {
  const md = field.md || {}
  const ref = md.ref || field.ref
  return r => {
    const valid = r && r.ref === ref
    return { message: messages['label.error.mustSelect'], valid: !!valid }
  }
}

function alwaysTrue(__, ___) {
  return __ => ({ message: 'Error', valid: true })
}

const lookup = {
  number: validateNumber,
  statement: validateStatement,
  thankyou_screen: validateStatement,
  multiple_choice: validateQuestion,
  dropdown: validateQuestion,
  picture_choice: validateQuestion,
  button_choice: validateQuestion,
  rating: validateRating,
  opinion_scale: validateOpinionScale,
  legal: validateLegal,
  yes_no: validateYesNo,
  welcome_screen: validateWelcomeScreen,
  short_text: validateString,
  long_text: validateString,
  date: validateString,
  share: validateStatement,
  webview: validateStatement,
  wait: validateStatement,
  stitch: validateStatement,
  notify: validateNotify,
  email: validateEmail,
  phone_number: validatePhone,
  upload: validateUpload,
  attachment: alwaysTrue,
  utility_message: validateUtilityMessage,
  notification_messages: validateNotificationMessages,
}

function validator(field, messages) {
  const m = _validationMessages(messages)
  const fn = lookup[field.type]

  if (!fn) {
    throw new TypeError(`There is no validator for the question of type ${field.type}`)
  }

  return fn(field, m)
}

module.exports = { validator, defaultMessage, followUpMessage, offMessage }
