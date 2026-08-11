# Marketing Messages Implementation Plan

**Date**: April 13, 2026  
**Deadline**: April 27, 2026 (Facebook message tag deprecation)  
**Scope**: Add Marketing Messages (Recurring Notifications) support to replace deprecated OTN flow  
**Status**: Ready for implementation

---

## Required Reading

Before starting implementation, read these in order:

1. **`documentation/marketing-messages.md`** — Specification and flow overview
2. **`replybot/README.md`** — Current OTN implementation, token handling, message flow
3. **`botserver/README.md`** — Webhook event types and processing flow
4. **`documentation/questions.md`** — Existing question type documentation
5. **Scout findings**:
   - `planning/marketing-messages-findings.md` — Replybot architecture and requirements
   - `planning/marketing-messages-webhook-findings.md` — BotServer webhook analysis

---

## Overview

**What is being built**: Support for Facebook Marketing Messages (Recurring Notifications) as a replacement for deprecated message tags (`CONFIRMED_EVENT_UPDATE`, etc.). 

**Why**: Facebook deprecates all message tags on April 27, 2026. Marketing Messages is the official replacement. It uses an opt-in flow identical to the production OTN (One-Time Notification) implementation, with these differences:

| Aspect | OTN | Marketing Messages |
|--------|-----|-------------------|
| Sends allowed | 1 per token | 1 per 48 hours (recurring) |
| Token consumed | Yes | No |
| Token expiry | ~24 hours | Extends while opted in |
| Field name | `one_time_notif_token` | `notification_messages_token` |
| Use case | Prize notifications | Marketing, status updates |

**Which components change**:
1. **BotServer** (`botserver/server/handlers.js`) — Handle `messaging_optin` webhook events (currently ignored)
2. **Replybot** (`replybot/lib/typewheels/machine.js`) — Extend OPTIN handler and message recipient logic for new token type
3. **Form template generator** (`@vlab-research/translate-typeform` package) — Add `notification_messages` field type to generate correct template payload
4. **Database schema** — Add table or column for recurring token storage
5. **Documentation** — Update README files and questions guide

---

## Implementation Steps

### Phase 1: BotServer Webhook Handling (30 minutes, no dependencies)

**Critical fix**: BotServer currently ignores `messaging_optin` events. Both OTN and Marketing Messages tokens arrive via this webhook type.

#### Step 1a: Add `messaging_optin` to event processing

**File**: `/home/nandan/Documents/vlab-research/fly/botserver/server/handlers.js` (line 32)

**Current code**:
```javascript
const eventTypes = ['messaging', 'messaging_handovers']
```

**Change to**:
```javascript
const eventTypes = ['messaging', 'messaging_handovers', 'messaging_optin']
```

**Impact**: Events will now pass through unchanged to Kafka (same behavior as other event types). Replybot's categorization logic will handle both OTN (`optin.type === "one_time_notif_req"`) and Marketing Messages (`optin.type === "notification_messages"`).

#### Step 1b: Update comment

**File**: `/home/nandan/Documents/vlab-research/fly/botserver/server/handlers.js` (line 31 or above)

Add/update comment to document the new event type:
```javascript
// Process all webhook event types: messaging (user interactions), messaging_handovers (thread control), messaging_optin (permissions/tokens)
```

#### Step 1c: Add test case

**File**: `/home/nandan/Documents/vlab-research/fly/botserver/server/handlers.test.js`

Add test for `messaging_optin` with type `notification_messages`. Reference existing OTN test pattern and verify:
- Event is produced to Kafka once
- Token and timezone fields are preserved in payload
- Timestamp normalized correctly

**Reference test structure**: Look at existing messaging event tests in `handlers.test.js` to maintain consistency.

---

### Phase 2: Replybot Token Storage Enhancement (2-3 hours, depends on Phase 1)

Tokens must be stored with metadata to distinguish OTN (consumed) from Marketing Messages (persistent).

