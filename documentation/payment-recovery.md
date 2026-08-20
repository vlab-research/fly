# Payment failure and recovery

> What happens across the platform when a payment does not go through: who
> retries, who is told, and how a respondent who was never told still gets paid.
>
> **Components:** `dinersclub` (executes payments), `replybot` (owns respondent
> state), `dean` (re-drives stalled respondents), the survey form (talks to the
> respondent), `devops/alerts` (tells a human).
>
> **Related:** `dinersclub/README.md` (the service),
> `documentation/alerting.md` §12 (runbooks),
> `planning/payment-failure-handling.md` (the decision and its reasoning),
> `planning/external-event-taxonomy.md` (the contract this anticipates).

---

## 1. The shape of the system

A survey reaches a payment question. replybot emits a payment event to Kafka and
parks the respondent in `WAIT_EXTERNAL_EVENT` with a wait condition:

```json
{"type": "payment:reloadly", "id": "PAYMENT_ID"}
```

dinersclub consumes the event, calls the provider, and POSTs a `Result` back to
botserver, which replybot appends to `state.externalEvents`. The respondent
moves on.

### The one rule that determines everything else

`waitConditionFulfilled` (`replybot/lib/typewheels/waiting.js:106`) matches a
wait against an event with a **subset check** over the wait's keys. The wait
carries `type` and `id`. A *failure* `Result` carries exactly that `type` and
that `id`. `success` is not part of the wait condition, so it is never compared.

**Any Result fulfils the wait. Sending and releasing are the same act.**

Three consequences that shape every design decision below:

1. A service **cannot** keep a respondent waiting by reporting a failure. The
   only way to keep someone parked is to send nothing.
2. Any notion inside a service of "decide whether the respondent waits" is
   fiction; it is really deciding "send / don't send", and the send always
   releases.
3. `ERROR` is unreachable from an external event — it is produced only by
   `MACHINE_REPORT` — so a failed payment cannot be routed there.

## 2. The three layers, and who owns what

| Layer | Mechanism | Horizon | Owns |
|---|---|---|---|
| **dinersclub** | `backoff.Retry` in-process | ~60s | absorbing a single-request blip |
| **dean** | `Payments` re-triggers anyone still in `WAIT_EXTERNAL_EVENT` | 2h grace → every 6h → 14 days, 30 attempts | outages, empty wallets, everything long |
| **the form** | branches on `e_payment_<provider>_success` / `_error_message` | immediate | telling the respondent |

**The rule: push each failure to the shortest layer that can outlast it.**
dinersclub executes fast and keeps the line moving; dean owns persistence; the
respondent is involved only when they hold information nobody else does.

**At-least-once is deliberate.** Better to pay someone twice than not at all:
they completed the survey, and a duplicate topup is a cost overrun while a
missed payment is a broken promise. Duplicate suppression is a platform-side
concern (Reloadly dedupes on `custom_identifier`), not something dinersclub
should buy at the price of dropped payments.

## 3. Recovery classes

dinersclub classifies every provider error code into one of three classes
(`dinersclub/classify.go`). The class is a fact about the failure: it does not
encode who retries, who is alerted, or what state the respondent ends up in.

| class | meaning | dinersclub sends | respondent | recovery |
|---|---|---|---|---|
| `transient` | the same call, later, may just work | **nothing** | stays parked | retried in-process, then dean |
| `precondition` | a human off-stage must act first | **nothing** | stays parked | researcher tops up / re-authorises, dean's next sweep pays everyone waiting |
| `permanent` | never going to work as configured | **the failure Result** | released to the form | none; the form tells them |

Examples: a provider 5xx is `transient`; `INSUFFICIENT_BALANCE` and
`AUTH_ERROR` are `precondition`; a bad number, `IMPOSSIBLE_AMOUNT` and an
operator refusal are `permanent`.

**An unrecognised code is `permanent`**, i.e. it is sent, i.e. it behaves
exactly as every failure behaved before classification existed. Silence is the
new behaviour and applies only where we can name the reason. The code is counted
by `dinersclub_unclassified_error_codes_total` and
`PaymentUnclassifiedErrorCode` asks someone to classify it.

### Why `precondition` is the point

`INSUFFICIENT_BALANCE` is 34% of all recorded payment failures — 8,521 of 22,802
in the production census. Before this design, every one of those respondents was
told their payment had failed, and the telling was what made it true: the Result
released them from the wait, so dean stopped re-driving them, so topping the
wallet up afterwards paid nobody.

Withholding it inverts that. The respondent hears nothing, stays parked, and is
paid automatically when the researcher funds the account — provided that happens
inside dean's 14-day window, which is what `PaymentWalletEmpty` exists to
ensure.

## 4. What the respondent's state looks like

`_eventMetadata` flattens every key of a delivered Result into `md` as
`e_<type>_<key>`, recursively, snake-cased. For a payment the form can read:

