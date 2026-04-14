const chai = require('chai')
const sinon = require('sinon')
const sinonChai = require('sinon-chai')
chai.use(sinonChai)
const should = chai.should()

const { handleMessengerEvents, normalizeTimestamp } = require('./handlers')

// Set up environment variables for testing
process.env.BOTSERVER_EVENT_TOPIC = 'test-events'
process.env.VERIFY_TOKEN = 'test-verify-token'

describe('Botserver Handlers', () => {
  let producerMock
  let producerReadyMock

  beforeEach(() => {
    // Mock the producer
    producerMock = {
      produce: sinon.stub()
    }
    producerReadyMock = Promise.resolve()
  })

  afterEach(() => {
    try {
      sinon.restore()
    } catch (e) {
      // Ignore cleanup errors
    }
  })

  describe('handleMessengerEvents', () => {
    it('should process single messaging event', async () => {
      const webhookPayload = {
        object: 'page',
        entry: [{
          id: 'page123',
          time: 1640995200000,
          messaging: [{
            sender: { id: 'user123' },
            recipient: { id: 'page123' },
            timestamp: 1640995200000,
            message: { text: 'Hello bot!' }
          }]
        }]
      }

      const ctx = {
        request: { body: webhookPayload },
        status: 0
      }

      await handleMessengerEvents(ctx, producerMock, producerReadyMock, 'test-events')

      ctx.status.should.equal(200)
      producerMock.produce.should.have.been.calledOnce
      
      const [topic, partition, data, user] = producerMock.produce.firstCall.args
      topic.should.equal('test-events')
      user.should.equal('user123')
      
      const eventData = JSON.parse(data.toString())
      eventData.source.should.equal('messenger')
      eventData.sender.id.should.equal('user123')
      eventData.message.text.should.equal('Hello bot!')
    })

    it('should process multiple messaging events', async () => {
      const webhookPayload = {
        object: 'page',
        entry: [{
          messaging: [
            {
              sender: { id: 'user123' },
              timestamp: 1640995200000,
              message: { text: 'First message' }
            },
            {
              sender: { id: 'user456' },
              timestamp: 1640995201000,
              message: { text: 'Second message' }
            }
          ]
        }]
      }

      const ctx = {
        request: { body: webhookPayload },
        status: 0
      }

      await handleMessengerEvents(ctx, producerMock, producerReadyMock, 'test-events')

      // Verify both events were processed
      producerMock.produce.should.have.been.calledTwice
      
      const calls = producerMock.produce.getCalls()
      const firstEvent = JSON.parse(calls[0].args[2].toString())
      const secondEvent = JSON.parse(calls[1].args[2].toString())
      
      firstEvent.message.text.should.equal('First message')
      secondEvent.message.text.should.equal('Second message')
    })

    it('should process handover events', async () => {
      const webhookPayload = {
        object: 'page',
        entry: [{
          messaging_handovers: [{
            sender: { id: 'user123' },
            recipient: { id: 'page123' },
            timestamp: 1640995200000,
            pass_thread_control: {
              new_owner_app_id: 'our_app_id',
              previous_owner_app_id: 'external_app_id',
              metadata: JSON.stringify({ completion_status: 'success' })
            }
          }]
        }]
      }

      const ctx = {
        request: { body: webhookPayload },
        status: 0
      }

      await handleMessengerEvents(ctx, producerMock, producerReadyMock, 'test-events')

      ctx.status.should.equal(200)
      producerMock.produce.should.have.been.calledOnce
      
      const [topic, partition, data, user] = producerMock.produce.firstCall.args
      topic.should.equal('test-events')
      user.should.equal('user123')
      
      const eventData = JSON.parse(data.toString())
      eventData.source.should.equal('messenger')
      eventData.should.have.property('pass_thread_control')
      eventData.pass_thread_control.new_owner_app_id.should.equal('our_app_id')
    })

    it('should process multiple handover events', async () => {
      const webhookPayload = {
        object: 'page',
        entry: [{
          messaging_handovers: [
            {
              sender: { id: 'user123' },
              timestamp: 1640995200000,
              pass_thread_control: {
                new_owner_app_id: 'our_app_id',
                previous_owner_app_id: 'app1'
              }
            },
            {
              sender: { id: 'user456' },
              timestamp: 1640995201000,
              pass_thread_control: {
                new_owner_app_id: 'our_app_id',
                previous_owner_app_id: 'app2'
              }
            }
          ]
        }]
      }

      const ctx = {
        request: { body: webhookPayload },
        status: 0
      }

      await handleMessengerEvents(ctx, producerMock, producerReadyMock, 'test-events')

      producerMock.produce.should.have.been.calledTwice
      
      const calls = producerMock.produce.getCalls()
      const firstEvent = JSON.parse(calls[0].args[2].toString())
      const secondEvent = JSON.parse(calls[1].args[2].toString())
      
      firstEvent.sender.id.should.equal('user123')
      firstEvent.pass_thread_control.previous_owner_app_id.should.equal('app1')
      secondEvent.sender.id.should.equal('user456')
      secondEvent.pass_thread_control.previous_owner_app_id.should.equal('app2')
    })

    it('should process both messaging and handover events in same webhook', async () => {
      const webhookPayload = {
        object: 'page',
        entry: [{
          messaging: [{
            sender: { id: 'user123' },
            timestamp: 1640995200000,
            message: { text: 'Hello' }
          }],
          messaging_handovers: [{
            sender: { id: 'user123' },
            timestamp: 1640995201000,
            pass_thread_control: {
              new_owner_app_id: 'our_app_id',
              previous_owner_app_id: 'external_app'
            }
          }]
        }]
      }

      const ctx = {
        request: { body: webhookPayload },
        status: 0
      }

      await handleMessengerEvents(ctx, producerMock, producerReadyMock, 'test-events')

      // Should produce both events
      producerMock.produce.should.have.been.calledTwice

      const calls = producerMock.produce.getCalls()
      const messagingEvent = JSON.parse(calls[0].args[2].toString())
      const handoverEvent = JSON.parse(calls[1].args[2].toString())

      messagingEvent.should.have.property('message')
      messagingEvent.message.text.should.equal('Hello')
      handoverEvent.should.have.property('pass_thread_control')
    })

    it('should process messaging_optin events for notification_messages', async () => {
      const webhookPayload = {
        object: 'page',
        entry: [{
          messaging_optin: [{
            sender: { id: 'user123' },
            recipient: { id: 'page123' },
            timestamp: 1640995200000,
            optin: {
              type: 'notification_messages',
              notification_messages_token: 'test_nm_token_abc123',
              notification_messages_timezone: 'America/New_York',
              token_expiry_timestamp: 1672531200
            },
            payload: 'optin_payload_123'
          }]
        }]
      }

      const ctx = {
        request: { body: webhookPayload },
        status: 0
      }

      await handleMessengerEvents(ctx, producerMock, producerReadyMock, 'test-events')

      ctx.status.should.equal(200)
      producerMock.produce.should.have.been.calledOnce

      const [topic, partition, data, user] = producerMock.produce.firstCall.args
      topic.should.equal('test-events')
      user.should.equal('user123')

      const eventData = JSON.parse(data.toString())
      eventData.source.should.equal('messenger')
      eventData.should.have.property('optin')
      eventData.optin.type.should.equal('notification_messages')
      eventData.optin.notification_messages_token.should.equal('test_nm_token_abc123')
      eventData.optin.notification_messages_timezone.should.equal('America/New_York')
      eventData.optin.token_expiry_timestamp.should.equal(1672531200)
      eventData.payload.should.equal('optin_payload_123')
    })

    it('should process multiple messaging_optin events', async () => {
      const webhookPayload = {
        object: 'page',
        entry: [{
          messaging_optin: [
            {
              sender: { id: 'user123' },
              timestamp: 1640995200000,
              optin: {
                type: 'notification_messages',
                notification_messages_token: 'token_user123',
                notification_messages_timezone: 'America/Los_Angeles',
                token_expiry_timestamp: 1672531200
              },
              payload: 'payload_123'
            },
            {
              sender: { id: 'user456' },
              timestamp: 1640995201000,
              optin: {
                type: 'one_time_notif_req',
                notification_messages_token: 'token_user456'
              },
              payload: 'payload_456'
            }
          ]
        }]
      }

      const ctx = {
        request: { body: webhookPayload },
        status: 0
      }

      await handleMessengerEvents(ctx, producerMock, producerReadyMock, 'test-events')

      producerMock.produce.should.have.been.calledTwice

      const calls = producerMock.produce.getCalls()
      const firstEvent = JSON.parse(calls[0].args[2].toString())
      const secondEvent = JSON.parse(calls[1].args[2].toString())

      firstEvent.sender.id.should.equal('user123')
      firstEvent.optin.type.should.equal('notification_messages')
      firstEvent.optin.notification_messages_timezone.should.equal('America/Los_Angeles')
      secondEvent.sender.id.should.equal('user456')
      secondEvent.optin.type.should.equal('one_time_notif_req')
    })

    it('should handle missing event arrays gracefully', async () => {
      const webhookPayload = {
        object: 'page',
        entry: [{
          id: 'page123'
          // No messaging or messaging_handovers arrays
        }]
      }

      const ctx = {
        request: { body: webhookPayload },
        status: 0
      }

      await handleMessengerEvents(ctx, producerMock, producerReadyMock, 'test-events')

      ctx.status.should.equal(200)
      producerMock.produce.should.not.have.been.called
    })

    it('should handle empty event arrays', async () => {
      const webhookPayload = {
        object: 'page',
        entry: [{
          messaging: [],
          messaging_handovers: []
        }]
      }

      const ctx = {
        request: { body: webhookPayload },
        status: 0
      }

      await handleMessengerEvents(ctx, producerMock, producerReadyMock, 'test-events')

      ctx.status.should.equal(200)
      producerMock.produce.should.not.have.been.called
    })

    it('should handle producer errors gracefully', async () => {
      producerMock.produce.throws(new Error('Kafka error'))
      
      const webhookPayload = {
        object: 'page',
        entry: [{
          messaging: [{
            sender: { id: 'user123' },
            timestamp: 1640995200000,
            message: { text: 'Hello' }
          }]
        }]
      }

      const ctx = {
        request: { body: webhookPayload },
        status: 0
      }

      // Should not throw an error
      await handleMessengerEvents(ctx, producerMock, producerReadyMock, 'test-events')
      ctx.status.should.equal(200)
    })
  })

  describe('normalizeTimestamp', () => {
    it('should convert seconds to milliseconds for timestamps before 2020', () => {
      const timestampInSeconds = 1577836800 // Jan 1, 2020 in seconds
      const result = normalizeTimestamp(timestampInSeconds)
      result.should.equal(1577836800000) // Should be in milliseconds
    })

    it('should leave timestamps in milliseconds unchanged', () => {
      const timestampInMilliseconds = 1640995200000 // Some date in 2022
      const result = normalizeTimestamp(timestampInMilliseconds)
      result.should.equal(1640995200000) // Should remain unchanged
    })
  })
})