#### Step 2a: Extend token storage structure

**File**: `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/machine.js`

**Decision point**: Store tokens as objects instead of strings. This enables:
- Distinguishing token type (OTN vs Marketing Messages) by field name
- Storing expiry/timezone metadata
- Supporting future token types

**Current structure** (line ~450):
```javascript
state.tokens = ["token1", "token2", ...]
```

**New structure** (after Phase 2):
```javascript
state.tokens = [
  { type: 'otn', token: 'OTN_TOKEN_1' },
  { type: 'marketing_messages', token: 'MM_TOKEN_1', timezone: 'US/Pacific', expires: 1704153600000 }
]
```

**Implementation note**: Create a helper function `normalizeToken(tokenString)` to handle migration of existing code that assumes strings. This allows gradual migration.

#### Step 2b: Update OPTIN case handler

**File**: `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/machine.js` (lines 447-461)

**Current code**:
```javascript
case 'OPTIN': {
  if (nxt.optin.type !== 'one_time_notif_req') {
    return _noop()
  }
  const { one_time_notif_token: token, payload } = nxt.optin
  const tokens = state.tokens ? [...state.tokens, token] : [token]
  return {
    action: 'RESPOND',
    stateUpdate: { tokens },
    response: payload,
    responseValue: 'optin',
    question: state.question
  }
}
```

**Change to**:
```javascript
case 'OPTIN': {
  if (nxt.optin.type === 'one_time_notif_req') {
    const { one_time_notif_token: token, payload } = nxt.optin
    const tokenObj = { type: 'otn', token }
    const tokens = state.tokens ? [...state.tokens, tokenObj] : [tokenObj]
    return {
      action: 'RESPOND',
      stateUpdate: { tokens },
      response: payload,
      responseValue: 'optin',
      question: state.question
    }
  } else if (nxt.optin.type === 'notification_messages') {
    const { notification_messages_token: token, payload, notification_messages_timezone: timezone, token_expiry_timestamp: expires } = nxt.optin
    const tokenObj = { type: 'marketing_messages', token, timezone, expires }
    const tokens = state.tokens ? [...state.tokens, tokenObj] : [tokenObj]
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
}
```

**Test coverage**: Extend `/replybot/lib/typewheels/machine.test.js` test "Validates an optin when it is a response to a notify request" (line 1589) to cover both types.

---

### Phase 3: Replybot Message Recipient Logic (1-2 hours, depends on Phase 2)

Update message sending to use correct token field based on token type.

#### Step 3a: Update message recipient selection

**File**: `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/machine.js` (lines 784-788 and 808-812)

The `_response()` function builds the Facebook message payload. It currently assumes `one_time_notif_token` field.

**Current code** (line ~785):
```javascript
if (token) {
  return { recipient: { one_time_notif_token: token }, ...message }
}
```

**Change to**:
```javascript
if (token) {
  const tokenString = token.token || token  // Handle both object and string formats
  const tokenType = token.type === 'marketing_messages' ? 'notification_messages_token' : 'one_time_notif_token'
  return { recipient: { [tokenType]: tokenString }, ...message }
}
```

**Also update** line ~810 (within the wait condition tokenWrap logic) with same recipient handling.

**Important**: This ensures:
- OTN sends with `{ one_time_notif_token: "..." }` (existing field name)
- Marketing Messages sends with `{ notification_messages_token: "..." }` (new field name)
- Backwards compatible with existing string tokens in state

#### Step 3b: OTN token consumption (one-time use)

**File**: `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/machine.js` (line ~245)

After using an OTN token, it should be removed from `state.tokens` array (consumed). Update the tokenWrap function to:
- Remove consumed OTN tokens: `state.tokens.filter(t => !(t.type === 'otn' && t.token === usedToken))`
- Keep Marketing Messages tokens: do NOT remove (can be reused per rate limits)

