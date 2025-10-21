# Facebook Messenger Handoff Protocol Implementation Specification

## Overview

This document specifies the implementation of Facebook Messenger handoff protocol support in replybot, allowing survey creators to hand off users to external chatbot applications and seamlessly resume surveys when control returns.

## Design Philosophy

The implementation reuses existing `WAIT_EXTERNAL_EVENT` infrastructure to minimize code changes and maintain consistency with current patterns. Users can compose handoff behavior using flexible wait conditions, following vlab/fly's philosophy of exposing lower-level primitives.

## Architecture Integration

### Current Architecture
- **Botserver** (`botserver/server/index.js`): Handles Facebook webhook events, forwards to Kafka
- **Replybot** (`replybot/lib/index.js`): Processes events from Kafka, manages survey state
- **Messenger Module** (`replybot/lib/messenger/index.js`): Facebook API calls with retry logic
- **Wait System** (`replybot/lib/typewheels/waiting.js`): External event waiting with OR/AND logic

### Integration Points
1. **Botserver webhook** adds `messaging_handovers` event handling
2. **Messenger module** adds handoff API functions
3. **Event processor** converts handover events to synthetic external events
4. **Machine logic** reuses existing `WAIT_EXTERNAL_EVENT` state

## Implementation Components

### 1. Botserver Webhook Enhancement

**File:** `botserver/server/index.js`

**Current function:** `handleMessengerEvents()` processes `entry.messaging` events

**Enhancement:** Add support for `entry.messaging_handovers` events

```javascript
// Update handleMessengerEvents function
const handleMessengerEvents = async (ctx) => {
  await producerReady

  for (const entry of ctx.request.body.entry) {
    try {
      console.log(util.inspect(entry, null, 8))

      // EXISTING: Handle messaging events
      if (entry.messaging) {
        const message = { ...entry.messaging[0], source: 'messenger' }
        message.timestamp = normalizeTimestamp(message.timestamp)
        const user = getUserFromEvent(message)
        const data = Buffer.from(JSON.stringify(message))
        producer.produce(EVENT_TOPIC, null, data, user)
      }

      // NEW: Handle handover events
      if (entry.messaging_handovers) {
        const handover = { ...entry.messaging_handovers[0], source: 'messenger_handover' }
        handover.timestamp = normalizeTimestamp(handover.timestamp)
        const user = getUserFromEvent(handover)
        const data = Buffer.from(JSON.stringify(handover))
        producer.produce(EVENT_TOPIC, null, data, user)
      }

    } catch (error) {
      console.error('[ERR] handleEvents: ', error)
    }
  }
  ctx.status = 200
}
```

**Key Points:**
- Uses existing producer/Kafka infrastructure
- Follows same pattern as messaging events
- Sets `source: 'messenger_handover'` to distinguish from regular messages

### 2. Replybot Messenger API Extension

**File:** `replybot/lib/messenger/index.js`

**Enhancement:** Add handoff functions using existing patterns

```javascript
// Add to existing exports
async function passThreadControl(userId, targetAppId, metadata, pageToken) {
  const headers = { Authorization: `Bearer ${pageToken}` }
  const url = `${BASE_URL}/me/pass_thread_control`
  const data = {
    recipient: { id: userId },
    target_app_id: targetAppId,
    metadata: JSON.stringify(metadata || {})
  }
  const fn = () => r2.post(url, { headers, json: data }).json
  return await facebookRequest(fn)
}

async function takeThreadControl(userId, metadata, pageToken) {
  const headers = { Authorization: `Bearer ${pageToken}` }
  const url = `${BASE_URL}/me/take_thread_control`
  const data = {
    recipient: { id: userId },
    metadata: JSON.stringify(metadata || {})
  }
  const fn = () => r2.post(url, { headers, json: data }).json
  return await facebookRequest(fn)
}

async function getThreadOwner(userId, pageToken) {
  const headers = { Authorization: `Bearer ${pageToken}` }
  const url = `${BASE_URL}/${userId}/thread_owner`
  const fn = () => r2.get(url, { headers }).json
  return await facebookRequest(fn)
}

// Update module exports
module.exports = {
  sendMessage,
  getUserInfo,
  passThreadControl,
  takeThreadControl,
  getThreadOwner
}
```

