# States System - Cross-Component Documentation

## Overview

The "state" in the VLab platform represents a user's complete conversation context during a survey interaction. Every participant interacting with a chatbot has exactly one state per Facebook page, tracking where they are in the survey flow, what questions they have answered, what errors they have hit, and what they are waiting for.

The state is the central concept that ties together the chatbot engine (replybot), operational automation (Dean), the database (CockroachDB `states` table), and the dashboard. Understanding how state flows through these components is essential for debugging participant issues and building features that expose participant progress.

## State Machine

The state machine governs the lifecycle of a participant's survey interaction. Each participant is always in exactly one of these states:

| State | Meaning |
|-------|---------|
| `START` | Initial state before the participant has begun answering questions |
| `RESPONDING` | Participant is actively answering survey questions |
| `QOUT` | A question has been sent to the participant, waiting for their response |
| `END` | Participant has completed the survey flow (all forms finished) |
| `BLOCKED` | Participant is blocked from proceeding (e.g., spam detection) |
| `ERROR` | An error occurred during processing (API failure, payment error, etc.) |
| `WAIT_EXTERNAL_EVENT` | Participant is paused, waiting for an external event (e.g., a payment confirmation, a timeout, or a follow-up trigger) |
| `USER_BLOCKED` | The user has blocked the Facebook page or is otherwise unreachable |

### Transition Model

The state machine follows a pure functional design with no side effects in transitions:

1. **`exec(state, event) -> output`** -- Categorizes the incoming event and determines what should happen next (which question to ask, whether to advance forms, whether to error out).
2. **`apply(state, output) -> newState`** -- Produces a new state object from the old state and the output. This is a pure function.

Side effects (sending messages to Facebook, publishing to Kafka) happen separately in the `act()` phase, after the new state has been computed. This separation makes the state machine testable and predictable.

## State Object Structure

The state JSON (`state_json` in the database) contains the full conversation context for a single participant. Its fields are:

| Field | Type | Description |
|-------|------|-------------|
| `state` | string | Current state machine value (one of the states listed above) |
| `question` | object | Reference to the current question being asked or awaiting a response |
| `qa` | array | Full transcript of question-answer pairs -- every question asked and every response given |
| `forms` | array | History of forms (shortcodes) the participant has traversed, in order |
| `md` | object | Metadata: randomization seed, start time, user info, payment data, cluster ID |
| `previousOutput` | object | The output from the most recent state transition (useful for debugging what just happened) |
| `error` | object | Error details if the participant is in the ERROR state (error tag, FB error code, etc.) |
| `wait` | object | Wait condition details if in WAIT_EXTERNAL_EVENT (what event is expected, timeout) |
| `tokens` | array | One-time notification tokens (used for re-engagement messaging) |
| `retries` | array | Retry timestamps for exponential backoff on transient failures |
| `pointer` | string | Message pointer timestamp (tracks position in event log replay) |
| `externalEvents` | array | External events received while the participant was waiting |

## Data Flow

State moves through the system in a well-defined pipeline:

```
User sends message on Facebook Messenger
       |
  [Botserver] receives webhook, publishes to Kafka chat-events topic
       |
  [Replybot] consumes event from Kafka
       |
       +---> Reads the cached state for THIS CONVERSATION
       |         (state:<platform>:<account_id>:<userid>), replaying from the
       |          event log on a miss
       |
       +---> Machine.transition(state, event)
       |         |
       |         +---> exec(state, event) -> output
       |         +---> apply(state, output) -> newState
       |
       +---> New state cached in Redis (runtime source of truth)
       |
       +---> act() sends messages to Facebook Graph API
       |
       +---> State published to Kafka VLAB_STATE_TOPIC
                  |
             [Scribble] consumes and writes to `states` table
                       (observability/debugging only -- replybot never reads it)
```

> **Correction.** This diagram used to show a `Stateman.put()` UPSERT into `states`
> alongside the Kafka publish. There was never a second writer on the live path:
> `replybot/lib/responses/stateman.js` was a dev-only consumer that could not run at all
> (it called a three-argument `machine.transition` against a two-argument method), it was
> deployed in no environment, and it has now been deleted. **Scribble is the only writer of
> the `states` table.**

### Key architectural insight

**Redis is the runtime source of truth for state, not CockroachDB.** Replybot replays state from the Kafka event log with Redis as a cache. The `states` table in CockroachDB is a denormalized dump for observability: it exists so that Dean can automate operational tasks and the dashboard can show participant status. Replybot never reads from the `states` table.

### The Redis cache is keyed by the conversation, not by the participant

A conversation is **`(platform, account_id, user_id)`**, and the cache key carries all three:

```
state:<platform>:<account_id>:<userid>

state:whatsapp:1203867182815254:15419799714
state:messenger:935593143497601:1051551461692797
```

Built by `makeKey` in `replybot/lib/typewheels/statestore.js` — the only place the shape is
written. `devops/clear-state-cache.sh` matches it with `SCAN MATCH state:*:*:<userid>`, so
the two must agree.

**Finding a participant's keys.** One participant can hold several — one per account they
have messaged. Match on the userid **suffix**, and use `SCAN`, never `KEYS` (production
Redis has a large keyspace and `KEYS` blocks the server):

```bash
PW=$(kubectl -n vprod get secret gbv-redis \
  -o go-template='{{index .data "redis-password" | base64decode}}')

# every conversation this participant has state for
kubectl -n vprod exec -i gbv-redis-master-0 -c redis -- \
  env REDISCLI_AUTH="$PW" redis-cli --scan --pattern 'state:*:*:15419799714'

# and what one of them holds
kubectl -n vprod exec -i gbv-redis-master-0 -c redis -- \
  env REDISCLI_AUTH="$PW" redis-cli GET 'state:whatsapp:1203867182815254:15419799714'
```

**Which participants have more than one conversation** — the population that was exposed to
the collision below:

```sql
SELECT userid, count(DISTINCT pageid)
FROM chatroach.states
GROUP BY userid HAVING count(DISTINCT pageid) > 1;
```

**Why it is keyed this way.** It used to be `state:<userid>`. A participant who messaged two
of a researcher's accounts therefore shared **one** state blob, and the last conversation
written was served to the next one to arrive. Reproduced live on 2026-08-16: an entry on one
WhatsApp number wrote `state:15419799714`; thirteen minutes later a button press on a
*different* number read that state back, recorded the press as an answer to the other
survey's field, and raised

```
FIELD_NOT_FOUND: Could not find the requested field, b485a02d-…, in our form: xleHnFWa
```

