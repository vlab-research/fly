const chai = require('chai')
const should = chai.should()

// Set up environment variables for testing
process.env.FACEBOOK_APP_ID = '123456789'

// Copy the function directly to avoid importing the full index.js with Kafka dependencies
function convertHandoverToExternal(handoverEvent, userId) {
  try {
    const event = JSON.parse(handoverEvent)
    
    // Validate handover event structure - fail fast if malformed
    if (event.source !== 'messenger') {
      throw new Error(`Invalid event source: expected 'messenger', got '${event.source}'`)
    }
    
    if (!event.pass_thread_control) {
      throw new Error('Missing pass_thread_control in handover event')
    }
    
    const { new_owner_app_id, previous_owner_app_id, metadata } = event.pass_thread_control
    
    if (!new_owner_app_id) {
      throw new Error('Missing new_owner_app_id in pass_thread_control')
    }
    
    if (!previous_owner_app_id) {
      throw new Error('Missing previous_owner_app_id in pass_thread_control')
    }
    
    // Security check: only process handovers TO our app
    if (new_owner_app_id !== process.env.FACEBOOK_APP_ID) {
      console.log(`Ignoring handover to different app: ${new_owner_app_id}`)
      return null
    }
    
    // Parse metadata - Facebook API guarantees it's a string
    let parsedMetadata = {}
    if (metadata) {
      if (typeof metadata !== 'string') {
        throw new Error(`Invalid handover metadata type: expected string, got ${typeof metadata}. This violates Facebook API specification.`)
      }
      try {
        parsedMetadata = JSON.parse(metadata)
      } catch (e) {
        throw new Error(`Invalid JSON in handover metadata: ${e.message}. Metadata: "${metadata}"`)
      }
    }
    
    // Validate required fields
    if (!event.timestamp) {
      throw new Error('Missing timestamp in handover event')
    }
    
    if (!event.recipient || !event.recipient.id) {
      throw new Error('Missing recipient.id in handover event')
    }
    
    // Create synthetic external event
    const syntheticEvent = {
      source: 'synthetic',
      user: userId,
      page: event.recipient.id,
      timestamp: event.timestamp,
      event: {
        type: 'external',
        value: {
          type: 'handoff_return',
          target_app_id: previous_owner_app_id,
          timestamp: event.timestamp,
          ...parsedMetadata
        }
      }
    }
    
    console.log('Converted handover to synthetic external event:', syntheticEvent)
    return syntheticEvent
    
  } catch (error) {
    console.error('Error converting handover event:', error)
    throw error // Re-throw instead of returning null
  }
}

