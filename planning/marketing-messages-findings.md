# Marketing Messages Implementation - Scout Findings

**Date**: April 13, 2026  
**Deadline**: April 27, 2026 (Facebook message tag deprecation)  
**Task**: Implement opt-in request step in survey form and update prize notification sender to use `notification_messages_token`

---

## 1. Survey/Facebot Architecture (High-Level)

### Components:
- **Facebot** (`/facebot`): Test fake chatbot for manual testing (minimal code, mostly test fixtures)
- **Replybot** (`/replybot`): **Production Kafka consumer** - processes incoming Facebook webhook events, transitions state machine, generates messages, sends to Facebook Graph API synchronously
- **Botserver** (`/botserver`): Receives Facebook webhooks, publishes events to Kafka, handles OAuth token management
- **Scribble** (`/scribble`): Kafka → CockroachDB sink for audit log tables (`states`, `responses`, `chat_log`, `messages`)
- **Message Worker** (`/message-worker`): Go library/service for translating platform-agnostic message commands to Messenger/Instagram/WhatsApp API formats (newer system, likely for async message sending)

### Key Data Flow:
```
Facebook Webhook → Botserver → Kafka event topic
                              ↓
                           Replybot (state machine engine)
                              ↓
                         Machine.run(state, event)
                              ↓
                         exec() → apply() → act()
                              ↓
                         Send to Facebook Graph API (synchronous)
                              ↓
                         Publish state to Kafka → Scribble → CockroachDB
```

---

## 2. Survey Flow & Question Types

### How Surveys Are Defined:
Surveys are JSON forms fetched from either:
- **Typeform API** (older, via `/replybot/lib/typewheels/typeform.js`)
- **Dashboard Form Central** (newer, via `/replybot/lib/typewheels/ourform.js`)

Both load a Typeform-compatible JSON structure with:
- `fields[]` — array of questions/statements
- `logic[]` — conditional jumps based on responses
- `thankyou_screens[]` — end-of-form screens
- `custom_messages` — validation/error message templates

### Supported Question Types (from `/documentation/questions.md`):

1. **Short Text** — Free text input
2. **Multiple Choice** — Quick replies or buttons
3. **Number** — Numeric validation
4. **Statement** — Auto-advancing message (no response needed)
5. **Image/Video** — Attachments with `keepMoving: true`
6. **Webview** — Button opening external URL with optional `wait` condition
7. **Stitch** — Link to next form (`{"type": "stitch", "stitch": {"form": "FORM_SHORTCODE"}}`)
8. **Wait** — Timeout condition (relative or absolute) with optional `notifyPermission: "true"` flag
9. **Notify** — One-time notification opt-in request (existing OTN flow) — `{"type": "notify"}`
10. **Payment** — Integration with Reloadly or HTTP payment endpoints
11. **Handoff** — (Custom type) Thread control transfer to human agents

### Field Metadata:
Custom field behavior is configured via field description (parsed as YAML by `/replybot/lib/typewheels/form.js`):
- `type` — Custom type (e.g., `statement`, `attachment`, `webview`, `handoff`, `wait`, `notify`)
- `keepMoving` — Auto-advance without waiting for response
- `wait` — Condition for external events (timeout, linksniffer click, payment, etc.)
- `md` — Metadata like `isRepeat: true`

---

## 3. Where Opt-In Fits in Survey Flow

### Current OTN Flow (Existing Implementation):

The existing "Notify" type question (`{"type": "notify"}`) is used for opt-in requests. When a field with `type: "notify"` is encountered:

1. **Form field definition** → `type: "notify"` (documented in `/documentation/questions.md:196`)
2. **Replybot processes event** → State machine checks if event is `OPTIN` type (line 172 in `/replybot/lib/typewheels/machine.js`)
3. **Facebook webhook** → Sends `messaging_optin` event with `optin.one_time_notif_token` and `optin.payload`
4. **Machine stores token** → Token stored in `state.tokens[]` array (line 452 in machine.js)
5. **Token used for messages** → When sending after 24-hour window, message recipient becomes `{ one_time_notif_token: token }` instead of `{ id: PSID }` (lines 785, 810 in machine.js)

