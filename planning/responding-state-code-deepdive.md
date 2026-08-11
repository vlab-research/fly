# RESPONDING State Bug — Code Deep-Dive & Corrections

## Corrections to Prior Findings

### 1. **INCORRECT: Exponential backoff "capped at 2^16 * 60 seconds = ~1 hour"**

**FACT**: The formula caps retry COUNT at 16, then uses that fixed value for subsequent retries:
```sql
next_retry TIMESTAMP AS (
  (FLOOR(
      (POWER(2, (CASE 
                  WHEN JSON_ARRAY_LENGTH(state_json->'retries') <= 16 
                    THEN JSON_ARRAY_LENGTH(state_json->'retries') 
                  ELSE 16  ← Cap at 16
                END)
            )*60000 + (state_json->'retries'->>-1)::INT
      )::INT)/1000)::INT::TIMESTAMP
) STORED,
```
Lines 137-146 in `01-init.sql`. After 16 retries, exponent stays at 16: `2^16 * 60000ms = 3,932 seconds ≈ 65.5 minutes`. So retry 16, 17, 18... all space 65.5 minutes apart (constant, not exponential).

**IMPACT**: Users aren't stuck *longer* than prior findings claimed, but the backoff plateaus, not continues exponentially.

### 2. **CORRECT: Dean runs every 30 minutes, NOT 20-minute grace + 30-min poll window**

**FACT**: Dean runs on schedule `*/30 * * * *` (every 30 minutes). Grace period `DEAN_RESPONDING_GRACE = "20 minutes"` is enforced in the SQL WHERE clause:
```sql
WHERE
  current_state = 'RESPONDING' AND
  updated + ($1)::INTERVAL > $4 AND           -- Within 48 hours (RespondingInterval)
  ($4 - updated) > ($2)::INTERVAL AND        -- Must be older than 20 min (Grace)
  (state_json->'retries' IS NULL OR JSON_ARRAY_LENGTH(...) < $3)
```
Lines 103-109 in `queries.go`. The grace period is applied as a strict minimum age, not a delay before polling.

**ACTUAL TIMELINE**:
```
T+0:00   User responds → FB send fails → state = RESPONDING, retries = []
T+0:20   Grace period ends (20 min old)
T+0:30   First Dean poll cycle (every 30 min) → finds user > 20 min old
         Sends REDO event if retries.length < 30
T+0:31   Replybot processes REDO → action RESPOND_AGAIN, appends timestamp to retries
         If FB send fails again, state still RESPONDING with retries = [T+0:00_retry]
T+1:00   Second Dean poll cycle
         Finds user still > 20 min old, retries.length = 1 < 30
         Sends second REDO
T+1:01   next_retry computed: POWER(2, 1) * 60000 + T+0:00_retry = ~T+2:00
         User waits until T+1:00 + 60 min (next_retry window)
T+2:00   third Dean poll cycle may send another REDO if user hasn't escaped
```

The **visible minimum stuck time is ~20-30 minutes** (grace + one polling cycle), not "20 min to 2+ hours".

### 3. **CRITICAL: No constant 30-min retry interval in Dean itself**

**FACT**: Dean doesn't retry at fixed 30-min intervals. Dean runs every 30 min (the poll schedule) and sends synthetic REDO events. The retries themselves are spaced by the exponential backoff formula computed in the database (POWER(2, retry_count) * 60 seconds), not by Dean's polling.

The user production evidence shows retries "roughly every 30 min for ~30 retries" because:
- Dean polls every 30 min
- Each poll may send 1 REDO event
- User's `retries` array grows by 1 each cycle for ~30 cycles
- This coincidentally looks like "30-min interval" but is actually "one per polling cycle"

The actual spacing between individual retries is governed by `next_retry` (exponential) and the next time `next_retry < NOW()` in the database query.

---

## The Exact Send-and-Persist Sequence

