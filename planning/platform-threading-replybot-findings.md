# Platform Threading Through Replybot Pipeline — Findings

**Date:** 2026-07-22  
**Scope:** Trace platform value flow through replybot state machine to identify where it is available and where it currently drops off.

---

## Q1: OUTBOUND PLATFORM DETERMINATION (Critical Path)

**Question:** When replybot emits SendMessageCommand/HandoffCommand (fields: platform, platform_account_id), where exactly does the platform value come from?

### Answer: From triggering event's source.type (or fallback to persisted state)

The platform flows through this chain:

1. **Event Normalization → source.type** (`replybot/lib/event-normalizer.js:365-412`)
   - `parseEvent()` dispatches on `parsed.source` (string: 'messenger', 'whatsapp', 'synthetic')
   - Each parser (`parseMessengerEvent`, `parseWhatsAppEvent`, `parseSyntheticEvent`) returns `UniversalEvent` with `source: { type: "<platform>", account_id: "..." }`
   - For Messenger: `source: { type: 'messenger', account_id: pageId }` (line 207)
   - For WhatsApp: `source: { type: 'whatsapp', account_id: phone_number_id }` (line 358)
   - For Synthetic: `source: { type: 'synthetic', account_id: pageId }` (line 226)

2. **Transition logic → platform variable** (`replybot/lib/typewheels/transition.js:21-38`)
   - `Machine.transition(state, parsedEvent)` extracts platform at **lines 32-34**:
   ```javascript
   const platform = parsedEvent.source.type === 'synthetic'
     ? ((state && state.md && state.md.platform) || 'messenger')
     : parsedEvent.source.type
   ```
   - **If event is NOT synthetic:** platform = `event.source.type` (direct from normalizer)
   - **If event IS synthetic:** platform = `state.md.platform` (fall back to persisted state, default to 'messenger')
   - **This is the key decision point.** Line 31 has a TODO: `// TODO(whatsapp): persist md.platform at conversation start so this is exact.`

3. **Command Building → SendMessageCommand.platform** (`replybot/lib/typewheels/transition.js:68-95`)
   - `buildCommands(messages, handoff, user, page, platform)` receives the `platform` variable
   - Injects it into each command at **line 75** (SendMessageCommand) and **line 87** (HandoffCommand):
   ```javascript
   {
     type: 'send_message',
     platform: platform,        // ← Here (line 75)
     platform_account_id: page,
     ...
   }
   ```

### Test Evidence
- `machine.test.js` validates this path exists (multiple platform-handling tests pass with expected platform values)

---

## Q2: THE RE-ENTRY PATH BUG CHECK (Synthetic Events)

**Question:** For a WhatsApp user receiving a synthetic timeout/follow-up/repeat-payment event, what platform value ends up on the SendMessageCommand? Is there a latent wrong-platform bug?

### Answer: Yes, there is a latent bug. Synthetic events default to 'messenger' if state.md.platform is not persisted.

### Bug Mechanism

1. **Event Path for Synthetic:**
   - Dean/Hermes triggers synthetic event (e.g., timeout, follow-up, repeat-payment) → Kafka → Replybot
   - `parseEvent()` recognizes `source: 'synthetic'` → calls `parseSyntheticEvent()` (line 397, event-normalizer.js)
   - Returns `UniversalEvent` with `source: { type: 'synthetic', account_id: pageId }` (line 226)

2. **Transition Fallback Logic:**
   - At `transition.js:32-34`, synthetic events trigger the fallback:
   ```javascript
   const platform = parsedEvent.source.type === 'synthetic'
     ? ((state && state.md && state.md.platform) || 'messenger')
     : parsedEvent.source.type
   ```
   - Looks for `state.md.platform` — **but this field is NEVER persisted.**

3. **Where Platform Should Be Stored:**
   - When conversation starts (REFERRAL event), `machine.js` receives the triggering event's source.type
   - **Line 215 of machine.js** builds initial metadata:
   ```javascript
   md: { ...state.md, ...stitch.metadata, startTime: nxt.timestamp }
   ```
   - The `md` object includes:
     - `form`, `pageid`, `seed`, `referrer`, `startTime` (from `getMetadata()`, line 59-84 of utils.js)
     - But **NOT** `platform`

4. **What Gets Persisted to State:**
   - State JSON goes to both Redis cache (`statestore.js:88`) and states table (via `index.js:36-39`, `publishState()`)
   - Payload shape: `{ userid, pageid, updated, current_state, state_json }`
   - `state_json` contains full `state` object including `md`, but `md.platform` was never set

### Concrete WhatsApp Scenario

1. WhatsApp user starts survey via referral → platform='whatsapp' → state.md.platform is NOT set
2. Survey progresses, state persisted
3. Dean triggers timeout synthetic event → Kafka event with source='synthetic'
4. Replybot parses: synthetic event → looks for state.md.platform → **NOT FOUND** → defaults to 'messenger'
5. SendMessageCommand.platform = 'messenger' (WRONG!)
6. Message-worker routes to Messenger API, fails or sends to wrong platform

