# Payments as a sub-bot — Plan

> Origin: VIR-73, which began as "find something lighter than a bail for payment
> problems" and became a question about what a payment *is*. The immediate
> prompt was the Girl Effect incident (VIR-55/56/68/72): 463 respondents bailed,
> 161 told their number was already used, 129 of them paid 150 and then shown an
> "ineligible" screen, and a recovery that ran on hand-assembled CSVs.
>
> **Status: proposed. Nothing here is built.** Depends on the sub-bot
> framework (`planning/sub-bots.md`, VIR-77), which is built first. This is its
> first consumer.
>
> **Related:** `planning/sub-bots.md` (the delegation primitive — read it
> first), `documentation/payment-recovery.md` (the system as it is today),
> `dinersclub/README.md`, `documentation/phone-numbers.md`,
> `documentation/bail-systems.md`, `planning/payment-failure-handling.md` (the
> 2026-08-20 decision this builds on), `planning/payment-provider-landscape.md`.

---

## 1. The decision

**The survey declares a promise. dinersclub keeps it.**

Four things, each with one job:

| thing | job | owned by | changes? |
|---|---|---|---|
| **claim** | the promise: *this person is owed 150 KES of airtime* | the survey, at crossing | never |
| **resolver** | how this researcher keeps promises: which wallets, in what order, and what to say while doing it | the researcher, in the dashboard | live |
| **transaction** | one thing that happened to a claim: a provider call and its outcome, a manual payment, a write-off | dinersclub | append-only |
| **the loop** | *while the claim is not filled: get a viable method or execute one* | dinersclub | — |

dinersclub becomes the payment sub-bot (`sub-bots.md`). It gains a second entry
point, state, and the ability to speak. Nothing else about it changes, and its
existing path stays untouched until it is retired (§4).

There is no separate settler: the loop is what pays. There is no auditor
re-deriving obligations from history: the promise is written into the event log
at delegation, and the survey cannot advance past it until it is kept.

### 1.1 What "complete" means

**A payment is complete when the provider says it is.** Not when the money
reaches the handset — we have no way to observe that, for any provider.

- The terminal state is *filled*, not *paid* or *delivered*. A researcher
  reading a column called `paid` will draw a conclusion we cannot support.
- **Provider reconciliation is the whole of reconciliation.** No respondent
  confirmation loop.
- `unknown` survives as a transaction outcome, but shrinks to one honest case:
  we issued a request and never got an answer. It is always resolved by asking
  the provider, never the respondent.

### 1.2 What we deliberately rejected

| rejected | why |
|---|---|
| A read-only auditor re-deriving obligations by folding `messages` | It hedged a design in which the record could be silently lost. Under delegation the promise is in the log (the `open` event carries it) and the parent cannot advance past it, so a lost claim is a `DELEGATED` state with no claim row — a join, not a 107M-row fold. |
| A separate settler process | The loop already attempts, backs off and records. A second process doing the same against the same rows is a double-pay waiting to happen. |
| Routing dinersclub's Result back through replybot as an `event` | dinersclub deliberately withholds some Results because today a Result releases the wait; making it always emit would regress every `await: true` form during migration. Inside one process the outcome is a return value and there is no delivery step at all. |
| The method (provider, SKU, number) as part of the claim | The promise is frozen at crossing; the method must be live so that fixing a wallet heals in-flight claims. Mixing them is why a withheld `PIN_DRIFT` cannot be healed today (`payment-recovery.md` §8). |
| A mutable `status` column on the claim | `states.payment_error_code` is wrong today precisely because it is a mutable column a later event forgot to clear (VIR-72). Status is a projection over transactions and cannot drift. |
| Country as the resolver's routing key | The payment block names its resolver explicitly, and the validator rejects a block that names one the owner does not have. Nothing is inferred, so nothing is unmapped. |
| The sub-bot re-taking control later (interrupts) | Safe-point queueing, concurrent-frame rules, out-of-window templates for every re-contact. If the respondent has gone quiet we do not chase them; the claim stays open for a human. |
| Fabricating success Results to mark someone paid | An operator act must be structurally distinguishable from a real disbursement. It is a transaction with `actor: operator` and a reason. |
| A human queue behind the sub-bot's chat | "Someone will get back to you" is an SLA that does not exist. The sub-bot deflects honestly; escalation is a list on a dashboard. |
| The payment handler living inside the machine | It needs wall-clock, timers, retries and IO, none of which may happen inside a pure fold (`sub-bots.md` §2.6). |

