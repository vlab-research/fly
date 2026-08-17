const mocha = require('mocha')
const chai = require('chai')
const should = chai.should()
const { parseEvent, parsePayload, categorizeMessengerEvent, parseMessengerEvent, parseWhatsAppEvent, categorizeWhatsAppEvent, parseSyntheticEvent } = require('./event-normalizer')

describe('parseSyntheticEvent - platform hint', () => {
  it('surfaces an optional top-level platform field as source.platform', () => {
    const result = parseSyntheticEvent({
      user: 'user123',
      page: 'page456',
      platform: 'whatsapp',
      event: { type: 'timeout', value: 1234 }
    }, 1711100000000)

    result.event_type.should.equal('synthetic_timeout')
    result.source.type.should.equal('synthetic')
    result.source.account_id.should.equal('page456')
    result.source.platform.should.equal('whatsapp')
  })

  it('omits source.platform when the payload carries no platform', () => {
    const result = parseSyntheticEvent({
      user: 'user123',
      page: 'page456',
      event: { type: 'timeout', value: 1234 }
    }, 1711100000000)

    result.source.should.not.have.property('platform')
  })

  it('passes the platform hint through parseEvent for raw synthetic kafka events', () => {
    const result = parseEvent(JSON.stringify({
      user: 'user123',
      page: 'page456',
      source: 'synthetic',
      platform: 'whatsapp',
      timestamp: 1711100000000,
      event: { type: 'follow_up', value: null }
    }))

    result.event_type.should.equal('synthetic_follow_up')
    result.source.type.should.equal('synthetic')
    result.source.platform.should.equal('whatsapp')
  })
})

describe('parsePayload', () => {
  it('parses JSON string to object', () => {
    const result = parsePayload('{"value":"0","ref":"test-ref"}')
    result.should.deep.equal({ value: '0', ref: 'test-ref' })
  })

  it('returns object as-is if already an object', () => {
    const obj = { value: '0', ref: 'test-ref' }
    const result = parsePayload(obj)
    result.should.deep.equal(obj)
  })

  it('returns string as-is if JSON parse fails', () => {
    const result = parsePayload('invalid-json')
    result.should.equal('invalid-json')
  })

  it('handles null payload', () => {
    const result = parsePayload(null)
    should.not.exist(result)
  })

  it('handles plain string payload', () => {
    const result = parsePayload('simple-string')
    result.should.equal('simple-string')
  })
})

describe('categorizeMessengerEvent - quick_reply', () => {
  it('extracts value and ref from JSON string payload', () => {
    const event = {
      message: {
        quick_reply: {
          payload: '{"value":"0","ref":"msg_ref_123"}'
        },
        text: 'Opinion Scale Label'
      }
    }
    const result = categorizeMessengerEvent(event)
    result.should.deep.equal({
      event_type: 'user_interaction',
      payload: {
        type: 'user_interaction',
        value: '0',
        label: 'Opinion Scale Label',
        source_message_id: 'msg_ref_123',
        interaction_type: 'quick_reply'
      }
    })
  })

  it('extracts value and ref from object payload', () => {
    const event = {
      message: {
        quick_reply: {
          payload: { value: 'I Accept', ref: 'msg_ref_456' }
        },
        text: 'Legal Agreement Button'
      }
    }
    const result = categorizeMessengerEvent(event)
    result.should.deep.equal({
      event_type: 'user_interaction',
      payload: {
        type: 'user_interaction',
        value: 'I Accept',
        label: 'Legal Agreement Button',
        source_message_id: 'msg_ref_456',
        interaction_type: 'quick_reply'
      }
    })
  })

  it('handles plain string payload (legacy)', () => {
    const event = {
      message: {
        quick_reply: {
          payload: 'simple_value'
        },
        text: 'Button Label'
      }
    }
    const result = categorizeMessengerEvent(event)
    result.should.deep.equal({
      event_type: 'user_interaction',
      payload: {
        type: 'user_interaction',
        value: 'simple_value',
        label: 'Button Label',
        source_message_id: '',
        interaction_type: 'quick_reply'
      }
    })
  })

  it('handles missing ref', () => {
    const event = {
      message: {
        quick_reply: {
          payload: '{"value":"selected_option"}'
        },
        text: 'Option Label'
      }
    }
    const result = categorizeMessengerEvent(event)
    result.should.deep.equal({
      event_type: 'user_interaction',
      payload: {
        type: 'user_interaction',
        value: 'selected_option',
        label: 'Option Label',
        source_message_id: '',
        interaction_type: 'quick_reply'
      }
    })
  })

  it('handles payload with only ref (uses ref as value)', () => {
    const event = {
      message: {
        quick_reply: {
          payload: '{"ref":"msg_ref_789"}'
        },
        text: 'Label'
      }
    }
    const result = categorizeMessengerEvent(event)
    result.should.deep.equal({
      event_type: 'user_interaction',
      payload: {
        type: 'user_interaction',
        value: { ref: 'msg_ref_789' },
        label: 'Label',
        source_message_id: 'msg_ref_789',
        interaction_type: 'quick_reply'
      }
    })
  })
})

