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
| `precondition` | a human off-stage must act first, and the respondent has no part in it | **nothing** | stays parked | researcher tops up / re-authorises / fixes the payment block, dean's next sweep re-drives everyone waiting |
| `respondent` | only the respondent can change the outcome, by giving a different number | **the failure Result** | released to the form | the form asks for another number and the payment runs again |

Examples: a provider 5xx is `transient`; `INSUFFICIENT_BALANCE`, `AUTH_ERROR`,
`IMPOSSIBLE_AMOUNT`, `PIN_DRIFT`, a malformed payment block and DingConnect's
`RateLimited` are `precondition`; a number the operator does not know, a line
that cannot take a top-up and an operator refusal of that number are
`respondent`.

**A failure is delivered only when another number could fix it.** A form's only
answer to a delivered failure is to ask for another phone number, so delivering
a stale pin, a rate limit or a malformed payment block tells the respondent
their number is wrong when it is not. That leaves three outcomes: the payment
succeeded; it failed and the fault is ours or the provider's (withheld, logged,
alerted on, re-driven by dean); it failed and only the respondent can fix it
(delivered).

`RateLimited` is `precondition` rather than `transient` because only `transient`
re-enters dinersclub's in-process `backoff.Retry`, which re-invokes the payout
wholesale and would replay the DingConnect discovery cascade from its first
candidate. Withheld, it is re-driven by dean on its normal cadence like any
other parked payment.

**One payment point produces exactly one classified Result, however many
provider calls it took.** DingConnect can try several operators for one payment
(see `dinersclub/README.md`, "Cascade contract"); the candidates are an internal
detail, and only the outcome that ends the resolution is classified, recorded in
the ledger, and delivered. Per-candidate outcomes ride along on the Result's
`resolution` block for debugging rather than becoming payment events of their
own — otherwise one payment point would inflate the metrics and the
`payment-recovery` tooling N-fold.

> **The DingConnect spelling gap (VIR-41) — closed 2026-09-10.** `classify.go`'s
> DingConnect rows used invented SCREAMING_SNAKE names the provider never emits;
> it passes DingConnect's PascalCase codes through verbatim. So
> `InsufficientBalance` from DingConnect was **not** classified `precondition`,
> and was sent to the respondent, releasing them from the wait and ending dean's
> ability to pay them on top-up: the §3 failure mode, reintroduced for one
> provider. Live from 2026-09-02.
>
> `InsufficientBalance`, `AuthenticationFailed`, `ProviderError`,
> `TransientProviderError`, `AccountNumberInvalid`, `ParameterInvalid` and
> `DuplicateTransactionPrevented` are now pinned in DingConnect's own spelling,
> and `PaymentWalletEmpty` — which matched `code="INSUFFICIENT_BALANCE"`
> exactly, and was therefore blind to DingConnect in the same way — now matches
> both. `TestDingConnectSpellingsAreClassified` is the regression test for the
> class rather than the instance.
>
> **The phantom rows are still there.** `INVALID_ACCOUNT_NUMBER`,
> `DUPLICATE_REFERENCE`, `INVALID_SKU_CODE`, `PROVIDER_UNAVAILABLE` and
> `PROVIDER_TIMED_OUT` are names nothing emits; removing them is a separate
> decision. Only nine codes are dinersclub's own inventions for DingConnect
> (`PIN_DRIFT`, `AMOUNT_CURRENCY_MISMATCH`, `NO_PIN_FOR_OPERATOR`,
> `IMPOSSIBLE_AMOUNT`, `INVALID_PAYMENT_DETAILS`, `COULD_NOT_AUTO_DETECT_OPERATOR`,
> `INVALID_RESPONSE`, `HTTP_REQUEST_FAILED`, `PAYMENT_FAILED`); everything else
> is the provider's, so check `go-dingconnect/errors.go` before adding a row.

**An unrecognised code is `precondition`**, i.e. it is withheld. A code nobody
has looked at says nothing about the respondent's number, so asking them for
another one would be a guess made in their chat. The cost of being wrong is a
respondent parked until the row is added: the code is counted by
`dinersclub_unclassified_error_codes_total` and
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
| `dinersclub_dingconnect_pin_drift_total{reason}` | a DingConnect pin no longer delivers the declared amount — alerts as `PaymentPinDrift` |
| `dinersclub_up` | is anyone scraping this at all |

`recovery != "respondent"` is precisely the set of failures the respondent was
not told about. Alerts and runbooks: `documentation/alerting.md` §12.

