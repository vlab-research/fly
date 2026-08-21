const crypto = require('crypto')

function newEventId() {
  return `evt_${crypto.randomUUID()}`
}

function parsePayload(payload) {
  if (payload == null) return null
  if (typeof payload === 'object') return payload
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload)
    } catch (e) {
      return payload
    }
  }
  return payload
}

function categorizeMessengerEvent(data) {
  // Messenger delivers quick_reply/postback payloads as JSON STRINGS, so these
  // must be parsed BEFORE testing for `.referral` -- reading `.referral` off
  // the raw string always yields undefined (VIR-19), which silently demoted
  // ad-click entries to user_interaction and lost the form shortcode to
  // FALLBACK_FORM. parsePayload returns non-JSON strings unchanged, so the
  // bare 'get_started' postback still compares equal after parsing.
  const postbackPayload = data.postback ? parsePayload(data.postback.payload) : null
  const quickReplyPayload = (data.message && data.message.quick_reply)
    ? parsePayload(data.message.quick_reply.payload)
    : null

  const referral = data.referral ||
    (data.postback && data.postback.referral) ||
    (postbackPayload && postbackPayload.referral) ||
    (quickReplyPayload && quickReplyPayload.referral)

  // A bare `get_started` postback is a conversation ENTRY carrying no referral,
  // so it resolves to FALLBACK_FORM downstream. That is deliberate and
  // load-bearing: it is how an organic (non-ad) Messenger user starts a survey,
  // and it accounts for roughly a third of production's 162,148 fallback
  // conversations -- 158 of 159 replayed `get_started` entries had no referral
  // anywhere in their log. Do NOT demote it to `user_interaction` to stop it
  // reaching the REFERRAL case; that breaks organic entry outright.
  //
  // What must not happen is a form-less entry RE-entering a conversation that
  // already has a form. That is refused one layer down, in machine.js's REFERRAL
  // case (`_refNamesForm`), because the same refusal has to cover a referral whose
  // ref names no form -- `clickToMessengerAds`, a CTWA referral object with no
  // `ref` -- which is indistinguishable from a real referral here. The normalizer
  // reports what arrived; the machine decides what it may do.
  if (referral || postbackPayload === 'get_started') {
    return {
      event_type: 'conversation_started',
      payload: {
        type: 'conversation_started',
        trigger: 'referral',
        referral
      }
    }
  }

  if (data.message) {
    if (data.message.is_echo) {
      let metadata = data.message.metadata
      if (typeof metadata === 'string') {
        try {
          metadata = JSON.parse(metadata)
        } catch (e) {
          // metadata remains as string
        }
      }

      return {
        event_type: 'bot_message_sent',
        payload: {
          type: 'bot_message_sent',
          ...data.message,
          metadata
        }
      }
    }

    if (data.message.quick_reply) {
      const payloadObj = quickReplyPayload
      const value = (payloadObj && payloadObj.value !== undefined) ? payloadObj.value : payloadObj
      const ref = payloadObj && payloadObj.ref

      return {
        event_type: 'user_interaction',
        payload: {
          type: 'user_interaction',
          value,
          label: data.message.text || '',
          source_message_id: ref || '',
          interaction_type: 'quick_reply'
        }
      }
    }

    if (data.message.text !== undefined) {
      return {
        event_type: 'user_text',
        payload: {
          type: 'user_text',
          text: data.message.text
        }
      }
    }

    if (data.message.attachments || data.message.stickerId) {
      return {
        event_type: 'user_media',
        payload: {
          type: 'user_media',
          attachments: data.message.attachments || null,
          stickerId: data.message.stickerId || null
        }
      }
    }
  }

  if (data.postback) {
    const payloadObj = postbackPayload
    const value = (payloadObj && payloadObj.value !== undefined) ? payloadObj.value : payloadObj
    const ref = payloadObj && payloadObj.ref

    return {
      event_type: 'user_interaction',
      payload: {
        type: 'user_interaction',
        value,
        label: data.postback.title || '',
        source_message_id: ref || '',
        interaction_type: 'postback'
      }
    }
  }

  if (data.read) {
    return {
      event_type: 'bot_message_read',
      payload: {
        type: 'bot_message_read',
        watermark: data.read.watermark,
        read_at: data.timestamp
      }
    }
  }

  if (data.delivery) {
    return {
      event_type: 'bot_message_delivered',
      payload: {
        type: 'bot_message_delivered',
        watermark: data.delivery.watermark,
        delivered_at: data.timestamp
      }
    }
  }

  if (data.reaction) {
    return {
      event_type: 'user_reaction',
      payload: {
        type: 'user_reaction',
        reaction: data.reaction.reaction,
        emoji: data.reaction.emoji,
        action: data.reaction.action
      }
    }
  }

  if (data.optin) {
    return {
      event_type: 'optin',
      payload: {
        type: 'optin',
        optin_type: data.optin.type,
        token: data.optin.one_time_notif_token,
        // Messenger sends the optin payload as a JSON string (the notify
        // field's {"ref": ...}); parse it like quick_reply/postback payloads
        // so the notify validator can match the ref.
        payload: parsePayload(data.optin.payload)
      }
    }
  }

  if (data.pass_thread_control) {
    const newOwnerAppId = data.pass_thread_control.new_owner_app_id
    return {
      event_type: 'handover',
      payload: {
        type: 'handover',
        previous_owner_app_id: data.pass_thread_control.previous_owner_app_id,
        new_owner_app_id: newOwnerAppId != null ? String(newOwnerAppId) : undefined,
        metadata: data.pass_thread_control.metadata
      }
    }
  }

  return {
    event_type: 'unknown',
    payload: { type: 'unknown' }
  }
}

