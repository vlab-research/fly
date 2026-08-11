# SurveyID Data Flow Trace - Replybot

## Executive Summary

The `surveyid` flows from the Formcentral API response all the way through to the `responses` table INSERT. The journey is:

**Formcentral API → `getForm()` → `Machine.actionsResponses()` → `responseVals()` → Database INSERT**

All the plumbing is in place. The chat-log publisher can access it the same way responses do, but **currently hardcodes `surveyid: null`** instead of using it.

---

## 1. Origin: Where surveyid Comes From

### Location: `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/ourform.js` (lines 29-61)

The `getForm()` function makes an HTTP call to the Formcentral API and receives a response object:

```javascript
async function getForm(pageid, shortcode, timestamp) {
  // ... validation & auth ...

  const res = await r2(url, { headers }).response
  const f = await res.json()  // Response from Formcentral

  // Extract surveyId from the response
  const { id: surveyId, form: rawForm, messages, off_time } = f

  const form = JSON.parse(rawForm)
  form.offTime = +(new Date(off_time))

  // RETURN: [translatedForm, surveyId]
  return [translateForm(form, JSON.parse(messages)), surveyId]
}

module.exports = { getForm }
```

**Key detail**: Returns a 2-tuple: `[form, surveyId]`

---

## 2. Flow Through Machine.actionsResponses()

### Location: `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/transition.js` (lines 40-63)

The `Machine` class calls `getForm()` and unpacks the surveyId:

```javascript
async actionsResponses(state, userId, timestamp, pageId, newState, output) {
  const upd = output && update(output)
  const shortcode = newState.forms.slice(-1)[0]

  if (!newState.md) {
    throw new Error(`User without metadata: ${userId}. State: ${util.inspect(newState, null, 8)}`)
  }
  const { startTime } = newState.md

  const pageToken = await iowrap('getPageToken', 'INTERNAL', this.getPageToken, pageId)

  // ⭐ CRITICAL: Destructure surveyId from getForm response
  const [form, surveyId, formSettings] = await iowrap('getForm', 'INTERNAL', this.getForm,
    pageId, shortcode, startTime)

  const user = await this.getUser(userId, pageToken)
  const { messages, payment, handoff } = act({ form, user, page: { id: pageId }, timestamp }, state, output)

  // ⭐ PASS TO responseVals
  const responses = responseVals(newState, upd, form, surveyId, pageId, user, timestamp)

  return { actions: messages, responses, pageToken, timestamp, payment, handoff }
}
```

**Data flow**: `surveyId` extracted and passed to `responseVals()` as the 4th parameter.

---

## 3. Flow Through Machine.run()

### Location: `/home/nandan/Documents/vlab-research/fly/replybot/lib/typewheels/transition.js` (lines 79-173)

The `run()` method calls `actionsResponses()` and returns the responses:

```javascript
async run(state, user, rawEvent) {
  let newState, output, page
  const event = parseEvent(rawEvent)
  const timestamp = event.timestamp

  // ... validation & error handling ...

  try {
    const t = this.transition(state, event)
    newState = t.newState
    output = t.output
    page = t.page

    // Early exit cases (NONE, RESET)
    if (output.action === 'NONE' || output.action === 'RESET') {
      return { /* no responses */ }
    }
  } catch (e) {
    // Error handling
  }

  try {
    // ⭐ CALLS actionsResponses, gets responses with surveyId
    const { actions, pageToken, responses, payment, handoff } =
      await this.actionsResponses(state, user, timestamp, page, newState, output)

    await this.act(actions, pageToken)
    if (handoff) {
      await this.handoff(handoff, pageToken)
    }

    // ⭐ RETURNS responses object containing surveyId
    return {
      publish: true,
      timestamp,
      user,
      page,
      actions,
      responses,  // <-- Contains surveyId from responseVals()
      payment,
      handoff,
      newState
    }
  } catch (e) {
    // Error handling with partial report
  }
}
```

**Key return**: The `report.responses` object contains `surveyId`.

---

## 4. Processor Receives It and Passes to Responser

### Location: `/home/nandan/Documents/vlab-research/fly/replybot/lib/index.js` (lines 55-90)

The processor function receives the Machine report and publishes responses:

```javascript
function processor(machine, stateStore) {
  return async function _processor({ key: userId, value: event }) {
    try {
      console.log('EVENT: ', event)

      const state = await stateStore.getState(userId, event)
      console.log('STATE: ', state)

      // ⭐ run() RETURNS report with responses containing surveyId
      const report = await machine.run(state, userId, event)
      console.log('REPORT: ', report)

      if (report.publish) {
        await publishReport(report)
      }
      if (report.newState) {
        await publishState(report.user, report.page, report.timestamp, report.newState)
        await stateStore.updateState(userId, report.newState)
      }

      // ⭐ PUBLISHES responses to Kafka
      if (report.responses) {
        await publishResponses(report.responses)  // <-- surveyId in message
      }

      if (report.payment) {
        await publishPayment(report.payment)
      }

      // ⭐ Chat log also receives state (see next section)
      if (VLAB_CHAT_LOG_TOPIC) {
        await publishChatLog(produce, VLAB_CHAT_LOG_TOPIC, event, state)
      }
    }
    catch (e) {
      // Error handling
    }
  }
}
```

**Data flow**: `report.responses` contains surveyId, which goes to Kafka topic `VLAB_RESPONSE_TOPIC`.

---

## 5. Database INSERT via responseVals()

### Location: `/home/nandan/Documents/vlab-research/fly/replybot/lib/responses/responser.js` (lines 7-34)

The `responseVals()` function constructs the object for the `responses` table:

```javascript
function responseVals(newState, update, form, surveyid, pageid, user, timestamp) {
  if (update) {
    const [q, response] = update
    const shortcode = newState.forms.slice(-1)[0]

    const flowid = newState.forms.length
    const [question_idx, { title: question_text, ref: question_ref }] =
      getField({ form, user }, q, true)

    const { seed, form: parent_shortcode } = newState.md
    const metadata = newState.md

    // ⭐ INCLUDES surveyid in returned object
    return {
      parent_shortcode,
      surveyid,           // <-- From parameter
      shortcode,
      flowid,
      userid: user.id,
      pageid,
      question_ref,
      question_idx,
      question_text,
      response,
      seed,
      metadata,
      timestamp,
    }
  }
}
```

### Insert Query (lines 73-90):

```javascript
put(vals) {
  const query = `INSERT INTO responses(parent_surveyid,
                                       parent_shortcode,
                                       surveyid,
                                       shortcode,
                                       flowid,
                                       userid,
                                       question_ref,
                                       question_idx,
                                       question_text,
                                       response,
                                       seed,
                                       metadata,
                                       timestamp)
       values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT(userid, timestamp, question_ref) DO NOTHING`

  return this.chatbase.pool.query(query, vals)
}
```

**Note**: The Responser class expects 13 values, but responseVals only returns 12 fields. The first parameter `parent_surveyid` is missing from the returned object. This appears to be a **bug** or intentional omission requiring investigation.

---

## 6. Chat Log Publisher: Current State vs. Potential

### Location: `/home/nandu/Documents/vlab-research/fly/replybot/lib/chat-log/publisher.js`

#### Current Implementation (lines 16-60):

```javascript
function extractChatLogEntry(event, state) {
  const category = categorizeEvent(event)

  if (category === 'ECHO') {
    return {
      userid: event.recipient.id,
      pageid: event.sender.id,
      timestamp: event.timestamp,
      direction: 'bot',
      content: event.message.text || '',
      question_ref: md.ref || null,
      shortcode: state.forms && state.forms.length > 0
        ? state.forms[state.forms.length - 1]
        : null,
      surveyid: null,  // ⭐ HARDCODED NULL
      message_type: md.type || null,
      raw_payload: event,
      metadata: state.md || null,
    }
  }

  if (category === 'TEXT' || category === 'QUICK_REPLY' || category === 'POSTBACK') {
    return {
      userid: event.sender.id,
      pageid: (state.md && state.md.pageid) || null,
      timestamp: event.timestamp,
      direction: 'user',
      content: (event.message && event.message.text) || /* ... */ '',
      question_ref: state.question || null,
      shortcode: state.forms && state.forms.length > 0
        ? state.forms[state.forms.length - 1]
        : null,
      surveyid: null,  // ⭐ HARDCODED NULL
      message_type: category.toLowerCase(),
      raw_payload: event,
      metadata: state.md || null,
    }
  }

  return null
}
```

#### Why surveyId is null:

The chat-log publisher receives:
- `event` - the raw event
- `state` - the state machine state **before** processing the event

**The surveyId is NOT available at this point** because:

1. The surveyId only gets fetched inside `Machine.actionsResponses()` after the transition
2. By the time `publishChatLog()` is called (line 80 in index.js), the event processing is complete
3. However, the function doesn't receive the `report` object which contains `responses.surveyid`