Metrics carry a `namespace` label, because Prometheus is a singleton across
`vprod` and `vstag` and dinersclub runs in both. Every alert is scoped to
`vprod` for that reason — otherwise a staging deployment would satisfy
`absent(dinersclub_up)` and mask a production scrape that had stopped.

### Per survey: the respondent's side

dinersclub's payment event carries only `userid`, `pageid`, `platform` and the
provider block, so none of the metrics above can say **which survey** a payment
belongs to. sql_exporter's `payment_health` collector
(`devops/sql-exporter/templates/configmap.yaml`) reads that from `states`
instead, on the same researcher › survey › shortcode › page labels as the rest
of Live Traffic:

| metric | what it answers |
|---|---|
| `survey_payment_waiting{window,provider,…}` | respondents parked on a `payment:*` wait, by when the wait **started** (`1h`/`6h`/`24h`); `14d` is everyone dean is still retrying |
| `survey_payment_results{window,provider,outcome,code,…}` | Results that **reached** the respondent (successes and `respondent` failures), counted per Result from `externalEvents` |

The two sources are complementary, not redundant:

- **A withheld failure shows up in state only as a respondent still waiting**,
  never with its code. The code is on the dinersclub counter, which has no
  survey. Read them together: `Held: wallet / auth` climbing on the counter, and
  one survey's waiting rows growing, is that survey's wallet.
- **`waitStart` is when the respondent first reached the payment.** dean's
  retries keep it (`state.waitStart || nxt.timestamp`), so it measures how long
  someone has really been waiting, not time since the last retry.
- **Time a Result by its envelope `timestamp`, never `payload.timestamp`.**
  dinersclub leaves the latter zero (`0001-01-01T00:00:00Z`) on most failure
  Results, and md's `e_payment_<provider>_timestamp` inherits the zero.
- **`shortcode` is the respondent's current form.** For a delivered Result that
  is the form they are on now, which after a stitch is not the form that paid
  them.
- **Parked rows are never cleaned up** (some date from 2022), so every waiting
  count is bounded by dean's 14-day horizon.

Both feed the **Payments** row of the Live Traffic Grafana board
(`devops/grafana-dashboards/README.md`).

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

**DingConnect is bounded differently, and deliberately so.** It ignores
`DINERSCLUB_PROVIDER_TIMEOUT` and uses the client's 90s `DefaultTimeout`, because
cutting a transfer short risks money moving after we stop listening. Since
VIR-40 one DingConnect payment can make several calls — an `AccountLookup`, a
cached `GetProducts`, and on the discovery path several `SendTransfer`s, all
inside `go-dingconnect`'s `Pay` — so dinersclub passes **one shared 90s context
for the whole resolution** rather than one deadline per call. A cascading payment therefore costs no more wall clock than a single one
did, and none of the values above move. If that deadline is ever made per-call,
N sequential 90s sends reproduce the 2026-08-17 shape exactly.

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
  rewriting the response to a success we cannot confirm. It and DingConnect's
  `DuplicateTransactionPrevented` are classed `respondent` and sent although the
  respondent cannot fix them: withholding would park people who were mostly
  paid, mid-survey, on a re-drive that can only draw the same duplicate again.
- **The in-process retry converts a transient Reloadly failure into
  `CUSTOM_IDENTIFIER_ALREADY_USED` when the form supplies the identifier.**
  Reloadly consumes a `custom_identifier` even when the topup fails, so the
  second attempt inside `payout`'s backoff — same event, same identifier — is
  refused as a duplicate. That code is `permanent`, so it ends the retry and is
  delivered: the respondent is told their number was already used, and surveys
  that treat the code as evidence of number sharing route them out. dean's
  `repeat_payment` re-drive has the same shape. Visible in production as
  identifiers whose *first delivered* Result is `CUSTOM_IDENTIFIER_ALREADY_USED`:
  under 20 a week before withholding shipped, 84–164 a week during the Safaricom
  Kenya outage (2026-08-17 to 2026-09-05). Same fix as above — the identifier
  must be unique per attempt while still deduping a genuinely repeated payment.
- **A withheld `PIN_DRIFT` is not healed by re-declaring the pin.** dean's
  re-drive rebuilds the payment from the form version the respondent started on
  (`actionsResponses` resolves the form at `md.startTime`, and `MAKE_PAYMENT`
  reads the payment block from that form), which carries the same stale pin. A
  corrected pin is a new version that only new respondents get. The same holds
  for any failure whose fix is an edit to the survey's payment block. This is
  by design: a respondent finishes on the version they started. The recovery
  is a bail (`documentation/bail-systems.md`) that moves the parked
  respondents into the corrected form, where they enter on the current
  version and the payment runs with the new block.
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
