# Phase Plan: Platform Abstraction Migration — Phases 2-5

**Status:** Phase 1 complete (event-normalizer, generic-translator, generic-validator added). This document outlines the refined execution plan for the remaining phases.

**Context:** This migration re-applies the feature/platform-abstraction branch's Phase-2 work onto current main, preserving main's newer replybot features (handoff wait-state guard from commit 96f27e3, synthetic restore_state recovery from 5986b3e).

---

## Phase 2: Refactor Core Machine Logic (High Risk)

### Objective
Adapt `machine.js` to read from `UniversalEvent` format (produced by event-normalizer) instead of raw Messenger events, while preserving main's handoff wait-state guard and restore_state recovery logic.

### Key Changes

#### 2.1 Update `categorizeEvent(nxt)` function
**Current (main):** Reads raw Messenger fields directly (e.g., `nxt.postback`, `nxt.message.text`, `event.pass_thread_control`).

**Target:** Read from UniversalEvent format (e.g., `nxt.event_type`, `nxt.payload`).

**Mapping Table:**
| UniversalEvent.event_type | Return Value | Triggered By |
|---|---|---|
| `conversation_started` | `'REFERRAL'` | Referral or get_started postback |
| `optin` | `'OPTIN'` | optin event |
| `synthetic_unblock` | `'UNBLOCK'` | Synthetic event type='unblock' |
| `synthetic_follow_up` | `'FOLLOW_UP'` | Synthetic event type='follow_up' |
| `synthetic_repeat_payment` | `'REPEAT_PAYMENT'` | Synthetic event type='repeat_payment' |
| `synthetic_redo` | `'REDO'` | Synthetic event type='redo' |
| `synthetic_platform_response` | `'PLATFORM_RESPONSE'` | Synthetic event type='platform_response' |
| `synthetic_machine_report` | `'MACHINE_REPORT'` | Synthetic event type='machine_report' |
| `synthetic_bailout` | `'BAILOUT'` | Synthetic event type='bailout' |
| `synthetic_block_user` | `'BLOCK_USER'` | Synthetic event type='block_user' |
| `synthetic_restore_state` | `'RESTORE_STATE'` | **NEW (main):** Synthetic event type='restore_state' |
| `handover` | `'HANDOVER_EVENT'` | pass_thread_control webhook |
| `synthetic_timeout` or `synthetic_external` | `'EXTERNAL_EVENT'` | Timeout or external event synthetic |
| `bot_message_read` or `bot_message_delivered` | `'WATERMARK'` | read or delivery event |
| `bot_message_sent` | `'ECHO'` | is_echo message |
| `user_interaction` (interaction_type='postback') | `'POSTBACK'` | postback event |
| `user_interaction` (interaction_type='quick_reply') | `'QUICK_REPLY'` | quick_reply event |
| `user_text` | `'TEXT'` | text message |
| `user_media` | `'MEDIA'` | attachments or stickerId |
| `user_reaction` | `'REACTION'` | reaction event |
| anything else | `'UNKNOWN'` | Unrecognized |

**Implementation:**
```javascript
function categorizeEvent(nxt) {
  const et = nxt.event_type
  
  if (et === 'conversation_started') return 'REFERRAL'
  if (et === 'optin') return 'OPTIN'
  if (et === 'synthetic_unblock') return 'UNBLOCK'
  if (et === 'synthetic_follow_up') return 'FOLLOW_UP'
  if (et === 'synthetic_repeat_payment') return 'REPEAT_PAYMENT'
  if (et === 'synthetic_redo') return 'REDO'
  if (et === 'synthetic_platform_response') return 'PLATFORM_RESPONSE'
  if (et === 'synthetic_machine_report') return 'MACHINE_REPORT'
  if (et === 'synthetic_bailout') return 'BAILOUT'
  if (et === 'synthetic_block_user') return 'BLOCK_USER'
  if (et === 'synthetic_restore_state') return 'RESTORE_STATE'
  if (et === 'handover') return 'HANDOVER_EVENT'
  if (et === 'synthetic_timeout' || et === 'synthetic_external') return 'EXTERNAL_EVENT'
  if (et === 'bot_message_read' || et === 'bot_message_delivered') return 'WATERMARK'
  if (et === 'bot_message_sent') return 'ECHO'
  
  if (et === 'user_interaction') {
    const interactionType = nxt.payload && nxt.payload.interaction_type
    if (interactionType === 'postback') return 'POSTBACK'
    if (interactionType === 'quick_reply') return 'QUICK_REPLY'
  }
  
  if (et === 'user_text') return 'TEXT'
  if (et === 'user_media') return 'MEDIA'
  if (et === 'user_reaction') return 'REACTION'
  
  return 'UNKNOWN'
}
```

