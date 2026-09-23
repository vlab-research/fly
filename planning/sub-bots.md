# Sub-bots — the delegation primitive

> The main bot hands the conversation to a sub-bot. The sub-bot talks to the
> participant as much as it wants, keeps its own state, and hands control back
> when it is done. The main bot keeps almost nothing while that happens.
>
> **Status: proposed.** The generic layer was first written down inside
> `planning/external-responder-design.md` (for the LLM case, decisions largely
> settled). This document lifts it out as a platform primitive with more than
> one consumer. Where that document has already decided something, this one
> cites it rather than restating it — do not let the two drift.
>
> **Consumers:** the payment sub-bot (`planning/payment-ledger.md`, first), the
> LLM sub-bot (`planning/external-responder-design.md` +
> `planning/llm-enumerator-eval.md`, second).

---

## 1. Why a primitive rather than two features

Three separate problems turned out to be the same problem:

- **Payments.** Payment failure handling is authored in each survey's Typeform
  YAML, branching on `e_payment_*` md keys. Every researcher re-implements it,
  differently, and a fix ships per-form by hand. That is what produced Girl
  Effect's "ineligible" screen for 129 respondents we had already paid.
- **LLM coercion.** A model needs to probe a free-text answer over several turns
  and code it into an option. `bauchipay1hausa/mobile_provider` has 918 distinct
  values over ~3.8k responses, including respondents naming their handset
  instead of their network — unrecoverable post-hoc, you have to *ask*.
- **Sub-forms.** A form that runs another form and resumes where it left off.

All three are "someone other than the main survey machine talks to this
participant for a while." `planning/external-responder-design.md` already
factored this out once, generically, for the third party case. It has no ticket
and one consumer. It should have a name and three.

## 2. The contract

A sub-bot is legal if and only if it satisfies all of these.

### 2.1 It owns its state

**The main bot keeps only: "I am delegated", the delegation id, and where to
resume.** Not the sub-bot's questions, not its answers, not its transcript.

This is encapsulation, not a call frame sharing the caller's memory, and the
difference is load-bearing:

- **The parent's state stops growing while delegated.** State size is a live
  operational problem — `STATE_STORE_LIMIT` exists because an oversized history
  has to be refused outright (`statestore.js` returns a capped `USER_BLOCKED`
  state past the cap), there is a planned quarantine at 100 `externalEvents`
  (`planning/dean-spammers-external-events-quarantine.md`), and the replybot OOM
  traced to the same place. A thirty-turn sub-bot conversation adds nothing to
  the parent blob.
- **Form version resolution stays independent.** Each machine resolves its own
  version from its own `md.startTime`. A shared-state design would have to save
  and restore the caller's `startTime` — `_stitch` (`machine.js:274`) overwrites
  it — or the caller resumes on a different version of itself.

Where the sub-bot's state lives is the sub-bot's problem, by definition: a
service's own store, a `payment_claims` row, a `states` row under a derived key.
The parent's schema does not change per sub-bot.

### 2.2 `qa` is working memory; `responses` is the record

The reason "the parent keeps nothing" is not lossy: the parent was never the
durable store of answers. A sub-bot that collects answers writes them to
`responses`, where analysts already look. The parent keeps the **outcome**,
enough to branch on — not the process.

### 2.3 It owns the conversation exclusively while delegated

While delegated, the parent emits nothing of its own, and **participant events
are forwarded to the sub-bot, not recorded as answers.**

That second half is not hypothetical. In `exec`, TEXT/QUICK_REPLY/POSTBACK/MEDIA
fall through to `RESPOND` unless the state is `RESPONDING`, `USER_BLOCKED` or
`_isHandoffWait` — so **today a participant who texts during a payment wait has
it recorded as their answer to the payment question.** See
`external-responder-design.md` § "`DELEGATED` is a real state" for why this
argues for a distinct state rather than a flag on the wait.

### 2.4 It declares when it is done, and returns a small value

Not a transcript. Something the parent can branch on. Control returns on
completion — there is no separate "done talking" transition (see §4.2).

### 2.5 It is fenced by an id derived from the log

The delegation id is **the `event_id` of the event that opened it** — not a
UUID, because `exec`/`apply` are pure and re-folded on every `getState`, so a
generated id would differ on each fold. Every sub-bot command carries it; the
parent drops anything that does not match the current one.

This is the difference between the primitive surviving and rotting. Any future
path that exits the delegated state without knowing sub-bots exist —
`RESTORE_STATE`, a bail, `BLOCK_USER` — is correct without its author knowing
anything. Fail-safe rather than "every exit path must remember to close".

