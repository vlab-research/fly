# Marketing Messages Webhook Implementation - Scout Findings

**Date**: April 13, 2026  
**Task**: Scope BotServer webhook handling for Facebook Marketing Messages (Recurring Notifications) support  
**Deadline**: April 27, 2026 (message tags deprecated)

---

## Executive Summary

**BotServer is missing webhook support for `messaging_optin` events.** These events contain the `notification_messages_token` required to send recurring messages. The fix is **minimal** (add one event type to an array) because:

1. **BotServer is generic** — it passes all events to Kafka unchanged
2. **Replybot already handles optin events** — the OTN (one_time_notif_req) flow is production-ready
3. **Only the event type name changes** — `notification_messages` vs `one_time_notif_req` optin type

**Recommendation**: Implement in two phases:
- **Phase 1** (immediate, 2 hours): Add `messaging_optin` to BotServer event handling + tests
- **Phase 2** (follow-up, 4-6 hours): Extend Replybot optin handler for the new type + database persistence

---

## BotServer Current State

### Architecture Overview

**Location**: `/home/nandan/Documents/vlab-research/fly/botserver/`  
**Tech Stack**: Node.js + Koa + Kafka producer  
**Purpose**: Single-threaded webhook receiver that publishes Facebook events to Kafka

**Key Files**:
- `server/index.js` (29 lines) — HTTP routes
- `server/handlers.js` (158 lines) — Event routing logic
- `server/producer.js` — Kafka producer wrapper
- `server/handlers.test.js` (304 lines) — Unit tests

### HTTP Routes

```
GET  /webhooks            → verifyToken()           [Facebook challenge]
POST /webhooks            → handleMessengerEvents() [Incoming webhooks]
POST /synthetic           → handleSyntheticEvents() [Test events]
GET  /health              → Health check
```

### Webhook Event Processing (Current)

**File**: `server/handlers.js:24-51`

```javascript
async function handleMessengerEvents(ctx, producer, producerReady, eventTopic) {
  await producerReady

  for (const entry of ctx.request.body.entry) {
    // Process two event types
    const eventTypes = ['messaging', 'messaging_handovers']
    
    for (const eventType of eventTypes) {
      if (entry[eventType]) {
        for (const eventData of entry[eventType]) {
          const event = { ...eventData, source: 'messenger' }
          event.timestamp = normalizeTimestamp(event.timestamp)
          const user = getUserFromEvent(event)
          const data = Buffer.from(JSON.stringify(event))
          producer.produce(eventTopic, null, data, user)  // Partition key: userId
        }
      }
    }
  }
  ctx.status = 200
}
```

**Flow**:
1. Extract `entry[]` from webhook payload (Facebook sends one per webhook call)
2. For each entry, check for known event type arrays: `messaging`, `messaging_handovers`
3. For each event found, publish to Kafka with userId as partition key
4. Return 200 OK immediately (producer runs async)

**All events pass through unchanged** — BotServer adds only `source: 'messenger'` and normalizes timestamp.

---

## The Missing Piece: `messaging_optin` Events

### What Facebook Sends

When a user opts into Marketing Messages (clicks "Allow" button on opt-in prompt):

```json
{
  "object": "page",
  "entry": [{
    "id": "PAGE_ID",
    "time": 1704067200000,
    "messaging_optin": [{
      "sender": { "id": "USER_PSID" },
      "recipient": { "id": "PAGE_ID" },
      "timestamp": 1704067200000,
      "optin": {
        "type": "notification_messages",
        "payload": "SURVEY_ID_OR_WEBHOOK_INFO",
        "notification_messages_token": "LONG_TOKEN_STRING",
        "notification_messages_timezone": "US/Pacific",
        "token_expiry_timestamp": 1704153600000,
        "user_token_status": "REFRESHED",
        "notification_messages_status": "NOT_SENT",
        "title": "Get your results"
      }
    }]
  }]
}
```

**Key fields to capture**:
- `notification_messages_token` — use as recipient for out-of-window messages (CRITICAL)
- `notification_messages_timezone` — user's timezone preference
- `token_expiry_timestamp` — when token expires
- `optin.payload` — echoed back from opt-in request, identifies which form/survey

### Where BotServer Fails

**File**: `server/handlers.js:32`

Current code only checks for `['messaging', 'messaging_handovers']` arrays. When Facebook sends `messaging_optin`, it's ignored completely — the event never reaches Kafka, never gets to Replybot.

**No test coverage** for optin events.

---

## Comparison: OTN (Existing Pattern)

To understand what's needed, here's how the production OTN (One-Time Notification) flow works:

### OTN Event Structure

Facebook sends (same `messaging_optin` array):
```json
{
  "optin": {
    "type": "one_time_notif_req",
    "one_time_notif_token": "OTN_TOKEN",
    "payload": { "ref": "survey_field_ref" }
  }
}
```

