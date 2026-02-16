'use strict'

const { categorizeEvent } = require('../typewheels/machine')
const { parseEvent } = require('@vlab-research/utils')

/**
 * Pure extraction function: (parsedEvent, state) -> ChatLogEntry | null
 *
 * Given a parsed Facebook webhook event and the current state machine state,
 * extracts a chat log entry if the event represents a visible message
 * in the conversation (bot echo or user message). Returns null for
 * all other event types (synthetic events, watermarks, referrals, etc.)
 *
 * No IO, no Kafka, no side effects.
 */
function extractChatLogEntry(event, state) {
  const category = categorizeEvent(event)

  if (category === 'ECHO') {
    const md = event.message.metadata || {}

    return {
      userid: event.recipient.id,
      pageid: event.sender.id,
      timestamp: event.timestamp,
      direction: 'bot',
      content: event.message.text || '',
      question_ref: md.ref || null,
      shortcode: state.forms && state.forms.length > 0
        ? state.forms[state.forms.length - 1]
        : null,
      surveyid: null,
      message_type: md.type || null,
      raw_payload: event,
      metadata: state.md || null,
    }
  }

  if (category === 'TEXT' || category === 'QUICK_REPLY' || category === 'POSTBACK') {
    return {
      userid: event.sender.id,
      pageid: (state.md && state.md.pageid) || null,
      timestamp: event.timestamp,
      direction: 'user',
      content: (event.message && event.message.text)
        || (event.postback && event.postback.title)
        || '',
      question_ref: state.question || null,
      shortcode: state.forms && state.forms.length > 0
        ? state.forms[state.forms.length - 1]
        : null,
      surveyid: null,
      message_type: category.toLowerCase(),
      raw_payload: event,
      metadata: state.md || null,
    }
  }

  return null
}

/**
 * IO wrapper: parses the raw event, calls pure extraction, then publishes
 * the result to the given Kafka topic via the produce helper.
 *
 * @param {Function} produce - async function(topic, message, userid) that
 *   serializes and publishes to Kafka (the same helper used for state,
 *   response, and payment topics)
 * @param {string} topic - Kafka topic name
 * @param {string} rawEvent - raw event JSON string from Kafka
 * @param {object} state - state machine state before this event
 */
function publishChatLog(produce, topic, rawEvent, state) {
  const event = parseEvent(rawEvent)
  const entry = extractChatLogEntry(event, state)
  if (!entry) return

  return produce(topic, entry, entry.userid)
}

module.exports = { extractChatLogEntry, publishChatLog }