The conversation went to `ERROR` and **stayed** there: `FIELD_NOT_FOUND` is not in
`DEAN_ERROR_TAGS`, so nothing retried it, and every touch refreshed the 24h TTL. It also
wrote one researcher's participant data into another researcher's account scope — which is
what the dashboard's `states` queries use to decide visibility. Full write-up:
`planning/conversation-identity.md`.

Two consequences worth knowing while debugging:

- **The account and platform on a cached state come from the event, never from
  `state_json.md`.** `md.pageid` and `md.platform` are the fields that bled, so nothing reads
  them back to route or to key. If you see `md.pageid` naming an account the event did not
  arrive on, that is a bug, not a quirk.
- **A cache miss now replays only that conversation's events.** `messages` carries
  `account_id` and `platform` (`devops/migrations/26-messages-account.sql`), and
  `chatbase.get()` takes `({ userid, account }, limit)` and scopes on both. Passing a bare
  user id throws rather than quietly reading unscoped, because the failure mode of this whole
  class of bug is silence.

  Two things to know while debugging a replay:

  - **Un-backfilled rows are still included.** `get()` matches
    `account_id = $2 OR account_id IS NULL`, so rows archived before migration 26 replay for
    whichever account is asking — exactly as they did before, no better and no worse. This is
    temporary scaffolding that drains as `devops/backfill-messages-account.sh` runs. So if a
    replay looks like it is mixing two conversations, **check whether those rows have a NULL
    `account_id`** before treating it as a regression:

    ```sql
    SELECT account_id, platform, count(*) FROM chatroach.messages
    WHERE userid = $1 GROUP BY 1, 2 ORDER BY 3 DESC;
    ```

  - **The `message_pointer` checkpoint is now per-account.** `get()` filters the `states`
    subquery to the one account instead of joining on `userid`, so a `form.reset` on one
    account no longer satisfies the checkpoint for another, and message rows are no longer
    duplicated once per account the participant holds state on. If you are comparing against
    an older transcript, a shorter replay is the fix working.

### The degraded path: an event that cannot name its conversation

An event that does not carry both a top-level `platform` and an `account_id` is **not allowed
to touch the cache at all** — neither read nor write. Its state is computed from
`chatroach.messages` instead, and `StateStore.getState` logs one line:

```
CONVERSATION_TUPLE_MISSING cache bypassed, computing from the event log {"user":…,"platform":null,"account":"…","replay":"account-scoped"}
```

Never key a conversation under a name we cannot verify. But **this path is materially worse
than a cache miss, and the difference is what to look for when debugging it.**

**Who lands on it.** All six *service* synthetic posters send the full triple (dean,
dinersclub, message-worker, replybot, linksniffer, exodus). **`moviehouse` is a seventh poster
and it does not** — it is a browser, not a service, so it does not appear in a `BOTSERVER_URL`
grep. `moviehouse/src/script.js` POSTs `{ user, page, data, event }` straight to hermes' public
ingress with **no `platform`**, for every `play`/`pause`/`seeked` and for a heartbeat every
30 s while the video plays. So a participant watching a video is on the degraded path for the
whole video, and `CONVERSATION_TUPLE_MISSING` is expected to be non-zero in production today.
When you are counting the tag as a canary, subtract moviehouse or you will read its normal
operation as a regression.

**Why it is worse than a cache miss.** Three reasons, and all three show up as symptoms:

1. **The replay can be short.** A cache miss happens to an established conversation, so the
   archive has had a day to catch up. The degraded path happens to whatever arrives — including
   the second event of a brand-new conversation. Replybot and scribble consume `chat-events`
   in **parallel**, and the messages sink flushes on a 2 s poll timeout for low-volume traffic,
   so for a new conversation the archive is *behind by construction*.
2. **The replay can be empty even with a current archive**, if the event named an account the
   conversation does not live on. `linksniffer` and `moviehouse` both read their `pageid` out of
   a **researcher-authored webview query string**, so a stale or hardcoded page id produces an
   empty account-scoped replay every time, repeatably.
3. **There is no memoization**, because the write is refused too. Every event re-scans up to
   `STATE_STORE_LIMIT=30000` rows.

**The symptom to recognise: a `305` conversation that appeared out of nowhere.** An empty replay
reconstructs as `START`. Until 2026-08-17, a synthetic external event arriving in that state
blank-started `FALLBACK_FORM` — production `305`, a **real, live survey belonging to another
researcher** whose misrouted participants complete in one message and therefore look like
completions rather than errors. The participant's real conversation was overwritten in `states`
and their answers attributed to `305`. Same signature as VIR-19 and as the CTWA defect in
`planning/conversation-identity.md` Appendix A.

```sql
-- participants switched onto the fallback survey on top of an existing conversation.
-- The tell is a 305 form stack with NO targeting keys in md, on a (userid, pageid) that
-- also has responses under a different shortcode.
SELECT s.userid, s.pageid, s.state_json->'forms' AS forms, s.updated
FROM chatroach.states s
WHERE s.state_json->'md'->>'form' = '305'
  AND jsonb_array_length(s.state_json->'forms') > 1;
```

**What happens now instead: `DEFER`.** A synthetic event on a conversation that reconstructs as
`START` is refused. `machine.js`'s `_handleExternalEvent` returns `{ action: 'DEFER' }`, which
folds as a pure no-op, and `transition.js`'s `run` returns **without `newState`** — so
`lib/index.js` publishes no state and writes no cache key, and one line is logged:

```
SYNTHETIC_EVENT_NO_CONVERSATION refusing to blank-start FALLBACK_FORM from a synthetic event; dropping it {"user":…,"page":…,"platform":…,"event_type":"synthetic_external"}
```

**Publishing nothing is the point, not a side effect.** `scribble/state.go` writes with a bare
`UPSERT`, so any state published here would overwrite the conversation's real `states` row —
and that row is what every recovery sweep selects on. Leaving it alone **is** the retry: dean's
`Timeouts()` re-fires every 10 minutes for up to `DEAN_TIMEOUT_MAX_PAST=72 hours` while
`current_state = 'WAIT_EXTERNAL_EVENT'`, dean's `Payments()` re-issues a `repeat_payment` after
2 hours, and moviehouse heartbeats again in 30 s. A linksniffer click has no re-send and is
genuinely lost.

An `ERROR` state with a retryable tag was considered and is **worse**: it clobbers that row, a
new tag is not in `DEAN_ERROR_TAGS` so nothing sweeps it, and even inside the tag set a redo
re-reads the same corrupt cached state and re-fails — see the `FIELD_NOT_FOUND` comment at
`devops/values/production.yaml:170-183`, where a sweep of 40 participants recovered exactly
zero.