describe('categorizeMessengerEvent - postback', () => {
  it('extracts value and ref from JSON string payload', () => {
    const event = {
      postback: {
        payload: '{"value":"button_value","ref":"msg_ref_123"}',
        title: 'Button Title'
      }
    }
    const result = categorizeMessengerEvent(event)
    result.should.deep.equal({
      event_type: 'user_interaction',
      payload: {
        type: 'user_interaction',
        value: 'button_value',
        label: 'Button Title',
        source_message_id: 'msg_ref_123',
        interaction_type: 'postback'
      }
    })
  })

  it('extracts value and ref from object payload', () => {
    const event = {
      postback: {
        payload: { value: 'option_2', ref: 'msg_ref_456' },
        title: 'Option 2'
      }
    }
    const result = categorizeMessengerEvent(event)
    result.should.deep.equal({
      event_type: 'user_interaction',
      payload: {
        type: 'user_interaction',
        value: 'option_2',
        label: 'Option 2',
        source_message_id: 'msg_ref_456',
        interaction_type: 'postback'
      }
    })
  })

  it('handles plain string payload (legacy)', () => {
    const event = {
      postback: {
        payload: 'some_other_button',
        title: 'Button Title'
      }
    }
    const result = categorizeMessengerEvent(event)
    result.should.deep.equal({
      event_type: 'user_interaction',
      payload: {
        type: 'user_interaction',
        value: 'some_other_button',
        label: 'Button Title',
        source_message_id: '',
        interaction_type: 'postback'
      }
    })
  })

  it('treats get_started postback as conversation_started referral', () => {
    const event = {
      postback: {
        payload: 'get_started',
        title: 'Get Started'
      }
    }
    const result = categorizeMessengerEvent(event)
    result.event_type.should.equal('conversation_started')
    result.payload.type.should.equal('conversation_started')
  })
})

// VIR-19: Messenger delivers quick_reply and postback payloads as JSON
// STRINGS. Testing `.referral` against the unparsed string always yielded
// undefined, so ad clicks arriving via a quick-reply button normalized to
// user_interaction and lost their form shortcode to FALLBACK_FORM.
describe('categorizeMessengerEvent - referral inside a payload STRING (VIR-19)', () => {
  const REAL_REF = 'creative.3b.gender.men.geography.other_states2.form.hpvintrotriple'

  it('treats a quick_reply payload string carrying a referral as conversation_started', () => {
    const event = {
      message: {
        text: 'Get Started',
        quick_reply: {
          payload: JSON.stringify({ referral: { ref: REAL_REF } })
        }
      }
    }
    const result = categorizeMessengerEvent(event)
    result.event_type.should.equal('conversation_started')
    result.payload.type.should.equal('conversation_started')
    result.payload.trigger.should.equal('referral')
    result.payload.referral.ref.should.equal(REAL_REF)
  })

  it('treats a postback payload string carrying a referral as conversation_started', () => {
    const event = {
      postback: {
        title: 'Get Started',
        payload: JSON.stringify({ referral: { ref: REAL_REF } })
      }
    }
    const result = categorizeMessengerEvent(event)
    result.event_type.should.equal('conversation_started')
    result.payload.referral.ref.should.equal(REAL_REF)
  })

  it('still treats a referral object on the quick_reply payload as conversation_started', () => {
    const event = {
      message: {
        text: 'Get Started',
        quick_reply: { payload: { referral: { ref: REAL_REF } } }
      }
    }
    const result = categorizeMessengerEvent(event)
    result.event_type.should.equal('conversation_started')
    result.payload.referral.ref.should.equal(REAL_REF)
  })

  it('keeps a normal survey answer (payload string, no referral) a quick_reply interaction', () => {
    const event = {
      message: {
        text: 'Yes',
        quick_reply: { payload: '{"value":"1","ref":"intro_1"}' }
      }
    }
    const result = categorizeMessengerEvent(event)
    result.should.deep.equal({
      event_type: 'user_interaction',
      payload: {
        type: 'user_interaction',
        value: '1',
        label: 'Yes',
        source_message_id: 'intro_1',
        interaction_type: 'quick_reply'
      }
    })
  })

  it('keeps a normal survey answer (postback payload string, no referral) a postback interaction', () => {
    const event = {
      postback: {
        title: 'Yes',
        payload: '{"value":"1","ref":"intro_1"}'
      }
    }
    const result = categorizeMessengerEvent(event)
    result.payload.interaction_type.should.equal('postback')
    result.event_type.should.equal('user_interaction')
  })

  it('still treats the bare get_started postback as conversation_started', () => {
    const result = categorizeMessengerEvent({
      postback: { payload: 'get_started', title: 'Get Started' }
    })
    result.event_type.should.equal('conversation_started')
    should.not.exist(result.payload.referral)
  })

  it('does not throw and does not fabricate a referral for a malformed payload string', () => {
    const qr = () => categorizeMessengerEvent({
      message: { text: 'x', quick_reply: { payload: '{"referral": {' } }
    })
    qr.should.not.throw()
    qr().event_type.should.equal('user_interaction')

    const pb = () => categorizeMessengerEvent({
      postback: { title: 'x', payload: 'not json at all' }
    })
    pb.should.not.throw()
    pb().event_type.should.equal('user_interaction')
  })

  it('normalizes the real production webhook end-to-end', () => {
    const result = parseMessengerEvent({
      sender: { id: 'user_123' },
      recipient: { id: 'page_456' },
      message: {
        mid: 'm_abc',
        text: 'Get Started',
        quick_reply: { payload: `{"referral": {"ref": "${REAL_REF}"}}` }
      }
    }, 1711100000000)

    result.event_type.should.equal('conversation_started')
    result.payload.referral.ref.should.equal(REAL_REF)
  })
})

