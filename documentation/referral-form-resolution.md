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

**File**: `replybot/lib/typewheels/utils.js` — `getMetadata`

The `getMetadata(event)` function reads the referral off the **normalized** event
and applies the fallback:

```javascript
function getMetadata(event) {
  let md = {}
  let referral = null

  try {
    if (event.event_type === 'conversation_started') {
      referral = event.payload.referral
    }

    if (referral && referral.ref) {
      const pairs = referral.ref.split('.')
      md = _group(pairs.map(decodeURIComponent))
    }
  } catch (e) {
    md = {}
    referral = null
  }

  md.form = md.form || process.env.FALLBACK_FORM
  md.startTime = event.timestamp
  md.pageid = event.source.account_id
  md.platform = eventPlatform(event)

  // fly-owned; see "Ad identity" below
  delete md.ad_id
  const adId = adIdFromReferral(referral, md.platform)
  if (adId !== undefined) md.ad_id = adId

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

### Ad identity scenarios (`md.ad_id`)

| Scenario | Referral | `md.ad_id` |
|---|---|---|
| Messenger ad click | `{ ref: 'form.ABC', ad_id: '123' }` | `'123'` |
| Messenger, older event | `{ ref: 'form.ABC' }` | **absent** |
| WhatsApp CTWA ad | `{ source_type: 'ad', source_id: '120254866237980150' }` | `'120254866237980150'` |
| **WhatsApp organic post reshare** | `{ source_type: 'post', source_id: '999' }` | **absent** — `source_id` is a *post* id here |
| WhatsApp, no source fields | `{ ref: 'form.ABC' }` | **absent** |
| WhatsApp legacy spelling | `{ source: 'ads', source_id: '5' }` | `'5'` (accepted defensively) |
| Bare-text `wa.me` entry | none (synthesized) | **absent** — organic entrant |
| Ref token collides | `?ref=form.ABC.ad_id.injected` | fly's resolved value, or **absent** — never `'injected'` |

---

## WhatsApp Entry Point Mechanics

WhatsApp differs fundamentally from Messenger in referral delivery:

### 1. CTWA Referral Object (Click-to-WhatsApp Ads)

Meta sends WhatsApp CTWA ads with a referral object on the inbound message. The
shape below is a **real production arrival**, taken verbatim from the `messages`
table (2026-08-16; ids and URLs abbreviated):

```json
{
  "messages": [{
    "from": "15419799714",
    "type": "text",
    "text": { "body": "ctwaprobe.alpha.creative.Ad1H.form.probetest" },
    "referral": {
      "source_url": "https://fb.me/9nJxtZGUu",
      "source_id": "120254866237980150",
      "source_type": "ad",
      "headline": "Virtual Lab survey",
      "body": "Ga iyaye & Masu kula da yara...",
      "media_type": "image",
      "image_url": "https://scontent-bos5-1.xx.fbcdn.net/...",
      "ctwa_clid": "AfiIcrJAS9EeBfiF9otcaepBuFmP...",
      "welcome_message": { "text": "Welcome! Tap below to start the survey." }
    }
  }]
}
```

Two corrections, because earlier revisions of this document got both wrong:

- **The key is `source_type` and the ad value is `"ad"`** — singular key,
  singular value. Earlier revisions of this document (and `replybot/README.md`)
  showed `"source": "ads"`. No production payload, hermes type, or test fixture
  in this repo has ever carried that spelling; it looks like a transcription of
  *Messenger's* referral `source` field (`"ADS"`, `"SHORTLINK"`,
  `"CUSTOMER_CHAT_PLUGIN"`) — a different platform's different field. Code that
  reads the source type accepts both spellings defensively, but `source_type` is
  the one that actually arrives.
- **There is no `ref`.** Every field on the object is Meta-assigned. The form
  shortcode came from the autofill text on `text.body`.

**Flow:**
1. Hermes receives webhook, stamps with `source: "whatsapp"` and `phone_number_id` (hermes/event.rs:73-97), publishes to Kafka unchanged
2. Replybot's `categorizeWhatsAppEvent()` (event-normalizer.js:257-265) checks `if (data.referral)` — matches
3. Emits `event_type: 'conversation_started'`, `payload.referral: data.referral` (preserves entire object)
4. `getMetadata(event)` (utils.js) extracts `form` from `payload.referral.ref` (falling back to the autofill text), and `ad_id` from `source_id` when `source_type` says the arrival came from an ad — see [Ad identity](#ad-identity-mdad_id)
5. The remaining fields (`ctwa_clid`, `headline`, `body`, `media_type`, `source_url`, `image_url`, `welcome_message`) are preserved on the raw event but **not** mapped into state metadata

**A CTWA referral usually has no `ref` at all.** Every documented field on the
object (`source_url`, `source_id`, `source_type`, `headline`, `body`,
`media_type`, `ctwa_clid`) is Meta-assigned; `ref` appears in a single Meta doc
with no explanation of how to set it, and nobody has confirmed it can be. Since
`getMetadata` guards on `if (r && r.ref)`, a referral without one resolves to
`FALLBACK_FORM` — the VIR-19 failure shape, and just as invisible, because the
fallback is a real survey whose users look like completions.

**The autofill message is the actual carrier (since `replybot-v0.0.217+`).** A
CTWA ad's `autofill_message` prefills the user's first message, so the same
`form.<shortcode>[.key.value...]` token the `wa.me` path uses arrives on
`text.body` alongside the referral. When the referral carries no usable `ref`,
`categorizeWhatsAppEvent` derives one from that text instead of short-circuiting
past it. Precedence and guarantees:

- An explicit `referral.ref` always **wins** over the text.
- The rest of the referral object is preserved — `ctwa_clid` in particular, which
  is what Conversions API attribution keys on. The inbound object is not mutated.
- A CTWA arrival with neither a `ref` nor a matching autofill text still emits
  `conversation_started` (falling back to `FALLBACK_FORM`); it must not degrade
  into a plain `user_text`.
- The autofill text is held to the same anchored full-match strictness, so a
  non-matching ad reply cannot bypass entry rules.

So targeting metadata does reach `state.md` from ads — but it is authored **per ad
creative**, not per click. N targeting cells means N creatives, unlike Messenger
where one ad backs unlimited `m.me?ref=` variants.

### 2. Bare-Text Entry Fallback (wa.me links, manual typing)

WhatsApp users can start a survey by typing plain text matching
`/^(?:start\s+)?form\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)$/i`
(case-insensitive, full-match):

```
User: "form.ABC123"
User: "FORM.ABC123" 
User: "start form.ABC123"
User: "form.ABC123.creative.3b.gender.men"   → md gets creative/gender too
```

Since `replybot-v0.0.217` the trailing `.key.value` pairs are carried through to
`getMetadata()`/`_group`, giving prefilled-text `wa.me` links the same metadata
capability as `m.me?ref=`. The pattern stays anchored/full-match, so a mid-survey
free-text answer still cannot re-trigger entry. An odd token count
(`form.ABC.creative`) matches deliberately and leaves the dangling key
`undefined` rather than throwing.

**Flow:**
1. Hermes receives webhook, stamps and publishes to Kafka
2. Replybot's `categorizeWhatsAppEvent()` (line 277-293): `if (data.type === 'text' && !data.referral)` + pattern test
3. On match, **synthesizes** `event_type: 'conversation_started'`, `payload.referral: { ref: "form.XYZ" }`
4. Rest of flow identical to CTWA path
5. Pattern is intentionally strict to prevent mid-survey answers from re-triggering entry (line 280-281)

**Shortcode case preservation (line 284):**
- Pattern matches case-insensitively (`/i` flag)
- Captured shortcode case preserved exactly as typed
- Example: `FORM.MyForm` → captured as `MyForm` → ref becomes `form.MyForm`

**Full test coverage** (event-normalizer.test.js:567-651):
- Valid: `form.abc`, `FORM.ABC`, `start form.abc`, `  form.abc  ` (whitespace tolerated)
- Invalid: `tell me form.abc` (extra text), `form.` (no shortcode), `form.abc@def` (invalid chars)
- Allows underscore/hyphen in shortcode
- Rejects mid-sentence refs

### 3. Metadata Constraints (`getMetadata`, utils.js)

All platforms converge at `getMetadata()`:

```javascript
if (r && r.ref) {
  const pairs = r.ref.split('.')
  md = _group(pairs.map(decodeURIComponent))
}
```

**Messenger capability:**
- Input: `form.ABC.creative.x.gender.men`
- Output: `{ form: "ABC", creative: "x", gender: "men" }`
- Arbitrary key-value pairs can ride along

**WhatsApp CTWA capability** (since `replybot-v0.0.217`):
- Input: the ad's **autofill message**, e.g. `form.ABC123.creative.x.gender.men`,
  arriving on `text.body` — the referral object itself normally carries no `ref`
- Output: `{ form: "ABC123", creative: "x", gender: "men" }`
- **Targeted metadata does transport**, through exactly the same `_group` pairing
  as Messenger. The constraint is *authorship*, not capability: the token is
  written per ad **creative**, not per click, so N targeting cells means N
  creatives — unlike Messenger, where one ad backs unlimited `m.me?ref=`
  variants. See [The autofill message is the actual carrier](#1-ctwa-referral-object-click-to-whatsapp-ads) above.
- Additionally: `ad_id` from `referral.source_id` when ad-sourced (see below)

**WhatsApp bare-text capability** (since `replybot-v0.0.217`):
- Input: `form.ABC123.creative.x.gender.men` typed, or prefilled by
  `wa.me/<number>?text=` (synthesized into a referral by the normalizer)
- Output: `{ form: "ABC123", creative: "x", gender: "men" }`
- **Targeted metadata does transport** — full parity with `m.me?ref=`. Note the
  encoding caveat: raw `&` and `#` inside a `wa.me?text=` value silently truncate
  the prefilled message, so percent-encode them (`%26`, `%23`).