**Key Points:**
- Reuses existing `facebookRequest()` retry logic and error handling
- Follows same pattern as `sendMessage()` for consistency
- Leverages existing `MachineIOError` handling

### 3. Replybot Event Processing

**File:** `replybot/lib/index.js`

**Enhancement:** Handle messenger handover events in main processor

```javascript
// Add helper function to convert handover events
function convertHandoverToExternal(handoverEvent, userId) {
  const { pass_thread_control } = handoverEvent

  if (!pass_thread_control) return null

  // Only process if control passed back to our app
  // Note: new_owner_app_id may be missing in some Messenger API webhook payloads
  if (pass_thread_control.new_owner_app_id &&
      pass_thread_control.new_owner_app_id !== process.env.FACEBOOK_APP_ID) {
    return null
  }

  const metadata = JSON.parse(pass_thread_control.metadata || '{}')

  return {
    source: 'synthetic',
    timestamp: handoverEvent.timestamp,
    sender: { id: userId },
    event: {
      type: 'external',
      value: {
        type: 'handoff_return',
        target_app_id: pass_thread_control.previous_owner_app_id,
        ...metadata
      }
    }
  }
}

// Update processor function
function processor(machine, stateStore) {
  return async function _processor({ key: userId, value: event }) {
    try {
      console.log('EVENT: ', event)

      // NEW: Convert handover events to synthetic external events
      if (event.source === 'messenger_handover') {
        const syntheticEvent = convertHandoverToExternal(event, userId)
        if (syntheticEvent) {
          // Recursively process the synthetic event
          await _processor({ key: userId, value: JSON.stringify(syntheticEvent) })
        }
        return
      }

      const state = await stateStore.getState(userId, event)
      console.log('STATE: ', state)
      const report = await machine.run(state, userId, event)
      console.log('REPORT: ', report)

      // ... rest of existing logic unchanged
      if (report.publish) {
        await publishReport(report)
      }
      if (report.newState) {
        await publishState(report.user, report.page, report.timestamp, report.newState)
        await stateStore.updateState(userId, report.newState)
      }
      if (report.responses) {
        await publishResponses(report.responses)
      }
      if (report.payment) {
        await publishPayment(report.payment)
      }
    }
    catch (e) {
      console.error('Error from ReplyBot: \n',
        e.message,
        '\n Error occured during event: ', util.inspect(JSON.parse(event), null, 8))
      console.error(e.stack)
    }
  }
}
```

**Key Points:**
- Converts Facebook handover events to replybot synthetic external events
- Validates that control was passed to our app (security check)
- Supports handoff return with optional metadata
- Reuses existing event processing pipeline

### 4. Question Type Parsing

**File:** `replybot/lib/typewheels/form.js`

**Enhancement:** Add handoff question parsing to `addCustomType` function

```javascript
// Add to the switch statement in addCustomType function
case 'handoff':
  const wait = config.wait || { type: 'timeout', value: `${config.timeout_minutes || 60}m` }

  return {
    ...question,
    handoff: {
      target_app_id: config.target_app_id,
      wait: wait,
      metadata: {
        survey_id: config.survey_id,
        question_ref: question.ref,
        ...config.metadata
      }
    }
  }
```

**Key Points:**
- Follows existing pattern from webview/stitch parsing
- Defaults to simple timeout if no wait condition provided
- Includes survey context in metadata for external apps

### 5. Machine Logic Enhancement

**File:** `replybot/lib/typewheels/machine.js`

**Enhancement:** Add handoff processing and timeout handling

```javascript
// Add import for messenger functions
const { passThreadControl, takeThreadControl } = require('../messenger')

// In message processing logic, add after stitch/wait checks:
if (md.handoff) {
  // Execute handoff
  try {
    await passThreadControl(
      userId,
      md.handoff.target_app_id,
      md.handoff.metadata,
      process.env.FACEBOOK_PAGE_ACCESS_TOKEN
    )
  } catch (error) {
    console.error('Handoff failed:', error)
    // Continue with timeout-only wait as fallback
  }

  return {
    action: 'WAIT_EXTERNAL_EVENT',
    question: md.ref,
    wait: md.handoff.wait,
    waitStart: state.waitStart || nxt.timestamp,
    handoffContext: {
      target_app_id: md.handoff.target_app_id,
      started_at: nxt.timestamp
    }
  }
}

// Add timeout handler for taking control back
// In external event processing, check for timeout during handoff:
if (nxt.event.type === 'timeout' &&
    state.state === 'WAIT_EXTERNAL_EVENT' &&
    state.handoffContext) {

  console.log('Handoff timeout, taking control back')
  try {
    await takeThreadControl(
      userId,
      {
        reason: 'timeout',
        original_target: state.handoffContext.target_app_id,
        handoff_duration_ms: nxt.timestamp - state.handoffContext.started_at
      },
      process.env.FACEBOOK_PAGE_ACCESS_TOKEN
    )
  } catch (error) {
    console.error('Take control failed:', error)
  }
}
```

