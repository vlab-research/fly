# Facebook Messenger Handoff Protocol

## Overview

The handoff protocol allows surveys to temporarily hand off conversation control to external Facebook Messenger applications, then resume the survey when control is returned. The `handoff` is a first-class field type: the author declares it with `type: handoff` and a `handoff:` block, and the runtime synthesizes the wait and thread-control handoff automatically.

## Authoring Format

Declare a handoff field in the Typeform description YAML:

```yaml
type: handoff
handoff:
  target_app_id: 619383124328766
  mode: wait
  metadata: { return_app_id: 699455733740842, assessment_type: literacy }
```

**Fields:**

| Field | Required | Description |
|---|---|---|
| `type` | yes | Must be `handoff` |
| `handoff.target_app_id` | yes | Facebook app ID of the external application |
| `handoff.mode` | yes | Only `wait` is implemented |
| `handoff.metadata` | no | Key-value pairs sent to the external app when it gains thread control |

### Parsing

`baseAddCustomType` parses the YAML into `md = { type: 'handoff', handoff: { target_app_id, mode, metadata } }` and sets `field.type = 'handoff'`. The `translateHandoff` translator renders the field title as text, producing metadata `{ type: 'handoff', handoff: { target_app_id, mode, metadata }, ref }`.

## Runtime Flow

The critical design decision: **the handoff (passing thread control) fires after the echo arms the wait, not on send.** This avoids the stuck-handoff bug where handing off on send would suppress the echo that arms the wait.

### Step-by-step

1. **User answers the question before the handoff field.** `exec()` returns `RESPOND`. `act()` sends the handoff message. No handoff side-effect occurs on send.
2. **The echo of the handoff message hits the ECHO handler.** The handler detects `md.type === 'handoff'` and returns:
   - `action: HANDOFF`
   - Synthesized `wait: { type: 'handover' }`
   - `handoff: md.handoff`
3. **`apply()` transitions state** to `WAIT_EXTERNAL_EVENT` with the synthesized wait.
4. **`act()` executes the handoff.** It returns `{ messages: [], handoff: _wrapSideEffect(ctx, output.handoff) }`. `transition.js` emits a `pass_thread_control` command to the Kafka `commands` topic; **message-worker** consumes it and calls Facebook's `pass_thread_control` API, handing thread control to the external app.
5. **External app completes its interaction** and calls Facebook's `pass_thread_control` API to return control.
6. **Botserver receives the handover webhook** and forwards it as a `messaging_handovers` event to Kafka.
7. **Replybot processes the handover event** via `_handleExternalEvent`. The `WAIT_EXTERNAL_EVENT` state's synthesized wait is fulfilled. State transitions to `RESPOND` and the survey resumes from the next question.

### User Input During Handoff Wait

While the machine is in `WAIT_EXTERNAL_EVENT` with `wait.type === 'handover'`, all user-initiated events (`TEXT`, `QUICK_REPLY`, `POSTBACK`, `MEDIA`) are silently ignored via the `_isHandoffWait` guard in `machine.js`. This is intentional — the conversation is owned by the external app, and any user messages during this period are not replies to survey questions. Regular `wait` fields (e.g. timeouts) are not affected; users can still respond before a timeout expires.

### Why the Echo Must Come First

If `passThreadControl` fired on send (before the echo), Facebook would route the echo to the external app instead of back to replybot. The echo would never reach the ECHO handler, the wait would never be armed, and the survey would be stuck in a state with no pending wait. Firing the handoff after the echo ensures the wait is armed before control leaves replybot.

## Not Yet Implemented

The following are aspirational and not part of the current implementation:

- **`mode: nowait`** -- hand off and end the survey (no wait, no handback).
- **`mode: reclaim`** -- hand off, wait (possibly with timeout), then `take_thread_control` to forcibly reclaim the thread and resume.
- **`take_thread_control`** -- there is no automatic reclamation of thread control.
- **Timeout backstops** -- there is no `timeout_minutes` field or automatic timeout. If the external app never returns control, the survey stays in `WAIT_EXTERNAL_EVENT` indefinitely.