**There is a second `DEFER` reason, with its own tag.** A **form-less entry event** — Messenger's
bare `get_started`, or a referral whose `ref` names no form — arriving on a conversation that
already has a form is refused the same way, by `machine.js`'s `REFERRAL` case. Same mechanism (no
`newState`, so no `states` UPSERT and no cache key), different line:

```
FALLBACK_ENTRY_ON_LIVE_CONVERSATION refusing to re-enter a live conversation on FALLBACK_FORM; dropping the entry event {"user":…,"page":…,"platform":…,"event_type":"conversation_started","state":"QOUT","form":"mnchweeklanguage"}
```

The tags are separate on purpose: this one is *expected* to be non-zero (10–90/month
historically), while `SYNTHETIC_EVENT_NO_CONVERSATION` is the canary that should read zero. The
`state` and `form` fields say which conversation was protected. If a participant reports "I
tapped Get Started and nothing happened", this is why — and the answer is an explicit
`form.<shortcode>` ref, not a bare Get Started. Full account, including the detector query:
`documentation/referral-form-resolution.md`, "A form-less entry event may not re-enter a live
conversation".

**Two things `DEFER` deliberately does not cover:**

- **A Messenger thread-control handover still blank-starts `FALLBACK_FORM`, and should.** It is
  a real platform event, and on an ad click it lands ~1.5 s *before* the quick_reply carrying
  the referral, which then switches the participant onto the referred form
  (`documentation/referral-form-resolution.md` §6b). The discriminator is
  `source.type === 'synthetic'`, not "arrived as an external event".
- **An exodus `bailout` still switches forms from `START`.** It names its own form, so it never
  resolves through `FALLBACK_FORM`, and exodus has no re-sweep — dropping it would silently
  un-bail someone.

**Still open.** `DEFER` closes the `FALLBACK_FORM` door, not the general one. On the degraded
path any event whose replay comes back short still publishes a truncated state, and the bare
`UPSERT` makes that a clobber — a no-op `machine_report` at `START` publishes a `START` row over
a live conversation. Transient rather than terminal (the next event re-replays), but if you see
a `states` row inexplicably reset to `START`, this is the mechanism.

### Blocking a participant destroys `md`: the `getForm`/`INTERNAL` failure

This is the platform's main source of `INTERNAL` errors. **Blocking a participant
silently discards their `md`, and any later event that wakes them crashes on the
missing `startTime`.**

> **Framing note.** An earlier revision of this section blamed the Redis-miss re-fold.
> That is a real secondary path and is described below, but it is **not** the primary
> mechanism: 12 of 15 production cases traced to a live, cached state with no re-fold
> involved. Lead with `BLOCK_USER`.

`md` is only ever *created* by `getMetadata()` (`utils.js`), which runs on a
`conversation_started` referral (`_blankStart`) or on `_stitch`. Every other write
**merges** (`{ ...state.md, ...output.md }`). So nothing downstream can regenerate `md`
once it is gone — a merge into `undefined` yields `{}`, or a **husk** holding only
event metadata such as `{"e_handover_metadata": "new message"}`.

The secondary path, for completeness: `StateStore.getState`
(`replybot/lib/typewheels/statestore.js` `getState`) checks Redis, and on a miss re-folds from
the event log via `replybot/lib/chatbase`, whose `get()` is windowed *and*
conversation-scoped — `WHERE userid = $1 AND (account_id = $2 OR account_id IS NULL)
AND (message_pointer IS NULL OR message_pointer <= timestamp)`, with the pointer taken
from that account's `states` row alone. The
fold therefore starts at `START` from `states.message_pointer`, not from the beginning
of the conversation, and `state_json` is never read back (it is write-only for this
purpose). A window that excludes the original referral cannot rebuild `md` either.

The husk is what makes this fail loudly rather than silently. `transition.js` `actionsResponses`
guards with `if (!newState.md)`, which a truthy husk passes; `actionsResponses` then
destructures `const { startTime } = newState.md` → `undefined` and calls
`getForm(pageId, shortcode, undefined)`, whose arity guard (`ourform.js:29`) throws:

```
TypeError: Trying to get a form without a pageid or shortcode or timestamp! <page>, <shortcode>, undefined
```

`iowrap('getForm', 'INTERNAL', ...)` (`transition.js`) relabels any non-`MachineIOError`
as **`INTERNAL`**, so a lost-metadata bug is reported as a platform fault with the
message `getForm`.

**It is unrecoverable, and it is self-amplifying.** The state is now `ERROR`, so Dean
retries it with a synthetic `redo` every 30 minutes. Each retry re-folds from the same
pointer, reproduces the same husk, and throws the identical `TypeError` — emitting two
`machine_report` errors per attempt, forever. Nothing in the retry path can advance
`message_pointer` or re-create `md`, so affected participants never recover on their
own. `states` is never garbage-collected, so they also accumulate.

Commit `3de533a8` fixed one entry point into this — `_handleExternalEvent` calling
`_blankStart` when `state.state === 'START'` (`machine.js:108`). That guard is
necessary but **not sufficient**.

> **Corrected 2026-07-30.** An earlier revision of this section said the guard misses
> "the common case for long-running conversations with handovers." That framing was
> too broad and is wrong. `pointer` only ever advances at three sites, and ordinary
> long-running conversations never move it — so their re-fold replays from the true
> beginning, referral included, and rebuilds `md` correctly. The actual precondition
> is narrower and is stated below: **it requires a prior `block_user`.**

**The precondition is `BLOCK_USER`.** `BLOCK_USER` (`machine.js:434-443`) returns a
RESET whose `stateUpdate` is `{ state: 'USER_BLOCKED', pointer: nxt.timestamp, forms:
state.forms }`. `apply()`'s RESET rebuilds from `_initialState()`, so `forms` survives,
`pointer` advances to the block event — and **`md` is silently dropped**. It is the only
`apply()` site that advances the pointer *and* drops `md` *and* leaves the state
non-`START`. Verified against production 2026-07-30: of the 15 participants then stuck
in `ERROR`/`INTERNAL`, all 12 that have a `message_pointer` have a `block_user` event
whose timestamp equals `state_json.pointer` **exactly, to the millisecond**.

Two independent defects then convert that into the husk:

- **`HANDOVER_EVENT` has no `USER_BLOCKED` guard.** It is the only external-event path
  without one — contrast `EXTERNAL_EVENT` (`machine.js:414-417`), which returns
  `_noop()`. So a Messenger thread passback still wakes a blocked participant, reaches
  `_handleExternalEvent` in state `USER_BLOCKED` (not `START`, so `3de533a8`'s guard
  does not fire), takes the merge branch at `:115-124`, and computes
  `{ ...undefined, ...handoverMetadata }` — the husk.
