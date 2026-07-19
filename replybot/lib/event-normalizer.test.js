const mocha = require('mocha')
const chai = require('chai')
const should = chai.should()
const { parseEvent, parsePayload, categorizeMessengerEvent, parseMessengerEvent } = require('./event-normalizer')

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
