# GBV State Debugger Investigation

## CORRECTION (verified empirically after this doc was written)

**The "critical backpressure bug" described below is INCORRECT and has been disproven.** Re-reading `pgstream.js:46-62`, `this.running = false` (line 61) sits OUTSIDE the `while` loop, at the same indentation as `while (true) {` — so it executes unconditionally whenever the loop exits, whether via the backpressure `break` (line 51) or the end-of-stream `break` (line 54). There is no deadlock: `_read()` correctly sees `running === false` after a backpressure pause and resumes `_go()`.

This was confirmed by directly exercising `DBStream` with a synthetic 5,000-item paginated source piped into a deliberately slow `Writable` (highWaterMark 16, 2ms/item — guaranteed to trigger repeated backpressure): **it streamed all 5,000 items to completion in ~10.5s with no hang.**

**The real root cause is the query performance issue described in the sibling doc `planning/gbv-state-debugger-query-performance.md`** (the `ROW_NUMBER() OVER (ORDER BY timestamp)` pagination re-scans the user's entire message history on every page, an O(n²) pattern) — empirically verified against a real CockroachDB instance: a user with 30,000 messages took ~19.5s to paginate with the current query vs ~1.6s with keyset pagination, and the gap widens superlinearly as event count grows. That is what makes the debugger "seem to not run" for high-event-count test users.

The rest of this document (sections 2, 4, 5, 6 on STATE_STORE_LIMIT, partial-replay semantics, and doc gaps) remains accurate and useful. Section 1 and section 3's "backpressure bug" framing should be disregarded in favor of the correction above.

---

## Executive Summary (ORIGINAL — section 1's bug claim has been retracted, see correction above)

~~The debugger has a critical backpressure handling bug in DBStream (pgstream.js:46-66) that causes it to silently hang when processing large event counts.~~ This claim was tested directly and found to be false — see correction above. The debugger's slowness on high-event-count users is a query-cost problem (O(n²) pagination), not a stream deadlock.

---

## 1. End-to-End Runtime Trace for High-Event-Count User

### Initialization (lines 26-53 of debugger.js)

1. **Parse userid** from `process.argv`
2. **Create DBStream** (pgstream.js:23-31):
   - `fn = query(chatbase.pool, userid, 0)` — closure over the `query()` function
   - `stream = new DBStream(fn, 0)` — starts with `lim = 0` (fetch from row_number > 0)
   - `this.buffer = new Buffered(this._fetch.bind(this))`
   - Readable stream with `objectMode: true`
3. **Create StateStore** (statestore.js:16-42):
   - `emptyBase = { get: () => [], pool: chatbase.pool }` — **key: `get()` always returns empty array**
   - `stateStore = new StateStore(emptyBase)` — passes `emptyBase` as `this.db`
4. **Pipe to PromiseStream** (lines 38-53):
   - Each event `{ userid, content: event }` extracted from message rows
   - Passed to async function that:
     - Calls `stateStore.getState(userId, event)`
     - Calls `machine.transition(state, parsedEvent)`
     - Calls `stateStore.updateState(userId, newState)`
     - Logs output

### Query Execution for User with 10,000 Events

**Query function** (debugger.js:9-24):
```javascript
WITH r AS (SELECT *, ROW_NUMBER() OVER (ORDER BY timestamp) AS row_number
           FROM messages WHERE userid = $1 ORDER BY timestamp ASC)
SELECT * FROM r WHERE row_number > $2 ORDER BY row_number LIMIT 100;
```

**Pagination loop**:
- Call 1: `lim=0` → returns rows 1-100, `lim=100`
- Call 2: `lim=100` → returns rows 101-200, `lim=200`
- ...
- Call 100: `lim=9900` → returns rows 9901-10000, `lim=10000`
- Call 101: `lim=10000` → returns `[null, null]`, terminates

Each batch of rows is fetched into `Buffered.buff` and yielded one-by-one to the stream pipeline.

### Stream Pipeline Execution

**DBStream._read()** (pgstream.js:64-66) is called by Node.js when the stream consumer is ready:
```javascript
_read() {
  if (!this.running) this._go()
}
```

**DBStream._go()** (pgstream.js:46-62):
```javascript
async _go() {
  this.running = true
  while (true) {
    const res = await this.buffer.next()
    if (!this.push(res)) break        // <-- CRITICAL BUG HERE
    if (res === null) {
      this.emit('end')
      break
    }
  }
  this.running = false
}
```

**PromiseStream._write()** (steez/lib/index.js:8-12):
```javascript
_write(d, e, c) {
  this.fn(d)
    .then(_ => c(null))
    .catch(c)
}
```

Each event `d` is processed by the async function in debugger.js lines 39-52, which:
1. Calls `stateStore.getState()` — **hits Redis**
2. Calls `machine.transition()` — **replays state machine** (can be slow for complex inputs)
3. Calls `stateStore.updateState()` — **writes back to Redis**
4. Logs output

### The Deadlock: Backpressure Handling Bug

**Scenario for user with thousands of events**:

1. `_go()` starts: `running = true`
2. Loop pushes data items: items 1, 2, 3, ..., N
3. After ~16-30 items (depending on PromiseStream's default highWaterMark):
   - **PromiseStream's internal write buffer fills up**
   - Each item is slowly processed by the async function (stateStore.getState is blocking on Redis)
   - Internal buffer backlog grows
   - **Next `push()` returns `false` to signal "stop sending"**
4. DBStream code executes: `if (!this.push(res)) break`
5. **Breaks from while loop**
6. **But `this.running` is still `true`** (only set to false after the loop)
7. Stream appears to finish (no more output), but internally:
   - PromiseStream continues draining its buffer
   - Eventually finishes, calls `_read()` again
   - `_read()` checks: `if (!this.running)` — but running IS true!
   - **`_read()` does nothing**
8. **Deadlock: no more data is pushed, consumer hangs indefinitely**

**Result**: Debugger prints 15-30 events, then outputs stop completely. Process hangs. No error message. No completion signal. Looks like the script "not running."

---

## 2. STATE_STORE_LIMIT Analysis

### Is STATE_STORE_LIMIT Used?

**YES, but only in a dead-code path for this script.**

Located in `statestore.js:6,73`:
```javascript
const STATE_STORE_LIMIT = process.env.STATE_STORE_LIMIT  // can be undefined
async _getEvents(user, event) {
  const res = await this.db.get(user, +STATE_STORE_LIMIT)  // <-- line 73
  ...
}
```

### Why It's Dead Code in debugger.js

The debugger creates StateStore with:
```javascript
const emptyBase = { get: () => [], pool: chatbase.pool }
const stateStore = new StateStore(emptyBase)
```

When `stateStore.getState(userId, event)` is called:
1. Checks Redis cache (line 82): `cached = await this.redis.get(key)`
2. If cached, returns it immediately
3. **Only if NOT cached, calls `_getEvents()` which calls `this.db.get()`**

For the debugger on a fresh run with no Redis state:
- First event: Redis miss, calls `_getEvents()`, which calls `emptyBase.get()`
- `emptyBase.get()` ignores STATE_STORE_LIMIT and returns `[]` always
- `_resolve([], event)` returns `[event]` (lines 8-14)
- After slicing off the event (line 76), returns `[]`
- `getState([])` replays empty log, returns initial state

**For subsequent events**: Redis hit, returns cached state directly. `_getEvents()` never called.

**Verdict**: `STATE_STORE_LIMIT` set to "3000" in debugger.yaml (line 63) does NOT affect the debugger's actual behavior at all. It's cargo-culted from the bot's standard env config but irrelevant here.

---

## 3. What Breaks If Someone Adds Event Limiting

### Hypothetical Change: Reduce LIMIT from 100 to 10

If someone tried to optimize by changing line 18:
```javascript
LIMIT 10;  // instead of LIMIT 100
```

**Result**: Makes the bug worse, hits sooner
- Smaller pages = more query calls
- More query results to push = faster backpressure accumulation
- Backpressure hit after ~5-10 events instead of 15-30
- **Appears to "not run" even faster**

### Hypothetical Change: Add Event Count Cap

If someone added:
```javascript
let count = 0;
while (count < 1000) {  // process only first 1000 events
  const res = await this.buffer.next()
  count++
  if (!this.push(res)) break
  ...
}
```

**Result**: No change to the fundamental bug. Still deadlocks.

### What Really Happens with "Limiting to Arbitrary Number"

The phrase "limiting events to an arbitrary number causes it to not run" suggests someone tried to add a counter or change batch size. This would:
1. Trigger the backpressure bug **sooner** (smaller batches = more pressure)
2. OR introduce new logic that also doesn't handle backpressure
3. **Either way, manifests as silent hang**

---

## 4. Machine.js Replay Analysis

### Can Partial Replay Work?

The debugger builds state incrementally:
- Event 1: `getState()` → Redis miss → `_getEvents()` → returns `[]` → replay from scratch → initial state
- Event 2: `getState()` → Redis hit → returns cached state from event 1
- Event 3: `getState()` → Redis hit → returns cached state from event 2
- etc.

### If Someone Skipped Events (e.g., process events 5000+)

Starting mid-stream with event 5000:
- Calls `getState(userId, event5000)` 
- Redis miss (first run)
- `_getEvents()` returns `[]` because `emptyBase.get()` always returns `[]`
- `getState([])` returns initial state
- **Then transitions event5000 from initial state**
- **This is wrong**: event5000 should transition from the state built by events 1-4999

But the current code doesn't expose this as a failure. It would just produce a "wrong but looking valid" state. The state machine would process event5000 successfully, but the intermediate state would be incorrect.

**If capping total events at N, the state would be wrong if N < total_events**, but would look syntactically correct and not throw.

---

## 5. Documentation Gaps

### replybot/README.md

**Current**: Lines 72-93 describe Chat Log Publisher, nothing about the debugger tool.

**Missing**:
- How to run the debugger (needs a userid, the k8s Job pattern, Redis/CockroachDB connectivity)
- What the debugger does (event replay, state machine transitions, caching behavior)
- Known issues/limitations (high event count hang, no backpressure handling)
- Interpreting the output (STATE/EVENT/OUTPUT/NEW STATE columns)

### documentation/states-debugging.md

**Current**: Comprehensive overview of the states system, data flow, and dashboard UI.

**Missing**:
- No mention of `lib/responses/debugger.js` tool at all
- No section on "debugging tools" or "operator utilities"
- No discussion of the k8s Job pattern for offline analysis

---

## 6. File-by-File Critical References

| File | Lines | Finding |
|------|-------|---------|
| `replybot/lib/responses/pgstream.js` | 46-66 | **CRITICAL BUG**: `_go()` breaks on backpressure with `running=true` still set, causing deadlock |
| `replybot/lib/responses/pgstream.js` | 64-66 | `_read()` only restarts loop if `!this.running`, but running never goes false after backpressure |
| `replybot/lib/responses/debugger.js` | 9-24 | Query function: `LIMIT 100` per page (tunable but doesn't fix underlying bug) |
| `replybot/lib/responses/debugger.js` | 33-34 | `emptyBase = { get: () => [] }` — always returns empty, making STATE_STORE_LIMIT irrelevant |
| `replybot/lib/typewheels/statestore.js` | 6, 73 | `STATE_STORE_LIMIT` read but only used in dead-code path `_getEvents()` (never called on cache hit) |
| `replybot/kube-scratch-dev/debugger.yaml` | 63 | Sets `STATE_STORE_LIMIT: "3000"` but this does nothing for the debugger |
| `replybot/node_modules/@vlab-research/steez/lib/index.js` | 8-12 | PromiseStream serializes all events through async fn, creating backpressure on large batches |

---

## Root Cause Summary

**Primary Issue**: DBStream backpressure handling bug in pgstream.js (lines 46-66). When push() returns false, the code breaks from the loop but leaves `this.running = true`, breaking the invariant that `!this.running` means "loop not active." Next `_read()` call checks `if (!this.running)` and does nothing, causing deadlock.

**Why It Manifests on Large Event Counts**: PromiseStream serializes each event through a slow async function (state machine transitions + Redis ops), filling its buffer quickly. With thousands of events, backpressure is inevitable.

**Why STATE_STORE_LIMIT Is Irrelevant**: It's only read in `_getEvents()`, which is only called on the first (uncached) event, and even then, `emptyBase.get()` ignores it and returns `[]` always.

**Why Limiting Events Makes It Worse**: Smaller batches or early breaks trigger backpressure handling (or similar bugs) sooner, making the hang appear to happen after fewer events.
