const _ = require('lodash')
const parse = require('parse-duration')
const { getTimeoutDate } = require('@vlab-research/utils')

function _waitFulfilled(value, events, waitStart) {
  const now = _(events).map(e => new Date(e.value)).max()
  const fulfilled = _(events).map(e => e.value).includes(waitStart)

  // NOTE: this needs to work for 3 different versions
  // right now, which can be simplified in the future
  if (typeof value !== 'string') {
    // new format, value is object, not v1 or v2
    return fulfilled
  }

  const endDateV1 = getTimeoutDate(waitStart, value)
  const endDateV2 = new Date(waitStart + parse(value))
  return fulfilled || (now - endDateV2 >= 0) || (now - endDateV1 >= 0)
}

const _contains = (a, b) => _.keys(b).every(k => a[k] === b[k])

function _matches(v1, v2) {
  // If v2 (wait condition value) is undefined or empty object, match any event of that type
  if (!v2 || (typeof v2 === 'object' && Object.keys(v2).length === 0)) {
    return !!v1
  }
  return v1 && v2 && (_.isEqual(v1, v2) || _contains(v1, v2))
}

function _normalizeEvent(event) {
  // Handle null/undefined events
  if (!event) {
    return null
  }

  // Handle different event structures
  if (event.event) {
    // Synthetic events (timeout, external)
    return event.event
  } else if (event.pass_thread_control) {
    // Raw handover events
    const value = {
      timestamp: event.timestamp
    }

    // Parse metadata if present - handle both JSON and plain strings
    if (event.pass_thread_control.metadata) {
      try {
        const parsed = JSON.parse(event.pass_thread_control.metadata)
        Object.assign(value, parsed)
      } catch (e) {
        // Metadata is a plain string, not JSON - store it as-is
        value.metadata = event.pass_thread_control.metadata
      }
    }

    // Only include target_app_id if new_owner_app_id is present
    if (event.pass_thread_control.new_owner_app_id) {
      value.target_app_id = event.pass_thread_control.new_owner_app_id
    }

    return {
      type: 'handover',
      value
    }
  }
  return null
}

const funs = {
  'and': (...args) => args.reduce((a, b) => a && b, true),
  'or': (...args) => args.reduce((a, b) => a || b, false)
}

function waitConditionFulfilled(wait, events, waitStart) {

  const { type, value, op, vars } = wait

  if (op) {
    const fn = funs[op]
    return fn(...vars.map(w => waitConditionFulfilled(w, events, waitStart)))
  }

  const relevant = events
    .map(_normalizeEvent)
    .filter(e => e && e.type === type)

  if (type === 'timeout') {
    return _waitFulfilled(value, relevant, waitStart)
  }
  
  return relevant.some(e => _matches(e.value, wait.value))
}


module.exports = { waitConditionFulfilled, _normalizeEvent }
