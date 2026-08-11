# RESPONDING State Bug — Investigation Findings

## Executive Summary

Users are getting stuck in the `RESPONDING` state because the state machine **transitions to `RESPONDING` before messages are sent to Facebook**, and if the Facebook API call fails, the state remains in `RESPONDING` with no recovery mechanism. The state eventually self-heals after 1-2 hours when Dean's cron job triggers a retry, but the user is stuck unresponsive to their own input during that time.

## The State Machine Flow

### State Transitions

The state machine (`replybot/lib/typewheels/machine.js`) has 8 states:

| State | Meaning | Entry Points |
|-------|---------|--------------|
| `START` | Initial state before survey begins | Initial state, after RESET |
| `RESPONDING` | **User has responded, bot is processing** | After user sends TEXT/QUICK_REPLY/POSTBACK (applied before FB message send) |
| `QOUT` | Question sent, waiting for user response | When ECHO received confirming bot message delivery |
| `END` | Survey completed | After final question answered |
| `BLOCKED` | User blocked (FB API error or spam detection) | FB errors or abuse detection |
| `ERROR` | Processing error occurred | Various failure scenarios |
| `WAIT_EXTERNAL_EVENT` | Paused for external event (payment, timeout) | Waiting for payment/event completion |
| `USER_BLOCKED` | User blocked the Facebook page | Explicit block event or Dean cron |

### Critical Flow: User Sends a Message

```
User sends TEXT/QUICK_REPLY/POSTBACK on Facebook
       ↓
[Botserver] receives webhook, publishes to Kafka chat-events topic
       ↓
[Replybot] consumes event from Kafka
       ↓
[machine.exec()] categorizes event (returns action: 'RESPOND')
       ↓
[machine.apply()] transitions state from QOUT → RESPONDING
    └─→ NEW STATE (RESPONDING) is written to Redis cache and database
       ↓
[machine.act()] generates list of messages to send to Facebook
       ↓
[messenger.sendMessage()] attempts Facebook API call
    ├─→ SUCCESS: User receives bot response, echoes back (next event type=ECHO)
    │   [machine.exec(ECHO)] transitions RESPONDING → QOUT
    │
    └─→ FAILURE: Exception thrown, caught in transition.run()
        Caught by MachineIOError handler (lines 152-161 of transition.js)
        ├─→ newState (still RESPONDING) is published to Kafka and database
        ├─→ NO state transition happens
        ├─→ NO recovery queued (Dean handles this via cron)
        └─→ User stuck in RESPONDING
```

## Root Cause Analysis

### The Critical Vulnerability: State Applied Before Side Effects

The state is transitioned to `RESPONDING` **before** the Facebook message is actually sent, violating the functional core / imperative shell pattern. When the side effect (FB send) fails, the state change has already been applied and persisted:

1. **Line 566** in `machine.js` — `apply(state, output)` where action is `'RESPOND'`:
   ```javascript
   case 'RESPOND':
     return {
       ...state,
       state: 'RESPONDING',  // ← State changed HERE
       ...output.stateUpdate,
       md: { ...state.md, ...output.md },
       question: output.question,
       previousOutput: output,
       error: undefined,
       retries: undefined,
       qa: updateQA(state.qa, update(output))
     }
   ```

2. **Line 70** in `index.js` — The new state is immediately published to Kafka and database:
   ```javascript
   if (report.newState) {
     await publishState(report.user, report.page, report.timestamp, report.newState)
     await stateStore.updateState(userId, report.newState)
   }
   ```

3. **Line 132** in `transition.js` — Only THEN do we attempt to send messages:
   ```javascript
   const { actions, pageToken, responses, payment, handoff } = await this.actionsResponses(...)
   await this.act(actions, pageToken)  // ← Facebook API call happens HERE
   ```

### Why This Is a Bug

If `sendMessage()` fails (lines 60-70 in `messenger/index.js`):

- The error is caught and wrapped as `MachineIOError` (line 37)
- It bubbles up through `act()` → `run()` to the catch block (lines 152-161)
- The `newState` (already in `RESPONDING`) is returned and published
- **User is now in `RESPONDING` state with no way to exit** except:
  - Another ECHO event (won't come because message wasn't received)
  - Dean's retry cron job (1-2 hours later)

