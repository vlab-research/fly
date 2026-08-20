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

#### AMENDED 2026-08-17 — the fifth entry point is now conditional: a SYNTHETIC event may not blank-start

The five paths above were `TEXT`, `MEDIA`, `QUICK_REPLY`, `POSTBACK` and
`_handleExternalEvent`. **`_handleExternalEvent` has two callers and only one of
them is a real platform event**, and the difference turned out to matter:

| Caller | `source.type` | At `START` |
|---|---|---|
| `HANDOVER_EVENT` — Messenger `pass_thread_control` | `messenger` | **still blank-starts** `FALLBACK_FORM` — this is the ad-click race described above, and it is the designed behaviour |
| `EXTERNAL_EVENT` — dean `timeout`, dinersclub payment result, linksniffer click, moviehouse video event | `synthetic` | **`DEFER`** — the event is dropped, nothing is published and nothing is cached |

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
| 3 | bare `get_started` postback | 1–4 s **after** the referral | **blank-starts** `FALLBACK_FORM` — this is organic entry, and must keep working | **`DEFER`** since 2026-08-17; previously appended `FALLBACK_FORM` to the live stack |

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

**Status: fixed on branch `feature/conversation-identity`, not yet deployed.** Live
in production from at least **2020-06 until the deploy of this fix** — the
longest-running instance of this failure family, and the third after VIR-19 and the
CTWA order-dependence below: a ref that fails to resolve silently becomes survey
`305`.

