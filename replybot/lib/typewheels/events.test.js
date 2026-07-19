const USER_ID = '1800244896727776'
const PAGE_ID = '1051551461692797'

const referral = {
  event_id: 'evt_test_referral',
  user_id: USER_ID,
  timestamp: 1542123799219,
  source: { type: 'messenger', account_id: PAGE_ID },
  event_type: 'conversation_started',
  payload: {
    type: 'conversation_started',
    trigger: 'referral',
    referral: { ref: 'form.FOO.foo.bar', source: 'SHORTLINK', type: 'OPEN_THREAD' }
  }
}

const payloadReferral = {
  event_id: 'evt_test_payload_referral',
  user_id: USER_ID,
  timestamp: 1542123799219,
  source: { type: 'messenger', account_id: PAGE_ID },
  event_type: 'conversation_started',
  payload: {
    type: 'conversation_started',
    trigger: 'referral',
    referral: { ref: 'form.FOO.foo.bar' }
  }
}

const multipleChoice = {
  event_id: 'evt_test_mc',
  user_id: USER_ID,
  timestamp: 1542116257642,
  source: { type: 'messenger', account_id: PAGE_ID },
  event_type: 'user_interaction',
  payload: {
    type: 'user_interaction',
    value: true,
    label: 'I Accept',
    source_message_id: 'foo',
    interaction_type: 'postback'
  }
}

const legalQuickReply = {
  event_id: 'evt_test_legal_qr',
  user_id: USER_ID,
  timestamp: 1542116257642,
  source: { type: 'messenger', account_id: PAGE_ID },
  event_type: 'user_interaction',
  payload: {
    type: 'user_interaction',
    value: 'I Accept',
    label: 'I Accept',
    source_message_id: 'foo',
    interaction_type: 'quick_reply'
  }
}

const getStarted = {
  event_id: 'evt_test_get_started',
  user_id: USER_ID,
  timestamp: 1542116257642,
  source: { type: 'messenger', account_id: PAGE_ID },
  event_type: 'conversation_started',
  payload: {
    type: 'conversation_started',
    trigger: 'referral',
    referral: { ref: 'form.FOO', source: 'SHORTLINK', type: 'OPEN_THREAD' }
  }
}

const text = {
  event_id: 'evt_test_text',
  user_id: USER_ID,
  timestamp: 1542116363617,
  source: { type: 'messenger', account_id: PAGE_ID },
  event_type: 'user_text',
  payload: {
    type: 'user_text',
    text: 'foo'
  }
}

const sticker = {
  event_id: 'evt_test_sticker',
  user_id: USER_ID,
  timestamp: 1542116363617,
  source: { type: 'messenger', account_id: PAGE_ID },
  event_type: 'user_media',
  payload: {
    type: 'user_media',
    attachments: [{ type: 'image' }],
    stickerId: 369239263222822
  }
}

const qr = {
  event_id: 'evt_test_qr',
  user_id: USER_ID,
  timestamp: 20,
  source: { type: 'messenger', account_id: PAGE_ID },
  event_type: 'user_interaction',
  payload: {
    type: 'user_interaction',
    value: 'Continue',
    label: '',
    source_message_id: 'foo',
    interaction_type: 'quick_reply'
  }
}

const read = {
  event_id: 'evt_test_read',
  user_id: USER_ID,
  timestamp: 15,
  source: { type: 'messenger', account_id: PAGE_ID },
  event_type: 'bot_message_read',
  payload: {
    type: 'bot_message_read',
    watermark: 10,
    read_at: 15
  }
}

const delivery = {
  event_id: 'evt_test_delivery',
  user_id: USER_ID,
  timestamp: 16,
  source: { type: 'messenger', account_id: PAGE_ID },
  event_type: 'bot_message_delivered',
  payload: {
    type: 'bot_message_delivered',
    watermark: 15,
    delivered_at: 16
  }
}

const optin = {
  event_id: 'evt_test_optin',
  user_id: USER_ID,
  timestamp: 25,
  source: { type: 'messenger', account_id: PAGE_ID },
  event_type: 'optin',
  payload: {
    type: 'optin',
    optin_type: 'one_time_notif_req',
    token: 'FOOBAR',
    payload: { ref: 'foo' }
  }
}