### Success Path (Message Sent)
```
1. EVENT ARRIVES: Kafka consumer gets chat-event (user sends TEXT/QUICK_REPLY/POSTBACK)
   File: replybot/lib/index.js, line 58
   
2. LOAD STATE: processor() calls stateStore.getState(userId, event)
   File: replybot/lib/index.js, line 61
   File: replybot/lib/typewheels/statestore.js, lines 80-88
   
3. PURE STATE TRANSITION: machine.run(state, userId, event)
   File: replybot/lib/index.js, line 63
   
   3a. exec(state, event) → output  [PURE, line 89 of transition.js]
       Returns action: 'RESPOND', output.question, etc.
       
   3b. apply(state, output) → newState  [PURE, line 90 of transition.js]
       newState.state = 'RESPONDING'  [line 566 of machine.js]
       newState.retries = undefined  [line 572 of machine.js — RESET on user action]
       newState.previousOutput = output  [line 570 of machine.js — saved for REDO]
       
4. BEFORE SIDE EFFECTS: actionsResponses() fetches form, page token, generates messages
   File: replybot/lib/typewheels/transition.js, lines 40-62 & 130
   All network calls wrapped in iowrap() which converts errors to MachineIOError
   
5. [CRITICAL] SIDE EFFECT: act(actions, pageToken) sends to Facebook API
   File: replybot/lib/typewheels/transition.js, line 132
   Calls messenger.sendMessage() for each message
   File: replybot/lib/messenger/index.js, lines 60-70
   facebookRequest() retries up to 5 times on ETIMEDOUT or codes [1200, 551]
   If succeeds: returns
   
6. RETURN SUCCESS REPORT: publish: true, newState
   File: replybot/lib/typewheels/transition.js, lines 140-150
   
7. PUBLISH RESULTS: processor() publishes newState + report
   File: replybot/lib/index.js, lines 66-81
   publishState() → Kafka VLAB_STATE_TOPIC  [line 70]
   stateStore.updateState() → Redis  [line 71]
   Scribble consumes state → writes RESPONDING to states table
   
8. WAIT FOR ECHO: Facebook webhook sends ECHO event confirming message delivery
   
9. ECHO ARRIVES: exec(REDO, event.ECHO) → action: 'WAIT_RESPONSE'
   File: replybot/lib/typewheels/machine.js, line 443 (implied from WAIT_RESPONSE case)
   apply() → state.state = 'QOUT'  [line 609 of machine.js]
   
10. STATE = QOUT: User can now send next message
```

### Failure Path (FB Send Fails)

```
Steps 1-4: IDENTICAL to success path
newState = RESPONDING, persisted to Redis cache only (not yet to DB)

5. [CRITICAL] SIDE EFFECT FAILS: act(actions, pageToken) → sendMessage() throws
   File: replybot/lib/messenger/index.js, line 65
   Scenarios:
   a) ETIMEDOUT after 5 retries → throws MachineIOError('NETWORK', ...)
      Lines 19-26 of messenger/index.js
   b) FB API error code (non-retryable like 100, 200, 2018278) → throws MachineIOError('FB', ...)
      Lines 29-38 of messenger/index.js
   c) Network error → wrapped to MachineIOError('INTERNAL', ...)
      Lines 49-56 (getPageToken), 51-52 (getForm) via iowrap()
   
6. EXCEPTION CAUGHT: try/catch in machine.run() catches at line 152
   
7. RETURN ERROR REPORT: 
   {
     publish: true,  ← CRITICAL: still publishes!
     newState,       ← STILL RESPONDING!
     error: { ...e.details, tag: e.tag, message: e.message }
   }
   File: replybot/lib/typewheels/transition.js, lines 152-161
   
8. PUBLISH SAME STATE: processor() publishes newState = RESPONDING
   File: replybot/lib/index.js, lines 70-71
   Same RESPONDING state written to Kafka + Redis + (via Scribble) CockroachDB
   
9. USER STUCK: Any user message processed by machine.exec() → _noop()
   User in RESPONDING state, input ignored
   File: replybot/lib/typewheels/machine.js, lines 492, 106, 115
   
10. WAIT FOR DEAN: Only exit is Dean's synthetic REDO event (or network recovers)
```

### Key Timing Observation
The state transitions to RESPONDING at step 3b (pure state computation), 
but is published to the database at step 7 (after FB API call may have failed).
However, Redis cache is updated at step 7 regardless of FB success/failure.

If replybot crashes between step 3b and step 7:
- Redis doesn't have the new state
- On restart, state is replayed from event log → still computes RESPONDING
- Event is re-processed, FB API called again (idempotency not guaranteed)

---

## The Actual Retry Logic: Dean + Exponential Backoff