### OTN Handling in Replybot

**File**: `lib/typewheels/machine.js:172, 445-461`

```javascript
// Event categorization (line 172)
if (nxt.optin) return 'OPTIN'

// State transition (lines 445-461)
case 'OPTIN': {
  if (nxt.optin.type !== 'one_time_notif_req') {
    return _noop()  // Ignore unknown types
  }

  const { one_time_notif_token: token, payload } = nxt.optin
  const tokens = state.tokens ? [...state.tokens, token] : [token]

  return {
    action: 'RESPOND',
    stateUpdate: { tokens },        // Store token in state
    response: payload,
    responseValue: 'optin',
    question: state.question
  }
}
```

**Current limitation**: Line 447 checks `type !== 'one_time_notif_req'` only. Marketing Messages with `type: 'notification_messages'` would return `_noop()` (ignored).

---

## Webhook Event Types Currently Handled

### Messaging Events
- Text messages (`message.text`)
- Quick replies (`message.quick_reply`)
- Postbacks (`postback`)
- Attachments/media (`message.attachments`)
- Message echoes (`message.is_echo`)
- Delivery receipts (`delivery`)
- Read receipts (`read`)
- Referrals (`referral`, including in postback)
- Reactions (`reaction`)

### Messaging Handover Events
- Thread control (`pass_thread_control`)

### NOT Handled
- ❌ `messaging_optin` — **THIS IS THE GAP**

---

## Database Considerations

### Current Token Storage (OTN)

Tokens are stored **only in-memory** in `state.tokens` array:
```javascript
state = {
  // ...
  tokens: ["OTN_TOKEN_1", "OTN_TOKEN_2", ...]
}
```

This works for OTN (one-time use, token consumed on send) but **not for Marketing Messages** (recurring sends, tokens persist).

### Database Schema

**File**: `devops/migrations/01-init.sql`

The `chatroach.states` table stores user state as JSON:
```sql
CREATE TABLE chatroach.states(
  userid VARCHAR NOT NULL,
  pageid VARCHAR NOT NULL,
  updated TIMESTAMPTZ NOT NULL,
  current_state VARCHAR NOT NULL,
  state_json JSON NOT NULL,
  ...
);
```

State is persisted after each event, but `state.tokens` is temporary. For Marketing Messages, we need:

**Option A**: Store tokens in state (simple, but mixes concerns)
```javascript
state_json = {
  tokens: [
    { 
      type: "one_time_notif_req", 
      token: "OLD_TOKEN" 
    },
    { 
      type: "notification_messages", 
      token: "NEW_TOKEN",
      timezone: "US/Pacific",
      expires: 1704153600000
    }
  ]
}
```

**Option B**: Create dedicated table (better for token lifecycle management)
```sql
CREATE TABLE notification_messages_tokens (
  userid VARCHAR NOT NULL,
  pageid VARCHAR NOT NULL,
  token VARCHAR NOT NULL PRIMARY KEY,
  payload VARCHAR,
  timezone VARCHAR,
  token_expiry_timestamp BIGINT,
  created TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  INDEX (userid, pageid)
);
```

**Recommendation**: Option B for Phase 2 — allows:
- Independent token refresh logic
- Batch cleanup of expired tokens
- Query tokens without loading full state
- Better auditing of token lifecycle

---

## Implementation Plan

### Phase 1: BotServer (IMMEDIATE)

**File**: `server/handlers.js`

**Change 1** (line 32):
```javascript
// Before
const eventTypes = ['messaging', 'messaging_handovers']

// After
const eventTypes = ['messaging', 'messaging_handovers', 'messaging_optin']
```

**Change 2** (line 33, add generic comment):
```javascript
// Before
// Process all event types (messaging and messaging_handovers)

// After
// Process all event types (messaging, messaging_handovers, messaging_optin)
```

**Risk**: None — events pass through unchanged, same as handover events

**Testing**: Add test case in `handlers.test.js`:

```javascript
it('should process messaging_optin events', async () => {
  const webhookPayload = {
    object: 'page',
    entry: [{
      messaging_optin: [{
        sender: { id: 'user123' },
        recipient: { id: 'page123' },
        timestamp: 1704067200000,
        optin: {
          type: 'notification_messages',
          notification_messages_token: 'TOKEN_ABC',
          notification_messages_timezone: 'US/Pacific',
          token_expiry_timestamp: 1704153600000,
          payload: 'form_ref_123'
        }
      }]
    }]
  }

  const ctx = { request: { body: webhookPayload }, status: 0 }
  await handleMessengerEvents(ctx, producerMock, producerReadyMock, 'test-events')

  ctx.status.should.equal(200)
  producerMock.produce.should.have.been.calledOnce
  const [topic, partition, data, user] = producerMock.produce.firstCall.args
  const eventData = JSON.parse(data.toString())
  eventData.optin.type.should.equal('notification_messages')
  eventData.optin.notification_messages_token.should.equal('TOKEN_ABC')
})
```