#### 2.2 Update `makeEventMetadata(nxt)` function
**Current:** Reads from `event.pass_thread_control` (handover) or `event.event.value` (synthetic).

**Target:** Read from UniversalEvent `payload` field.

**Example:**
```javascript
function makeEventMetadata(event) {
  // Handle handover events
  if (event.event_type === 'handover') {
    const payload = event.payload || {}
    const { new_owner_app_id, metadata } = payload
    let parsed = {}
    
    if (metadata) {
      try {
        parsed = JSON.parse(metadata)
      } catch (e) {
        parsed = { metadata }
      }
    }
    
    return _eventMetadata('e_handover', {
      target_app_id: new_owner_app_id,
      ...parsed
    })
  }
  
  // Handle synthetic external events
  if (event.event_type === 'synthetic_timeout' || event.event_type === 'synthetic_external') {
    const payload = event.payload || {}
    const type = payload.type
    if (!type) return
    
    const base = type.split(':').join('_')
    const prefix = `e_${base}`
    return _eventMetadata(prefix, payload)
  }
  
  return undefined
}
```

#### 2.3 Update `getWatermark(nxt)` function
**Current:** Reads from `event.read` or `event.delivery`.

**Target:** Read from UniversalEvent `payload`.

**Example:**
```javascript
function getWatermark(event) {
  if (event.event_type === 'bot_message_read') {
    const payload = event.payload || {}
    return { type: 'read', mark: payload.watermark }
  }
  
  if (event.event_type === 'bot_message_delivered') {
    const payload = event.payload || {}
    return { type: 'delivery', mark: payload.watermark }
  }
  
  return undefined
}
```

#### 2.4 Update ECHO case handler
**Current:** Reads `nxt.message.metadata` (string or object).

**Target:** Read from UniversalEvent `payload`.

