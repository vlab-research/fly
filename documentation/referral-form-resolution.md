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
      md = _group(pairs.map(_decodeToken))
    }
  } catch (e) {
    md = {}
    referral = null
  }

  // fly-owned; see "The encoded ref" below. DELIBERATELY outside the catch.
  delete md.vt
  if (md.r !== undefined) {
    const { form, token } = decodeRecruitmentRef(md.r)
    delete md.r
    md.form = form
    md.vt = token
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
- **The encoded-ref branch is outside the `try`/`catch`, deliberately.** See
  "The encoded ref" below — a decode failure must not fall through to the
  fallback survey.
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

#### AMENDED 2026-08-17 — the fifth entry point is now conditional: a SYNTHETIC event may not blank-start

The five paths above were `TEXT`, `MEDIA`, `QUICK_REPLY`, `POSTBACK` and
`_handleExternalEvent`. **`_handleExternalEvent` has two callers and only one of
them is a real platform event**, and the difference turned out to matter:

| Caller | `source.type` | At `START` |
|---|---|---|
| `HANDOVER_EVENT` — Messenger `pass_thread_control` | `messenger` | **still blank-starts** `FALLBACK_FORM` — this is the ad-click race described above, and it is the designed behaviour |
| `EXTERNAL_EVENT` — dean `timeout`, dinersclub payment result, linksniffer click, moviehouse video event | `synthetic` | **`_noop()`** — the event is dropped; no message, no form, state unchanged |

**Why synthetic is different.** Each of those synthetic events exists *only
because a conversation already exists*: dean selects a `states` row sitting in
`WAIT_EXTERNAL_EVENT`, a payment result requires an issued payment, a click or a
video event requires a field to have been rendered and sent. So `START` is
self-contradictory — it means the replayed log is not this conversation's log,
either because the scribble `messages` sink has not archived it yet or because the
event named an account the conversation does not live on (`linksniffer` and
`moviehouse` read their `pageid` from a researcher-authored webview query string).

Falling through to `FALLBACK_FORM` there is the **third** instance of the same
failure shape as VIR-19 and the CTWA order-dependence bug below: `305` is a real,
live survey in the same account, but not the survey the participant should be
on — their answers are misattributed to it, and because it finishes in one
message the misroute looks like a completion rather than an error. Unlike the
handover race it is not recoverable by a following referral, because there is
no following referral — nobody is arriving.

**The discriminator is `source.type === 'synthetic'`, not "arrived through
`_handleExternalEvent`".** A guard written the second way would have broken every
Click-to-Messenger ad, because the handover race above is exactly that shape.

An exodus `bailout` at `START` is also **not** deferred: it names its own form, so
it never resolves through `FALLBACK_FORM` at all.

Details, including why an error state with a retryable tag was rejected in favour
of a silent-but-logged deferral: `replybot/README.md` ("A SYNTHETIC event may not
blank-start"), `documentation/states-debugging.md` ("The degraded path") and
`planning/conversation-identity.md` §7.1 (CORRECTED 2026-08-17).

#### AMENDED 2026-08-17 (2) — the sixth entry point: `REFERRAL` now guards too, and the ad-click race has THREE webhooks

The five paths above guard on `state.state === 'START'`. The `REFERRAL` case did
not, and that was the last unguarded entry into `FALLBACK_FORM`. It now refuses a
**form-less** entry on a conversation that already has a form. See
[A form-less entry event may not re-enter a live conversation](#a-form-less-entry-event-may-not-re-enter-a-live-conversation-resolved-2026-08-17)
below for the measurement and the fix.

**A single ad click emits three webhooks, not two.** The section above describes
the handover and the referral. Traced in `chatroach.messages` on two independent
pages and months, the full sequence is:

| # | Webhook | Timing | At `START` | On a LIVE conversation |
|---|---|---|---|---|
| 1 | `pass_thread_control` handover | ~1.5 s **before** the referral | **blank-starts** `FALLBACK_FORM` — designed | `UPDATE_STATE` / wait fulfilment; harmless |
| 2 | the referral (top-level, or inside a quick_reply/postback payload) | the click | starts the **referred** form | **switches** to the referred form — designed |
| 3 | bare `get_started` postback | 1–4 s **after** the referral | **blank-starts** `FALLBACK_FORM` — this is organic entry, and must keep working | **`_noop()`** since 2026-08-17; previously appended `FALLBACK_FORM` to the live stack |

Webhook 3 is the one that had no guard. Note that in the *handover-first*
ordering it was already harmless — the handover has by then put `FALLBACK_FORM` on
the stack, so `_hasForm` absorbs it — which is part of why it stayed invisible for
six years. The damaging ordering is the one production actually traces:
referral first, `get_started` 1.2 s later, onto a stack that does **not** contain
the fallback.

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

## A form-less entry event may not re-enter a live conversation (resolved, 2026-08-17)

**Status: fixed and DEPLOYED TO PRODUCTION** in the Phase 1.3 deploy, 2026-08-25
(replybot v0.0.221). Corrected 2026-08-26 — this previously read "fixed on branch
`feature/conversation-identity`, not yet deployed", which had been false since the
deploy. Live in production from at least **2020-06 until the deploy of this fix** — the
longest-running instance of this failure family, and the third after VIR-19 and the
CTWA order-dependence below: a ref that fails to resolve silently becomes survey
`305`.

The fix is in `machine.js`'s `REFERRAL` case (`_refNamesForm` + a `_noop()`). It is
**not logged**, so there is no tag to count; the detector query and the behavioural
change are at the end of this section.

`categorizeMessengerEvent` (`event-normalizer.js:37`) maps Messenger's bare
"Get Started" postback to a conversation entry:

```js
if (referral || postbackPayload === 'get_started') {
  return { event_type: 'conversation_started',
           payload: { type: 'conversation_started', trigger: 'referral', referral } }
}
```

On that branch `referral` is `undefined`. So `categorizeEvent` routes it to
**`REFERRAL`** (§5), `getForm(nxt)` finds no ref and resolves `FALLBACK_FORM`,
`_hasForm(state, '305')` is false for anyone whose real form is not `305`, and
`_blankStart` pushes `305` onto the form stack **at any state** — replacing `md`
wholesale, so `creative`/`gender`/`geography` are wiped.

**Unlike every other path in §6b, this one had no `state.state === 'START'`
guard.** `TEXT`, `MEDIA`, `QUICK_REPLY` and `POSTBACK` all blank-start only from
`START`; the `REFERRAL` case blank-started unconditionally, because a referral is
normally *supposed* to be able to switch a live participant onto a new form. That
is correct for a referral naming a form and wrong for an entry event naming none.

**`get_started` is not the only shape that names no form.** A *referral* can carry
a `ref` that yields no `form` pair, and production has several:
`clickToMessengerAds`, `homescreenpwa`, `murchida`,
`xav_pl_fb_external_link_ios`, and referral objects with no `ref` field at all
(15 of the 22 measured referral-driven cases). Every WhatsApp CTWA referral without
a resolvable `ref` is the same shape. These are 4% of the population and are
misroutings for exactly the same reason, so the fix keys on **"the entry names no
form"**, not on "the event was a `get_started`".

**Why it fires in practice: a single ad click emits both webhooks.** Traced in
`chatroach.messages` on two independent pages and months, same sequence:

```
13:16:00.474  referral  ref="creative.Static Hausa -parents.Age.Age.State.Bauchi State.form.mnchweeklanguage"
13:16:01.653  {"postback":{"title":"Get Started","payload":"get_started"}}      <- 1.2s later
13:16:03.524  forms:["mnchweeklanguage","305"]   md:{form:"305",startTime,pageid,platform,seed}
13:16:04.53   ERROR
```

This is the *third* webhook in the ad-click race documented in §6b — the handover
at ~1.5 s before the referral, the quick_reply carrying the referral, and this
one after it. The first two are handled; this one is not.

**Consequence is misattribution, not loss.** On the `ecd` page the participant's
answer to the language question was recorded as `shortcode: '305'`,
`question_ref: 'end'`, and they were told *"Sorry, I can't accept any responses
now."* Their real survey shows them as having dropped out.

**Production exposure, measured 2026-08-17.** The discriminating shape is `305`
**appended** to an existing stack, because VIR-19 and the CTWA defect both produce
`forms = ["305"]` of length 1:

| Measure | Count |
|---|---|
| `md.form = '305'`, `forms = ["305"]` only (cause (a)/(b), or a page that legitimately enters on 305) | 162,148 |
| **`305` appended and last** | **3,732** |
| ...whose 305 start post-dates the participant's earliest non-305 response | 2,725 |
| ...outside both known windows | 2,722 |
| Resulting-state split of the 3,732 | `END` 2,486 · `ERROR` 824 · `BLOCKED` 354 · `QOUT` 58 · `USER_BLOCKED` 9 · `START` 1 |

Chronic at 10–90 rows/month, continuously from **2020-06** through 2026-08 — six
years, not two. The oldest affected `md.startTime` is 2020-06.

**Do not use "no targeting keys in `md`" to identify this.**
`creative`/`gender`/`geography`/`ctwaprobe` appear **zero** times across all
168,041 `md.form='305'` rows — a fallback start has no ref to read them from, so
the absence is the definition of a fallback rather than a fingerprint of a cause.
Use the `forms` length.

### What state were those conversations actually in? (measured, and it changed the fix)

The table above gives **resulting** states, which is not the same question. 561 of
the 3,732 conversations (a stratified sample, ≥8 per calendar month across all 76
months) had their real `chatroach.messages` logs replayed through `machine.exec` /
`machine.apply` with `FALLBACK_FORM=305`, reproducing production's own
user-keyed replay. 521 reproduced the append; the state **at the moment `305` was
appended** was:

| Prior state | Count | Share |
|---|---|---|
| `END` | 263 | 50% |
| `QOUT` | 117 | 22% |
| `RESPONDING` | 73 | 14% |
| `WAIT_EXTERNAL_EVENT` | 34 | 7% |
| `BLOCKED` | 30 | 6% |
| `ERROR` | 4 | 1% |
| `START` | **0** | — |

So **44% were mid-survey** — the discriminator is unambiguously correct for them —
and **50% were re-engagement after finishing**. Not one was at `START`, and every
append was onto a **non-empty** form stack.

**What appended the `305`:** a bare `get_started` in 499 cases (96%), a referral
whose ref named no form in 22 (4%).

**Only ~11% is the ad-click race.** 56 of the 73 `RESPONDING` cases arrived within
5 s of the participant's own last inbound event — that is the traced
referral→`get_started` sequence, and `RESPONDING` is what `apply(SWITCH_FORM)`
leaves behind. The rest arrive much later: of the 499 `get_started` appends, 62 came
within 5 s of the participant's last message, 105 within a minute, 127 within an
hour, and **129 more than a day later**. The dominant mechanism is therefore *not*
the race documented in §6b — it is a participant tapping Get Started again on a
conversation they already have, days or weeks later.

### Entry must keep working, and it does — measured separately

162,148 `states` rows are `FALLBACK_FORM` conversations with a length-1 stack. A
452-conversation stratified sample of those was replayed the same way, to see what
event actually enters them (450 reproduced):

| Entering event | Count | Share |
|---|---|---|
| plain `text` | 188 | 42% |
| **bare `get_started`** | **159** | **35%** |
| `media` | 80 | 18% |
| referral whose ref names no form | 13 | 3% |
| `quick_reply` | 7 | 2% |
| `pass_thread_control` handover | 3 | 1% |

**A bare `get_started` is not the sole organic entry signal — plain text is
commoner — but it is roughly a third of them**, some 57,000 conversations, and
**158 of those 159 had no referral anywhere in their log**. So it cannot be ignored
or demoted in the normalizer; the guard has to be precise. Two properties make it
so: all 450 entries happened on the **first event the machine acted on**, so
`forms: []` and `state: 'START'` coincided for every one of them.

### The fix

`replybot/lib/typewheels/machine.js`, `REFERRAL` case, after the existing
`USER_BLOCKED` / `_hasForm` / self-referrer guards:

```js
if (!_refNamesForm(nxt) && state.forms.length) return _noop()
return _blankStart(nxt)
```

Two choices in there are load-bearing:

1. **The discriminator is the REF, not the resolved form.**
   `getForm(nxt) === process.env.FALLBACK_FORM` reads as the obvious equivalent and
   is wrong: a ref may name the fallback shortcode *explicitly*. Production has
   three live rows entered on `?ref=form.305.country.iraq` (the Iraq vaccination
   page, `pageid 102398018371948`), which are real referrals and must keep
   switching forms. `_refNamesForm` re-uses `_group` from `utils.js`, so it cannot
   disagree with `getMetadata` about whether a ref carries a form — including the
   even-token-boundary rule.
2. **The state test is `state.forms.length`, not `state.state !== 'START'`.** They
   agree on all 3,732 appends and all 450 entries, and `forms.length` is safer
   where they diverge: a `machine_report` error arriving before entry leaves the
   conversation in `ERROR` with an empty stack, and refusing entry there would
   strand a participant who has no conversation at all.
**`_noop()`, not a bespoke refusal action.** `_noop` returns `newState`, so
`lib/index.js` publishes it and `scribble/state.go` UPSERTs it back over the live
conversation's own `states` row. The content is byte-identical — `apply`'s default
branch returns `state` unchanged — so only `updated` moves, and nothing reads
`updated` for correctness (dean's `Timeouts()`/`Payments()` key off `current_state`
and `calculated_timeout_date`). Skipping that write was the only thing a separate
action bought, and it did not justify a second vocabulary for "nothing happened".
Same treatment as the synthetic refusal in §6b's first amendment.

**Nothing is logged.** Neither refusal emits a greppable tag, so neither rate is
measurable from pod logs. Use the `states` detector queries below instead.

### Behavioural change, named rather than slipped in

**A participant at `END` who taps Get Started again now receives nothing at all.**
Previously they were entered on `FALLBACK_FORM` — production `305`, a live survey
in the same account but not the one they were on — where their subsequent answers
were recorded under that shortcode instead. That is half the affected population,
so this is a real change and not a corner.

It is the right change for three reasons: the documented restart mechanism is
`REPLYBOT_RESET_SHORTCODE` (`"reset"` in staging and production), reached through
an explicit `form.reset` ref and **not** a bare `get_started`; every *other*
post-`END` interaction (text, media, quick_reply, postback) already declines to
start a new survey; and being silently moved onto a stranger's survey is worse than
silence. **A re-engagement affordance is now a deliberate gap**: if one is wanted,
it should be an explicit `form.<shortcode>` ref or a named product feature, not a
side effect of an unguarded entry path.

Two further consequences, accepted:

- **A `QOUT` participant (22%) is not sent their pending question again.**
  `_hasForm` already does exactly that for someone whose live form *is* the
  fallback, so extending it here is tempting — and it is a product decision with
  its own state write, so it was deliberately not taken in a bug fix.
- **On WhatsApp the refused event is the participant's own message.** A CTWA
  arrival with no resolvable `ref` on a live conversation is dropped, message and
  all, where Messenger's `get_started` carries no content. Still strictly better
  than silently misrouting them onto `FALLBACK_FORM`, and they recover by sending
  anything else. The alternative — re-interpreting the entry as a survey answer —
  is the VIR-19 failure mode and was rejected.

### Detector

The historical population, and the check that no new rows appear after the deploy.
The sharpened form excludes the explicit-`form.305` referrals: a fallback start has
exactly the five generated `md` keys (plus any `e_*` event metadata), so **any other
key proves the form came from a ref**. This is the analogue of `md.pageid <> pageid`
for cross-account leakage — 3,729 of 3,732 rows, with the 3 legitimate ones cleanly
excluded:

```sql
-- Form-less entry appended to a live conversation. Substitute FALLBACK_FORM for '305'.
SELECT userid, pageid, current_state, state_json->'forms' AS forms, form_start_time
  FROM chatroach.states
 WHERE current_form = '305'
   AND jsonb_array_length(state_json->'forms') > 1
   AND NOT EXISTS (
     SELECT 1 FROM jsonb_object_keys(state_json->'md') AS k
      WHERE k NOT IN ('form', 'startTime', 'pageid', 'platform', 'seed')
        AND k NOT LIKE 'e\_%')
 ORDER BY form_start_time DESC;
-- 3,729 rows as of 2026-08-17; drop the NOT EXISTS clause to get 3,732 including
-- the 3 deliberate `?ref=form.305.country.iraq` referrals.
```

Post-deploy the live rate is **not directly measurable**. The refusal is a
`_noop()` and emits no log line, and it appends nothing to `forms`, so a refused
event leaves neither a row nor a tag to count. What the SQL above still gives you is
the *absence* of new appends: run it periodically, and new rows matching it mean the
guard has been bypassed. There is no positive signal that the guard is being reached
at all — that was the cost of dropping the greppable tag, and it was accepted
deliberately.

### Regression coverage

- `replybot/lib/typewheels/machine.test.js` — describe **"a form-less entry event
  must not re-enter a live conversation"** (17 tests). Drives the **raw** traced
  production sequence (top-level referral with the real Bauchi ref, then the bare
  `get_started` 1.179 s later) through `parseEvent`, and asserts the live
  conversation is byte-for-byte unchanged (`after.should.eql(before)`). Also pins
  every preserved behaviour: first-event entry, entry on a non-`START` formless
  state, the explicit `form.<fallback>` referral, the `_hasForm` QOUT repeat,
  `USER_BLOCKED`, the reset shortcode, and the handover-then-referral ordering.
- `replybot/lib/typewheels/transition.test.js` — describe **"form-less entry
  on a live conversation)"** (5 tests). The shell half: no `newState`, so no
  `states` UPSERT and no cache write; no report, no command, no response; and the
  contrast case, where the same webhook on an empty conversation still enters and
  still sends.
- `replybot/lib/event-normalizer.test.js` — "keeps the bare `get_started` an entry
  signal, with no referral to resolve", pinning the normalizer *against* the
  tempting fix that would break organic entry.

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
| **WhatsApp text**, form pair first | `text: "form.ABC"` | `ABC` |
| **WhatsApp text**, form pair last | `text: "creative.x.form.ABC"` | `ABC` (fixed in v0.0.219; previously `FALLBACK_FORM`) |
| **WhatsApp text**, form pair in the middle | `text: "creative.x.form.ABC.gender.men"` | `ABC` |
| **WhatsApp CTWA autofill**, form pair last (live failure, 2026-08-16) | referral with no `ref` + `text: "ctwaprobe.alpha.creative.Ad1H.form.probetest"` | `probetest`, with `ctwaprobe: 'alpha'` / `creative: 'Ad1H'` in `md` (fixed in v0.0.219; on v0.0.218 this resolved to `305`) |
| **WhatsApp text**, `start ` prefix | `text: "start creative.x.form.ABC"` | `ABC` |
| **WhatsApp text**, form key on an odd token boundary | `text: "creative.form.ABC"` | No entry — stays `user_text` (`_group` could only yield `{ creative: 'form' }`, never a form) |
| **WhatsApp text**, mid-survey free-text answer | `text: "tell me about form.abc please"` | No entry — stays `user_text` (anchored full-match) |
| Handover arrives before the referral | — | Referral's form — the handover blank-starts `FALLBACK_FORM`, then the referral switches to the referred form. `state.forms` retains the transient fallback entry |
| **Bare `get_started` postback, first event** (organic Messenger entry) | `payload: "get_started"` | `FALLBACK_FORM` — 35% of production's fallback entries arrive this way |
| **Bare `get_started` postback, conversation already has a form** | `payload: "get_started"` | **No form.** `_noop()` — no message, no form, state unchanged (fixed 2026-08-17; previously appended `FALLBACK_FORM` to the live stack) |
| **Referral whose ref names no form**, first event | `?ref=clickToMessengerAds` | `FALLBACK_FORM` |
| **Referral whose ref names no form**, conversation already has a form | `?ref=clickToMessengerAds` | **No form.** `_noop()` (fixed 2026-08-17) |
| **Referral naming the fallback shortcode explicitly**, live conversation | `?ref=form.305.country.iraq` | `305` — an explicit ref is an explicit ref; still switches. Three live production rows depend on this |
| Bare `get_started` when the live form **is** `FALLBACK_FORM`, at `QOUT` | `payload: "get_started"` | Pending question repeated (`_hasForm`, unchanged) |
| **Synthetic external event on an empty conversation** (dean `timeout`, dinersclub payment result, linksniffer click, moviehouse video) | — | **No form.** `_noop()` — the event is dropped; no message, no form, state unchanged (fixed 2026-08-17; previously `FALLBACK_FORM`). See §6b's amendment |
| Exodus `bailout` on an empty conversation | — | The bail's own named form — deliberately not refused |
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
1. Hermes receives webhook, stamps with `source: "whatsapp"` and `phone_number_id` (`hermes/src/event.rs:stamp_whatsapp_event()`), publishes to Kafka unchanged
2. Replybot's `categorizeWhatsAppEvent()` (`replybot/lib/event-normalizer.js`) checks `if (data.referral)` — matches
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
- The recognized text is **order-independent** (since `replybot-v0.0.219`): the
  `form` pair may sit anywhere in the dotted token list, so a real ad reading
  `ctwaprobe.alpha.creative.Ad1H.form.probetest` resolves to `probetest` with
  `ctwaprobe` and `creative` reaching `md`. Both text paths share the one
  `_refFromText` helper, so this holds for `wa.me` links identically. See
  [CTWA autofill order-independence](#ctwa-autofill-order-independence-resolved-v00219).

So targeting metadata does reach `state.md` from ads — but it is authored **per ad
creative**, not per click. N targeting cells means N creatives, unlike Messenger
where one ad backs unlimited `m.me?ref=` variants.

### 2. Bare-Text Entry Fallback (wa.me links, manual typing)

WhatsApp users can start a survey by typing plain text matching
`/^(?:start\s+)?((?:(?:[A-Za-z0-9_-]|%[0-9A-Fa-f]{2})+\.(?:[A-Za-z0-9_-]|%[0-9A-Fa-f]{2})+\.)*)form\.((?:[A-Za-z0-9_-]|%[0-9A-Fa-f]{2})+)((?:\.(?:[A-Za-z0-9_-]|%[0-9A-Fa-f]{2})+)*)$/i`
(case-insensitive, full-match):

```
User: "form.ABC123"
User: "FORM.ABC123" 
User: "start form.ABC123"
User: "form.ABC123.creative.3b.gender.men"   → md gets creative/gender too
User: "creative.3b.gender.men.form.ABC123"   → identical result; form pair last
```

Since `replybot-v0.0.217` the trailing `.key.value` pairs are carried through to
`getMetadata()`/`_group`, giving prefilled-text `wa.me` links the same metadata
capability as `m.me?ref=`. The pattern stays anchored/full-match, so a mid-survey
free-text answer still cannot re-trigger entry. An odd token count
(`form.ABC.creative`) matches deliberately and leaves the dangling key
`undefined` rather than throwing.

**This path is order-independent too (since `replybot-v0.0.219`).** The `form`
pair may sit anywhere in the token list, matching what `_group` has always done
(§6) and what Messenger refs have always looked like in production
(`creative.3b.gender.men.form.hpvintrotriple`). The three capture groups are
leading pairs / shortcode / trailing tokens, and `_refFromText` reassembles them
with the literal `form` token lowercased — the shortcode and every other token
keep the case as typed. The whole ref body is handed to `getMetadata()`/`_group`;
the normalizer does not parse key/value pairs itself.

Two constraints survive the change:

- **Still anchored, full-match.** No whitespace is permitted inside the token
  list, so `tell me about form.abc please` and
  `I already did creative.x.form.abc yesterday` remain plain `user_text`.
- **The `form` pair must begin on an even token boundary.** `_group` pairs
  tokens two at a time, so a `form` token landing in a *value* slot resolves to
  no form at all — `creative.form.ABC` groups to
  `{ creative: 'form', ABC: undefined }`. The leading `(?:key\.value\.)*` group
  enforces the boundary, and such a message is deliberately left as `user_text`
  rather than synthesized into a referral that could only resolve to
  `FALLBACK_FORM`.

Before `v0.0.219` the pattern was anchored on a leading `form.`
(`/^(?:start\s+)?form\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)$/i`), which
contradicted §6 and silently dropped every form-last ref to `FALLBACK_FORM`.
See [CTWA autofill order-independence](#ctwa-autofill-order-independence-resolved-v00219).

#### Percent-encoded metadata values

Real targeting values contain spaces — `Static English - Girls`, `Bauchi State`,
`South East`. They travel **percent-encoded**:

```
form.ABC123.creative.Static%20English%20-%20Girls.state.Bauchi%20State
  → { form: 'ABC123', creative: 'Static English - Girls', state: 'Bauchi State' }
```

`getMetadata` has always decoded (`_group(pairs.map(...))` over
`decodeURIComponent`); what was missing was the **entry gate** — `%` was not in
the character class, so an encoded autofill message failed to match, no
`conversation_started` was derived, and the arrival landed on `FALLBACK_FORM`.
This matters most on CTWA, where there is no advertiser-settable `ref` and the
autofill text is the only carrier.

The gate accepts only **well-formed** escapes (`%[0-9A-Fa-f]{2}`), never a bare
`%`. A bare `%` would admit `%zz`, a trailing `%`, or a truncated `%2` — each of
which makes `decodeURIComponent` throw. `getMetadata` swallows that throw
(`catch (e) { md = {} }`), so the whole `md` would come back empty and the user
would land on `FALLBACK_FORM` anyway: the same silent misroute, in a
harder-to-spot form. Malformed escapes are therefore rejected at the gate and
simply never start a conversation.

**Well-formed hex is necessary but not sufficient.** `%FF`, `%C3`, `%80` and
`%E2%82` are all valid `%XX` octets that `decodeURIComponent` still throws on,
because they are not valid UTF-8 — and UTF-8 well-formedness is not practically
expressible as a regex. That residual is absorbed in `getMetadata` instead: it
decodes **per token** via `_decodeToken`, which returns the raw token when
decoding fails. So one malformed value can no longer discard the entire `md`
(including `form`) and cost the user their survey — the form still resolves and
the bad value survives verbatim (`k: '%FF'`), visible and debuggable rather than
vanished. This also covers the Messenger path, which had the identical exposure.

**For link and ad authors:** Python's `quote()` never encodes `.`, `-`, `_` or
`~`. A `.` in a value will **corrupt the pair structure** (it reads as a
separator), and `~` is not in the gate's alphabet and will fail the match
outright. Encode or strip both before building the ref. The older caveat about
raw `&` and `#` truncating a `wa.me?text=` link still applies.

**Flow:**
1. Hermes receives webhook, stamps and publishes to Kafka
2. Replybot's `categorizeWhatsAppEvent()`: no referral present + `_refFromText(data)` matches
3. On match, **synthesizes** `event_type: 'conversation_started'`, `payload.referral: { ref: "<matched ref>" }`
4. Rest of flow identical to CTWA path
5. Pattern is intentionally strict to prevent mid-survey answers from re-triggering entry

`_refFromText` is the single shared helper for **both** WhatsApp text paths —
the bare-text `wa.me` entry here and the CTWA autofill recovery in §1 — so the
two cannot drift apart. Any change to entry-token syntax lands in both at once.

**Shortcode case preservation:**
- Pattern matches case-insensitively (`/i` flag)
- Only the literal `form` token is lowercased, wherever it sits in the list
- Shortcode and all metadata tokens preserved exactly as typed
- `FORM.MyForm` → ref becomes `form.MyForm`
- `Creative.X.FORM.MyForm` → ref becomes `Creative.X.form.MyForm`

**Full test coverage** (`event-normalizer.test.js`, describes: "bare-text form
ref entry", "Messenger-parity metadata", "form pair in any position
(order-independent)", "mid-survey free text never re-triggers entry", and the
end-to-end "WhatsApp entry text → md.form"):
- Valid: `form.abc`, `FORM.ABC`, `start form.abc`, `  form.abc  ` (whitespace tolerated)
- Valid, form pair not first: `creative.x.form.ABC`,
  `creative.x.form.ABC.gender.men`, `ctwaprobe.alpha.creative.Ad1H.form.probetest`
- Invalid: `tell me form.abc` (extra text), `form.` (no shortcode), `form.abc@def` (invalid chars)
- Invalid: `creative.form.ABC` (form key on an odd token boundary — unresolvable by `_group`)
- Allows underscore/hyphen in shortcode
- Rejects mid-sentence refs, form-first or form-last

### CTWA autofill order-independence (resolved, v0.0.219)

**Status**: fixed in `replybot-v0.0.219`. Broken from `v0.0.217` (when the
autofill recovery path was introduced) until `v0.0.219`; reproduced live on
**2026-08-16** against `replybot-v0.0.218`.

`WHATSAPP_ENTRY_REF` was anchored on `form.` coming **first** in the dotted
token list, contradicting §6's guarantee that `_group` is order-independent.
Real refs are routinely written form-last — Messenger's own production refs look
like `creative.3b.gender.men.form.hpvintrotriple` — so a CTWA ad whose
`autofill_message` read

```
ctwaprobe.alpha.creative.Ad1H.form.probetest
```

failed the pattern outright. Because a CTWA referral carries no usable `ref` of
its own, the autofill text is the **only** recovery path, so the arrival kept no
ref at all and `getMetadata` fell through to `FALLBACK_FORM=305` — a real, live
survey in the same account, but not the one the participant should be on, so
their misrouted answers look like completions rather than errors. Exactly the
VIR-19 failure shape, from a different cause.

The pattern now accepts a `form` pair in any position and hands the **whole**
matched body to `getMetadata()`/`_group` (it must not re-prefix `form.`, which
would produce `form.ctwaprobe.alpha...`). The one new restriction is the even
token boundary described above, which rejects only lists `_group` could never
have resolved a form from anyway.

Regression coverage lives in `replybot/lib/event-normalizer.test.js`: the
describe "bare-text form ref entry — form pair in any position
(order-independent)", the form-last case inside the CTWA autofill describe, and
the end-to-end "WhatsApp entry text → md.form" describe, which drives raw
hermes-shaped webhooks through `parseEvent` into `getMetadata` and asserts the
resolved shortcode is `probetest` rather than `305`.

### 3. Metadata Constraints (`getMetadata`, typewheels/utils.js)

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

## The encoded ref (`md.r` → `md.form` + `md.vt`)

A second ref format, opt-in per study, alongside the dotted one. Where the
dotted ref spells the whole stratum vocabulary out
(`creative.Static English.Age.Age.State.Bauchi.form.mnchweek`), the encoded ref
carries just a shortcode and an opaque token:

```
r.<base64url(v1 | len(shortcode) | shortcode | token)>
```

- `base64url` unpadded — alphabet `[A-Za-z0-9_-]`, so it contains no `.` and
  cannot collide with the dotted key/value grammar, and it passes fly's
  WhatsApp entry gate unencoded.
- **Length-prefixed, not delimited.** A delimiter is a character a shortcode
  might contain, and that failure would be a silent mis-route. The length is in
  *bytes*, not characters, because UTF-8 is variable width.
- The token is vlab's attribution join key, minted deterministically by adopt
  from `(study_id, stratum_id, creative_name, destination_name)`.

**fly decodes it locally** — `decodeRecruitmentRef` in
`replybot/lib/typewheels/utils.js`. No lookup, no shared state, no call to
vlab. The WhatsApp entry gate accepts a second anchor `r.<base64url>`
(`WHATSAPP_ENTRY_REF_ENCODED` in `replybot/lib/event-normalizer.js`) alongside
`form.<shortcode>`.

### A decode failure is loud, not swallowed

The decode branch sits **outside** `getMetadata`'s `try`/`catch`, and the
inversion is the point. That catch exists so one malformed metadata token does
not cost a respondent their survey: it discards `md` and lets `form` fall
through to `FALLBACK_FORM`. Here the reasoning reverses — the encoded ref is
the *only* carrier of the shortcode, so a ref that will not decode means fly
does not know which survey the person wanted. Falling through would put them in
a real but wrong survey, which is the exact silent misroute the format exists
to prevent.

So it throws `RefDecodeError` (tag `REF_DECODE`) and the respondent lands in a
**visible ERROR state**. The `RecruitmentRefDecodeErrors` alert watches it; see
`documentation/recruitment-arrival-health.md`.

### Ownership: fly owns `vt`, same as `ad_id`

`getMetadata` deletes `md.vt` **unconditionally and before** the decode branch.

The unconditional part is what matters, because of the case where the branch
does *not* run. A dotted ref like
`creative.Smiling.vt.injected.gender.women.form.mnchweek` parses through the
ordinary `_group` dot-pairing into `md.vt = "injected"` — and since there is no
`md.r`, the decode branch never fires to overwrite it. That author-set value
would then be the join key vlab attributes the respondent by: a silent mis-join
onto whichever attribution row happens to carry the token `injected`.

Only the decode branch may set `vt`. Same defence-in-depth `ad_id` gets below.
``owns `vt`: a dotted ref cannot inject a join key`` in `utils.test.js` is the
test that fails if anyone removes the delete.

`r` is fly-owned on the way out too: it is consumed into `form` and `vt` and
never left in the metadata, so nothing downstream sees a half-parsed ref.

### What vlab does with the token

vlab joins it against `ad_attributions.ref_token` to recover the respondent's
stratum. An extraction conf declaring `mapping: "ad_table_lookup"` names the
metadata key the token arrives under — `vt`, by this convention, though the key
is conf-declared rather than hardcoded on either side. See
`documentation/ad-attributions.md` in the vlab repo.

The token supersedes `ad_id` as the join key: `ad_id` rides Meta's referral
webhook, which Meta sends for only ~31% of Messenger ad entrants, while the
token rides a carrier vlab authors and so reaches everyone. `md.ad_id` below is
still captured, and still feeds arrival-health alerting — it is just no longer
what attribution joins on.

---

## Ad identity (`md.ad_id`)

vlab owns an `(network, ad_id) -> stratum metadata` mapping and fly's role is to
capture and expose the identifier. **Note that this is no longer what
attribution joins on** — the encoded ref's `vt` token superseded it, because
Meta sends the referral carrying `ad_id` for only ~31% of Messenger ad entrants
(see "The encoded ref" above). `md.ad_id` is still captured, still exported, and
still what the recruitment-health alerting gates on; it is simply not the join
key any more. Everything below still describes how it is resolved and owned.

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
- **Hermes webhook handler**: `hermes/src/handlers.rs:handle_whatsapp()`
- **Hermes event stamping**: `hermes/src/event.rs:stamp_whatsapp_event()`
- **Event normalization**: `replybot/lib/event-normalizer.js:categorizeWhatsAppEvent()`
- **Entry-token pattern** (`WHATSAPP_ENTRY_REF`, event-normalizer.js): order-independent
  since `v0.0.219` — `/^(?:start\s+)?((?:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.)*)form\.([A-Za-z0-9_-]+)((?:\.[A-Za-z0-9_-]+)*)$/i`
- **Text→ref helper**: `replybot/lib/event-normalizer.js:_refFromText()` — shared by
  the bare-text `wa.me` path and the CTWA autofill recovery path; lowercases only
  the literal `form` token and returns the whole ref body
- **Pattern tests**: `replybot/lib/event-normalizer.test.js` — describes
  "bare-text form ref entry", "Messenger-parity metadata", "form pair in any
  position (order-independent)", "mid-survey free text never re-triggers entry",
  "CTWA referral without a ref", and the end-to-end "WhatsApp entry text → md.form"

**Ad identity:**
- **Resolution rule (pure)**: `replybot/lib/typewheels/utils.js:adIdFromReferral()` — exported for unit testing; the accepted source keys/values live beside it in `AD_SOURCE_KEYS` / `AD_SOURCE_VALUES`
- **Stamping**: `replybot/lib/typewheels/utils.js:getMetadata()`
- **Responses projection**: `dashboard-server/queries/responses/response.queries.js` (`_all` and `responsesQuery`)
- **Export column**: `exporter/exporter/exporter.py` (`ALWAYS_EXPORTED_METADATA`, consumed in `format_data`)

**Cross-platform:**
- **Event categorization**: `replybot/lib/typewheels/machine.js:categorizeEvent()`
- **REFERRAL handler**: `replybot/lib/typewheels/machine.js`, `exec`'s `REFERRAL` case
- **Blank start**: `replybot/lib/typewheels/machine.js:_blankStart()`
- **"Did the ref name a form?"**: `replybot/lib/typewheels/machine.js:_refNamesForm()` —
  the discriminator that lets a form-less entry start a conversation but never
  re-enter one; re-uses `_group` from `utils.js`
- **Refusals**: both are plain `_noop()` returns from `machine.js` — the synthetic
  one in `_handleExternalEvent`, the form-less-entry one in the `REFERRAL` case.
  Neither is logged and neither has a distinct action or tag
- **Metadata extraction**: `replybot/lib/typewheels/utils.js:getMetadata()` / `_group()`
- **Field lookup**: `replybot/lib/typewheels/form.js:getField()`
- **Tests**: `replybot/lib/typewheels/utils.test.js` (`adIdFromReferral` — pure resolver, exhaustive), `replybot/lib/event-normalizer.test.js` (normalizer preserves `ad_id`/`source_type` unmodified), `replybot/lib/typewheels/machine.test.js` (`md.ad_id — ad attribution identity captured from the referral` — end-to-end raw webhook -> `parseEvent` -> `state.md`, including the post-vs-ad regression and the `ad_id` ref-token collision)
