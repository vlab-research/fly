// ---------------------------------------------------------------------------
// First-party service URLs
//
// `link_tracking` and `moviehouse` are field types whose URL replybot OWNS
// end to end. The researcher supplies content -- a destination, or a Vimeo
// video id -- and never plumbing. The base address comes from config, exactly
// the way replybot learns every other service address (BOTSERVER_URL,
// FORMCENTRAL_URL); the conversation identity comes from `ctx`.
//
// That ownership is the whole design, and it is what deletes three problems
// that the previous `tracked: true` approach could only mitigate:
//
//   1. NO HOST ALLOWLIST. replybot is not matching a researcher's host against
//      a list of ours, it is using its own. The allowlist rotted twice --
//      `gbvlinks.nandan.cloud` was missing while carrying 193 live fields, and
//      `virtuallab-videos.netlify.com` was listed as a hazard while carrying
//      490. Both of those hosts are dead today (the first serves the ingress
//      controller's fake certificate because no Ingress claims it; the second
//      404s), which is the point: a host a researcher typed years ago is not a
//      host we control, and stamping identity into it was never going to help.
//   2. NO PER-SERVICE PARAM SCHEMES. Because replybot owns both ends there is
//      ONE canonical set of identity param names, below, and both services read
//      it. The `id` collision that forced two schemes -- linksniffer's
//      participant vs moviehouse's Vimeo video id -- cannot exist, because the
//      video id is now an explicit `vlab_video` param replybot sets.
//   3. NO `tracked` FLAG. Choosing the field type IS the opt-in, so there is no
//      way to author a first-party link and forget to turn tracking on.
//
// Hand-authored `webview` fields are untouched by all of this. They stay
// ordinary webviews: no host matching, no decoration, byte-identical output.
// The migration path is "change the field's type", not "add a flag".
// ---------------------------------------------------------------------------

// THE canonical conversation-identity query params. One set, read by
// `linksniffer/server.go` and `moviehouse/src/identity.js` alike.
//
// The `vlab_` prefix is deliberate and is what makes a collision structurally
// impossible rather than merely unlikely. Unprefixed names (`id`, `platform`,
// `account_id`) are names a third party can plausibly use for something else --
// which is exactly how `id` came to mean "the participant" on one of our pages
// and "the Vimeo video" on another. Nothing else in this system, and nothing on
// a destination site, is called `vlab_*`.
const IDENTITY_PARAMS = {
  user: 'vlab_user',
  account: 'vlab_account',
  platform: 'vlab_platform'
}

// moviehouse content. Namespaced for the same reason: the legacy name for this
// was `id`, and `id` is the single ambiguous name in this whole story.
const VIDEO_PARAM = 'vlab_video'

// linksniffer content. These are linksniffer's existing destination contract and
// carry no identity, so they keep their names: `url` is the destination with the
// protocol stripped, `p` is that protocol (`https`, `tel`, `mailto`, `sms`).
const DESTINATION_PARAM = 'url'
const PROTOCOL_PARAM = 'p'

// Pure. The conversation triple as query params, plus the components we could
// not resolve. A component is stamped only when it is a non-empty string --
// same rule hermes applies when stamping the envelope. An empty string would be
// a poisoned conversation key downstream, which is worse than an absent one.
function identityParams(ctx) {
  const params = {}
  const missing = []

  const user = ctx && ctx.user && ctx.user.id
  if (user) params[IDENTITY_PARAMS.user] = String(user)
  else missing.push('user.id')

  const account = ctx && ctx.page && ctx.page.id
  if (account) params[IDENTITY_PARAMS.account] = String(account)
  else missing.push('page.id')

  const platform = ctx && ctx.platform
  if (platform) params[IDENTITY_PARAMS.platform] = String(platform)
  else missing.push('platform')

  return { params, missing }
}

// Pure. Assemble `base` + query params into an absolute URL.
//
// `base` may carry a path (`https://links.vlab.digital/go`) and may or may not
// carry a trailing slash; any query string already on it is discarded, since
// replybot owns the query string for these types.
function buildServiceUrl(base, params) {
  const b = new URL(String(base))
  b.search = new URLSearchParams(params).toString()
  return b.href
}