### Why Users Are Stuck During RESPONDING

The state machine explicitly blocks all user input while in RESPONDING state. When a user is in `RESPONDING` state, they **cannot interact** — all their messages are silently dropped:

```javascript
// Lines 467, 476, 492 in machine.js
case 'POSTBACK': {
  if (state.state === 'RESPONDING' || state.state === 'USER_BLOCKED') return _noop()
  ...
}

case 'QUICK_REPLY': {
  if (state.state === 'RESPONDING' || state.state === 'USER_BLOCKED') return _noop()
  ...
}

case 'TEXT': {
  if (state.state === 'RESPONDING' || state.state === 'USER_BLOCKED') return _noop()
  ...
}
```

**All user input is silently dropped** while in `RESPONDING`. The state is meant to be transient (immediate transition to `QOUT` when bot message is echoed), but if the echo never arrives, the user is frozen.

## State Machine in ASCII

```
┌─────────────────────────────────────────────────────────────────┐
│                        STATE MACHINE                            │
└─────────────────────────────────────────────────────────────────┘

    ┌─────────┐
    │  START  │◄──────────────────────────────────────┐
    └────┬────┘                                        │
         │ REFERRAL / TEXT (no prior state)           │
         ▼                                              │
    ┌─────────────┐                                    │
    │  RESPONDING │ ◄──────────────────┐               │
    └────┬────────┘                    │               │
         │ ECHO (from bot message)     │               │
         │                             │               │
         ▼                             │               │
    ┌────────┐                         │               │
    │  QOUT  │  ───────┬───────────┐   │               │
    └────┬───┘        │           │   │               │
         │            │           │   │               │
         │ TEXT/      │ FOLLOW_UP │ REDO (sends synthetic)
         │ QUICK_REPLY├───────────┘   │               │
         │ POSTBACK   │                │               │
         │            │ (if in QOUT)   │               │
         ▼            ▼                ▼               │
    ┌────────┐   ┌──────────┐   ┌──────────────┐      │
    │  END   │   │WAIT_...  │   │   ERROR      │      │
    └────────┘   └──────────┘   └────┬─────────┘      │
                       │             │                │
                       │ (timeout)   │ (retry redo)   │
                       ▼             ▼                │
                    RESPOND ────────►RESPONDING ──────┘
                                         ▲
                                         │
                      FB Message Send Failure
                      (Network, FB error, timeout)


    ┌──────────────────────────┐
    │     ERROR STATES         │
    └──────────────────────────┘

    BLOCKED:  Facebook API error (e.g. user blocked page)
              ├─→ Can auto-recover via Dean retry or 'unblock' event
              └─→ Spans 1-2 hours before Dean retries

    ERROR:    Other processing errors
              └─→ Retried by Dean after DEAN_ERROR_INTERVAL

    USER_BLOCKED: User actively blocked the page
                  └─→ No recovery, survey ends
```

## Data Flow Diagram

```
User Message Event
       │
       ▼
[Botserver] Kafka chat-events topic
       │
       ▼
[Replybot Consumer]
       │
       ├─► stateStore.getState(userId)
       │   └─► Replay Kafka event log → compute current state
       │   └─► Redis cache (TTL 24h)
       │
       ├─► machine.run(state, event)
       │   │
       │   ├─► exec(state, event) → output
       │   │   └─► categorizeEvent() determines action type
       │   │
       │   ├─► apply(state, output) → newState
       │   │   └─► STATE UPDATED TO RESPONDING HERE (if user input)
       │   │
       │   ├─► actionsResponses(newState, output)
       │   │   │
       │   │   ├─► getForm(pageid, shortcode)
       │   │   ├─► getPageToken(pageid)
       │   │   ├─► act(state, output) → messages list
       │   │   │
       │   │   └─► return { messages, ... }
       │   │
       │   ├─► this.act(messages, pageToken)
       │   │   │
       │   │   └─► for each message: sendMessage(action, pageToken)
       │   │       │
       │   │       ├─► facebookRequest() with exponential backoff
       │   │       │
       │   │       ├─ SUCCESS: Graph API responds
       │   │       │
       │   │       └─ FAILURE: Timeout/Network/FB error
       │   │           └─ Throws MachineIOError
       │   │
       │   ├─ SUCCESS CASE: newState published with RESPONDING
       │   │   └─ When Facebook echoes message, next event is ECHO
       │   │       └─ exec(ECHO) triggers WAIT_RESPONSE action
       │   │           └─ apply() transitions RESPONDING → QOUT
       │   │
       │   └─ FAILURE CASE: Caught by try/catch (lines 152-161)
       │       └─ newState (RESPONDING) published unchanged
       │       └─ Error details logged
       │       └─ *** USER STUCK IN RESPONDING ***
       │
       ├─► publishState(newState) → Kafka VLAB_STATE_TOPIC
       │   └─► Scribble consumes → writes to states table
       │
       ├─► publishResponses(responses) → VLAB_RESPONSE_TOPIC
       │
       └─► stateStore.updateState(userId, newState)
           └─► Redis cache updated
```

