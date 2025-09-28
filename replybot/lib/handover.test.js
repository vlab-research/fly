const chai = require('chai')
const should = chai.should()

// Set up environment variables for testing
process.env.FACEBOOK_APP_ID = '123456789'

// Copy the function directly to avoid importing the full index.js with Kafka dependencies
function convertHandoverToExternal(handoverEvent, userId) {
  try {
    const event = JSON.parse(handoverEvent)
    
    // Only process handover events where control was passed to our app
    if (event.source !== 'messenger' || !event.pass_thread_control) {
      return null
    }
    
    const { new_owner_app_id, previous_owner_app_id, metadata } = event.pass_thread_control
    
    // Security check: only process handovers TO our app
    if (new_owner_app_id !== process.env.FACEBOOK_APP_ID) {
      console.log(`Ignoring handover to different app: ${new_owner_app_id}`)
      return null
    }
    
    // Parse metadata if it's a string
    let parsedMetadata = {}
    if (metadata) {
      try {
        parsedMetadata = typeof metadata === 'string' ? JSON.parse(metadata) : metadata
      } catch (e) {
        console.warn('Failed to parse handover metadata:', e.message)
      }
    }
    
    // Create synthetic external event
    const syntheticEvent = {
      source: 'synthetic',
      user: userId,
      page: event.recipient?.id || 'unknown',
      timestamp: event.timestamp || Date.now(),
      event: {
        type: 'external',
        value: {
          type: 'handoff_return',
          target_app_id: previous_owner_app_id,
          timestamp: event.timestamp || Date.now(),
          ...parsedMetadata
        }
      }
    }
    
    console.log('Converted handover to synthetic external event:', syntheticEvent)
    return syntheticEvent
    
  } catch (error) {
    console.error('Error converting handover event:', error)
    return null
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

    it('should handle handover event with object metadata', () => {
      const handoverEvent = JSON.stringify({
        source: 'messenger',
        sender: { id: 'user123' },
        recipient: { id: 'page123' },
        timestamp: 1640995200000,
        pass_thread_control: {
          new_owner_app_id: '123456789',
          previous_owner_app_id: '987654321',
          metadata: { completion_status: 'success', user_intent: 'purchase' }
        }
      })

      const result = convertHandoverToExternal(handoverEvent, 'user123')

      result.should.be.an('object')
      result.event.value.completion_status.should.equal('success')
      result.event.value.user_intent.should.equal('purchase')
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

    it('should return null for non-handover events', () => {
      const regularEvent = JSON.stringify({
        source: 'messenger',
        sender: { id: 'user123' },
        recipient: { id: 'page123' },
        timestamp: 1640995200000,
        message: { text: 'Hello bot!' }
      })

      const result = convertHandoverToExternal(regularEvent, 'user123')

      should.not.exist(result)
    })

    it('should return null for non-messenger events', () => {
      const syntheticEvent = JSON.stringify({
        source: 'synthetic',
        event: { type: 'external', value: { type: 'handoff_return' } }
      })

      const result = convertHandoverToExternal(syntheticEvent, 'user123')

      should.not.exist(result)
    })

    it('should handle malformed JSON gracefully', () => {
      const malformedEvent = '{"source": "messenger", "pass_thread_control": {'

      const result = convertHandoverToExternal(malformedEvent, 'user123')

      should.not.exist(result)
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

    it('should handle invalid metadata JSON gracefully', () => {
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

      const result = convertHandoverToExternal(handoverEvent, 'user123')

      result.should.be.an('object')
      result.event.value.type.should.equal('handoff_return')
      result.event.value.target_app_id.should.equal('987654321')
      // Should not have metadata fields due to parse error
      should.not.exist(result.event.value.invalid)
    })

    it('should use current timestamp if missing', () => {
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

      const before = Date.now()
      const result = convertHandoverToExternal(handoverEvent, 'user123')
      const after = Date.now()

      result.should.be.an('object')
      result.timestamp.should.be.at.least(before)
      result.timestamp.should.be.at.most(after)
    })

    it('should use unknown page if recipient missing', () => {
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

      const result = convertHandoverToExternal(handoverEvent, 'user123')

      result.should.be.an('object')
      result.page.should.equal('unknown')
    })
  })
})