**Key:** Need to preserve the echo payload structure (which includes the metadata sent with the bot's message).

**Example:**
```javascript
case 'ECHO': {
  if (state.state === 'USER_BLOCKED') return _noop()
  if (state.state === 'START') return _noop()
  
  const payload = nxt.payload || {}
  const md = payload.metadata  // This is the metadata stored in the echo
  
  if (!md || md.repeat || md.type === 'statement' || md.keepMoving) {
    return _noop()
  }
  
  // ... rest of the logic
}
```

#### 2.5 Update TEXT, QUICK_REPLY, POSTBACK cases
These read user input values from `nxt.payload` instead of raw message fields.

**Example:**
```javascript
case 'TEXT': {
  if (state.state === 'RESPONDING' || state.state === 'USER_BLOCKED' || _isHandoffWait(state)) return _noop()
  
  if (state.state === 'START') {
    return _blankStart(nxt)
  }
  
  const payload = nxt.payload || {}
  const text = payload.text || ''
  
  return {
    action: 'RESPOND',
    response: text,
    responseValue: text,
    question: state.question
  }
}

case 'QUICK_REPLY': {
  if (state.state === 'RESPONDING' || state.state === 'USER_BLOCKED' || _isHandoffWait(state)) return _noop()
  
  const payload = nxt.payload || {}
  const value = payload.value
  
  return {
    action: 'RESPOND',
    response: value,
    responseValue: value,
    question: state.question
  }
}

case 'POSTBACK': {
  if (state.state === 'RESPONDING' || state.state === 'USER_BLOCKED' || _isHandoffWait(state)) return _noop()
  
  const payload = nxt.payload || {}
  const value = payload.value
  
  return {
    action: 'RESPOND',
    response: value,
    responseValue: value,
    question: state.question
  }
}
```

#### 2.6 Update REFERRAL case
Extract referral info from `payload`.

```javascript
case 'REFERRAL': {
  const payload = nxt.payload || {}
  const referral = payload.referral
  
  const form = referral && referral.ref ? referral.ref : null
  if (!form) return _noop()
  
  // ... rest of logic
}
```

#### 2.7 Preserve Main's Handoff Wait-State Guard
**From commit 96f27e3:** Lines 512, 522, 537, 553 check `_isHandoffWait(state)` and return `_noop()` for user input during handoff wait.

**Action:** Keep this logic unchanged. It already guards against TEXT, QUICK_REPLY, POSTBACK during handoff wait.

#### 2.8 Preserve Main's Restore_State Recovery
**From commit 5986b3e:** RESTORE_STATE case (lines 413-430) handles the synthetic_restore_state event.

**Action:** Ensure categorizeEvent maps `synthetic_restore_state` to `RESTORE_STATE` and test recovery works end-to-end.

### Testing
- All existing machine.test.js tests must pass (will need assertion updates for UniversalEvent shape)
- Specific tests for:
  - categorizeEvent maps each event_type correctly
  - makeEventMetadata reads payload correctly
  - getWatermark extracts watermark
  - Handoff wait-state guard still works (user input ignored during WAIT_EXTERNAL_EVENT with type='handover')
  - Restore_state recovery still works

### Risk Level: HIGH
- Core state machine logic changes
- Many tests need updates
- If UniversalEvent parsing fails, all events are lost

---

## Phase 3: Refactor Transition & Command Building (High Risk)

### Objective
Update `transition.js` to emit SendMessageCommand objects with the correct MessageContent format that main's message-worker expects, while leveraging the new abstraction layer.

### Key Changes

#### 3.1 Remove Messenger-Specific Logic
Delete or comment out:
- `getUserInfo()` calls (lines 22-24, 52)
- `getPageToken()` logic (lines 26-28, 47)
- TokenStore dependency

**Rationale:** message-worker now handles all platform concerns; replybot only orchestrates form logic.

#### 3.2 Refactor `buildCommands()` to emit SendMessageCommand format

**Current (main):**
```javascript
buildCommands(messages, handoff, user, page) {
  const commands = messages.map(msg => ({
    command_id: crypto.randomBytes(8).toString('hex'),
    issued_at: Date.now(),
    conversation_id: user,
    user_id: user,
    platform: 'messenger',
    platform_account_id: page,
    message: {
      type: 'native',
      native_payload: msg
    }
  }))
  
  if (handoff) {
    commands.push({
      ...
      message: {
        type: 'pass_thread_control',
        ...
      }
    })
  }
  
  return commands
}
```

**Target:** Emit commands with `Message.Type` enums matching message-worker's expectations.

```javascript
buildCommands(messages, handoff, user, page) {
  const commands = messages.map(msg => {
    // msg is now a MessageContent object from act()
    // (e.g., { type: 'text', text: '...', metadata: {...} })
    
    return {
      command_id: crypto.randomBytes(8).toString('hex'),
      issued_at: Date.now(),
      conversation_id: user,
      user_id: user,
      platform: 'messenger',
      platform_account_id: page,
      message: msg  // Direct MessageContent object
    }
  })
  
  if (handoff) {
    // Handoff is also a SendMessageCommand with pass_thread_control type
    commands.push({
      command_id: crypto.randomBytes(8).toString('hex'),
      issued_at: Date.now(),
      conversation_id: user,
      user_id: user,
      platform: 'messenger',
      platform_account_id: page,
      message: {
        type: 'pass_thread_control',
        target_app_id: handoff.target_app_id,
        handoff_metadata: JSON.stringify(handoff.metadata || {})
      }
    })
  }
  
  return commands
}
```

#### 3.3 Clarify Response vs Command Flow
**Key insight:** Main's `act()` function (in machine.js) currently returns Facebook-native payloads. After this migration:

- `act()` should return MessageContent objects (text, question, media types)
- `buildCommands()` wraps them as SendMessageCommand for Kafka
- message-worker's translation path activates when `Message.Type` is text/question/media

**Action:** Verify act() is wired to call generic-translator for questions and media.

#### 3.4 Update `transition()` method
Ensure it:
1. Calls event-normalizer to normalize the raw webhook to UniversalEvent
2. Passes UniversalEvent to exec/apply (not raw event)
3. Still returns `{ newState, output, page }`

**Example:**
```javascript
transition(state, rawEvent) {
  const normalizedEvent = parseEvent(rawEvent)  // from event-normalizer
  const page = normalizedEvent.source.account_id
  const output = exec(state, normalizedEvent)
  const newState = apply(state, output)
  return { newState, output, page }
}
```

### Testing
- Verify buildCommands emits correct SendMessageCommand format
- Test with message-worker: commands consumed correctly from Kafka
- Verify native passthrough still works for legacy flows
- Test pass_thread_control message format

### Risk Level: HIGH
- Output format change (goes to message-worker)
- Potential message loss if format mismatch
- Integration with message-worker (already deployed on main)

---

## Phase 4: Update Supporting Files (Medium Risk)

### 4.1 Update `form.js`
**Changes:**
- Replace `@vlab-research/translate-typeform` calls with local generic-translator
- translateField() should return MessageContent object (not JSON)
- Port `addCustomType()` from @vlab-research/utils locally (if not done yet)
- Add pipe transform support: `{{hidden:phone|e164}}` using normalizePhone

**Files touched:**
- replybot/lib/typewheels/form.js

**Example:**
```javascript
const { translateTypeformField } = require('../generic-translator')

function translateField(field) {
  return translateTypeformField(field)
}
```

### 4.2 Update `utils.js`
**Changes:**
- Port phone normalization helpers locally (normalizePhone with e164 support)
- Update getMetadata() to read from UniversalEvent if needed
- Remove @vlab-research/utils dependency

**Files touched:**
- replybot/lib/typewheels/utils.js

### 4.3 Update `waiting.js`
**Changes:**
- Update _normalizeEvent() to read UniversalEvent format (or remove if event-normalizer does it all)
- Preserve restore_state recovery logic

**Files touched:**
- replybot/lib/typewheels/waiting.js

### 4.4 Update `statestore.js`
**Changes:**
- Call event-normalizer in parseEvent() instead of @vlab-research/utils

**Files touched:**
- replybot/lib/typewheels/statestore.js

### Testing
- Form translation tests pass
- Pipe transform (e164) works
- Wait condition fulfillment logic works
- restore_state recovery still works

### Risk Level: MEDIUM
- Dependent on Phase 2 & 3 being correct
- Localized changes to supporting modules

---

## Phase 5: Delete Deprecated Files & Clean Config (Low Risk)

### 5.1 Delete Messenger & Chat-Log Modules
**Files to delete:**
- replybot/lib/messenger/index.js
- replybot/lib/messenger/messenger.test.js
- replybot/lib/chat-log/publisher.js
- replybot/lib/chat-log/publisher.test.js
- replybot/lib/typewheels/tokenstore.js

**Impact:** No other code should depend on these (verify with grep).

### 5.2 Clean Configuration
**Changes:**
- Remove `VLAB_CHAT_LOG_TOPIC` env var references
- Remove tokenstore references
- Remove messenger API token lookups

**Files touched:**
- replybot/lib/index.js (remove publishChatLog calls)
- replybot/package.json (remove obsolete deps)
- devops/values/production.yaml (remove VLAB_CHAT_LOG_TOPIC)
- devops/values/staging.yaml (remove VLAB_CHAT_LOG_TOPIC)

### Testing
- App starts without VLAB_CHAT_LOG_TOPIC
- No references to deleted files
- Grep: `tokenstore`, `getUserInfo`, `publishChatLog`, `chat_log_topic`

### Risk Level: LOW
- Additive deletions only
- No functional changes

---

## Phase 6: Integration Tests & Deployment (Medium Risk)

### 6.1 End-to-End Test
**What to test:**
1. Message sent by user → normalized event → machine processes → commands built → message-worker receives → sent to Facebook
2. Handoff sent → pass_thread_control command → message-worker handles
3. Handoff wait-state guard → user input ignored during wait
4. Restore_state recovery → state recovered from restore event

**Test files:**
- facebot/testrunner (already integrated with message-worker)
- Add specific test for: platform-abstraction flow (event normalization → commands → translate path)

### 6.2 Deploy & Version Bump
**Steps:**
1. Build new replybot Docker image
2. Update devops/values/production.yaml replybot version
3. Deploy to staging, verify end-to-end
4. Deploy to production

**Files:**
- devops/values/production.yaml
- devops/values/staging.yaml

### Risk Level: MEDIUM
- Integration with deployed message-worker
- Live traffic depends on correctness

---

## Summary Table

| Phase | Commits | Key Files | Changes | Risk | Tests |
|-------|---------|-----------|---------|------|-------|
| **1** | 1 | event-normalizer, generic-translator, generic-validator, package.json | +952 lines (additive) | NONE | All pass |
| **2** | 1 | machine.js | categorizeEvent, makeEventMetadata, getWatermark, event reading | HIGH | Adapt existing |
| **3** | 1 | transition.js | buildCommands, remove messenger logic | HIGH | Integration |
| **4** | 1 | form.js, utils.js, waiting.js, statestore.js | Port translators, update event reading | MEDIUM | Adapt existing |
| **5** | 1 | Delete messenger/, chat-log/, tokenstore; config cleanup | Deletions only | LOW | Grep verify |
| **6** | 2 | facebot/testrunner, devops/values | E2E test, version bump | MEDIUM | Live test |

**Total Estimated Commits:** 7-8 (phases 1 + cleanup + integration)

---

## Critical Integration Points

### Event Normalization → Machine
- **Input:** Raw Messenger/synthetic webhook or object
- **Output via event-normalizer:** UniversalEvent with event_type + payload
- **Machine reads:** event_type to categorize, payload to extract values
- **Risk:** If normalization loses data, events are dropped silently

### Machine → Transition
- **Input:** UniversalEvent (already normalized)
- **Output:** { newState, output, page }
- **Transition reads:** output.action to decide what to do
- **Risk:** Output format change breaks message-worker integration

### Transition → Message-Worker
- **Input:** Messages (MessageContent) + handoff from act()
- **Output via buildCommands:** SendMessageCommand with Message.Type enum
- **message-worker reads:** Message.Type to route (native → bypass, text/question/media → translate)
- **Risk:** Format mismatch means messages don't reach Facebook

### Handoff Wait-State Guard
- **Where:** machine.js categorizeEvent() guards TEXT/QUICK_REPLY/POSTBACK when _isHandoffWait(state)
- **Preserved:** Yes, logic stays the same
- **Test:** Verify user input ignored during handoff wait

### Restore_State Recovery
- **Where:** machine.js exec() handles RESTORE_STATE case
- **Preserved:** Yes, reads event.event.value.state and unconditionally overwrites state
- **Test:** Verify recovery restores full state from snapshot

---

## Quality Gates (Before Merge)

1. All machine.test.js tests pass (with adapted assertions)
2. All transition tests pass
3. All form, utils, waiting tests pass
4. E2E integration test passes (message flows end-to-end with message-worker)
5. No references to deleted files (grep: tokenstore, getUserInfo, publishChatLog)
6. No console warnings/errors beyond pre-existing
7. Git log shows clean, focused commits with clear messages

---

## Implementation Order & Dependencies

1. **Phase 2 → Phase 3:** Transition depends on machine changes
2. **Phase 2 + 3 → Phase 4:** Supporting files depend on core changes
3. **Phase 4 → Phase 5:** Must finish refactoring before deletions
4. **Phase 5 → Phase 6:** Integration tests run against clean codebase
5. **No parallelization:** Each phase blocks the next (tight coupling)

---

## Documentation Updates (After Merge)

1. **documentation/platform-abstraction.md**
   - Update "Status" to reflect Phase-2 completion
   - Confirm code samples match implementation
   - Add message-worker integration notes

2. **replybot/README.md**
   - Add "Platform Abstraction Architecture" section
   - Diagram: UniversalEvent → MessageContent → SendMessageCommand flow
   - Document event types and payload shapes
   - Document message-worker integration
