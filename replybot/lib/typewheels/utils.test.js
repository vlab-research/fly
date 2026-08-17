const chai = require('chai')
const should = chai.should()
const u = require('./utils')

const { getStarted, echo, statementEcho, delivery, read, qr, text, multipleChoice, referral, whatsappReferral, WA_PHONE_NUMBER_ID } = require('./events.test')



describe('getForm', () => {
  let prevFallback

  before(() => {
    prevFallback = process.env.FALLBACK_FORM
    process.env.FALLBACK_FORM = 'fallback'
  })
  after(() => {
    process.env.FALLBACK_FORM = prevFallback
  })

  it('gets a form when one exists', () => {
    u.getForm(referral).should.equal('FOO')
  })

  it('gets the fallback form when referral has no form', () => {
    u.getForm({ ...referral, payload: { ...referral.payload, referral: { ref: 'blah' } } }).should.equal('fallback')
  })
})

describe('_group', () => {
  it('pairs when even', () => {
    u._group([1, 2, 3, 4]).should.deep.equal({ 1: 2, 3: 4 })
    u._group(['foo', 'bar', 'baz', 'buz']).should.deep.equal({ foo: 'bar', baz: 'buz' })
  })

  it('leaves last item undefined when odd', () => {
    u._group(['foo', 'bar', 'baz']).should.deep.equal({ foo: 'bar', baz: undefined })
  })
})

describe('getMetadata', () => {
  let prevFallback
  before(() => {
    prevFallback = process.env.FALLBACK_FORM
    process.env.FALLBACK_FORM = 'fallback'
  })
  after(() => {
    process.env.FALLBACK_FORM = prevFallback
  })

  it('gets metadata from referral', () => {
    u.getMetadata(referral)
      .should.deep.equal(
        {
          form: 'FOO',
          foo: 'bar',
          seed: 4001850155,
          startTime: referral.timestamp,
          pageid: '1051551461692797',
          platform: 'messenger'
        }
      )
  })

  it('falls back to fallback infor when there is no referral event', () => {
    u.getMetadata(echo)
      .should.deep.equal(
        {
          form: 'fallback',
          seed: 2378635558,
          startTime: echo.timestamp,
          pageid: '1051551461692797',
          platform: 'messenger'
        }
      )
  })

  it('persists platform whatsapp from a whatsapp conversation start', () => {
    const md = u.getMetadata(whatsappReferral)
    md.platform.should.equal('whatsapp')
    md.pageid.should.equal(WA_PHONE_NUMBER_ID)
    md.form.should.equal('FOO')
  })

  it('persists platform from a synthetic referral carrying a platform hint, never synthetic', () => {
    const syntheticReferral = {
      ...whatsappReferral,
      source: { type: 'synthetic', account_id: WA_PHONE_NUMBER_ID, platform: 'whatsapp' }
    }
    const md = u.getMetadata(syntheticReferral)
    md.platform.should.equal('whatsapp')
  })

  it('defaults platform to messenger on a synthetic referral without a hint', () => {
    const syntheticReferral = {
      ...referral,
      source: { type: 'synthetic', account_id: referral.source.account_id }
    }
    const md = u.getMetadata(syntheticReferral)
    md.platform.should.equal('messenger')
  })

  // _decodeToken containment: %FF is a well-formed %XX escape but not valid
  // UTF-8, so decodeURIComponent throws on it. Without _decodeToken, that
  // throw propagated out of the pairs.map(...) inside getMetadata's
  // try/catch around the WHOLE ref parse, discarding md entirely -- including
  // `form` -- and falling to FALLBACK_FORM. Now only the bad token is kept
  // raw; the rest of the ref, `form` especially, still resolves.
  it('keeps a malformed-UTF-8-but-well-formed escape raw without losing the form', () => {
    const badEscapeReferral = {
      ...referral,
      payload: { ...referral.payload, referral: { ref: 'form.FOO.k.%FF' } }
    }
    const md = u.getMetadata(badEscapeReferral)
    md.form.should.equal('FOO')
    md.k.should.equal('%FF')
  })
})

describe('eventPlatform', () => {
  it('returns source.type for real platform events', () => {
    u.eventPlatform({ source: { type: 'messenger', account_id: 'x' } }).should.equal('messenger')
    u.eventPlatform({ source: { type: 'whatsapp', account_id: 'x' } }).should.equal('whatsapp')
  })

  it('returns the platform hint for synthetic events', () => {
    u.eventPlatform({ source: { type: 'synthetic', account_id: 'x', platform: 'whatsapp' } }).should.equal('whatsapp')
    u.eventPlatform({ source: { type: 'synthetic', account_id: 'x', platform: 'messenger' } }).should.equal('messenger')
  })

  it('never returns synthetic — defaults to messenger', () => {
    u.eventPlatform({ source: { type: 'synthetic', account_id: 'x' } }).should.equal('messenger')
    u.eventPlatform({ source: { type: 'synthetic', platform: 'synthetic' } }).should.equal('messenger')
    u.eventPlatform({ source: {} }).should.equal('messenger')
    u.eventPlatform({}).should.equal('messenger')
  })
})