## Failure Modes That Cause Stuck RESPONDING

### 1. Facebook Network Timeout (Most Common)

**Scenario**: `sendMessage()` network times out after retries exhausted

**Current Behavior**:
- Facebook request times out
- `facebookRequest()` retries up to 5 times with exponential backoff (400ms, 800ms, 1.6s, 3.2s, 6.4s = ~12 seconds total)
- After 5 retries, throws `MachineIOError('NETWORK', ...)`
- State published as RESPONDING
- User stuck

**Evidence**: Lines 19-26 in `messenger/index.js`

### 2. Facebook API Error (e.g., Invalid Recipient)

**Scenario**: User deleted their Facebook account or user ID is invalid

**Current Behavior**:
- Facebook API returns error code (e.g., 200, 1200, 551, etc.)
- `facebookRequest()` checks for retry-able codes (1200, 551) and retries
- For non-retry codes, throws `MachineIOError('FB', res.error.message, res.error)`
- State published as RESPONDING
- User stuck

**Evidence**: Lines 29-38 in `messenger/index.js`

### 3. Page Token Expired/Invalid

**Scenario**: Facebook page token expired or revoked

**Current Behavior**:
- `getPageToken()` may return expired token
- `sendMessage()` called with invalid token
- Facebook API returns error
- Throws MachineIOError
- State published as RESPONDING
- User stuck

### 4. Kafka Producer/Network Failure During State Publish

**Scenario**: Kafka broker unavailable when publishing newState

**Current Behavior**:
- `publishState()` fails to queue message (rare, but possible)
- Redis cache updated, but state not persisted to Kafka/DB
- On replybot restart, state lost
- User in undefined state

## Recovery Mechanism: Dean's Cron

### How Self-Healing Works (20 Minutes - 2+ Hours)

Dean (`dean/dean.go`) is a Go microservice that polls the `states` table every 30 minutes and identifies stuck users:

**Query** (lines 102-113 in `dean/queries.go`):
```sql
SELECT userid, pageid
FROM states
WHERE
  current_state = 'RESPONDING' AND
  updated + ($1)::INTERVAL > $4 AND           -- Within DEAN_RESPONDING_INTERVAL
  ($4 - updated) > ($2)::INTERVAL AND        -- Past DEAN_RESPONDING_GRACE
  (state_json->'retries' IS NULL OR JSON_ARRAY_LENGTH(state_json->'retries') < $3)
```

**Production Configuration** (from `devops/values/production.yaml`):
- `DEAN_RESPONDING_INTERVAL` = `48 hours` — Look back up to 2 days for stuck users
- `DEAN_RESPONDING_GRACE` = `20 minutes` — Wait 20 min before first retry
- `DEAN_RETRY_MAX_ATTEMPTS` = `30` — Retry up to 30 times before giving up
- **Query Schedule**: `*/30 * * * *` — Run every 30 minutes

**Action**: Dean sends a synthetic event `{ event: { type: 'redo' } }` to botserver

**Effect**: Replybot processes REDO event:
- Lines 320-336 in `machine.js`
- Repeats the previous state output (previousOutput field)
- Attempts to send messages again
- Tracks retry attempts in `state_json.retries` array

**Exponential Backoff for Retries**:
- The `next_retry` computed column in the database calculates:
  - Base: 2^(retry_count) * 60 seconds
  - Capped at: 2^16 * 60 seconds = ~1 hour for retry 16+
  - Formula: `POWER(2, retry_count) * 60000` milliseconds