The fix is in `machine.js`'s `REFERRAL` case (`_refNamesForm` + a `DEFER`); the
greppable tag is **`FALLBACK_ENTRY_ON_LIVE_CONVERSATION`**; the detector query and
the behavioural change are at the end of this section.

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
if (!_refNamesForm(nxt) && state.forms.length) {
  return { action: 'DEFER', reason: DEFER_FALLBACK_ENTRY_ON_LIVE_CONVERSATION, event_type: nxt.event_type }
}
return _blankStart(nxt)
```

Three choices in there are load-bearing:

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
3. **`DEFER`, not `_noop()`.** `_noop` returns `newState`, `lib/index.js` publishes
   it and `scribble/state.go` UPSERTs it over the live conversation's real `states`
   row — the row every recovery sweep selects on — while bumping `updated`, by
   which dean and the dashboard age conversations. Nothing happened, so nothing is
   written: `DEFER` returns without `newState`, so neither `states` nor the Redis
   cache is touched. Same mechanism and same reasoning as the synthetic deferral in
   §6b's first amendment.

`DEFER` now carries a `reason`, and `transition.js` turns each reason into its own
greppable tag. This matters: `SYNTHETIC_EVENT_NO_CONVERSATION` is the instrument
for §7.1's "watch 24 h, expect zero" canary and must not be inflated by a defect
that is *expected* to register 10–90/month.

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

Post-deploy, the live rate is the **log tag**, not the table — the fix writes
nothing, so a refused event leaves no row to count:

```
kubectl logs -n vprod -l app=gbv-replybot --since=24h | grep -c FALLBACK_ENTRY_ON_LIVE_CONVERSATION
```

The line carries `state` and `form`, which splits the count into the ad-click race
(`"state":"RESPONDING"`, arriving 1–4 s after a referral) and re-engagement
(`"state":"END"`). Expect it to be non-zero and roughly to track the historical
10–90/month; a **zero** count means the guard is not being reached and something is
wrong, and new rows matching the SQL above mean it has been bypassed.

### Regression coverage

- `replybot/lib/typewheels/machine.test.js` — describe **"a form-less entry event
  must not re-enter a live conversation"** (17 tests). Drives the **raw** traced
  production sequence (top-level referral with the real Bauchi ref, then the bare
  `get_started` 1.179 s later) through `parseEvent`, and asserts the live
  conversation is byte-for-byte unchanged (`after.should.eql(before)`). Also pins
  every preserved behaviour: first-event entry, entry on a non-`START` formless
  state, the explicit `form.<fallback>` referral, the `_hasForm` QOUT repeat,
  `USER_BLOCKED`, the reset shortcode, and the handover-then-referral ordering.
- `replybot/lib/typewheels/transition.test.js` — describe **"DEFER (form-less entry
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
| **Bare `get_started` postback, conversation already has a form** | `payload: "get_started"` | **No form.** `DEFER` — nothing published, nothing cached (fixed 2026-08-17; previously appended `FALLBACK_FORM` to the live stack) |
| **Referral whose ref names no form**, first event | `?ref=clickToMessengerAds` | `FALLBACK_FORM` |
| **Referral whose ref names no form**, conversation already has a form | `?ref=clickToMessengerAds` | **No form.** `DEFER` (fixed 2026-08-17) |
| **Referral naming the fallback shortcode explicitly**, live conversation | `?ref=form.305.country.iraq` | `305` — an explicit ref is an explicit ref; still switches. Three live production rows depend on this |
| Bare `get_started` when the live form **is** `FALLBACK_FORM`, at `QOUT` | `payload: "get_started"` | Pending question repeated (`_hasForm`, unchanged) |
| **Synthetic external event on an empty conversation** (dean `timeout`, dinersclub payment result, linksniffer click, moviehouse video) | — | **No form.** `DEFER` — the event is dropped, nothing published, nothing cached (fixed 2026-08-17; previously `FALLBACK_FORM`). See §6b's amendment |
| Exodus `bailout` on an empty conversation | — | The bail's own named form — deliberately not deferred |
| No form, page has default | (no form param) | Page's default |
| No form, no page default | (no form param) | `FALLBACK_FORM` env var |
| Empty ref | `?ref=blah` | Fallback (parsing fails) |
| Form specified + page default | `?ref=form.ABC` | `ABC` (URL takes precedence) |
| User already has form | `?ref=form.ABC` | No-op (form already in history) |
| User is referrer | (self-referral case) | No-op (prevent loop) |
| Blocked user | any | No-op (user blocked) |

---

## WhatsApp Entry Point Mechanics

WhatsApp differs fundamentally from Messenger in referral delivery:

### 1. CTWA Referral Object (Click-to-WhatsApp Ads)

Meta sends WhatsApp CTWA ads with a referral object on the inbound message:

```json
{
  "messages": [{
    "from": "27123456789",
    "type": "text",
    "text": { "body": "Hi" },
    "referral": {
      "ref": "form.ABC123",
      "source": "ads",
      "source_id": "campaign_123",
      "ctwa_clid": "click_id",
      "headline": "ad headline",
      "body": "ad copy"
    }
  }]
}
```

**Flow:**
1. Hermes receives webhook, stamps with `source: "whatsapp"` and `phone_number_id` (`hermes/src/event.rs:stamp_whatsapp_event()`), publishes to Kafka unchanged
2. Replybot's `categorizeWhatsAppEvent()` (`replybot/lib/event-normalizer.js`) checks `if (data.referral)` — matches
3. Emits `event_type: 'conversation_started'`, `payload.referral: data.referral` (preserves entire object)
4. `getMetadata()` (`replybot/lib/typewheels/utils.js`) extracts `form` from `payload.referral.ref` only — but see `_refFromText` below, which supplies that `ref` from the autofill text when the referral has none
5. Extra fields (`source_id`, `ctwa_clid`, `headline`, `body`) are **not extracted or mapped to state metadata**

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
`/^(?:start\s+)?((?:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.)*)form\.([A-Za-z0-9_-]+)((?:\.[A-Za-z0-9_-]+)*)$/i`
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

**WhatsApp CTWA capability:**
- Input: the ad's `autofill_message`, recovered by `_refFromText` when the
  referral carries no `ref` of its own — e.g.
  `ctwaprobe.alpha.creative.Ad1H.form.probetest`
- Output: `{ form: "probetest", ctwaprobe: "alpha", creative: "Ad1H" }`
- Full key-value transport, but authored **per ad creative**, not per click:
  N targeting cells means N creatives. The Meta-assigned referral fields
  (`source_id`, `ctwa_clid`, `headline`, `body`) are preserved on the raw event
  but still not mapped into `md`.

**WhatsApp bare-text capability:**
- Input: `form.ABC123.creative.x.gender.men` or `creative.x.gender.men.form.ABC123`
  (synthesized into a referral by the normalizer; order-independent)
- Output: `{ form: "ABC123", creative: "x", gender: "men" }`
- Same key-value transport as `m.me?ref=` since `v0.0.217`

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

**Cross-platform:**
- **Event categorization**: `replybot/lib/typewheels/machine.js:categorizeEvent()`
- **REFERRAL handler**: `replybot/lib/typewheels/machine.js`, `exec`'s `REFERRAL` case
- **Blank start**: `replybot/lib/typewheels/machine.js:_blankStart()`
- **"Did the ref name a form?"**: `replybot/lib/typewheels/machine.js:_refNamesForm()` —
  the discriminator that lets a form-less entry start a conversation but never
  re-enter one; re-uses `_group` from `utils.js`
- **DEFER reasons / greppable tags**: `machine.js` exports
  `DEFER_SYNTHETIC_NO_CONVERSATION` and `DEFER_FALLBACK_ENTRY_ON_LIVE_CONVERSATION`;
  `transition.js` turns each into its own `console.warn` line and exports
  `SYNTHETIC_NO_CONVERSATION_TAG` / `FALLBACK_ENTRY_ON_LIVE_CONVERSATION_TAG`
- **Metadata extraction**: `replybot/lib/typewheels/utils.js:getMetadata()` / `_group()`
- **Field lookup**: `replybot/lib/typewheels/form.js:getField()`
- **Tests**: `replybot/lib/event-normalizer.test.js`, `machine.test.js`