**Key Points:**
- Reuses existing `WAIT_EXTERNAL_EVENT` action
- Stores handoff context for timeout handling
- Gracefully handles API failures by falling back to timeout-only wait
- Takes control back on timeout to ensure survey can continue

## Question Format Specifications

### Basic Handoff Question

**Typeform Description Field:**
```
type: handoff
target_app_id: 123456789
timeout_minutes: 30
```

**Generated Question Structure:**
```javascript
{
  type: 'statement',
  ref: 'customer_service',
  title: 'Connecting you to customer service...',
  properties: {
    description: 'type: handoff\ntarget_app_id: 123456789\ntimeout_minutes: 30'
  },
  handoff: {
    target_app_id: '123456789',
    wait: { type: 'timeout', value: '30m' },
    metadata: {
      survey_id: undefined,
      question_ref: 'customer_service'
    }
  }
}
```

### Advanced Handoff Question

**Typeform Description Field:**
```json
{
  "type": "handoff",
  "target_app_id": "987654321",
  "wait": {
    "op": "or",
    "vars": [
      {"type": "external", "value": {"type": "handoff_return", "target_app_id": "987654321"}},
      {"type": "timeout", "value": "45m"}
    ]
  },
  "metadata": {
    "user_intent": "purchase",
    "product_category": "enterprise"
  }
}
```


## External Event Types

### 1. handoff_return
Generated when external app passes thread control back normally.

```javascript
{
  type: 'external',
  value: {
    type: 'handoff_return',
    target_app_id: '123456789',
    timestamp: 1640995200000
  }
}
```

## Metadata Handling

External apps can include metadata when returning thread control, which will be automatically flattened and stored in the user's state metadata. This allows external apps to pass information back to the survey.

### Metadata Flattening Process

The existing `makeEventMetadata` function automatically flattens nested metadata objects using the `_eventMetadata` helper. For handoff events, metadata is flattened with the prefix `e_handover_`.

**Example External App Metadata:**
```json
{
  "completion_status": "success",
  "assessment_results": {
    "reading_level": 8,
    "comprehension_score": 75
  },
  "recommendations": ["literacy_support", "advanced_content"],
  "participant_needs": {
    "language_preference": "spanish",
    "requires_assistance": true
  }
}
```

**Flattened Metadata Added to State:**
```javascript
{
  e_handover_completion_status: "success",
  e_handover_assessment_results_reading_level: 8,
  e_handover_assessment_results_comprehension_score: 75,
  e_handover_recommendations_0: "literacy_support",
  e_handover_recommendations_1: "advanced_content",
  e_handover_participant_needs_language_preference: "spanish",
  e_handover_participant_needs_requires_assistance: true
}
```

### Usage in Survey Logic

The flattened metadata becomes available as hidden fields in survey logic and question interpolation:

```javascript
// In survey logic conditions
{{hidden:e_handover_completion_status}} // "success"
{{hidden:e_handover_assessment_results_reading_level}} // 8

// In question text
"Based on your reading level assessment of grade {{hidden:e_handover_assessment_results_reading_level}}, we have prepared appropriate materials..."

// In survey branching logic
if ({{hidden:e_handover_participant_needs_requires_assistance}} == true) {
  // Show questions with additional support options
}
```

### Implementation Details

The metadata processing happens automatically through the existing event metadata system:

1. External app calls `pass_thread_control` with metadata
2. Handover event converted to synthetic external event (includes all metadata)
3. `makeEventMetadata` function processes the external event
4. Metadata flattened with `e_handover_` prefix
5. Flattened metadata merged into user state via existing `md` update process

**No additional code required** - the existing metadata flattening infrastructure handles handoff metadata automatically.

## Test Cases

### Test Case 1: Basic Timeout Handoff