- **`message_pointer` is floored to the whole second**, so the pointer does not
  actually exclude the event that set it. The generated column is
  `floor((state_json->>'pointer')::INT8 / 1000)::INT8::TIMESTAMPTZ`
  (`devops/migrations/04-pointers.sql`), while `replybot/lib/chatbase`'s `get()` filters
  `message_pointer <= timestamp`. Measured drift on the 12 affected states: 50–979 ms,
  always positive. The `block_user` event therefore satisfies the filter and is
  **re-included as the first event of every windowed re-fold** — where it hits
  `BLOCK_USER`'s own `if (state.state === 'START') return _noop()` guard
  (`machine.js:434-436`) and is discarded. The re-fold thus never re-establishes
  `USER_BLOCKED`.

**The trigger is not always a handover.** Of the 12, 9 broke on a `pass_thread_control`
and **3 broke on a plain inbound `TEXT` or `MEDIA`** (`6891544804295134`,
`5838894052894040`, `25053076534312947` — their husk is `{}`, with no handover keys).
That is surprising because `TEXT`/`MEDIA` *do* guard on `USER_BLOCKED`
(`machine.js:546,560`), and it is consistent with the floor()/no-op path above leaving
the state at `START` rather than `USER_BLOCKED`. **The exact `apply()` hop for these
three is not yet pinned down** and needs a `machine.test.js` reproduction rather than
more log archaeology. The operational consequence is firm either way: **a fix must not
special-case `HANDOVER_EVENT`** — 25% of observed live cases were not handover-driven.

**A separate, older origin accounts for the rest.** 3 of the 15 (`8269974449750246`,
`5949070365165277`, `8403086566475919`) have `message_pointer IS NULL`, `forms: []`, and
**zero `block_user` events ever**. They fail with both `shortcode` and `startTime`
undefined and trace back to Facebook delivery-error `BLOCKED` episodes from 2023–2024,
predating both `3de533a8` and this failure mode. Whatever reset them to `forms: []` has
not been identified. Do not assume a `BLOCK_USER` fix clears them.

**Diagnosing it.** The signature is an `ERROR`/`INTERNAL` state whose `md` has no
`startTime` — a shape that never occurs on a healthy state:

```sql
SELECT userid, pageid, current_form, state_json->'md' AS md, updated
FROM chatroach.states
WHERE current_state = 'ERROR' AND error_tag = 'INTERNAL'
  AND state_json->'md'->>'startTime' IS NULL
  AND updated > NOW() - INTERVAL '24 hours';
```

Confirm the cause by checking that no referral exists after the pointer — if this
returns 0, a re-fold provably cannot rebuild `md`:

```sql
SELECT COUNT(*) FROM chatroach.messages m
WHERE m.userid = $1 AND m.timestamp >= (SELECT message_pointer FROM chatroach.states WHERE userid = $1)
  AND (m.content LIKE '%conversation_started%' OR m.content LIKE '%"referral"%');
```

**Why they were blocked in the first place: Dean's spam/OOM guard.** The `block_user`
event is synthetic, published by Dean's `Spammers()` sweep (`dean/queries.go:271-284`),
which selects any non-`USER_BLOCKED` state where **either** the last 25 QA answers are
identical **or** `jsonb_array_length(state_json->'externalEvents')` exceeds
`DEAN_SPAMMER_EXTERNAL_EVENTS_MAX` (**100** in production,
`devops/values/production.yaml:218`). The second branch is an OOM guard, and it is
reachable without any malicious behaviour: `_handleExternalEvent` appends one
`externalEvents` entry per handover ping and never caps the array, so a participant
sitting in `WAIT_EXTERNAL_EVENT` who keeps receiving `pass_thread_control` can cross the
threshold from ordinary Messenger activity alone.

> **Unverified:** which of the two branches actually fired for the observed cases is
> *not* established. The RESET wipes both `qa` and `externalEvents`, so the post-block
> state cannot answer it, and no pre-block `machine_report` survives in the hour before
> the sweep (Dean reads `states` directly and does not need one). Do not repeat the
> OOM-branch story as fact without tracing an older report.

Dean sweeps in batches, so blocks arrive in bursts rather than one at a time. On
2026-05-06 between 22:00 and 23:00 UTC a single sweep blocked **115 participants**; five
of the fifteen stuck states investigated on 2026-07-30 came from that one hour.

**Blast radius — this is a latent population, not fifteen users.** `BLOCK_USER` drops
`md` unconditionally, so *every* blocked state is pre-loaded with the fault and waits
for a handover to detonate it. Measured on prod 2026-07-30:

| | count |
|---|---|
| `USER_BLOCKED` states total | 1,983 |
| ...of those, with `md.startTime` lost | **1,983 (100%)** |
| ...and with a non-empty `forms` (so they pass `transition.js:48` and reach `getForm`) | **1,982** |

Of the 115 blocked in the 2026-05-06 22:00 sweep, 94 are still sitting in
`USER_BLOCKED` and 11 have already converted to `ERROR`. The conversion rate is a
function of how many blocked participants happen to receive a thread passback — which
is why this presents as a slow, irregular trickle (1–3/day) with occasional jumps
(11 on 2026-07-30) rather than a clean step change.

**Diagnosing it.** The signature is an `ERROR`/`INTERNAL` state whose `md` has no
`startTime` — a shape that never occurs on a healthy state:

```sql
SELECT userid, pageid, current_form, state_json->'md' AS md, updated
FROM chatroach.states
WHERE current_state = 'ERROR' AND error_tag = 'INTERNAL'
  AND state_json->'md'->>'startTime' IS NULL
  AND updated > NOW() - INTERVAL '24 hours';
```

Confirm the origin by checking that `state_json.pointer` coincides with a `block_user`
event. Compare against `state_json->>'pointer'` (exact ms), **not** the `message_pointer`
column, which is floored to the second:

```sql
SELECT s.userid, (s.state_json->>'pointer')::bigint AS ptr_ms, m.timestamp AS block_ts
FROM chatroach.states s
LEFT JOIN chatroach.messages m
  ON m.userid = s.userid AND m.content::jsonb->'event'->>'type' = 'block_user'
WHERE s.userid = $1;
```

**Fixing it.** `planning/blocked-user-durability-handoff.md` scopes the work as Gap 1
(`BLOCK_USER` must carry `md: state.md` through its `stateUpdate`), Gap 2
(`HANDOVER_EVENT` needs the `USER_BLOCKED` guard the other paths already have), and
Gap 3 (block durability across re-folds). Three constraints on any fix:

- **It must not special-case `HANDOVER_EVENT`** — 3 of 12 traced cases were triggered by
  a plain `TEXT`/`MEDIA`, not a passback.
