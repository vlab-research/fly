const mocha = require('mocha')
const chai = require('chai')
const should = chai.should()
const { translateTypeformField } = require('./generic-translator')

describe('translateTypeformField', () => {

  describe('translateAttachment', () => {
    it('preserves field.md (including keepMoving) in metadata', () => {
      const field = {
        type: 'attachment',
        ref: 'attachment_1',
        title: 'Please share an image',
        md: { keepMoving: true, customFlag: 'test' },
        properties: {
          description: ''
        }
      }

      const result = translateTypeformField(field)

      result.should.have.property('metadata')
      result.metadata.should.have.property('keepMoving', true)
      result.metadata.should.have.property('customFlag', 'test')
      result.metadata.should.have.property('ref', 'attachment_1')
      result.metadata.should.have.property('type', 'attachment')
    })

    it('preserves attachment metadata when field.md is empty', () => {
      const field = {
        type: 'attachment',
        ref: 'attachment_2',
        title: 'Share your photo',
        md: {},
        properties: {
          description: ''
        }
      }

      const result = translateTypeformField(field)

      result.should.have.property('metadata')
      result.metadata.should.have.property('ref', 'attachment_2')
      result.metadata.should.have.property('type', 'attachment')
      // Should not have unexpected properties
      result.metadata.should.not.have.property('keepMoving')
    })

    it('has correct media and caption fields', () => {
      const field = {
        type: 'attachment',
        ref: 'att_3',
        title: 'Attachment Title',
        md: { keepMoving: true },
        properties: {
          description: 'Some description'
        }
      }

      const result = translateTypeformField(field)

      result.should.have.property('type', 'media')
      result.should.have.property('caption', 'Attachment Title')
      result.should.have.property('media_type', 'image')
    })
  })

  describe('translateStatement', () => {
    it('preserves field.md in metadata (existing behavior)', () => {
      const field = {
        type: 'statement',
        ref: 'stmt_1',
        title: 'Thank you for your response',
        md: { keepMoving: true, customData: 'value' },
        properties: {}
      }

      const result = translateTypeformField(field)

      result.metadata.should.have.property('keepMoving', true)
      result.metadata.should.have.property('customData', 'value')
      result.metadata.should.have.property('type', 'statement')
    })
  })

  describe('translateQuestionWithChoices', () => {
    it('preserves field.md in metadata', () => {
      const field = {
        type: 'multiple_choice',
        ref: 'q_1',
        title: 'Pick one',
        md: { keepMoving: false },
        properties: {
          choices: [
            { label: 'Option A', ref: 'opt_a' },
            { label: 'Option B', ref: 'opt_b' }
          ]
        }
      }

      const result = translateTypeformField(field)

      result.metadata.should.have.property('keepMoving', false)
      result.metadata.should.have.property('ref', 'q_1')
    })
  })
})
