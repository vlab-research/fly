# External Responder Interface — Design Notes

**Status:** design in progress. Decisions below are settled unless marked OPEN.
Nothing is implemented. Companion doc: `planning/llm-enumerator-eval.md`.

## What this is

Two layers, built as one mechanism:

1. **External responder interface** (generic) — the machine temporarily delegates a
   conversation to an external service, which can talk to the participant, write
   answers, and decide when to hand control back.
2. **LLM coercion** (specific) — a capability-scoped *policy* over layer 1: accept a
   free-text answer, probe if ambiguous, code it into one of the field's options.
   Not a separate mechanism.

Also covered naturally by layer 1: the "hand the participant to an LLM for a while,
then hand them back" use case researchers have asked for.

## Why

`bauchipay1hausa/mobile_provider` is a free-text network question feeding a Reloadly
airtime payment: 918 distinct values over ~3.8k responses. Five spellings of MTN,
`Kamfanin mtn` (Hausa), `Zain`/`Zaini` (Airtel's former Nigerian brand), and a cluster of
`Oppo`/`Vivo`/`Infinix`/`Tecno` — respondents naming their handset instead of their network.
That last group is unrecoverable by any post-hoc coding: you have to *ask*. Which is what
an enumerator does, and what this feature is for. Full evidence in the eval plan.

## Hard constraint: replay determinism

`getState` (`machine.js:965`) folds the **entire event log** through pure `exec`/`apply` on
every read. Therefore:

- No LLM call, no IO, and no wall-clock reads may happen inside the machine.
- The model's output must **land in the event log as a fact**, never be recomputed.
- No time-based buffering in the core (it would either read wall-clock or force the fold
  to hold events and decide later).

Everything below follows from this.

## Architecture

Same shape as payments (`payment:http` → `external-worker` → synthetic event), which is
already proven in production. **A responder is not a new kind of component — it is a third
worker**, alongside message-worker and external-worker.

### The existing topology, and the rule it already follows

```
vlab-prod-chat-events   ← hermes, botserver, message-worker (echoes),
                          external-worker, dean (via botserver)
                        → replybot
vlab-prod-commands      ← replybot
                        → message-worker
vlab-prod-{state,response,payment}
                        ← replybot → scribble (sinks)
```

The unwritten rule: **workers consume commands and produce events.** message-worker's env
states it literally — `KAFKA_COMMAND_TOPIC` in, `KAFKA_EVENT_TOPIC` out
(`production.yaml:817-820`). external-worker does the same. Replybot is the only stateful
decision-maker; every worker is a stateless function from command to event.

Roles:

| Role | Consumes | Produces | Knows about |
|---|---|---|---|
| Decision-maker (replybot) | events | commands | nothing downstream |
| Workers (message-worker, external-worker, responders) | commands | events | nothing about other consumers |
| Sinks (scribble) | events | — | — |

### Applied to responders

```
replybot (DELEGATED)
  → vlab-prod-delegations             (`open` / `event`; `service` in envelope; keyed by userid)
      → responder service N  (own consumer group, filters on `service`)
          → external API (LLM or anything)
      → hermes /synthetic → vlab-prod-chat-events   (`say` / `release`: what the model decided)
  → replybot fences on the delegation id, stays delegated or exits
```

**Replybot → responder is a command. Responder → replybot is an event.** The responder does
not command the bot; it reports *what the model decided* — a fact — and replybot adjudicates
against the capability grant and the validator. Propose-and-validate therefore falls out of
the bus semantics rather than being bolted on: a responder that could publish commands could
bypass the trust boundary; one that publishes events structurally cannot.

**Topics name kinds of work, not identities of services.** `delegations` names "delegated
conversations", exactly as `vlab-prod-commands` names "outbound messaging work" rather than
"message-worker". Any number of responder services subscribe and filter on `service`,
the same way message-worker already dispatches internally on `type` (`send_message` vs
`handoff`).

*No per-responder queue.* That would require someone to hold a service → topic mapping, making
each new responder a replybot config change — and it is what would force message-worker to
learn that responders exist.

**Coupling test:** adding responder #2 must require changing no producer. This shape passes.

*Why a separate topic rather than having responders read `chat-events`* — the projection.
Message bodies on `chat-events` are platform-shaped and the parser lives in replybot, and
"is this user delegated to me" is state only replybot holds; forwarding is the projection of
exactly those two things. Full reasoning and the rejected alternatives: `sub-bots.md` §2.7.
(Consumer-lag alerting is per consumer group, so observability is *not* the reason —
a responder's lag would be visible either way.)

**Always async.** Replybot is a Kafka consumer; a blocking call in the consume loop stalls
a partition and shows up as consumer lag. A responder may block internally; the machine never does.

## `DELEGATED` is a real state (decided)

Not a flavour of `WAIT_EXTERNAL_EVENT`. Reasons, in order of weight:

1. **User events.** In `exec`, TEXT/QUICK_REPLY/POSTBACK/MEDIA fall through to `RESPOND`
   unless the state is `RESPONDING`, `USER_BLOCKED`, or `_isHandoffWait`. Today a user who
   texts during a payment wait has it recorded as their answer to `state.question`.
   Delegation needs the opposite — forward, don't record. A distinct state makes that one
   clear guard; reusing the wait means a second `_isHandoffWait`-style predicate in four
   places. One such predicate is a special case; two is a pattern — and it is the pattern
   that made handoff silently drop user messages.
2. **Wrong consumption model.** `waitConditionFulfilled` answers a boolean: has one matching
   event arrived? Delegation is a stream — many events in, commands out, until a terminal one.
   `_handleExternalEvent` has only two branches (stay and emit nothing, or fulfil and RESPOND).
   There is no "handle, emit messages, stay" branch. That machinery gets added either way.
   Also `_matches` treats an empty condition value as *match any event of that type*
   (`waiting.js:29`) — a footgun for a stream of heterogeneous responder commands.
3. **Cost is near zero.** `current_state` is a plain VARCHAR (`01-init.sql:113`) with six
   indexes keyed on it. A new value needs **no migration** and is queryable by Dean on day one.
   Outside replybot, state names appear in exactly four places: `dean/queries.go`,
   `dashboard-client/.../ConditionBuilder.js`, `StatesSummary.js`, `StateDetail.js`.
4. **Legibility.** `current_state` is the operational surface (StatesList filters, Dean
   predicates, stuck-state investigations). A participant mid-LLM-delegation is operationally
   very different from one waiting on a Reloadly callback. Given the 277-stuck-state history,
   collapsing them is a real cost.

**Cost accepted:** the transient `delegation` field must be cleared on exit, same discipline as
`error`/`retries`/`wait`, and `replybot/README.md`'s transient-field table gains a row. But
see §"Delegation ID as fencing token" below — correctness does **not** depend on every exit
path emitting a close; it depends on the ID check. Field-clearing is hygiene, not safety.

Reuse the *plumbing*, not the state name: carry `delegatedAt` so Dean's predicate mirrors the
existing `timeout_date` comparison.

## Delegation ID as fencing token (decided)

**Correctness by construction, not by discipline.** "Every exit path must remember to emit
close" is the invariant class that already bit this codebase with transient fields and stuck
states (277-state incident, documented in `replybot/README.md`). A new code path added a year
from now by someone who's never heard of responders would silently break it. So do not rely on
it.

**Replybot's state holds the current `delegation_id`.** The responder stamps it on every
command it emits. **Replybot discards any command whose `delegation_id` doesn't match the
current one** — one check, in one place, in the pure core, where the responder's output is
adjudicated.

Now any path that exits `DELEGATED` without knowing responders exist — `RESTORE_STATE`
overwriting state wholesale (`machine.js:340-357`), a bail, `BLOCK_USER` — is correct without
its author knowing anything: the delegation is gone, the ID no longer matches, late commands
are dropped. Fail-safe, not fail-open.

### Derive the ID from the log

It cannot be `uuid()` — `exec`/`apply` are pure and replayed on every `getState`, so a
generated ID would differ on each fold.

**Use the `event_id` of the event that opened the delegation.** Already unique, already
deterministic, already in the log, zero new machinery. Same principle as using the event's
timestamp for ordering instead of inventing a counter: the log already carries identity and
order, so take them rather than manufacture them.

Two-level fencing hierarchy, for free:

- **across delegations** — `delegation_id` (the opening event's `event_id`)
- **within a delegation** — `source_event_id` on each turn, for the newest-wins cancellation
  race (see §"Concurrent user messages")

### Close is best-effort, not required

Emit the `closed` event from the paths that naturally know — responder `release`,
max_turns exhausted, Dean expiry — and do **not** thread it through `RESTORE_STATE` or
`BLOCK_USER`. The ID covers those. `closed` lets the responder abort an in-flight LLM call
and stop burning tokens it will never use. That is cost, not correctness.

Responder-side cleanup is then a TTL on the in-flight map; it does not need to be precise
because nothing depends on it being precise. **Count dropped orphan commands as a metric** — a
spike means either a responder is misbehaving or delegations are ending unexpectedly.

### Dean's expiry must carry the ID

Dean reads `states` on a sweep and emits seconds later. If the user's delegation ended and a
new one opened in that gap, an unfenced `delegation_expired` would kill the *new* delegation.
Dean already reads `state_json` (every computed column and predicate works that way), so it
can read `delegation.id` and include it; replybot checks it matches before acting. Same
staleness class as the `Respondings`/redo behaviour in `dean/README.md`.

## The delegation topic: four messages (decided — owned by `sub-bots.md` §2.7)

The delegation topic carries two messages from replybot, keyed by userid (ordering
guaranteed on one partition); the responder answers with two, POSTed to hermes `/synthetic`
and adjudicated by replybot off `vlab-prod-chat-events`. The vocabulary is the sub-bot
primitive's, not this feature's; what follows is how the LLM responder uses it.

**Replybot → responder:**

| Message | When | Payload |
|---|---|---|
| `open` | survey reaches a responder field | `delegation_id`, the full `(platform, account_id, user_id)`, capability grant, config (prompt, model alias, `max_turns`, `deadline`), target field (ref, question text, choices, validation rules); optional triggering user message (present for coercion, absent for `type: delegate` takeover); optional prior `qa` if `context: conversation` granted |
| `event` | anything arrives for the delegated conversation | the normalized event: a participant message (with `source_timestamp`, `source_event_id`), a delivery echo of a `say`, a refused `release` (the validator's message), or `closed` with a reason (`released`, `max_turns`, `expired`, `blocked`, `restored`). `receive:` filters which kinds this service is sent |

**Responder → replybot:**

| Message | Machine does |
|---|---|
| `say(content)` | sends it; state unchanged, still delegated. `(delegation_id, seq)` makes a redelivered POST idempotent |
| `release(outcome)` | runs the field's **existing validator** on the outcome; pass → recorded like any answer and the survey resumes at the next field; fail → stays delegated and forwards the rejection as an `event`. An outcome of `unresolvable` is a release too — the form maps it to the declared fallback |

There is no `turn`/`echo`/`verdict`/`close` (all are `event`), no `resolve` (it is the
outcome of `release`) and no `fail` (a `release` with a bad outcome). The earlier
nine-message vocabulary was cut to these four once the payment sub-bot was designed against
the same interface: every dropped message existed for one consumer's one case.

### The rejection loop (decided)

The responder `release`s a candidate. Replybot runs the validator and the capability
check. **A refused release must come back as an `event`, or the loop deadlocks** — the
responder believes it's done and stops, while replybot is still delegated waiting for a
valid answer.

A validator rejection is a normal, expected part of the coercion loop: the model proposes
"MTN", the field's labels are "MTN Nigeria", it gets told no (with the validator's message —
already written, translated, and survey-authored) and tries again, up to `max_turns`. That
is the mechanism working as designed.

### Propose-and-validate (decided)

**The responder never decides validity. It proposes a candidate; the field's existing
validator is the judge.** The `release` outcome runs through `validator(field, messages)` —
the same function that judges a button tap.

Consequences: the trust boundary stays in the deterministic core; the model cannot invent
values; and **every field type with a validator gets coercion for free** — `number` ("about
25 or so" → 25, locale-aware, min/max enforced), `phone_number`, `date`, `opinion_scale`.

This is also why the recorded value must be the literal `choice.label`
(`generic-validator.js:46`): logic jumps, the `responses` table, and every export stay
byte-identical to a human tapping the button. Downstream analysis need not know an LLM existed.

### Capability scoping (decided)

The survey author declares what the service may do; the machine enforces it in the pure core.
A responder whose `release` outcome tries to answer a field it was not granted gets a
deterministic, logged rejection.

```yaml
# coercion — the release outcome is this field's answer
type: multiple_choice
responder:
  service: llm
  answers: self               # none | self
  max_turns: 2
  deadline: 5m
  on_unresolvable: fallback_buttons
  context: question           # none | question | conversation
  receive: [user_messages, delivery_echoes]
```

```yaml
# takeover — the release outcome is only branched on
type: delegate
responder:
  service: llm-tutor
  answers: none
  deadline: 30m
  on_unresolvable: release
  context: conversation
  receive: [user_messages, delivery_echoes]
```

`jump` / `stitch` stay out of the vocabulary for v1 — letting a model route people through the
instrument is a much larger validity hazard than letting it code one answer. The capability
list makes it expressible later without redesign.

**`context` is a data-governance switch, not a feature flag.** `conversation` sends prior
answers to a third-party model — a different consent posture than sending one isolated
utterance, and the kind of thing that shows up in an ethics review. Default to `question`.

**`receive` controls which `event` kinds the responder is sent** on the delegation topic.
Refused releases and `closed` are always sent (the loop deadlocks without the former); the
list governs only participant messages and delivery echoes.

Authoring rides on `addCustomType` (`form.js:351`), which already merges arbitrary YAML from
the Typeform description into `field.md`. **Side benefit:** the prompt is form content, so it
is versioned by form version and resolved through `md.startTime` in `getForm` — every response
is already tied to the exact prompt that produced it, for free.

Model **alias** in the form (`cheap-fast`), alias → provider mapping in worker config, so
providers can be swapped without editing research instruments.

## Deadlines: two-tier (decided)

- **Short deadlines** (coercion, seconds) — enforced by the responder itself. It knows its own
  call timed out; it `release`s with `unresolvable`.
- **Dead responder** — Dean is the backstop. A `Delegations` query following the existing
  `Respondings` pattern, emitting `delegation_expired`.

Dean cannot do the short tier: production cron is `*/30` with a 20-minute grace, so real firing
is 30–60 minutes out. Fine for a 30-minute takeover, useless for a 5-second call.

`timeout_date` does not help — that computed column only fires when `wait.type = 'timeout'`.
A new predicate is needed either way.

**Trap to avoid:** the `delegation_expired` handler must actually *exit* the delegated state.
Dean's `Respondings`/redo loop re-selects the same users every sweep forever because
`RESPOND_AGAIN` puts them back in `RESPONDING`. A predicate that doesn't clear itself rebuilds
that trap. Additionally, the expiry event must carry the `delegation_id` (see §"Delegation ID
as fencing token") so a stale sweep doesn't kill a new delegation opened in the gap.

## Concurrent user messages (decided)

**Replybot always forwards immediately. The responder owns cancellation.** No buffering,
no policy enum in the form — coalesce/debounce/interrupt becomes each responder's
implementation detail, which is right, since a coercer and a tutor want different behaviour.

This also keeps `exec`/`apply` free of timing logic, which replay forbids anyway.

Implications for the responder (Go, using `burrow`):

- **`KeyAffinity: false`.** Key affinity gives per-key FIFO by routing a user's messages to one
  worker's channel — so message N+1 waits until N's handler returns. If N's handler is the LLM
  call, the responder *cannot see* the message it needs in order to cancel. Key affinity
  guarantees ordering precisely by preventing the concurrency the cancel design needs.
  Instead: N+1 lands on another worker, cancels the user's in-flight entry, proceeds.
  Serialize **state mutation** with a per-user mutex; do not serialize **arrival**.
  (Note this is the opposite of what message-worker wants — same library, inverted config.)
- **Ordering comes from the event, not a counter.** With `KeyAffinity` off there is no
  ordering guarantee, so the envelope carries the source `timestamp` + `event_id` from the
  `UniversalEvent`. Events are keyed by userid onto one partition, so they are already totally
  ordered upstream; replybot only propagates that order, it does not maintain one. No counter,
  no state, no coordination. "Newest wins" = highest timestamp; same-millisecond ties are
  arbitrary by definition.
- **Emit before returning `nil`.** Burrow's gap detection commits only contiguous *completed*
  offsets, and completion is `processFunc` returning — so emitting first gives at-least-once
  for free. A crash mid-turn re-consumes on restart.
- **Never return `error` for an upstream API failure.** Burrow's default `FatalOnError` calls
  `os.Exit(1)`; an LLM outage would crash-loop the pod. `release` as `unresolvable` and
  return `nil`.
- **Cancelled LLM calls still bill for generated tokens.** Argues for a short debounce inside
  the responder before starting the call.

Responder state is a **cache, never the source of truth**. It may cache aggressively (prompt
caching, session reuse) but must be correct when handed full context cold.

## Delivery confirmation (decided)

Forward `bot_echo`s to the responder for the duration of the delegation, alongside user
messages. **message-worker does not change** — it keeps publishing echoes to the event bus and
never learns responders exist.

Replybot doing the forwarding is not coupling: the filter is *"is this user currently
delegated"*, which is **state-dependent**, and replybot is the only component holding that
state. A stateless bus cannot route on it. Either replybot projects the relevant slice, or
every responder re-derives delegation state from the firehose — duplicated state that will
skew. The component owning the state performs the projection.

Why the responder needs this: it knows what it *emitted*, not what was *delivered*. A send can fail
(message-worker error, blocked user, outside the 24-hour window `(#10)`). A model whose next
turn references a question the participant never received produces an incoherent conversation.
message-worker publishes a `bot_echo` after every successful send on every platform
(`worker.go:254`), which replybot already consumes to arm waits.

This gives the responder delivery ground truth, a reconciliation point for its cache, and an
exact definition of cold start: replay the delegation's forwarded events.

Make it opt-in per service — `receive: [user_messages, delivery_echoes]`.

**Escape hatch:** echoes are published via `PublishRawEvent(ctx, cmd.UserID, data)` onto the
raw events topic, so a responder wanting full history can subscribe directly. Cost: it is the
firehose (every user, survey, platform), and it is the *raw platform-shaped* schema, not the
normalized `UniversalEvent` — the WhatsApp echo carries `phone_number_id`/`from`, Messenger's
differs. Default to forwarding; document the subscription as the advanced path.

## Provenance

- **`metadata.responder: '<service>'` on outbound responder messages.** In the Full Messages
  export, `get_direction` labels every echo `direction = 'bot'` — the only type that does. So
  without a tag, a model's improvised sentence and an ethics-approved researcher-authored
  question are indistinguishable rows in the CSV. Cheap now, **unrecoverable retroactively**.
  Also needed to correlate own-utterances when consuming the firehose.
- **Put the whole model result in the synthetic event payload** — chosen value, confidence, raw
  user text, prompt version, model id, tokens. The `messages` table already holds every raw
  event, so this makes provenance a consequence of the architecture rather than a side table
  that desyncs.
- **`responses` only has `response VARCHAR`.** The coded label lands where analysts look; the
  raw text does not. Writing it out (second response row or hidden field, following the
  `e_payment_*` convention) is the one deliberate act required.

## What this subsumes

`type: handoff` (`machine.js:478`, `replybot/HANDOFF_PROTOCOL.md`) already delegates via
Facebook `pass_thread_control`: Messenger-only, hands the participant to something that talks
to Facebook directly, and drops inbound user events while delegated (`_isHandoffWait` →
`_noop()`). The external responder is the platform-agnostic version — control delegated
logically inside the state machine, the responder speaking through our own pipeline, works on
WhatsApp. Design it to eventually replace the FB handoff rather than sit beside it.

## OPEN

- **Does `resolve` exist in the takeover case?** A responder that converses freely *and* writes
  answers is a model filling in a survey from a chat it conducted. That may be exactly what
  researchers want, but it is a different provenance story than coercion and may warrant a
  distinct marker in `responses` rather than looking like a normal answer.
- **Transcript shape in the envelope** — full history vs. delta since last command.
- **Where the responder service lives** — a new provider inside `external-worker` (reuses its
  command → synthetic-event machinery) vs. a separate service. Leaning `external-worker`.
- **Budget enforcement granularity** — per-survey ceiling in the responder (the only stateful
  place); behaviour on exhaustion (`unresolvable` → fallback buttons).
- **Eval** — see `planning/llm-enumerator-eval.md`. Build before shipping.

## Implementation roadmap (for future agents)

Read `CLAUDE.md` first — especially the documentation-first protocol and the IaC rule.
Read `replybot/README.md` and `documentation/questions.md` before touching machine code.
Work in a git worktree for anything that runs.

**Phases 1–3 below are the sub-bot framework, not the LLM feature.** The order of work
and the consumer list are owned by `planning/sub-bots.md` §8; the payment sub-bot goes
before the LLM responder. Phase 0 and Phases 4–6 are this feature's own.

### Phase 0: Eval (prerequisite, no code changes)

Follow `planning/llm-enumerator-eval.md`. Mine the prod DB read-only, build the frozen JSONL,
score baselines and cheap-tier models on the three metrics (coding accuracy, escape recall,
forced-fit rate). This validates the feature before building it and gives a number to beat.

### Phase 1: `DELEGATED` state in the machine (replybot, pure core)

1. Add `DELEGATED` to the state enum in `apply()` and `exec()`.
2. Add the `delegation` transient field (`{id, service, turns, deadline, config}`) — clear it
   on every exit path, same discipline as `error`/`retries`/`wait`. Update the transient-field
   table in `replybot/README.md`.
3. Guard TEXT/QUICK_REPLY/POSTBACK/MEDIA in `exec()` — when `state.state === 'DELEGATED'`,
   forward instead of `RESPOND`. One condition, same position as `_isHandoffWait`.
4. Add the fencing check: any `say`/`release` with a non-matching `delegation_id` is
   `_noop()`.
5. Add `addCustomType` parsing for the `responder:` YAML block (already merges arbitrary YAML
   into `field.md` — just needs the field type to be recognized).
6. Add the `release` path — the outcome runs `validator(field, messages)`; pass → record as
   a normal answer (`response` = `choice.label`) and exit `DELEGATED`; fail → stay delegated
   and forward the validator's message as an `event`.
7. Add `metadata.responder: '<service>'` to outbound messages from delegated turns.
8. Tests: `replybot/lib/typewheels/machine.test.js` — new state, forwarding, fencing,
   propose-and-validate, capability rejection. Fixtures in `events.test.js`.

### Phase 2: Delegation topic + replybot producer (replybot, IO edge)

1. Add the `vlab-<env>-delegations` topic to `devops/values/{production,staging}.yaml`.
2. Replybot publishes `open` and `event`, keyed by userid — `event` is whatever arrives
   for a delegated user, normalized, unclassified.
3. Replybot consumes `say`/`release` from `vlab-prod-chat-events`, fences, validates
   `release`, applies.
4. `closed` emitted from natural exit paths only (release, max_turns, expiry). Do not
   thread through `RESTORE_STATE`/`BLOCK_USER` — fencing handles those.

### Phase 3: Dean `Delegations` query (dean)

1. New query in `dean/queries.go` following `Respondings` pattern. Select
   `current_state = 'DELEGATED'` where `delegatedAt + deadline < now`.
2. Emit `delegation_expired` carrying `delegation.id` from `state_json`.
3. Handler in replybot must exit `DELEGATED` (clear the field, apply fallback) — do not
   re-select. Test the self-clearing predicate.

### Phase 4: Responder service (Go, using burrow)

1. New consumer group on `vlab-<env>-delegations`, filtering on `service`.
2. `burrow` with `KeyAffinity: false`, `FatalOnError` → `release` as `unresolvable`, return
   `nil` for upstream errors.
3. Per-user in-flight map with cancellation tokens. Serialize state mutation with per-user
   mutex; do not serialize arrival.
4. LLM provider with model alias → provider config mapping. Start with the cheap tier.
5. POST `say`/`release` to hermes `/synthetic`, addressed with the identity from `open`,
   with a retry budget on the pattern of `DINERSCLUB_RETRY_BOTSERVER`.
6. Decide: inside `external-worker` (reuse its machinery) or standalone. Leaning
   `external-worker`.
7. Short deadline enforcement inside the responder (context timeout on the LLM call).

### Phase 5: Dashboard + provenance

1. `DELEGATED` in `ConditionBuilder.js`, `StatesSummary.js`, `StateDetail.js` (color).
2. `metadata.responder` surfaced in the Full Messages export.
3. Raw text + model metadata written to `responses` (second row or hidden field).

### Phase 6: Ship gate

1. Eval passes (Phase 0 numbers beat baselines).
2. Randomized arm via `seed_2` — LLM-enumerator vs. plain MC, compare response distributions
   and drop-off.
3. Consumer-lag alerting for the new topic
   (`documentation/kafka-consumer-lag-alerting.md`).

## Deliberately deferred

- **Voice.** `MessageContent {type: 'question', question_text, options, metadata}` is already a
  structured instruction a voice agent could consume, and the platform abstraction means voice
  would be a fourth platform (hermes-equivalent inbound + message-worker adapter outbound), not
  a new app. Notable coupling: **voice makes coercion mandatory, not optional** — ASR returns
  "um, MTN I think", which no exact-label validator accepts, and reading 13 options aloud is
  unusable. Not being pursued now.

## Adjacent findings (not part of this work)

- `documentation/chat-message-logging.md` is stale: `replybot/lib/chat-log/` no longer exists
  (removed with the platform abstraction), but `VLAB_CHAT_LOG_TOPIC` is still set in both
  `production.yaml` and `staging.yaml`.
- message-worker runs `NUM_WORKERS: "1"` in production (`production.yaml:844`) against a code
  default of 100, because burrow has no key affinity and ordering is preserved by never
  processing two messages at once. `KeyAffinity` exists in the burrow working tree but is
  **uncommitted** and not in `v0.1.4`, which is what `message-worker/go.mod` pins. Landing it
  would unlock concurrency there — independent of this feature.