describe('parseMessengerEvent', () => {
  it('parses complete quick_reply event with JSON string payload', () => {
    const event = {
      sender: { id: 'user_123' },
      recipient: { id: 'page_456' },
      timestamp: 1234567890,
      message: {
        quick_reply: {
          payload: '{"value":"0","ref":"evt_ref_xyz"}'
        },
        text: 'Rating'
      }
    }
    const result = parseMessengerEvent(event, 1234567890)
    result.user_id.should.equal('user_123')
    result.event_type.should.equal('user_interaction')
    result.payload.value.should.equal('0')
    result.payload.source_message_id.should.equal('evt_ref_xyz')
    result.payload.interaction_type.should.equal('quick_reply')
    should.exist(result.event_id)
    should.exist(result.raw)
  })

  it('parses complete postback event with JSON string payload', () => {
    const event = {
      sender: { id: 'user_789' },
      recipient: { id: 'page_456' },
      timestamp: 1234567890,
      postback: {
        payload: '{"value":"accept","ref":"evt_ref_abc"}',
        title: 'Accept'
      }
    }
    const result = parseMessengerEvent(event, 1234567890)
    result.user_id.should.equal('user_789')
    result.event_type.should.equal('user_interaction')
    result.payload.value.should.equal('accept')
    result.payload.source_message_id.should.equal('evt_ref_abc')
    result.payload.interaction_type.should.equal('postback')
  })

  it('parses optin event carrying the subtype in optin_type and the OTN token', () => {
    const event = {
      sender: { id: 'user_123' },
      recipient: { id: 'page_456' },
      timestamp: 1234567890,
      optin: {
        type: 'one_time_notif_req',
        payload: '{ "ref": "notify_ref" }',
        one_time_notif_token: 'FOOBAR'
      }
    }
    const result = parseMessengerEvent(event, 1234567890)
    result.event_type.should.equal('optin')
    result.payload.type.should.equal('optin')
    result.payload.optin_type.should.equal('one_time_notif_req')
    result.payload.token.should.equal('FOOBAR')
    // the JSON-string payload is parsed so the notify validator can match ref
    result.payload.payload.ref.should.equal('notify_ref')
  })

  // md.ad_id (see utils.js "Ad identity" block) reads referral.ad_id directly
  // for Messenger. That only works if parseMessengerEvent/categorizeMessengerEvent
  // pass the referral through unmodified -- pin that here, once, at the
  // normalizer boundary. adIdFromReferral itself is covered exhaustively in
  // utils.test.js; this is not a re-test of that logic.
  it('preserves referral.ad_id through to payload.referral untouched', () => {
    const event = {
      sender: { id: 'user_123' },
      recipient: { id: 'page_456' },
      timestamp: 1234567890,
      referral: { ref: 'form.ABC', source: 'ADS', type: 'OPEN_THREAD', ad_id: '6041234567890' }
    }
    const result = parseMessengerEvent(event, 1234567890)
    result.event_type.should.equal('conversation_started')
    result.payload.referral.ad_id.should.equal('6041234567890')
  })
})