---

## 2. Why — the evidence

The case is not that payments are broken. It is that **five layers each solve a
slice of the problem and none of them can state the problem.**

- `dinersclub/db.go` opens a database pool **solely to read `credentials`. It
  never writes.** What `payment-recovery.md` §3 calls "the ledger" is a
  Prometheus counter with no `userid`, no survey, and finite retention.
- **Withheld failures are recorded nowhere.** `INSUFFICIENT_BALANCE` alone is
  34% of recorded payment failures (8,521 of 22,802 in the production census).
- **`states.payment_error_code`** is hardcoded to `e_payment_reloadly_*`, so it
  is blind to every other provider; it reflects only the latest state; and it
  is not cleared by a later success (VIR-72).
- **Nothing records money spent per respondent.** User `8563270007096163` was
  paid 1,424 times over 1.5 years
  (`planning/dean-payments-timeouts-retry-caps.md`). We found it by counting
  `retries` in a state blob.
- **Payment error UX is form-authored.** Forms branch on `e_payment_*` md keys,
  so every researcher re-implements failure handling in Typeform YAML,
  differently. `girleffectincentive` still carried the old logic a day after
  two sibling forms were corrected.
- **The method is frozen in the form.** A corrected pin is a new form version
  that only new respondents get; the recovery for everyone else is a bail.
  Provider fallback (VIR-62, VIR-54) and operator-aware routing (VIR-38) have
  nowhere to live.

---

## 3. What the code constrains

### 3.1 A payment point writes no `responses` row

`_handleExternalEvent` (`replybot/lib/typewheels/machine.js`) returns
`response: null`; `update()` (`machine.js:961`) emits a response row only when
`responseValue` is present. Today, crossing a payment point leaves no durable
record anywhere unless a Result comes back — and a withheld failure sends none.
**So the claim must be its own record**, written by dinersclub on `open`.

### 3.2 The amount is interpolated per respondent

`interpolateField` (`replybot/lib/typewheels/form.js:176`) walks every key of a
field, so a payment block's `amount` and `number` may be templated against that
respondent's answers. **So the promise is computed by the machine at
delegation**, with that respondent's `qa` in hand, and travels in `open`. It
lands in the event log as a fact (`sub-bots.md` §2.6); dinersclub never
recomputes it.

### 3.3 The seams

- A `PaymentEvent` on `vlab-payment` is plain JSON; `details` *is* the provider
  settings. This is the old entry point and it does not change.
- dinersclub's Result goes to hermes `/synthetic` as a user event and any Result
  fulfils a payment wait. This is the old delivery path and it does not change.
- Phone numbers are parsed by `replybot/lib/phone.js` against a declared
  country; what goes to the provider is E.164 (`documentation/phone-numbers.md`).
  The sub-bot must use the same parser or it accepts numbers it cannot pay.
- Out-of-window sends require a pre-approved template — `sub-bots.md` §4.3.

---

## 4. dinersclub is the payment sub-bot

Same binary, two entry points:

| entry point | consumes | delivery | state | until |
|---|---|---|---|---|
| **old** — `vlab-payment` | `PaymentEvent` from replybot's `publishPayment` | withholding, in-process `backoff.Retry`, POST Result to `/synthetic` | none | retired in phase 5 |
| **new** — `vlab-<env>-delegations` | `open` / `event` for `service: payment` | none: the outcome is a return value written to a transaction row | claims + transactions | — |

Everything worth keeping is reused in place: the providers, `classify.go`, the
credentials read, the timeout budget, the metrics, burrow.

**The Kafka handler records; it never acts.** `open` → insert the claim,
return. A message `event` → parse the number, insert a `destination`
transaction, return. A separate scheduler goroutine walks open claims by
`next_at`, calls the provider, writes the transaction, decides. Nothing with a
backoff or a wait runs on the consumer thread, or `max.poll.interval` evicts it
— the 2026-08-17 shape. This is also "the claim row is the state" enforced by
process shape: a restart loses nothing because nothing was in flight in RAM
that was not already a row.