### Recommended Placement for Marketing Messages Opt-In:

Marketing Messages opt-in should be triggered **explicitly in the survey flow**, similar to existing Notify type. Best practices suggest:

1. **After initial consent/agreement** — Once user has agreed to participate in the study
2. **Before waiting periods** — If the survey has a long timeout (>24h) and needs to send messages later
3. **At natural conversation breaks** — Between major form sections or after milestone questions
4. **With context** — Pair with a statement explaining why opt-in is needed (e.g., "We may send you updates about your prize status")

**Example flow:**
```
1. Welcome statement
2. Consent question  
3. [Statement] "To notify you about your prize, please allow notifications"
4. [New] Marketing Messages opt-in request (notification_messages template)
5. Continue survey questions
6. ... [potentially long wait]
7. Winner announcement → Use notification_messages_token to send outside 24h window
```

---

## 4. Prize Notification System (Location, How It Works, Recipient Field)

### Current Prize Notification Approach:
**Not found in current codebase as a discrete service.** Prize notifications likely happen via:
1. **Bail systems** (`/documentation/bail-systems.md`) — Automatically move winners to a "congratulations/prize claim" form
2. **Regular form flow** — The congratulations form is sent via normal Replybot message flow (within 24-hour window)

**Current implementation uses PSID as recipient:**
- All messages are sent with `recipient: { id: PSID }` by default (line 819 in `/replybot/lib/typewheels/machine.js`)
- OTN tokens (`one_time_notif_token`) are used only when a token was explicitly received from an opt-in event
- **No dedicated "prize notification sender" service exists** — messages are sent through the normal state machine

### Where to Add Marketing Messages Support:

**In Replybot's message sending pipeline:**

1. **File**: `/replybot/lib/typewheels/machine.js`
   - Line 819: `respond()` function sets default recipient
   - Lines 785, 810: Already has logic for OTN token recipients
   - **Need to add**: Logic to use `notification_messages_token` when appropriate

2. **File**: `/replybot/lib/typewheels/machine.js` 
   - Lines 447-460: OPTIN case handler processes incoming optin webhook
   - **Need to extend**: Handle new optin type `notification_messages` (currently only `one_time_notif_req` supported)

3. **File**: `/botserver/server/handlers.js`
   - Lines 32-44: Event handler only processes `messaging` and `messaging_handovers`
   - **Need to add**: Processing for `messaging_optins` webhook events (currently missing!)

---

## 5. Existing OTN Flow (If Any)

### Existing Implementation Details:

**OTN is already implemented for one-time notifications.** Here's the complete flow:

#### 1. **Sending the Opt-In Request**

The "Notify" field type in a survey triggers sending an opt-in request:

```javascript
// In replybot/lib/typewheels/machine.js, respond() function
// Lines 784-786: When a token exists AND we're sending first question with token
if (token) {
  return { recipient: { one_time_notif_token: token }, ...message }
}
```

The actual opt-in template is built by replybot when a "notify" type field is detected. Need to find where the template is constructed (likely in `translateField()` or Typeform translator).

#### 2. **Receiving the Opt-In Webhook**

**BUG FOUND**: Botserver does NOT handle `messaging_optins` webhooks!

- `/botserver/server/handlers.js` lines 32-44 only process `messaging` and `messaging_handovers`
- `messaging_optins` is subscribed to in `/dashboard-server/utils/facebook/facebook.util.js` line 22
- But the handler doesn't process them, so **opt-in tokens are never received**

#### 3. **Processing the Optin in Replybot**

