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

// ---------------------------------------------------------------------------
// The three-case contract (§7.1). statestore.test.js B10-9a/b/c pins what the
// STORE does with each of the three shapes; these pin that the extractor can
// actually PRODUCE all three. Without the middle case here, B10-9b was testing
// a shape no real event could reach it in -- which is how the strict
// `if (!platform || !account) return null` gate shipped with a green unit
// suite and was caught only by an integration run (B10-8).
// ---------------------------------------------------------------------------
describe('conversationFromRawEvent', () => {
  const { expect } = require('chai')
  const conv = raw => u.conversationFromRawEvent(raw)

  it('platform + account => the full conversation', () => {
    expect(conv({ platform: 'whatsapp', account_id: '106540352242922' }))
      .to.eql({ platform: 'whatsapp', account: '106540352242922' })
  })

  it('reads a JSON string exactly as it reads an object', () => {
    expect(conv(JSON.stringify({ platform: 'messenger', account_id: '935593143497601' })))
      .to.eql({ platform: 'messenger', account: '935593143497601' })
  })

  it('account, NO platform => the account SURVIVES (replay stays account-scoped)', () => {
    // The regression this test exists for. Returning null here throws away an
    // account the event carried and silently degrades the replay to every
    // account this participant has -- oldest-first, so it can truncate before
    // it ever reaches this conversation. See the contract table in utils.js.
    expect(conv({ account_id: '935593143497601' }))
      .to.eql({ platform: null, account: '935593143497601' })
  })

  it('platform, NO account => the platform survives, the account is null', () => {
    // Both gates downstream already fail on a null account; keeping the
    // platform is what lets CONVERSATION_TUPLE_MISSING name the missing half.
    expect(conv({ platform: 'whatsapp' }))
      .to.eql({ platform: 'whatsapp', account: null })
  })

  it('neither component => null', () => {
    expect(conv({})).to.equal(null)
    expect(conv({ source: 'whatsapp', from: '1541347160' })).to.equal(null)
  })

  it('an empty string is not a name', () => {
    // hermes stamps a field only when it derives to a non-empty string; an
    // empty one would be a poisoned cache key rather than a name.
    expect(conv({ platform: '', account_id: '' })).to.equal(null)
    expect(conv({ platform: '', account_id: '935593143497601' }))
      .to.eql({ platform: null, account: '935593143497601' })
  })

  it('a non-string component is not a name', () => {
    expect(conv({ platform: 12, account_id: '935593143497601' }))
      .to.eql({ platform: null, account: '935593143497601' })
    expect(conv({ platform: 'whatsapp', account_id: { id: 'x' } }))
      .to.eql({ platform: 'whatsapp', account: null })
  })

  it('is TOTAL -- never throws, for any input', () => {
    const junk = [
      undefined, null, '', 'not json', '{', '[]', '"a string"', '42',
      0, 42, true, false, [], [1, 2], () => { }, Symbol('s'), Buffer.from('{}')
    ]
    junk.forEach(x => {
      expect(() => u.conversationFromRawEvent(x)).to.not.throw()
    })
  })

  it('takes NO fallback to md, to source, or to per-shape fields', () => {
    // A fallback would silently paper over a producer that stopped stamping the
    // envelope -- precisely the failure the conversation key exists to make
    // impossible.
    expect(conv({
      source: 'whatsapp',
      phone_number_id: '106540352242922',
      recipient: { id: '935593143497601' },
      page: '935593143497601',
      md: { pageid: '935593143497601', platform: 'messenger' }
    })).to.equal(null)
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