**No in-process retry on the new path.** A `transient` outcome schedules the
next attempt through the claim, and every attempt mints its own identifier
(§5.2) — which is the fix for the retry-burns-the-identifier bug in
`payment-recovery.md` §8, falling out rather than being a ticket.

**It speaks** by POSTing `say` and `release` to hermes `/synthetic`, stamped
with the delegation id, on the pattern of the existing botserver client and its
retry budget. It never writes to the commands topic.

---

## 5. The state: facts are stored, everything else is projected

Two tables. Same rule the platform already lives by — `messages` is truth,
`states` is a fold — applied to money.

### 5.1 `payment_claims` — the promise. Immutable.

```
id              UUID PK
userid, account_id, platform          -- the conversation
owner_id        UUID NOT NULL         -- researcher (credentials.userid)
survey_name     VARCHAR NOT NULL      -- the study, not the version
question_ref    VARCHAR NOT NULL      -- the payment field
surveyid        UUID                  -- the version, for audit only
amount          DECIMAL NOT NULL
currency        VARCHAR NOT NULL
kind            VARCHAR NOT NULL      -- airtime | mobile_money | giftcard
resolver        VARCHAR NOT NULL      -- name, under owner_id
country         VARCHAR               -- parsing context, from the block
lang            VARCHAR               -- which strings, from the block
number_hint     VARCHAR               -- from the block, if it gave one
pins            JSONB                 -- provider/sku narrowing, if the block gave one
delegation_id   VARCHAR NOT NULL      -- the delegation that opened it (latest)
opened_at       TIMESTAMPTZ NOT NULL
UNIQUE (userid, survey_name, question_ref)
```

`kind` is part of the promise. Airtime and mobile money are both KES and are
not fungible to the person receiving them; a researcher who promised airtime
cannot later switch because M-Pesa is cheaper. Putting `kind` on the claim is
what enforces that.

**Claim identity is `(userid, survey_name, question_ref)`** — deliberately not
the version, the form instance or the delegation. Bailing someone into a
corrected form reopens the same claim (`delegation_id` is the one field that
updates); baseline and endline are two claims. Get this wrong and the system
either double-pays on every re-bail or silently merges two genuine debts.

### 5.2 `payment_transactions` — what happened. Append-only.

```
claim_id        UUID NOT NULL REFERENCES payment_claims
seq             INT NOT NULL
kind            VARCHAR NOT NULL      -- attempt | manual | write_off | destination | said | released
actor           VARCHAR NOT NULL      -- subbot | operator | reconciler | respondent
method          JSONB                 -- {wallet, provider, number, operator, amount} for attempt/manual
custom_identifier VARCHAR             -- <claim_id>-<seq>
outcome         VARCHAR               -- accepted | declined | unknown
code            VARCHAR               -- provider error code, verbatim
class           VARCHAR               -- transient | precondition | respondent | permanent
delivered       DECIMAL               -- what counts toward the promise
provider_ref    VARCHAR
reason          VARCHAR               -- for operator rows
raw             JSONB
at              TIMESTAMPTZ NOT NULL
UNIQUE (claim_id, seq)
```

- **Failed attempts are facts too.** They never touch `filled`, but they are
  what `next_action` reads: whether to ask for a number (`respondent`), back off
  (`transient`), escalate (count), or say "taking longer" (elapsed since the
  first attempt). Store only successes and the loop's memory lives in RAM —
  which is exactly today's gap.
- **Operator acts are rows.** A payment by hand is `manual` with a `delivered`
  amount; a waiver is `write_off` for the remainder. Both reduce `remaining` the
  same way and both are visibly not a provider transaction. That is the whole
  of VIR-73's original "lighter than a bail" ask.
- **The reconciler is an actor.** A provider report showing an `unknown`
  attempt went through is a `manual`-shaped row with `actor: reconciler`
  referencing the attempt in `raw`. It never edits the attempt.
- **A new number is a row** (`destination`, `actor: respondent`); the next
  attempt uses it.
- **Two non-money facts.** `said` (which message kinds have gone out, so
  "taking longer" is sent once) and `released` (so the loop stops scanning a
  filled claim). They carry no amount.