**Reference**: Current `tokenWrap()` function around line 238-249.

**Test coverage**: Ensure existing OTN consumption test still passes, and add test for MM token persistence.

---

### Phase 4: Form Template Type Support (2-3 hours, depends on Phase 1-3)

Add `notification_messages` field type to survey form definitions, so survey creators can request opt-in.

#### Step 4a: Add template translator function

**File**: `/home/nandan/Documents/vlab-research/fly/replybot/node_modules/@vlab-research/translate-typeform/translate-fields.js` (near line 219 where `translateNotify` is defined)

Add new function:
```javascript
const translateNotificationMessages = (data, ref) => {
  const { timezone = 'UTC', ctaText = 'ALLOW' } = data.md || {}
  
  const response = {
    attachment: {
      type: "template",
      payload: {
        template_type: "notification_messages",
        title: data.title,  // max 65 chars
        notification_messages_timezone: timezone,
        notification_messages_cta_text: ctaText,  // ALLOW, GET, GET_UPDATES, OPT_IN, SIGN_UP
        payload: JSON.stringify({ ref })
      }
    }
  }
  
  return response
}
```

**Register** in the field type translator map (around line 325 where `'notify': translateNotify` is):
```javascript
'notification_messages': translateNotificationMessages,
```

**Field configuration** in surveys: Users define in form JSON with:
```json
{
  "type": "statement",
  "description": "type: notification_messages\ntimezone: US/Pacific\nctaText: GET_UPDATES",
  "title": "Get your results"
}
```

#### Step 4b: Update documentation

**File**: `/documentation/questions.md`

Add section describing `notification_messages` field type (similar to existing `notify` type):

```markdown
### Notification Messages (type: "notification_messages")

Send an opt-in request for recurring notifications. Unlike OTN (one-time), these tokens persist and can be used for recurring sends (1 message per 48 hours).

**Field definition**:
```json
{
  "type": "statement",
  "description": "type: notification_messages\ntimezone: US/Pacific\nctaText: GET_UPDATES",
  "title": "Get your results"
}
```

**Metadata options**:
- `timezone` — User's timezone (e.g., `US/Pacific`, `UTC`). Defaults to `UTC`
- `ctaText` — Button label: `ALLOW`, `GET`, `GET_UPDATES`, `OPT_IN`, `SIGN_UP`. Defaults to `ALLOW`

**How it works**:
1. Field triggers sending the opt-in template to user
2. User clicks button
3. Facebook sends webhook with `notification_messages_token`
4. Token stored in state and used for messages sent outside 24-hour window
5. Token can be reused per rate limits (1 message per 48 hours)

**Example flow**:
```
[Survey intro]
↓
[Consent questions]
↓
[Statement] "To send you updates, please allow notifications"
↓
[Notification Messages opt-in request] ← User clicks "GET_UPDATES"
↓
[Long wait - 25 hours]
↓
[Winner announcement] ← Sent outside 24h window using token
```
```

---

### Phase 5: Database Schema for Recurring Token Storage (2 hours, depends on Phase 2-3)

Tokens need persistent storage for audit/debugging and future multi-send management.

#### Step 5a: Create migration

**File**: `/home/nandan/Documents/vlab-research/fly/devops/migrations/08-notification-messages-tokens.sql` (create new migration)

**Create table**:
```sql
CREATE TABLE IF NOT EXISTS notification_messages_tokens (
  id BIGSERIAL PRIMARY KEY,
  userid VARCHAR NOT NULL,
  pageid VARCHAR NOT NULL,
  token VARCHAR NOT NULL UNIQUE,
  token_type VARCHAR NOT NULL DEFAULT 'marketing_messages',  -- 'marketing_messages' or 'otn'
  payload VARCHAR,  -- echo back from opt-in request (form ref, user id, etc)
  timezone VARCHAR DEFAULT 'UTC',  -- User's timezone preference
  title VARCHAR,  -- Opt-in title shown to user
  token_expiry_timestamp BIGINT,  -- When Facebook token expires
  created TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT fk_states FOREIGN KEY (userid, pageid) REFERENCES states(userid, pageid),
  INDEX idx_user_page (userid, pageid),
  INDEX idx_token_type (token_type),
  INDEX idx_created (created)
);
```

