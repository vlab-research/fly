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

// ---------------------------------------------------------------------------
// The three-case contract. statestore.test.js pins what the STORE does with each
// shape; these pin that the extractor can actually PRODUCE all three. Without the
// middle case, a strict `if (!platform || !account) return null` gate passes the
// unit suite while silently degrading every partial event to an unscoped replay.
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


// ---------------------------------------------------------------------------
// The encoded recruitment ref: `r.<base64url>`
//
// An optional second ref format. The legacy dotted form is untouched, and these
// tests assert that too -- every existing Messenger study depends on it.
//
// The property that matters most is that a ref which will not decode THROWS
// rather than resolving nothing. Resolving nothing means md.form falls through
// to FALLBACK_FORM, a real survey where the misrouted respondent looks like a
// completion; a throw becomes a tagged ERROR state that is counted and
// alertable. This format is the ONLY carrier of the shortcode, so "cannot
// decode" and "do not know the survey" are the same statement.
// ---------------------------------------------------------------------------

// Build a payload the way vlab must: version | len | shortcode | token.
// Written out longhand rather than by inverting the decoder, so these tests pin
// the WIRE FORMAT and not merely a round trip against ourselves.
function encodeRef(shortcode, tokenHex, version = 1) {
  const sc = Buffer.from(shortcode, 'utf8')
  const token = Buffer.from(tokenHex, 'hex')
  return Buffer.concat([Buffer.from([version, sc.length]), sc, token]).toString('base64url')
}

describe('decodeRecruitmentRef', () => {
  it('recovers the shortcode and the token', () => {
    u.decodeRecruitmentRef(encodeRef('mnchweek', 'a7f3c20b1e'))
      .should.deep.equal({ form: 'mnchweek', token: 'a7f3c20b1e' })
  })

  it('stays inside the alphabet both entry gates accept', () => {
    // base64url is [A-Za-z0-9_-] and contains no `.`, which is what lets an
    // encoded ref pass the WhatsApp gate and never collide with the dotted
    // key/value grammar.
    for (const sc of ['mnchweek', 'ecdenglishincentive', 'a', 'MNCH-week_2']) {
      const encoded = encodeRef(sc, 'ffeeddccbb')
      encoded.should.match(/^[A-Za-z0-9_-]+$/)
      u.decodeRecruitmentRef(encoded).form.should.equal(sc)
    }
  })

  it('handles a multi-byte shortcode, since the length is in BYTES not chars', () => {
    u.decodeRecruitmentRef(encodeRef('café', '0102030405')).form.should.equal('café')
  })

  it('throws on anything outside the base64url alphabet', () => {
    for (const bad of ['not base64!', 'has.dot', 'plus+slash/', '']) {
      ;(() => u.decodeRecruitmentRef(bad)).should.throw(/base64url/)
    }
  })

  it('throws on a non-string', () => {
    for (const bad of [undefined, null, 42, {}, []]) {
      ;(() => u.decodeRecruitmentRef(bad)).should.throw(/base64url/)
    }
  })

  it('throws on a lenient-decoder near-miss rather than silently truncating', () => {
    // THE reason the round-trip check exists. Node's base64 decoder skips
    // characters it cannot use instead of failing, so a string of impossible
    // length decodes to a SHORT buffer and would otherwise read as a valid but
    // different payload.
    ;(() => u.decodeRecruitmentRef(encodeRef('mnchweek', 'a7f3c20b1e') + 'A'))
      .should.throw(/canonical/)
  })

  it('throws on an unknown version instead of guessing the layout', () => {
    ;(() => u.decodeRecruitmentRef(encodeRef('mnchweek', 'a7f3c20b1e', 2)))
      .should.throw(/version/)
  })

  it('throws when the declared shortcode length overruns the payload', () => {
    const sc = Buffer.from('mnchweek', 'utf8')
    const encoded = Buffer.concat([
      Buffer.from([1, 200]), sc, Buffer.from('a7f3c20b1e', 'hex')
    ]).toString('base64url')
    ;(() => u.decodeRecruitmentRef(encoded)).should.throw(/length/)
  })

  it('throws when there is no token after the shortcode', () => {
    // A shortcode with no token is unattributable; accepting it silently would
    // produce conversations that route fine and attribute to nobody.
    const sc = Buffer.from('mnchweek', 'utf8')
    const encoded = Buffer.concat([Buffer.from([1, sc.length]), sc]).toString('base64url')
    ;(() => u.decodeRecruitmentRef(encoded)).should.throw(/length/)
  })

  it('throws on a zero-length shortcode', () => {
    const encoded = Buffer.concat([
      Buffer.from([1, 0]), Buffer.from('a7f3c20b1e', 'hex')
    ]).toString('base64url')
    ;(() => u.decodeRecruitmentRef(encoded)).should.throw(/length/)
  })

  it('carries the REF_DECODE tag so it does not page the platform on-call', () => {
    // transition.js reads `e.tag || 'STATE_ACTIONS'`, and STATE_ACTIONS is in
    // every consumer's platform allow-list. An untagged throw here would page
    // the platform on-call for a study's broken ad.
    try {
      u.decodeRecruitmentRef('not base64!')
      throw new Error('expected a throw')
    } catch (e) {
      e.tag.should.equal('REF_DECODE')
    }
  })
})