// Pure. Split a researcher's destination into linksniffer's `p` + `url` pair.
//
// linksniffer rebuilds `https://` + url for the web protocols and `tel:` + url
// for the rest (`linksniffer/server.go` buildRedirectURL), so the protocol has
// to travel separately. A destination with no scheme at all is assumed https,
// which matches both linksniffer's own default and how researchers have always
// authored the `url` param.
function splitDestination(destination) {
  const d = String(destination).trim()
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(\/\/)?(.*)$/.exec(d)

  if (!m) return { protocol: 'https', target: d }
  return { protocol: m[1].toLowerCase(), target: m[3] }
}

// Pure. The full linksniffer URL for a `link_tracking` field.
function buildLinkTrackingUrl(base, destination, ctx) {
  const { protocol, target } = splitDestination(destination)
  const { params, missing } = identityParams(ctx)

  const url = buildServiceUrl(base, {
    [DESTINATION_PARAM]: target,
    [PROTOCOL_PARAM]: protocol,
    ...params
  })

  return { url, missing }
}

// Pure. The full moviehouse URL for a `moviehouse` field.
function buildMoviehouseUrl(base, videoId, ctx) {
  const { params, missing } = identityParams(ctx)

  const url = buildServiceUrl(base, {
    [VIDEO_PARAM]: String(videoId),
    ...params
  })

  return { url, missing }
}

