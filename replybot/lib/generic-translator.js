function makeUrl(url) {
  if (typeof url === 'string') return url

  const { base, protocol = 'https', params = {} } = url
  if (!base) throw new Error(`Invalid URL object for creating a URL: ${url}`)

  const p = new URLSearchParams(params)
  const b = new URL(`${protocol}://${base}`)
  b.search = p.toString()
  return b.href
}

function translateTextField(field) {
  const metadata = { ...(field.md || {}) }
  if (!metadata.type) metadata.type = field.type
  metadata.ref = field.ref

  return {
    type: 'text',
    text: field.title,
    question_text: null,
    options: null,
    media_url: null,
    media_type: null,
    caption: null,
    metadata
  }
}

function translateQuestionWithChoices(field) {
  const options = field.properties.choices.map(choice => ({
    value: choice.ref || choice.label,
    label: choice.label,
    description: null
  }))

  return {
    type: 'question',
    text: null,
    question_text: field.title,
    options,
    media_url: null,
    media_type: null,
    caption: null,
    metadata: { ...(field.md || {}), ref: field.ref, type: field.type }
  }
}

function translateYesNo(field) {
  const options = [
    { value: true, label: 'Yes', description: null },
    { value: false, label: 'No', description: null }
  ]

  return {
    type: 'question',
    text: null,
    question_text: field.title,
    options,
    media_url: null,
    media_type: null,
    caption: null,
    metadata: { ...(field.md || {}), ref: field.ref, type: 'yes_no' }
  }
}

function translateLegal(field) {
  const options = [
    { value: true, label: 'I Accept', description: null },
    { value: false, label: "I don't Accept", description: null }
  ]

  return {
    type: 'question',
    text: null,
    question_text: field.title,
    options,
    media_url: null,
    media_type: null,
    caption: null,
    metadata: { ...(field.md || {}), ref: field.ref, type: 'legal' }
  }
}

function translateOpinionScale(field) {
  const steps = (field.properties && field.properties.steps) || 5
  const startAtOne = (field.properties && field.properties.start_at_one) !== false
  const start = startAtOne ? 1 : 0

  const options = []
  for (let i = start; i <= steps; i++) {
    options.push({ value: String(i), label: String(i), description: null })
  }

  return {
    type: 'question',
    text: null,
    question_text: field.title,
    options,
    media_url: null,
    media_type: null,
    caption: null,
    metadata: { ...(field.md || {}), ref: field.ref, type: 'opinion_scale', steps }
  }
}

function translateRating(field) {
  const steps = (field.properties && field.properties.steps) || 5

  const options = []
  for (let i = 1; i <= steps; i++) {
    const label = i === 1 ? '1 star' : `${i} stars`
    options.push({ value: String(i), label, description: null })
  }

  return {
    type: 'question',
    text: null,
    question_text: field.title,
    options,
    media_url: null,
    media_type: null,
    caption: null,
    metadata: { ...(field.md || {}), ref: field.ref, type: 'rating', steps }
  }
}

function translateWelcomeScreen(field) {
  const buttonText = (field.properties && field.properties.button_text) || 'Continue'
  const options = [{ value: buttonText, label: buttonText, description: null }]

  return {
    type: 'question',
    text: null,
    question_text: field.title,
    options,
    media_url: null,
    media_type: null,
    caption: null,
    metadata: { ...(field.md || {}), ref: field.ref }
  }
}

function translateStatement(field) {
  const metadata = { ref: field.ref }
  if (field.type === 'statement' || field.type === 'thankyou_screen') {
    metadata.type = field.type
  }

  if (field.md && typeof field.md === 'object') {
    Object.assign(metadata, field.md)
  }

  return {
    type: 'text',
    text: field.title,
    question_text: null,
    options: null,
    media_url: null,
    media_type: null,
    caption: null,
    metadata
  }
}

function translateShare(field) {
  const md = field.md || {}
  const url = md.url || ''
  const buttonText = md.buttonText || 'Start'

  return {
    type: 'text',
    text: field.title,
    question_text: null,
    options: null,
    media_url: null,
    media_type: null,
    caption: null,
    metadata: { ref: field.ref, type: 'share', url, buttonText }
  }
}

function translateWebview(field) {
  const md = field.md || {}
  const webviewUrl = makeUrl(md.url || '')
  const buttonText = md.buttonText || 'View website'

  return {
    type: 'text',
    text: field.title,
    question_text: null,
    options: null,
    media_url: null,
    media_type: null,
    caption: null,
    metadata: { ...md, ref: field.ref, type: 'webview', url: webviewUrl, buttonText }
  }
}

function translateAttachment(field) {
  const md = field.md || {}
  const attachment = md.attachment || {}
  const mediaUrl = attachment.url || md.md || field.properties.description || ''

  return {
    type: 'media',
    text: null,
    question_text: null,
    options: null,
    media_url: mediaUrl,
    media_type: attachment.type || 'image',
    caption: field.title,
    metadata: { ...(field.md || {}), ref: field.ref, type: 'attachment' }
  }
}

function translateUtilityMessage(field) {
  const choices = (field.properties && field.properties.choices) || []

  if (choices.length > 0) {
    const options = choices.map(choice => ({
      value: choice.ref || choice.label,
      label: choice.label,
      description: null
    }))

    return {
      type: 'question',
      text: null,
      question_text: field.title,
      options,
      media_url: null,
      media_type: null,
      caption: null,
      metadata: { ...(field.md || {}), ref: field.ref, type: 'utility_message' }
    }
  }

  return translateTextField(field)
}

function translateTypeformField(field) {
  switch (field.type) {
    case 'short_text':
    case 'long_text':
    case 'number':
    case 'date':
    case 'email':
    case 'phone_number':
    case 'upload':
    case 'notify':
    case 'notification_messages':
      return translateTextField(field)

    case 'multiple_choice':
    case 'dropdown':
    case 'picture_choice':
    case 'button_choice':
      return translateQuestionWithChoices(field)

    case 'yes_no':
      return translateYesNo(field)

    case 'legal':
      return translateLegal(field)

    case 'opinion_scale':
      return translateOpinionScale(field)

    case 'rating':
      return translateRating(field)

    case 'welcome_screen':
      return translateWelcomeScreen(field)

    case 'statement':
    case 'thankyou_screen':
    case 'wait':
    case 'stitch':
    case 'handoff':
      return translateStatement(field)

    case 'share':
      return translateShare(field)

    case 'webview':
      return translateWebview(field)

    case 'attachment':
      return translateAttachment(field)

    case 'utility_message':
      return translateUtilityMessage(field)

    default:
      throw new TypeError(`There is no translator for the question of type ${field.type}`)
  }
}

module.exports = { translateTypeformField }
