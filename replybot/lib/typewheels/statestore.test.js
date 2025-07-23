const { expect } = require('chai')
const sinon = require('sinon')
const { StateStore, _resolve } = require('./statestore')

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
    it('should create correct key format', () => {
      const key = stateStore._makeKey('user123')
      expect(key).to.equal('state:user123')
    })
  })

  describe('getState', () => {
    it('should return cached state if available', async () => {
      const cachedState = { state: 'RESPONDING', question: 'test' }
      mockRedis.get.resolves(JSON.stringify(cachedState))

      const result = await stateStore.getState('user123', 'event')

      expect(result).to.deep.equal(cachedState)
      expect(mockRedis.get.calledWith('state:user123')).to.be.true
    })

    it('should calculate state from events if not cached', async () => {
      mockRedis.get.resolves(null)
      mockDb.get.resolves(['event1', 'event2'])

      const result = await stateStore.getState('user123', 'event3')

      // Check that db.get was called with the correct arguments
      expect(mockDb.get.called).to.be.true
      expect(mockDb.get.firstCall.args[0]).to.equal('user123')
      expect(result).to.exist
    })
  })

  describe('updateState', () => {
    it('should store state in Redis with TTL', async () => {
      const state = { state: 'RESPONDING', question: 'test' }
      mockRedis.setex.resolves('OK')

      await stateStore.updateState('user123', state)

      expect(mockRedis.setex.calledWith(
        'state:user123',
        stateStore.ttl,
        JSON.stringify(state)
      )).to.be.true
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