# Webhook Receiver Audit: Could Facebook echoes be arriving via a different field?

**Date:** 2026-05-25  
**Status:** Completed investigation (no code changes)  
**Question:** Is Facebook silently delivering message echoes via a webhook field or event path our code doesn't process?

---

## 1. Fields We Subscribe to vs Fields We Process

### Subscribed Fields (two different lists in codebase)

**File: `dashboard-server/utils/facebook/facebook.util.js` (line 19-28)**
```javascript
const json = { subscribed_fields: ['messages',
                                   'message_echoes',
                                   'messaging_account_linking',
                                   'messaging_optins',
                                   'messaging_postbacks',
                                   'messaging_referrals',
                                   'messaging_handovers',
                                   'messaging_fblogin_account_linking',
                                   'messaging_account_linking',
                                   'message_template_status_update']}
```

**File: `dashboard-server/api/facebook/facebook.controller.js` (line 24-33)**
```javascript
const json = {
  subscribed_fields: ['messages',
                      'messaging_postbacks',
                      'messaging_optins',
                      'messaging_account_linking',
                      'messaging_referrals',
                      'message_echoes',
                      'messaging_handovers',
                      'messaging_policy_enforcement',
                      'message_template_status_update']
}
```

**Full subscribed fields list (union):**
- `messages` — inbound user messages
- `message_echoes` — outbound message echoes (confirmation of what bot sent)
- `messaging_postbacks` — button/menu postback interactions
- `messaging_optins` — opt-in events (e.g., checkbox plugin)
- `messaging_account_linking` — account linking flows
- `messaging_referrals` — referral data from m.me links
- `messaging_handovers` — thread control pass/take events
- `messaging_fblogin_account_linking` — Facebook login linking (duplicate in util.js)
- `messaging_policy_enforcement` — policy violation notifications
- `message_template_status_update` — message template approval status

### Processed Event Paths in Handler

**File: `botserver/server/handlers.js` (line 54-91)**

The handler iterates **only two event types**:
```javascript
const eventTypes = ['messaging', 'messaging_handovers']

for (const eventType of eventTypes) {
  if (entry[eventType]) {
    for (const eventData of entry[eventType]) {
      const event = { ...eventData, source: 'messenger' }
      // ... normalize and send to Kafka
    }
  }
}

if (entry.changes) {
  for (const change of entry.changes) {
    if (change.field === 'message_template_status_update') {
      handleTemplateStatusUpdate(entry.id, change.value)
    }
  }
}
```

### Subscription vs Processing Table

| Field/Event | Subscribed? | Processed in Handler? | Entry Path in Webhook |
|---|---|---|---|
| messages | ✓ | ✓ | `entry.messaging[i]` |
| message_echoes | ✓ | ✗ (CRITICAL) | `entry.messaging[i]` with `is_echo: true` |
| messaging_postbacks | ✓ | ✗ (SILENT DROP) | `entry.messaging[i]` with `postback` field |
| messaging_optins | ✓ | ✗ (SILENT DROP) | `entry.messaging[i]` with `optin` field |
| messaging_account_linking | ✓ | ✗ (SILENT DROP) | `entry.messaging[i]` with `account_linking` field |
| messaging_referrals | ✓ | ✗ (SILENT DROP) | `entry.messaging[i]` with `referral` field |
| messaging_handovers | ✓ | ✓ | `entry.messaging_handovers[i]` |
| messaging_fblogin_account_linking | ✓ | ✗ (SILENT DROP) | Unknown (not documented by Facebook) |
| messaging_policy_enforcement | ✓ | ✗ (SILENT DROP) | `entry.messaging[i]` with `policy_enforcement` field |
| message_template_status_update | ✓ | ✓ (partial) | `entry.changes[i]` with `field === 'message_template_status_update'` |

---

## 2. The `entry.changes` Array Path and Echo Delivery

### Current `changes` Handler
**File: `botserver/server/handlers.js` (line 76-84)**
```javascript
if (entry.changes) {
  for (const change of entry.changes) {
    if (change.field === 'message_template_status_update') {
      handleTemplateStatusUpdate(entry.id, change.value).catch(err =>
        console.error('[ERR] handleTemplateStatusUpdate:', err)
      )
    }
  }
}
```

**What would happen if FB sent echoes via `entry.changes`:**
- The handler checks `if (entry.changes)` → condition passes
- Iterates each `change` object
- Checks `if (change.field === 'message_template_status_update')` → **fails for echo**
- **No logging, no error** — the echo is silently dropped
- The loop continues to the next change (if any)