**Timeline**:
```
T+0:00   User responds, state → RESPONDING, FB message send fails
         state_json.retries = [] (empty)

T+0:20   Dean grace period ends, first retry triggered
         state_json.retries = [timestamp1]
         next_retry = 2^1 * 60 = 120 seconds = T+2:20

T+0:30   Dean polling cycle runs, detects stuck user at T+20m
         Sends REDO event

T+0:35   Replybot processes REDO, attempts FB send again
         ├─→ SUCCESS: Message sent, state → QOUT, user can respond
         └─→ FAILURE: Still fails, retry count increments

T+2:20   Next retry window opens (2 minutes later)
         If still stuck, Dean sends another REDO

T+3:30   (30 min poll window closes)
T+4:00   Next Dean poll cycle: finds user still in RESPONDING state
         Sends REDO event if retry_count < 30

T+4:20   next_retry = 2^2 * 60 = 240 seconds = T+8:20 (exponential backoff)

...continues with exponential delays...

T+1h     After ~6-8 retry attempts spread over 1 hour
         If still failing, user abandoned after max retries
```

### Why 20 Minutes to 2+ Hours

The timing depends on:
1. **Grace period** (`DEAN_RESPONDING_GRACE`): 20 minutes before first retry
2. **Dean polling interval**: Every 30 minutes
3. **Exponential backoff**: 2^N minutes between retries (doubles each time)
4. **Network/processing latency**: Usually <1 second

**Minimum**: 20 minutes (grace) + processing latency ≈ 20 minutes visible

**Typical**: 20 min + exponential retries = 20 min, 42 min, 104 min, 224 min, etc.

**Maximum**: After 30 retries, user is abandoned (roughly 2-24 hours depending on retry timing)

If a user hits a permanent failure (e.g., user deleted account, account banned), Dean will retry up to 30 times, with exponential backoff eventually spacing retries hours apart.

## Stuck User Detection

### SQL Query to Find Stuck Users

```sql
-- Find users in RESPONDING state
SELECT
  userid,
  pageid,
  current_form,
  updated,
  NOW() - updated AS time_stuck,
  state_json->'qa'->-1->>0 AS last_question_ref,
  state_json->'error'->>'tag' AS error_tag
FROM states
WHERE
  current_state = 'RESPONDING'
  AND NOW() - updated > INTERVAL '5 minutes'
ORDER BY updated ASC;
```

### SQL Query to Find Recent Failures (Likely Cause)

```sql
-- Find users with recent FB errors before getting stuck
WITH recent_errors AS (
  SELECT
    userid,
    pageid,
    updated,
    error_tag,
    fb_error_code,
    state_json->'error'->>'message' AS error_message
  FROM states
  WHERE
    current_state IN ('ERROR', 'BLOCKED')
    AND updated > NOW() - INTERVAL '2 hours'
    AND error_tag IN ('FB', 'NETWORK')
)
SELECT *
FROM recent_errors
ORDER BY updated DESC;
```

### SQL Query to Check Dean's Retry Backlog

```sql
-- Find users waiting for Dean retry
SELECT
  userid,
  pageid,
  current_state,
  current_form,
  updated,
  next_retry,
  json_array_length(state_json->'retries') AS retry_count,
  state_json->'retries'->-1 AS last_retry_timestamp
FROM states
WHERE
  next_retry < NOW()
  AND (state_json->'retries' IS NOT NULL AND JSON_ARRAY_LENGTH(state_json->'retries') < 5)
ORDER BY next_retry ASC;
```

## File References

### State Machine Definition
- **Machine state transitions**: `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/machine.js`
  - Lines 251-544: `exec()` - determines action type
  - Lines 547-640: `apply()` - applies state transition
  - Lines 644-690: `act()` - generates messages to send
  - Line 566: **CRITICAL** — state set to RESPONDING

### Message Sending to Facebook
- **Messenger API wrapper**: `/home/nandan/Documents/vlab-research/fly/replybot/lib/messenger/index.js`
  - Lines 10-41: `facebookRequest()` with retry logic
  - Lines 60-70: `sendMessage()` entry point
  - Lines 19-26: Timeout retry logic
  - Lines 29-38: Facebook error code retry logic

