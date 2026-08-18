const { expect } = require('chai')
const sinon = require('sinon')
const { StateStore, _resolve } = require('./statestore')

// ---------------------------------------------------------------------------
// B10 -- conversation-keyed state cache.
//
// RED UNTIL §7.1 LANDS. Every assertion in the `_makeKey`, `getState`,
// `updateState` and `missing tuple` blocks below describes the POST-FIX
// contract. Against current code they fail, because `_makeKey(user)`
// (statestore.js:64-66) takes a single argument and returns `state:${user}` --
// keying a conversation by the participant alone. That is the bug: a
// conversation is (platform, account_id, user_id), and two of a researcher's
// accounts messaged by one participant currently share one state blob.
//
// Observed failure mode before the fix (recorded per §C.3 of
// planning/conversation-identity-test-plan.md): `_makeKey('whatsapp', acct,
// user)` ignores arguments 2 and 3 and returns `state:whatsapp`, so BOTH
// accounts resolve to the same key and the "distinct keys" assertions fail on
// equality rather than on shape.
//
// THE KEY SHAPE IS NOT YET SETTLED -- see the test plan §0.9-2. If account ids
// are globally unique (which the ratified (allocator, id) model asserts, and
// which `unique_messaging_account` enforces in production today) then
// `state:{account}:{user}` is sufficient and §7.3 stops being a hard
// prerequisite for §7.1. Every assertion below routes through expectedKey(),
// so a decision either way is a one-line change here and not a sweep through
// the file.
// ---------------------------------------------------------------------------

const KEY_INCLUDES_PLATFORM = true

const expectedKey = (platform, account, user) =>
  KEY_INCLUDES_PLATFORM
    ? `state:${platform}:${account}:${user}`
    : `state:${account}:${user}`

// The conversation handle the processor computes from the event envelope
// (§7.1's `conversationFromRawEvent`) and hands to the store.
const conv = (platform, account) => ({ platform, account })

const PAGE_A = '935593143497601'
const PAGE_B = '811223344556677'
const WA_A = '106540352242922'

