# External Service Events: a taxonomy for success, failure, and state

> Brainstorm / design options. **Nothing here is decided.** Written after the
> 2026-08-17 dinersclub incident exposed that we have no consistent contract for
> how an external service reports what happened to it.
>
> Scope is deliberately wider than payments: `dinersclub` (3 payment providers),
> `linksniffer`, `moviehouse`, and anything added later all use the same
> mechanism and all have the same gap.

---

## 1. What exists today

### The mechanism

An external service POSTs a result to botserver `/synthetic`. Replybot's
`_handleExternalEvent` appends it to `state.externalEvents`, then asks
`waitConditionFulfilled` whether the respondent can move on.

Five external wait types are live in production:

| wait `value.type` | states waiting | service |
|---|---|---|
| `payment:http` | 866 | dinersclub |
| `payment:reloadly` | 552 | dinersclub |
| `moviehouse:play` | 455 | moviehouse |
| `payment:giftcard` | 217 | dinersclub |
| `linksniffer:click` | 112 | linksniffer |

### The matching rule, and why it is the crux

`waitConditionFulfilled` (`waiting.js:106`) is:

```js
relevant.some(e => _matches(e.value, wait.value))
```

`_matches` is a **subset check** (`_contains`): every key in the wait condition
must equal the same key on the event. The wait for a payment is

```json
{"type": "payment:reloadly", "id": "PAYMENT_ID"}
```

and a *failure* Result carries exactly that `type` and that `id`. Both keys
match. `success` is not part of the wait condition, so it is never compared.

**Therefore: any result fulfils the wait. Success and failure are
indistinguishable to the state machine.** The form is released either way and
branches afterwards on `e_payment_<provider>_success`.

Three consequences worth stating plainly:

1. **An external service cannot choose to keep someone waiting by reporting a
   failure.** The only way to keep a respondent parked is to send *nothing* --
   which is what the incident did, by crashing.
2. **A "disposition" in the service that claims to control state is fiction.**
   Any design where dinersclub decides "wait" vs "release" is really deciding
   "send / don't send", and the send always releases.
3. **`ERROR` is unreachable from an external event.** `ERROR` is produced only
   by `MACHINE_REPORT` (`machine.js:334`). No external event can move a
   respondent there today.

### What reaches the form

`_eventMetadata` flattens every key of the result into `md` as
`e_<type>_<key>`, recursively, snake-cased. So for a payment the form can read:

| documented in `questions.md` | actually present in `md` |
|---|---|
| `e_payment_reloadly_success` | ✅ |
| `e_payment_reloadly_error_message` | ✅ |
| `e_payment_reloadly_id` | ✅ |
| — | `e_payment_reloadly_error_code` ← **exists, undocumented** |

The error *code* is already in state (it is how the production census in
`planning/payment-failure-handling.md` was taken). It is simply not a documented
contract, so no survey uses it. **The form can branch on "did it work" but not
on "what kind of failure was it".**

### What dean expects

| state | dean query | emits | replybot handler | effect |
|---|---|---|---|---|
| `WAIT_EXTERNAL_EVENT` | `Payments` | `repeat_payment` | `MAKE_PAYMENT` | **re-runs the payment** |
| `ERROR` | `Errored` | `redo` | `RESPOND_AGAIN` | **re-sends the last message** |

This matters more than it looks. Moving a failed payment to `ERROR` would be
wrong twice over: `redo` never retries the payment, and `Errored` gates on
`error_tag = ANY('NETWORK','INTERNAL','STATE_ACTIONS')`, which a payment failure
does not carry -- so it would never fire at all. The `ERROR` transition also
clears `wait`/`waitStart`, destroying what `Payments` selects on.

**`WAIT_EXTERNAL_EVENT` + dean's `Payments` is already the correct machinery for
a retryable payment failure.** Any redesign has to keep that, or replace both
halves together.

---

## 2. The actual problem

We have no vocabulary. Every external service invents its own result shape, and
the state machine understands exactly one thing about any of them: *an event
arrived that structurally matches the wait*.

That forces every real distinction into one of two bad places:

- **Into the service** — which then has to encode assumptions about respondent
  handling, alert audiences, and state transitions it cannot see. (Both previous
  attempts in `planning/payment-failure-handling.md` did this and had to be
  unwound.)
- **Into the form** — which has only free-text English and a boolean.

What is missing is a **shared, small, service-agnostic vocabulary** that an
external service emits as fact, and that the state machine, dean, the form, and
study-health each interpret in their own terms.

### Design constraints any answer must satisfy

1. **Services report facts, not decisions.** "The operator refused this number"
   is a fact dinersclub owns. "Therefore park them / tell them / alert the
   researcher" is not.
