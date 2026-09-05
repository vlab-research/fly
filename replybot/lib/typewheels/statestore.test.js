const { expect } = require('chai')
const sinon = require('sinon')
const { StateStore, _resolve, isCapped, cappedState, HISTORY_LIMIT_TAG } = require('./statestore')

// Conversation-keyed state cache.
//
// A conversation is (platform, account_id, user_id). Keying by the participant
// alone is the bug these tests exist to prevent: two of a researcher's accounts
// messaged by one participant would share a single state blob.
//
// Every assertion routes through expectedKey(), so changing the key shape is a
// one-line change here rather than a sweep through the file.
const KEY_INCLUDES_PLATFORM = true

const expectedKey = (platform, account, user) =>
  KEY_INCLUDES_PLATFORM
    ? `state:${platform}:${account}:${user}`
    : `state:${account}:${user}`

// The conversation handle the processor computes from the event envelope and
// hands to the store.
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

    // Account ids are globally unique across platforms today, so this cannot arise
    // yet. It becomes real if a facebook_page credential also serves Instagram --
    // one account id carrying both platforms. The only assertion that depends on
    // the platform actually being in the key.
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

    // Asserts the object `get({ userid, account }, limit)` receives, not merely
    // that it was called -- asserting the call alone would pass against a
    // completely unscoped replay.
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
  // The missing-tuple contract.
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

    // This tag is the only instrument for the rollout canary: missing and it reads
    // zero for the wrong reason, noisy and it is unreadable. Once per event.
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

  // -------------------------------------------------------------------------
  // The history cap.
  //
  // A block no longer sets a pointer, so a blocked user's refold reads their
  // whole (short) log. What the pointer was standing in for -- an unbounded log
  // -- gets its own honest mechanism: with STATE_STORE_LIMIT=N we ask chatbase
  // for N + 1 rows, and if all N + 1 come back we do not fold. We return a
  // USER_BLOCKED state tagged HISTORY_LIMIT, log one greppable line, and let the
  // processor cache it like any other state, so the oversized read happens once
  // per Redis miss rather than once per event. A human restores or resets the
  // conversation, which sets a pointer and cuts the history off.
  // -------------------------------------------------------------------------
  describe('history cap (HISTORY_LIMIT)', () => {
    const N = 3
    const rows = n => Array.from({ length: n }, (_, i) => `event${i + 1}`)
    const current = JSON.stringify({
      event_id: 'evt_current', user_id: 'user123', timestamp: 4242,
      source: { type: 'messenger' }, event_type: 'text', payload: { text: 'hi' }
    })

    const taggedLines = spies => []
      .concat(...spies.map(sp => sp.getCalls()))
      .map(c => c.args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      .filter(l => l.includes(HISTORY_LIMIT_TAG))

    let prevLimit
    beforeEach(() => {
      prevLimit = process.env.STATE_STORE_LIMIT
      process.env.STATE_STORE_LIMIT = String(N)
      mockRedis.get.resolves(null)
    })
    afterEach(() => {
      if (prevLimit === undefined) delete process.env.STATE_STORE_LIMIT
      else process.env.STATE_STORE_LIMIT = prevLimit
    })

    it('asks chatbase for N + 1 rows', async () => {
      mockDb.get.resolves(rows(1))
      await stateStore.getState(conv('messenger', PAGE_A), 'user123', current)
      expect(mockDb.get.firstCall.args[1]).to.equal(N + 1)
    })

    it('exactly N archived events folds normally', async () => {
      mockDb.get.resolves(rows(N))
      const state = await stateStore.getState(conv('messenger', PAGE_A), 'user123', current)
      expect(state.state).to.equal('START')
      expect(state.error).to.be.undefined
    })

    it('N + 1 archived events => capped USER_BLOCKED state tagged HISTORY_LIMIT, no md, one log line', async () => {
      const warn = sinon.spy(console, 'warn')
      const error = sinon.spy(console, 'error')
      const log = sinon.spy(console, 'log')
      mockDb.get.resolves(rows(N + 1))

      const state = await stateStore.getState(conv('messenger', PAGE_A), 'user123', current)

      expect(state.state).to.equal('USER_BLOCKED')
      expect(state.qa).to.eql([])
      expect(state.forms).to.eql([])
      expect(state.md).to.be.undefined
      expect(state.error).to.eql({ tag: HISTORY_LIMIT_TAG, message: `history exceeds ${N} events`, ts: 4242 })

      const lines = taggedLines([warn, error, log])
      expect(lines.length, `expected exactly one ${HISTORY_LIMIT_TAG} line, got ${lines.length}`).to.equal(1)
      expect(lines[0]).to.include('user123')
      expect(lines[0]).to.include(PAGE_A)
      expect(lines[0]).to.include(`"limit":${N}`)
    })

    // The cap counts the RAW rows, before _resolve appends the current event.
    // Whether the current event is archived yet moves the boundary by one; it
    // must not make N archived rows + the current event count as N + 1.
    it('counts archived rows only, not the current event', async () => {
      mockDb.get.resolves(rows(N))
      const state = await stateStore.getState(conv('messenger', PAGE_A), 'user123', 'eventNotInArchive')
      expect(state.state).to.equal('START')
    })

    it('the account-present, platform-absent degraded path is capped too', async () => {
      mockDb.get.resolves(rows(N + 1))
      const state = await stateStore.getState(conv(undefined, PAGE_A), 'user123', current)
      expect(state.state).to.equal('USER_BLOCKED')
      expect(state.error.tag).to.equal(HISTORY_LIMIT_TAG)
    })

    // The unscoped path reads across every account the participant ever
    // messaged, so its row count is not this conversation's history. It keeps
    // today's behaviour: fold the oldest N rows, uncapped.
    it('an unscoped replay (account null) is never capped', async () => {
      const warn = sinon.spy(console, 'warn')
      mockDb.get.resolves(rows(N + 1))
      const state = await stateStore.getState(null, 'user123', current)
      expect(state.state).to.equal('START')
      expect(state.error).to.be.undefined
      expect(taggedLines([warn])).to.have.length(0)
    })

    it('STATE_STORE_LIMIT unset => falsy limit passed to chatbase, never capped', async () => {
      delete process.env.STATE_STORE_LIMIT
      mockDb.get.resolves(rows(50))
      const state = await stateStore.getState(conv('messenger', PAGE_A), 'user123', current)
      expect(mockDb.get.firstCall.args[1]).to.not.be.ok
      expect(state.state).to.equal('START')
      expect(state.error).to.be.undefined
    })

    // The whole point of returning a state rather than throwing: it is cached, so
    // the N + 1 read happens once per Redis miss, not once per event.
    it('the capped state round-trips through updateState and is served from Redis without touching the db', async () => {
      mockDb.get.resolves(rows(N + 1))
      mockRedis.setex.resolves('OK')
      const c = conv('messenger', PAGE_A)

      const capped = await stateStore.getState(c, 'user123', current)
      await stateStore.updateState(c, 'user123', capped)

      const written = mockRedis.setex.firstCall.args[2]
      mockRedis.get.reset()
      mockRedis.get.resolves(written)
      mockDb.get.reset()

      const again = await stateStore.getState(c, 'user123', current)
      expect(again).to.deep.equal(capped)
      expect(mockDb.get.called).to.be.false
    })
  })

  describe('close', () => {
    it('should disconnect Redis client', async () => {
      await stateStore.close()
      expect(mockRedis.disconnect.called).to.be.true
    })
  })
})

describe('isCapped', () => {
  it('fires only when strictly more than limit rows came back, for a scoped replay, with a limit set', () => {
    expect(isCapped(['a', 'b', 'c', 'd'], 3, PAGE_A)).to.be.true
    expect(isCapped(['a', 'b', 'c'], 3, PAGE_A)).to.be.false
    expect(isCapped(['a', 'b', 'c', 'd'], 3, null)).to.be.false
    expect(isCapped(['a', 'b', 'c', 'd'], NaN, PAGE_A)).to.be.false
    expect(isCapped(['a', 'b', 'c', 'd'], 0, PAGE_A)).to.be.false
  })
})

describe('cappedState', () => {
  it('is a USER_BLOCKED initial state carrying only the HISTORY_LIMIT error', () => {
    const state = cappedState(10000, { timestamp: 77 })
    expect(state).to.deep.equal({
      state: 'USER_BLOCKED',
      qa: [],
      forms: [],
      error: { tag: HISTORY_LIMIT_TAG, message: 'history exceeds 10000 events', ts: 77 }
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