function parseMessengerEvent(data, timestamp) {
  const senderId = data.sender && data.sender.id
  const recipientId = data.recipient && data.recipient.id

  const isEcho = data.message && data.message.is_echo

  let userId, pageId
  if (isEcho) {
    userId = recipientId
    pageId = senderId
  } else {
    userId = senderId
    pageId = recipientId
  }

  const { event_type, payload } = categorizeMessengerEvent(data)

  return {
    event_id: newEventId(),
    user_id: userId,
    timestamp,
    source: { type: 'messenger', account_id: pageId },
    event_type,
    payload,
    raw: data
  }
}

function parseSyntheticEvent(data, timestamp) {
  const event = data.event || {}
  const eventType = event.type || 'unknown'
  const unifiedType = `synthetic_${eventType}`

  const userId = data.user_id || data.user || ''
  const pageId = data.page || data.pageid || data.account_id

  // Synthetic events may carry the conversation's real platform as an
  // optional top-level field ("platform": "messenger" | "whatsapp") — dean
  // sends it and hermes/botserver pass it through. Surface it as
  // source.platform so downstream consumers can recover the real platform;
  // source.type stays 'synthetic'.
  const source = { type: 'synthetic', account_id: pageId }
  if (data.platform) {
    source.platform = data.platform
  }

  return {
    event_id: newEventId(),
    user_id: userId,
    timestamp,
    source,
    event_type: unifiedType,
    payload: event.value !== undefined ? event.value : null,
    raw: data
  }
}

// WhatsApp Cloud API. Hermes publishes one raw event per `messages[]` /
// `statuses[]` item, augmented with `source: 'whatsapp'`, `phone_number_id`,
// and a normalized (ms) `timestamp`. This maps each to the same event_type
// vocabulary the machine already understands (see categorizeMessengerEvent).
// Anchored, full-match pattern for a WhatsApp entry token. STRICT by design: a
// mid-survey free-text answer that merely contains a ref token must not
// re-trigger entry, so partial matches are rejected outright.
//
// The `form` pair may sit ANYWHERE in the dot-separated key.value list, not
// only first. Messenger `m.me?ref=` links have always been written form-last
// (`creative.3b.gender.men.form.hpvintrotriple`) and a real CTWA ad's
// autofill_message reads the same way — `ctwaprobe.alpha.creative.Ad1H.form.
// probetest`. Anchoring on a leading `form.` rejected those outright and
// dropped the arrival to FALLBACK_FORM: the VIR-19 failure shape, reproduced
// live on 2026-08-16.
//
// FALLBACK_FORM is NOT another account's survey, and nothing here crosses an
// account boundary. Shortcodes are user-scoped: formcentral resolves one by
// `s.userid = (SELECT userid FROM credentials WHERE key = <pageid>)`
// (formcentral/db.go:82), so FALLBACK_FORM always names a survey owned by
// whoever owns the account the conversation is already on. The harm is
// misattribution WITHIN that account -- the participant lands on the owner's
// fallback survey instead of the survey the ref named, and then counts as
// activity there.
//
// The pair must still begin on an EVEN token boundary, which is what the
// leading `(?:key\.value\.)*` group enforces. getMetadata()/_group
// (typewheels/utils.js) pairs tokens two at a time, so a `form` token landing
// in a value slot resolves to no form at all (`creative.form.ABC` groups to
// `{ creative: 'form', ABC: undefined }`). Refusing to match those leaves the
// message an ordinary user_text rather than synthesizing a referral that
// cannot resolve.
//
// Capture groups: 1 = leading key.value pairs, 2 = shortcode, 3 = trailing tokens.
const WHATSAPP_ENTRY_REF = /^(?:start\s+)?((?:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.)*)form\.([A-Za-z0-9_-]+)((?:\.[A-Za-z0-9_-]+)*)$/i