describe('StateStore', () => {
  let mockDb
  let mockRedis
  let stateStore

  beforeEach(() => {
    // Mock database
    mockDb = {
      get: sinon.stub()
    }

    // Mock Redis client
    mockRedis = {
      get: sinon.stub(),
      setex: sinon.stub(),
      disconnect: sinon.stub()
    }

    // Create StateStore with mocked Redis
    stateStore = new StateStore(mockDb, '1h', mockRedis)
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('constructor', () => {
    it('should throw error if no db is provided', () => {
      expect(() => new StateStore()).to.throw('StateStore must be given a db')
    })

    it('should accept mock Redis client for testing', () => {
      const newStateStore = new StateStore(mockDb, '1h', mockRedis)
      expect(newStateStore.redis).to.equal(mockRedis)
    })
  })

  describe('_parseTTL', () => {
    it('should parse TTL string to seconds', () => {
      const stateStore = new StateStore(mockDb, '1h', mockRedis)
      expect(stateStore.ttl).to.be.a('number')
      expect(stateStore.ttl).to.be.greaterThan(0)
    })

    it('should throw error for invalid TTL format', () => {
      expect(() => new StateStore(mockDb, 'invalid', mockRedis)).to.throw('Invalid TTL format: "invalid"')
    })

    it('should support 0 TTL with warning', () => {
      const consoleSpy = sinon.spy(console, 'warn')
      const stateStore = new StateStore(mockDb, '0s', mockRedis)
      expect(stateStore.ttl).to.equal(0)
      expect(consoleSpy.calledWith('Warning: TTL "0s" results in 0 seconds expiration. State will not expire.')).to.be.true
      consoleSpy.restore()
    })
  })

  describe('_makeKey', () => {
    // B10-1. Replaces the old `state:user123` assertion.
    it('B10-1: keys on the full conversation tuple, not the user alone', () => {
      const key = stateStore._makeKey('whatsapp', WA_A, 'user123')
      expect(key).to.equal(expectedKey('whatsapp', WA_A, 'user123'))
      expect(key).to.not.equal('state:user123')
    })

    // B10-2. THE regression test for the whole bug, at the unit level.
    // B2-1 in test.tc.ts is its end-to-end counterpart; keep both -- this one
    // localises the failure, that one proves it against the real stack.
    it('B10-2: two accounts, same platform, same user => two distinct keys', () => {
      const a = stateStore._makeKey('messenger', PAGE_A, 'user123')
      const b = stateStore._makeKey('messenger', PAGE_B, 'user123')
      expect(a).to.not.equal(b)
      expect(a).to.equal(expectedKey('messenger', PAGE_A, 'user123'))
      expect(b).to.equal(expectedKey('messenger', PAGE_B, 'user123'))
    })

    // B10-3. DEFENSIVE. Under the ratified (allocator, id) account-identity
    // model (documentation/platform-abstraction.md:246-261) account ids are
    // globally unique across platforms, so this case should be unreachable in
    // the real system. It is asserted anyway because it is free, and because
    // §5.2's proposed PRIMARY KEY (platform, account_id) would admit it.
    // If KEY_INCLUDES_PLATFORM is turned off, this test is expected to be
    // removed along with it -- it is the only assertion that depends on the
    // platform component actually being in the key.
    it('B10-3: same account id on two platforms => two distinct keys', function () {
      if (!KEY_INCLUDES_PLATFORM) return this.skip()
      const m = stateStore._makeKey('messenger', PAGE_A, 'user123')
      const w = stateStore._makeKey('whatsapp', PAGE_A, 'user123')
      expect(m).to.not.equal(w)
    })
  })

  describe('getState', () => {
    it('should return cached state if available', async () => {
      const cachedState = { state: 'RESPONDING', question: 'test' }
      mockRedis.get.resolves(JSON.stringify(cachedState))

      const result = await stateStore.getState(conv('messenger', PAGE_A), 'user123', 'event')

      expect(result).to.deep.equal(cachedState)
      expect(mockRedis.get.calledWith(expectedKey('messenger', PAGE_A, 'user123'))).to.be.true
    })

    // B10-9a: replay runs for the right user AND is scoped to the right account.
    //
    // This assertion used to read `.to.equal('user123')`, pinning the pre-§7.5
    // POSITIONAL call shape `get(userid, limit)`. §7.5 moved it to
    // `get({ userid, account }, limit)`. The test's intent -- "the replay ran for
    // the right user" -- never changed; only the mechanism did. The object form is
    // strictly stronger, because it also pins the account scoping that §7.5 exists
    // to provide.
    it('should calculate state from events if not cached, scoped to the account', async () => {
      mockRedis.get.resolves(null)
      mockDb.get.resolves(['event1', 'event2'])

      const result = await stateStore.getState(conv('messenger', PAGE_A), 'user123', 'event3')

      expect(mockDb.get.called).to.be.true
      expect(mockDb.get.firstCall.args[0]).to.deep.equal({ userid: 'user123', account: PAGE_A })
      expect(result).to.exist
    })

    // ----------------------------------------------------------------------
    // THE REPLAY-SCOPING CONTRACT, all three rows.
    //
    // Until these existed, the assertion above was the ONLY unit-level check of
    // replay scoping anywhere -- and B10-4/B10-5 below assert `mockDb.get.called`
    // rather than its arguments, so they would pass against a COMPLETELY UNSCOPED
    // replay. The third row (account: null) had no coverage at all.
    // ----------------------------------------------------------------------

    it('B10-9b: account present, PLATFORM ABSENT => replay is still scoped to that account', async () => {
      mockRedis.get.resolves(null)
      mockDb.get.resolves(['event1', 'event2'])

      // No platform, but the event DID carry an account.
      await stateStore.getState(conv(undefined, PAGE_A), 'user123', 'event3')

      // The cache cannot be keyed without a platform -- but the REPLAY can still
      // be scoped by account, and must be. Discarding the account here would
      // silently replay every conversation this participant has, for every
      // platform-less-but-account-bearing event.
      //
      // The live gate is `(conv && conv.account) || null`. An `isNamed`-style gate
      // -- "only scope when the whole tuple is known" -- would resolve this case to
      // `account: null` and throw the account away. That alternative was considered
      // and rejected; THIS TEST is what stops someone reintroducing it as a
      // simplification.
      expect(mockDb.get.called).to.be.true
      expect(mockDb.get.firstCall.args[0]).to.deep.equal({ userid: 'user123', account: PAGE_A })
    })

    it('B10-9c: no account => { userid, account: null } passed EXPLICITLY', async () => {
      mockRedis.get.resolves(null)
      mockDb.get.resolves(['event1', 'event2'])

      await stateStore.getState(null, 'user123', 'event3')

      expect(mockDb.get.called).to.be.true
      const arg = mockDb.get.firstCall.args[0]

      // The key must be PRESENT and null, not merely absent: omitting it throws by
      // design (that throw is the guard that stops a forgotten call site degrading
      // quietly to an unscoped read). So assert presence and nullness separately --
      // `to.deep.equal({userid, account: null})` alone would not distinguish a
      // missing key from a null one in every chai version.
      expect(arg).to.have.property('account')
      expect(arg.account).to.equal(null)
      expect(arg).to.deep.equal({ userid: 'user123', account: null })
    })

    // A write under one account must be invisible to the other. This is the
    // read half of B10-2.
    it('B10-2: a cached state on account A is not served to account B', async () => {
      const stateA = { state: 'END', forms: ['isoFormA'] }
      mockRedis.get
        .withArgs(expectedKey('messenger', PAGE_A, 'user123'))
        .resolves(JSON.stringify(stateA))
      mockRedis.get
        .withArgs(expectedKey('messenger', PAGE_B, 'user123'))
        .resolves(null)
      mockDb.get.resolves(['event1', 'event2'])

      const onB = await stateStore.getState(conv('messenger', PAGE_B), 'user123', 'event3')

      expect(onB).to.not.deep.equal(stateA)
      expect(mockDb.get.called).to.be.true
    })
  })

  describe('updateState', () => {
    it('should store state in Redis with TTL', async () => {
      const state = { state: 'RESPONDING', question: 'test' }
      mockRedis.setex.resolves('OK')

      await stateStore.updateState(conv('messenger', PAGE_A), 'user123', state)

      expect(mockRedis.setex.calledWith(
        expectedKey('messenger', PAGE_A, 'user123'),
        stateStore.ttl,
        JSON.stringify(state)
      )).to.be.true
    })

    it('B10-2: writes under two accounts land on two distinct keys', async () => {
      mockRedis.setex.resolves('OK')

      await stateStore.updateState(conv('messenger', PAGE_A), 'user123', { state: 'A' })
      await stateStore.updateState(conv('messenger', PAGE_B), 'user123', { state: 'B' })

      const keys = mockRedis.setex.getCalls().map(c => c.args[0])
      expect(new Set(keys).size).to.equal(2)
      expect(keys).to.include(expectedKey('messenger', PAGE_A, 'user123'))
      expect(keys).to.include(expectedKey('messenger', PAGE_B, 'user123'))
    })
  })

  // -------------------------------------------------------------------------
  // B10-4 .. B10-7 -- the missing-tuple contract (§7.1).
  //
  // When either component is absent the store must NEITHER READ NOR WRITE the
  // cache: it computes from the event log and logs once with a greppable tag.
  // The cost is one replay, which is what a cache miss already does. The
  // alternative -- keying under a partially-known name, or falling back to
  // `md` -- is exactly how the bug got here, because `md.pageid` and
  // `md.platform` are the fields that bleed between conversations.
  // -------------------------------------------------------------------------
  describe('missing conversation tuple', () => {
    const TAG = 'CONVERSATION_TUPLE_MISSING'

    beforeEach(() => {
      mockDb.get.resolves(['event1', 'event2'])
      mockRedis.get.resolves(null)
    })

    it('B10-4: missing platform => no cache read, no cache write, state from the log', async () => {
      const result = await stateStore.getState(conv(undefined, PAGE_A), 'user123', 'event3')

      expect(mockRedis.get.called, 'redis.get must not be called').to.be.false
      expect(mockDb.get.called, 'state must be computed from the event log').to.be.true
      // ... and that replay is STILL account-scoped -- see B10-9b. Asserting only
      // `.called` here would pass against a fully unscoped replay.
      expect(mockDb.get.firstCall.args[0]).to.deep.equal({ userid: 'user123', account: PAGE_A })
      expect(result).to.exist

      await stateStore.updateState(conv(undefined, PAGE_A), 'user123', { state: 'RESPONDING' })
      expect(mockRedis.setex.called, 'redis.setex must not be called').to.be.false
    })

    it('B10-5: missing account_id => no cache read, no cache write, state from the log', async () => {
      const result = await stateStore.getState(conv('messenger', undefined), 'user123', 'event3')

      expect(mockRedis.get.called, 'redis.get must not be called').to.be.false
      expect(mockDb.get.called, 'state must be computed from the event log').to.be.true
      // With no account there is nothing to scope by, so `account` must be an
      // EXPLICIT null rather than an omitted key -- see B10-9c.
      expect(mockDb.get.firstCall.args[0]).to.deep.equal({ userid: 'user123', account: null })
      expect(result).to.exist

      await stateStore.updateState(conv('messenger', undefined), 'user123', { state: 'RESPONDING' })
      expect(mockRedis.setex.called, 'redis.setex must not be called').to.be.false
    })

    it('B10-5: a null conversation entirely => no cache read, no cache write', async () => {
      const result = await stateStore.getState(null, 'user123', 'event3')

      expect(mockRedis.get.called).to.be.false
      expect(mockDb.get.called).to.be.true
      expect(result).to.exist

      await stateStore.updateState(null, 'user123', { state: 'RESPONDING' })
      expect(mockRedis.setex.called).to.be.false
    })

    // B10-6. This tag is the ENTIRE instrument for the §7.1 pre-step canary
    // ("ship a log-only build, watch 24h, expect zero"). If it is missing the
    // canary reads zero for the wrong reason; if it is noisy the canary is
    // unreadable. Once per event, not once per retry.
    it('B10-6: logs exactly one greppable line, once', async () => {
      const warn = sinon.spy(console, 'warn')
      const error = sinon.spy(console, 'error')
      const log = sinon.spy(console, 'log')

      await stateStore.getState(conv(undefined, PAGE_A), 'user123', 'event3')

      const lines = []
        .concat(warn.getCalls(), error.getCalls(), log.getCalls())
        .map(c => c.args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
        .filter(l => l.includes(TAG))

      expect(lines.length, `expected exactly one ${TAG} line, got ${lines.length}`).to.equal(1)
    })

    // B10-7. The test that stops someone "helpfully" reintroducing a fallback.
    // A state whose md carries a perfectly usable platform and pageid must
    // still NOT be used to key the cache -- those are the bleeding fields.
    it('B10-7: does not fall back to state.md.platform / state.md.pageid', async () => {
      mockRedis.get.resolves(JSON.stringify({
        state: 'RESPONDING',
        md: { platform: 'messenger', pageid: PAGE_A }
      }))

      await stateStore.getState(null, 'user123', 'event3')

      expect(mockRedis.get.called, 'must not consult the cache to find the tuple').to.be.false
      expect(mockRedis.setex.called).to.be.false

      const keysTouched = []
        .concat(mockRedis.get.getCalls(), mockRedis.setex.getCalls())
        .map(c => c.args[0])
      expect(keysTouched).to.not.include(expectedKey('messenger', PAGE_A, 'user123'))
    })
  })

  describe('close', () => {
    it('should disconnect Redis client', async () => {
      await stateStore.close()
      expect(mockRedis.disconnect.called).to.be.true
    })
  })
})

describe('_resolve', () => {
  it('should return list if no event provided', () => {
    const list = ['event1', 'event2']
    const result = _resolve(list)
    expect(result).to.deep.equal(list)
  })

  it('should return event in array if no list provided', () => {
    const event = 'event1'
    const result = _resolve(null, event)
    expect(result).to.deep.equal([event])
  })

  it('should append event if not in list', () => {
    const list = ['event1', 'event2']
    const event = 'event3'
    const result = _resolve(list, event)
    expect(result).to.deep.equal(['event1', 'event2', 'event3'])
  })

  it('should truncate list at event if event already exists', () => {
    const list = ['event1', 'event2', 'event3', 'event4']
    const event = 'event2'
    const result = _resolve(list, event)
    expect(result).to.deep.equal(['event1', 'event2'])
  })
})
