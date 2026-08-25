const chai = require('chai')
const should = chai.should()
const { responseVals } = require('./responser')

describe('responseVals', () => {
  // A response row is archived by scribble into chatroach.responses. The
  // `platform` column (migration 26) is nullable and is what binds the row to
  // its conversation's transport after `credentials` cascades on user delete.
  // It must be threaded from the event through transition() into the payload --
  // nothing else populates it.
  it('includes the conversation platform on the response row', () => {
    const form = { id: 'F', fields: [{ ref: 'q1', title: 'Q1', type: 'short_text', properties: {} }] }
    const newState = { forms: ['FOO'], md: { seed: 123, form: 'FOO' } }
    const update = ['q1', 'answer']

    const row = responseVals(newState, update, form, 'survey-1', 'page-1', { id: 'user-1' }, 1599039840517, 'whatsapp')

    row.platform.should.equal('whatsapp')
  })

  it('includes platform even when it is the empty string (a nullable column absorbs it)', () => {
    const form = { id: 'F', fields: [{ ref: 'q1', title: 'Q1', type: 'short_text', properties: {} }] }
    const newState = { forms: ['FOO'], md: { seed: 123, form: 'FOO' } }
    const update = ['q1', 'answer']

    const row = responseVals(newState, update, form, 'survey-1', 'page-1', { id: 'user-1' }, 1599039840517, '')

    should.exist(row.platform)
    row.platform.should.equal('')
  })
})