// Returns the `[key.value...]form.<shortcode>[.key.value...]` ref carried by a
// text message, or null. Shared by both WhatsApp entry paths — the wa.me
// prefilled-text link and a CTWA ad's autofill message — so they cannot drift
// apart.
//
// Only the literal `form` token is normalized to lowercase (the pattern is
// case-insensitive) so getMetadata's `md.form` lookup always finds the
// shortcode; the shortcode and every metadata token keep the case as typed.
// The ref is otherwise reassembled exactly as matched — key/value parsing
// belongs to getMetadata()/_group (typewheels/utils.js) and is not duplicated
// here.
function _refFromText(data) {
  if (data.type !== 'text') return null
  const body = (data.text && data.text.body) || ''
  const match = body.trim().match(WHATSAPP_ENTRY_REF)
  if (!match) return null

  const [, leading, shortcode, trailing] = match
  return `${leading}form.${shortcode}${trailing}`
}

function categorizeWhatsAppEvent(data) {
  // A referral starts a conversation, exactly like a Messenger referral —
  // getMetadata() reads the form shortcode off `payload.referral.ref`.
  //
  // But a real Click-to-WhatsApp referral is NOT guaranteed to carry `ref`.
  // Meta's documented CTWA referral fields are source_url / source_id /
  // source_type / headline / body / media_type / ctwa_clid — all Meta-assigned,
  // none of them ours, and `ref` appears in exactly one Meta doc with no
  // explanation of how to set it. A referral without `ref` fails getMetadata's
  // `if (r && r.ref)` guard and silently resolves to FALLBACK_FORM — the same
  // failure shape as VIR-19, and just as invisible, because the fallback is a
  // real survey that looks like a completion.
  //
  // The metadata is still recoverable: a CTWA ad's autofill_message prefills
  // the user's first message, so the SAME `form.<shortcode>[.key.value...]`
  // token the wa.me path uses arrives on `text.body` alongside the referral.
  // So when the referral carries no usable `ref`, derive one from the text
  // rather than short-circuiting past it. The rest of the referral object is
  // preserved — ctwa_clid in particular is what Conversions API attribution
  // keys on, so it must survive.
  if (data.referral) {
    let referral = data.referral
    if (!referral.ref) {
      const ref = _refFromText(data)
      if (ref) referral = { ...referral, ref }
    }
    return {
      event_type: 'conversation_started',
      payload: {
        type: 'conversation_started',
        trigger: 'referral',
        referral
      }
    }
  }

  // Bare-text entry fallback: if there is no referral and the message is plain
  // text, test it against a strict full-match pattern for form refs. This allows
  // wa.me/<number>?text=form.<shortcode> links and real-phone smoke tests to
  // start surveys without Click-to-WhatsApp ads. The pattern is STRICT
  // (full-match, anchored) to prevent mid-survey free-text answers from
  // accidentally re-triggering a referral — an existing user answering a
  // question must not be interrupted by a ref token in their text reply.
  // On match, synthesize a referral shape so machine.js's REFERRAL logic
  // (no-retake, ignore rules) applies identically to both entry paths.
  //
  // Messenger parity: `wa.me/<number>?text=form.ABC.creative.x.gender.men`
  // carries the same dot-separated key.value metadata as an `m.me?ref=` link,
  // and — like `m.me?ref=` — the `form` pair may appear anywhere in that list
  // rather than only first. The pattern stays anchored/full-match, so
  // strictness against mid-survey free text is unchanged. We pass the WHOLE
  // matched ref body through and let getMetadata()/_group (utils.js) do the
  // key/value parsing — this normalizer does not duplicate that logic.
  //
  // An odd number of tokens (e.g. `form.ABC.creative`, a dangling key with
  // no value) is deliberately allowed to match: _group() pairs tokens two at
  // a time and assigns `undefined` to a trailing unpaired key rather than
  // throwing, so `state.md.creative` ends up `undefined` instead of the
  // request being dropped. See event-normalizer.test.js for coverage.
  const bareRef = _refFromText(data)
  if (bareRef) {
    return {
      event_type: 'conversation_started',
      payload: {
        type: 'conversation_started',
        trigger: 'referral',
        referral: { ref: bareRef }
      }
    }
  }

  // Synthetic echo emitted by the message-worker after a successful WhatsApp
  // send (WhatsApp has no native message echo). Carries the outbound message's
  // metadata so the ECHO handler can advance the conversation, exactly like a
  // Messenger is_echo message.
  if (data.type === 'bot_echo') {
    return {
      event_type: 'bot_message_sent',
      payload: {
        type: 'bot_message_sent',
        metadata: data.metadata
      }
    }
  }

  // Delivery/read/sent receipts (statuses[]) → watermarks, like Messenger.
  if (data.status) {
    const statusMap = {
      delivered: 'bot_message_delivered',
      read: 'bot_message_read',
      sent: 'bot_message_sent'
    }
    const eventType = statusMap[data.status] || 'bot_message_delivered'
    return {
      event_type: eventType,
      payload: {
        type: eventType,
        watermark: data.timestamp,
        status_at: data.timestamp
      }
    }
  }

  if (data.type === 'text') {
    return {
      event_type: 'user_text',
      payload: {
        type: 'user_text',
        text: (data.text && data.text.body) || ''
      }
    }
  }

  // Interactive replies (button_reply / list_reply). The machine validates
  // choice answers against the field's option LABELS, so value = the reply
  // title (the visible label); the reply id is kept as source_message_id.
  if (data.type === 'interactive' && data.interactive) {
    const reply = data.interactive.button_reply || data.interactive.list_reply || {}
    const label = reply.title || ''
    return {
      event_type: 'user_interaction',
      payload: {
        type: 'user_interaction',
        value: label,
        label,
        source_message_id: reply.id || '',
        interaction_type: 'quick_reply'
      }
    }
  }

  // Template quick-reply button click (type: 'button').
  if (data.type === 'button' && data.button) {
    const label = data.button.text || ''
    return {
      event_type: 'user_interaction',
      payload: {
        type: 'user_interaction',
        value: label,
        label,
        source_message_id: data.button.payload || '',
        interaction_type: 'quick_reply'
      }
    }
  }

  if (['image', 'video', 'audio', 'voice', 'document', 'sticker'].includes(data.type)) {
    const media = data[data.type] || {}
    return {
      event_type: 'user_media',
      payload: {
        type: 'user_media',
        attachments: [{
          type: data.type === 'voice' ? 'audio' : data.type,
          payload: {
            id: media.id || null,
            url: media.url || media.link || null,
            mime_type: media.mime_type || null,
            sha256: media.sha256 || null
          }
        }],
        stickerId: null
      }
    }
  }

  return {
    event_type: 'unknown',
    payload: { type: 'unknown' }
  }
}

