# Payments as a first-class subsystem — Plan

> Origin: VIR-73, which began as "find something lighter than a bail for payment
> problems" and became a question about what a payment *is*. The immediate
> prompt was the Girl Effect incident (VIR-55/56/68/72): 463 respondents bailed,
> 161 told their number was already used, 129 of them paid 150 and then shown an
> "ineligible" screen, and a recovery that ran on hand-assembled CSVs.
>
> **Status: proposed. Nothing here is built.** Phase 1 is read-only and is also
> the step that can disprove the design; do not commit to a schema before it
> passes.
>
> **Related:** `planning/sub-bots.md` (the delegation primitive — the payment
> sub-bot is its first consumer), `documentation/payment-recovery.md` (the
> system as it is today — read it first), `dinersclub/README.md`,
> `documentation/bail-systems.md`, `planning/payment-failure-handling.md` (the
> 2026-08-20 decision this builds on),
> `planning/payment-provider-landscape.md`.

---

## 1. The decision

Payments stop being a side effect of a survey question and become a subsystem
with its own record, its own controller, and its own convergence process.

Three parts, in the order they matter:

1. **A claim** — a durable row saying *this respondent is owed X*, created when
   they cross the payment point. The desired state.
2. **A sub-bot** — while a claim is open, a payment sub-bot owns the
   conversation. It decides what to say and how to read replies. When the claim
   completes, control returns to the survey machine at the next field. It is the
   first consumer of the delegation primitive in `planning/sub-bots.md`.
3. **A reconciliation loop** — a background process that converges reality onto
   the claims, and whose only oracle is the payment provider.

The survey declares the obligation. It does not execute it, and it does not
handle its failures.

### 1.1 What "complete" means

**A payment is complete when the provider says it is.** Not when the money
reaches the handset — we have no way to observe that, for any provider, and the
design must not pretend otherwise.

This is a definition, not an approximation, and it settles several things:

- The terminal success state is *disbursed*, not *paid* or *delivered*. Use that
  vocabulary in the schema and in exports; a researcher reading a column called
  `paid` will draw a conclusion we cannot support.
- **Provider reconciliation is the whole of reconciliation.** There is no second
  oracle, no respondent-confirmation loop, no "did it really arrive" question we
  are obliged to answer.
- `unknown` survives as a status, but shrinks to one honest case: we issued a
  request and never got an answer. It is always resolved by asking the provider,
  never by asking the respondent — so every `unknown` has a mechanical path out.

We tell the respondent the money is on its way. For us it is complete.

### 1.2 What we deliberately rejected

Recorded because each was considered and each would have cost real complexity:

| rejected | why |
|---|---|
| The payment subsystem re-taking control later (interrupts) | Too complex. Requires safe-point queueing, concurrent-frame rules, and out-of-window templates for every re-contact. If the respondent has gone quiet we do not chase them; the claim stays open for a human. |
| Separating "release" (done talking) from "resolve" (done paying) | Two transitions where one will do. Control returns on completion, full stop. |
| Deriving the contract purely from survey design | Not possible — see §3.2. The amount is interpolated per respondent. |
| A payment as a system-owned *form* stitched into the conversation | Reuses the stitch machinery, but a form cannot express "back off six hours and retry", so it collapses back into the sub-bot. |
| Fabricating success Results to mark someone paid | An operator act must be structurally distinguishable from a real disbursement, not distinguishable by convention. It becomes a claim state with an actor. |
| A human queue behind the sub-bot's chat | "Someone will get back to you" is a commitment to an SLA that does not exist. The sub-bot deflects honestly instead; escalation is a list on a dashboard, not a queue with a respondent waiting on it. |
| The payment handler living inside the machine | It needs wall-clock, timers, retries and IO, none of which may happen inside a pure fold. See `planning/sub-bots.md` §2.6. |

---

## 2. Why — the evidence

The case is not that payments are broken. It is that **five layers each solve a
slice of the problem and none of them can state the problem.** That is the
signature of a missing domain object.

