const Redis = require('ioredis')
const parse = require('parse-duration')
const { getState } = require('./machine')
const { parseEvent } = require('@vlab-research/utils')

const STATE_STORE_LIMIT = process.env.STATE_STORE_LIMIT; // can be undefined 

function _resolve(li, e) {
  if (!e) return li
  if (!li) return [e]

  const i = li.indexOf(e)
  return i === -1 ? [...li, e] : li.slice(0, i + 1)
}

class StateStore {
  constructor(db, ttl = '24h', redisClient = null) {
    if (!db) throw new TypeError('StateStore must be given a db')

    this.db = db
    this.ttl = this._parseTTL(ttl)
    
    // Allow injection of Redis client for testing
    if (redisClient) {
      this.redis = redisClient
    } else {
      // Only create real Redis connection if no mock is provided
      this.redis = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD,
        db: process.env.REDIS_DB || 0,
        retryDelayOnFailover: 100,
        maxRetriesPerRequest: 3,
        lazyConnect: true, // Don't connect immediately
        retryDelayOnClusterDown: 300,
        enableOfflineQueue: false
      })
    }
  }

  _parseTTL(ttl) {
    // Parse the duration string
    const milliseconds = parse(ttl)
    
    // parse-duration returns null for invalid strings
    if (milliseconds === null) {
      throw new Error(`Invalid TTL format: "${ttl}". Expected format like "24h", "30m", "1d", etc.`)
    }

    // Convert to seconds for Redis
    const seconds = Math.floor(milliseconds / 1000)
    
    // Allow 0 TTL (no expiration) but warn about it
    if (seconds === 0) {
      console.warn(`Warning: TTL "${ttl}" results in 0 seconds expiration. State will not expire.`)
    }
    
    return seconds
  }

  _makeKey(user) {
    return `state:${user}`
  }

  parseEvent(event) {
    return parseEvent(event)
  }

  async _getEvents(user, event) {
    const res = await this.db.get(user, +STATE_STORE_LIMIT)
    return _resolve(res, event)
      .map(this.parseEvent)
      .slice(0, -1)
  }

  // get state UP TO BUT NOT INCLUDING this event
  async getState(user, event) {
    const key = this._makeKey(user)
    const cached = await this.redis.get(key)

    if (cached) return JSON.parse(cached)

    const events = await this._getEvents(user, event)
    return getState(events)
  }

  async updateState(user, state) {
    const key = this._makeKey(user)
    return this.redis.setex(key, this.ttl, JSON.stringify(state))
  }

  // Method to close Redis connection (useful for testing)
  async close() {
    if (this.redis && this.redis.disconnect) {
      await this.redis.disconnect()
    }
  }
}

module.exports = { _resolve, StateStore }