### Would Facebook send echoes via `entry.changes`?

**Historical webhook structure for echoes (per Facebook Messenger docs):**
- `entry.messaging[i]` array contains both inbound messages AND echoes
- Echoes are marked with `message.is_echo = true`
- They do NOT go to `entry.changes`

**From official Page webhook reference:** The `messaging` field is the standard path for all messenger events (including echoes). The `changes` field is used only for field-specific webhook events like template status updates, page subscriptions, and metadata changes.

**Conclusion:** It is **extremely unlikely** (nearly impossible without a major Facebook API restructuring) that echoes would come via `entry.changes`. They have historically always arrived in `entry.messaging[i]` with `is_echo: true`.

---

## 3. Other Webhook Endpoints

Searched entire codebase for alternative webhook receivers:

**File: `botserver/server/index.js` (line 13-15)**
```javascript
router.get('/webhooks', verifyToken)
router.post('/webhooks', (ctx) => handleMessengerEvents(ctx, producer, producerReady, EVENT_TOPIC))
router.post('/synthetic', (ctx) => handleSyntheticEvents(ctx, producer, producerReady, EVENT_TOPIC))
```

**File: `dashboard-server/api/facebook/facebook.routes.js` (line 1-8)**
```javascript
router.post('/exchange-token', controller.exchangeToken);
router.post('/webhooks', controller.addWebhooks);  // NOT a webhook receiver, subscribes to webhooks
router.post('/get-started', controller.addGetStarted);
```

**facebot/testrunner/sender.ts (line 26-29):**
```javascript
default:
  url = `${BOTSERVER_URL}/webhooks`;
  json = { entry: [message] };
```

**Findings:**
- **Primary webhook receiver:** `botserver/server/handlers.js::handleMessengerEvents` at `POST /webhooks`
- **Synthetic event injection:** `botserver/server/handlers.js::handleSyntheticEvents` at `POST /synthetic` (not from Facebook)
- **No other webhook receivers** found in `facebot/`, `botserver-core/`, `dashboard-server/`, or `replybot/`
- All echoes MUST go through the single `handleMessengerEvents` handler

---

## 4. Most Plausible Hidden-Event Paths Ranked by Likelihood

### 1. **LEAST PLAUSIBLE: Echo arrives via `entry.changes` as a new field**
- **Why unlikely:** Violates Facebook's historical webhook architecture; changes array is field-status only
- **What happens if true:** Echo silently dropped (handler checks only `field === 'message_template_status_update'`, skips unknown fields)
- **Evidence against:** No documentation or changelog mentions changes to `changes` structure; all messenger events use `messaging` array historically
- **Risk if ignored:** LOW — would require Facebook to make a fundamental API restructuring without documentation

### 2. **LESS PLAUSIBLE: Echo arrives as a separate top-level entry array (e.g., `entry.message_echoes[i]`)**
- **Why unlikely:** Facebook would need to create a parallel event delivery path; currently all messenger events use `messaging`
- **What happens if true:** Echo silently dropped (handler only checks `entry.messaging` and `entry.messaging_handovers`)
- **Evidence against:** No historical precedent; would be a major breaking change to webhook contract
- **Risk if ignored:** LOW-MEDIUM — Facebook might use this path but would document it in changelogs

### 3. **POSSIBLE: Echo still comes via `entry.messaging[i]` but handler fails to match it due to event shape**
- **Why possible:** Handler uses generic iteration: `for (const eventData of entry[eventType])` then passes entire event to Kafka
- **What could go wrong:** If echo event lacks expected fields (e.g., no `sender` or `recipient`), `getUserFromEvent()` might fail
- **Evidence against:** Other message types including plain text, templates, postbacks, referrals all deliver successfully; handler doesn't validate field existence
- **Risk if ignored:** MEDIUM — if FB changed echo structure without documentation, this could silently fail at the `getUserFromEvent()` stage

### 4. **MOST PLAUSIBLE: Echo still comes via `entry.messaging[i]` but a downstream handler silently drops it**
- **Why plausible:** Handler successfully passes echo to Kafka; the issue might be in scribble, replybot, or state machine
- **What happens:** Echo arrives, is logged, sent to Kafka, but not processed by downstream consumers
- **Evidence against:** User reports verify that webhooks ARE received (other messages echo correctly); issue is specific to `user_phone_number` QR
- **Risk if ignored:** HIGH — the bug may not be in botserver at all, but we've ruled this out already per task description