| key | present |
|---|---|
| `e_payment_reloadly_success` | ✅ documented in `questions.md` |
| `e_payment_reloadly_error_message` | ✅ documented |
| `e_payment_reloadly_id` | ✅ documented |
| `e_payment_reloadly_error_code` | ⚠️ exists, undocumented — no survey branches on it |

**Withheld failures appear nowhere in state.** That is the deliberate trade, and
it is only acceptable because it is instrumented instead — see §6. A respondent
parked on an ageing `payment:*` wait is the independent cross-check.

## 5. How dean re-drives a payment

| state | dean query | emits | replybot handler | effect |
|---|---|---|---|---|
| `WAIT_EXTERNAL_EVENT` | `Payments` | `repeat_payment` | `MAKE_PAYMENT` | **re-runs the payment** |
| `ERROR` | `Errored` | `redo` | `RESPOND_AGAIN` | re-sends the last message |

`WAIT_EXTERNAL_EVENT` + `Payments` is the correct machinery for a retryable
payment failure, and moving a failed payment to `ERROR` would be wrong twice
over: `redo` never retries the payment, and `Errored` gates on
`error_tag = ANY('NETWORK','INTERNAL','STATE_ACTIONS')`, which a payment failure
does not carry. The `ERROR` transition also clears `wait`/`waitStart`,
destroying what `Payments` selects on.

> `repeat_payment` never lands in `externalEvents`, which is why `Payments`
> cannot cap attempts by counting them there. See `dean/README.md`,
> "`Payments` and the `repeat_payment` event".

## 6. Observability

Because a withheld failure writes no state, dinersclub exports metrics — the
only application service in this repo that Prometheus scrapes.

| metric | what it answers |
|---|---|
| `dinersclub_payment_results_total{provider,outcome,recovery,code}` | the ledger: every attempt, once |
| `dinersclub_unclassified_error_codes_total{provider,code}` | which rows are missing from the classifier |
| `dinersclub_payment_duration_seconds{provider,outcome}` | are we anywhere near the Kafka poll budget |
| `dinersclub_processing_faults_total{stage}` | is dinersclub itself broken (replaces "the pod restarted") |
| `dinersclub_up` | is anyone scraping this at all |

`recovery != "permanent"` is precisely the set of failures the respondent was
not told about. Alerts and runbooks: `documentation/alerting.md` §12.

## 7. Timeout budget

`spine` hardcodes `max.poll.interval.ms = 300000` with
`enable.auto.commit = false`. If one batch outruns 300s, Kafka evicts the
consumer, the in-flight batch is **never committed**, and the restarted service
reads the same messages and hangs again — a crash loop making zero progress.
That is what happened on 2026-08-17.

| knob | value | why |
|---|---|---|
| `DINERSCLUB_PROVIDER_TIMEOUT` | 15s | hard ceiling on **one** outbound call |
| `DINERSCLUB_RETRY_PROVIDER` | 60s | elapsed budget **across** attempts (~2 real attempts) |
| `DINERSCLUB_RETRY_BOTSERVER` | 60s | same, for delivering the Result |

**One attempt is up to three calls, not one.** Reloadly's `DoJob` makes
`FindOperator` + `Topup`, and `AutoFallback` can add a second `Topup` on a
refusal — so an attempt costs up to 3× the per-call timeout. That is why the
per-call ceiling must be much smaller than the budget containing it.

Worst case for a batch at `POOL_SIZE == BATCH_SIZE` (messages run concurrently,
so a batch costs about what one message costs) is ~180s, leaving headroom under
300s. **Raising any of these, or setting `BATCH_SIZE` above `POOL_SIZE`, must be
re-checked against that ceiling.**

The retry budget now applies to declined payments, not only to system faults: a
`transient` provider error code is retried inside it rather than handed straight
to the respondent.

## 8. Known gaps

- **`CUSTOM_IDENTIFIER_ALREADY_USED` is reported as a failure** (2,385
  occurrences), but 1,483 of the 2,393 states carrying it also record
  `success=true` — most of those people were paid. The honest fix is a stable,
  event-derived `custom_identifier` so the duplicate is never submitted, not
  rewriting the response to a success we cannot confirm.
- **A timeout does not tell you whether the payment executed**, and the backoff
  then retries it. Reloadly dedupes on `custom_identifier`, but the topups
  provider forwards one only when the event supplies it, and the giftcards
  provider generates a *fresh* UUID per call — which does not dedupe at all.
- **`PaymentWalletEmpty` cannot name the researcher.** The counter carries
  `provider`, not the credential key.
- **The event contract itself is unchanged.** The two-axis design in
  `planning/external-event-taxonomy.md` is deferred to land with the external
  responder / LLM service work, rather than being retrofitted onto
  `PaymentError` now and redone in six months.
