const Redis = require('ioredis')
const parse = require('parse-duration')
const { getState, _initialState } = require('./machine')
const { parseEvent } = require('../event-normalizer')

// Greppable tag for "we could not name this conversation". Emitted exactly once
// per event -- from getState, never also from updateState -- so the count is a
// count of events. Nothing else may use this string.
const TUPLE_MISSING_TAG = 'CONVERSATION_TUPLE_MISSING'

// Greppable tag for "this conversation's history is over the cap and we refused
// to fold it". Emitted once per overflow, i.e. once per Redis miss on a capped
// conversation, never per event: the capped state is cached like any other. It
// also lands in `states.error_tag` via the stored column, so capped users are
// distinguishable from ordinary blocked ones in SQL. Nothing else may use this
// string.
const HISTORY_LIMIT_TAG = 'HISTORY_LIMIT'

// STATE_STORE_LIMIT caps how many archived events we will fold on a cache miss.
// Read at call time, not module load, so tests can set it. Unset is unlimited:
// `+undefined` is NaN, NaN is falsy, and chatbase.get() applies its SQL limit
// under `if (limit)`, so an unset value skips both the limit and the cap check.
function historyLimit() {
  return +process.env.STATE_STORE_LIMIT
}

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

// The cap decision, on the RAW rows chatbase returned, before the current event
// is appended by _resolve. We ask chatbase for limit + 1 rows, so "all of them
// came back" -- strictly more than `limit` -- means the pointer-truncated history
// exceeds the cap. Exactly `limit` archived events folds normally.
//
// Only account-scoped replays are capped. The unscoped no-account path already
// reads across every account the participant ever messaged and is documented as
// degraded; capping it would fire on the wrong conversation's history.
//
// Whether the current event is already archived (replybot and scribble consume
// in parallel) moves the boundary by one event. Harmless.
function isCapped(rows, limit, account) {
  return account !== null && !!limit && rows.length > limit
}

// The state a capped conversation gets instead of a fold. USER_BLOCKED because
// the machine already no-ops everything in it and dean already skips it, so no
// new guard sites; the error tag is what tells a capped user apart from a
// blocked one. No md, and that is safe: every USER_BLOCKED handler returns
// before actionsResponses, the only place that dereferences md.
//
// A returned state rather than a thrown error because the processor's catch only
// logs: nothing would be persisted or cached, and the next event would repeat
// the oversized read. Fail loud has to leave a mark.
function cappedState(limit, event) {
  return {
    ..._initialState(),
    state: 'USER_BLOCKED',
    error: { tag: HISTORY_LIMIT_TAG, message: `history exceeds ${limit} events`, ts: event.timestamp }
  }
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
  //
  // Returns { events } on the normal path, or { capped: true, limit } when the
  // pointer-truncated history exceeds STATE_STORE_LIMIT (see isCapped). The
  // pointer filter lives inside chatbase.get's query, so a restored or reset
  // user's history starts at their pointer -- that is the escape hatch from a
  // cap. Logs exactly one HISTORY_LIMIT line per overflow.
  async _getEvents(conv, user, event) {
    const account = (conv && conv.account) || null
    const limit = historyLimit()
    const res = await this.db.get({ userid: user, account }, limit ? limit + 1 : limit)

    if (isCapped(res, limit, account)) {
      console.warn(HISTORY_LIMIT_TAG, 'history exceeds cap, not folding; returning capped USER_BLOCKED state', JSON.stringify({
        user,
        platform: (conv && conv.platform) || null,
        account,
        limit
      }))
      return { capped: true, limit }
    }

    const events = _resolve(res, event)
      .map(parseEvent)
      .slice(0, -1)
    return { events }
  }

  // Replay from the durable log: fold the events, or hand back the capped state.
  async _replay(conv, user, event) {
    const { events, capped, limit } = await this._getEvents(conv, user, event)
    return capped ? cappedState(limit, parseEvent(event)) : getState(events)
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
      return this._replay(conv, user, event)
    }

    const key = this._makeKey(conv.platform, conv.account, user)
    const cached = await this.redis.get(key)

    if (cached) return JSON.parse(cached)

    return this._replay(conv, user, event)
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

module.exports = { _resolve, StateStore, makeKey, isNamed, isCapped, cappedState, TUPLE_MISSING_TAG, HISTORY_LIMIT_TAG }
