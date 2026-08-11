# QOUT and State Machine Findings

## Summary

`QOUT` ("Question Out") is one of eight valid states in the VLab platform's user-state machine. It means a question has been sent to the participant and the system is waiting for their response. The state machine is defined in JavaScript (replybot), reflected in the database (CockroachDB `states` table), queried by multiple Go services, and displayed in the dashboard.

---

## Every File Containing 'QOUT'

### Core State Machine Logic

**`/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/machine.js`**
- Line 267: `if (state.state === 'QOUT') return _repeat(state)` — when a REFERRAL event arrives for a form already seen and state is QOUT, repeat the last question
- Line 325: `const dontRedo = ['QOUT', 'END']` — REDO events are ignored if in QOUT or END
- Line 347: `if (state.state !== 'QOUT') return _noop()` — FOLLOW_UP events are only handled in QOUT state
- Line 606: `state: 'QOUT'` — the `apply()` function sets state to QOUT on `WAIT_RESPONSE` action (after echo of a question is received back from Messenger, confirming delivery)
- Line 828: `return { state: 'START', qa: [], forms: [] }` — initial state is START, not QOUT

### Database Write Layer (Go — scribble)

**`/home/nandan/Documents/vlab-research/fly/scribble/state.go`**
- The `State` struct has a `CurrentState string` field mapped to `current_state` in the database. No enum validation — any string is accepted. The value is read from Kafka messages.

**`/home/nandan/Documents/vlab-research/fly/scribble/state_test.go`**
- Lines 33–34, 64–65, 94–95, 129, 135, 188, 212: Integration tests that insert `current_state: "QOUT"` and `state_json: { ..., "state": "QOUT", ... }` rows into the database to verify the scribble write pipeline.

### Operational Automation (Go — dean)

**`/home/nandan/Documents/vlab-research/fly/dean/queries.go`**
- Line 223: `current_state = 'QOUT' AND` — the `FollowUps()` SQL query selects users in QOUT state whose survey has a follow-up message configured and who haven't received a follow-up yet. This is the primary use of QOUT in operational queries.

**`/home/nandan/Documents/vlab-research/fly/dean/queries_test.go`**
- Line 43: `base := \`{"state": "QOUT", ...}\`` — helper for building test state JSON
- Lines 629, 636, 643, 650, 657, 664, 758, 759, 774, 775: Integration tests that insert QOUT states to validate the follow-up query behavior

### Dashboard (JavaScript — dashboard-client)

**`/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/StatesExplorer/StatesList.js`**
- Line 11: `'START', 'RESPONDING', 'QOUT', 'END', 'BLOCKED', 'ERROR', 'WAIT_EXTERNAL_EVENT', 'USER_BLOCKED'` — complete canonical list of valid states used for UI validation
- Line 108: `QOUT: 'cyan'` — display color in the states table
- Line 200: `<Option value="QOUT">QOUT</Option>` — dropdown filter option

**`/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/StatesExplorer/StateDetail.js`**
- Line 74: `QOUT: 'cyan'` — display color in individual state detail view

**`/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/StatesExplorer/StatesSummary.js`**
- Line 57: `QOUT: 'cyan'` — display color in states summary/aggregate view

### Bail System Query Builder (Go — exodus)

**`/home/nandan/Documents/vlab-research/fly/exodus/README.md`**
- Line 137: `{"type": "state", "value": "QOUT"}` — example showing how to use QOUT as a bail condition to select users who are in QOUT state for targeting

### Documentation

**`/home/nandan/Documents/vlab-research/fly/documentation/states-debugging.md`**
- Line 17: Definition — "A question has been sent to the participant, waiting for their response"
- Line 257: Color code — `QOUT — cyan`
- Line 308: Interpretation — "Null or missing response → question sent but not yet answered (QOUT state)"

---

## State Machine Definition — All Valid States

The authoritative definition lives in `machine.js`. The complete set of valid states is:

| State | Set in `apply()` by | Meaning |
|-------|---------------------|---------|
| `START` | `_initialState()` and `RESET` action | No interaction yet; initial or reset condition |
| `RESPONDING` | `RESPOND`, `RESPOND_AGAIN`, `SWITCH_FORM` actions | Processing a user response (a question is being computed) |
| `QOUT` | `WAIT_RESPONSE` action | Question delivered (echo received), waiting for user reply |
| `END` | `END` action | Survey flow complete (thank-you screen sent) |
| `BLOCKED` | `BLOCKED` action | Blocked from proceeding (spam detection, FB error) |
| `ERROR` | `ERROR` action | Processing error (API failure, payment error) |
| `WAIT_EXTERNAL_EVENT` | `WAIT_EXTERNAL_EVENT` action | Paused waiting for external event (payment, timeout, follow-up trigger) |
| `USER_BLOCKED` | `RESET` with `state: "USER_BLOCKED"` | User has blocked the Facebook page or is unreachable |

The canonical list is also defined in the dashboard at:
```
/home/nandan/Documents/vlab-research/fly/dashboard-client/src/containers/StatesExplorer/StatesList.js
const VALID_STATES = new Set([
  'START', 'RESPONDING', 'QOUT', 'END',
  'BLOCKED', 'ERROR', 'WAIT_EXTERNAL_EVENT', 'USER_BLOCKED',
]);
```

---

## State Machine Architecture

### Where It Lives

The state machine implementation is entirely in:
```
/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/machine.js
```

It exports:
- `exec(state, event) -> output` — pure transition function; categorizes the event and decides the action
- `apply(state, output) -> newState` — pure state updater; takes old state + action output and returns new state
- `act(ctx, state, output) -> { messages, payment, handoff }` — produces side effects (which messages to send)
- `getState(log) -> state` — replays all events to compute current state (used when cache misses)
- `categorizeEvent(event) -> string` — categorizes an incoming Messenger event into an event type

### State Transition Logic

The `exec()` function is a large switch on event category. Key transitions relevant to QOUT:

| Event category | Condition | Action produced |
|----------------|-----------|-----------------|
| `ECHO` with `md.ref` (question ref) | Normal case | `WAIT_RESPONSE` → `apply()` sets state to `QOUT` |
| `ECHO` with `md.type === 'thankyou_screen'` | Survey complete | `END` |
| `ECHO` with `md.wait` | Wait condition attached | `WAIT_EXTERNAL_EVENT` |
| `TEXT`, `POSTBACK`, `QUICK_REPLY`, `MEDIA` | In any non-RESPONDING, non-USER_BLOCKED state | `RESPOND` → `apply()` sets state to `RESPONDING` |
| `FOLLOW_UP` | Only if `state === 'QOUT'` | `RESPOND` (sends follow-up message) |
| `REFERRAL` | State is QOUT, form already seen | Repeats the last question |
| `REDO` | In QOUT or END | Ignored (no-op) |

### The QOUT Lifecycle

1. Bot sends a question to the user via Facebook Messenger
2. Facebook sends back an "echo" event confirming delivery
3. `exec()` sees the echo, returns action `WAIT_RESPONSE`
4. `apply()` sets state to `QOUT`, recording the question reference
5. User sends a response (text, quick reply, postback, media)
6. `exec()` sees the response, returns action `RESPOND`
7. `apply()` sets state to `RESPONDING`, starts processing

### State Store

**`/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/statestore.js`**

The `StateStore` class caches current state in Redis (24h TTL by default) and falls back to event log replay from the database on cache miss. The `getState(user, event)` method returns state UP TO BUT NOT INCLUDING the current event.

### How State Is Persisted

After a transition in `replybot`, the new state is published to Kafka. The `scribble` Go service consumes from Kafka and writes to the `chatroach.states` table via `UPSERT` (one row per `(userid, pageid)` pair).