- **The identifier is `<claim_id>-<seq>` from the first attempt.** A genuinely
  repeated request still dedupes at the provider, and a burned identifier
  (Reloadly consumes one on a decline — VIR-68) never blocks the next attempt.
  No "once burned" special case.

### 5.3 Projections — pure functions, never stored

| projection | is |
|---|---|
| `remaining` | `claim.amount − Σ delivered` |
| `filled` | `remaining == 0` (`< 0` is over-disbursement, which the Girl Effect 150-against-75 case needed and nothing today can compute) |
| `number` | latest `destination` row, else `claim.number_hint`, else none |
| `methods` | `resolve(claim, number, wallets, resolver)` — §6.3 |
| `next_action` | `f(remaining, methods, last attempt's class and time, attempt count, said)` → attempt / ask for a number / say / escalate / release |
| `status` | for the dashboard only: `filled`, `owed`, `needs_number`, `waiting_on_wallet`, `needs_attention`, `waived` |

All of the old state diagram is this one function. It is tested with fixtures
and the scheduler re-projects before every attempt; nothing reads a cached
status for a money decision. Open claims are thousands, not millions, so the
scheduler's scan is a join over `remaining > 0`, not a materialized column.

### 5.4 The shell

```
consumer  (vlab-<env>-delegations, service: payment)
  open   → insert claim (or update delegation_id on the existing one)
  event  → participant message: parse with phone.js against claim.country;
           a number → insert destination; anything else → deflect (§7.3)
           closed: nothing — the loop notices via fencing

scheduler (own goroutine, off the consumer thread)
  for claim in open where next_at <= now:
     a = next_action(claim, transactions)
     execute a; insert the resulting row(s)
```

---

## 6. Wallets and resolvers

Two things the researcher owns, neither of which is in the form.

### 6.1 A wallet is a connected, funded provider account

It already exists as a `credentials` row — the thing `dinersclub/db.go` reads —
it just isn't surfaced as a concept. `(owner, provider, credentials, label,
enabled)`, with **capabilities** (which numbers it can reach, in what
denominations — asked of the provider live via `FindOperator`,
`AccountLookup`, `GetProducts`, never stored) and **health** (balance where the
API gives one; otherwise the last `INSUFFICIENT_BALANCE`).

A wallet is referenced by resolvers; it holds the credentials, they don't.

### 6.2 A resolver is how a researcher keeps promises

```
resolver
  owner
  name                                        -- what the payment block names
  wallets:   [ {wallet, pins?}, … ]           -- in order
  messages:  { <lang>: { sending, sent, bad_number, taking_longer,
                         not_a_number, cant_answer } }
  templates: { <lang>: { … } }                -- approved out-of-window templates