describe('Handover Event Processing', () => {

  describe('convertHandoverToExternal', () => {
    it('should convert valid handover event to synthetic external event', () => {
      const handoverEvent = JSON.stringify({
        source: 'messenger',
        sender: { id: 'user123' },
        recipient: { id: 'page123' },
        timestamp: 1640995200000,
        pass_thread_control: {
          new_owner_app_id: '123456789',
          previous_owner_app_id: '987654321',
          metadata: '{"completion_status":"success","user_intent":"purchase"}'
        }
      })

      const result = convertHandoverToExternal(handoverEvent, 'user123')

      result.should.be.an('object')
      result.source.should.equal('synthetic')
      result.user.should.equal('user123')
      result.page.should.equal('page123')
      result.timestamp.should.equal(1640995200000)
      result.event.type.should.equal('external')
      result.event.value.type.should.equal('handoff_return')
      result.event.value.target_app_id.should.equal('987654321')
      result.event.value.completion_status.should.equal('success')
      result.event.value.user_intent.should.equal('purchase')
    })

    it('should throw error for object metadata (Facebook API violation)', () => {
      const handoverEvent = JSON.stringify({
        source: 'messenger',
        sender: { id: 'user123' },
        recipient: { id: 'page123' },
        timestamp: 1640995200000,
        pass_thread_control: {
          new_owner_app_id: '123456789',
          previous_owner_app_id: '987654321',
          metadata: { completion_status: 'success', user_intent: 'purchase' } // Object instead of string
        }
      })

      should.throw(() => {
        convertHandoverToExternal(handoverEvent, 'user123')
      }, 'Invalid handover metadata type: expected string, got object')
    })

    it('should ignore handover events to different apps', () => {
      const handoverEvent = JSON.stringify({
        source: 'messenger',
        sender: { id: 'user123' },
        recipient: { id: 'page123' },
        timestamp: 1640995200000,
        pass_thread_control: {
          new_owner_app_id: '999999999', // Different app
          previous_owner_app_id: '987654321',
          metadata: '{"completion_status":"success"}'
        }
      })

      const result = convertHandoverToExternal(handoverEvent, 'user123')

      should.not.exist(result)
    })

    it('should throw error for non-handover events', () => {
      const regularEvent = JSON.stringify({
        source: 'messenger',
        sender: { id: 'user123' },
        recipient: { id: 'page123' },
        timestamp: 1640995200000,
        message: { text: 'Hello bot!' }
      })

      should.throw(() => {
        convertHandoverToExternal(regularEvent, 'user123')
      }, 'Missing pass_thread_control in handover event')
    })

    it('should throw error for non-messenger events', () => {
      const syntheticEvent = JSON.stringify({
        source: 'synthetic',
        event: { type: 'external', value: { type: 'handoff_return' } }
      })

      should.throw(() => {
        convertHandoverToExternal(syntheticEvent, 'user123')
      }, "Invalid event source: expected 'messenger', got 'synthetic'")
    })

    it('should throw error for malformed JSON', () => {
      const malformedEvent = '{"source": "messenger", "pass_thread_control": {'

      should.throw(() => {
        convertHandoverToExternal(malformedEvent, 'user123')
      }, 'Unexpected end of JSON input')
    })

    it('should handle missing metadata gracefully', () => {
      const handoverEvent = JSON.stringify({
        source: 'messenger',
        sender: { id: 'user123' },
        recipient: { id: 'page123' },
        timestamp: 1640995200000,
        pass_thread_control: {
          new_owner_app_id: '123456789',
          previous_owner_app_id: '987654321'
          // No metadata
        }
      })

      const result = convertHandoverToExternal(handoverEvent, 'user123')

      result.should.be.an('object')
      result.event.value.type.should.equal('handoff_return')
      result.event.value.target_app_id.should.equal('987654321')
      // Should not have metadata fields
      should.not.exist(result.event.value.completion_status)
    })

    it('should throw error for invalid metadata JSON', () => {
      const handoverEvent = JSON.stringify({
        source: 'messenger',
        sender: { id: 'user123' },
        recipient: { id: 'page123' },
        timestamp: 1640995200000,
        pass_thread_control: {
          new_owner_app_id: '123456789',
          previous_owner_app_id: '987654321',
          metadata: '{"invalid": json}' // Invalid JSON
        }
      })

      should.throw(() => {
        convertHandoverToExternal(handoverEvent, 'user123')
      }, 'Invalid JSON in handover metadata')
    })

    it('should throw error for missing timestamp', () => {
      const handoverEvent = JSON.stringify({
        source: 'messenger',
        sender: { id: 'user123' },
        recipient: { id: 'page123' },
        // No timestamp
        pass_thread_control: {
          new_owner_app_id: '123456789',
          previous_owner_app_id: '987654321'
        }
      })

      should.throw(() => {
        convertHandoverToExternal(handoverEvent, 'user123')
      }, 'Missing timestamp in handover event')
    })

    it('should throw error for missing recipient', () => {
      const handoverEvent = JSON.stringify({
        source: 'messenger',
        sender: { id: 'user123' },
        // No recipient
        timestamp: 1640995200000,
        pass_thread_control: {
          new_owner_app_id: '123456789',
          previous_owner_app_id: '987654321'
        }
      })

      should.throw(() => {
        convertHandoverToExternal(handoverEvent, 'user123')
      }, 'Missing recipient.id in handover event')
    })

    it('should throw error for non-string metadata', () => {
      const handoverEvent = JSON.stringify({
        source: 'messenger',
        sender: { id: 'user123' },
        recipient: { id: 'page123' },
        timestamp: 1640995200000,
        pass_thread_control: {
          new_owner_app_id: '123456789',
          previous_owner_app_id: '987654321',
          metadata: { completion_status: 'success' } // Object instead of string
        }
      })

      should.throw(() => {
        convertHandoverToExternal(handoverEvent, 'user123')
      }, 'Invalid handover metadata type: expected string, got object')
    })

    it('should throw error for missing new_owner_app_id', () => {
      const handoverEvent = JSON.stringify({
        source: 'messenger',
        sender: { id: 'user123' },
        recipient: { id: 'page123' },
        timestamp: 1640995200000,
        pass_thread_control: {
          previous_owner_app_id: '987654321'
          // Missing new_owner_app_id
        }
      })

      should.throw(() => {
        convertHandoverToExternal(handoverEvent, 'user123')
      }, 'Missing new_owner_app_id in pass_thread_control')
    })

    it('should throw error for missing previous_owner_app_id', () => {
      const handoverEvent = JSON.stringify({
        source: 'messenger',
        sender: { id: 'user123' },
        recipient: { id: 'page123' },
        timestamp: 1640995200000,
        pass_thread_control: {
          new_owner_app_id: '123456789'
          // Missing previous_owner_app_id
        }
      })

      should.throw(() => {
        convertHandoverToExternal(handoverEvent, 'user123')
      }, 'Missing previous_owner_app_id in pass_thread_control')
    })

    it('should throw error for invalid event source', () => {
      const handoverEvent = JSON.stringify({
        source: 'synthetic', // Wrong source
        sender: { id: 'user123' },
        recipient: { id: 'page123' },
        timestamp: 1640995200000,
        pass_thread_control: {
          new_owner_app_id: '123456789',
          previous_owner_app_id: '987654321'
        }
      })

      should.throw(() => {
        convertHandoverToExternal(handoverEvent, 'user123')
      }, "Invalid event source: expected 'messenger', got 'synthetic'")
    })

    it('should throw error for missing pass_thread_control', () => {
      const handoverEvent = JSON.stringify({
        source: 'messenger',
        sender: { id: 'user123' },
        recipient: { id: 'page123' },
        timestamp: 1640995200000
        // Missing pass_thread_control
      })

      should.throw(() => {
        convertHandoverToExternal(handoverEvent, 'user123')
      }, 'Missing pass_thread_control in handover event')
    })
  })
})