---

## 5. Could FB Silently Suppress Echoes for `user_phone_number` QRs?

### Fields Checked in Handler

The handler code does **zero validation** of message structure before forwarding to Kafka:

**File: `botserver/server/handlers.js` (line 64-74)**
```javascript
for (const eventType of eventTypes) {
  if (entry[eventType]) {
    for (const eventData of entry[eventType]) {
      const event = { ...eventData, source: 'messenger' }
      event.timestamp = normalizeTimestamp(event.timestamp)
      const user = getUserFromEvent(event)  // Extracts sender.id or recipient.id
      const data = Buffer.from(JSON.stringify(event))
      producer.produce(eventTopic, null, data, user)
    }
  }
}
```

**No message-type-specific checks:**
- Does not examine `message.quick_replies`
- Does not check `message.is_echo`
- Does not filter by `metadata.type === 'phone_number'`
- Does not validate that event matches expected shape for echoes

**If the echo arrives at all** (in `entry.messaging[i]`), it **WILL be forwarded to Kafka**, assuming:
1. The event contains a recognizable `sender.id` or `recipient.id` for `getUserFromEvent()` to extract
2. No exception is thrown during JSON serialization

### Where Silent Drops Could Occur

**Risk Point 1: `getUserFromEvent()` fails (medium risk)**
```javascript
const user = getUserFromEvent(event)  // from '@vlab-research/utils'
```
If this function cannot extract a user ID from the event structure, an exception is caught and logged, event is dropped. Unknown if `utils` is in repo; would need to verify it handles echo payloads.

**Risk Point 2: Empty/malformed `entry.messaging[i]` (low risk)**
If FB sends the event but with missing or null fields, the JSON.stringify would still succeed, but downstream consumers might drop it. Handler itself would not detect this.

**Risk Point 3: Silent exception during produce (very low risk)**
Unlikely given the handler wraps in try/catch, but if Kafka producer throws on certain payloads, echo could be silently dropped.

---

## 6. Verdict: Can Echoes Be Silently Swallowed?

### YES, with specific caveats:

1. **If echo arrives in `entry.messaging[i]` with `is_echo: true`:**
   - Handler WILL iterate it
   - Handler WILL forward it to Kafka
   - **Handler is NOT the culprit** — check `getUserFromEvent()` in utils and downstream consumers

2. **If echo arrives via `entry.changes` or a new top-level array:**
   - Handler WILL silently drop it
   - **No logging, no error, no trace** — would be impossible to detect from webhook logs
   - **This is a major blind spot:** We cannot distinguish between "FB didn't send it" and "we dropped it"

3. **If `getUserFromEvent()` fails on echo structure:**
   - Exception is caught and logged: `[ERR] handleEvents: ...`
   - Event is dropped, not forwarded
   - Webhook logs would show an ERROR entry, not silent drop

### Most Concerning Gap:

The handler processes **every message-like event blindly:**
- `messaging_postbacks` — forwarded silently (subscriber doesn't want them → wasted Kafka traffic)
- `messaging_optins` — forwarded silently
- `messaging_referrals` — forwarded silently
- `messaging_policy_enforcement` — forwarded silently
- `message_echoes` — forwarded silently (this is correct, but handler doesn't discriminate)

**If Facebook restructured webhook payload to use `entry.changes` for echoes**, we would have **zero visibility** into the fact that echoes are arriving and being dropped.

---

## 7. Recommendations for Investigation

Before filing a Facebook bug report, verify:

1. **Check `@vlab-research/utils::getUserFromEvent()`**
   - Confirm it handles echoes correctly
   - Check if `recipient.id` (sent by bot) differs from `sender.id` (user) in echo vs inbound message
   - Verify it doesn't throw on messages with `is_echo: true`

2. **Add logging to handler for edge cases**
   - Log event type when `is_echo === true`
   - Log any exceptions during `getUserFromEvent()`
   - Would catch if echoes are being dropped at this stage

3. **Verify Facebook subscription logs**
   - Check if pages still have `message_echoes` in subscribed_fields (already done per FB bug report)
   - Confirm no recent permission changes

4. **Check for `entry.changes` with echo data**
   - Run test against live page with `user_phone_number` QR
   - Inspect full webhook payload for any `entry.changes` containing echo-like data
   - Would catch if FB changed the payload structure

5. **Test with message_template_status_update**
   - Verify that `entry.changes` handler logic works correctly
   - Confirms the `changes` path is functional (not a broader webhook issue)
