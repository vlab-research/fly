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