- `dinersclub/db.go` opens a database pool **solely to read `credentials`. It
  never writes.** What `payment-recovery.md` §3 calls "the ledger" is
  `dinersclub_payment_results_total` — a Prometheus counter with no `userid`, no
  survey, and finite retention.
- **Withheld failures are recorded nowhere.** `payment-recovery.md` §4 states
  this as a deliberate trade. `INSUFFICIENT_BALANCE` alone is 34% of recorded
  payment failures (8,521 of 22,802 in the production census).
- **`states.payment_error_code`** (`devops/migrations/01-init.sql:147`) is
  hardcoded to `e_payment_reloadly_*`, so it is blind to DingConnect, giftcards
  and the http provider; it reflects only the latest state; and it is not
  cleared by a later success (VIR-72).
- **Nothing records money spent per respondent.** User `8563270007096163` was
  paid 1,424 times over 1.5 years
  (`planning/dean-payments-timeouts-retry-caps.md`). We found it by counting
  `retries` in a state blob — the spend was inferred from a retry loop, because
  there was nothing to count directly.
- **Payment error UX is form-authored.** Forms branch on `e_payment_*` md keys,
  so every researcher re-implements failure handling in Typeform YAML,
  differently. Girl Effect's "ineligible" screen was a branch-ordering bug plus
  stale md keys, and fixing it required editing each form by hand —
  `girleffectincentive` still carried the old logic a day after two sibling
  forms were corrected.
- Every recovery mechanism we own — dinersclub's in-process backoff, dean's
  re-drive, the recovery classifier, form branches, bails — is a workaround for
  an obligation that was never written down.

**The counter-case**, recorded honestly: if payments were incidental this would
be over-engineering, and the right answer would be to fix VIR-72, write an
operator script, and move on. They are not incidental — payment is a standing
part of the platform's value proposition and the failure volume is load-bearing.

---

## 3. What the code constrains

Two findings that are not negotiable and that shaped the design.

### 3.1 A payment point writes no `responses` row

`_handleExternalEvent` (`replybot/lib/typewheels/machine.js`) returns
`response: null` and sets no `responseValue`; `update()` (`machine.js:961`)
emits a response row only when `responseValue` is present. So **crossing a
payment point leaves no row in `responses`.**

The only traces are the outbound echo in `messages` and, if a Result came back,
an entry in `state_json.externalEvents`. A *withheld* failure leaves neither.
"Everyone who reached point P" is therefore not currently a query — it is a fold.

### 3.2 The amount is interpolated per respondent

`interpolateField` (`replybot/lib/typewheels/form.js:176`) walks every key of a
field, so a payment block's `amount`, `number` and `custom_identifier` may all be
templated against that respondent's answers.

The contract is therefore **not** "form F, field R ⇒ 150 KES" in general. Only
replybot, at the moment of crossing, with that respondent's `qa` in hand, can
compute X.

### 3.3 The consequence

The claim must be **written at crossing** — that is the only moment X is
knowable — and **independently re-derivable** by re-folding that respondent's
event log, which reproduces the same interpolation.

Two sources: a fast writer that can drop things, and a slow auditor that finds
what was dropped. That is what makes the system self-healing, and it is the
difference between this and a log. A log is only as good as its emitter; our
emitter fails silently in at least three known ways (Kafka loss, a provider
absent from `DINERSCLUB_PROVIDERS`, a crash between the state write and
`publishPayment`).

### 3.4 The seams, for reference

Useful facts about how payments move today, verified while designing this:

- A payment wait is `{type: 'external', value: {type: 'payment:<provider>', id}}`
  and `waitConditionFulfilled` (`waiting.js:106`) subset-matches it. Any Result
  fulfils it; nothing checks the sender. Anything that can POST `/synthetic` can
  release a parked respondent.
- A `PaymentEvent` on `vlab-payment` is plain JSON and dinersclub does not care
  who produced it. `details` *is* the provider settings.
- replybot owns the only producer (`publishPayment`, `lib/index.js:67`).
- Out-of-window sends require a pre-approved template — see §6.11.

---

## 4. The model

### 4.1 Claims and attempts

