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
  if (data.referral ||
      (data.postback && data.postback.referral) ||
      (data.postback && data.postback.payload === 'get_started') ||
      (data.postback && data.postback.payload && data.postback.payload.referral) ||
      (data.message && data.message.quick_reply && data.message.quick_reply.payload && data.message.quick_reply.payload.referral)) {
    const referral = data.referral ||
      (data.postback && data.postback.referral) ||
      (data.postback && data.postback.payload && data.postback.payload.referral) ||
      (data.message && data.message.quick_reply && data.message.quick_reply.payload && data.message.quick_reply.payload.referral)

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
      const payloadObj = parsePayload(data.message.quick_reply.payload)
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
    const payloadObj = parsePayload(data.postback.payload)
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
function categorizeWhatsAppEvent(data) {
  // A referral (click-to-WhatsApp / ref link) starts a conversation, exactly
  // like a Messenger referral — payload.referral.ref carries `form.<shortcode>`.
  if (data.referral) {
    return {
      event_type: 'conversation_started',
      payload: {
        type: 'conversation_started',
        trigger: 'referral',
        referral: data.referral
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
  if (data.type === 'text' && !data.referral) {
    const body = (data.text && data.text.body) || ''
    const trimmed = body.trim()
    const refPattern = /^(?:start\s+)?form\.([A-Za-z0-9_-]+)$/i
    const match = trimmed.match(refPattern)
    if (match) {
      // Preserve shortcode case exactly as typed; prefix is always lowercase
      const shortcode = match[1]
      return {
        event_type: 'conversation_started',
        payload: {
          type: 'conversation_started',
          trigger: 'referral',
          referral: { ref: `form.${shortcode}` }
        }
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
          payload: { id: media.id || null, url: media.link || null }
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
