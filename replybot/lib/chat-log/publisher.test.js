'use strict'

const chai = require('chai')
const should = chai.should()
const { extractChatLogEntry } = require('./publisher')

const USER_ID = '1800244896727776'
const PAGE_ID = '1051551461692797'

// ---------------------------------------------------------------------------
// Event fixtures
// ---------------------------------------------------------------------------

// ECHO: bot message echoed back via webhook
const echoEvent = {
  sender: { id: PAGE_ID },
  recipient: { id: USER_ID },
  timestamp: 1700000000000,
  message: {
    is_echo: true,
    metadata: { ref: 'question_1', type: 'statement' },
    text: 'Welcome to the survey!'
  }
}

// ECHO with no metadata on the message
const echoNoMetadata = {
  sender: { id: PAGE_ID },
  recipient: { id: USER_ID },
  timestamp: 1700000001000,
  message: {
    is_echo: true,
    text: 'Hello there'
  }
}

// ECHO with empty message text
const echoEmptyText = {
  sender: { id: PAGE_ID },
  recipient: { id: USER_ID },
  timestamp: 1700000002000,
  message: {
    is_echo: true,
    metadata: { ref: 'img_q', type: 'attachment' }
  }
}

// TEXT: user sends a plain text message
const textEvent = {
  sender: { id: USER_ID },
  recipient: { id: PAGE_ID },
  timestamp: 1700000010000,
  message: { text: 'My answer is 42' }
}

// TEXT with empty string
const textEmptyEvent = {
  sender: { id: USER_ID },
  recipient: { id: PAGE_ID },
  timestamp: 1700000010500,
  message: { text: '' }
}

// QUICK_REPLY: user taps a quick-reply button
const quickReplyEvent = {
  sender: { id: USER_ID },
  recipient: { id: PAGE_ID },
  timestamp: 1700000020000,
  message: {
    quick_reply: { payload: { value: 'Yes', ref: 'consent_q' } },
    text: 'Yes'
  }
}

// POSTBACK: user taps a postback button (non-referral, non-get_started)
const postbackEvent = {
  sender: { id: USER_ID },
  recipient: { id: PAGE_ID },
  timestamp: 1700000030000,
  postback: {
    payload: { value: true, ref: 'legal_q' },
    title: 'I Accept'
  }
}

// REFERRAL: referral events should be excluded
const referralEvent = {
  recipient: { id: PAGE_ID },
  timestamp: 1700000040000,
  sender: { id: USER_ID },
  referral: {
    ref: 'form.FOO.foo.bar',
    source: 'SHORTLINK',
    type: 'OPEN_THREAD'
  }
}

// REFERRAL via postback (get_started)
const getStartedEvent = {
  recipient: { id: PAGE_ID },
  timestamp: 1700000040500,
  sender: { id: USER_ID },
  postback: {
    payload: 'get_started',
    referral: {
      ref: 'form.FOO',
      source: 'SHORTLINK',
      type: 'OPEN_THREAD'
    },
    title: 'Get Started'
  }
}

// WATERMARK: read receipt
const readEvent = {
  sender: { id: USER_ID },
  recipient: { id: PAGE_ID },
  timestamp: 1700000050000,
  read: { watermark: 1700000000000 }
}

// WATERMARK: delivery receipt
const deliveryEvent = {
  sender: { id: USER_ID },
  recipient: { id: PAGE_ID },
  timestamp: 1700000050500,
  delivery: { watermark: 1700000000000 }
}

// REACTION: user reacts with an emoji
const reactionEvent = {
  sender: { id: USER_ID },
  recipient: { id: PAGE_ID },
  timestamp: 1700000060000,
  reaction: {
    action: 'react',
    emoji: '😠',
    reaction: 'angry'
  },
  source: 'messenger'
}

// Synthetic timeout event
const syntheticTimeout = {
  source: 'synthetic',
  event: { type: 'timeout', value: {} },
  user: USER_ID,
  page: PAGE_ID,
  timestamp: 1700000070000
}

// Synthetic bailout event
const syntheticBailout = {
  source: 'synthetic',
  event: { type: 'bailout', value: { form: 'BAR' } },
  user: USER_ID,
  page: PAGE_ID,
  timestamp: 1700000070500
}

// Synthetic follow_up event
const syntheticFollowUp = {
  source: 'synthetic',
  event: { type: 'follow_up', value: {} },
  user: USER_ID,
  page: PAGE_ID,
  timestamp: 1700000071000
}

