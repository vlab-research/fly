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
          description: 'type: handoff\ntarget_app_id: 123456789\ntimeout_minutes: 30'
        }
      }

      const result = addCustomType(field)

      result.should.be.an('object')
      result.type.should.equal('handoff') // Base addCustomType changes the type
      result.ref.should.equal('customer_service')
      result.handoff.should.be.an('object')
      result.handoff.target_app_id.should.equal(123456789) // YAML parses as number
      result.handoff.wait.should.deep.equal({ 
        op: 'or',
        vars: [
          { type: 'handover', value: { target_app_id: 123456789 } },
          { type: 'timeout', value: '30m' }
        ]
      })
      result.handoff.metadata.should.be.an('object')
      result.handoff.metadata.question_ref.should.equal('customer_service')
    })

    it('should parse handoff with custom wait condition', () => {
      const field = {
        type: 'statement',
        title: 'Connecting you to sales...',
        ref: 'sales_chat',
        properties: {
          description: `type: handoff
target_app_id: 987654321
wait:
  op: or
  vars:
    - type: external
      value:
        type: handoff_return
        target_app_id: 987654321
    - type: timeout
      value: 45m
metadata:
  user_intent: purchase
  product_category: enterprise`
        }
      }

      const result = addCustomType(field)

      result.should.be.an('object')
      result.handoff.target_app_id.should.equal(987654321) // YAML parses as number
      result.handoff.wait.should.deep.equal({
        op: 'or',
        vars: [
          {
            type: 'external',
            value: {
              type: 'handoff_return',
              target_app_id: 987654321 // YAML parses as number
            }
          },
          {
            type: 'timeout',
            value: '45m'
          }
        ]
      })
      result.handoff.metadata.user_intent.should.equal('purchase')
      result.handoff.metadata.product_category.should.equal('enterprise')
    })

    it('should use default timeout if not specified', () => {
      const field = {
        type: 'statement',
        title: 'Connecting you to support...',
        ref: 'support',
        properties: {
          description: 'type: handoff\ntarget_app_id: 555666777'
        }
      }

      const result = addCustomType(field)

      result.handoff.wait.should.deep.equal({ 
        op: 'or',
        vars: [
          { type: 'handover', value: { target_app_id: 555666777 } },
          { type: 'timeout', value: '60m' }
        ]
      })
    })

    it('should include survey_id in metadata if provided', () => {
      const field = {
        type: 'statement',
        title: 'Connecting you to support...',
        ref: 'support',
        properties: {
          description: `type: handoff
target_app_id: 555666777
survey_id: survey_123
metadata:
  custom_field: custom_value`
        }
      }

      const result = addCustomType(field)

      result.handoff.metadata.survey_id.should.equal('survey_123')
      result.handoff.metadata.custom_field.should.equal('custom_value')
      result.handoff.metadata.question_ref.should.equal('support')
    })

    it('should not add handoff property for non-handoff questions', () => {
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
      should.not.exist(result.handoff)
    })

    it('should not add handoff property for invalid YAML', () => {
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
      should.not.exist(result.handoff)
    })

    it('should not add handoff property for non-YAML description', () => {
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
      should.not.exist(result.handoff)
    })

    it('should not add handoff property for YAML without type field', () => {
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
      should.not.exist(result.handoff)
    })

    it('should not add handoff property for YAML with different type', () => {
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
      result.type.should.equal('share') // Base addCustomType changes the type
      should.not.exist(result.handoff)
    })

    it('should handle missing properties gracefully', () => {
      const field = {
        type: 'statement',
        title: 'No properties',
        ref: 'no_props'
        // No properties field
      }

      const result = addCustomType(field)

      result.should.be.an('object')
      result.type.should.equal('statement')
      should.not.exist(result.handoff)
    })

    it('should handle missing description gracefully', () => {
      const field = {
        type: 'statement',
        title: 'No description',
        ref: 'no_desc',
        properties: {
          // No description field
        }
      }

      const result = addCustomType(field)

      result.should.be.an('object')
      result.type.should.equal('statement')
      should.not.exist(result.handoff)
    })
  })
})