- **It must not simply blank-start a blocked participant.** That appends the fallback
  form and silently reassigns a real participant mid-survey — the reason `3de533a8`
  deliberately scoped itself to `START` only.
- **Gap 1 alone does not clear the existing 1,982.** They have already lost `md`; a
  forward fix stops new ones but leaves the standing population armed. Draining it needs
  a backfill, and the three `forms: []` participants are a separate origin that a
  `BLOCK_USER` fix will not touch at all.

See `documentation/error-events.md` for the error-reporting side — in particular why
`iowrap` relabels this deterministic input error as `INTERNAL` and pages the platform
on-call.

## The RESPONDING/Echo Trap

When a user sends a response, replybot transitions to `RESPONDING` (`replybot/lib/typewheels/machine.js:606-625` for `RESPOND`, `:645-649` for `RESPOND_AGAIN`) and waits for Facebook to echo the bot's own message back as confirmation of delivery. The **only** transition out of `RESPONDING` is `WAIT_RESPONSE`, which is emitted by the `ECHO` event handler (`machine.js:445-493`) when the echo arrives (returning `WAIT_RESPONSE` at `:490-493`).

**The trap**: If the echo never arrives — whether due to a network gap, a platform ingestion failure, or a Facebook delivery issue — the user is pinned in `RESPONDING` indefinitely. The two transitions treat `retries` differently, and the asymmetry is what lets the loop accumulate: `RESPOND` clears it (`retries: undefined`, `:621`) because a user answering ends the episode, whereas `RESPOND_AGAIN` deliberately preserves it — the new array arrives via `output.stateUpdate` and the case comment reads "keep retries for backoff" (`:643-649`). So each redo grows the array, and `retries` length is the direct measure of how long a user has been trapped.

### Where the echo comes from differs by platform

This matters because it determines how exposed each platform is to the trap.

| Platform | Source of the echo | Failure exposure |
|---|---|---|
| Messenger | Facebook's native `is_echo` webhook (`replybot/lib/event-normalizer.js:49`) | An external round-trip. If Facebook never calls back, nothing local notices. |
| WhatsApp | A synthetic `bot_echo` that message-worker publishes after a successful send (`message-worker/worker.go:164-168`, `emitWhatsAppEcho` at `:179`) | Local to the send. Fails only if the Kafka publish fails. |

Both normalize to `event_type: bot_message_sent` and are categorized as `ECHO` (`machine.js:170`), so the state machine treats them identically.

WhatsApp is therefore the *more* robust platform here. For Messenger, message-worker emits nothing at all — `emitMessageSent` exists but its call site is commented out (`worker.go:170`, "replybot can't parse message_worker event shape"), and it would not suffice as written because it omits `Message.Metadata`, which the ECHO handler needs to resolve the question ref.

The WhatsApp path has a known, deliberate hole: a failed echo publish is logged at `Warn` and swallowed, on the reasoning that the message really was delivered so reporting a send failure would be untrue. The code comment states the consequence plainly — "it stalls the state machine, not the delivery." A stalled state machine is exactly this trap.

### Dean's Respondings Sweep

Dean's `Respondings()` query (`dean/queries.go:108-119`) selects all `current_state = 'RESPONDING'` users past a grace interval and emits a `redo` event. The sweep is part of the `respondings` job (which also runs `blocked` and `errored` queries, `devops/values/production.yaml:221-223`), scheduled at `*/30 * * * *` (every 30 minutes) with:

- `DEAN_RESPONDING_GRACE: "20 minutes"` — do not redo a user until they have been `RESPONDING` for at least 20 minutes
- `DEAN_RESPONDING_INTERVAL: "48 hours"` — do not redo a user who has been `RESPONDING` for more than 48 hours (they are aged out)
- `DEAN_RETRY_MAX_ATTEMPTS: "60"` — do not redo a user if their `retries` array length is already ≥ 60 (the max attempt cap)
- `DEAN_SEND_DELAY: "3s"` — add 3 seconds of delay between consecutive sends to avoid overwhelming Facebook

`REDO` is handled in `machine.js:366-382`. It no-ops for users in `['QOUT', 'END']` (lines 371-373) — so a healthy user who successfully received the echo and moved to `QOUT` is immune to further redo attempts. For users still in `RESPONDING`, `REDO` replays the previous output as `RESPOND_AGAIN` (`:378-379`), appending the timestamp to the `retries` array (`:375`). **The `retries` array counts Dean redo attempts, not initial send attempts.**

### How the Loop Ends

The loop does not end via `DEAN_RETRY_MAX_ATTEMPTS`. It ends when the send finally fails and the user is marked `BLOCKED`. Dean does not do the marking: the send error comes back as a `machine_report` and replybot's own handler performs the `BLOCKED` transition. The most common failure is Facebook error code 10 (`(#10) This message is sent outside of allowed window`), which occurs when the 24-hour Messenger window closes. Being `BLOCKED` removes the user from the `current_state = 'RESPONDING'` predicate, so the respondings sweep stops seeing them; and because code 10 is not in `DEAN_FB_CODES` (production value: `"2022,613,-1,190,80006,551"`, `devops/values/production.yaml:191`), the `blocked` sweep does not pick them up either. The loop halts by exhausting the user, not by any configured limit.

**The observed cadence** (30–68 minutes, irregular) comes from the half-hourly cron run gated by the 20-minute grace, with per-user drift from the 3-second send delay across users in each sweep batch. It is **not** hourly and **not** exponential backoff.

### Worked Example (Production, Verified)

User `28777805391819468` on form `mentalitybaseline`, question `buttons_instruction`:

- **Jul 16 13:16–13:19**: Answered a button-only question five times with free text ("1", "Hey", "Hey", "Yes", "Hello"). Each response was rejected with "Sorry, I only understand answers to the questions I ask." Last echo received Jul 16 13:19:11.972. State correctly transitioned to `QOUT` after the final rejection and re-ask.
- **Jul 17 05:05:46**: ONE `follow_up` event fired (Dean followups cron: `0 5-19 * * *`, `DEAN_FOLLOWUP_MIN/MAX` 12h/24h, `devops/values/production.yaml:210-213`). The user had not answered the question in the previous 24 hours, triggering a follow-up. State transitioned to `RESPONDING`.
- **No echo ever arrives**. The 24-hour Messenger window closes at Jul 17 13:19:08 — measured from the user's last *inbound* message, not from the last echo.
- **14 `redo` events follow** from 05:36 to 18:36 (13 hours, irregular spacing reflecting the grace + cron cadence). Each redo appends a timestamp to `retries`.
- **Jul 17 18:36:53**: the send returns error `(#10)`, subcode 2018278, and replybot transitions the user to `BLOCKED`. `state_json.retries` length is 14. `state_json.previousOutput` is still set to the follow-up output. The `stuck_on_question` column holds `buttons_instruction`.