**Scenario:** External app never returns control, timeout after 60 minutes

**Setup:**
```javascript
const handoffQuestion = {
  type: 'statement',
  ref: 'customer_service',
  properties: {
    description: 'type: handoff\ntarget_app_id: 123456789\ntimeout_minutes: 60'
  }
}
```

**Expected Flow:**
1. User reaches handoff question
2. `passThreadControl()` called with target_app_id `123456789`
3. State becomes `WAIT_EXTERNAL_EVENT` with timeout wait condition
4. After 60 minutes, timeout external event generated by existing wait system
5. `takeThreadControl()` called to reclaim control
6. Survey resumes from next question

**Verification Points:**
- Facebook API calls logged with correct parameters
- State properly transitions to `WAIT_EXTERNAL_EVENT`
- Timeout event processed correctly
- Survey continues after timeout

### Test Case 2: Proper Return via Handover Protocol

**Scenario:** External app properly returns control via Facebook handover API

**Setup:**
```javascript
const handoffQuestion = {
  type: 'statement',
  ref: 'sales_chat',
  properties: {
    description: JSON.stringify({
      type: 'handoff',
      target_app_id: '987654321',
      wait: {
        op: 'or',
        vars: [
          { type: 'external', value: { type: 'handoff_return', target_app_id: '987654321' } },
          { type: 'timeout', value: '30m' }
        ]
      }
    })
  }
}
```

**Test Flow:**
1. User reaches handoff question
2. Thread control passed to app `987654321`
3. External app processes user for 10 minutes
4. External app calls Facebook `pass_thread_control` back to our app
5. Botserver receives webhook with `messaging_handovers` event
6. Event forwarded to Kafka as `source: 'messenger_handover'`
7. Replybot processes handover event
8. Synthetic `handoff_return` external event generated
9. Wait condition fulfilled immediately (before 30m timeout)
10. Survey resumes from next question

**Mock Webhook Event:**
```json
{
  "entry": [{
    "messaging_handovers": [{
      "sender": {"id": "user123"},
      "recipient": {"id": "page456"},
      "timestamp": 1640995200000,
      "pass_thread_control": {
        "new_owner_app_id": "our_app_id",
        "previous_owner_app_id": "987654321",
        "metadata": "{\"completion_status\": \"success\", \"reading_level\": 8}"
      }
    }]
  }]
}
```

**Note:** The `new_owner_app_id` field may be missing in some Messenger API webhook payloads. When this field is absent, replybot will accept the handover event (assuming control is being passed back to our app). To handle cases where `new_owner_app_id` might be missing, use a wait condition without a `value` field (or with an empty value):

```yaml
wait:
  op: or
  vars:
    - type: handover        # Accept any handover event (value is optional)
    - type: timeout
      value: 60m
```

This will match any handover event regardless of the `target_app_id`. If you want to match only handovers from a specific app, include the `value` field:

```yaml
wait:
  op: or
  vars:
    - type: handover
      value:
        target_app_id: '123456789'  # Only accept handovers from this specific app
    - type: timeout
      value: 60m
```

### Test Case 3: Metadata Processing

**Scenario:** External app returns control with structured metadata that gets flattened into state

**Setup:**
```javascript
const handoffQuestion = {
  type: 'statement',
  ref: 'literacy_assessment',
  properties: {
    description: JSON.stringify({
      type: 'handoff',
      target_app_id: '555666777',
      wait: {
        op: 'or',
        vars: [
          { type: 'external', value: { type: 'handoff_return', target_app_id: '555666777' } },
          { type: 'timeout', value: '30m' }
        ]
      }
    })
  }
}
```

**Test Flow:**
1. User reaches handoff question
2. Thread control passed to literacy assessment app
3. External app conducts reading comprehension test and evaluates participant needs
4. External app calls `pass_thread_control` with metadata:
   ```json
   {
     "completion_status": "success",
     "assessment_results": {
       "reading_level": 6,
       "comprehension_score": 82,
       "completed_modules": 3
     },
     "recommendations": ["literacy_support", "visual_aids"],
     "participant_profile": {
       "preferred_language": "portuguese",
       "needs_audio_support": true
     }
   }
   ```