**Rationale**:
- Separate table allows independent token lifecycle management
- Audit trail of when tokens created/updated
- Query tokens without loading full state
- Support batch cleanup of expired tokens

#### Step 5b: Update state machine to write tokens

**File**: `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/transition.js`

After token is stored in `state.tokens` (Phase 2), also write to database table. Add function call in processor after `machine.run()` completes:

```javascript
if (actionResult.stateUpdate?.tokens) {
  const newTokens = actionResult.stateUpdate.tokens
    .filter(t => t.type === 'marketing_messages' || t.type === 'otn')
  
  for (const tokenObj of newTokens) {
    await db.query(
      `INSERT INTO notification_messages_tokens 
       (userid, pageid, token, token_type, timezone, title, token_expiry_timestamp, payload) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (token) DO UPDATE SET updated = CURRENT_TIMESTAMP`,
      [
        userId, pageId,
        tokenObj.token,
        tokenObj.type,
        tokenObj.timezone || null,
        null,  // title not stored (would require tracking from original request)
        tokenObj.expires || null,
        null   // payload not stored in state (available via webhook if needed)
      ]
    )
  }
}
```

**Alternative** (simpler for MVP): Skip database write for Phase 1-4. Add this phase only if recurring send management is needed. Tokens persist in state and are sufficient for single sends.

---

### Phase 6: Testing & Documentation Update (1-2 hours, depends on all phases)

#### Step 6a: Integration tests

**File**: `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/machine.test.js`

Add test cases covering:

1. **Token extraction**: OPTIN event with `notification_messages` type extracts token correctly
2. **Token storage**: Token stored in state with correct type/timezone/expires
3. **Message sending**: Message sent with `notification_messages_token` recipient field
4. **Token persistence**: MM token NOT removed from state after use (vs OTN which is consumed)
5. **Backward compatibility**: Existing OTN tests still pass

**Reference existing test**: "Validates an optin when it is a response to a notify request" (line 1589) shows OTN test pattern.

#### Step 6b: BotServer tests

**File**: `/home/nandan/Documents/vlab-research/fly/botserver/server/handlers.test.js`

Add test for `messaging_optin` webhook event processing (Step 1c).

#### Step 6c: Update documentation

**File**: `/home/nandan/Documents/vlab-research/fly/replybot/README.md`

The README already has excellent sections on OTN token handling. Update to clarify Marketing Messages:

**Location**: Section "Opt-In Tokens (Out-of-Window Message Sending)" (lines ~328-356)

Add/clarify:
- Token storage now includes type information (objects vs strings)
- Marketing Messages token structure and expiry
- Token field name differences (`notification_messages_token` vs `one_time_notif_token`)
- Example payload structures for both types
- Note about token persistence (MM tokens NOT consumed)

**File**: `/home/nandan/Documents/vlab-research/fly/botserver/README.md`

Already updated (line 25-28) during Phase 1. Verify documentation matches implementation.

---

## Database Changes

### Required
None required for MVP (Phase 1-4). Tokens persist in `state_json` state object, same as OTN.

### Optional (Phase 5)
Create `notification_messages_tokens` table for audit trail and future multi-send management. See Phase 5 for migration.

---

## Test Strategy

### Unit Tests (all phases)

1. **BotServer**: Add `messaging_optin` event handling test in `handlers.test.js`
   - Verify event published to Kafka unchanged
   - Verify both `one_time_notif_req` and `notification_messages` types pass through