### Evidence of Missing Persistence

- `utils.js:59-84` `getMetadata()` extracts from referral: `form`, `startTime`, `pageid`, `seed`, but no `platform`
- `machine.js:215` captures metadata on conversation start; line 32-34 shows source.type is available but not stored
- Line 31 of transition.js has explicit TODO confirming this gap: `// TODO(whatsapp): persist md.platform at conversation start so this is exact.`

### Severity
**HIGH** — Any WhatsApp conversation that receives a synthetic timeout, follow-up, or repeat-payment event will produce wrong-platform commands.

---

## Q3: STATE PERSISTENCE

**Question:** How does replybot persist state? Does it write the states table directly or publish to Kafka?

### Answer: Publishes to Kafka topic (VLAB_STATE_TOPIC); another service consumes and writes states table.

### Flow

1. **Machine.run() produces report** (`index.js:59-95`)
   - After state machine transition, returns report object with fields: `{ newState, responses, commands, payment, ... }`

2. **publishState() publishes to Kafka** (`index.js:36-39`)
   ```javascript
   function publishState(userid, pageid, updated, state) {
     const message = { userid, pageid, updated, current_state: state.state, state_json: state }
     return produce(process.env.VLAB_STATE_TOPIC, message, userid)
   }
   ```
   - Payload shape:
     ```json
     {
       "userid": "...",
       "pageid": "...",
       "updated": <timestamp>,
       "current_state": "<state-name>",
       "state_json": { ... full state object ... }
     }
     ```
   - Called from `index.js:74` when `report.newState` exists

3. **Redis Cache Layer** (`statestore.js:86-89`)
   - Replybot also caches the latest state in Redis for quick access on next event
   - Key: `state:<userid>`, TTL: 24h (default)
   - Used by `getState()` (line 76-84) to avoid repeated DB queries

4. **Metadata Included in state_json**
   - Full state object, including `state.md` (the metadata map), is serialized to state_json
   - `md` persists: `{ form, pageid, seed, referrer, startTime, ...other fields... }`
   - **But platform is not in md**, so it doesn't get persisted

### To Include Platform in State Persistence

Would require:
1. Set `md.platform = parsedEvent.source.type` when conversation starts (machine.js:215)
2. Re-read platform from `md.platform` on synthetic events (already in transition.js, just add the persistence)
3. Verify platform survives round-trip through state_json serialization

---

## Q4: RESPONSE PERSISTENCE

**Question:** Who produces responses table payloads? What shape? Where does it get written?

### Answer: Replybot produces payload; published to Kafka (VLAB_RESPONSE_TOPIC); another service writes responses table.

### Flow

1. **responseVals() constructs payload** (`responses/responser.js:6-33`)
   ```javascript
   function responseVals(newState, update, form, surveyid, pageid, user, timestamp) {
     if (update) {
       const [q, response] = update  // question ref and response value
       
       return {
         parent_shortcode,      // from newState.md
         surveyid,
         shortcode,             // current form
         flowid,                // depth in form stack
         userid: user.id,
         pageid,                // ← From parameter (not from event)
         question_ref,
         question_idx,
         question_text,
         response,
         seed,                  // from newState.md
         metadata,              // full newState.md
         timestamp,
       }
     }
   }
   ```
   - **pageid comes from parameter**, passed from `actionsResponses()` (transition.js:40-59)
   - Which receives it as `page` from `transition()` (transition.js:21-38)
   - Traced back to event.source.account_id (never touches platform)

2. **publishResponses() publishes to Kafka** (`index.js:41-44`)
   ```javascript
   function publishResponses(message) {
     if (!message) return
     return produce(process.env.VLAB_RESPONSE_TOPIC, message, message.userid)
   }
   ```
   - Topic: `process.env.VLAB_RESPONSE_TOPIC`
   - Payload: response object from `responseVals()`

3. **Response Metadata Includes state.md**
   - Line 29 of responser.js: `metadata: newState.md`
   - So full `md` (including any platform field if it existed) would be persisted in responses table metadata column

4. **DB Write** (responser.js:71-89)
   - Another process (`stateman` or separate consumer) reads from Kafka and writes:
   ```sql
   INSERT INTO responses(parent_surveyid, parent_shortcode, surveyid, shortcode,
                         flowid, userid, question_ref, question_idx, question_text,
                         response, seed, metadata, timestamp)
   VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
   ```

### To Include Platform in Responses

Would require:
1. Add `platform` to `responseVals()` return payload (need to pass platform through actionsResponses chain)
2. Store in responses table metadata column (or add new platform column)
3. Ensure platform flows through state.md (from Q3 fix)