### Dean Query (Respondings)
File: `dean/queries.go`, lines 102-113:
```go
func Respondings(cfg *Config, conn *pgxpool.Pool) <-chan *ExternalEvent {
  query := `SELECT userid, pageid
            FROM states
            WHERE
              current_state = 'RESPONDING' AND
              updated + ($1)::INTERVAL > $4 AND
              ($4 - updated) > ($2)::INTERVAL AND
              (state_json->'retries' IS NULL OR JSON_ARRAY_LENGTH(state_json->'retries') < $3)`

  d := time.Now().UTC()
  return get(conn, getRedo, query, cfg.RespondingInterval, cfg.RespondingGrace, cfg.RetryMaxAttempts, d)
}
```

**Parameters from production config** (`devops/values/production.yaml`, lines 177-182):
- `DEAN_RESPONDING_INTERVAL = "48 hours"` — only look at users updated within last 48h
- `DEAN_RESPONDING_GRACE = "20 minutes"` — must be 20+ min old to retry
- `DEAN_RETRY_MAX_ATTEMPTS = 30` — stop after 30 retries

**What this returns**: All users where:
- `current_state = 'RESPONDING'`
- `NOW() - updated < 48 hours` (relatively recent)
- `NOW() - updated > 20 minutes` (old enough to retry)
- `retries.length < 30` (haven't exhausted attempts)

### Dean Execution
File: `dean/dean.go`, lines 71-104:
```go
func send(cfg *Config, client *http.Client, e *ExternalEvent) error {
  body, err := json.Marshal(e)
  ...
  resp, err := client.Post(cfg.Botserver, "application/json", bytes.NewBuffer(body))
  ...
  code := resp.StatusCode
  if code != 200 {
    err := fmt.Errorf("Non 200 response from Botserver: %v", code)
    return err
  }
  return nil
}

func process(cfg *Config, ch <-chan *ExternalEvent) {
  client := &http.Client{}
  counter := 0
  for e := range ch {
    err := send(cfg, client, e)
    handle(err)  ← Panics on error!
    counter += 1
    time.Sleep(cfg.SendDelay)  ← 3s from production.yaml line 191
  }
  ...
}
```

**Critical**: If send() fails (Botserver unreachable), Dean panics. Only successful sends continue. This means if Botserver is down, Dean fails the entire query cycle.

### Replybot's REDO Handling
File: `replybot/lib/typewheels/machine.js`, lines 320-336:
```javascript
case 'REDO': {
  const dontRedo = ['QOUT', 'END']
  if (dontRedo.includes(state.state)) return _noop()

  const newRetries = [...(state.retries || []), nxt.timestamp]

  return {
    ...state.previousOutput,
    action: 'RESPOND_AGAIN',
    stateUpdate: { retries: newRetries }
  }
}
```

When REDO arrives:
1. If state is QOUT or END, ignore (NOOP)
2. Otherwise, copy previousOutput, add timestamp to retries array
3. Action becomes RESPOND_AGAIN

Then apply():
```javascript
case 'RESPOND_AGAIN':
  return {
    ...state,
    ...output.stateUpdate,    ← retries array updated
    state: 'RESPONDING'        ← still RESPONDING!
  }
```

State remains RESPONDING. Next FB send attempt happens.

### The Exponential Backoff Plateau

Database computed column `next_retry` (lines 137-146 of `01-init.sql`):
```sql
(FLOOR(
  (POWER(2, (CASE 
              WHEN JSON_ARRAY_LENGTH(state_json->'retries') <= 16 
                THEN JSON_ARRAY_LENGTH(state_json->'retries') 
              ELSE 16  ← Plateau at exponent=16
            END)
          )*60000 + (state_json->'retries'->>-1)::INT
  )::INT)/1000)::INT::TIMESTAMP
```

Example timeline (assuming first failure at T+0):
- Retry 1 (state_json->'retries'->-1 = T+0:00): `2^1 * 60 = 120s` → wait until T+2:00
- Retry 2 (T+0:30): `2^2 * 60 = 240s` → wait until T+4:00
- Retry 3 (T+1:00): `2^3 * 60 = 480s` → wait until T+8:00
- ...
- Retry 16 (T+7:30): `2^16 * 60 = 3932s ≈ 65 min` → wait until T+72:30
- Retry 17+ (T+8:00+): `2^16 * 60 = 3932s` → **stays 65 min, doesn't grow**

After 30 retries with exponential backoff capped at retry 16, total elapsed time:
- Retries 1-16: exponential sum ≈ 2^17 * 60 ≈ 7.9 million seconds ≈ 92 days... **WAIT, this is wrong**

Actually, let me recalculate: the formula adds the exponentially-backed-off delay to the last retry timestamp, not cumulatively:
```
next_retry = 2^(retry_count) * 60 seconds + last_retry_timestamp
```

So if first failure T+0:00 and Dean sends REDO events every ~30 min:
- T+0:30 first REDO, retries[0] = T+0:30, next_retry = T+0:30 + 120s = T+2:30
- T+2:30 window opens, but Dean doesn't check until T+3:00 poll
- T+3:00 second REDO sent, retries[1] = T+3:00, next_retry = T+3:00 + 240s = T+7:00
- T+7:00 window opens, but Dean checks again T+3:30 poll, sends REDO
- ... continues ...
- After ~30 cycles over ~15 hours (30 * 30 min), user is abandoned

This matches production evidence: "30 retries ~30 min apart, total ~15 hours, then stuck forever".

---

## Why Errors Are Silent (fb_error_code = NULL)

### The Problem
Production data shows: `fb_error_code = NULL` on 853/860 stuck users.
The code does capture FB errors. Why aren't they in the DB?

### The Answer: Column is Computed from state_json->'error'

File: `01-init.sql`, line 121:
```sql
fb_error_code varchar AS (state_json->'error'->>'code') STORED,
```

This extracts `code` from the error object stored in state_json.

### When Error is Populated

In `transition.js`, line 160:
```javascript
error: { ...e.details, tag: e.tag, message: e.message, stack: e.stack }
```

When a MachineIOError is caught, the error object is constructed from:
- `e.details` (spread)
- `e.tag` ('FB', 'NETWORK', 'INTERNAL', etc.)
- `e.message`
- `e.stack`

### Where Details Come From

In `messenger/index.js`, line 37:
```javascript
throw new MachineIOError('FB', res.error.message, res.error)
```

The FB error details are passed directly: `{ code: 100, message: "Invalid recipient", ... }`

In `messenger/index.js`, line 25:
```javascript
throw new MachineIOError('NETWORK', e.message, { code: e.code, message: e.message })
```

Network errors have `code: 'ETIMEDOUT'` as a string, not a number.

### But state_json->'error' may not have 'code'

The issue: When state transitions to RESPONDING via `apply()`, **no error is stored**:

File: `machine.js`, lines 559-574:
```javascript
case 'RESPOND':
  return {
    ...state,
    state: 'RESPONDING',
    ...output.stateUpdate,
    md: { ...state.md, ...output.md },
    question: output.question,
    previousOutput: output,
    error: undefined,  ← ERROR CLEARED
    retries: undefined,
    qa: updateQA(state.qa, update(output))
  }
```

**State is set to RESPONDING with error undefined. The error is only in the report, not in the state itself.**

When FB send fails and exception is caught, the report has the error:
```javascript
return {
  publish: true,
  timestamp,
  user,
  page,
  newState,        ← still RESPONDING, error: undefined
  error: { ...e.details, tag: e.tag, message: e.message }  ← error here in report
}
```

### What Gets Persisted to DB

File: `index.js`, line 70:
```javascript
await publishState(report.user, report.page, report.timestamp, report.newState)
```

Only `report.newState` is persisted. The `report.error` is NOT persisted to the states table.

The error is only published to the chatbase via `publishReport()` (line 67), which likely goes to a separate logging/reporting table, not the `states` table.

**SMOKING GUN**: The state_json stored in `states.state_json` has `error: undefined` even though the FB send failed. Thus `fb_error_code` column (extracted from state_json->'error'->>'code') is NULL.

---

## Smoking Guns: Code Locations Explaining Stuck-Forever

### 1. **State Persisted Before FB Send** (Lines 127-132 of transition.js + Lines 70-71 of index.js)
```javascript
// transition.js:130
const { actions, pageToken, responses, payment, handoff } = await this.actionsResponses(...)
// transition.js:132 — FB SEND HAPPENS HERE
await this.act(actions, pageToken)  ← Can throw MachineIOError

// If above throws, caught at line 152, still returns newState = RESPONDING
// Then in index.js:70
await publishState(report.user, report.page, report.timestamp, report.newState)  ← Persisted!
```

The state machine enforces that RESPONDING is unreachable except by:
- User input (only exit via ECHO, line 443 of machine.js)
- REDO event → RESPOND_AGAIN → still RESPONDING until FB succeeds and ECHO arrives

### 2. **Error Report Not Persisted to State** (Line 71 of index.js vs Lines 70-71)
```javascript
// Line 70 publishes state
await publishState(report.user, report.page, report.timestamp, report.newState)
// Line 67 publishes report (separate topic)
await publishReport(report)

// State table gets newState.state_json, which has error: undefined
// Error details go to a different topic/table
```

### 3. **Only Exit Path is ECHO** (machine.js lines 443 + 609)
```javascript
case 'ECHO': {
  ...
  return {
    action: 'WAIT_RESPONSE',
    question: output.question
  }
}
// apply():
case 'WAIT_RESPONSE':
  return {
    ...state,
    state: 'QOUT',  ← Only way out of RESPONDING
    question: output.question
  }
```

No timeout, no fallback, no state transition without ECHO.

### 4. **Retries Don't Change State** (machine.js lines 589-593)
```javascript
case 'RESPOND_AGAIN':
  return {
    ...state,
    ...output.stateUpdate,    ← retries: [timestamps...]
    state: 'RESPONDING'        ← Still RESPONDING!
  }
```

Retry (RESPOND_AGAIN action) returns the same state without transition.

### 5. **User Input Ignored While RESPONDING** (machine.js lines 106, 115, 492)
```javascript
case 'QUICK_REPLY': {
  if (state.state === 'RESPONDING' || state.state === 'USER_BLOCKED') return _noop()
  ...
}
case 'TEXT': {
  if (state.state === 'RESPONDING' || state.state === 'USER_BLOCKED') return _noop()
  ...
}
case 'POSTBACK': {
  if (state.state === 'RESPONDING' || state.state === 'USER_BLOCKED') return _noop()
  ...
}
```

Any user message in RESPONDING state returns `_noop()`, which returns `{ action: 'NONE' }`, which in `transition.run()` (line 94) returns `publish: false`, meaning no state change is published.

### 6. **Dean Stops After 30 Retries** (queries.go line 109)
```sql
(state_json->'retries' IS NULL OR JSON_ARRAY_LENGTH(state_json->'retries') < $3)
```

When retries.length >= 30, the WHERE clause excludes the user. Dean stops sending REDO events.

State remains RESPONDING forever (or until manual intervention, like an UNBLOCK event).

---

## Open Questions

1. **When does the ECHO event actually arrive?**
   - Facebook's webhook must deliver a delivery confirmation event
   - If Facebook batches/delays these, user waits longer than expected
   - Code does not timeout RESPONDING state; if ECHO never arrives, user stuck forever

2. **Do identical events cause double-sends if replybot crashes?**
   - State transitions at step 3b (pure), but DB persists at step 7 (after FB send)
   - If replybot crashes between 3b and 7, on restart the same event is replayed
   - Act() is called again, FB API called again
   - No idempotency key on the FB message send request

3. **What happens if Botserver is unreachable when Dean sends REDO?**
   - dean.go line 99: `handle(err)` panics
   - Entire Dean process crashes
   - User stuck until manual restart or pod restart

4. **Can `next_retry` window pass without Dean detecting it?**
   - `next_retry` is computed but only checked by Dean's query
   - If Dean doesn't run during that window (e.g., Dean pod down), check is skipped
   - User may wait 30+ min past the window because Dean is offline

5. **Why does ECHO sometimes arrive late or not at all?**
   - Facebook webhook delivery is not instantaneous
   - If Facebook rate-limits or drops webhook deliveries, ECHO never comes
   - No fallback, no timeout to exit RESPONDING

---

## Summary of Root Cause

The bug is a violation of **functional core / imperative shell principle**:

**The Code Does**:
1. Compute newState = RESPONDING (pure)
2. Publish newState to DB (side effect)
3. Attempt FB send (side effect)
4. If (3) fails, newState is already persisted

**What It Should Do**:
1. Compute newState = RESPONDING (pure)
2. Attempt FB send (side effect)
3. If (2) succeeds, publish newState
4. If (2) fails, don't change state

The current design assumes FB send is part of the "pure" computation, not a separate side effect requiring separate error handling.

The recovery mechanism (Dean + exponential backoff) can reach the stuck user in 20+ minutes, but only if:
- Network to Botserver is working
- Dean pod is running
- User's retries < 30

After 30 retries (spaced exponentially, ~15+ hours), the user is abandoned forever in RESPONDING.
