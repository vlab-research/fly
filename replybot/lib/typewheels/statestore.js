const Redis = require('ioredis')
const parse = require('parse-duration')
const { getState } = require('./machine')
const { parseEvent } = require('../event-normalizer')

const STATE_STORE_LIMIT = process.env.STATE_STORE_LIMIT; // can be undefined

// The greppable tag for "we could not name this conversation". It is the entire
// instrument for the §7.1 canary ("watch 24h, expect zero"), so it is emitted
// exactly once per event -- from getState, never also from updateState -- and
// nothing else in the codebase may use this string.
const TUPLE_MISSING_TAG = 'CONVERSATION_TUPLE_MISSING'

function _resolve(li, e) {
  if (!e) return li
  if (!li) return [e]

  const i = li.indexOf(e)
  return i === -1 ? [...li, e] : li.slice(0, i + 1)
}

// --- functional core -------------------------------------------------------
//
// A conversation is (platform, account_id, user_id). Keying on the user alone
// is the bug this module exists to make impossible: a participant messaging two
// of a researcher's accounts shared one state blob, so an entry on one account
// answered a question in the other account's form and the conversation went to
// ERROR permanently.

// Pure. The Redis key for a conversation. `devops/clear-state-cache.sh` matches
// this with `SCAN MATCH state:*:*:<userid>` -- the two must agree, which is why
// the shape lives in exactly one function.
function makeKey(platform, account, user) {
  return `state:${platform}:${account}:${user}`
}

// Pure, total. True only when we can name the conversation with certainty.
// Deliberately no fallback to state.md.platform / state.md.pageid: those are
// precisely the fields that bleed between conversations, so recovering the key
// from them would re-create the bug on a cache hit.
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
  // The account is threaded in from the event envelope (`conv`), never from
  // state.md -- the same rule, for the same reason, as the cache key.
  //
  // `db.get` takes the conversation as an OBJECT (§7.5,
  // `lib/chatbase/chatbase.js`): `get({ userid, account }, limit)`. A bare string
  // throws there by design, and `account` is passed EXPLICITLY -- including as
  // null -- because omitting the key throws too. Both are deliberate: a call site
  // that forgets to scope fails loudly instead of quietly reading every account's
  // history. Do not add a default.
  //
  // Scoping is decided by the ACCOUNT ALONE -- deliberately NOT by `isNamed`.
  // `isNamed` gates the cache KEY, which needs the full triple. The replay needs
  // only the account, so an event carrying an account but no platform still gets
  // a correctly scoped replay. `isNamed(conv) ? conv.account : null` would scope
  // that event to null and throw away information the event actually gave us;
  // it is not a guess, because the account came from the event.
  //
  // A null account means an UNSCOPED replay: every event for this user id across
  // every account, interleaved (§2.2 item 3). That is the pre-§7.1 behaviour, so
  // an unattributable event is no worse off than it is today, and it still
  // advances the conversation instead of erroring (test plan B10-8). It is not a
  // path to be comfortable with -- see the note in getState.
  async _getEvents(conv, user, event) {
    const account = (conv && conv.account) || null
    const res = await this.db.get({ userid: user, account }, +STATE_STORE_LIMIT)
    return _resolve(res, event)
      .map(parseEvent)
      .slice(0, -1)
  }

  // get state UP TO BUT NOT INCLUDING this event
  //
  // `conv` is { platform, account } as computed from the event envelope by
  // conversationFromRawEvent (utils.js). All three key components come from the
  // event, never from the state being fetched.
  async getState(conv, user, event) {
    if (!isNamed(conv)) {
      // Never key a conversation under a name we cannot verify. Fall back to the
      // durable event log -- exactly what a cache miss already does -- and say so
      // once, loudly.
      //
      // `replay` records whether the fallback was scoped, because the unscoped
      // case is the expensive one and the two must be distinguishable in the
      // canary. An unscoped replay reads `ORDER BY timestamp ASC LIMIT
      // STATE_STORE_LIMIT` -- the OLDEST events, not the newest -- across all of
      // the participant's accounts, so for a heavy two-account participant the
      // window can be consumed entirely by the other conversation's history and
      // never reach this conversation's recent events. It does not merely
      // interleave; it can silently truncate. Which is the real argument for the
      // canary reading zero rather than for tolerating this path.
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
    // Never poison the cache with a partially-scoped write. getState already
    // logged TUPLE_MISSING_TAG for this event, so this path stays silent to
    // keep the canary at one line per event.
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