// md.ad_id — see the "Ad identity" block comment in utils.js for the full
// rationale. adIdFromReferral is pure, so this is the cheap exhaustive layer;
// machine.test.js separately proves the same rules survive a real raw webhook
// through parseEvent -> getMetadata.
describe('adIdFromReferral', () => {
  it('messenger: reads referral.ad_id directly, no gate', () => {
    u.adIdFromReferral({ ad_id: '123' }, 'messenger').should.equal('123')
  })

  it('messenger: no ad_id on the referral -> undefined', () => {
    should.equal(u.adIdFromReferral({}, 'messenger'), undefined)
  })

  it('messenger: null/undefined referral -> undefined, does not throw', () => {
    should.equal(u.adIdFromReferral(null, 'messenger'), undefined)
    should.equal(u.adIdFromReferral(undefined, 'messenger'), undefined)
  })

  it('whatsapp: source_type "ad" gates source_id through', () => {
    u.adIdFromReferral({ source_type: 'ad', source_id: '120254866237980150' }, 'whatsapp')
      .should.equal('120254866237980150')
  })

  // The regression that matters most: source_id is not ad-specific. An
  // organic reshare of a page post also carries a source_id, but it is a
  // POST id, and source_type says so. Capturing it unconditionally would
  // write post ids into ad_id, where they can never match vlab's
  // (network, ad_id) mapping and would pile up forever in the "unmapped"
  // bucket that exists to catch real bugs.
  it('whatsapp: source_type "post" must NOT resolve an ad_id', () => {
    should.equal(u.adIdFromReferral({ source_type: 'post', source_id: '999' }, 'whatsapp'), undefined)
  })

  it('whatsapp: source_id with no source_type at all -> undefined', () => {
    should.equal(u.adIdFromReferral({ source_id: '999' }, 'whatsapp'), undefined)
  })

  it('whatsapp: source_type "ad" but no source_id -> undefined', () => {
    should.equal(u.adIdFromReferral({ source_type: 'ad' }, 'whatsapp'), undefined)
  })

  it('whatsapp: legacy spelling source: "ads" also gates through', () => {
    u.adIdFromReferral({ source: 'ads', source_id: '5' }, 'whatsapp').should.equal('5')
  })

  it('whatsapp: source_type/id are trimmed and case-insensitive', () => {
    u.adIdFromReferral({ source_type: ' AD ', source_id: ' 7 ' }, 'whatsapp').should.equal('7')
  })

  it('whatsapp: whitespace-only source_id is the same as absent -> undefined', () => {
    should.equal(u.adIdFromReferral({ source_type: 'ad', source_id: '   ' }, 'whatsapp'), undefined)
  })

  it('normalizes a numeric id to its string form', () => {
    // A literal that large (Meta's real ad ids run 15-18 digits) exceeds
    // Number.MAX_SAFE_INTEGER and would round on its way into this test file,
    // which would test JS float precision rather than _id()'s String(v).trim()
    // behavior. Use a value safely inside the exact-integer range instead.
    u.adIdFromReferral({ source_type: 'ad', source_id: 120254866 }, 'whatsapp')
      .should.equal('120254866')
  })

  // Cross-platform guard: a whatsapp referral shaped like a Messenger one
  // (carrying `ad_id` instead of `source_id`/`source_type`) must not resolve
  // anything -- the whatsapp branch only ever reads source_id, gated by
  // source_type/source.
  it('whatsapp: messenger-shaped referral (ad_id field) resolves nothing', () => {
    should.equal(u.adIdFromReferral({ ad_id: '123' }, 'whatsapp'), undefined)
  })
})

describe('hash', () => {
    xit('hashing multiple times does reasonable things', () => {
    const res = [] 
    
    for (let i = 100000; i < 999000; i++) {
      const s = i + ''
      const first = u.hash(s)
      const second = u.hash(first)
      const third = u.hash(second)
      res.push([first % 3, second % 3, third % 3])
    }

    // All versions should be spread equally
    // amongst buckets
    [0,1,2].forEach(i => {
      const count = res.reduce((a, b) => {
        const key = b[i] + ''
        return {...a, [key]: a[key] + 1}
      }, {'0': 0, '1': 0, '2': 0})

      const firstTrue = Math.round(count['0'] / 10000) === Math.round(count['1'] / 10000)
      const secondTrue = Math.round(count['1'] / 10000) === Math.round(count['2'] / 10000)

      firstTrue.should.be.true
      secondTrue.should.be.true
    })
    
    // Chance of all three being the same should be 1/9
    // 1/3 * 1/3 * 1/3 * 3
    const eq = res.reduce((a, b) => {
      const r = (b[2] === b[1]) && (b[2] === b[0]) + ''
      return {...a, [r]: a[r] + 1}
    }, {true: 0, false: 0}) 

    const frac = Math.round((eq['true'] / (eq['true'] + eq['false'])) * 100)

    frac.should.equal(11)
  })
})