Full reasoning, including the two-level hierarchy and why close is best-effort:
`external-responder-design.md` § "Delegation ID as fencing token".

### 2.6 Its non-determinism stays outside the fold

`getState` folds the entire event log through pure `exec`/`apply` on every read.
So no sub-bot's decision may be *recomputed* by the parent — it must land in the
log as a fact. A sub-bot may have wall-clock, timers, retries and IO precisely
because it is not in the fold.

This is why a sub-bot is a service rather than a handler inside the machine,
even when its logic happens to be deterministic.

## 3. What the parent keeps

The main bot is a router plus a stack, with exactly two powers it cannot
delegate — because the sub-bot is the component most likely to be broken:

1. **The fencing check** (§2.5) — one comparison, in the pure core, where the
   sub-bot's output is adjudicated.
2. **The deadline backstop.** Two tiers: the sub-bot enforces its own short
   deadlines; dean is the backstop for a sub-bot that died, following the
   existing `Respondings` pattern. The trap, already identified: the expiry
   handler must actually *exit* the delegated state, or it rebuilds dean's
   re-selection loop. Expiry must carry the delegation id.
   See `external-responder-design.md` § "Deadlines: two-tier".

Everything else — what to say, how to read a reply, when to give up — belongs to
the sub-bot.

## 4. Consequences worth stating

### 4.1 Provenance is not optional

In the Full Messages export, `get_direction` labels every echo
`direction = 'bot'`. Without a tag, a model's improvised sentence, a payment
sub-bot's "it's on its way", and an ethics-approved researcher-authored question
are indistinguishable rows. **Every sub-bot tags its outbound messages with its
own identity.** Cheap now, unrecoverable retroactively.

### 4.2 There is no "hand back early"

Control returns on completion. We considered and rejected separating "done
talking" from "done working", and rejected a sub-bot re-taking control later
(interrupts): both drag in safe-point queueing, concurrent-frame rules, and
out-of-window templates for every re-contact. If a sub-bot has nothing more to
ask and is not finished, it stays delegated and silent.

The consequence to accept deliberately: a slow sub-bot holds the participant.
For payments that is correct — they are owed money and have not been paid — and
the escape is a human resolving the underlying record, not an interrupt.

### 4.3 Resuming can be outside the 24-hour window

A sub-bot that finishes days later hands back, and the parent's next question is
an out-of-window send. Not a new problem — it is what the template systems were
built for (`documentation/whatsapp-templates.md` names "payment retries, any
re-contact") — but a survey with questions after a delegation point needs its
resume path to go through an approved template. Design it in; do not discover it.

### 4.4 It subsumes the Facebook handoff

`type: handoff` (`machine.js:512`, `replybot/HANDOFF_PROTOCOL.md`) already
delegates via `pass_thread_control`: Messenger-only, and it drops inbound
participant events while delegated. Sub-bots are the platform-agnostic version.
Design toward replacing it rather than sitting beside it.

## 5. The conformance test

**A whole fly machine, running another form, must be a legal sub-bot.**

We may never ship this. It is a test of the interface, not a feature request: if
the contract is clean enough to carry an entire machine with its own state, its
own form stack and its own version resolution, then a payment sub-bot or an LLM
sub-bot is trivially inside it. If it *cannot* carry a fly machine, the contract
is leaking something the parent should not have known.

Apply the test to any proposed change to §2.

**One delegation at a time. A sub-bot does not itself delegate.** No nesting, no
stack, no depth cap — out of scope, and nothing we want needs it. The test above
is unaffected: it asks whether the contract can *carry* a machine, not whether
one can be nested inside another.

## 6. The consumers

| # | sub-bot | goal | decision space | success criterion |
|---|---|---|---|---|
| 1 | **payment** | pay this participant | three recovery classes | the provider accepted |
| 2 | **LLM** | code a free-text answer into an option | open | the eval says it matches an enumerator |
| — | fly machine | run another form | n/a | conformance test only |

Payments first, deliberately: a fully-enumerated decision space and a hard
success criterion prove the interface without it having to absorb
non-determinism while it is still being designed. The LLM sub-bot is not starved
by going second — it already has a design and an eval plan.

## 7. Open

- **Where sub-bot services live** — a provider inside `external-worker` (reuses
  its command → synthetic-event machinery) vs. separate services. The responder
  design leans `external-worker`; the payment sub-bot may want its own, since it
  owns a database.
- **Return value shape** in the envelope, and whether it is uniform across
  sub-bots or per-sub-bot.
- Everything under `external-responder-design.md` § OPEN still applies to
  consumer 2.
