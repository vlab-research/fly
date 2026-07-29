# Referral → Form Resolution

## Overview

When a Facebook Messenger user arrives via a referral link (clicked a link shared by another user or accessed via `m.me/pageusername?ref=...`), the system must determine which Typeform survey to load. This document describes the current flow and how referral data flows through the system to resolve a form.

---

## Referral URL Format

Referral URLs use a dot-separated key-value pair format:

```
https://m.me/PAGEUSERNAME?ref=form.SHORTCODE.key1.value1.key2.value2...
```

**Example:**
```
https://m.me/testvirtuallab?ref=form.ABC123.study.wave1.cohort.A
```

Parses to:
```javascript
{
  form: 'ABC123',
  study: 'wave1',
  cohort: 'A'
}
```

The first pair **must** be `form.SHORTCODE`. The rest are arbitrary metadata passed into the user's state for later use (stored in `state.md`).

---

## Event Flow: From Webhook to Form Load

### 1. Facebook Webhook Arrives at BotServer

When a user clicks a referral link and messages the page, Facebook sends a webhook to `/webhooks`:

```json
{
  "object": "page",
  "entry": [
    {
      "id": "1051551461692797",
      "time": 1234567890000,
      "messaging": [
        {
          "sender": {"id": "USERID"},
          "recipient": {"id": "PAGEID"},
          "timestamp": 1234567890000,
          "referral": {
            "ref": "form.ABC123.key.value",
            "type": "OPEN_THREAD"
          }
        }
      ]
    }
  ]
}
```

### 2. BotServer Handler Parses and Produces Event

**File**: `botserver/server/handlers.js:54-91`

- Verifies webhook token
- Normalizes timestamp (converts seconds → milliseconds if needed)
- Adds `source: 'messenger'` field
- Produces raw event to Kafka topic (e.g., `chat-events`)

**Event types processed**: `['messaging', 'messaging_handovers']` — covers standard messages, postbacks, and referrals nested within.

### 3. Replybot Consumer Receives Event

**File**: `replybot/lib/index.js:55-89`

The `processor()` function:
- Receives event from Kafka
- Retrieves existing user state from StateStore
- Runs `machine.run(state, userId, event)` to process the event
- Publishes new state, responses, and payments back to Kafka

### 4. Event Normalizer Classifies the Raw Webhook

**File**: `replybot/lib/event-normalizer.js:20-39`

Since the UniversalEvent refactor, raw platform webhooks are normalized into a
common event vocabulary *before* the state machine sees them.
`categorizeMessengerEvent(data)` decides whether an inbound event is a
conversation entry by looking for a referral in four places:

- Top-level `data.referral` (this is the `m.me/...?ref=...` shape)
- `data.postback.referral`
- `data.postback.payload.referral` — payload parsed first
- `data.message.quick_reply.payload.referral` — payload parsed first

On a match it emits `event_type: 'conversation_started'` with the referral on
`payload.referral`. Everything else becomes `user_interaction` (quick_reply /
postback), `user_text`, `user_media`, etc.

**The two delivery shapes are not equivalent.** `m.me` links and Click-to-Messenger
ads that trigger a native referral put the referral at the **top level**, where it
is an object. Ads whose welcome message carries a quick-reply button deliver the
referral **inside that button's payload**, where Messenger sends it as a **JSON
string**:

```json
"quick_reply": {
  "payload": "{\"referral\": {\"ref\": \"creative.6b.gender.men.form.hpvintrotriple\"}}"
}
```

