const Redis = require('ioredis')
const parse = require('parse-duration')
const { getState } = require('./machine')
const { parseEvent } = require('../event-normalizer')

const STATE_STORE_LIMIT = process.env.STATE_STORE_LIMIT; // can be undefined

// Greppable tag for "we could not name this conversation". Emitted exactly once
// per event -- from getState, never also from updateState -- so the count is a
// count of events. Nothing else may use this string.
const TUPLE_MISSING_TAG = 'CONVERSATION_TUPLE_MISSING'

function _resolve(li, e) {
  if (!e) return li
  if (!li) return [e]

  const i = li.indexOf(e)
  return i === -1 ? [...li, e] : li.slice(0, i + 1)
}

// --- functional core -------------------------------------------------------

// The Redis key for a conversation. `devops/clear-state-cache.sh` matches it with
// `SCAN MATCH state:*:*:<userid>`, so the shape lives in exactly one function.
function makeKey(platform, account, user) {
  return `state:${platform}:${account}:${user}`
}

// True only when we can name the conversation with certainty. No fallback to
// state.md: those fields bleed between conversations, so recovering the key from
// them re-creates the bug on a cache hit.
function isNamed(conv) {
  return !!(conv && conv.platform && conv.account)
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
        lazyConnect: false, // Connect immediately
        retryDelayOnClusterDown: 300,
        enableOfflineQueue: true, // Queue commands when disconnected
        connectTimeout: 10000, // 10 second timeout
        commandTimeout: 5000   // 5 second command timeout
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

  _makeKey(platform, account, user) {
    return makeKey(platform, account, user)
  }

  // Replay the durable event log for this conversation.
  //
  // `account` is passed explicitly, including as null, because omitting it throws
  // in chatbase.get(). Do not add a default.
  //
  // Scoping keys on the ACCOUNT ALONE, not `isNamed`: the cache key needs the full
  // triple, the replay needs only the account, so an event carrying an account but
  // no platform still gets a correctly scoped replay.
  //
  // A null account replays every account for this user, interleaved.
  async _getEvents(conv, user, event) {
    const account = (conv && conv.account) || null
    const res = await this.db.get({ userid: user, account }, +STATE_STORE_LIMIT)
    return _resolve(res, event)
      .map(parseEvent)
      .slice(0, -1)
  }

  // State up to but NOT including this event. All three key components come from
  // the event, never from the state being fetched.
  async getState(conv, user, event) {
    if (!isNamed(conv)) {
      // Never key a conversation under a name we cannot verify. Fall back to the
      // event log, as a cache miss already does, and say so once.
      //
      // `replay` distinguishes scoped from unscoped because unscoped is the
      // expensive case: it reads the OLDEST STATE_STORE_LIMIT events across every
      // account, so for a heavy two-account participant the window can be consumed
      // by the other conversation entirely. It does not merely interleave, it can
      // silently truncate.
      console.warn(TUPLE_MISSING_TAG, 'cache bypassed, computing from the event log', JSON.stringify({
        user,
        platform: (conv && conv.platform) || null,
        account: (conv && conv.account) || null,
        replay: (conv && conv.account) ? 'account-scoped' : 'unscoped'
      }))
      return getState(await this._getEvents(conv, user, event))
    }

    const key = this._makeKey(conv.platform, conv.account, user)
    const cached = await this.redis.get(key)

    if (cached) return JSON.parse(cached)

    const events = await this._getEvents(conv, user, event)
    return getState(events)
  }

  async updateState(conv, user, state) {
    // Never poison the cache with a partially-scoped write. getState already logged
    // this event, so stay silent here.
    if (!isNamed(conv)) return undefined

    const key = this._makeKey(conv.platform, conv.account, user)
    return this.redis.setex(key, this.ttl, JSON.stringify(state))
  }

  // Method to close Redis connection (useful for testing)
  async close() {
    if (this.redis && this.redis.disconnect) {
      await this.redis.disconnect()
    }
  }
}

module.exports = { _resolve, StateStore, makeKey, isNamed, TUPLE_MISSING_TAG }