#### Tests Confirm Intent (publisher.test.js lines 549-559):

The test file explicitly asserts that surveyid should be null:

```javascript
describe('surveyid field', () => {
  it('should always set surveyid to null for echo events', () => {
    const entry = extractChatLogEntry(echoEvent, fullState)
    should.equal(entry.surveyid, null)
  })

  it('should always set surveyid to null for user events', () => {
    const entry = extractChatLogEntry(textEvent, fullState)
    should.equal(entry.surveyid, null)
  })
})
```

This is **intentional**, not a bug. The tests explicitly verify it's null.

#### How to Fix It:

**Option A: Pass surveyId through state.md**
- Add surveyId to the metadata during the transition
- Chat log can read it from `state.md.surveyid`

**Option B: Pass report to publishChatLog**
- Change the signature: `publishChatLog(produce, topic, event, state, report)`
- Extract surveyId from `report.responses.surveyid`

**Option C: Fetch it parallelly**
- Call `getForm()` within `extractChatLogEntry()` using the state's shortcode and startTime
- Not ideal (repeated DB calls) but would work

#### Current Call Site (index.js line 80):

```javascript
if (VLAB_CHAT_LOG_TOPIC) {
  await publishChatLog(produce, VLAB_CHAT_LOG_TOPIC, event, state)
}
```

The `report` object exists at this point and could be passed if needed.

---

## Key Observations

### What Works
1. ✅ SurveyId is correctly extracted from Formcentral API
2. ✅ Properly threaded through Machine.actionsResponses() → responseVals()
3. ✅ Gets published to Kafka topic with responses
4. ✅ Inserted into database via responser.put()

### Potential Issues
1. ❌ Chat log hardcodes `surveyid: null` — cannot currently access the value
2. ⚠️ Parent surveyid in responses table — check if it's supposed to be filled or if it's legacy

### Data Flow Diagram

```
Formcentral API
    ↓ (returns: { id: surveyId, form: rawForm, ... })
getForm() [ourform.js:53]
    ↓ (returns: [form, surveyId])
Machine.actionsResponses() [transition.js:51]
    ↓ (unpacks surveyId, passes to responseVals)
responseVals() [responser.js:7]
    ↓ (includes surveyId in return object)
{surveyid, shortcode, flowid, userid, ...}
    ↓
processor() [index.js:74]
    ↓ (report.responses contains surveyId)
publishResponses() / Database INSERT
    ↓
responses table ✅

(separate thread)
publishChatLog() [index.js:80]
    ↓ (has state, but NOT report)
extractChatLogEntry() [publisher.js:16]
    ↓ (hardcodes surveyid: null)
chat_log table ❌
```

---

## Testing

To verify surveyId is flowing correctly:
1. Check Kafka message from `VLAB_RESPONSE_TOPIC` - should contain surveyId
2. Query `responses` table - should have surveyid populated
3. Chat log will show null until the publisher is fixed

---

## Files Involved

| File | Lines | Purpose |
|------|-------|---------|
| `/replybot/lib/typewheels/ourform.js` | 29-61 | API call, surveyId extraction |
| `/replybot/lib/typewheels/transition.js` | 40-63, 79-173 | Machine methods that unpack and pass surveyId |
| `/replybot/lib/responses/responser.js` | 7-34, 73-90 | responseVals() construction & DB insert |
| `/replybot/lib/index.js` | 55-90 | Processor that orchestrates all components |
| `/replybot/lib/chat-log/publisher.js` | 16-60, 73-79 | Chat log extraction (hardcodes surveyid: null) |

---

## Additional Details About responseVals

Looking at the actual implementation (responser.js lines 7-34), note that:

1. **parent_shortcode** is extracted from `newState.md.form` (line 15)
   - This represents the original/parent form when a bailout occurred
   - For normal flows, this is the same form that started the user's session

2. **Only returns 12 fields** but INSERT expects 13
   - Returned: `parent_shortcode`, `surveyid`, `shortcode`, `flowid`, `userid`, `pageid`, `question_ref`, `question_idx`, `question_text`, `response`, `seed`, `metadata`, `timestamp`
   - Expected by INSERT: `parent_surveyid`, plus the 12 above
   - **`parent_surveyid` is missing** from the return object
   - This suggests either:
     - The `$1` parameter gets undefined/null (possible but risky)
     - The query is wrong and should omit `parent_surveyid`
     - This is legacy/incomplete code

