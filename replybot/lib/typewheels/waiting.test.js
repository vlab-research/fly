const mocha = require('mocha')
const chai = require('chai')
const should = chai.should()
const parse = require('parse-duration')
const w = require('./waiting')
const chrono = require('chrono-node')

describe('waitConditionFulfilled', () => {
  const start = Date.now()

  it('Is false when there are no events', () => {
    const res = w.waitConditionFulfilled({ type: 'timeout', value: '2 days' }, [], Date.now())
    res.should.be.false
  })

  it('Is true when event fulfilled', () => {
    const res = w.waitConditionFulfilled(
      { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } },
      [{ event: { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } } }],
      Date.now())
    res.should.be.true
  })


  it('Is true when event fulfilled even though not fully specified', () => {
    const res = w.waitConditionFulfilled(
      { type: 'external', value: { type: 'moviehouse:play' } },
      [{ event: { type: 'external', value: { type: 'moviehouse:play', id: 'foobaz' } } }],
      Date.now())
    res.should.be.true
  })

  it('Is true when timeout fulfilled', () => {
    const res = w.waitConditionFulfilled(
      { type: 'timeout', value: '1 hour' },
      [{ event: { type: 'timeout', value: Date.now() + 1000 * 60 * 60 } }],
      Date.now())
    res.should.be.true
  })


  it('Is true when timeout fulfilled V3 Dean', () => {
    const waitStart = Date.now() + 1000 * 60 * 60
    const res = w.waitConditionFulfilled(
      { type: 'timeout', value: '1 hour' },
      [{ event: { type: 'timeout', value: waitStart } }],
      waitStart)

    res.should.be.true
  })


  it('Is true when timeout fulfilled - value object', () => {
    const waitStart = Date.now() + 1000 * 60 * 60
    const res = w.waitConditionFulfilled(
      { type: 'timeout', value: { type: 'absolute', timeout: 'ignored' } },
      [{ event: { type: 'timeout', value: waitStart } }],
      waitStart)

    res.should.be.true
  })


  it('Is true when timeout overfulfilled', () => {
    const res = w.waitConditionFulfilled(
      { type: 'timeout', value: '1 hour' },
      [{ event: { type: 'timeout', value: Date.now() + 2000 * 60 * 60 } }],
      Date.now())
    res.should.be.true
  })


  it('Is true when timeout overfulfilled and delivered in rfc3339 rounded up to nearest second', () => {
    const now = 1599084716601
    const rfc = '2020-09-02T23:11:57.000Z'

    const res = w.waitConditionFulfilled(
      { type: 'timeout', value: '1 hour' },
      [{ event: { type: 'timeout', value: rfc } }],
      now)
    res.should.be.true
  })

  it('Works even when the timeoutdate is in the morning (reg test with chrono)', () => {

    const events = [{ "event": { "type": "timeout", "value": "2020-09-03T08:55:14Z" }, "page": "1855355231229529", "source": "synthetic", "timestamp": 1599141618334, "user": "2979486965512390" }]
    const waitStart = 1597654513730

    const res = w.waitConditionFulfilled(
      { type: 'timeout', value: '17 days' },
      events,
      waitStart)

    res.should.be.true
  })

  it('operator:or -- true when one event is fulfilled', () => {

    const wait = {
      op: 'or', vars: [
        { type: 'timeout', value: '1 hour' },
        { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } }
      ]
    }

    const res = w.waitConditionFulfilled(
      wait,
      [{ event: { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } } }],
      Date.now())

    res.should.be.true
  })

  it('operator:or -- false when no event is fulfilled', () => {

    const wait = {
      op: 'or', vars: [
        { type: 'timeout', value: '1 hour' },
        { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } }
      ]
    }

    const res = w.waitConditionFulfilled(
      wait,
      [{ event: { type: 'external', value: { type: 'moviehouse:load', id: 'foobar' } } }],
      Date.now())

    res.should.be.false
  })

  it('operator:or -- true when both events are fulfilled', () => {

    const wait = {
      op: 'or', vars: [
        { type: 'timeout', value: '1 hour' },
        { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } }
      ]
    }

    const res = w.waitConditionFulfilled(
      wait,
      [{ event: { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } } }],
      Date.now() - 1000 * 60 * 60)

    res.should.be.true
  })

  it('operator:or -- true when any of many events are fulfilled', () => {

    const wait = {
      op: 'or', vars: [
        { type: 'timeout', value: '1 hour' },
        { type: 'external', value: { type: 'moviehouse:pause', id: 'foobar' } },
        { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } }
      ]
    }

    const res = w.waitConditionFulfilled(
      wait,
      [{ event: { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } } }],
      Date.now() - 1000 * 60 * 60)

    res.should.be.true
  })

  it('operator:or -- false when none of many events are fulfilled', () => {

    const wait = {
      op: 'or', vars: [
        { type: 'timeout', value: '1 hour' },
        { type: 'external', value: { type: 'moviehouse:pause', id: 'foobar' } },
        { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } }
      ]
    }

    const res = w.waitConditionFulfilled(
      wait,
      [{ event: { type: 'external', value: { type: 'moviehouse:butt', id: 'foobar' } } }],
      Date.now() - 1000 * 60 * 60)

    res.should.be.false
  })


  it('operator:and -- true when all events are fulfilled - v1 dean', () => {

    const wait = {
      op: 'and', vars: [
        { type: 'timeout', value: '1 hour' },
        { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } },
        { type: 'external', value: { type: 'moviehouse:pause', id: 'foobar' } }
      ]
    }

    const timeoutDate = chrono.parseDate('1 hour', new Date(start))

    const res = w.waitConditionFulfilled(
      wait,
      [{ event: { type: 'timeout', value: timeoutDate } },
      { event: { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } } },
      { event: { type: 'external', value: { type: 'moviehouse:pause', id: 'foobar' } } }],
      start)

    res.should.be.true
  })


  it('operator:and -- true when all events are fulfilled - v2 dean', () => {

    const wait = {
      op: 'and', vars: [
        { type: 'timeout', value: '1 hour' },
        { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } },
        { type: 'external', value: { type: 'moviehouse:pause', id: 'foobar' } }
      ]
    }

    const timeoutDate = new Date(parse('1 hour') + start)

    const res = w.waitConditionFulfilled(
      wait,
      [{ event: { type: 'timeout', value: timeoutDate } },
      { event: { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } } },
      { event: { type: 'external', value: { type: 'moviehouse:pause', id: 'foobar' } } }],
      start)

    res.should.be.true
  })


  it('operator:and -- true when all events are fulfilled - v3 dean', () => {

    const wait = {
      op: 'and', vars: [
        { type: 'timeout', value: '1 hour' },
        { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } },
        { type: 'external', value: { type: 'moviehouse:pause', id: 'foobar' } }
      ]
    }

    const timeoutDate = start

    const res = w.waitConditionFulfilled(
      wait,
      [{ event: { type: 'timeout', value: timeoutDate } },
      { event: { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } } },
      { event: { type: 'external', value: { type: 'moviehouse:pause', id: 'foobar' } } }],
      start)

    res.should.be.true
  })

  it('operator:and -- false when only one event is fulfilled', () => {

    const wait = {
      op: 'and', vars: [
        { type: 'timeout', value: '1 hour' },
        { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } }
      ]
    }

    const res = w.waitConditionFulfilled(
      wait,
      [{ event: { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } } }],
      Date.now() - 1000 * 60 * 30)

    res.should.be.false
  })


  it('operator:and -- false when no event is fulfilled', () => {

    const wait = {
      op: 'and', vars: [
        { type: 'timeout', value: '1 hour' },
        { type: 'external', value: { type: 'moviehouse:play', id: 'foobar' } }
      ]
    }

    const res = w.waitConditionFulfilled(
      wait,
      [{ event: { type: 'external', value: { type: 'moviehouse:load', id: 'foobar' } } }],
      Date.now() - 1000 * 60 * 30)

    res.should.be.false
  })

  describe('_normalizeEvent', () => {
    it('should normalize synthetic timeout events', () => {
      const syntheticEvent = {
        source: 'synthetic',
        user: 'user123',
        page: 'page123',
        timestamp: 1640995200000,
        event: {
          type: 'timeout',
          value: 1640995200000
        }
      }

      const result = w._normalizeEvent(syntheticEvent)
      
      result.should.deep.equal({
        type: 'timeout',
        value: 1640995200000
      })
    })

    it('should normalize synthetic external events', () => {
      const syntheticEvent = {
        source: 'synthetic',
        user: 'user123',
        page: 'page123',
        timestamp: 1640995200000,
        event: {
          type: 'external',
          value: {
            type: 'user_action',
            action: 'button_click'
          }
        }
      }

      const result = w._normalizeEvent(syntheticEvent)
      
      result.should.deep.equal({
        type: 'external',
        value: {
          type: 'user_action',
          action: 'button_click'
        }
      })
    })

    it('should normalize raw handover events', () => {
      const handoverEvent = {
        source: 'messenger',
        sender: { id: 'user123' },
        recipient: { id: 'page123' },
        timestamp: 1640995200000,
        pass_thread_control: {
          new_owner_app_id: '123456789',
          previous_owner_app_id: '987654321',
          metadata: '{"completion_status": "success", "user_intent": "purchase"}'
        }
      }

      const result = w._normalizeEvent(handoverEvent)
      
      result.should.deep.equal({
        type: 'handover',
        value: {
          target_app_id: '123456789',
          timestamp: 1640995200000,
          completion_status: 'success',
          user_intent: 'purchase'
        }
      })
    })

    it('should handle handover events without metadata', () => {
      const handoverEvent = {
        source: 'messenger',
        sender: { id: 'user123' },
        recipient: { id: 'page123' },
        timestamp: 1640995200000,
        pass_thread_control: {
          new_owner_app_id: '123456789',
          previous_owner_app_id: '987654321'
          // No metadata
        }
      }

      const result = w._normalizeEvent(handoverEvent)
      
      result.should.deep.equal({
        type: 'handover',
        value: {
          target_app_id: '123456789',
          timestamp: 1640995200000
        }
      })
    })

    it('should handle handover events with invalid metadata gracefully', () => {
      const handoverEvent = {
        source: 'messenger',
        sender: { id: 'user123' },
        recipient: { id: 'page123' },
        timestamp: 1640995200000,
        pass_thread_control: {
          new_owner_app_id: '123456789',
          previous_owner_app_id: '987654321',
          metadata: '{"invalid": json}' // Invalid JSON
        }
      }

      // This should throw an error due to invalid JSON
      should.throw(() => {
        w._normalizeEvent(handoverEvent)
      }, 'Unexpected token j in JSON at position 12')
    })

    it('should return null for unrecognized event types', () => {
      const unknownEvent = {
        source: 'unknown',
        someField: 'value'
      }

      const result = w._normalizeEvent(unknownEvent)
      
      should.not.exist(result)
    })

    it('should handle null/undefined events', () => {
      should.not.exist(w._normalizeEvent(null))
      should.not.exist(w._normalizeEvent(undefined))
    })
  })
})