describe('parseEvent', () => {
  it('parses kafka event with quick_reply message containing JSON string payload', () => {
    const kafkaEvent = JSON.stringify({
      sender: { id: 'user_123' },
      recipient: { id: 'page_456' },
      timestamp: 1234567890,
      source: 'messenger',
      message: {
        quick_reply: {
          payload: '{"value":"1","ref":"message_ref_456"}'
        },
        text: 'Multiple Choice'
      }
    })
    const result = parseEvent(kafkaEvent)
    result.user_id.should.equal('user_123')
    result.event_type.should.equal('user_interaction')
    result.payload.value.should.equal('1')
    result.payload.source_message_id.should.equal('message_ref_456')
  })

  it('parses kafka event string containing quick_reply with object payload', () => {
    const kafkaEvent = JSON.stringify({
      sender: { id: 'user_456' },
      recipient: { id: 'page_789' },
      timestamp: 1234567890,
      source: 'messenger',
      message: {
        quick_reply: {
          payload: { value: 'yes', ref: 'msg_ref_789' }
        },
        text: 'Yes/No'
      }
    })
    const result = parseEvent(kafkaEvent)
    result.payload.value.should.equal('yes')
    result.payload.source_message_id.should.equal('msg_ref_789')
  })

  it('parses kafka event with postback containing JSON string payload', () => {
    const kafkaEvent = JSON.stringify({
      sender: { id: 'user_100' },
      recipient: { id: 'page_200' },
      timestamp: 1234567890,
      source: 'messenger',
      postback: {
        payload: '{"value":"confirm","ref":"msg_ref_100"}',
        title: 'Confirm'
      }
    })
    const result = parseEvent(kafkaEvent)
    result.payload.value.should.equal('confirm')
    result.payload.source_message_id.should.equal('msg_ref_100')
    result.payload.interaction_type.should.equal('postback')
  })
})