3. The responseVals function only executes if `update` is truthy
   - Returns `undefined` if there's no user response to save
   - This prevents spurious database inserts for non-response events

---

## Recommendations

1. **Document the Data Contract**: Add a comment above `responseVals()` describing what parameters come from where and their sources

2. **Audit parent_surveyid**:
   - Verify the INSERT query matches the 12 fields returned by `responseVals()`
   - If `parent_surveyid` should be populated, add it to responseVals return
   - If it's not needed, remove it from the INSERT to avoid undefined values

3. **Fix Chat Log SurveyId** (if needed): Decide between:
   - **Option A** (recommended): Pass `report` to `publishChatLog()` and read from `report.responses.surveyid`
   - **Option B**: Add surveyId to state.md during transition so chat log can access it
   - **Option C**: Accept that chat log entries don't have surveyId (consistent with current tests)

4. **Add Integration Test**: Verify surveyId flows end-to-end from form lookup to database
   - Mock Formcentral API response
   - Process event through Machine
   - Assert surveyId appears in publishResponses() call
   - Assert surveyId is inserted into database

---

## Summary Table

| Component | File | Location | Status | Notes |
|-----------|------|----------|--------|-------|
| **SurveyId Origin** | ourform.js | Line 53 | ✅ Correct | Extracted from API response |
| **Machine Unpacks** | transition.js | Line 51 | ✅ Correct | Destructured into surveyId variable |
| **Pass to responseVals** | transition.js | Line 60 | ✅ Correct | Passed as 4th parameter |
| **ResponseVals Returns** | responser.js | Line 20 | ✅ Correct | Included in returned object |
| **Processor Publishes** | index.js | Line 74 | ✅ Correct | Via publishResponses() |
| **Database INSERT** | responser.js | Line 76 | ⚠️ Verify | Check parent_surveyid parameter |
| **Chat Log** | publisher.js | Line 32, 52 | ❌ Hardcoded null | Intentional per tests, access report if needed |

---

## Deep Dive: form_start_time Semantics

### 1. What `form_start_time` Is (Exact Definition)

From `/home/nandan/Documents/vlab-research/fly/devops/migrations/01-init.sql`, line 118:

```sql
form_start_time TIMESTAMPTZ AS (
  CEILING((state_json->'md'->>'startTime')::INT/1000)::INT::TIMESTAMPTZ
) STORED
```

`form_start_time` is a **generated stored column** derived from `state_json->'md'->>'startTime'`. It reads the JavaScript millisecond timestamp from the `md` object inside `state_json` and converts it to a PostgreSQL `TIMESTAMPTZ` by dividing by 1000 (ms → seconds).

### 2. What `md.startTime` Actually Means

The `md.startTime` field is set in two distinct places in the state machine code:

**On first arrival (REFERRAL event)** — `replybot/lib/typewheels/utils.js`, line 60:
```javascript
md.startTime = event.timestamp
```
This sets `startTime` to the timestamp of the first referral event (when the user first clicked the survey link).

**On every SWITCH_FORM transition** — `replybot/lib/typewheels/machine.js`, line 234:
```javascript
md: { ...state.md, ...stitch.metadata, startTime: nxt.timestamp }
```
When a bail fires and stitches the user to a new form, `startTime` is **overwritten** with the timestamp of the stitch echo event. The old seed and `md.form` (the parent form) are preserved, but `startTime` is reset.

This is explicitly tested and documented with a comment in machine.js (lines 225–229):
```javascript
// retains metadata (seed)
// and metadata (form) -- which is the initial form
// but creates new startTime in metadata.
// TODO: clean this up, differentiate between "permanent"
// and "temporary" metadata.
```

And confirmed by tests in `machine.test.js`, lines 587–588:
```javascript
state.md.startTime.should.not.equal(referral.timestamp)
state.md.startTime.should.equal(echo.timestamp)
```

**Conclusion: `form_start_time` represents the start time of the user's CURRENT form, not the original parent form.** It is reset every time the user is bailed to a new form.

### 3. Is `states` One Row Per (user, page) or (user, form)?

The `states` table primary key is `(userid, pageid)` — confirmed in `01-init.sql`, line 115:
```sql
PRIMARY KEY (userid, pageid)
```

The `pageid` here is the **Facebook Page ID** (confirmed by the `credentials` table which has `facebook_page_id` derived from a Facebook credential). There is one row per (user, Facebook page). A single row represents the user's current position in the overall flow, which may span multiple forms.