---

## Q5: PAYMENT EVENTS

**Question:** Where does replybot construct the payment event published to VLAB_PAYMENT_TOPIC? Exact file:line?

### Answer: Constructed in machine.js `_wrapSideEffect()` (line 710-718); published from index.js

### Flow

1. **Payment Extraction from Form Field** (`machine.js:702-730`)
   - Line 702-708: `getPayment()` reads payment from message metadata:
   ```javascript
   function getPayment(ctx, qa, ref) {
     const f = getField(ctx, ref)
     const message = translateField(ctx, qa, f)
     const { payment } = message.metadata || {}
     return payment
   }
   ```
   - Triggered when field has `properties.description` with `{ payment: { type, details } }` payload

2. **Side Effect Wrapping** (`machine.js:710-718`)
   ```javascript
   function _wrapSideEffect(ctx, data) {
     if (!data) return
     return {
       userid: ctx.user.id,
       pageid: ctx.page.id,
       timestamp: ctx.timestamp,
       ...data
     }
   }
   ```
   - **ctx.page.id is the pageid** (comes from event.source.account_id)
   - **NO platform field is added here**

3. **Payment Emitted via act()** (`machine.js:649-659`)
   ```javascript
   const payment = messages.map(m => getPaymentFromMessage(ctx, m)).find(p => p)
   return { messages, payment }
   ```

4. **Returned in Machine.run() report** (transition.js:150-167)
   ```javascript
   const { actions, responses, payment, handoff } = await this.actionsResponses(...)
   return {
     payment,
     commands,
     ...
   }
   ```

5. **Published to Kafka** (`index.js:46-48`)
   ```javascript
   function publishPayment(message) {
     return produce(process.env.VLAB_PAYMENT_TOPIC, message, message.userid)
   }
   ```
   - Called at line 81 when `report.payment` exists

### Payment Event Payload Shape

```json
{
  "userid": "...",
  "pageid": "...",
  "timestamp": <ms>,
  "type": "<provider>",
  "details": { ... }
}
```

**NOT platform-aware** — no platform field is set.

### Code Path Summary
- **machine.js:702** — getPayment() extracts from field metadata
- **machine.js:710-718** — _wrapSideEffect() wraps with userid, pageid, timestamp, spreads payment details
- **machine.js:657** — return { payment } from act()
- **transition.js:152** — payment passed through from actionsResponses()
- **index.js:81** — publishPayment(report.payment)
- **index.js:47** — produce() to VLAB_PAYMENT_TOPIC

### To Include Platform in Payment Events

- Add `platform: ctx.page.platform` to `_wrapSideEffect()` payload (requires platform to flow through context)
- OR pass platform separately to `_wrapSideEffect()` call sites

---

## Q6: FORMCENTRAL CALL (Survey Resolution)

**Question:** Trace lib/typewheels/ourform.js:36 (formcentral URL call). Where does pageid come from? Is platform/source.type available in scope?

### Answer: pageid comes from function parameter; platform/source.type is NOT available in scope.

### Code Path

1. **getForm() called from transition.js:49-50**
   ```javascript
   const [form, surveyId] = await iowrap('getForm', 'INTERNAL', this.getForm,
     pageId, shortcode, startTime)
   ```
   - pageId is passed as parameter from `actionsResponses()` (line 40)

2. **getForm() in ourform.js (lines 28-60)**
   ```javascript
   async function getForm(pageid, shortcode, timestamp) {
     if (!pageid || !shortcode || !timestamp) {
       throw new TypeError(...)
     }
     
     const { token, tokenType } = await getDashboardToken()
     const headers = { Authorization: `${tokenType} ${token}` }
     const url = `${process.env.FORMCENTRAL_URL}/surveys?pageid=${pageid}&shortcode=${shortcode}&timestamp=${timestamp}`
     const res = await fetch(url, { headers })
     
     const f = await res.json()
     ...
   }
   ```
   - **Line 36**: URL construction: `${process.env.FORMCENTRAL_URL}/surveys?pageid=${pageid}&shortcode=${shortcode}&timestamp=${timestamp}`
   - **pageid parameter** comes from event.source.account_id (traced back to transition.js:26)

3. **Platform Not Available at Call Site**
   - getForm() is called from `actionsResponses()` in transition.js
   - At that point, `platform` variable was calculated in `transition()` method (line 32-34)
   - But `actionsResponses()` (line 40) does NOT receive platform as parameter
   - Only receives: `state, userId, timestamp, pageId, newState, output`

### Formcentral Query (What it does)
- Looks up user by pageid (and other params)
- Resolves survey by (shortcode, userid)
- Returns form structure, surveyid, off_time, messages
- **Does not care about platform** (pageid is the account_id, which is platform-agnostic per documentation/platform-abstraction.md)

### To Include Platform Here