This user is part of the stuck-in-RESPONDING cohort: they cannot proceed because no echo will ever arrive, Dean's redo loop eventually fails with code 10, and the user is blocked.

### Recognising the Pattern

A `BLOCKED` state carrying the echo-trap signature has:
- `state_json.retries` length ≥ 5 (indicates multiple redo attempts)
- `state_json.previousOutput` preserved (the message that failed to echo)
- `stuck_on_question` naming the question the user never got past
- `error.code` 10 with `error_tag` `FB`, and an `error.payload` whose text matches whatever `previousOutput` was re-sending

### Scale

On the platform as of Jul 31 2026:
- **68,344 of 164,534 `BLOCKED` states** carry >= 5 retries (a sign of the redo loop).
- On Jul 17 alone, **88 users were blocked**, of which **85 had >= 5 retries** (96.5% of that day's blocks — a spike). On Jul 16: 3 (background rate).
- **`RESPONDING` stays small** (815 users platform-wide) precisely because the loop terminates by blocking people.

### Hypothesis: Echo Ingestion Gap on Jul 17

Echo delivery is not broadly broken: 17/17 sampled `QOUT` users on `mentalitybaseline` on Jul 17 had echoes. However, of 400 users whose states updated 05:00–14:00 UTC on Jul 17, only ONE echo appeared all day, with echoes resuming at 16:00. This is **suggestive of an ingestion gap that morning**, but the root cause was not identified. The sample is biased toward users last active during the affected window, and this remains a hypothesis, not a confirmed root cause. The alternative explanations are message delivery issues (timeouts, network partitions, Facebook API slowness) rather than an ingestion-side bug.

### Unresolved Discrepancy

The same user episode (user `28777805391819468`) shows a stored error whose stack trace references `replybot/lib/messenger/index.js` (replybot's own Graph API send path) while the same episode's `machine_report` carries a `commands` array (the message-worker path). These two send paths should not coexist in the same episode. **Which component actually sent the message — replybot directly or message-worker — is unknown.** This needs investigation in the message-worker logs for that user and timestamp.

## The `states` Table

### Schema

**Primary key**: `(userid, pageid)` -- exactly one row per user per Facebook page.

| Column | Type | Description |
|--------|------|-------------|
| `userid` | VARCHAR | Facebook user PSID |
| `pageid` | VARCHAR | Facebook page ID |
| `updated` | TIMESTAMPTZ | When this row was last written |
| `current_state` | VARCHAR | The state machine value (START, RESPONDING, etc.) |
| `state_json` | JSON | The full state object (see State Object Structure above) |

### Computed Columns

The table has 15+ computed/stored columns derived from `state_json` for efficient querying without JSON parsing:

| Computed Column | Purpose |
|-----------------|---------|
| `current_form` | Survey form shortcode -- the last entry in the `forms` array |
| `form_start_time` | When the participant started the current form |
| `error_tag` | Error classification string (for filtering by error type) |
| `fb_error_code` | Facebook API error code (for diagnosing delivery failures) |
| `stuck_on_question` | Boolean: detects when a user has answered the same question 3+ times |
| `timeout_date` | When an external wait condition should expire |
| `next_retry` | Exponential backoff retry timestamp |
| `payment_error_code` | Reloadly payment error code |
| `previous_is_followup` | Whether the previous output was a follow-up message |
| `previous_with_token` | Whether the previous output included a one-time notification token |

### Indexes

The table has 10+ indexes plus an INVERTED INDEX on `state_json` for flexible JSON queries. The heavy indexing reflects the variety of queries Dean runs for operational automation.

### Permissions

| DB User | Access |
|---------|--------|
| `chatroach` | INSERT, SELECT, UPDATE (used by scribble for writes, Dean for reads) |
| `chatreader` | SELECT only (used by dashboard-server for read-only queries) |

### Who Reads the `states` Table

1. **Dean** (`dean/queries.go`) -- The primary consumer. Dean is a Go cron service that queries states for operational automation: retrying failed participants, timing out stale waits, detecting stuck users, identifying spammers, and triggering follow-ups.

2. **Dashboard-server** -- Reads states for user-facing debugging and survey health monitoring. Queries are scoped by the authenticated user's surveys.

### Schema Definition

Defined in `devops/migrations/01-init.sql` (lines 109-162), with additional computed columns added in later migration files.

## Survey to States Mapping

### The `current_form` Link

There is no direct foreign key from `states` to `surveys`. The link between a participant's state and a survey is the `current_form` computed column, which contains the survey **shortcode** (e.g., `"s1"`, `"followup_v2"`).

### Survey Names and Multiple Shortcodes

A "survey" in the dashboard sense is identified by `survey_name` in the surveys table. One survey can contain **multiple shortcodes** (called "forms" in the frontend). For example, a survey named "Health Study 2024" might have shortcodes `health_intake`, `health_followup_1`, and `health_followup_2`.

To get all states for a survey, you query all shortcodes belonging to that `survey_name`:

```sql
-- Get all shortcodes for a survey
SELECT DISTINCT shortcode FROM surveys
WHERE survey_name = $1 AND userid = $2;

-- Get states for those shortcodes
SELECT userid, pageid, current_state, current_form, updated, error_tag, timeout_date
FROM states
WHERE current_form IN (
  SELECT shortcode FROM surveys WHERE survey_name = $1 AND userid = $2
);
```

### Formcentral and Time-Based Versioning

Shortcodes are **not globally unique**. The same shortcode can have multiple survey versions, distinguished by their `created` timestamp. When a participant joins a study, their join time determines which version of the survey they receive.

**Formcentral** (`formcentral/`) is a Go microservice that resolves this mapping at runtime:

```
GET /surveys?pageid={fbPageId}&shortcode={shortcode}&timestamp={joinTimeMs}
```

The underlying query finds the most recent survey with that shortcode created at or before the participant's join time:

```sql
SELECT ... FROM surveys s
WHERE s.userid = (SELECT userid FROM credentials WHERE facebook_page_id = $1 LIMIT 1)
  AND s.shortcode = $2
  AND created <= $3
ORDER BY created DESC
LIMIT 1
```

This means if shortcode `"s1"` has been recreated three times, a participant who joined before the second version was created will always see the first version.

### The credentials Bridge

The `credentials` table bridges Facebook page IDs to VLab user IDs:

```
states.pageid -> credentials.facebook_page_id -> credentials.userid -> surveys.userid
```

This is how page-scoped state data connects back to user-owned surveys.

## Components Involved

| Component | Language | Role in States System | Key Files |
|-----------|----------|----------------------|-----------|
| **Replybot** | Node.js | Produces state via the state machine. Caches in Redis, publishes to Kafka. Never reads `state_json` back — its one read of `states` is the `message_pointer` that windows a replay (see "The secondary path" above). | `replybot/lib/typewheels/machine.js`, `replybot/lib/index.js`, `replybot/lib/chatbase/chatbase.js` (the replay client — vendored into replybot; formerly the `@vlab-research/chatbase-postgres` package) |
| **Scribble** | Go | Kafka-to-DB writer. Consumes from state topic, UPSERTs to `states` table. | `scribble/` |
| **Dean** | Go | Reads `states` table for operational automation: retries, timeouts, stuck detection, spam detection, follow-ups. | `dean/queries.go` |
| **Dashboard-server** | Node.js | Reads `states` table for user-facing debugging and survey health views. Queries scoped by authenticated user. | `dashboard-server/` |
| **Formcentral** | Go | Maps (shortcode + join timestamp) to a specific survey version. Used by replybot at runtime, not by the states table directly. | `formcentral/db.go` |
| **Botserver** | Node.js | Event ingress. Receives Facebook webhooks and synthetic events, publishes to Kafka chat-events topic. Upstream of replybot. | `botserver/server/handlers.js` |
| **Redis** | -- | Runtime state cache, keyed `state:<platform>:<account_id>:<userid>` — one key per conversation, not per participant. Source of truth for replybot's state replay. Not queryable by other services. | `replybot/lib/typewheels/statestore.js`, `devops/clear-state-cache.sh` |
| **CockroachDB** | -- | Stores the `states` table. Queryable by Dean and dashboard-server. Not the runtime source of truth. | `devops/migrations/01-init.sql` |

## Common Debugging Scenarios

### Participant stuck on a question
Query `states` for `stuck_on_question = true`. The `state_json.qa` array will show the repeated question-answer attempts. Common causes: validation failures, unclear question wording, or translation issues.

### Participant in ERROR state
Filter by `current_state = 'ERROR'`. The `error_tag` and `fb_error_code` computed columns classify the error without needing to parse JSON. Common errors: Facebook API rate limits, invalid recipient (user deleted account), payment failures.

A **stuck** `ERROR` — one no retry sweep can clear, because its tag is not in
`DEAN_ERROR_TAGS` (`NETWORK,INTERNAL,STATE_ACTIONS`) — needs the cached state cleared, or the
fixed code will never see the participant:

```bash
DRY_RUN=1 devops/clear-state-cache.sh vprod ids.txt   # see what would go
devops/clear-state-cache.sh vprod ids.txt
```

Non-destructive: state is derived, the event log is durable, a miss recomputes, and nothing
is sent to anyone. See the Redis cache-key section above for how to find the keys by hand.

### Participant waiting too long
Filter by `current_state = 'WAIT_EXTERNAL_EVENT'` and check `timeout_date`. Dean normally handles timeouts automatically, but if Dean is down or misconfigured, participants can get stuck waiting. The `state_json.wait` field describes what event is expected.

### Survey health overview
Aggregate `current_state` counts grouped by `current_form` for all shortcodes in a survey:

```sql
SELECT current_state, current_form, COUNT(*)
FROM states
WHERE current_form IN (
  SELECT shortcode FROM surveys WHERE survey_name = $1 AND userid = $2
)
GROUP BY current_state, current_form;
```

This shows how many participants are responding, completed, errored, blocked, or waiting across each form in the survey.

## Dashboard UI — States Explorer

The States Explorer feature in the dashboard provides a user-facing interface for debugging participant states. It follows the established container pattern with multiple views for different debugging scenarios.

### StatesSummary Component

**Path**: `dashboard-client/src/containers/StatesExplorer/StatesSummary.js`

**Purpose**: High-level overview of participant states across a survey.

**UI Elements**:
1. **Overview Card** — displays total participant count and per-state aggregates using `<Statistic>` components
2. **State Breakdown Table** — shows `current_form × current_state × count` grouped by both dimensions

**Data Flow**:
- Calls `/surveys/:surveyName/states/summary` endpoint (surveyName is URL-encoded)
- Backend aggregates across all shortcodes belonging to that survey_name
- Response format: `{ summary: [{ current_state, current_form, count }, ...] }`

**State Color Coding**:
States are visualized with color-coded tags for quick recognition:
- `START` — blue (participant just started)
- `RESPONDING` — green (active engagement)
- `QOUT` — cyan (question sent, awaiting answer)
- `END` — default/gray (completed survey)
- `BLOCKED` — red (spam/abuse detection)
- `ERROR` — red (failure state)
- `WAIT_EXTERNAL_EVENT` — orange (waiting for payment, timeout, or trigger)
- `USER_BLOCKED` — magenta (user blocked the Facebook page)

**Use Cases**:
- Quickly assess survey health at a glance
- Identify if a significant number of participants are stuck in ERROR or WAIT states
- Compare completion rates across different forms in a multi-form survey

### StateDetail Component

**Path**: `dashboard-client/src/containers/StatesExplorer/StateDetail.js`

**Purpose**: Deep dive into a single participant's complete state, including full QA transcript and error diagnostics.

**UI Structure**:
1. **Back button** — returns to StatesList
2. **Main info card** — `<Descriptions bordered>` showing all computed columns (userid, pageid, current_state, current_form, updated, form_start_time, error_tag, fb_error_code, stuck_on_question, timeout_date)
3. **Error details card** (conditional, shown if `current_state = 'ERROR'`) — displays `state_json.error` fields including tag, message, fb_error_code, payment_error_code, and additional details
4. **Wait condition card** (conditional, shown if `current_state = 'WAIT_EXTERNAL_EVENT'`) — shows what event is expected, timeout, reason, and metadata
5. **QA transcript table** — all question-answer pairs from `state_json.qa` with columns for question ref/text and response text/value
6. **Raw state_json viewer** — `<Collapse>` component with formatted JSON for advanced debugging

**Data Flow**:
- Calls `/surveys/:surveyName/states/:userid` endpoint (both params URL-encoded)
- Backend returns full state row including `state_json` column
- Component parses JSON and conditionally renders sections based on state

**Interpreting state_json Fields**:

#### QA Transcript (`state_json.qa`)
Array of question-answer pairs representing the full conversation:
```javascript
{
  "question": {
    "ref": "q1",          // Question reference ID from survey definition
    "text": "How old are you?"  // Question text shown to participant
  },
  "response": {
    "text": "25",         // Participant's text response
    "value": 25          // Parsed/validated value (may be different type than text)
  }
}
```

**Debugging patterns**:
- **Repeated questions with same ref** → validation failures or participant confusion
- **response.value differs from response.text** → shows validation/parsing transformations
- **Null or missing response** → question sent but not yet answered (QOUT state)

#### Error Details (`state_json.error`)
Present when `current_state = 'ERROR'`:
```javascript
{
  "tag": "FB_API_ERROR",           // Error classification (indexed in error_tag column)
  "message": "Message failed to send",  // Human-readable error description
  "fb_error_code": 10,             // Facebook API error code (if applicable)
  "payment_error_code": "INSUFFICIENT_FUNDS",  // Reloadly error code (if applicable)
  "details": { /* additional context */ }  // Structured error metadata
}
```

**Common error tags**:
- `FB_API_ERROR` — Facebook Graph API failure (rate limit, invalid recipient, permissions)
- `PAYMENT_ERROR` — Reloadly payment/airtime delivery failure
- `VALIDATION_ERROR` — Participant response failed survey validation rules
- `TIMEOUT_ERROR` — External event wait condition expired without resolution

#### Wait Condition (`state_json.wait`)
Present when `current_state = 'WAIT_EXTERNAL_EVENT'`:
```javascript
{
  "event": "PAYMENT_CONFIRMATION",  // Expected event type
  "timeout": "2024-03-15T10:30:00Z",  // When wait expires (also in timeout_date column)
  "reason": "Waiting for airtime delivery",  // Human-readable explanation
  "metadata": {
    "transaction_id": "abc123",  // Context-specific data for the event
    "amount": 10
  }
}
```

**Debugging actions**:
- Compare `wait.timeout` with current time — if past timeout, Dean should have processed it
- Check `wait.metadata` for transaction/event IDs to correlate with external systems (Reloadly, payment providers)
- If participant stuck waiting past timeout, verify Dean cron is running and check Dean logs for that userid

#### Forms History (`state_json.forms`)
Array of shortcodes the participant has traversed:
```javascript
["intake_survey", "followup_v2"]
```
- Last entry should match `current_form` computed column
- Multiple entries indicate follow-up/multi-stage surveys
- Empty array means participant hasn't started any forms yet (START state)

#### Metadata (`state_json.md`)
Operational metadata about the participant session:
```javascript
{
  "randomization_seed": "abc123",  // Ensures consistent randomization across restarts
  "start_time": "2024-03-10T08:00:00Z",  // When participant first interacted
  "user_info": { /* Facebook profile data */ },
  "cluster_id": "cluster-a",  // A/B test or segmentation group
  "payment_data": { /* airtime delivery info */ }
}
```

**Use Cases**:
- Trace complete conversation history for participants reporting issues
- Diagnose Facebook API delivery failures
- Verify payment/airtime transactions correlated with participant state
- Understand why a participant is stuck (validation loop, external wait, API error)
- Provide support with full context of participant's survey experience

### StatesList Component

**Path**: `dashboard-client/src/containers/StatesExplorer/StatesList.js`

**Purpose**: Filterable, paginated list of all participants with their current states. Provides a bird's-eye view with drill-down capability.

**UI Elements**:
1. **Filter controls card** — three filters arranged in a grid:
   - **State dropdown** — select from state machine values (START, RESPONDING, ERROR, etc.)
   - **Error tag input** — free-text search for specific error tags
   - **User ID search** — LIKE match on userid column
   - **Reset filters button** — clears all filters and resets to page 1
2. **Participant table** — columns: userid (link to detail), current_state (color tag), current_form, updated (formatted timestamp), error_tag (red tag if present), stuck_on_question (yes/no tag), timeout_date (formatted timestamp)
3. **Server-side pagination** — limit/offset query params with configurable page size

**Data Flow**:
- Calls `/surveys/:surveyName/states?state=...&error_tag=...&search=...&limit=50&offset=0`
- Backend returns `{ states: [...], total: N }`
- Table re-fetches on filter change or page change

**Interaction Pattern**:
- Clicking any table row navigates to StateDetail view for that userid
- Filters reset pagination to page 1 to avoid confusion
- Page size options: 10, 20, 50, 100

**Common Workflows**:
- Filter by `state=ERROR` and `error_tag=FB_API_ERROR` to identify all Facebook delivery failures
- Filter by `state=WAIT_EXTERNAL_EVENT` to see all participants waiting for external events (payments, timeouts)
- Search for specific userid when participant reports an issue
- Sort by `updated` to find participants who haven't progressed recently

### Navigation Flow

**Entry Point**: From the main SurveyScreen, users click the **STATES** button (located alongside NEW FORM and EXPORT buttons).

**Route Hierarchy**:
```
/surveys/:surveyName                    → SurveyScreen (main survey table)
  /surveys/:surveyName/states           → StatesSummary (overview/aggregates)
  /surveys/:surveyName/states/list      → StatesList (filterable participant list)
  /surveys/:surveyName/states/:userid   → StateDetail (individual participant deep dive)
```

**Navigation Patterns**:

1. **From SurveyScreen to StatesSummary**:
   - User clicks STATES button → navigates to `/surveys/:surveyName/states`
   - Shows aggregate counts and per-form breakdown
   - User can manually navigate to `/surveys/:surveyName/states/list` or go back to survey

2. **From StatesSummary to StatesList** (not automatic):
   - Currently no direct link from summary to list (future enhancement opportunity)
   - User can manually edit URL or use browser back/forward

3. **From StatesList to StateDetail**:
   - Clicking any table row navigates to `/surveys/:surveyName/states/:userid`
   - StateDetail receives `backPath` prop set to `/surveys/:surveyName/states/list`
   - Back button at top of StateDetail uses this prop to return to the list view

4. **From StateDetail back to StatesList**:
   - Click back button (icon: `<ArrowLeftOutlined />`) at top of page
   - Preserves filters and pagination from previous list view (via browser history)

**URL Parameters**:
- `:surveyName` — the `survey_name` from the surveys table, URL-encoded
- `:userid` — participant's Facebook PSID, URL-encoded

**Authorization**:
All views scoped by authenticated user's surveys. The backend `validateSurveyNameAccess` middleware ensures users can only view states for their own surveys. A 403 response is returned if user attempts to access a survey they don't own.

**Design Rationale**:
Routes are nested under `/surveys/:surveyName/` to maintain context that states are tied to a specific survey. This mirrors the existing pattern for survey forms (`/surveys/:surveyName/form/:surveyid`) and bails (`/surveys/:surveyName/bails`), creating a consistent mental model for users navigating survey-related features.