**When a user bails from form A to form B:**
- `state_json.forms` grows from `['A']` to `['A', 'B']` (the entire form history is kept in the array)
- `state_json.md.startTime` is updated to the current timestamp (time of the stitch)
- `state_json.md.form` remains the original parent form (`'A'`)
- `current_form` (generated column) = `state_json->'forms'->>-1` = the last element = `'B'`
- `form_start_time` (generated column) = time user entered form B (NOT form A)

So **`form_start_time` changes as users move between forms.** At any given moment, it reflects when the user entered their *current* form, not their original form.

### 4. Is There a Reliable Way to Get "When User Started Form X"?

**From the `states` table: No, not reliably.** `states` is a mutable single-row-per-(user, page) store. It only captures the current form's start time. Historical form start times are not preserved anywhere in `states`.

**From the `responses` table: Yes, via MIN(timestamp).** Every response the user submits is stored in `responses` with columns `userid`, `shortcode` (= the form shortcode), and `timestamp`. To find when a user started form X:

```sql
SELECT userid, MIN(timestamp) as started_form_at
FROM responses
WHERE shortcode = $form
GROUP BY userid
```

This is exactly the pattern already used by the `elapsed_time` condition in `exodus/query/builder.go`, lines 181–186:
```go
cte := fmt.Sprintf(`%s AS (
    SELECT userid, MIN(timestamp) as response_time
    FROM responses
    WHERE shortcode = $%d AND question_ref = $%d
    GROUP BY userid
)`, ...)
```

The difference is that `elapsed_time` currently anchors to a *specific question's* first response. To anchor to "when user started the form" we would use `MIN(timestamp)` across all questions for that form, without a `question_ref` filter.

**Important caveat:** The `MIN(timestamp)` pattern finds when the user submitted their *first response* to form X, not when they were stitched into it. There may be a small delay (seconds to minutes) between when the user enters the form and when they answer the first question. For practical purposes (measuring hours/days), this is negligible.

**There is no "form started" event table.** There is no separate event log recording when a user was stitched to a form. The `responses` table first-response timestamp is the best available proxy.

### 5. Recommended SQL Pattern for "Started Form X More Than N Time Ago"

The best pattern, analogous to what `elapsed_time` already does for specific questions:

```sql
WITH form_start_times AS (
    SELECT userid, MIN(timestamp) AS started_at
    FROM responses
    WHERE shortcode = $form_shortcode
    GROUP BY userid
)
SELECT DISTINCT s.userid, s.pageid
FROM states s
JOIN form_start_times fst ON s.userid = fst.userid
WHERE fst.started_at + $duration::INTERVAL < NOW()
```

This finds users who:
1. Have responses in form X (i.e., they started it)
2. First responded more than N time ago

**Alternative using `form_start_time` from states (only valid for current form):**

If the condition is "user has been on their *current* form for more than N time", then `form_start_time` can be used directly:

```sql
SELECT userid, pageid
FROM states
WHERE current_form = $form_shortcode
  AND form_start_time + $duration::INTERVAL < NOW()
```

This is simpler and avoids the CTE, but only works for the user's *current* form. If a user has been bailed away from form X to form Y, this would match against Y's start time, not X's.

### 6. How This Affects a `start_time` Condition Type

A `start_time` condition like "user started form X more than 4 days ago" should be implemented using the `responses` CTE pattern (option above), NOT using `form_start_time` from `states`. Reasons:

1. `form_start_time` reflects the current form's start time, which changes with every bail
2. If a user was bailed from form X to form Y, querying `states.form_start_time WHERE current_form = X` would return no rows (they're now on Y)
3. The `responses` table preserves the full history of when users answered questions in each form, making it the only reliable source for "when did user start form X"

The implementation should mirror `elapsed_time` in `exodus/query/builder.go` but use a form-level `MIN(timestamp)` without a `question_ref` filter.

### 7. Key Files for Implementation

| File | Location | Relevance |
|------|----------|-----------|
| `devops/migrations/01-init.sql` | Line 118 | `form_start_time` generated column definition |
| `replybot/lib/typewheels/utils.js` | Line 60 | Initial `md.startTime` set from referral event timestamp |
| `replybot/lib/typewheels/machine.js` | Line 234 | `md.startTime` overwritten on SWITCH_FORM |
| `exodus/query/builder.go` | Lines 148–198 | `elapsed_time` CTE pattern to mirror |
| `exodus/types/types.go` | Lines 104–114 | `TimeReference` and `TimeEventDetails` types to extend |
