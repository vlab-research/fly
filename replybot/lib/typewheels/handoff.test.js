const chai = require('chai')
const should = chai.should()

describe('Handoff Question Parsing', () => {
  let addCustomType

  beforeEach(() => {
    const form = require('./form')
    addCustomType = form.addCustomType
  })

  describe('addCustomType with handoff', () => {
    it('should parse basic handoff question', () => {
      const field = {
        type: 'statement',
        title: 'Connecting you to customer service...',
        ref: 'customer_service',
        properties: {
          description: 'type: handoff\nhandoff:\n  target_app_id: 123456789\n  mode: wait\n  metadata:\n    reason: support'
        }
      }

      const result = addCustomType(field)

      result.should.be.an('object')
      result.type.should.equal('handoff')
      result.ref.should.equal('customer_service')
      result.md.type.should.equal('handoff')
      result.md.handoff.target_app_id.should.equal(123456789)
      result.md.handoff.mode.should.equal('wait')
      result.md.handoff.metadata.reason.should.equal('support')
    })

    it('should parse handoff with minimal fields', () => {
      const field = {
        type: 'statement',
        title: 'Connecting you to sales...',
        ref: 'sales_chat',
        properties: {
          description: 'type: handoff\nhandoff:\n  target_app_id: 987654321'
        }
      }

      const result = addCustomType(field)

      result.should.be.an('object')
      result.type.should.equal('handoff')
      result.md.handoff.target_app_id.should.equal(987654321)
    })

    it('should not add handoff md for non-handoff questions', () => {
      const field = {
        type: 'statement',
        title: 'Regular statement',
        ref: 'regular',
        properties: {
          description: 'This is just a regular statement'
        }
      }

      const result = addCustomType(field)

      result.should.be.an('object')
      result.type.should.equal('statement')
      should.not.exist(result.md)
    })

    it('should not add handoff md for invalid YAML', () => {
      const field = {
        type: 'statement',
        title: 'Invalid YAML',
        ref: 'invalid',
        properties: {
          description: 'type: handoff\ninvalid: yaml: content: ['
        }
      }

      const result = addCustomType(field)

      result.should.be.an('object')
      result.type.should.equal('statement')
      should.not.exist(result.md)
    })

    it('should not add handoff md for non-YAML description', () => {
      const field = {
        type: 'statement',
        title: 'Not YAML',
        ref: 'not_yaml',
        properties: {
          description: 'This is not YAML at all'
        }
      }

      const result = addCustomType(field)

      result.should.be.an('object')
      result.type.should.equal('statement')
      should.not.exist(result.md)
    })

    it('should not add handoff md for YAML without type field', () => {
      const field = {
        type: 'statement',
        title: 'YAML without type',
        ref: 'no_type',
        properties: {
          description: 'target_app_id: 123456789\ntimeout_minutes: 30'
        }
      }

      const result = addCustomType(field)

      result.should.be.an('object')
      result.type.should.equal('statement')
    })

    it('should not add handoff md for YAML with different type', () => {
      const field = {
        type: 'statement',
        title: 'Different type',
        ref: 'different_type',
        properties: {
          description: 'type: share\nurl: https://example.com'
        }
      }

      const result = addCustomType(field)

      result.should.be.an('object')
      result.type.should.equal('share')
      should.not.exist(result.md.handoff)
    })

    it('should handle missing properties gracefully', () => {
      const field = {
        type: 'statement',
        title: 'No properties',
        ref: 'no_props'
      }

      const result = addCustomType(field)

      result.should.be.an('object')
      result.type.should.equal('statement')
    })

    it('should handle missing description gracefully', () => {
      const field = {
        type: 'statement',
        title: 'No description',
        ref: 'no_desc',
        properties: {}
      }

      const result = addCustomType(field)

      result.should.be.an('object')
      result.type.should.equal('statement')
    })
  })
})