Two tables. The split is already implied by `payment-recovery.md` §3 — *"one
payment point produces exactly one classified Result, however many provider
calls it took"* — and DingConnect's cascade makes it physical.

```
chatroach.payment_claims
  id                UUID PK
  userid            VARCHAR NOT NULL
  account_id        VARCHAR NOT NULL
  platform          VARCHAR
  survey_name       VARCHAR NOT NULL      -- the study, not the version
  shortcode         VARCHAR               -- the form they crossed on
  surveyid          UUID                  -- the version, for audit only
  question_ref      VARCHAR NOT NULL      -- the payment field
  owner_id          UUID NOT NULL         -- researcher (credentials.userid)
  provider          VARCHAR NOT NULL
  credential_key    VARCHAR               -- which wallet
  amount            DECIMAL NOT NULL
  currency          VARCHAR NOT NULL
  destination       VARCHAR               -- see §7.2 before implementing
  status            VARCHAR NOT NULL
  origin            VARCHAR NOT NULL      -- survey | audit | operator
  crossed_at        TIMESTAMPTZ NOT NULL
  completed_at      TIMESTAMPTZ
  updated           TIMESTAMPTZ
  UNIQUE (userid, survey_name, question_ref)     -- §4.3
```

```
chatroach.payment_attempts
  id                 UUID PK
  claim_id           UUID NOT NULL REFERENCES payment_claims
  attempt_no         INT NOT NULL
  actor              VARCHAR NOT NULL     -- subsystem | operator | reconciler
  custom_identifier  VARCHAR NOT NULL     -- what we sent the provider
  provider_ref       VARCHAR              -- the provider's transaction id
  outcome            VARCHAR NOT NULL     -- accepted | declined | unknown
  code               VARCHAR              -- provider error code, verbatim
  recovery           VARCHAR              -- transient|precondition|respondent|permanent
  requested_amount   DECIMAL
  delivered_amount   DECIMAL              -- providers return both; fees/FX differ
  raw                JSONB
  started_at, finished_at
  UNIQUE (claim_id, attempt_no)
```

`delivered` — whether a Result reached the respondent — belongs on the attempt.
It is the durable answer to "were they told", which today exists only as the
absence of a message.

### 4.2 The claim's life

```
owed ──► claiming ──► disbursed                      (provider accepted)
  ▲          │
  │          ├──► declined(transient|precondition) ──► owed   (backoff)
  │          ├──► declined(respondent)             ──► needs_respondent
  │          └──► unknown                          ──► needs_verification
  │                                                        │
  │                                     (provider report) ─┘
  │
  └── needs_attention   (attempt cap reached — a human, never a silent drop)

terminal by human act:  disbursed_offline | waived
```

- **`needs_respondent` is handled by the sub-bot**, while we still
  have them. If they have gone quiet, the claim sits and a human deals with it.
  We do not chase.
- **The attempt cap escalates.** That is the fix for the 1,424-retry case: the
  loop stops, the claim stays visibly outstanding, a human sees a queue rather
  than a silence.
- **`disbursed_offline` and `waived` are the operator verbs.** The whole of
  VIR-73's original "lighter than a bail" ask collapses into two state
  transitions with an actor and a reason attached. No fabricated events.

### 4.3 Claim identity — the most important line in the schema

`UNIQUE (userid, survey_name, question_ref)` — deliberately **not** including
the survey version or the form instance.

- Bailing someone into a corrected form does not create a second debt: they
  cross the point again, the claim already exists, nothing new is owed.
- Baseline and endline are different `question_ref`s, so they remain two claims.
- The Girl Effect cohort paid 150 against a 75 claim surfaces as an
  over-disbursement, which §5.2 can actually see.

Get this wrong and the system either double-pays on every re-bail or silently
merges two genuine obligations.

### 4.4 The identifier

Mint the claim id in replybot and derive `custom_identifier` from it.