2. **Replybot Machine**: Extend OPTIN handler tests in `machine.test.js`
   - Test OTN token extraction and storage (ensure backward compatibility)
   - Test MM token extraction with timezone/expires
   - Test token objects vs string migration
   - Test message recipient selection (correct field name per token type)

3. **Replybot Form Translation**: Add `notification_messages` field type translator test
   - Verify correct template payload structure
   - Verify timezone and CTA text options respected
   - Verify payload echoed correctly

### Integration Tests
1. **End-to-end flow**: 
   - Form with `notification_messages` field
   - User receives opt-in request
   - Simulate Facebook webhook with token
   - Token stored in state
   - Later message uses token as recipient

2. **Backward compatibility**:
   - Existing OTN flows still work
   - Existing surveys with `notify` type unaffected
   - Token consumption logic unchanged for OTN

### Manual Testing
1. Create survey with `notification_messages` field using Dashboard
2. Send test message via Messenger to activate survey
3. Verify opt-in request appears with correct button text
4. Approve and check Kafka topic for token event
5. Wait for trigger (>24 hours) and send winner message
6. Verify message delivered outside window

---

## Acceptance Criteria

**Feature is complete when**:

1. **Webhook reception** (Phase 1)
   - [ ] BotServer accepts `messaging_optin` events
   - [ ] Events published to Kafka unchanged
   - [ ] Test passes for MM optin type

2. **Token extraction** (Phase 2)
   - [ ] OPTIN handler recognizes `notification_messages` type
   - [ ] Token extracted from `optin.notification_messages_token`
   - [ ] Token stored in state with type metadata
   - [ ] Timezone and expiry preserved

3. **Message sending** (Phase 3)
   - [ ] Message recipient uses `notification_messages_token` field (not PSID)
   - [ ] Message sent to token outside 24-hour window
   - [ ] Token NOT consumed (available for 48h re-send)
   - [ ] OTN tokens still consumed correctly

4. **Form support** (Phase 4)
   - [ ] `notification_messages` field type recognized in surveys
   - [ ] Correct Facebook template payload generated
   - [ ] Opt-in request sent with configurable title and button text
   - [ ] Survey with both `notify` (OTN) and `notification_messages` fields works

5. **Backward compatibility**
   - [ ] All existing OTN tests pass
   - [ ] All existing surveys work without changes
   - [ ] No breaking changes to state structure (tokens can be strings or objects)

6. **Documentation**
   - [ ] BotServer README updated
   - [ ] Replybot README updated
   - [ ] Questions guide updated with `notification_messages` type
   - [ ] Implementation notes in code comments

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| **BotServer change breaks existing events** | Very Low | High | Change is append-only (add to array). All existing events pass through unchanged. Test added. |
| **Token type confusion** | Medium | Medium | Store with type metadata. Guard conditions handle both types. Clear test coverage. |
| **MM token sent as OTN** | Low | Medium | Token objects carry type info. Recipient field chosen based on type. Test for correct field name. |
| **Message sent inside 24h window uses token** | Low | High | Token usage only triggered by wait condition with `notifyPermission: true`. Existing logic unchanged. |
| **Expired tokens sent** | Low | High | Store expires in state. Check expiry before use (optional Phase 5). Rate limits enforced by Facebook. |
| **State structure breakage** | Low | High | Token objects backward compatible with strings via helper function. Gradual migration. Tests for both formats. |
| **Replybot crashes on new optin type** | Very Low | High | Guard condition `if (type === X) { ... } else if (type === Y) { ... } else { _noop() }` handles all cases. |

**Mitigation strategy**: Phase 1-3 are low-risk (no state structure change, append-only events, guard conditions). Phase 4 is isolated (new field type, no impact on existing). Phase 5 is optional.

---

## Implementation Order

Execute in strict order (each phase depends on previous):

1. **Phase 1** (30 min) — BotServer webhook handling
   - Enables tests to run with real optin events
   - No breaking changes