### State Transition Orchestration
- **Main orchestration**: `/home/nandu/Documents/vlab-research/fly/replybot/lib/typewheels/transition.js`
  - Lines 33-38: `transition()` - calls exec/apply
  - Lines 65-72: `act()` - sends messages to Facebook
  - Lines 79-173: `run()` - orchestrates full flow
  - **CRITICAL** Lines 127-150: Success path (state published BEFORE message send)
  - **CRITICAL** Lines 152-161: Error path (catches FB send failures, publishes same state)

### Event Processing
- **Main processor**: `/home/nandan/Documents/vlab-research/fly/replybot/lib/index.js`
  - Lines 55-90: `processor()` - Kafka consumer
  - Lines 39-47: State/response/payment publishing
  - **CRITICAL** Lines 69-71: State published to database

### Recovery: Dean Cron Service
- **Dean main**: `/home/nandan/Documents/vlab-research/fly/dean/dean.go`
  - Lines 71-91: `send()` - sends external event to botserver
  - Lines 102-146: `getQueries()` - loads all query types
  - Lines 118-144: Query execution

- **Dean queries**: `/home/nandan/Documents/vlab-research/fly/dean/queries.go`
  - Lines 102-113: `Respondings()` - finds stuck RESPONDING users
  - **CRITICAL** Line 109: Checks retries array length < max attempts

### Database Schema
- **States table**: `/home/nandu/Documents/vlab-research/fly/devops/migrations/01-init.sql`
  - Lines 109-162: Table definition
  - Lines 137-146: `next_retry` computed column — exponential backoff formula
  - Line 140-141: Retry count extracted from state_json->'retries'

## Logging and Monitoring

### Where to Look in Logs

#### Replybot Logs
- **RESPONDING state transition**: `STATE: `, `REPORT: ` log lines show state before/after
- **Facebook failures**: Search for `MachineIOError` or `FB` tag in error logs
- **Network timeouts**: Search for `ETIMEDOUT` or `NETWORK` tag

#### Example Log Signature
```
EVENT: {"sender":{"id":"123"},"message":{"text":"hello"},"timestamp":1234567890}
STATE: {"state":"QOUT","question":"q1","qa":[...],"forms":["survey1"]}
REPORT: {"newState":{"state":"RESPONDING","question":"q1",...},"error":{"tag":"FB","message":"Message failed",...}}
```

#### Dean Logs
- **Stuck user detection**: Search for `Respondings` query results
- **Retry sends**: Success/failure of external events sent to botserver

### Recommended Monitoring Dashboard

1. **Histogram of time in RESPONDING state**
   ```sql
   SELECT
     FLOOR((NOW() - updated) / INTERVAL '1 minute') * INTERVAL '1 minute' AS time_bucket,
     COUNT(*) AS count
   FROM states
   WHERE current_state = 'RESPONDING'
   GROUP BY time_bucket
   ORDER BY time_bucket DESC;
   ```

2. **Error frequency by type**
   ```sql
   SELECT
     error_tag,
     COUNT(*) AS count,
     COUNT(*) * 100 / (SELECT COUNT(*) FROM states WHERE error_tag IS NOT NULL) AS pct
   FROM states
   WHERE error_tag IS NOT NULL
   GROUP BY error_tag
   ORDER BY count DESC;
   ```

3. **Stuck RESPONDING users by form**
   ```sql
   SELECT
     current_form,
     COUNT(*) AS stuck_count,
     MIN(NOW() - updated) AS oldest_stuck,
     MAX(NOW() - updated) AS newest_stuck
   FROM states
   WHERE current_state = 'RESPONDING' AND NOW() - updated > INTERVAL '5 minutes'
   GROUP BY current_form
   ORDER BY stuck_count DESC;
   ```

## Undocumented Behavior & Gaps

1. **No idempotency guarantee on Facebook message send**: If replybot crashes after `apply()` but before `publishState()`, the message might be sent twice when replybot restarts and retries the event.

2. **ECHO event dependency**: The state machine assumes that a successful Facebook send will immediately result in an ECHO event. If Facebook's webhook delivery is delayed or fails, the user can be stuck waiting for the echo.

3. **Exponential backoff formula is opaque**: The `next_retry` computed column calculation (lines 137-146 in schema) uses a complex formula with hard-coded constants. It's not documented what the expected retry intervals are.