Would require:
1. Pass `platform` as parameter to `getForm()` (optional, for informational logging only)
2. OR pass through to `actionsResponses()` so it can be available to downstream callers
3. But formcentral query itself is correctly platform-agnostic (uses pageid only)

---

## Gaps & Risks Summary

### CRITICAL GAPS

1. **Platform NOT persisted in state.md** (`machine.js:215`, `utils.js:59-84`)
   - When conversation starts, source.type is available but never saved to state.md
   - Line 31 of transition.js has explicit TODO acknowledging this
   - **Risk:** Every synthetic re-entry (timeout, follow-up, repeat-payment) on WhatsApp will default to 'messenger'

2. **Synthetic events have no platform signal** (`event-normalizer.js:214-231`)
   - Synthetic events are tagged source.type = 'synthetic' by Hermes
   - They carry no indication of the real platform (messenger, whatsapp, etc.)
   - Fall back to state.md.platform (which isn't set) → default to 'messenger'
   - **Risk:** Wrong-platform bug on all synthetic re-entries for any non-Messenger platform

### MEDIUM GAPS

3. **Payment events don't include platform** (`machine.js:710-718`)
   - _wrapSideEffect() doesn't add platform to payload
   - Dinersclub/payment provider won't know which platform the payment came from
   - **Risk:** Payment events are platform-blind; downstream services can't route by platform

4. **Responses don't explicitly include platform** (`responser.js:6-33`)
   - Platform is NOT in response payload shape
   - It IS in metadata.state.md IF we fix gap #1
   - **Risk:** Responses can't be filtered/analyzed by platform at DB layer

5. **Command building doesn't validate platform** (`transition.js:68-95`)
   - buildCommands() accepts any platform string, doesn't validate it's real
   - Message-worker will reject unknown platforms, but earlier in pipeline is better

### DESIGN DECISIONS TO CONFIRM

1. Should platform be stored in state.md on every event, or just conversation_started?
   - **Recommendation:** Store once at conversation start (REFERRAL); reuse from state for all subsequent events (including synthetic)
   - This handles the common case efficiently without redundant writes

2. Should payment events include platform?
   - **Recommendation:** YES — dinersclub needs it for provider routing and debugging
   - Add to _wrapSideEffect() payload

3. Should responses include platform explicitly?
   - **Recommendation:** Track in metadata (which we're fixing) rather than duplicate column
   - Metadata will contain state.md.platform after fix #1

---

## Immediate Action Items for Platform Threading

1. **Fix: Persist platform in state.md on REFERRAL**
   - Edit `machine.js:215` to include platform in initial md
   - Use `getMetadata(event)` + spread source.type into md.platform

2. **Verify: Platform flows from event through state to synthetic re-entry**
   - Confirm transition.js line 32-34 uses persisted platform correctly
   - Add test case: WhatsApp user → timeout synthetic event → confirm platform='whatsapp'

3. **Enhancement: Add platform to payment event wrapper**
   - Edit `machine.js:710-718` _wrapSideEffect() to include platform
   - Requires platform in ctx (thread it through act() and getPayment() call sites)

4. **Documentation: Update transition.js line 31 TODO**
   - Remove TODO after implementing platform persistence
   - Add comment explaining synthetic event fallback logic

---

## File Reference Index

| File | Lines | Purpose |
|------|-------|---------|
| event-normalizer.js | 365-412 | parseEvent() dispatcher; returns UniversalEvent with source.type |
| event-normalizer.js | 186-212 | parseMessengerEvent() → source.type = 'messenger' |
| event-normalizer.js | 347-363 | parseWhatsAppEvent() → source.type = 'whatsapp' |
| event-normalizer.js | 214-231 | parseSyntheticEvent() → source.type = 'synthetic' |
| transition.js | 21-38 | Machine.transition(): platform decision logic (line 32-34 CRITICAL) |
| transition.js | 68-95 | buildCommands(): inject platform into SendMessageCommand |
| transition.js | 40-59 | actionsResponses(): receives pageId (not platform) |
| machine.js | 59 | getMetadata(event): extracts referral; sets pageid but NOT platform |
| machine.js | 215 | REFERRAL case: builds initial state.md (missing platform) |
| machine.js | 710-718 | _wrapSideEffect(): wraps payment/side-effects (missing platform) |
| ourform.js | 28-36 | getForm(): formcentral URL construction (pageid only, correct) |
| index.js | 36-39 | publishState(): publishes to VLAB_STATE_TOPIC |
| index.js | 41-44 | publishResponses(): publishes to VLAB_RESPONSE_TOPIC |
| index.js | 46-48 | publishPayment(): publishes to VLAB_PAYMENT_TOPIC |
| statestore.js | 86-89 | updateState(): Redis cache write |
| responser.js | 6-33 | responseVals(): response payload shape (has metadata but not explicit platform) |