- No `ad_id`: there is no referral object and therefore no ad to attribute to.
  A bare-text arrival is an organic entrant.

> **Historical note.** Until this revision, both WhatsApp rows above read "No
> targeted metadata transport". That was already false when written — it
> contradicted this document's own v0.0.217 section a few dozen lines earlier,
> which describes the autofill/prefill carrier in detail. The claim is
> retired; do not reintroduce it.

---

## Ad identity (`md.ad_id`)

vlab keys ad attribution on an **opaque ad id** and owns the
`(network, ad_id) -> stratum metadata` mapping itself, joining at analysis time.
**Fly's entire role is to capture and expose that one identifier.**

This is purely additive. The legacy dotted-ref path above
(`creative.Static English.Age.Age.State.Bauchi.form.mnchweek` → dot-parsed into
`state.md`) is unchanged and **stays permanently** — existing Messenger studies
depend on it and will never migrate. Nothing is gated, removed, or deprecated.

### Resolution rule

`getMetadata` (`replybot/lib/typewheels/utils.js`) resolves `md.ad_id` from the
referral via the pure helper `adIdFromReferral(referral, platform)`:

| Platform | Source field | Gate |
|---|---|---|
| Messenger | `referral.ad_id` | none — Messenger only sets it for ad-sourced referrals, so the field is self-identifying. Older events simply lack it. |
| WhatsApp | `referral.source_id` | **only when `source_type` (or legacy `source`) is `ad`/`ads`**, case-insensitive |