5. Handover event processed and `makeEventMetadata` called
6. Metadata flattened with `e_handover_` prefix
7. State updated with flattened metadata:
   ```javascript
   {
     e_handover_completion_status: "success",
     e_handover_assessment_results_reading_level: 6,
     e_handover_assessment_results_comprehension_score: 82,
     e_handover_assessment_results_completed_modules: 3,
     e_handover_recommendations_0: "literacy_support",
     e_handover_recommendations_1: "visual_aids",
     e_handover_participant_profile_preferred_language: "portuguese",
     e_handover_participant_profile_needs_audio_support: true
   }
   ```
8. Survey resumes with metadata available as hidden fields
9. Next questions can use metadata for logic: `{{hidden:e_handover_assessment_results_reading_level}}`

**Verification Points:**
- Nested objects flattened correctly with underscore separation
- Arrays converted to indexed keys (recommendations_0, recommendations_1)
- Metadata available in subsequent survey logic
- Existing metadata flattening logic handles all data types (strings, numbers, arrays, objects)


### Test Case 4: Wrong App Returns Control (Security)

**Scenario:** Different app tries to return control

**Setup:**
- Handoff to app `123456789`
- App `999888777` tries to pass control back

**Test Flow:**
1. Handoff executed to correct app `123456789`
2. Different app `999888777` calls `pass_thread_control`
3. Botserver receives handover webhook
4. `convertHandoverToExternal()` checks `previous_owner_app_id`
5. App ID doesn't match expected `123456789`
6. Event ignored, no synthetic event generated
7. User remains in `WAIT_EXTERNAL_EVENT` state
8. Timeout eventually triggers and reclaims control

**Security Check Code:**
```javascript
// In convertHandoverToExternal function
if (pass_thread_control.previous_owner_app_id !== expectedAppId) {
  console.log('Handover from unexpected app ignored:', pass_thread_control.previous_owner_app_id)
  return null
}
```

### Test Case 5: Facebook API Failures

**Scenario:** `passThreadControl` fails with temporary error

**Test Flow:**
1. Handoff question processed
2. `passThreadControl()` called
3. Facebook API returns error code 1200 (temporary failure)
4. Messenger module retries with exponential backoff (existing retry logic)
5. Second attempt succeeds after 400ms delay
6. Wait state properly established
7. Handoff completes successfully

**Error Handling:**
```javascript
// In machine.js handoff processing
try {
  await passThreadControl(userId, targetAppId, metadata, pageToken)
} catch (error) {
  console.error('Handoff failed, continuing with timeout-only wait:', error)
  // Wait condition still works, just timeout-based
}
```

### Test Case 6: Concurrent Events

**Scenario:** Handover return and timeout occur simultaneously

**Test Flow:**
1. User in `WAIT_EXTERNAL_EVENT` for 29 minutes 50 seconds
2. External app returns control at 29:55
3. Timeout event also generated at 30:00
4. Both events processed through existing wait system
5. First event (handover return) wins due to existing wait fulfillment logic
6. Survey resumes normally
7. Timeout event ignored (wait already fulfilled)

## Configuration Requirements

### Environment Variables

**Botserver (existing):**
```bash
BOTSERVER_EVENT_TOPIC=events
VERIFY_TOKEN=your_verify_token
```

**Replybot (existing + new):**
```bash
# Existing
FACEBOOK_PAGE_ACCESS_TOKEN=your_page_token
FACEBOOK_GRAPH_URL=https://graph.facebook.com/v8.0
FACEBOOK_RETRIES=5
FACEBOOK_BASE_RETRY_TIME=400

# NEW - Required for handoff validation
FACEBOOK_APP_ID=your_app_id
```

### Facebook App Configuration

1. **Webhook Subscriptions**
   - Add `messaging_handovers` to existing webhook subscriptions
   - Existing `messages` subscription remains unchanged
   - Webhook URL stays the same: `https://your-domain/webhooks`

2. **App Roles**
   - Configure app as **Primary Receiver**
   - External apps will be **Secondary Receivers**

3. **Permissions**
   - Ensure `pages_messaging` permission includes handover capabilities
   - No additional permissions required

### Page Setup

1. **Page Access Token**
   - Must have handover permissions
   - Same token used for existing messaging

2. **App Configuration**
   - Link page to Facebook Business Manager
   - Configure handover settings in Page Settings > Messenger

## Error Handling & Edge Cases

### 1. Facebook API Failures