function parseWhatsAppEvent(data, timestamp) {
  const isStatus = !!data.status
  const userId = isStatus ? (data.recipient_id || '') : (data.from || '')
  const accountId = data.phone_number_id

  const { event_type, payload } = categorizeWhatsAppEvent(data)

  return {
    event_id: newEventId(),
    user_id: userId,
    timestamp,
    source: { type: 'whatsapp', account_id: accountId },
    event_type,
    payload,
    raw: data
  }
}

function parseEvent(rawKafkaEvent) {
  let parsed
  if (typeof rawKafkaEvent === 'string') {
    try {
      parsed = JSON.parse(rawKafkaEvent)
    } catch (e) {
      return {
        event_id: newEventId(),
        user_id: '',
        timestamp: Date.now(),
        source: { type: 'unknown' },
        event_type: 'unknown',
        payload: {},
        raw: rawKafkaEvent
      }
    }
  } else if (typeof rawKafkaEvent === 'object' && rawKafkaEvent !== null) {
    parsed = rawKafkaEvent
  } else {
    throw new Error('Invalid raw Kafka event: expected string or object')
  }

  if (parsed.event_type) {
    return parsed
  }

  const source = parsed.source
  const timestamp = parsed.timestamp || Date.now()

  switch (source) {
    case 'messenger':
      return parseMessengerEvent(parsed, timestamp)
    case 'synthetic':
      return parseSyntheticEvent(parsed, timestamp)
    case 'whatsapp':
      return parseWhatsAppEvent(parsed, timestamp)
    default:
      return {
        event_id: newEventId(),
        user_id: '',
        timestamp,
        source: { type: source || 'unknown' },
        event_type: 'unknown',
        payload: {},
        raw: parsed
      }
  }
}

module.exports = {
  parseEvent,
  parseMessengerEvent,
  parseSyntheticEvent,
  parseWhatsAppEvent,
  categorizeMessengerEvent,
  categorizeWhatsAppEvent,
  parsePayload,
  newEventId
}
