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
// re-trigger entry, so partial matches are rejected outright. Widening the
// alphabet below does NOT relax that: the pattern stays `^...$` anchored and
// full-match, which is the property the whole no-accidental-re-entry rule
// rests on.
//
// Each `.`-separated token accepts unreserved characters OR a percent escape.
// The escape branch exists because WhatsApp has no advertiser-settable `ref`:
// on CTWA the shortcode and its targeting metadata reach us through the ad's
// autofill message text, and vlab's ad metadata values contain spaces
// ("Static English - Girls", "Bauchi State"). vlab percent-encodes them, so
// without `%` in the alphabet the text failed this gate, no
// conversation_started was derived, and the arrival silently landed on
// FALLBACK_FORM — a real survey whose misrouted users look like completions
// (the VIR-19 shape). Note the decoding half already worked: getMetadata does
// `_group(pairs.map(decodeURIComponent))`.
//
// The escape branch is `%[0-9A-Fa-f]{2}` and NOT a bare `%` on purpose. A bare
// `%` would admit `form.abc.k.%zz`, a trailing `%`, or a truncated `%2` — all
// of which make decodeURIComponent THROW. getMetadata swallows that throw
// (`catch (e) { md = {} }`), so md comes back empty and md.form falls to
// FALLBACK_FORM: the exact failure this widening exists to remove, in a
// harder-to-spot form.
//
// Caveat, deliberately not solved here: well-formed hex is necessary but NOT
// sufficient for decodeURIComponent. `%FF`, `%C3`, `%80` and `%E2%82` are all
// valid `%XX` octets that still throw, because they are not valid UTF-8. A
// regex cannot practically encode UTF-8 well-formedness, so the residual is
// handled where it belongs — see the safe per-token decode in
// typewheels/utils.js, which keeps one bad token from discarding the whole md.
//
// Both alternation branches are disjoint (`%` is not in the character class)
// and tokens are split by a literal `.` that neither branch can produce, so
// the pattern is unambiguous and backtracks linearly — no ReDoS exposure.
const WHATSAPP_ENTRY_REF = /^(?:start\s+)?form\.((?:[A-Za-z0-9_-]|%[0-9A-Fa-f]{2})+(?:\.(?:[A-Za-z0-9_-]|%[0-9A-Fa-f]{2})+)*)$/i

// Returns the `form.<shortcode>[.key.value...]` ref carried by a text message,
// or null. Shared by both WhatsApp entry paths — the wa.me prefilled-text link
// and a CTWA ad's autofill message — so they cannot drift apart.
//
// Only the literal `form.` prefix is normalized to lowercase (the pattern is
// case-insensitive) so getMetadata's `md.form` lookup always finds the
// shortcode; the shortcode and every metadata token keep the case as typed.
// The whole ref body is returned as-is — key/value parsing belongs to
// getMetadata()/_group (typewheels/utils.js) and is not duplicated here.
// The second entry anchor: an ENCODED recruitment ref, `r.<base64url>`.
//
// A separate pattern rather than another branch inside WHATSAPP_ENTRY_REF, on
// purpose. Sharing the `form.` anchor would mean replybot deciding at runtime
// whether `form.AbC123` is a literal shortcode or an encoded blob — a heuristic
// on the routing path, where a wrong guess costs a respondent their survey. Two
// disjoint anchors make the ref format an explicit property of what the ad
// shipped rather than something inferred from the shape of a token.
//
// The alphabet is exactly base64url's: no `%` branch and no `.`. An encoded ref
// is a single opaque token by construction, so neither percent escapes nor the
// dotted key/value grammar apply to it — and because `.` cannot appear, the two
// patterns are disjoint and can never both match one body. Anchored and
// full-match like its sibling, which is what stops a mid-survey free-text
// answer containing a token from re-triggering entry.
//
// Case matters here in a way it does not for the dotted form. base64url is
// case-SIGNIFICANT, and the `i` flag applies only to the literal `r.` prefix —
// the capture group preserves the body exactly as sent, the same way the
// shortcode does. Lower-casing it would silently corrupt every encoded ref.
const WHATSAPP_ENTRY_REF_ENCODED = /^(?:start\s+)?r\.([A-Za-z0-9_-]+)$/i

function _refFromText(data) {
  if (data.type !== 'text') return null
  const body = (data.text && data.text.body) || ''
  const trimmed = body.trim()

  const encoded = trimmed.match(WHATSAPP_ENTRY_REF_ENCODED)
  if (encoded) return `r.${encoded[1]}`

  const match = trimmed.match(WHATSAPP_ENTRY_REF)
  return match ? `form.${match[1]}` : null
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
  // carries the same dot-separated key.value metadata as an `m.me?ref=`
  // link. The character class after `form.` additionally accepts further
  // `.`-separated tokens, still anchored/full-match so strictness against
  // mid-survey free text is unchanged. We pass the WHOLE matched ref body
  // through as-is and let getMetadata()/_group (utils.js) do the key/value
  // parsing — this normalizer does not duplicate that logic.
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