```

Set up once in the dashboard / MCP, named in every form that uses it. Most
researchers make one per country and never think about it again; the name
exists so the second Kenyan study with the other donor's wallet can name a
different one, and so one resolver can serve a whole multi-country study.

**Routing is one lookup, `(owner, form.resolver)`, and nothing is inferred.**
`create_survey` / `create_survey_version` reject a payment block whose
`resolver` does not exist under the owner, exactly as they reject a malformed
block. There is no default, no tiebreak, and no such thing as an unmapped
study.

**Copy falls back per language.** The platform ships default strings for each
language it supports; a resolver made with wallets only still speaks sensibly.

### 6.3 The promise is frozen; the method is live

The claim never changes. But `resolve()` runs **at attempt time, against the
resolver as it is now** — not the form as it was when the respondent started.

That inverts the failure `payment-recovery.md` §8 records as by-design.
Correcting a wallet's pin, adding a second wallet during a Safaricom outage
(VIR-33), switching rail for a country where the first one cannot pay
(VIR-62's Bolivians, VIR-54's Tigo): each heals **every in-flight claim on the
next tick**, with no form version and no bail. Configuration heals claims.

```
resolve(claim, number, wallets, resolver) → [method, …]
```

Pure over its inputs; the provider capability queries are its IO edge and
dinersclub already makes all three. v1 is trivial: honour `pins`; otherwise
each of the resolver's wallets in order that the provider says can reach this
number for this `kind`; skip wallets known empty. Fallback, operator routing
and denomination splitting are all just this list being longer than one.

**Wallet health is what "waiting on a precondition" now means**: *no* wallet
can keep the promise, not *this* one can't. And the alert can finally name the
researcher — `PaymentWalletEmpty` carries only `provider` today (§8's last
gap); a wallet is owned.

### 6.4 Country

Not declared on the resolver and not a routing key. It matters in exactly the
places it already does:

- **Parsing.** The payment block declares `country`; `open` carries it; the
  sub-bot parses any number it asks for against it with `phone.js`. Without it
  only international numbers resolve, which is a bad experience for someone
  who typed `0712…`.
- **Deliverability.** The promise is in a currency; the number is in a
  country; whether one reaches the other is a live question to the provider.
  150 KES to a `+234` number is not a method — `respondent`-class, ask for a
  number in the study's country, cap, escalate. The promise never bends to fit
  the number.
- **Operator and denominations.** Derived per number, recorded on the
  transaction's method, declared by nobody.

---

## 7. The form contract, and the loop

### 7.1 The payment block

```yaml
type: payment
amount: 150                     # interpolable
currency: KES
kind: airtime
resolver: kenya
country: KE                     # parsing context for any number we ask for
lang: sw                        # which strings
number: '{{field:pay_phone}}'   # optional hint; absent or bad → the sub-bot asks
provider: dingconnect           # optional pin, narrows the resolver
sku: …                          # optional pin
```

`open` is this block after interpolation, plus the conversation identity.
**Today's blocks are the fully-pinned end of the dial**, so migration is
mechanical; an existing block keeps today's semantics behind an explicit
`await: true` until migrated. Ideally a new-style survey never asks for a
phone number at all.

### 7.2 The loop is `classify.go`'s three classes

| class | the loop | the mouth |
|---|---|---|
| `transient` | back off, retry | silence |
| `precondition`, or an `unknown` that persists | try the next wallet; if none, wait | **"taking longer than expected"**, once |
| `respondent` | pause | **ask for another number** — the only question it ever has |
| cap reached | stop; `needs_attention` | silence |
| `accepted`, `filled` | `release` | **"sent"** |

`precondition` is already defined as *"a human off-stage must act first, and
the respondent has no part in it"* — the definition of "taking longer". The
condition that sends that message is the condition that fires
`PaymentWalletEmpty`: the respondent is told when the researcher is paged.

`classify.go` files four different things under it, and the loop's one
response — next wallet, else wait on cadence, cap → `needs_attention` — is
right for all four, but for different reasons:

| what is wrong | codes | who fixes it |
|---|---|---|
| the wallet | `INSUFFICIENT_BALANCE`, `AUTH_ERROR`, `MISSING_SECRET` — nearly all of the 34% | the researcher funds or re-authorises; the loop resumes on the next tick |
| the method | `IMPOSSIBLE_AMOUNT`, `INVALID_AMOUNT_*`, `INVALID_SKU_CODE`, `PIN_DRIFT`, `NO_PIN_FOR_OPERATOR`, malformed block | mostly eliminated — `resolve()` asks the provider for denominations rather than pinning; the rest is a resolver edit, applied live |
| nobody knows | `UNMAPPED_PROVIDER_ERROR_CODE`, `PAYMENT_FAILED`, `INVALID_RESPONSE` | an engineer classifies the code; until then, the cap escalates it |
| misfiled transient | `RateLimited` | parked here only to avoid re-entering `backoff.Retry`; with no in-process retry on the new path it is `transient` again |

**Cadence and cap: dean's.** 2h grace, then every 6h, 30 attempts over 14
days. At the cap the claim becomes `needs_attention` and **still holds** —
there is no automatic `release`. The ceiling is a human: fix the wallet and
the loop resumes, or `write_off` and the survey continues.

**A control loop with a mouth, and the loop has to work with the mouth turned
off.** The test for any feature: *does the loop still terminate correctly if
this message is never delivered and never answered?* If not, it belongs in the
loop, not the chat.

### 7.3 What it says

Six strings per language, from the resolver. **Announce outcomes, not
attempts**: `sending` is timer-gated (only if not resolved within N seconds);
`taking_longer` is sent at most once per claim, gated on elapsed time, never on
the first failure. Emission is a `said` row, so a restart does not repeat.

Everything that is not a number is deflected, in two distinct ways —
collapsing them tells someone who fat-fingered a digit that we are refusing to
talk to them: `not_a_number` for a bad answer to our question, `cant_answer`
for anything else, which when we are not asking anything doubles as a status
("your payment is still on its way"). Cap the deflections; after a few, go
quiet and stay delegated. Silence is legitimate. An SLA is not.

### 7.4 "I didn't get it" is a signal, not a trigger

Delivery is unobservable (§1.1), but a participant saying so is the only
delivery signal anywhere in the system. It must **not** drive payment — an
obvious exploit. Record it against the claim and count it: a cluster against
one operator while the provider reports success is evidence the provider is
lying, and because it is aggregate no individual claim has to be believed.

### 7.5 What it must never do

Decide eligibility, amount or kind (the promise is the survey's), branch on
survey logic, hold the participant when it has nothing to ask, pay without a
claim, or pay a filled claim.

### 7.6 How it ends

The delegation ends when the claim is `filled` — by provider, by `manual`, or
by `write_off`. Escalation is **not** terminal: the participant is owed money,
the delegation holds, and a human resolving the claim is what releases it.
`write_off` is the necessary escape hatch — "we cannot pay this person, let
them continue" — recorded as a decision with a name on it, not as a bail.

Completion can land days later; the parent's next question is then an
out-of-window send through the resolver's approved template (`sub-bots.md`
§4.3).

---

## 8. The provider reconciler

Pull the provider's transaction report, match on `custom_identifier`, append
what we did not know: an `unknown` that went through, a transaction we have no
row for. Read-only against the provider; append-only against our data. It
would also settle empirically which of the 2,385
`CUSTOM_IDENTIFIER_ALREADY_USED` respondents actually received money.

---

## 9. Risks

- **Phone numbers on transactions** (`method.number`). A table of number +
  amount + outcome is a more attractive target than anything we keep today.
  Decide before the migration whether it is stored in the clear, hashed with a
  retained suffix, or by reference (`documentation/phone-numbers.md`).
- **A second source of truth.** Today the platform has one: the conversation.
  **This design says that for money, the conversation is not the record.** The
  claim table outlives the state machine — the first domain object here that
  does. Defensible because the money is a promise to a person and the
  conversation demonstrably fails to record it; not a precedent to apply
  casually.
- **Money safety.** Per-form opt-in. Caps per run, per survey, per wallet that
  escalate to `needs_attention` rather than proceed. A kill switch. Owner
  scoping through `credentials` exactly as exodus does it after VIR-60. The
  scheduler refuses a claim whose `remaining <= 0`.
- **Migration overlap.** A form is on exactly one path — the sub-bot, or
  `await: true` + dean's `Payments` — never both, or the overlap double-pays.

---

## 10. Phases

| phase | what | spends money |
|---|---|---|
| **0** | The sub-bot framework — VIR-77 | no |
| **1** | Wallets surfaced and resolvers created in the dashboard / MCP; the payment-block validator | no |
| **2** | `payment_claims`, `payment_transactions`; the `delegations` entry point in dinersclub; the scheduler, `resolve()`, the mouth; caps and kill switch; forms opt in | **yes**, for opted-in forms |
| **3** | Operator rows (`manual`, `write_off`) and the `needs_attention` list on the dashboard | no |
| **4** | The provider reconciler (§8) | no |
| **5** | Migrate existing forms off `await: true`; retire the `vlab-payment` entry point, withholding, dean's `Payments`, the `e_payment_*` branches, `states.payment_error_code`, bail-as-payment-recovery | no |

Phase 1 ships value alone: a researcher can see and manage their wallets
before any of this pays anyone. Nothing is backfilled; claims exist from the
moment a form opts in. Historical obligations — Girl Effect included — stay a
one-off, already handled by hand.

---

## 11. Open

Decided 2026-09-23: the cadence and cap are dean's (§7.2), and a claim holds
the survey until a human resolves it — there is no automatic `release` for the
form to branch on.

1. **The `kind` vocabulary** — `airtime | mobile_money | giftcard` to start;
   what else the providers actually distinguish.
2. **Where transactions store the number** (§9).
3. **Currency and FX.** Wallets are funded in one currency and deliver in
   another; nothing here reconciles balances. Deliberately out of scope: this
   is a record of what we promised and what providers said, not an accounting
   system.