2. **Phase 2** (2-3 hrs) — Replybot token storage
   - Enables token extraction and state management
   - Backward compatible

3. **Phase 3** (1-2 hrs) — Message recipient logic
   - Enables messages to be sent to tokens
   - Core feature complete

4. **Phase 4** (2-3 hrs) — Form template support
   - Enables survey creators to use feature
   - Feature fully functional

5. **Phase 5** (2 hrs, optional) — Database persistence
   - Enables audit/debugging
   - Can be deferred post-launch

6. **Phase 6** (1-2 hrs) — Testing & docs
   - Verification and handoff documentation
   - Can overlap with other phases

**Total effort**: 8-13 hours (10 hours median)  
**Timeline**: 1-2 days of focused work

---

## File Changes Summary

| File | Phase | Changes | Lines |
|------|-------|---------|-------|
| `botserver/server/handlers.js` | 1 | Add `messaging_optin` to event types | 32 |
| `botserver/server/handlers.test.js` | 1 | Add MM optin test case | +30 |
| `replybot/lib/typewheels/machine.js` | 2,3 | Extend OPTIN handler, token storage, recipient logic | 447-461, 784-812 |
| `replybot/lib/typewheels/machine.test.js` | 2,3 | Add MM optin and recipient tests | +60 |
| `replybot/node_modules/@vlab-research/translate-typeform/translate-fields.js` | 4 | Add `translateNotificationMessages` function | +30, register +1 |
| `documentation/questions.md` | 4,6 | Add `notification_messages` field type docs | +50 |
| `replybot/README.md` | 2,6 | Clarify Marketing Messages vs OTN token handling | Sections ~328-356 |
| `botserver/README.md` | 1,6 | Update webhook event types list | Lines 25-28 |
| `devops/migrations/08-notification-messages-tokens.sql` | 5 (optional) | Create token storage table | +50 |

---

## Key Decisions

1. **Token storage as objects, not strings**: Enables type distinction without database lookup
2. **No token consumption for MM**: Aligns with Facebook API (tokens persist)
3. **Skip Phase 5 for MVP**: Database writes can be added later; state persistence sufficient
4. **Extend existing OTN translator**: Avoid duplicate code; reuse pattern for MM template
5. **Guard conditions for unknown types**: `_noop()` if type unrecognized (safe fail-forward)

---

## Deployment Checklist

- [ ] All phases 1-4 implemented
- [ ] All tests passing (unit + integration)
- [ ] Code reviewed for backward compatibility
- [ ] Documentation updated and reviewed
- [ ] Staging environment tested with real Facebook webhook
- [ ] Survey created in Dashboard with `notification_messages` field
- [ ] Opt-in request visually verified
- [ ] Token extracted and stored in state
- [ ] Message sent outside 24-hour window verified
- [ ] Rollback plan documented (none needed — append-only changes)

---

## Appendix: OTN Reference Implementation

For reference, here's how the existing OTN (One-Time Notification) flow currently works:

### Current OTN Flow
1. Survey contains field with `type: "notify"` (via `translateNotify()`)
2. User sees opt-in request: "Allow notifications?"
3. User clicks "Allow"
4. Facebook sends `messaging_optin` webhook with `optin.type === "one_time_notif_req"`
5. **BUG**: BotServer ignores this event (Phase 1 fixes this)
6. Replybot would receive event (after Phase 1), categorize as OPTIN
7. Token extracted and stored in `state.tokens`
8. After wait condition (>24 hours), message sent with `{ one_time_notif_token: token }` recipient
9. Token consumed (removed from state)

### Marketing Messages Changes
- Same flow, but `optin.type === "notification_messages"`
- Different field: `notification_messages_token` (not `one_time_notif_token`)
- Token NOT consumed (persistent, reusable per rate limits)
- Additional metadata: timezone, expiry timestamp

All other logic (categorization, Kafka flow, state management) remains unchanged.
