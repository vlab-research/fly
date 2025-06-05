const { pipeline } = require('stream')
const { Machine } = require('../typewheels/transition')
const { StateStore } = require('../typewheels/statestore')
const { TokenStore } = require('../typewheels/tokenstore')

class SpineSupervisor {
  constructor(numSpines, maxRestarts = 5, timeWindow = 5 * 60 * 1000, chatbase = null, BotSpineCtor = null) {
    if (!Number.isInteger(numSpines) || numSpines < 1) {
      throw new Error('numSpines must be a positive integer')
    }
    this.numSpines = numSpines
    this.maxRestarts = maxRestarts
    this.timeWindow = timeWindow
    this.restarts = []
    this.chatbase = chatbase || new (require(process.env.CHATBASE_BACKEND))()
    this.BotSpineCtor = BotSpineCtor || require('@vlab-research/botspine').BotSpine
  }

  recordRestart() {
    const now = Date.now()
    this.restarts.push(now)
    
    // Remove restarts outside the time window
    this.restarts = this.restarts.filter(time => now - time < this.timeWindow)
    
    // Check if we've exceeded the restart threshold
    if (this.restarts.length > this.maxRestarts) {
      const error = new Error(`Supervisor: Too many restarts (${this.restarts.length}) in ${this.timeWindow/1000}s window`)
      error.name = 'SupervisorError'
      throw error
    }
  }

  setupPipeline(spine, spineIndex, processor) {
    const stateStore = new StateStore(this.chatbase, process.env.REPLYBOT_STATESTORE_TTL || '24h')
    const tokenStore = new TokenStore(this.chatbase.pool)
    const machine = new Machine(process.env.REPLYBOT_MACHINE_TTL || '60m', tokenStore)

    const handleSpineError = (err) => {
      console.error(`Spine ${spineIndex} error:`, err)
      // Use safeShutdown to gracefully stop this spine
      spine.safeShutdown()
      // Record the restart with the supervisor
      this.recordRestart()
      // Schedule a restart after a delay
      setTimeout(() => {
        this.setupPipeline(spine, spineIndex, processor)
      }, 20000) // 20 second delay before restart
    }

    pipeline(
      spine.source(),
      spine.transform(processor(machine, stateStore)),
      spine.sink(),
      handleSpineError
    )
  }

  start(processor) {
    for (let i = 0; i < this.numSpines; i++) {
      const spine = new this.BotSpineCtor('replybot')
      this.setupPipeline(spine, i, processor)
    }
  }
}

module.exports = { SpineSupervisor } 