**Effort**: 30 minutes

---

### Phase 2: Replybot (FOLLOW-UP)

**Files to modify**:
1. `lib/typewheels/machine.js` — handle new optin type
2. Database migration — create token storage table
3. Token persistence layer — store/retrieve tokens
4. Message sending — use correct recipient field

**Change 1** (machine.js:447):
```javascript
// Before
if (nxt.optin.type !== 'one_time_notif_req') {
  return _noop()
}

// After
if (nxt.optin.type === 'one_time_notif_req') {
  const { one_time_notif_token: token, payload } = nxt.optin
  // ... existing OTN logic
} else if (nxt.optin.type === 'notification_messages') {
  const { notification_messages_token: token, payload, notification_messages_timezone: tz, token_expiry_timestamp: expires } = nxt.optin
  const tokens = state.tokens ? [...state.tokens, { type: 'notification_messages', token, timezone: tz, expires }] : [{ type: 'notification_messages', token, timezone: tz, expires }]
  return {
    action: 'RESPOND',
    stateUpdate: { tokens },
    response: payload,
    responseValue: 'optin',
    question: state.question
  }
} else {
  return _noop()
}
```

**Change 2** (machine.js:784-788, message recipient):

Current code assumes all tokens use `one_time_notif_token` field. Need to determine field name based on token type:

```javascript
// Before
if (token) {
  return { recipient: { one_time_notif_token: token }, ...message }
}

// After
if (token) {
  const tokenType = token.type === 'notification_messages' ? 'notification_messages_token' : 'one_time_notif_token'
  const tokenValue = token.token || token  // Handle both object and string formats
  return { recipient: { [tokenType]: tokenValue }, ...message }
}
```

**Effort**: 4-6 hours (including database migration, tests, validation)

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|-----------|
| **BotServer change breaks existing events** | High | Change is append-only (add to array), not replace. All existing events unaffected. |
| **Replybot doesn't know new optin type** | High | Add guard in categorizeEvent to return 'OPTIN' for both types. Add test. |
| **Token field name collision** | Medium | Token objects need to carry type info. Use Option B (token objects, not strings). |
| **Expired tokens sent to Facebook** | Medium | Implement token expiry check before use. Track in separate table. |
| **Token not persisted across restarts** | Medium | Store in database table, not just in-memory state. |

**Recommended mitigation**: Complete Phase 2 with database persistence before deploying to production.

---

## Gaps in Existing Documentation

### BotServer README
- No mention of webhook event types processed
- No mention of Kafka topic structure
- No mention of event routing logic
- No mention of `getUserFromEvent()` utility

**Should document**: Event types (messaging, messaging_handovers, messaging_optin), Kafka topic keys (userId), event passthrough behavior

### Replybot README
- Mentions "Kafka topics" but doesn't list them or their event types
- No documentation of optin handling
- No documentation of token storage in state
- No documentation of token recipient wrapping

**Should document**: OTN flow, token storage in state, how optin events are categorized, token recipient handling

---

## Files Relevant to Implementation

### BotServer
- `/home/nandan/Documents/vlab-research/fly/botserver/server/handlers.js` — Core change (line 32)
- `/home/nandan/Documents/vlab-research/fly/botserver/server/handlers.test.js` — Add test
- `/home/nandan/Documents/vlab-research/fly/botserver/README.md` — Document webhook event types

### Replybot
- `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/machine.js` — Handle new optin type (lines 447-461, 784-788)
- `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/machine.test.js` — Add test cases
- `/home/nandan/Documents/vlab-research/fly/replybot/README.md` — Document token handling

### Database
- `/home/nandan/Documents/vlab-research/fly/devops/migrations/` — Create new migration for token table
- `/home/nandan/Documents/vlab-research/fly/devops/all.sql` — Update master schema

### Documentation
- `/home/nandan/Documents/vlab-research/fly/documentation/marketing-messages.md` — Already exists with good detail

---

## Summary

| Aspect | Status | Effort | Risk |
|--------|--------|--------|------|
| **Webhook reception** | Missing | 30 min | None |
| **Optin event handling** | Partially implemented (OTN only) | 4 hrs | Low |
| **Token persistence** | Not implemented | 6 hrs | Medium |
| **Survey form support** | Out of scope for this scout | TBD | TBD |
| **Total Phase 1+2** | — | **10-12 hours** | **Low-Medium** |

**Next Steps**:
1. Implement Phase 1 (BotServer) — unblocks Replybot testing
2. Deploy and validate with test webhook
3. Implement Phase 2 (Replybot + database) in parallel
4. Add integration test end-to-end (webhook → Kafka → Replybot → Facebook API)