**passThreadControl fails:**
```javascript
try {
  await passThreadControl(userId, targetAppId, metadata, pageToken)
} catch (error) {
  console.error('Handoff failed:', error)
  // Continue with timeout-only wait as fallback
  // User will still get survey completion via timeout
}
```

**takeThreadControl fails on timeout:**
```javascript
try {
  await takeThreadControl(userId, metadata, pageToken)
} catch (error) {
  console.error('Take control failed:', error)
  // Log error but continue - survey will proceed anyway
  // External app may still have control but survey continues
}
```

### 2. Invalid Configuration

**Missing target_app_id:**
```javascript
// In form.js parsing
if (!config.target_app_id) {
  throw new Error(`Handoff question ${question.ref} missing required target_app_id`)
}
```

**Invalid wait condition:**
```javascript
// Fallback to simple timeout
const wait = config.wait || { type: 'timeout', value: `${config.timeout_minutes || 60}m` }
```

### 3. Malformed Webhook Data

**Invalid handover structure:**
```javascript
function convertHandoverToExternal(handoverEvent, userId) {
  try {
    const { pass_thread_control } = handoverEvent
    if (!pass_thread_control) return null

    // ... processing logic
  } catch (error) {
    console.error('Invalid handover event:', error)
    return null // Event ignored
  }
}
```

**Unparseable metadata:**
```javascript
const metadata = JSON.parse(pass_thread_control.metadata || '{}')
// If JSON.parse fails, falls back to empty object
```

### 4. State Consistency

**User sends message during handoff:**
- Message processed normally by external app (they have control)
- No special handling needed in replybot
- If external app silently returns control, next user message will be processed normally

**Multiple rapid handoffs:**
- Each handoff processed independently
- Existing wait system handles event ordering
- Last handoff wins (overwrites previous wait condition)

## Future Enhancements

### 1. User Message Wait Type

Add support for detecting user messages during handoff:

```javascript
// New wait condition type
{ type: 'user_message' }

// Combined with handoff return
{
  op: 'or',
  vars: [
    { type: 'external', value: { type: 'handoff_return', target_app_id: '123' } },
    { type: 'user_message' },
    { type: 'timeout', value: '60m' }
  ]
}
```

### 2. Enhanced Metadata Exchange

Support for structured data exchange:

```javascript
// External app returns structured data
{
  "completion_status": "success",
  "user_data": {
    "lead_score": 85,
    "interested_products": ["enterprise", "analytics"]
  },
  "next_action": "schedule_demo"
}

// Data available in survey logic as hidden fields
{{hidden:handoff_lead_score}} // 85
{{hidden:handoff_interested_products}} // "enterprise,analytics"
```

### 3. Handoff Analytics

Track handoff performance and success rates:

```javascript
// Log handoff events for analytics
const handoffMetrics = {
  handoff_started: nxt.timestamp,
  target_app_id: targetAppId,
  timeout_configured: timeoutMinutes,
  // ... completion tracking
}
```

### 4. Multi-Step Handoffs

Support chaining multiple external apps:

```javascript
{
  type: 'handoff_chain',
  steps: [
    { target_app_id: '111', timeout_minutes: 15 }, // Triage
    { target_app_id: '222', timeout_minutes: 30 }  // Specialist
  ]
}
```

## Testing Strategy

### Unit Tests

**Messenger Module:**
```javascript
describe('passThreadControl', () => {
  it('should call Facebook API with correct parameters', async () => {
    // Mock r2.post
    // Test API call structure
    // Verify retry logic
  })

  it('should handle Facebook API errors', async () => {
    // Mock API failure
    // Verify MachineIOError thrown
    // Test retry behavior
  })
})
```