describe('getMetadata with an encoded ref', () => {
  let prevFallback

  before(() => {
    prevFallback = process.env.FALLBACK_FORM
    process.env.FALLBACK_FORM = 'fallback'
  })
  after(() => {
    process.env.FALLBACK_FORM = prevFallback
  })

  const event = (ref) => ({
    event_type: 'conversation_started',
    timestamp: 1600000000000,
    user_id: 'user-1',
    source: { type: 'whatsapp', account_id: 'page-1' },
    payload: { referral: { ref } }
  })

  it('resolves the shortcode out of the encoded ref', () => {
    const md = u.getMetadata(event(`r.${encodeRef('mnchweek', 'a7f3c20b1e')}`))
    md.form.should.equal('mnchweek')
    md.vt.should.equal('a7f3c20b1e')
  })

  it('consumes `r` rather than leaving a half-parsed ref in the metadata', () => {
    const md = u.getMetadata(event(`r.${encodeRef('mnchweek', 'a7f3c20b1e')}`))
    should.not.exist(md.r)
  })

  it('THROWS on a malformed encoded ref instead of falling back', () => {
    // The whole point. getMetadata's existing try/catch swallows a bad dotted
    // token so one broken metadata value cannot cost a user their survey. That
    // reasoning inverts here: the encoded ref is the only carrier of the
    // shortcode, so swallowing would route the respondent into FALLBACK_FORM.
    // Asserted on the TAG, not the message: which validation trips first is an
    // implementation detail, but the tag is the contract — it is what routes the
    // failure to a study ticket instead of the platform on-call.
    for (const bad of ['r.not-canonical-A', 'r.AAAA', 'r.' + 'A'.repeat(40)]) {
      let thrown = null
      try {
        u.getMetadata(event(bad))
      } catch (e) {
        thrown = e
      }
      should.exist(thrown, `expected ${bad} to throw`)
      thrown.tag.should.equal('REF_DECODE')
    }
  })

  it('leaves the legacy dotted ref completely untouched', () => {
    const md = u.getMetadata(event('creative.Smiling.gender.women.form.mnchweek'))
    md.form.should.equal('mnchweek')
    md.creative.should.equal('Smiling')
    md.gender.should.equal('women')
    should.not.exist(md.vt)
  })

  it('still swallows a malformed LEGACY ref, as before', () => {
    // Unchanged behaviour, asserted so the new throw cannot leak into the old
    // path: a legacy ref carries `form` in the clear, so a bad metadata token
    // must not cost the respondent their survey.
    const md = u.getMetadata(event('form.mnchweek.city.%FF'))
    md.form.should.equal('mnchweek')
  })

  it('owns `vt`: a dotted ref cannot inject a join key', () => {
    // The defence-in-depth the `delete md.vt` exists for. A dotted ref like
    // `creative.foo.vt.bar` parses via _group into md.vt = "bar", and since
    // there is no md.r the decode branch would not fire to overwrite it. Without
    // the delete, that author-set "bar" becomes vlab's attribution join key --
    // a silent mis-join onto any row whose token is "bar". The delete makes vt
    // fly-owned, same as ad_id: only the decode branch can set it.
    //
    // This test is the one that fails if anyone removes the `delete md.vt`.
    const md = u.getMetadata(event('creative.Smiling.vt.injected.gender.women.form.mnchweek'))
    should.not.exist(md.vt)
    md.form.should.equal('mnchweek')
    md.creative.should.equal('Smiling')
    md.gender.should.equal('women')
  })
})