This resolves the deadlock recorded in `payment-recovery.md` §8 and VIR-68:
`custom_identifier = <claim_id>` is stable across retries, so a genuinely
repeated payment still dedupes at the provider — but when reconciliation
establishes that an identifier was **burned** (Reloadly consumes one on a
decline; see the upstream ticket), the next attempt mints
`<claim_id>-<attempt_no>`. Uniqueness per attempt and duplicate suppression stop
being in tension, because the dedupe key becomes ours rather than the provider's
accident.

---

## 5. Reconciliation is three processes

Different cadences, different failure modes, and only the third spends money.

### 5.1 Contract ↔ claims (the auditor)

A batch fold over `messages` that derives who crossed which payment point for
what amount, and diffs against `payment_claims`. Catches: lost emissions, wrong
amounts, claims with no crossing.

Read-only. Daily. **This is Phase 1 and it is the falsification step.**

### 5.2 Claims ↔ provider (the reconciler)

Pull the provider's transaction report, match on `custom_identifier`, correct our
view. Resolves every `unknown`. Detects over-disbursement.

Read-only against our data, read-only against the provider. It would also settle
empirically which of the 2,385 `CUSTOM_IDENTIFIER_ALREADY_USED` respondents
actually received money — a question currently answered by inferring from
`success=true` in md, by hand.

### 5.3 Claims ↔ disbursements (the settler)

Picks up `owed`, attempts, records, backs off. Idempotent twice over: an in-flight
lock on the claim, and a provider-side dedupe on the derived identifier.

**This is the only part that moves money, and it is last.**

---

## 6. The payment sub-bot

The first consumer of `planning/sub-bots.md`. A separate service whose only goal
is to pay one participant.

**The way to think about it: a control loop with a mouth, and the loop has to
work with the mouth turned off.** Design the chat first and you rebuild today's
system, where the participant's presence is load-bearing and everything degrades
the moment they stop replying. The test for any feature: *does the loop still
terminate correctly if this message is never delivered and never answered?* If
not, it belongs in the loop, not the chat.

### 6.1 The claim row is the sub-bot's state

No session memory, nothing in RAM that matters. Every decision it makes is
recoverable by reading the claim and its attempts, so a restart mid-flight
resumes correctly. That is what "self-healing" cashes out to operationally.

It is a service, not a handler inside the machine, because it needs wall-clock,
timers, retries and IO — none of which may happen inside the pure fold
(`sub-bots.md` §2.6).

### 6.2 Its decision space is already enumerated

`dinersclub/classify.go` partitions every provider error into a recovery class,
and that partition is exactly the sub-bot's world. It needs no new taxonomy:

| class | the loop | the mouth |
|---|---|---|
| `transient` | retry with backoff | silence |
| `precondition`, or an `unknown` that persists | wait; a human acts off-stage | **"this is taking longer than expected"** |
| `respondent` | pause | **ask for another number** — the only question it ever has |
| cap reached | stop, mark `needs_attention` | silence |

`payment-recovery.md` §3 already defines `precondition` as *"a human off-stage
must act first, **and the respondent has no part in it**"*. That is the
definition of "sorry, this is taking longer than expected." The class was always
the right abstraction; we simply never used it to say anything.

The same fact drives both ends: the condition that sends that message is the
condition that fires the `PaymentWalletEmpty` alert. The respondent is told at
the moment the researcher is paged, and no new detection is needed.

### 6.3 What it says — four messages and a timing rule

1. acknowledgement / "sending your X"
2. "sent — it should arrive shortly"
3. "that number didn't work — what's another number we can send it to?"
4. "this is taking longer than expected; we'll keep trying"

**Announce outcomes, not attempts.** Most payments resolve in seconds, and
"sending now…" followed two seconds later by "sent!" is noise. The first message
is timer-gated: emitted only if the claim has not resolved within N seconds. A
service can do that; the machine could not.

**Message 4 is sent at most once per claim**, gated on elapsed time rather than
on the first `precondition` failure. Repeating "still taking longer" every few
hours is how a good message becomes a complaint. After it, the next thing they
hear is "sent".

Emission is keyed on `(claim_id, kind, attempt_no)` so a restart does not
re-send.

### 6.4 What it says to everything else — deflection, not escalation