**Event Processing:**
```javascript
describe('convertHandoverToExternal', () => {
  it('should convert handover return to external event', () => {
    const handoverEvent = {
      pass_thread_control: {
        new_owner_app_id: 'our_app',
        previous_owner_app_id: '123456',
        metadata: '{}'
      }
    }

    const result = convertHandoverToExternal(handoverEvent, 'user123')
    expect(result.event.value.type).to.equal('handoff_return')
  })

  it('should include metadata in external event', () => {
    const handoverEvent = {
      pass_thread_control: {
        new_owner_app_id: 'our_app',
        previous_owner_app_id: '123456',
        metadata: '{"reading_level": 6, "status": "completed"}'
      }
    }

    const result = convertHandoverToExternal(handoverEvent, 'user123')
    expect(result.event.value.reading_level).to.equal(6)
    expect(result.event.value.status).to.equal('completed')
  })

  it('should ignore handovers from wrong apps', () => {
    // Test security validation
  })
})

**Metadata Processing:**
```javascript
describe('makeEventMetadata', () => {
  it('should flatten handoff return metadata', () => {
    const event = {
      event: {
        type: 'external',
        value: {
          type: 'handoff_return',
          target_app_id: '123456',
          assessment_results: {
            reading_level: 7,
            comprehension_score: 88
          },
          recommendations: ['literacy_support', 'advanced_materials']
        }
      }
    }

    const metadata = makeEventMetadata(event)
    expect(metadata).to.deep.equal({
      e_handover_target_app_id: '123456',
      e_handover_assessment_results_reading_level: 7,
      e_handover_assessment_results_comprehension_score: 88,
      e_handover_recommendations_0: 'literacy_support',
      e_handover_recommendations_1: 'advanced_materials'
    })
  })

  it('should handle empty metadata gracefully', () => {
    const event = {
      event: {
        type: 'external',
        value: {
          type: 'handoff_return',
          target_app_id: '123456'
        }
      }
    }

    const metadata = makeEventMetadata(event)
    expect(metadata.e_handover_target_app_id).to.equal('123456')
  })
})
```

### Integration Tests

**End-to-End Handoff Flow:**
```javascript
describe('Handoff Integration', () => {
  it('should complete full handoff cycle', async () => {
    // 1. Start with user at handoff question
    // 2. Mock Facebook API calls
    // 3. Simulate handover return webhook
    // 4. Verify survey continues
  })

  it('should complete handoff cycle with metadata', async () => {
    // 1. Start with user at handoff question
    // 2. Mock Facebook API calls
    // 3. Simulate handover return webhook with metadata
    // 4. Verify metadata flattened and added to state
    // 5. Verify survey continues with metadata available
    // 6. Test metadata usage in subsequent questions
  })

  it('should handle timeout scenario', async () => {
    // 1. Start handoff
    // 2. Don't return control
    // 3. Fast-forward time
    // 4. Verify timeout triggers takeThreadControl
    // 5. Verify survey continues
  })
})
```

**Webhook Integration:**
```javascript
describe('Botserver Webhook', () => {
  it('should process handover events', async () => {
    // Mock webhook payload
    // Verify Kafka event produced
    // Check event structure
  })
})
```

### Mock Data

**Facebook Handover Webhook:**
```json
{
  "object": "page",
  "entry": [{
    "id": "page123",
    "time": 1640995200000,
    "messaging_handovers": [{
      "sender": {"id": "user123"},
      "recipient": {"id": "page123"},
      "timestamp": 1640995200000,
      "pass_thread_control": {
        "new_owner_app_id": "our_app_id",
        "previous_owner_app_id": "external_app_id",
        "metadata": "{\"status\": \"complete\"}"
      }
    }]
  }]
}
```


## Backwards Compatibility

- ✅ No breaking changes to existing functionality
- ✅ New handoff questions work alongside existing webview/stitch/wait questions
- ✅ Existing wait logic unchanged and fully reused
- ✅ Existing Facebook API patterns maintained
- ✅ Botserver webhook handling extended, not modified

## Implementation Checklist

### Phase 1: Core Implementation
- [ ] Add `messaging_handovers` handling to botserver webhook
- [ ] Add handoff functions to replybot messenger module
- [ ] Add handover event processing to replybot main processor
- [ ] Add handoff question parsing to form.js
- [ ] Add handoff execution logic to machine.js
- [ ] Add environment variable `FACEBOOK_APP_ID`

### Phase 2: Testing & Validation
- [ ] Unit tests for new messenger functions
- [ ] Integration tests for handoff flow
- [ ] Mock webhook testing
- [ ] Error handling validation
- [ ] Security testing (wrong app scenarios)

### Phase 3: Documentation & Deployment
- [ ] Update Facebook app webhook subscriptions
- [ ] Configure app as Primary Receiver
- [ ] Test with real external app
- [ ] Monitor handoff success rates
- [ ] Document external app integration patterns

This specification provides a complete implementation guide that leverages existing replybot architecture while adding robust handoff protocol support with minimal code changes and maximum reuse of proven patterns.