describe('categorizeWhatsAppEvent', () => {
  it('categorizes a text message as user_text', () => {
    const { event_type, payload } = categorizeWhatsAppEvent({ type: 'text', text: { body: 'hello' } })
    event_type.should.equal('user_text')
    payload.text.should.equal('hello')
  })

  it('categorizes an interactive button_reply as user_interaction with the title as value', () => {
    const { event_type, payload } = categorizeWhatsAppEvent({
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'ref_a', title: 'Yes' } }
    })
    event_type.should.equal('user_interaction')
    payload.value.should.equal('Yes')
    payload.label.should.equal('Yes')
    payload.source_message_id.should.equal('ref_a')
    payload.interaction_type.should.equal('quick_reply')
  })

  it('categorizes an interactive list_reply as user_interaction with the title as value', () => {
    const { payload } = categorizeWhatsAppEvent({
      type: 'interactive',
      interactive: { type: 'list_reply', list_reply: { id: 'row_1', title: 'Blue', description: 'the colour' } }
    })
    payload.value.should.equal('Blue')
    payload.source_message_id.should.equal('row_1')
  })

  it('categorizes a template button click (type button) as user_interaction', () => {
    const { event_type, payload } = categorizeWhatsAppEvent({ type: 'button', button: { text: 'Confirm', payload: 'p1' } })
    event_type.should.equal('user_interaction')
    payload.value.should.equal('Confirm')
  })

  it('categorizes a referral as conversation_started', () => {
    const { event_type, payload } = categorizeWhatsAppEvent({ type: 'text', text: { body: 'x' }, referral: { ref: 'form.ABC123' } })
    event_type.should.equal('conversation_started')
    payload.referral.ref.should.equal('form.ABC123')
  })

  it('maps a worker bot_echo to bot_message_sent carrying the metadata', () => {
    const { event_type, payload } = categorizeWhatsAppEvent({ type: 'bot_echo', metadata: { ref: 'q1', type: 'multiple_choice' } })
    event_type.should.equal('bot_message_sent')
    payload.metadata.ref.should.equal('q1')
    payload.metadata.type.should.equal('multiple_choice')
  })

  it('categorizes a delivered status as bot_message_delivered', () => {
    const { event_type, payload } = categorizeWhatsAppEvent({ status: 'delivered', timestamp: 1640995200000, recipient_id: 'u1' })
    event_type.should.equal('bot_message_delivered')
    payload.watermark.should.equal(1640995200000)
  })

  it('categorizes a read status as bot_message_read', () => {
    const { event_type } = categorizeWhatsAppEvent({ status: 'read', timestamp: 1, recipient_id: 'u1' })
    event_type.should.equal('bot_message_read')
  })

  it('categorizes image media as user_media', () => {
    const { event_type, payload } = categorizeWhatsAppEvent({ type: 'image', image: { id: 'media_1' } })
    event_type.should.equal('user_media')
    payload.attachments[0].type.should.equal('image')
    payload.attachments[0].payload.id.should.equal('media_1')
  })

  it('returns unknown for unrecognized types', () => {
    const { event_type } = categorizeWhatsAppEvent({ type: 'location' })
    event_type.should.equal('unknown')
  })

  describe('bare-text form ref entry (wa.me links, smoke tests)', () => {
    it('starts conversation when bare text matches form.<shortcode>', () => {
      const { event_type, payload } = categorizeWhatsAppEvent({ type: 'text', text: { body: 'form.KAvzEUWn' } })
      event_type.should.equal('conversation_started')
      payload.type.should.equal('conversation_started')
      payload.trigger.should.equal('referral')
      payload.referral.ref.should.equal('form.KAvzEUWn')
    })

    it('starts conversation with optional start prefix', () => {
      const { event_type, payload } = categorizeWhatsAppEvent({ type: 'text', text: { body: 'start form.KAvzEUWn' } })
      event_type.should.equal('conversation_started')
      payload.referral.ref.should.equal('form.KAvzEUWn')
    })

    it('matches case-insensitively but preserves shortcode case', () => {
      const { event_type, payload } = categorizeWhatsAppEvent({ type: 'text', text: { body: 'START FORM.abc' } })
      event_type.should.equal('conversation_started')
      // "abc" should be preserved exactly as typed (all lowercase)
      payload.referral.ref.should.equal('form.abc')
    })

    it('matches case-insensitively with mixed-case shortcode', () => {
      const { event_type, payload } = categorizeWhatsAppEvent({ type: 'text', text: { body: 'START form.AbCdEf' } })
      event_type.should.equal('conversation_started')
      payload.referral.ref.should.equal('form.AbCdEf')
    })

    it('tolerates leading and trailing whitespace', () => {
      const { event_type, payload } = categorizeWhatsAppEvent({ type: 'text', text: { body: '  form.abc  ' } })
      event_type.should.equal('conversation_started')
      payload.referral.ref.should.equal('form.abc')
    })

    it('rejects mid-survey free-text answer containing a ref token', () => {
      const { event_type } = categorizeWhatsAppEvent({ type: 'text', text: { body: 'I filled form.abc yesterday' } })
      event_type.should.equal('user_text')
    })

    it('rejects bare form. without a shortcode', () => {
      const { event_type } = categorizeWhatsAppEvent({ type: 'text', text: { body: 'form.' } })
      event_type.should.equal('user_text')
    })

    it('rejects plain numeric answer', () => {
      const { event_type, payload } = categorizeWhatsAppEvent({ type: 'text', text: { body: '590' } })
      event_type.should.equal('user_text')
      payload.text.should.equal('590')
    })

    it('still uses referral object when present (fallback not consulted)', () => {
      const { event_type, payload } = categorizeWhatsAppEvent({
        type: 'text',
        text: { body: 'form.XYZ' },
        referral: { ref: 'form.ABC123', source: 'ctwa' }
      })
      event_type.should.equal('conversation_started')
      payload.referral.ref.should.equal('form.ABC123')
    })

    it('accepts underscore and hyphen in shortcode', () => {
      const { event_type, payload } = categorizeWhatsAppEvent({ type: 'text', text: { body: 'form.abc_def-123' } })
      event_type.should.equal('conversation_started')
      payload.referral.ref.should.equal('form.abc_def-123')
    })

    it('rejects shortcode with invalid characters', () => {
      const { event_type } = categorizeWhatsAppEvent({ type: 'text', text: { body: 'form.abc@def' } })
      event_type.should.equal('user_text')
    })

    it('handles empty text body gracefully', () => {
      const { event_type } = categorizeWhatsAppEvent({ type: 'text', text: { body: '' } })
      event_type.should.equal('user_text')
    })

    it('handles null text body gracefully', () => {
      const { event_type } = categorizeWhatsAppEvent({ type: 'text', text: { body: null } })
      event_type.should.equal('user_text')
    })

    it('handles missing text object gracefully', () => {
      const { event_type } = categorizeWhatsAppEvent({ type: 'text' })
      event_type.should.equal('user_text')
    })
  })

  describe('bare-text form ref entry — Messenger-parity metadata (dot-separated key.value pairs)', () => {
    it('carries multiple key.value metadata pairs through as the whole matched ref', () => {
      const { event_type, payload } = categorizeWhatsAppEvent({ type: 'text', text: { body: 'form.ABC.creative.x.gender.men' } })
      event_type.should.equal('conversation_started')
      payload.trigger.should.equal('referral')
      payload.referral.ref.should.equal('form.ABC.creative.x.gender.men')
    })

    it('still works for the plain single-shortcode case', () => {
      const { event_type, payload } = categorizeWhatsAppEvent({ type: 'text', text: { body: 'form.flysmoke' } })
      event_type.should.equal('conversation_started')
      payload.referral.ref.should.equal('form.flysmoke')
    })

    it('supports the optional start prefix with metadata pairs', () => {
      const { event_type, payload } = categorizeWhatsAppEvent({ type: 'text', text: { body: 'start form.ABC.creative.x' } })
      event_type.should.equal('conversation_started')
      payload.referral.ref.should.equal('form.ABC.creative.x')
    })

    it('preserves case of the shortcode and metadata pairs exactly as typed', () => {
      const { event_type, payload } = categorizeWhatsAppEvent({ type: 'text', text: { body: 'FORM.MyForm.Creative.X.Gender.Men' } })
      event_type.should.equal('conversation_started')
      // "form." prefix is normalized to lowercase (matched case-insensitively);
      // everything after it is preserved verbatim.
      payload.referral.ref.should.equal('form.MyForm.Creative.X.Gender.Men')
    })

    it('handles a dangling odd-numbered token without throwing', () => {
      let result
      ;(() => { result = categorizeWhatsAppEvent({ type: 'text', text: { body: 'form.ABC.creative' } }) }).should.not.throw()
      result.event_type.should.equal('conversation_started')
      result.payload.referral.ref.should.equal('form.ABC.creative')
    })

    it('still rejects mid-survey free text containing dots and a form-like token', () => {
      const { event_type } = categorizeWhatsAppEvent({ type: 'text', text: { body: 'I already did form.ABC.creative.x yesterday' } })
      event_type.should.equal('user_text')
    })

    it('still rejects any whitespace inside the ref, even between metadata pairs', () => {
      const { event_type } = categorizeWhatsAppEvent({ type: 'text', text: { body: 'form.ABC. creative.x' } })
      event_type.should.equal('user_text')
    })

    it('still rejects invalid characters anywhere in the metadata chain', () => {
      const { event_type } = categorizeWhatsAppEvent({ type: 'text', text: { body: 'form.ABC.creative@x' } })
      event_type.should.equal('user_text')
    })

    it('still rejects an empty trailing token (double dot)', () => {
      const { event_type } = categorizeWhatsAppEvent({ type: 'text', text: { body: 'form.ABC..creative' } })
      event_type.should.equal('user_text')
    })
  })

  // A real Click-to-WhatsApp referral object carries only Meta-assigned fields
  // (source_url / source_id / source_type / headline / body / media_type /
  // ctwa_clid) — none of which is a form ref. Without a `ref`, getMetadata's
  // `if (r && r.ref)` guard fails and the user silently lands on FALLBACK_FORM:
  // the VIR-19 failure shape. The ad's autofill_message prefills the user's
  // first message with the same entry token the wa.me path uses, so the ref is
  // recovered from `text.body` when the referral itself has none.
  describe('CTWA referral without a ref — recover the form from the autofill text', () => {
    const ctwaReferral = {
      source_url: 'https://fb.me/3cr4Wqqkv',
      source_id: '120226305854810726',
      source_type: 'ad',
      headline: 'Take our survey',
      body: 'Tap to start',
      media_type: 'image',
      ctwa_clid: 'AAbbCCddEE'
    }

    it('derives the ref from the autofill text when the referral has none', () => {
      const { event_type, payload } = categorizeWhatsAppEvent({
        type: 'text',
        text: { body: 'form.hpvintrotriple.creative.3b.gender.men' },
        referral: ctwaReferral
      })
      event_type.should.equal('conversation_started')
      payload.referral.ref.should.equal('form.hpvintrotriple.creative.3b.gender.men')
    })

    it('preserves the rest of the CTWA referral, ctwa_clid especially', () => {
      // ctwa_clid is what Conversions API attribution keys on — dropping it
      // would silently break ad attribution.
      const { payload } = categorizeWhatsAppEvent({
        type: 'text',
        text: { body: 'form.ABC' },
        referral: ctwaReferral
      })
      payload.referral.ctwa_clid.should.equal('AAbbCCddEE')
      payload.referral.source_id.should.equal('120226305854810726')
      payload.referral.headline.should.equal('Take our survey')
    })

    // md.ad_id's whatsapp gate (see utils.js "Ad identity" block) reads
    // source_type off the referral to decide whether source_id is trustworthy
    // as an ad id. That gate is only meaningful if source_type survives
    // normalization unmodified -- pin that here, once, at the normalizer
    // boundary. The gate logic itself (post vs ad) is covered exhaustively in
    // utils.test.js; this is not a re-test of that logic.
    it('preserves source_type, the field the ad-sourcing gate reads', () => {
      const { payload } = categorizeWhatsAppEvent({
        type: 'text',
        text: { body: 'form.ABC' },
        referral: ctwaReferral
      })
      payload.referral.source_type.should.equal('ad')
    })

    it('does NOT mutate the inbound referral object', () => {
      const referral = { ...ctwaReferral }
      categorizeWhatsAppEvent({ type: 'text', text: { body: 'form.ABC' }, referral })
      should.not.exist(referral.ref)
    })

    it('prefers an explicit referral.ref over the text when both are present', () => {
      const { payload } = categorizeWhatsAppEvent({
        type: 'text',
        text: { body: 'form.fromtext' },
        referral: { ...ctwaReferral, ref: 'form.fromref.creative.9z' }
      })
      payload.referral.ref.should.equal('form.fromref.creative.9z')
    })

    it('still starts a conversation (falling back) when neither ref nor a matching text exists', () => {
      // A CTWA click IS a conversation start even if we cannot resolve a form
      // from it — it must not degrade into a plain user_text.
      const { event_type, payload } = categorizeWhatsAppEvent({
        type: 'text',
        text: { body: 'hello there' },
        referral: ctwaReferral
      })
      event_type.should.equal('conversation_started')
      should.not.exist(payload.referral.ref)
    })

    it('still starts a conversation when the CTWA reply is not text at all', () => {
      const { event_type, payload } = categorizeWhatsAppEvent({
        type: 'image',
        image: { id: 'abc' },
        referral: ctwaReferral
      })
      event_type.should.equal('conversation_started')
      should.not.exist(payload.referral.ref)
    })

    it('does not let a non-matching CTWA text bypass entry strictness', () => {
      const { payload } = categorizeWhatsAppEvent({
        type: 'text',
        text: { body: 'I already did form.ABC yesterday' },
        referral: ctwaReferral
      })
      should.not.exist(payload.referral.ref)
    })
  })
})