4. **Retry logic differs between two places**: 
   - `facebookRequest()` in messenger/index.js retries specific error codes
   - `Dean` retries based on error_tag and time intervals
   - These retry strategies are not coordinated or documented as a system

5. **No circuit breaker pattern**: If Facebook API is consistently down, replybot will continuously attempt to send messages every ~30 minutes for 5 retries, then give up. There's no mechanism to stop early if a pattern of failures is detected.

6. **State machine cannot exit RESPONDING without ECHO**: The only way out of RESPONDING is if an ECHO event arrives (line 443 in machine.js). There is no timeout or alternative exit path. This is design, but the implications are not documented.

## Detailed Mechanism of Being Stuck

### What Happens When User Responds and FB Send Fails

**Sequence of Events**:

1. User sends "hello" on Facebook Messenger
2. Botserver webhook receives it, publishes to Kafka `chat-events` topic
3. Replybot consumer processes the event:
   - Replays state from event log → User is currently in `QOUT` state, waiting for response
   - `exec(QOUT_state, TEXT_event)` → Returns `action: RESPOND`
   - `apply(QOUT_state, RESPOND_output)` → **State becomes RESPONDING**
   - New state immediately cached in Redis and published to Kafka `VLAB_STATE_TOPIC`
   - Scribble consumes state message → Writes `RESPONDING` to database `states` table
4. **At this point, state is RESPONDING and persisted**
5. Replybot attempts to send message to Facebook API
   - `sendMessage(action, pageToken)` is called
   - Network timeout occurs OR Facebook API error returned
   - Exception raised, caught by `transition.run()` catch block
6. Error handling publishes the state again (still RESPONDING) and returns
7. **User is now stuck in RESPONDING state**
8. Any messages the user sends are processed by replybot:
   - `state.state === RESPONDING` check (line 492 in machine.js)
   - Input ignored, returns `_noop()` — no state change
9. **User waits 20-30+ minutes for Dean cron to trigger a retry**

**Why User Can't Recover on Their Own**:

The only way out of RESPONDING is the ECHO event:
- ECHO event only comes from Facebook's webhook when our message successfully reached Facebook
- If we never sent a message to Facebook (or it timed out before being received), no ECHO arrives
- User's new input doesn't trigger ECHO, it's ignored as `_noop()`
- User is frozen

### The Missing Safeguard

The code violates the **Functional Core / Imperative Shell** principle documented in CLAUDE.md:

> **All business logic must be pure functions** — deterministic, no side effects, easy to test
> **Push IO and side effects to the edges** — database calls, API requests, file operations happen in a thin outer layer that calls into the pure core

**What should happen**:
```
1. exec(state, event) → output (pure)
2. apply(state, output) → newState (pure)
3. [ONLY IF PURE FUNCTIONS SUCCEED] 
4. act(newState) → side effects (send to FB, publish to Kafka)
5. [ONLY IF SIDE EFFECTS SUCCEED]
6. Persist newState to database
```

**What actually happens**:
```
1. exec(state, event) → output (pure) ✓
2. apply(state, output) → newState (pure) ✓
3. Persist newState IMMEDIATELY ← BUG: Too early
4. act(newState) → side effects (send to FB) ← Can fail
5. If side effects fail, newState already persisted
```

## Summary of Key Findings

| Finding | Details | File:Line |
|---------|---------|-----------|
| **Root Cause** | State applied and persisted BEFORE FB side effect | machine.js:566 + index.js:70 |
| **Side Effect Failure** | `sendMessage()` fails but state already published | transition.js:152-161 |
| **User Input Blocked** | All TEXT/QUICK_REPLY/POSTBACK ignored while RESPONDING | machine.js:467, 476, 492 |
| **Only Exit Path** | ECHO event from FB (requires successful send) | machine.js:443 |
| **Recovery Mechanism** | Dean cron every 30 min sends REDO synthetic events | dean/queries.go:102-113 |
| **Grace Period** | 20 minutes before first retry | production.yaml |
| **Retry Formula** | Exponential: 2^(retry_count) * 60 seconds, capped at 2^16 | 01-init.sql:137-146 |
| **Max Retries** | 30 attempts before user abandoned | production.yaml |