**The WhatsApp gate is the critical correctness detail.** `source_id` is not an
ad-specific field. On an organic reshare of a page post the source is a *post*,
and `source_id` is then a **post id**. Capturing it unconditionally would write
post ids into the ad_id field, where they can never match vlab's mapping and
would pile up forever in the "unmapped" bucket that exists to catch real bugs. A
post-sourced arrival is an organic entrant and falls through with **no `ad_id`
key at all**.

When nothing resolves, the key is **absent** — not `null`, not `undefined`, not
the string `"undefined"`.

### Ownership and collisions

`ad_id` is a **fly-owned synthetic key**, in the same family as `md.form`,
`md.startTime`, `md.pageid` and `md.platform`: assigned *after* `_group`, so
fly's value wins any collision with a ref token. That ordering must be
preserved.

Ownership is total, including the negative case. A ref token literally named
`ad_id` (`?ref=form.ABC.ad_id.injected`) is **deleted** before fly stamps its own
value, so it can never leak into `md.ad_id` even when fly resolves nothing. The
column feeds vlab's join and has to be trustworthy — a study author who could
write into it would pollute the very unmapped bucket the gate protects.

### Notes

- **No `ad_network` key.** `md.platform` already holds `messenger`/`whatsapp`
  and vlab derives the network from it.
- **Captured once.** `getMetadata` runs at `conversation_started` and persists in
  `state.md`, so a single capture stamps every subsequent response.
- **`getMetadata` stays pure.** The resolution rule is unit-testable in
  isolation; `adIdFromReferral` is exported for exactly that.
- **`ctwa_clid` is deliberately NOT stamped.** It was considered and **deferred**
  to a separate stream — it is per-click rather than per-ad and belongs to
  Conversions API attribution, a different concern. Leaving it out keeps this
  change reviewable. It remains preserved on the raw event either way.

### Where it surfaces