There is **no human queue**. Anything that is not an answer to its one question
is deflected, in two distinct ways:

- *They answered, badly* — "that doesn't look like a number we can send to."
- *They asked something else* — "sorry, I can't answer questions."

Collapsing those two tells someone who fat-fingered a digit that we are refusing
to talk to them.

**When it is not asking anything, the deflection is a status reply.** A
participant who writes in during a wait gets "I can't answer questions — your
payment is still on its way", which is simultaneously a brush-off and the one
thing they wanted to know.

Cap the deflections: after a few, go quiet and stay delegated. Silence is a
legitimate response. Escalation to a person is not — that would be an SLA we
cannot honour. `needs_attention` is a list on a dashboard, not a queue with a
respondent waiting on the other end.

### 6.5 The chat box is a delivery sensor we said we would never have

§1.1 fixes completion as *the provider said so*, because delivery is
unobservable. But a participant replying "I didn't get it" is the only delivery
signal anywhere in the system.

It must **not** drive payment — "I didn't get it" → pay again is an obvious
exploit. It should be recorded against the claim and **counted**. A cluster of
non-receipt reports against one operator or country, while the provider reports
success, is precisely the evidence that a provider's reports are lying — and
because it is aggregate, no individual claim has to be believed.

Detection, not disbursement.

### 6.6 What it can own that no form ever could

**Provider fallback.** Today the provider is baked into the form's payment block,
so "Reloadly refused this operator — try DingConnect" has nowhere to live. Two
open tickets are that homeless feature: VIR-62 (11 Bolivians unpayable via
DingConnect, "investigate, try Reloadly") and VIR-54 (the discovery cascade stops
early). A system whose only goal is to pay someone is the right owner for "try a
different rail".

**Trap:** the sub-bot must parse and normalise phone numbers with the *same*
parser the form uses (`replybot/lib/phone.js`). `documentation/phone-numbers.md`
states the symmetry contract — anything the question accepts must normalise at
the payment. A second parser in a second service accepts numbers it then cannot
pay.

### 6.7 What it must never do

