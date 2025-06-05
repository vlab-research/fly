const { expect } = require('chai')
const sinon = require('sinon')
const { SpineSupervisor } = require('./spine-supervisor')
const { Readable, Transform, Writable, pipeline } = require('stream')

describe('SpineSupervisor', () => {
  let mockSpine
  let mockStateStore
  let mockTokenStore
  let mockMachine
  let mockProcessor
  let mockChatbase
  let clock
  let mockBotSpineCtor

  function createMockStreams() {
    const src = new Readable({ read() {} })
    const trans = new Transform({
      transform(chunk, encoding, callback) {
        callback(null, chunk)
      }
    })
    const sink = new Writable({
      write(chunk, encoding, callback) {
        callback()
      }
    })
    return { src, trans, sink }
  }

  beforeEach(() => {
    // Mock BotSpine with real streams
    mockSpine = {
      source: sinon.stub(),
      transform: sinon.stub(),
      sink: sinon.stub(),
      safeShutdown: sinon.stub()
    }

    // Mock stores and machine
    mockStateStore = { getState: sinon.stub(), updateState: sinon.stub() }
    mockTokenStore = { pool: {} }
    mockMachine = { run: sinon.stub() }

    // Mock processor function
    mockProcessor = sinon.stub().returns(sinon.stub())

    // Mock chatbase
    mockChatbase = {
      pool: {}
    }

    // Mock BotSpine constructor
    mockBotSpineCtor = sinon.stub().returns(mockSpine)

    // Mock process.env
    process.env.CHATBASE_BACKEND = './mock-chatbase'
    process.env.REPLYBOT_STATESTORE_TTL = '24h'
    process.env.REPLYBOT_MACHINE_TTL = '60m'

    // Ensure the mock module is in the require cache
    require.cache[require.resolve('./mock-chatbase')] = {
      exports: require('./mock-chatbase')
    }

    // Setup fake timer
    clock = sinon.useFakeTimers()
  })

  afterEach(() => {
    clock.restore()
    delete process.env.CHATBASE_BACKEND
    delete process.env.REPLYBOT_STATESTORE_TTL
    delete process.env.REPLYBOT_MACHINE_TTL
    delete require.cache[require.resolve('./mock-chatbase')]
    sinon.restore()
  })

  describe('constructor', () => {
    it('should throw error for invalid numSpines', () => {
      expect(() => new SpineSupervisor(0, 5, 5 * 60 * 1000, mockChatbase, mockBotSpineCtor)).to.throw('numSpines must be a positive integer')
      expect(() => new SpineSupervisor(-1, 5, 5 * 60 * 1000, mockChatbase, mockBotSpineCtor)).to.throw('numSpines must be a positive integer')
      expect(() => new SpineSupervisor('2', 5, 5 * 60 * 1000, mockChatbase, mockBotSpineCtor)).to.throw('numSpines must be a positive integer')
    })

    it('should initialize with valid numSpines', () => {
      const supervisor = new SpineSupervisor(2, 5, 5 * 60 * 1000, mockChatbase, mockBotSpineCtor)
      expect(supervisor.numSpines).to.equal(2)
      expect(supervisor.maxRestarts).to.equal(5)
      expect(supervisor.timeWindow).to.equal(5 * 60 * 1000)
    })

    it('should use provided BotSpineCtor', () => {
      const supervisor = new SpineSupervisor(1, 5, 5 * 60 * 1000, mockChatbase, mockBotSpineCtor)
      expect(supervisor.BotSpineCtor).to.equal(mockBotSpineCtor)
    })
  })

  describe('recordRestart', () => {
    it('should record restarts within time window', () => {
      const supervisor = new SpineSupervisor(1, 5, 5 * 60 * 1000, mockChatbase, mockBotSpineCtor)
      supervisor.recordRestart()
      expect(supervisor.restarts.length).to.equal(1)
    })

    it('should remove old restarts outside time window', () => {
      const supervisor = new SpineSupervisor(1, 5, 5 * 60 * 1000, mockChatbase, mockBotSpineCtor)
      supervisor.recordRestart()
      clock.tick(6 * 60 * 1000) // Move time forward 6 minutes
      supervisor.recordRestart()
      expect(supervisor.restarts.length).to.equal(1)
    })

    it('should throw error when max restarts exceeded', () => {
      const supervisor = new SpineSupervisor(1, 2, 5 * 60 * 1000, mockChatbase, mockBotSpineCtor) // max 2 restarts
      supervisor.recordRestart()
      supervisor.recordRestart()
      expect(() => supervisor.recordRestart()).to.throw('Supervisor: Too many restarts')
    })
  })

  describe('setupPipeline', () => {
    it('should setup pipeline with error handling', (done) => {
      clock.restore(); // Use real timers for this test
      const supervisor = new SpineSupervisor(1, 5, 5 * 60 * 1000, mockChatbase, mockBotSpineCtor)
      const { src, trans, sink } = createMockStreams()
      mockSpine.source.returns(src)
      mockSpine.transform.returns(trans)
      mockSpine.sink.returns(sink)

      supervisor.setupPipeline(mockSpine, 0, mockProcessor)

      // Simulate error on the pipeline
      setImmediate(() => {
        src.emit('error', new Error('test error'))
        setTimeout(() => {
          expect(mockSpine.safeShutdown.called).to.be.true
          expect(supervisor.restarts.length).to.equal(1)
          done()
        }, 10)
      })
    })
  })

  describe('start', () => {
    it('should create and setup correct number of spines with replybot name', () => {
      const supervisor = new SpineSupervisor(3, 5, 5 * 60 * 1000, mockChatbase, mockBotSpineCtor)
      // Use real streams for each spine
      for (let i = 0; i < 3; i++) {
        const { src, trans, sink } = createMockStreams()
        mockBotSpineCtor.onCall(i).returns({
          source: sinon.stub().returns(src),
          transform: sinon.stub().returns(trans),
          sink: sinon.stub().returns(sink),
          safeShutdown: sinon.stub()
        })
      }
      supervisor.start(mockProcessor)
      expect(mockBotSpineCtor.callCount).to.equal(3)
      expect(mockBotSpineCtor.firstCall.args[0]).to.equal('replybot')
    })

    it('should throw error if spine creation fails', () => {
      const supervisor = new SpineSupervisor(1, 5, 5 * 60 * 1000, mockChatbase, mockBotSpineCtor)
      mockBotSpineCtor.throws(new Error('spine creation failed'))

      expect(() => supervisor.start(mockProcessor)).to.throw('spine creation failed')
    })
  })
}) 