| Surface | How |
|---|---|
| `state.md.ad_id` | stamped at conversation start |
| `responses.metadata->>'ad_id'` | `state.md` is persisted as the responses metadata blob |
| `GET /api/v1/responses` | projected as a first-class `ad_id` column (`dashboard-server/queries/responses/response.queries.js`) |
| Responses CSV download | same projection, same file |
| Responses export (`exporter/`) | always-on column via `ALWAYS_EXPORTED_METADATA` in `exporter/exporter/exporter.py` — not opt-in, so every export carries the join key |

The dashboard-server surfaces use a query-level projection
(`responses.metadata->>'ad_id' AS ad_id`) rather than a `STORED` computed column
like `responses.clusterid`. That needs no migration, works retroactively on
every existing row, and avoids a backfill on a very large production table. The
pagination cursors are untouched: `_all` encodes its token from
`(timestamp, userid, question_ref)` and `responsesQuery` from
`(userid, timestamp, question_ref)`; `ad_id` collides with neither.

### Test coverage

| File | Layer |
|---|---|
| `replybot/lib/typewheels/utils.test.js` | `adIdFromReferral` as a pure function — exhaustive: both platforms, both source spellings, post-sourced rejection, trimming/case, numeric ids, empty ids, cross-platform shapes |
| `replybot/lib/typewheels/machine.test.js` | end-to-end from a **raw** webhook through `parseEvent` → `getState` → `state.md`, covering every row of the scenarios table above plus persistence across a later reply |
| `replybot/lib/event-normalizer.test.js` | boundary pins that `ad_id` / `source_type` survive normalization onto `payload.referral` |
| `exporter/exporter/tests/test_exporter.py` | `ad_id` column present without opt-in, alongside requested keys, de-duplicated, null-safe, row-aligned |
| `dashboard-server/queries/responses/response.test.js` | the `metadata->>'ad_id'` projection against a real database |

Note that `replybot/lib/typewheels/events.test.js` is a **fixtures module**, not
a test suite, and its events are already normalized. Referral behaviour must be
exercised by building raw webhook shapes and running them through `parseEvent`,
as `machine.test.js` does — otherwise normalization is skipped and the test
proves less than it appears to.

---

## Related Code

**Messenger:**
- **Webhook handler**: `botserver/server/handlers.js:handleMessengerEvents()`
- **Event normalization**: `replybot/lib/event-normalizer.js:categorizeMessengerEvent()`
- **Payload parsing**: `replybot/lib/event-normalizer.js:parsePayload()`

**WhatsApp:**
- **Hermes webhook handler**: `hermes/src/handlers.rs:handle_whatsapp()` (line 124)
- **Hermes event stamping**: `hermes/src/event.rs:stamp_whatsapp_event()` (line 73-97)
- **Event normalization**: `replybot/lib/event-normalizer.js:categorizeWhatsAppEvent()` (line 254-395)
- **Bare-text pattern**: `/^(?:start\s+)?form\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)$/i` (event-normalizer.js)
- **Pattern tests**: `replybot/lib/event-normalizer.test.js:567-651`

**Ad identity:**
- **Resolution rule (pure)**: `replybot/lib/typewheels/utils.js:adIdFromReferral()` — exported for unit testing; the accepted source keys/values live beside it in `AD_SOURCE_KEYS` / `AD_SOURCE_VALUES`
- **Stamping**: `replybot/lib/typewheels/utils.js:getMetadata()`
- **Responses projection**: `dashboard-server/queries/responses/response.queries.js` (`_all` and `responsesQuery`)
- **Export column**: `exporter/exporter/exporter.py` (`ALWAYS_EXPORTED_METADATA`, consumed in `format_data`)

**Cross-platform:**
- **Event categorization**: `replybot/lib/typewheels/machine.js:categorizeEvent()`
- **REFERRAL handler**: `replybot/lib/typewheels/machine.js:285-310`
- **Blank start**: `replybot/lib/typewheels/machine.js:_blankStart()`
- **Metadata extraction**: `replybot/lib/typewheels/utils.js:getMetadata()`
- **Field lookup**: `replybot/lib/typewheels/form.js:getField()`
- **Tests**: `replybot/lib/typewheels/utils.test.js` (`adIdFromReferral` — pure resolver, exhaustive), `replybot/lib/event-normalizer.test.js` (normalizer preserves `ad_id`/`source_type` unmodified), `replybot/lib/typewheels/machine.test.js` (`md.ad_id — ad attribution identity captured from the referral` — end-to-end raw webhook -> `parseEvent` -> `state.md`, including the post-vs-ad regression and the `ad_id` ref-token collision)