// Synthetic redo event
const syntheticRedo = {
  source: 'synthetic',
  event: { type: 'redo' },
  user: USER_ID,
  page: PAGE_ID,
  timestamp: 1700000071500
}

// OPTIN event
const optinEvent = {
  sender: { id: USER_ID },
  recipient: { id: PAGE_ID },
  timestamp: 1700000080000,
  optin: {
    type: 'one_time_notif_req',
    one_time_notif_token: 'TOKEN123',
    payload: { ref: 'foo' }
  }
}

// MEDIA event (attachment, no text)
const mediaEvent = {
  sender: { id: USER_ID },
  recipient: { id: PAGE_ID },
  timestamp: 1700000090000,
  message: { attachments: [{ type: 'image' }] }
}

// ---------------------------------------------------------------------------
// State fixtures
// ---------------------------------------------------------------------------

const fullState = {
  forms: ['shortcode_A', 'shortcode_B'],
  question: 'current_question_ref',
  md: { pageid: PAGE_ID, form: 'MYFORM', seed: 12345 }
}

const emptyState = {}

const stateNoForms = {
  question: 'q1',
  md: { pageid: PAGE_ID }
}

const stateNoMd = {
  forms: ['sc1'],
  question: 'q2'
}

const stateEmptyForms = {
  forms: [],
  question: 'q3',
  md: { pageid: PAGE_ID }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractChatLogEntry', () => {

  // =========================================================================
  // 1. ECHO events (bot messages)
  // =========================================================================
  describe('ECHO events (bot messages)', () => {
    it('should extract a full entry from a standard echo event', () => {
      const entry = extractChatLogEntry(echoEvent, fullState)

      entry.userid.should.equal(USER_ID)
      entry.pageid.should.equal(PAGE_ID)
      entry.direction.should.equal('bot')
      entry.content.should.equal('Welcome to the survey!')
      entry.question_ref.should.equal('question_1')
      entry.message_type.should.equal('statement')
      entry.shortcode.should.equal('shortcode_B')
      entry.metadata.should.deep.equal(fullState.md)
      entry.raw_payload.should.deep.equal(echoEvent)
      should.equal(entry.surveyid, null)
    })

    it('should extract userid from recipient.id and pageid from sender.id', () => {
      const entry = extractChatLogEntry(echoEvent, fullState)
      // For echo events the sender is the page and the recipient is the user
      entry.userid.should.equal(echoEvent.recipient.id)
      entry.pageid.should.equal(echoEvent.sender.id)
    })

    it('should pass through the numeric timestamp', () => {
      const entry = extractChatLogEntry(echoEvent, fullState)
      entry.timestamp.should.equal(1700000000000)
    })

    it('should use the last form in state.forms as shortcode', () => {
      const stateThreeForms = { ...fullState, forms: ['a', 'b', 'c'] }
      const entry = extractChatLogEntry(echoEvent, stateThreeForms)
      entry.shortcode.should.equal('c')
    })
  })

  // =========================================================================
  // 2. TEXT events (user text messages)
  // =========================================================================
  describe('TEXT events (user text messages)', () => {
    it('should extract a full entry from a user text message', () => {
      const entry = extractChatLogEntry(textEvent, fullState)

      entry.userid.should.equal(USER_ID)
      entry.pageid.should.equal(PAGE_ID)
      entry.direction.should.equal('user')
      entry.content.should.equal('My answer is 42')
      entry.question_ref.should.equal('current_question_ref')
      entry.message_type.should.equal('text')
      entry.shortcode.should.equal('shortcode_B')
      entry.metadata.should.deep.equal(fullState.md)
      entry.raw_payload.should.deep.equal(textEvent)
      should.equal(entry.surveyid, null)
    })

    it('should extract userid from sender.id', () => {
      const entry = extractChatLogEntry(textEvent, fullState)
      entry.userid.should.equal(textEvent.sender.id)
    })

    it('should extract pageid from state.md.pageid', () => {
      const entry = extractChatLogEntry(textEvent, fullState)
      entry.pageid.should.equal(fullState.md.pageid)
    })

    it('should use state.question as question_ref', () => {
      const entry = extractChatLogEntry(textEvent, fullState)
      entry.question_ref.should.equal(fullState.question)
    })

    it('should pass through the numeric timestamp', () => {
      const entry = extractChatLogEntry(textEvent, fullState)
      entry.timestamp.should.equal(1700000010000)
    })
  })

  // =========================================================================
  // 3. QUICK_REPLY events
  // =========================================================================
  describe('QUICK_REPLY events', () => {
    it('should extract a full entry from a quick reply event', () => {
      const entry = extractChatLogEntry(quickReplyEvent, fullState)

      entry.userid.should.equal(USER_ID)
      entry.pageid.should.equal(PAGE_ID)
      entry.direction.should.equal('user')
      entry.content.should.equal('Yes')
      entry.question_ref.should.equal('current_question_ref')
      entry.message_type.should.equal('quick_reply')
      entry.shortcode.should.equal('shortcode_B')
      entry.metadata.should.deep.equal(fullState.md)
      entry.raw_payload.should.deep.equal(quickReplyEvent)
    })

    it('should set message_type to quick_reply (lowercase of category)', () => {
      const entry = extractChatLogEntry(quickReplyEvent, fullState)
      entry.message_type.should.equal('quick_reply')
    })

    it('should extract content from message.text when present', () => {
      const entry = extractChatLogEntry(quickReplyEvent, fullState)
      entry.content.should.equal('Yes')
    })
  })

  // =========================================================================
  // 4. POSTBACK events
  // =========================================================================
  describe('POSTBACK events', () => {
    it('should extract a full entry from a postback event', () => {
      const entry = extractChatLogEntry(postbackEvent, fullState)

      entry.userid.should.equal(USER_ID)
      entry.pageid.should.equal(PAGE_ID)
      entry.direction.should.equal('user')
      entry.content.should.equal('I Accept')
      entry.question_ref.should.equal('current_question_ref')
      entry.message_type.should.equal('postback')
      entry.shortcode.should.equal('shortcode_B')
      entry.metadata.should.deep.equal(fullState.md)
      entry.raw_payload.should.deep.equal(postbackEvent)
    })

    it('should set message_type to postback (lowercase of category)', () => {
      const entry = extractChatLogEntry(postbackEvent, fullState)
      entry.message_type.should.equal('postback')
    })

    it('should extract content from postback.title', () => {
      const entry = extractChatLogEntry(postbackEvent, fullState)
      entry.content.should.equal('I Accept')
    })

    it('should fall back to empty string when postback has no title and no message', () => {
      const noTitlePostback = {
        sender: { id: USER_ID },
        recipient: { id: PAGE_ID },
        timestamp: 1700000031000,
        postback: { payload: { value: true } }
      }
      const entry = extractChatLogEntry(noTitlePostback, fullState)
      entry.content.should.equal('')
    })
  })

  // =========================================================================
  // 5. Excluded events (should return null)
  // =========================================================================
  describe('excluded events (return null)', () => {
    it('should return null for referral events', () => {
      const entry = extractChatLogEntry(referralEvent, fullState)
      should.not.exist(entry)
    })

    it('should return null for get_started referral postback events', () => {
      const entry = extractChatLogEntry(getStartedEvent, fullState)
      should.not.exist(entry)
    })

    it('should return null for read watermark events', () => {
      const entry = extractChatLogEntry(readEvent, fullState)
      should.not.exist(entry)
    })

    it('should return null for delivery watermark events', () => {
      const entry = extractChatLogEntry(deliveryEvent, fullState)
      should.not.exist(entry)
    })

    it('should return null for reaction events', () => {
      const entry = extractChatLogEntry(reactionEvent, fullState)
      should.not.exist(entry)
    })

    it('should return null for synthetic timeout events', () => {
      const entry = extractChatLogEntry(syntheticTimeout, fullState)
      should.not.exist(entry)
    })

    it('should return null for synthetic bailout events', () => {
      const entry = extractChatLogEntry(syntheticBailout, fullState)
      should.not.exist(entry)
    })

    it('should return null for synthetic follow_up events', () => {
      const entry = extractChatLogEntry(syntheticFollowUp, fullState)
      should.not.exist(entry)
    })

    it('should return null for synthetic redo events', () => {
      const entry = extractChatLogEntry(syntheticRedo, fullState)
      should.not.exist(entry)
    })

    it('should return null for optin events', () => {
      const entry = extractChatLogEntry(optinEvent, fullState)
      should.not.exist(entry)
    })

    it('should return null for media-only events (no text, attachment only)', () => {
      const entry = extractChatLogEntry(mediaEvent, fullState)
      should.not.exist(entry)
    })
  })

  // =========================================================================
  // 6. Edge cases
  // =========================================================================
  describe('edge cases', () => {

    // -- Missing metadata on echo --
    describe('echo with missing metadata', () => {
      it('should default question_ref to null when metadata is absent', () => {
        const entry = extractChatLogEntry(echoNoMetadata, fullState)
        should.not.exist(entry.question_ref)
      })

      it('should default message_type to null when metadata is absent', () => {
        const entry = extractChatLogEntry(echoNoMetadata, fullState)
        should.not.exist(entry.message_type)
      })

      it('should still extract other fields correctly when metadata is absent', () => {
        const entry = extractChatLogEntry(echoNoMetadata, fullState)
        entry.userid.should.equal(USER_ID)
        entry.direction.should.equal('bot')
        entry.content.should.equal('Hello there')
      })
    })

    // -- Missing message text on echo --
    describe('echo with missing message text', () => {
      it('should default content to empty string when text is undefined', () => {
        const entry = extractChatLogEntry(echoEmptyText, fullState)
        entry.content.should.equal('')
      })

      it('should still extract metadata fields correctly', () => {
        const entry = extractChatLogEntry(echoEmptyText, fullState)
        entry.question_ref.should.equal('img_q')
        entry.message_type.should.equal('attachment')
      })
    })

    // -- Missing state.forms --
    describe('missing state.forms', () => {
      it('should set shortcode to null when state has no forms property', () => {
        const entry = extractChatLogEntry(echoEvent, stateNoForms)
        should.not.exist(entry.shortcode)
      })

      it('should set shortcode to null when state.forms is empty array', () => {
        const entry = extractChatLogEntry(echoEvent, stateEmptyForms)
        should.not.exist(entry.shortcode)
      })

      it('should set shortcode to null for user events when state has no forms', () => {
        const entry = extractChatLogEntry(textEvent, stateNoForms)
        should.not.exist(entry.shortcode)
      })

      it('should set shortcode to null for user events when forms is empty', () => {
        const entry = extractChatLogEntry(textEvent, stateEmptyForms)
        should.not.exist(entry.shortcode)
      })
    })

    // -- Missing state.md --
    describe('missing state.md', () => {
      it('should set metadata to null when state.md is absent', () => {
        const entry = extractChatLogEntry(echoEvent, stateNoMd)
        should.not.exist(entry.metadata)
      })

      it('should set pageid to null for user events when state.md is absent', () => {
        const entry = extractChatLogEntry(textEvent, stateNoMd)
        should.not.exist(entry.pageid)
      })

      it('should set metadata to null for user events when state.md is absent', () => {
        const entry = extractChatLogEntry(textEvent, stateNoMd)
        should.not.exist(entry.metadata)
      })
    })

    // -- Empty state --
    describe('empty state object', () => {
      it('should handle a fully empty state for echo events', () => {
        const entry = extractChatLogEntry(echoEvent, emptyState)
        should.not.exist(entry.shortcode)
        should.not.exist(entry.metadata)
        entry.direction.should.equal('bot')
      })

      it('should handle a fully empty state for user text events', () => {
        const entry = extractChatLogEntry(textEvent, emptyState)
        should.not.exist(entry.shortcode)
        should.not.exist(entry.metadata)
        should.not.exist(entry.question_ref)
        should.not.exist(entry.pageid)
        entry.direction.should.equal('user')
      })
    })

    // -- Empty message text on user event --
    describe('empty message text on user event', () => {
      it('should extract content as empty string when user sends empty text', () => {
        const entry = extractChatLogEntry(textEmptyEvent, fullState)
        entry.content.should.equal('')
        entry.message_type.should.equal('text')
      })
    })

    // -- surveyid is always null --
    describe('surveyid field', () => {
      it('should always set surveyid to null for echo events', () => {
        const entry = extractChatLogEntry(echoEvent, fullState)
        should.equal(entry.surveyid, null)
      })

      it('should always set surveyid to null for user events', () => {
        const entry = extractChatLogEntry(textEvent, fullState)
        should.equal(entry.surveyid, null)
      })
    })

    // -- Quick reply with no message.text falls back to empty string --
    describe('quick reply without message.text', () => {
      it('should fall back to empty string when quick reply has no text', () => {
        const qrNoText = {
          sender: { id: USER_ID },
          recipient: { id: PAGE_ID },
          timestamp: 1700000025000,
          message: {
            quick_reply: { payload: { value: 'Option A', ref: 'q5' } }
          }
        }
        const entry = extractChatLogEntry(qrNoText, fullState)
        entry.content.should.equal('')
        entry.message_type.should.equal('quick_reply')
      })
    })
  })
})