Decide eligibility or amount (that is the survey's contract), branch on survey
logic, hold the participant when it has nothing to ask, or pay without a claim.

### 6.8 Forms stop branching on `e_payment_*`

The sub-bot owns everything the participant sees about a payment. A researcher
cannot get payment UX wrong, and a fix ships once for everyone instead of
per-form by hand — which is the actual lesson of Girl Effect, where
`girleffectincentive` still carried the old branch logic a day after two sibling
forms were corrected.

Existing forms keep today's semantics behind an explicit `await: true` on the
payment block until migrated; their `e_payment_*` branches would otherwise
become dead or, worse, wrong.

### 6.9 The copy is four strings, not a UX

Researchers need their own voice and their own language — Girl Effect in Kenyan
English, Bauchi in Hausa. That is **four strings per survey per language, plus
the approved templates for out-of-window sends**, with a platform default they
can leave alone.

Worth stating plainly because the alternative framing ("researchers configure
payment messaging") sounds like a product surface and is not one. The line is:
researchers own the words, the platform owns the logic.

### 6.10 How it ends

Terminal states are `disbursed`, `disbursed_offline`, `waived`.

Escalation is **not** terminal and does not return control: the participant is
owed money and has not been paid, so the delegation holds, and a human resolving
the claim is what releases it.

That makes `waived` a necessary escape hatch, to be designed deliberately rather
than discovered. VIR-62's Bolivians may be genuinely unpayable by any rail we
have; somebody must be able to say "we cannot pay this person, let them
continue" and have it recorded as a decision with a name on it, rather than as a
bail.

### 6.11 Resuming after a slow completion

Control returns on completion, and completion can land days later — a wallet
topped up on Thursday for a payment that stalled on Monday. The parent's next
question is then an **out-of-window send**.

Not new: it is the same problem dean has, and what the template systems were
built for (`documentation/whatsapp-templates.md` names "dean timeouts and
follow-ups, payment retries, any re-contact"). But a survey with questions after
its payment point needs its resume path to go through an approved template, and
that must be designed in rather than discovered in production.

---

## 7. Risks

### 7.1 A backfilled claim must never auto-settle

A derivation bug over history creates debts en masse. The first auditor run is
dry, diffed and human-approved before anything becomes payable. The settler must
refuse claims whose `origin = 'audit'` until they are explicitly released.

### 7.2 `destination` is a phone number

Same class of data `responses.metadata` already carries, but a table of
number + amount + outcome is a more attractive target than anything we currently
keep. Decide before the migration whether it is stored in the clear, hashed with
a retained suffix, or by reference. See `documentation/phone-numbers.md`.

### 7.3 A second source of truth

Today the platform has exactly one: the conversation. `states` is the fold of the
event log and everything else derives from it; every recovery tool we own works
by putting an event into that log. **This design says that for money, the
conversation is not the record.** The claim table outlives and out-scopes the
state machine — the first domain object in this codebase that does.

That is the real architectural cost. It is a second thing that can be wrong, a
second thing to keep consistent, and a second thing every future feature has to
know about. It is defensible here because the money is a promise to a person and
the conversation demonstrably fails to record it — but it should not become a
precedent applied casually.

### 7.4 Money safety

Caps on the settler: per run, per survey, per wallet, each escalating to
`needs_attention` rather than proceeding. A kill switch. Owner scoping through
`credentials` exactly as exodus does it after VIR-60.

### 7.5 Migration overlap

While both paths are live, dean is still re-driving and forms still branch on md.
The claim table must be authoritative for **both** paths before the settler turns
on, or the overlap double-pays.

---

## 8. Phases

Ordered so that the cheapest step is the one that can disprove the design.

| phase | what | spends money | ships value alone |
|---|---|---|---|
| **1** | **The auditor** (§5.1) as a read-only report over history | no | yes — it is the outstanding-payments report |
| **2** | **The provider reconciler** (§5.2), read-only | no | yes — resolves the burned-identifier question |
| **3** | Claim table + replybot writes claims at crossing | no | records obligations going forward |
| **4** | The payment sub-bot (§6), new forms only, `await: true` compatibility | no | payment UX stops being form-authored |
| **5** | The settler (§5.3) with caps and kill switch | **yes** | closes the loop |
| **6** | Retire: dean's `Payments` re-drive, the withheld/delivered distinction, `states.payment_error_code`, bail-as-payment-recovery | no | removes five layers |

Phases 1 and 2 are independently valuable, involve no schema commitment, and are
the work that would have made the Girl Effect recovery a report instead of a
fortnight.

### 8.1 The falsification step

**Run the Phase 1 auditor over the Girl Effect data and check whether it
independently reproduces the split we established by hand: 129 endline-bail
users paid 150 and owed 75, 30 baseline-bail users owed 75, 6 confirmed
number-sharers, 2 genuine failures.**

If it does, the derivation is trustworthy and the rest is engineering. If it does
not, we have learned the contract is not derivable for about a week of work
rather than a quarter's — and the answer is probably to fix VIR-72, write the
operator script, and stop here.

Do not commit to the schema in §4 before this passes.

---

## 9. Open questions

1. **Does the survey stall acceptably?** Control returns only on completion, so
   a wallet-empty claim holds the respondent for as long as it takes. Less
   harmful than today's silent parking — they have been told, the loop keeps
   trying, an operator can resolve the claim — but it is a product decision that
   should be made explicitly, not inherited.
2. **Per-survey message copy** (§6.9) — four strings per survey per language,
   plus template approval. Small, but it needs an owner and a default.
3. **`destination` storage** (§7.2).
4. **Does the auditor fold cost what we think?** Re-folding every respondent's
   event log is the same shape as the Phase 1.5 backfill
   (`planning/backfill-in-cluster-job.md`, 106,931,189 rows). Bound it before
   building it.
5. **Currency and FX.** `requested_amount` vs `delivered_amount` are captured,
   but nothing here reconciles wallet balances. Deliberately out of scope: this
   is a record of what we told providers to do and what they said, not an
   accounting system.