2. **The state machine owns state.** Only replybot decides where a respondent
   goes.
3. **study-health owns audience.** Who gets told is a mapping over recorded
   facts, changed without redeploying any service.
4. **Backwards compatible.** 2202 respondents are parked on external waits right
   now, and live surveys read `e_*_success` / `e_*_error_message`.
5. **Uniform across services.** Whatever we choose must fit linksniffer and
   moviehouse, not just payments.

---

## 3. Design options

### Option A — Outcome vocabulary on the event (recommended starting point)

Every external service reports a small closed `outcome` alongside its
service-specific payload:

| `outcome` | Meaning | Example |
|---|---|---|
| `success` | it happened | topup delivered; link clicked |
| `pending` | accepted, not finished | async provider still processing |
| `retryable` | failed, same request may work later | provider 5xx, operator down |
| `blocked` | failed, needs a human to change something | empty wallet, dead credentials |
| `invalid` | failed, will never work as asked | bad number, impossible amount |

Each consumer reads the same field in its own terms:

- **replybot:** `success`/`invalid` fulfil the wait; `retryable`/`blocked`/`pending` do not.
- **dean:** keeps re-driving anything still parked (unchanged).
- **the form:** branches on `e_<type>_outcome` -- a documented, closed set.
- **study-health:** maps `(outcome, code, form)` to an audience.

Requires the wait condition to carry `outcome` so matching can discriminate, e.g.
`{"type": "payment:reloadly", "id": "X", "outcome": "success"}` -- which the
existing `_contains` subset check supports **without any change to
`waiting.js`**. Old waits without the key keep matching everything, so existing
respondents are unaffected.

**Pro:** small, uniform, no matcher change, additive to the state.
**Con:** a new contract every service must adopt; `pending` needs care so a
respondent is not parked forever awaiting a terminal event that never comes.

### Option B — Keep the boolean, document the code

Do nothing structural. Promote `e_<type>_error_code` to a documented contract and
let forms branch on provider codes directly.

**Pro:** zero code change; the data is already there.
**Con:** pushes provider-specific vocabulary into every survey. A form author
must know what `PHONE_RECENTLY_RECHARGED` means, and adding a provider means
re-teaching every survey. Does not help linksniffer/moviehouse at all.

### Option C — Wait conditions gain predicates

Extend the wait grammar so a survey expresses what it is waiting for:
`{"type": "payment:reloadly", "id": "X", "where": {"success": true}}`.

**Pro:** maximum expressiveness; the survey decides.
**Con:** changes `waiting.js` matching, which every parked respondent depends on;
pushes the decision onto survey authors, who are the least equipped to reason
about provider failure modes. Probably a later refinement of A, not an
alternative.

### Option D — Make `ERROR` reachable from external events

Add an external-event path into `ERROR` with a payment-specific `error_tag`.

**Pro:** reuses an existing state, dean query, and study-health metric
(`survey_error_states{error_tag}`).
**Con:** `ERROR` means "the bot broke", not "the payment failed"; `redo` re-sends
a message rather than retrying the payment; needs a new tag in
`DEAN_ERROR_TAGS`, and the `FIELD_NOT_FOUND` note in `production.yaml` is a
standing warning about how that goes wrong. **Only worth it if we conclude
parked-forever is worse than a wrong-shaped state**, which §1 suggests it is not.

---

## 4. Open questions

1. **Is `pending` real?** DingConnect is instant-mode only, but an async
   provider would need it. Adding it later is harder than reserving it now.
2. **Who owns the outcome mapping for a provider?** Presumably the service (it
   is provider knowledge), but the *table* could live in config so it changes
   without a release.
3. **What releases an `invalid`?** If the form has no branch for it, releasing
   the respondent shows a generic failure message about something they cannot
   fix. Silence may genuinely be better until forms opt in.
4. **Does `outcome` belong in the wait condition or beside it?** Putting it in
   the wait makes matching discriminate for free, but couples survey JSON to the
   vocabulary.
5. **Migration.** Do services emit `outcome` alongside the current fields
   indefinitely, or is there a cutover?

---

## 5. Relationship to the payments work

`planning/payment-failure-handling.md` phase 1 assumed dinersclub could decide
"wait" vs "release". §1 shows it cannot. **That plan should not be implemented
until this taxonomy is settled** -- otherwise phase 1 hard-codes a distinction
the state machine does not honour.

What survives from it unchanged:

- the production error-code census (33 codes, 22802 failures);
- the retry/timeout budget work (dinersclub's own loop, unaffected by any of this);
- the finding that `formatError` turns any `APIError` into a respondent-facing
  failure, which is a bug under every option here;
- the layering rule -- dinersclub absorbs a blip, dean owns the long game.
