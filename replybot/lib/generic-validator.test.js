const mocha = require('mocha')
const chai = require('chai')
const should = chai.should()
const { validator } = require('./generic-validator')
const { categorizeWhatsAppEvent } = require('./event-normalizer')

// An upload question as it reaches the validator: field.type 'upload', with the
// accepted media type under md.validate.type (md.upload.type is an alias).
const uploadField = (mediaType, key = 'validate') => ({
  type: 'upload',
  md: { [key]: { type: mediaType } }
})

// The verbatim production webhook payload from the 2026-08-05 Track A test.
// See planning/inbound-media.md Appendix A §2. Note `url`, not `link` —
// reading `link` here is what rejected every WhatsApp media answer.
const REAL_WHATSAPP_IMAGE_WEBHOOK = {
  from: '15419799714',
  id: 'wamid.HBgLMTU0MTk3OTk3MTQVAgASGCBBQzZFQzMyQ0ZCQ0VFOTAxMTEyNTdBQ0Y1NDhCRUMwMwA=',
  timestamp: 1785972838000,
  type: 'image',
  image: {
    mime_type: 'image/jpeg',
    sha256: 'IykpcWWXi/vfsIJ1QUUouc+HEoWd5W/ypMuc/6L7/es=',
    id: '2563305464111161',
    url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=2563305464111161&source=webhook&ext=1785973140&hash=abc'
  },
  source: 'whatsapp',
  phone_number_id: '1203867182815254'
}

describe('validateUpload', () => {

  describe('end-to-end: real WhatsApp webhook through normalizer into validator', () => {

    it('accepts the production payload that used to be rejected', () => {
      const { payload } = categorizeWhatsAppEvent(REAL_WHATSAPP_IMAGE_WEBHOOK)
      const attachment = payload.attachments[0]

      const { valid } = validator(uploadField('image'), {})(attachment)
      valid.should.be.true
    })

    it('carries the durable media id through normalization', () => {
      const { payload } = categorizeWhatsAppEvent(REAL_WHATSAPP_IMAGE_WEBHOOK)
      payload.attachments[0].payload.id.should.equal('2563305464111161')
    })

    it('rejects when the sent media type is not the type the question asked for', () => {
      const { payload } = categorizeWhatsAppEvent(REAL_WHATSAPP_IMAGE_WEBHOOK)
      const attachment = payload.attachments[0]

      const { valid } = validator(uploadField('video'), {})(attachment)
      valid.should.be.false
    })
  })

  describe('validity rests on the media id, not the URL', () => {

    it('accepts an id with no URL at all', () => {
      // The state that matters: WhatsApp URLs require a Bearer token and die in
      // ~302s (findings §4). The id is the only durable handle, so it alone must
      // be enough to call the answer valid.
      const attachment = {
        type: 'image',
        payload: { id: '2563305464111161', url: null, mime_type: 'image/jpeg', sha256: 'abc' }
      }

      const { valid } = validator(uploadField('image'), {})(attachment)
      valid.should.be.true
    })

    it('regression: accepts a Messenger attachment, which has a URL but no id', () => {
      const attachment = {
        type: 'image',
        payload: { url: 'https://scontent.xx.fbcdn.net/v/t39.1997-6/image.png' }
      }

      const { valid } = validator(uploadField('image'), {})(attachment)
      valid.should.be.true
    })

    it('rejects when neither id nor URL is present', () => {
      const { valid } = validator(uploadField('image'), {})({ type: 'image', payload: {} })
      valid.should.be.false
    })

    it('rejects a null response', () => {
      validator(uploadField('image'), {})(null).valid.should.be.false
    })

    it('rejects a bare text answer to an upload question', () => {
      validator(uploadField('image'), {})('some text').valid.should.be.false
    })
  })

  it('reads the accepted type from the md.upload alias as well as md.validate', () => {
    const attachment = { type: 'image', payload: { id: 'abc' } }
    validator(uploadField('image', 'upload'), {})(attachment).valid.should.be.true
    validator(uploadField('video', 'upload'), {})(attachment).valid.should.be.false
  })
})

// Phone answers as respondents actually type them. A `phone_number` question
// carries the expected country in properties.default_country_code; without it
// a bare national number has no country and cannot be resolved.
const phoneField = (country) => ({
  type: 'phone_number',
  properties: country ? { default_country_code: country } : {}
})

describe('validatePhone', () => {
  const accepts = (field, ...numbers) => numbers.forEach(n => {
    it(`accepts ${JSON.stringify(n)}`, () => {
      validator(field, {})(n).valid.should.be.true
    })
  })

  describe('Argentina', () => {
    // Argentine mobiles carry a 9 between the country code and the area code.
    // Every one of these is the same reachable handset written the way a
    // respondent writes it.
    accepts(phoneField('AR'),
      '+5491164018373',
      '+54 9 11 6401-8373',
      '5491164018373',
      '54 9 1164018373',
      '+5492613900931')

    it('rejects a number with too many digits to dial', () => {
      validator(phoneField('AR'), {})('+549112326403068').valid.should.be.false
    })

    // No country code. Resolvable only against the question's country.
    accepts(phoneField('AR'), '1164018373', '2346459349', '2613900931')

    it('rejects a national number when the question names no country', () => {
      validator(phoneField(null), {})('1164018373').valid.should.be.false
    })
  })

  describe('other corridors', () => {
    accepts(phoneField('BO'), '+59171234567')
    accepts(phoneField('HN'), '+50499887766')
    accepts(phoneField('KE'), '+254712345678')

    it('treats a lowercase country code as that country', () => {
      validator(phoneField('ar'), {})('1164018373').valid.should.be.true
    })

    it('rejects a number that is too short to dial', () => {
      validator(phoneField('AR'), {})('23345').valid.should.be.false
    })
  })
})