Do not reference `timeout_minutes`, `take_thread_control`, or custom wait conditions in handoff YAML. The wait is always synthesized as `{ type: 'handover' }` at runtime.

## Receiving Data from External Apps

When external apps return control, they can include metadata that is automatically flattened and stored under the `e_handover_metadata_` prefix.

### How It Works

External app calls Facebook's `pass_thread_control` API with metadata (a JSON **string**, per the Facebook API):

```json
{
  "completion_status": "success",
  "assessment_results": {
    "reading_level": 6,
    "comprehension_score": 82
  },
  "recommendations": ["literacy_support", "visual_aids"]
}
```

Flattened metadata in state (the production contract, verified against `main`'s live pipeline):

```javascript
e_handover_metadata_completion_status: "success"
e_handover_metadata_assessment_results_reading_level: 6
e_handover_metadata_assessment_results_comprehension_score: 82
e_handover_metadata_recommendations_0: "literacy_support"
e_handover_metadata_recommendations_1: "visual_aids"
e_handover_target_app_id: <previous_owner_app_id>
```

**Where the `metadata_` segment comes from (important):** replybot's event pipeline (`parseEvent` = `recursiveJSONParser`) pre-parses the `pass_thread_control.metadata` JSON string into an object before `makeEventMetadata` runs. `makeEventMetadata`'s own `JSON.parse(metadata)` then throws on the already-parsed object, and its catch-fallback wraps the object as `{ metadata: <object> }`, which the flattener nests under a `metadata_` level. If the metadata ever reaches the flattener still as a string, the `JSON.parse` succeeds and the keys come out **flat** (`e_handover_completion_status`) — a one-level-shallower, incompatible key set. Any refactor of event parsing/normalization MUST preserve the wrapped `e_handover_metadata_*` keys: they are what production has always served and what live surveys reference. (The platform-abstraction V2 normalizer initially dropped the pre-parse and broke exactly this — see Troubleshooting.)

### Flattening Rules

- Nested objects: `{user: {age: 25}}` becomes `e_handover_metadata_user_age: 25`
- Arrays: `{tags: ["a", "b"]}` becomes `e_handover_metadata_tags_0: "a"`, `e_handover_metadata_tags_1: "b"`
- All data types preserved: strings, numbers, booleans, null
- Keys named `type` are dropped at every nesting level; `undefined` values are dropped; camelCase keys are snake_cased
- Non-JSON plain-string metadata becomes a single field: `e_handover_metadata: "<string>"`

### Using Returned Data

Access flattened metadata in subsequent questions:

```
Based on your reading level of grade {{hidden:e_handover_metadata_assessment_results_reading_level}},
we have prepared appropriate materials for you.
```

A missing key renders as an **empty string** — never an error — so a key mismatch shows up as silent empty placeholders in the rendered message.

In logic jumps, use the hidden fields to branch on assessment results.

## External App Requirements

For an app to work with the handoff protocol, it needs to:

1. **Be configured as a Secondary Receiver** in Facebook Page settings
2. **Receive thread control** when the survey hands off
3. **Return control** by calling Facebook's `pass_thread_control` API:
   ```javascript
   POST https://graph.facebook.com/v18.0/me/pass_thread_control
   {
     "recipient": {"id": "user_psid"},
     "target_app_id": "our_app_id",
     "metadata": "{\"result\": \"data\"}"
   }
   ```

No special API integration or webhooks are required on the external app side beyond standard Facebook Handover Protocol support.

## Configuration

### Facebook App Setup

1. Set the replybot app as **Primary Receiver** in Page Settings > Messenger Platform
2. Add `messaging_handovers` to webhook subscriptions in the Facebook App dashboard
3. Configure external apps as **Secondary Receivers** on the page

### Environment Variables

```bash
FACEBOOK_APP_ID=your_replybot_app_id
```

Used to validate that control is returned to the correct app.

## Use Cases

### Literacy Assessment Integration

```yaml
type: handoff
handoff:
  target_app_id: 111222333
  mode: wait
  metadata: { assessment_type: literacy, grade_level: adult }
```

The literacy app conducts an interactive reading test, then returns reading level, comprehension scores, and recommendations. The survey continues with appropriate question complexity.

### Multilingual Support Assessment

```yaml
type: handoff
handoff:
  target_app_id: 444555666
  mode: wait
  metadata: { languages_offered: ["english", "spanish", "portuguese"] }
```

### Accessibility Needs Evaluation

```yaml
type: handoff
handoff:
  target_app_id: 777888999
  mode: wait
  metadata: { survey_context: accessibility_check }
```

## Troubleshooting

### Survey does not resume after handoff

- Is `target_app_id` correct?
- Is the external app returning control to the correct app ID?
- Check botserver logs for handover webhook events
- Check replybot logs for the ECHO handler producing `action: HANDOFF`

### Metadata not appearing in survey

- Is metadata properly JSON-formatted when the external app calls `pass_thread_control`?
- Are you using the correct field names with the `e_handover_metadata_` prefix (see "Receiving Data from External Apps" — the `metadata_` segment is part of the production contract)?
- Check replybot logs to confirm the external event was processed
- **Survey resumes but placeholders render empty (`""`)**: the handover itself worked (the wait was fulfilled) but the flattened keys don't match the survey's hidden-field names. This exact symptom occurred when the V2 event-normalizer stopped pre-parsing the metadata string, silently shifting keys from `e_handover_metadata_*` to flat `e_handover_*`. To diagnose, inspect the user's state (see `documentation/states-debugging.md`) and check which key set actually landed in `md`.

### External app never gets control

- Is the external app configured as a Secondary Receiver on the page?
- Is `target_app_id` the correct Facebook app ID?
- Check replybot logs for `passThreadControl` API call results
- Confirm the ECHO handler fired and `action: HANDOFF` was produced (the handoff only fires after the echo)

### Stuck in WAIT_EXTERNAL_EVENT indefinitely

- There is no timeout backstop. If the external app never returns control, the survey will not resume.
- Verify the external app is functioning and will return control.
- Consider whether a `mode: reclaim` feature is needed for your use case (not yet implemented).

### Replybot crashes with `There is no translator for the question of type handoff`

This happens when a user sends a text message while the machine is in `WAIT_EXTERNAL_EVENT` during a handoff. Two bugs caused this, both fixed in replybot v0.0.202:

1. **machine.js missing guard**: The `TEXT`, `QUICK_REPLY`, `POSTBACK`, and `MEDIA` event handlers only checked for `RESPONDING` and `USER_BLOCKED` states. User input during a handoff wait was treated as a response to the handoff field, triggering the validator. Fixed by adding `_isHandoffWait(state)` — checks `state.state === 'WAIT_EXTERNAL_EVENT' && state.wait.type === 'handover'` — to all four handlers. Regular `wait` fields (timeouts) still accept user input; only handoff waits are blocked.

2. **translate-typeform validator missing `handoff`**: The translator dispatch table had `handoff` (added in 0.2.17) but the validator dispatch table did not. Even if the machine guard is bypassed, the validator would throw. Fixed in translate-typeform 0.2.18 by adding `handoff: validateStatement` to the validator lookup (handoff fields don't accept user input, same as `wait` and `statement`).

The machine.js guard is the primary fix. The validator entry is defense-in-depth.

## Related Documentation

- **Implementation Specification**: `HANDOFF_PROTOCOL_IMPLEMENTATION.md`
- **Facebook Handover Protocol**: https://developers.facebook.com/docs/messenger-platform/reference/handover-protocol/