describe('parseWhatsAppEvent', () => {
  it('builds a UniversalEvent from a WhatsApp text message', () => {
    const data = { from: '27123', phone_number_id: 'PHONE_1', type: 'text', text: { body: 'hi' }, timestamp: 1640995200000 }
    const result = parseWhatsAppEvent(data, 1640995200000)
    result.user_id.should.equal('27123')
    result.source.type.should.equal('whatsapp')
    result.source.account_id.should.equal('PHONE_1')
    result.event_type.should.equal('user_text')
    result.payload.text.should.equal('hi')
  })

  it('keys a status event on recipient_id', () => {
    const data = { status: 'delivered', recipient_id: '27123', phone_number_id: 'PHONE_1', timestamp: 1 }
    const result = parseWhatsAppEvent(data, 1)
    result.user_id.should.equal('27123')
    result.event_type.should.equal('bot_message_delivered')
  })
})

describe('parseEvent - whatsapp source', () => {
  it('dispatches source:whatsapp through parseWhatsAppEvent', () => {
    const kafkaEvent = JSON.stringify({
      source: 'whatsapp',
      phone_number_id: 'PHONE_1',
      from: '27123',
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'r0', title: 'Red' } },
      timestamp: 1640995200000
    })
    const result = parseEvent(kafkaEvent)
    result.source.type.should.equal('whatsapp')
    result.event_type.should.equal('user_interaction')
    result.payload.value.should.equal('Red')
  })

  describe('WhatsApp inbound media with id, url, mime_type, sha256', () => {
    it('normalizes image with all media fields from real WhatsApp webhook', () => {
      const { event_type, payload } = categorizeWhatsAppEvent({
        type: 'image',
        image: {
          id: '1234567890',
          url: 'https://media.example.com/image123',
          mime_type: 'image/jpeg',
          sha256: 'abcdef123456'
        }
      })
      event_type.should.equal('user_media')
      payload.type.should.equal('user_media')
      payload.attachments[0].type.should.equal('image')
      payload.attachments[0].payload.id.should.equal('1234567890')
      payload.attachments[0].payload.url.should.equal('https://media.example.com/image123')
      payload.attachments[0].payload.mime_type.should.equal('image/jpeg')
      payload.attachments[0].payload.sha256.should.equal('abcdef123456')
    })

    it('normalizes video with all media fields', () => {
      const { event_type, payload } = categorizeWhatsAppEvent({
        type: 'video',
        video: {
          id: 'vid_001',
          url: 'https://media.example.com/video456',
          mime_type: 'video/mp4',
          sha256: 'xyz789'
        }
      })
      event_type.should.equal('user_media')
      payload.attachments[0].type.should.equal('video')
      payload.attachments[0].payload.id.should.equal('vid_001')
      payload.attachments[0].payload.mime_type.should.equal('video/mp4')
    })

    it('normalizes audio with all media fields', () => {
      const { event_type, payload } = categorizeWhatsAppEvent({
        type: 'audio',
        audio: {
          id: 'aud_002',
          url: 'https://media.example.com/audio789',
          mime_type: 'audio/mpeg',
          sha256: 'sound123'
        }
      })
      event_type.should.equal('user_media')
      payload.attachments[0].type.should.equal('audio')
      payload.attachments[0].payload.id.should.equal('aud_002')
    })

    it('normalizes voice as audio with all fields', () => {
      const { event_type, payload } = categorizeWhatsAppEvent({
        type: 'voice',
        voice: {
          id: 'voice_003',
          url: 'https://media.example.com/voice999',
          mime_type: 'audio/ogg',
          sha256: 'voice_sha'
        }
      })
      event_type.should.equal('user_media')
      payload.attachments[0].type.should.equal('audio')
      payload.attachments[0].payload.id.should.equal('voice_003')
    })

    it('normalizes document with all fields', () => {
      const { event_type, payload } = categorizeWhatsAppEvent({
        type: 'document',
        document: {
          id: 'doc_004',
          url: 'https://media.example.com/document.pdf',
          mime_type: 'application/pdf',
          sha256: 'doc_sha256'
        }
      })
      event_type.should.equal('user_media')
      payload.attachments[0].type.should.equal('document')
      payload.attachments[0].payload.id.should.equal('doc_004')
    })

    it('normalizes sticker with all fields', () => {
      const { event_type, payload } = categorizeWhatsAppEvent({
        type: 'sticker',
        sticker: {
          id: 'stk_005',
          url: 'https://media.example.com/sticker.webp',
          mime_type: 'image/webp',
          sha256: 'sticker_sha'
        }
      })
      event_type.should.equal('user_media')
      payload.attachments[0].type.should.equal('sticker')
      payload.attachments[0].payload.id.should.equal('stk_005')
    })

    it('handles media with missing optional fields (nulls gracefully)', () => {
      const { event_type, payload } = categorizeWhatsAppEvent({
        type: 'image',
        image: { id: 'img_only' }
      })
      event_type.should.equal('user_media')
      payload.attachments[0].payload.id.should.equal('img_only')
      should.equal(payload.attachments[0].payload.url, null)
      should.equal(payload.attachments[0].payload.mime_type, null)
      should.equal(payload.attachments[0].payload.sha256, null)
    })

    it('prefers media.url over media.link when both present', () => {
      const { payload } = categorizeWhatsAppEvent({
        type: 'image',
        image: {
          id: 'img_prefer',
          url: 'https://api.example.com/url',
          link: 'https://api.example.com/link'
        }
      })
      payload.attachments[0].payload.url.should.equal('https://api.example.com/url')
    })

    it('falls back to media.link if media.url is absent', () => {
      const { payload } = categorizeWhatsAppEvent({
        type: 'image',
        image: {
          id: 'img_fallback',
          link: 'https://api.example.com/fallback_link'
        }
      })
      payload.attachments[0].payload.url.should.equal('https://api.example.com/fallback_link')
    })
  })
})