const echo = {
  event_id: 'evt_test_echo',
  user_id: USER_ID,
  timestamp: 5,
  source: { type: 'messenger', account_id: PAGE_ID },
  event_type: 'bot_message_sent',
  payload: {
    type: 'bot_message_sent',
    is_echo: true,
    metadata: { ref: 'foo' },
    text: 'Whatsupp welcome you agree or what?'
  }
}

const statementEcho = {
  event_id: 'evt_test_stmt_echo',
  user_id: USER_ID,
  timestamp: 5,
  source: { type: 'messenger', account_id: PAGE_ID },
  event_type: 'bot_message_sent',
  payload: {
    type: 'bot_message_sent',
    is_echo: true,
    metadata: { ref: 'bar', type: 'statement' },
    text: 'Whatsupp, welcome.'
  }
}

const tyEcho = {
  event_id: 'evt_test_ty_echo',
  user_id: USER_ID,
  timestamp: 5,
  source: { type: 'messenger', account_id: PAGE_ID },
  event_type: 'bot_message_sent',
  payload: {
    type: 'bot_message_sent',
    is_echo: true,
    metadata: { ref: 'baz', type: 'thankyou_screen' },
    text: 'Thanks'
  }
}

const fakeEcho = {
  event_id: 'evt_test_fake_echo',
  user_id: USER_ID,
  timestamp: 5,
  source: { type: 'messenger', account_id: PAGE_ID },
  event_type: 'bot_message_sent',
  payload: {
    type: 'bot_message_sent',
    is_echo: true,
    metadata: { ref: 'foo', type: 'statement', fake_echo: true },
    text: 'Whatsupp, welcome.'
  }
}

const repeatEcho = {
  event_id: 'evt_test_repeat_echo',
  user_id: USER_ID,
  timestamp: 5,
  source: { type: 'messenger', account_id: PAGE_ID },
  event_type: 'bot_message_sent',
  payload: {
    type: 'bot_message_sent',
    is_echo: true,
    metadata: { ref: 'bar', repeat: 'true' },
    text: 'Whatsupp, welcome.'
  }
}

const syntheticBail = {
  event_id: 'evt_test_bail',
  user_id: USER_ID,
  timestamp: 20,
  source: { type: 'synthetic' },
  event_type: 'synthetic_bailout',
  payload: { form: 'BAR' }
}

const syntheticRedo = {
  event_id: 'evt_test_redo',
  user_id: USER_ID,
  timestamp: 20,
  source: { type: 'synthetic' },
  event_type: 'synthetic_redo',
  payload: null
}

const syntheticPR = {
  event_id: 'evt_test_pr',
  user_id: USER_ID,
  timestamp: 20,
  source: { type: 'synthetic' },
  event_type: 'synthetic_platform_response',
  payload: { response: 'OK', metadata: '' }
}

const synthetic = (event, more = {}) => {
  const eventType = event.type
  const unifiedType = `synthetic_${eventType}`
  return {
    event_id: `evt_test_${eventType}`,
    user_id: USER_ID,
    timestamp: 20,
    source: { type: 'synthetic' },
    event_type: unifiedType,
    payload: event.value !== undefined ? event.value : null,
    ...more
  }
}

const reaction = {
  event_id: 'evt_test_reaction',
  user_id: '1972130092884542',
  timestamp: 1581454140135,
  source: { type: 'messenger', account_id: USER_ID },
  event_type: 'user_reaction',
  payload: {
    type: 'user_reaction',
    reaction: 'angry',
    emoji: '\u{1F620}',
    action: 'react'
  }
}

module.exports = { getStarted, echo, fakeEcho, tyEcho, statementEcho, repeatEcho, delivery, read, qr, text, sticker, multipleChoice, legalQuickReply, referral, reaction, USER_ID, PAGE_ID, syntheticBail, syntheticPR, optin, payloadReferral, syntheticRedo, synthetic }