// Pure. Render either authored `url` form of a legacy hand-authored `webview`.
// No decoration, no host matching, no identity -- these are exactly as the
// researcher wrote them.
// url can be a string, or {base, protocol, params}.
function makeUrl(url) {
  if (typeof url === 'string') {
    return url
  }

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
    value: choice.label,
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
    { value: 'Yes', label: 'Yes', description: null },
    { value: 'No', label: 'No', description: null }
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
    { value: 'I Accept', label: 'I Accept', description: null },
    { value: "I don't Accept", label: "I don't Accept", description: null }
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

// opinion_scale/rating render as `steps` numeric quick replies labelled
// [start .. start+steps-1], where start is 1 unless start_at_one === false
// (matches translate-typeform translateRatings). `steps` is NOT added to
// metadata — it is derived from properties, and the expected metadata omits it.
function scaleOptions(field) {
  const steps = (field.properties && field.properties.steps) || 5
  const start = (field.properties && field.properties.start_at_one) === false ? 0 : 1

  const options = []
  for (let i = 0; i < steps; i++) {
    const label = String(start + i)
    options.push({ value: label, label, description: null })
  }
  return options
}

function translateOpinionScale(field) {
  return {
    type: 'question',
    text: null,
    question_text: field.title,
    options: scaleOptions(field),
    media_url: null,
    media_type: null,
    caption: null,
    metadata: { ...(field.md || {}), ref: field.ref, type: 'opinion_scale' }
  }
}

function translateRating(field) {
  return {
    type: 'question',
    text: null,
    question_text: field.title,
    options: scaleOptions(field),
    media_url: null,
    media_type: null,
    caption: null,
    metadata: { ...(field.md || {}), ref: field.ref, type: 'rating' }
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

  // thankyou_screen renders only the first line of its title (the rest is
  // Typeform's "create your own" boilerplate), matching translate-typeform.
  const text = field.type === 'thankyou_screen'
    ? String(field.title).split('\n')[0]
    : field.title

  return {
    type: 'text',
    text,
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

// A hand-authored `webview`. Renders the researcher's URL and nothing else --
// no host matching, no identity, no decoration. Byte-identical to what the
// researcher wrote, which is the entire contract for this type.
function translateWebview(field) {
  const md = field.md || {}

  return webviewMessage(field, md, makeUrl(md.url || ''), md.buttonText)
}

// Every first-party field type renders as the SAME wire shape a hand-authored
// webview does: `metadata.type === 'webview'`, with `url` and `buttonText`.
// That is load-bearing rather than convenient -- `metadata.type` is the
// discriminator message-worker routes on for both transports
// (`translator.go` case "webview" -> Messenger button template;
// `translator_whatsapp.go` -> cta_url interactive message), and it is what
// `generic-validator.js` looks up. Emitting a new wire type would mean touching
// both, plus every fixture in `facebot/testrunner`.
//
// `...md` is spread FIRST and on purpose: it is what carries `keepMoving`,
// `wait` and `responseMessage` through untouched. `machine.js` reads those by
// name off the message metadata (`md.keepMoving` at :635 and :1086, `md.wait` at
// :661) and never looks at the field type, so a `moviehouse` field that waits on
// `moviehouse:play` reaches the state machine as exactly the same object a
// `webview` field that waits on it does. `type`/`url`/`buttonText` are set after
// the spread so the researcher's authoring-time values cannot leak into the wire
// shape.
function webviewMessage(field, md, url, buttonText) {
  return {
    type: 'text',
    text: field.title,
    question_text: null,
    options: null,
    media_url: null,
    media_type: null,
    caption: null,
    metadata: {
      ...md,
      ref: field.ref,
      type: 'webview',
      url,
      buttonText: buttonText || 'View website'
    }
  }
}

// The base address of a first-party service, from config. Read inline, the way
// replybot reads every other service address (`lib/index.js` BOTSERVER_URL,
// `typewheels/ourform.js` FORMCENTRAL_URL) -- there is no central config module
// to add it to.
//
// Missing config throws HERE, at the point of use, rather than at startup. That
// is a deliberate reading of "fail fast and loud", not a softening of it:
//
//   - It refuses to produce a wrong artifact. The alternative -- degrade, emit a
//     base-less or relative URL -- sends a participant a button that cannot
//     load, which is precisely the `.netlify.com` / `gbvlinks.nandan.cloud`
//     failure mode this design exists to make impossible. A URL never degrades.
//   - Refusing to START would take down all of replybot over a gap that affects
//     one field type. replybot serves every survey on the platform; only the
//     minority use these types. Crash-looping the whole deployment for that is a
//     self-inflicted outage strictly worse than the bug, and it would also break
//     every dev and test environment that has no reason to set the variable.
//   - The blast radius is already correctly bounded and already loud.
//     `transition.js` catches this and publishes an error report; because the
//     error carries no `tag`, it routes to the untagged `STATE_ACTIONS`
//     catch-all, which is read downstream as "platform fault" -- which a missing
//     environment variable is. A study-config error would be the wrong routing
//     and would blame the researcher for an ops mistake.
function serviceBase(envVar, fieldType, ref) {
  const base = process.env[envVar]

  if (!base || !String(base).trim()) {
    throw new Error(
      `[MISSING_SERVICE_URL] ${envVar} is not set, so the '${fieldType}' field ` +
      `'${ref}' has no base url to build from. Set it in the replybot env ` +
      `block of devops/values/<env>.yaml.`
    )
  }

  const trimmed = String(base).trim()

  // A base with no scheme (`links.vlab.digital`) is the obvious way to get this
  // wrong, and `new URL()` would reject it several frames later with "Invalid
  // URL" and no clue which variable was at fault. Name the variable and the
  // value here instead.
  try {
    new URL(trimmed) // eslint-disable-line no-new
  } catch (e) {
    throw new Error(
      `[INVALID_SERVICE_URL] ${envVar} is not an absolute url: ${trimmed}. ` +
      `It needs a scheme, e.g. https://links.vlab.digital`
    )
  }

  return trimmed
}

function warnIncomplete(fieldType, ref, missing) {
  if (missing.length > 0) {
    console.warn(`[FIRST_PARTY_URL_INCOMPLETE] type=${fieldType} ref=${ref} missing components: ${missing.join(', ')}`)
  }
}

// `link_tracking` -- a link whose click we record. The researcher writes the
// destination and nothing else:
//
//   type: link_tracking
//   url: https://who.int/hpv
//   buttonText: Read about HPV
//
// replybot builds the whole linksniffer URL: base from LINKSNIFFER_URL,
// destination split into `url` + `p`, identity from the conversation.
function translateLinkTracking(field, ctx) {
  const md = field.md || {}
  const base = serviceBase('LINKSNIFFER_URL', 'link_tracking', field.ref)

  if (!md.url) {
    throw new Error(`[MISSING_FIELD_CONTENT] the 'link_tracking' field '${field.ref}' has no 'url' to send the participant to.`)
  }

  const { url, missing } = buildLinkTrackingUrl(base, md.url, ctx)
  warnIncomplete('link_tracking', field.ref, missing)

  return webviewMessage(field, withExtensionsDefault(md), url, md.buttonText)
}

// `moviehouse` -- a tracked Vimeo video. The researcher writes the video id and
// nothing else:
//
//   type: moviehouse
//   videoId: "164118668"
//   buttonText: Watch the video
//   wait: { type: external, value: { type: moviehouse:play } }
//
// replybot builds the whole moviehouse URL: base from MOVIEHOUSE_URL, the video
// under `vlab_video`, identity from the conversation. There is no account id for
// a researcher to hardcode any more, which deletes the defect class outright:
// 465 of 570 stored moviehouse fields hardcode a page id, 63 of those are junk,
// and one routed a WhatsApp participant into a phantom Messenger conversation
// that is still BLOCKED in production
// (`planning/moviehouse-conversation-identity.md`).
function translateMoviehouse(field, ctx) {
  const md = field.md || {}
  const base = serviceBase('MOVIEHOUSE_URL', 'moviehouse', field.ref)

  // YAML parses a bare `videoId: 164118668` as a NUMBER, and a Vimeo id is an
  // opaque identifier rather than a quantity. 0 is not a valid id, so a falsy
  // check is safe here.
  if (!md.videoId) {
    throw new Error(`[MISSING_FIELD_CONTENT] the 'moviehouse' field '${field.ref}' has no 'videoId' to play.`)
  }

  const { url, missing } = buildMoviehouseUrl(base, md.videoId, ctx)
  warnIncomplete('moviehouse', field.ref, missing)

  return webviewMessage(field, withExtensionsDefault(md), url, md.buttonText)
}

// Messenger renders a webview button with `messenger_extensions: true` unless
// told otherwise (`message-worker/translator.go`), and that requires the domain
// to be whitelisted in the Facebook app or the button fails to open. Neither
// first-party page needs the extensions bridge on this path -- replybot supplies
// the participant in the URL, which is exactly what moviehouse's direct mode
// wants and what its Messenger-Extensions mode existed to work around. So these
// types default to `extensions: false`; a researcher can still override it.
function withExtensionsDefault(md) {
  return md.extensions === undefined ? { ...md, extensions: false } : md
}

function translateAttachment(field) {
  const md = field.md || {}
  const attachment = md.attachment || {}

  // Media already uploaded to the page is referenced by id, not URL. Without
  // this the URL fallback chain below puts the raw md JSON in media_url, which
  // Messenger rejects with "... should represent a valid URL".
  const attachmentId = attachment.attachment_id || null

  return {
    type: 'media',
    text: null,
    question_text: null,
    options: null,
    media_url: attachmentId ? null : (attachment.url || md.md || field.properties.description || ''),
    media_attachment_id: attachmentId,
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

function translateTypeformField(field, ctx) {
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

    case 'link_tracking':
      return translateLinkTracking(field, ctx)

    case 'moviehouse':
      return translateMoviehouse(field, ctx)

    case 'attachment':
      return translateAttachment(field)

    case 'utility_message':
      return translateUtilityMessage(field)

    default:
      throw new TypeError(`There is no translator for the question of type ${field.type}`)
  }
}

module.exports = {
  translateTypeformField,
  makeUrl,
  identityParams,
  splitDestination,
  buildServiceUrl,
  buildLinkTrackingUrl,
  buildMoviehouseUrl,
  IDENTITY_PARAMS,
  VIDEO_PARAM,
  DESTINATION_PARAM,
  PROTOCOL_PARAM
}