```javascript
// replybot/lib/typewheels/machine.js:172
if (nxt.optin) return 'OPTIN'

// Lines 446-461: OPTIN case handler
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

**Token is stored in `state.tokens[]` array** — persisted in the state machine's state object, which gets written to CockroachDB `states.state_json` column.

#### 4. **Using the Token for Out-of-Window Messages**

```javascript
// replybot/lib/typewheels/machine.js:808-813
if (token) {
  return {
    recipient: { one_time_notif_token: token },
    ...nextQuestion(ctx, qa, question)
  }
}
```

When sending a message and a token exists, the recipient switches from `{ id: PSID }` to `{ one_time_notif_token: token }`.

---

## 6. What Needs to Change for Marketing Messages

### 1. **Add Marketing Messages Template Type to Survey Form** ✓ Documented
   - Add `"notification_messages"` as a new question type (alongside existing `"notify"`)
   - Documentation already exists in `/documentation/marketing-messages.md`

### 2. **Botserver: Handle messaging_optins Webhook**
   - **File**: `/botserver/server/handlers.js` (lines 32-44)
   - **Change**: Add `messaging_optins` to the `eventTypes` array or handle separately
   - **Payload structure**: `entry[].messaging_optins[].optin` contains:
     - `type: "notification_messages"` (or `"one_time_notif"`)
     - `notification_messages_token` or `one_time_notif_token`
     - `notification_messages_timezone` (for Marketing Messages only)
     - `token_expiry_timestamp`
     - `payload` — echo back payload from opt-in request
   - **Action**: Publish to same Kafka event topic as other events

### 3. **Replybot: Extend OPTIN Handler to Support Marketing Messages Type**
   - **File**: `/replybot/lib/typewheels/machine.js` (lines 447-460)
   - **Change**: Remove the type check `if (nxt.optin.type !== 'one_time_notif_req')` or extend it
   - **New logic**: 
     - Handle `type: "notification_messages"` → store token differently (in `state.notification_messages_tokens[]` or extended `state.tokens[]` with metadata)
     - OR reuse existing `state.tokens[]` and detect token type by field name (`one_time_notif_token` vs `notification_messages_token`)
   - **Storage**: Decide where to persist tokens:
     - Option A: Extend `state.tokens[]` to array of objects: `[{type: "otn", token: "..."}, {type: "marketing_messages", token: "..."}]`
     - Option B: Create separate `state.notification_messages_tokens[]` array
     - Option C: Store in user/state table with separate column (less ideal, requires schema change)

### 4. **Replybot: Update Message Sending to Use notification_messages_token**
   - **File**: `/replybot/lib/typewheels/machine.js` (lines 785-815 in `_response()` function)
   - **Change**: Extend recipient logic to check which token type to use:
     ```javascript
     // Pseudo-code
     if (hasNotificationMessagesToken) {
       return {
         recipient: { notification_messages_token: token },
         ...nextQuestion(...)
       }
     } else if (hasOTNToken) {
       return {
         recipient: { one_time_notif_token: token },
         ...nextQuestion(...)
       }
     }
     ```

### 5. **Form Definition: Add "marketing_messages" Question Type**
   - **File**: `/replybot/lib/typewheels/form.js` or Typeform translator
   - **What to do**: Extend to recognize and handle `type: "marketing_messages"` fields
   - **Output**: Generate Facebook `notification_messages` template payload with:
     - `template_type: "notification_messages"`
     - `title` (max 65 chars)
     - `notification_messages_cta_text` ("ALLOW", "GET", "GET_UPDATES", "OPT_IN", "SIGN_UP")
     - `notification_messages_timezone` (optional, defaults to "UTC")
     - `payload` (echo back to identify survey/user on webhook)

### 6. **Database Schema: Add Column to Store Notification Messages Tokens**
   - **File**: Database migration needed
   - **Table**: `states` (or new table `notification_tokens`)
   - **Change**: Either:
     - Add `notification_messages_tokens` JSONB column to `states` table
     - OR extend existing `state_json` to store tokens with type metadata

### 7. **Optional: Update Message Worker** 
   - **File**: `/message-worker/types/command.go`, `/message-worker/translator.go`
   - **If needed for async sending**: Add support for `notification_messages_token` recipient type in message translation
   - **Note**: May not be necessary if sticking with Replybot synchronous flow

---

## 7. Key Technical Insights

### Architecture Decisions:
1. **OTN and Marketing Messages use same webhook endpoint** — Both arrive as `messaging_optins` events with different `optin.type` values
2. **Tokens must be stored with type information** — Can't tell them apart by token string alone; need `type` field to distinguish "otn" vs "marketing_messages"
3. **Token usage is opt-in specific** — Tokens should only be used for sending messages outside 24-hour window; inside the window, use PSID
4. **Token expiry differs** — OTN tokens are one-use and expire immediately after use; Marketing Messages tokens expire if revoked or unused (stays active if user is opted in)

### Critical Bug Found:
**Botserver does not handle `messaging_optins` webhooks!** 
- The webhook is subscribed to (line 22 of `/dashboard-server/utils/facebook/facebook.util.js`)
- But `/botserver/server/handlers.js` only processes `messaging` and `messaging_handovers` events (lines 32-44)
- This means **OTN tokens are never received** in the current system
- **Fix required**: Add `messaging_optins` to handlers.js event processing

### State Machine Token Storage:
- Currently: `state.tokens[]` is a simple array of strings
- Future: Should be either array of objects `[{type, token, expiry?, metadata?}]` OR separate typed arrays

---

## 8. Files Affected & Change Summary

| File | Change | Impact |
|------|--------|--------|
| `/botserver/server/handlers.js` | Add `messaging_optins` to event processing | **Critical** — enables opt-in webhooks |
| `/replybot/lib/typewheels/machine.js` | Extend OPTIN handler, update recipient logic | **Critical** — handles tokens, sends messages |
| `/replybot/lib/typewheels/form.js` or Typeform translator | Add `notification_messages` field type support | **Important** — enables form field definition |
| `/documentation/questions.md` | Add `marketing_messages` question type docs | **Important** — survey creator guide |
| `Database migration` | Add `notification_messages_tokens` column/table | **Important** — token persistence |
| `/message-worker/` (optional) | Add `notification_messages_token` recipient support | Low priority if using Replybot sync flow |

---

## 9. Recommended Implementation Order

1. **Phase 1 (Core)**: Fix Botserver webhook handling
   - Add `messaging_optins` processing to handlers.js
   - Test receiving opt-in webhooks from Facebook

2. **Phase 2 (Token Storage)**: Extend Replybot token storage
   - Modify `state.tokens[]` to support multiple token types
   - Update OPTIN handler to store with type metadata

3. **Phase 3 (Message Sending)**: Update Replybot message recipient logic
   - Extend `respond()` and `_response()` to choose recipient based on token type
   - Ensure `notification_messages_token` recipient is used when appropriate

4. **Phase 4 (Form Support)**: Add question type to surveys
   - Implement `notification_messages` field type recognition
   - Generate correct Facebook template payload

5. **Phase 5 (Database)**: Persistent storage
   - Create migration for `notification_messages_tokens` column
   - Write to database for audit/debugging

6. **Phase 6 (Documentation & Testing)**: 
   - Update README files
   - Add tests for new template type
   - Document survey flow with marketing messages opt-in

---

## 10. Documentation Updates Needed

After implementation:

1. **`/replybot/README.md`**: Add section on Marketing Messages vs OTN tokens, token types, recipient selection logic
2. **`/documentation/marketing-messages.md`**: Already excellent; no changes needed (pre-written for this task!)
3. **`/documentation/questions.md`**: Add `notification_messages` field type (alongside existing `notify` type)
4. **`/botserver/README.md`**: Document webhook handling for `messaging_optins` events

