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

  return {
    event_id: newEventId(),
    user_id: userId,
    timestamp,
    source: { type: 'synthetic', account_id: pageId },
    event_type: unifiedType,
    payload: event.value !== undefined ? event.value : null,
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
  categorizeMessengerEvent,
  parsePayload,
  newEventId
}