`categorizeMessengerEvent` parses both payloads (via `parsePayload`) *before*
testing them for `.referral`, so the string and object shapes are handled
identically. See [String-payload referrals](#string-payload-referrals-resolved-vir-19)
below for the history — this was broken in production between 2026-07-25 and
2026-07-29.

### 4b. State Machine Categorizes the Normalized Event

**File**: `replybot/lib/typewheels/machine.js:153-182`

`categorizeEvent(nxt)` now switches on `nxt.event_type` only. It does **not**
inspect raw webhook shapes.

| `event_type` | Category |
|---|---|
| `conversation_started` | `REFERRAL` |
| `user_interaction` + `interaction_type: 'quick_reply'` | `QUICK_REPLY` |
| `user_interaction` + `interaction_type: 'postback'` | `POSTBACK` |
| `user_text` | `TEXT` |
| `handover` | `HANDOVER_EVENT` |

Only `REFERRAL` carries a form shortcode. A referral that fails to normalize into
`conversation_started` is therefore invisible to the form-resolution path.

### 5. REFERRAL Case Handler Extracts Form

**File**: `replybot/lib/typewheels/machine.js:254-279`

When event categorizes as REFERRAL:

```javascript
case 'REFERRAL': {
  const form = getForm(nxt)

  // Check for reset shortcode
  if (form === process.env.REPLYBOT_RESET_SHORTCODE) {
    return { action: "RESET", stateUpdate: { pointer: nxt.timestamp } }
  }

  // Block if user is blocked
  if (state.state === 'USER_BLOCKED') return _noop()

  // Prevent re-entry to same form
  if (_hasForm(state, form)) {
    if (state.state === 'QOUT') return _repeat(state)
    return _noop()
  }

  // Ignore if user is the referrer (prevent self-referrals)
  if (_currentUserIsReferrer(nxt)) return _noop()

  return _blankStart(nxt)
}
```

**Decision logic**:
1. Extract form shortcode
2. Check for special reset cases
3. Validate user is allowed to start form
4. Prevent duplicate form attempts
5. Prevent self-referrals
6. Start the form with `_blankStart()`

### 6. Form Shortcode Extraction with Fallback

**File**: `replybot/lib/typewheels/utils.js:75-105`

The `getMetadata(event)` function reads the referral off the **normalized** event
and applies the fallback:

```javascript
function getMetadata(event) {
  let md = {}

  try {
    let r
    if (event.event_type === 'conversation_started') {
      r = event.payload.referral
    }

    if (r && r.ref) {
      const pairs = r.ref.split('.')
      md = _group(pairs.map(decodeURIComponent))
    }
  } catch (e) {
    md = {}
  }

  md.form = md.form || process.env.FALLBACK_FORM
  md.startTime = event.timestamp
  md.pageid = event.source.account_id
  md.platform = eventPlatform(event)

  return { ...md, ...randomSeed(event, md) }
}
```

**Key behavior**:
- **Only `conversation_started` events can carry a form.** Any other event type
  yields `md = {}` and falls through to the fallback shortcode.
- Falls back to `process.env.FALLBACK_FORM` if no `form` key is found
- `pageid` comes from `event.source.account_id` (the messaging account id, i.e.
  the page id for Messenger)
- `platform` is persisted so synthetic re-entry events (dean timeouts /
  follow-ups) can recover the conversation's real platform
- Generates a deterministic seed from form + userId

**Current fallback**: `FALLBACK_FORM=305` (`devops/values/production.yaml`)

**`_group` is order-independent.** It pairs the dot-separated tokens two at a
time, so `form.ABC.creative.x` and `creative.x.form.ABC` both resolve to
`form: 'ABC'`. The form pair does not have to come first.

### 6b. Which Events Can Start a Form

`_blankStart(event)` sets `md: getMetadata(event)` and appends `md.form` to the
state's `forms` array. As of `3de533a8` (2026-07-25), **five** entry points
blank-start when `state.state === 'START'`: `TEXT`, `MEDIA`, `QUICK_REPLY`,
`POSTBACK` and `_handleExternalEvent` (which covers handover events).

The rationale was that a user does not need a referral to enter the system, and
previously these paths fell through to `RESPOND` and produced an empty-object
`md` husk that passed transition.js's `!md` guard and then threw inside
`getForm`.

The consequence is that **any** of those events, arriving first, starts the user
on `FALLBACK_FORM`. This matters because a single ad click produces more than
one webhook: a thread-control handover typically lands ~1.5 s before the
quick_reply that carries the referral.

This is **recoverable but not free**. A referral that normalizes to
`conversation_started` still reaches the `REFERRAL` handler even when the state
has left `START`, and `_blankStart` switches the user onto the referred form —
see the handover-race test in `machine.test.js`. What does *not* get undone is
the `forms` array: it keeps the transient `FALLBACK_FORM` entry, so the user
looks like they touched that survey.

The reason the race looked terminal during VIR-19 is that the referral was not
normalizing to `conversation_started` at all — as a `user_interaction` it was
consumed as a *response* to the current question instead of routing through the
`REFERRAL` handler.

---

## String-payload referrals (resolved, VIR-19)

**Status**: fixed in `replybot-v0.0.212`. Broken in production from 2026-07-25
until 2026-07-29 (**VIR-19**; user-visible symptom tracked as **VIR-17**).

### Current behavior

`categorizeMessengerEvent` parses `data.postback.payload` and
`data.message.quick_reply.payload` with `parsePayload()` **once, at the top of
the function**, and tests the *parsed* values for `.referral`. A referral
therefore resolves identically whether Messenger delivered it as an object or as
a JSON string, and the same parsed values are reused by the downstream
`user_interaction` branches rather than being parsed a second time.

Two properties of `parsePayload` make this safe:

- It returns a non-JSON string **unchanged**, so the bare
  `postback.payload === 'get_started'` sentinel still compares equal after
  parsing and still yields `conversation_started`.
- It swallows `JSON.parse` failures, so a malformed payload string cannot throw
  on the hot path — it simply carries no `.referral` and falls through to the
  normal interaction branches.

A payload that parses to an object **without** a `referral` key (an ordinary
survey answer such as `{"value":"1","ref":"intro_1"}`) is untouched and still
normalizes to `user_interaction` / `interaction_type: 'quick_reply'`.

### What went wrong (history)

The referral test read `.referral` off the **raw, unparsed** payload. Messenger
delivers those payloads as JSON strings and `"...".referral` is `undefined`, so
the referral branch was never taken. The event fell through to the generic
quick_reply branch, which *did* call `parsePayload()` — but discarded the
referral and emitted `user_interaction`.

Downstream, `getMetadata` saw no `conversation_started`, so
`md.form = FALLBACK_FORM`. Every ad click delivered via a quick-reply button
started the user on shortcode `305`. Of the users clicking an `hpvintrotriple`
ad after 2026-07-27, 309 landed on `305` and only 2 reached `hpvintrotriple`;
1,770 users started on `305` after 2026-07-25.

Why it stayed invisible for four days:

- **`305` is a real survey shortcode**, not an inert fallback. It belongs to a
  live researcher, and its version at the time had a single field
  (`default_message`), so misrouted users received one message and went straight
  to `END` — they looked like completions, not errors. See the note in
  `devops/sql-exporter/templates/configmap.yaml`.
- **State is replayed, not stored.** Replybot rebuilds state from the event log
  on every new event, so participants who entered correctly *before* the
  regression were re-attributed to `305` the next time they interacted. Their
  `responses` rows kept the correct shortcode — only `states` was wrong. Note
  this cuts the other way too: after the fix, replaying an affected user's log
  resolves the correct form.
- Test coverage constructed the payload as an **object**, which never exercised
  the string path.

**Diagnostic for affected historical users**: `md.form = "305"` with no
`creative`/`gender`/`geography` keys in `md`, while their `responses` rows carry
the real shortcode.

### Regression coverage

- `replybot/lib/event-normalizer.test.js` — `categorizeMessengerEvent - referral
  inside a payload STRING (VIR-19)`: string and object referrals on both
  quick_reply and postback, the `get_started` sentinel, an ordinary survey
  answer, and a malformed payload string.
- `replybot/lib/typewheels/machine.test.js` — `Referral delivered inside a
  quick_reply payload string`: drives a **raw** webhook through `parseEvent` into
  `getState` and asserts the referred form (not `FALLBACK_FORM`) is started and
  that the `creative`/`gender`/`geography` targeting keys reach `state.md`.

Note that `replybot/lib/typewheels/events.test.js` is a **fixtures module**, not
a test suite despite the filename — it exports pre-normalized events. Tests that
must exercise normalization have to build raw webhook shapes and run them
through `parseEvent`, as the machine test above does.

### 7. Form Loading from Database

After `getMetadata()` returns, the form shortcode is used to load the survey definition:

**File**: `replybot/lib/typewheels/transition.js` (form loading logic)

```javascript
this.getForm = (pageid, shortcode, timestamp) => {
  return cache.wrap(`form:${pageid}:${shortcode}:${timestamp}`, 
    () => getForm(pageid, shortcode, timestamp), 
    ttl)
}
```

Form is fetched from `chatroach.surveys` table by shortcode:
```sql
SELECT form FROM surveys WHERE shortcode = ? AND userid = (SELECT userid FROM facebook_pages WHERE pageid = ?)
```

---

## Current Limitations

### 1. Single Global Default
- `FALLBACK_FORM` is an environment variable set per deployment
- Cannot vary per Facebook page
- Requires Kubernetes manifest edit + pod restart to change

### 2. No Per-Page Configuration Table
- `facebook_pages` table has no `default_form_shortcode` column
- Dashboard API does not expose per-page defaults
- Cannot store user preferences for different pages

### 3. Form Resolution is Not Page-Specific
- Form lookup checks shortcode only
- Does not support page-specific survey variants
- Multiple pages sharing shortcode will load identical form

### 4. BotServer Event Type Handling
- `messaging_referrals` is not explicitly listed in event types (covered by `messaging` array)
- Adds ambiguity in code about what event types are intentionally supported

---

## Data Model: Pages & Forms

### facebook_pages Table
```sql
CREATE TABLE facebook_pages(
  pageid VARCHAR PRIMARY KEY,          -- Facebook page ID
  userid UUID REFERENCES users(id),   -- Dashboard user who connected page
  token VARCHAR                       -- Page access token
  -- NEW: default_form_shortcode VARCHAR (to be added)
);
```

### surveys Table
```sql
CREATE TABLE surveys(
  id UUID PRIMARY KEY,
  created TIMESTAMPTZ,
  formid VARCHAR,                     -- Typeform form ID
  form VARCHAR,                       -- Full Typeform definition (JSON)
  messages VARCHAR,
  shortcode VARCHAR NOT NULL,         -- The lookup key (e.g., "305")
  title VARCHAR,
  userid UUID REFERENCES users(id)
);
```

**Relationship**: A page belongs to a user. Surveys are created by a user. There is no direct foreign key from `facebook_pages` to `surveys`, but users can filter surveys by `shortcode` and page context.

---

## Page Identity Availability

The page ID is **always available** at the point of form resolution:

1. **From Facebook webhook**: `event.recipient.id` contains the page ID
2. **At fallback point**: `getPageFromEvent(event)` is called immediately after extracting form shortcode
3. **In state metadata**: `state.md.pageid` is stored after form resolution

This means per-page configuration lookups can be performed at the fallback point without requiring structural changes to the event flow.

---

## Future: Per-Page Defaults Design

To support per-page default forms:

1. **Add column to `facebook_pages`**:
   ```sql
   ALTER TABLE facebook_pages ADD COLUMN default_form_shortcode VARCHAR;
   ```

2. **Query page config before applying env var fallback** (in `getMetadata()`):
   ```javascript
   if (!md.form) {
     const pageConfig = await getPageConfig(md.pageid)
     md.form = pageConfig?.default_form_shortcode || process.env.FALLBACK_FORM
   }
   ```

3. **Dashboard API** to set/get page defaults:
   ```
   PATCH /api/v1/facebook-pages/{pageid}/config
   GET /api/v1/facebook-pages/{pageid}/config
   ```

4. **Precedence**:
   - Explicit form in referral URL (highest priority)
   - Page-specific default from database
   - Global fallback environment variable (lowest priority)

---

## Testing Scenarios

| Scenario | URL | Expected Form |
|----------|-----|---|
| Referral at top level of webhook (`m.me` link) | `?ref=form.ABC.x.y` | `ABC` |
| Referral inside a **quick_reply payload string** (ad-click button) | `payload: "{\"referral\":{\"ref\":\"form.ABC\"}}"` | `ABC` (fixed in v0.0.212, VIR-19) |
| Referral inside a **postback payload string** | `payload: "{\"referral\":{\"ref\":\"form.ABC\"}}"` | `ABC` (fixed in v0.0.212, VIR-19) |
| Malformed payload string | `payload: "{\"referral\": {"` | No throw; treated as a normal interaction |
| Form pair not first | `?ref=creative.x.form.ABC` | `ABC` (`_group` is order-independent) |
| Handover arrives before the referral | — | Referral's form — the handover blank-starts `FALLBACK_FORM`, then the referral switches to the referred form. `state.forms` retains the transient fallback entry |
| No form, page has default | (no form param) | Page's default |
| No form, no page default | (no form param) | `FALLBACK_FORM` env var |
| Empty ref | `?ref=blah` | Fallback (parsing fails) |
| Form specified + page default | `?ref=form.ABC` | `ABC` (URL takes precedence) |
| User already has form | `?ref=form.ABC` | No-op (form already in history) |
| User is referrer | (self-referral case) | No-op (prevent loop) |
| Blocked user | any | No-op (user blocked) |

---

## Related Code

- **Webhook handler**: `botserver/server/handlers.js:handleMessengerEvents()`
- **Event normalization**: `replybot/lib/event-normalizer.js:categorizeMessengerEvent()` (Messenger), `categorizeWhatsAppEvent()` (WhatsApp)
- **Payload parsing**: `replybot/lib/event-normalizer.js:parsePayload()`
- **Event categorization**: `replybot/lib/typewheels/machine.js:categorizeEvent()`
- **REFERRAL handler**: `replybot/lib/typewheels/machine.js:285-310`
- **Blank start**: `replybot/lib/typewheels/machine.js:_blankStart()`, `_handleExternalEvent()`
- **Metadata extraction**: `replybot/lib/typewheels/utils.js:getMetadata()`
- **Field lookup** (source of `FIELD_NOT_FOUND`): `replybot/lib/typewheels/form.js:getField()`
- **Tests**: `replybot/lib/typewheels/utils.test.js`, `machine.test.js`, `events.test.js`