Database schema (`/home/nandan/Documents/vlab-research/fly/devops/migrations/01-init.sql`, line 109):
```sql
CREATE TABLE IF NOT EXISTS chatroach.states(
  userid VARCHAR NOT NULL,
  pageid VARCHAR NOT NULL,
  updated TIMESTAMPTZ NOT NULL,
  current_state VARCHAR NOT NULL,   -- the QOUT/RESPONDING/etc. value
  state_json JSON NOT NULL,         -- full state object
  PRIMARY KEY (userid, pageid),
  -- computed stored columns:
  current_form varchar AS (state_json->'forms'->>-1) STORED,
  previous_is_followup BOOL AS (...) STORED,
  previous_with_token BOOL AS (...) STORED,
  form_start_time TIMESTAMPTZ AS (...) STORED,
  error_tag VARCHAR AS (...) STORED,
  fb_error_code varchar AS (...) STORED,
  stuck_on_question VARCHAR AS (...) STORED,
  timeout_date TIMESTAMPTZ AS (...) STORED,
  next_retry TIMESTAMP AS (...) STORED,
  payment_error_code VARCHAR AS (...) STORED,
  ...indexes
);
```

The `current_state` column is redundant with `state_json->>'state'` but stored separately for fast indexing.

---

## Operational Queries That Use QOUT

### Dean (Follow-Up Service)

**File:** `/home/nandan/Documents/vlab-research/fly/dean/queries.go`, `FollowUps()`, lines 211–238

```sql
SELECT question, userid, pageid
FROM states s
WHERE
  current_state = 'QOUT' AND
  previous_is_followup = FALSE AND
  previous_with_token = FALSE AND
  (NOW() - updated) > ($1)::INTERVAL AND    -- min elapsed since question was sent
  (NOW() - updated) < ($2)::INTERVAL        -- max elapsed (don't follow up too late)
  AND has_followup = TRUE                   -- survey must have followup configured
```

This is the **only** operational query in `dean/queries.go` that filters on `QOUT` directly. Other operational queries filter on `RESPONDING`, `ERROR`, `BLOCKED`, and `WAIT_EXTERNAL_EVENT`.

### Exodus (Bail System)

The exodus `query/builder.go` translates bail conditions to SQL. A condition like:
```json
{"type": "state", "value": "QOUT"}
```
generates:
```sql
s.current_state = $N
```
This means bail rules can target users in QOUT state for re-routing.

---

## Relationship Summary

```
replybot/machine.js (exec/apply)    -- defines state transitions, writes QOUT
       |
       v
Kafka (chat-reports topic)          -- state change events published
       |
       v
scribble/state.go                   -- writes states table (UPSERT on userid+pageid)
       |
       v
chatroach.states table              -- current_state column stores "QOUT" etc.
       |
       +---> dean/queries.go        -- FollowUps() reads QOUT states to trigger follow-ups
       |
       +---> exodus/query/builder   -- bail conditions can filter by state = QOUT
       |
       +---> dashboard-client       -- StatesExplorer UI displays/filters by state
```

---

## Key Observations

1. **QOUT is not an enum.** There is no Go or TypeScript type enforcing valid state values. The string `"QOUT"` flows from the JavaScript state machine through Kafka, into Go, and into the database. The only canonical list is the JavaScript `VALID_STATES` set in the dashboard.

2. **QOUT means delivery confirmed, not just sent.** The state is set to QOUT when the Messenger "echo" event is received (confirming FB delivered the message), not when the bot sends the request. This is important for operational accuracy.

3. **QOUT is "sticky."** Once in QOUT, only a user response (text/postback/quick-reply/media) or a follow-up event advances the state. Referrals, REDOs, and most synthetic events are ignored while QOUT.

4. **The follow-up system is QOUT-gated.** Dean's `FollowUps()` query explicitly requires `current_state = 'QOUT'`. A user who is in any other state (e.g., RESPONDING) will not receive a follow-up even if they haven't answered.

5. **Both `current_state` and `state_json->>'state'` store the same value.** The `current_state` column is a denormalized copy of the state inside the JSON blob, kept for index performance.
