# Payment Failure Handling — Plan

> Origin: the 2026-08-17 production incident where `dinersclub` crash-looped for
> ~50 minutes on two uncommitted Reloadly payments and delivered nothing.
> Diagnosis in `dinersclub/README.md` ("Provider call hangs / crash loop") and
> `documentation/kafka-consumer-lag-alerting.md`.
>
> This plan supersedes the framing of commit `19692c1b`. See "Disposition of the
> existing commit" at the end.


---

## 0. DECIDED (2026-08-20) — read this first

**SHIPPED 2026-08-20 on `feature/payment-recovery-classes`.** Everything in this
section is implemented; the sections below it record how we got here and remain
accurate as analysis. The living documentation is
`documentation/payment-recovery.md` (cross-component),
`dinersclub/README.md` (the service) and `documentation/alerting.md` §12
(runbooks) — prefer those over this file, which is a record of a decision rather
than a description of the system.

| decided | landed as |
|---|---|
| §0.1 send permanent, withhold the rest | `dinersclub/classify.go`, `classify_test.go`, `recovery_test.go`, dispatch in `main.go` |
| §0.2 metrics close the tracking gap | `dinersclub/metrics.go`, `chart/templates/{service,servicemonitor}.yaml` |
| §0.3 the `INSUFFICIENT_BALANCE` alert | `devops/alerts/templates/payment-health.yaml` → `PaymentWalletEmpty` (critical) |
| §0.4 retry budget vs the poll interval | 15s per call / 60s budgets in `devops/values/{production,staging}.yaml` |
| §0.5 long-term event contract | still deferred, by design |

Two things were decided during implementation and are **not** what the sections
below say:

- **An unrecognised error code is `permanent`, not transient.** §1 says the
  opposite. §0.1 settled on "everything not explicitly silenced behaves as it
  does today", and silently parking respondents for 14 days on a code nobody has
  read is the larger risk. The `PaymentUnclassifiedErrorCode` alert is what
  converges the table instead.
- **Alert routing (§7 q2) is answered**: AlertManager already splits
  `severity=critical` to `#vlab-alerts-critical`, so `PaymentWalletEmpty` pages
  there rather than landing in the channel people have learned to ignore.

Short term:

### 0.1 Send permanent failures, stay silent on the rest

dinersclub keeps `WAIT_EXTERNAL_EVENT` as the only state it can leave someone
in, because that is the only thing the state machine actually supports (see
`planning/external-event-taxonomy.md` §1: the wait matcher is a subset check
over `type` + `id`, so ANY Result fulfils the wait -- "send" and "release" are
the same act, and not sending is the only way to keep someone parked).

| recovery class | dinersclub does | why |
|---|---|---|
| `transient` — provider 5xx, operator down | retry in-process, then fall through to silence | a blip; dean re-drives if it outlives our budget |
| `precondition` — `INSUFFICIENT_BALANCE`, `AUTH_ERROR` | **send nothing** | the payment is still coming. The researcher tops up, dean's next sweep pays everyone parked. Telling them it failed forecloses exactly that recovery |
| `permanent` — bad number, `IMPOSSIBLE_AMOUNT`, refused | **send the failure Result**, as today | dean will never succeed; releasing them to the form is better than a silent 14-day park, and surveys already handle this path |

This is deliberately a hybrid. Roughly 8,700 of 22,802 recorded failures are
`precondition` (7687 reloadly + 834 giftcard `INSUFFICIENT_BALANCE`, 219
`AUTH_ERROR`) and stop being told a falsehood. Everything else behaves exactly
as it does today -- no new wire fields, no replybot change, no survey change.

### 0.2 Metrics close the tracking gap

Not sending an event means the failure leaves no trace in state. That is
acceptable *because we instrument it*, not in spite of it:

- `prometheus/client_golang` is already in `dinersclub/go.sum` (transitive), and
  the repo has ServiceMonitor precedent (`devops/minio/servicemonitor.yaml`).
- Export payment outcomes by `provider`, `code`, and recovery class.
- A long-parked respondent is independently visible: `WAIT_EXTERNAL_EVENT` on a
  `payment:*` wait, aging. That is the cross-check on the silent path.

### 0.3 The alert that started all of this

**An `INSUFFICIENT_BALANCE` rule in AlertManager, paging the platform owner.**
It is the top failure code for both reloadly (7687) and giftcard (834), it never
self-heals, and dean's 14-day runway only helps if a human is told inside it.
For now the platform owner acts on it directly; routing it to the survey creator
is a study-health concern and comes later.

### 0.4 Retry budget lined up with the Kafka poll interval

Unchanged from §1.4 below: bound every provider call, and size the retry budget
so a batch cannot outrun spine's 300s `max.poll.interval.ms`. This is what stops
the crash loop from the incident recurring.

### 0.5 Long term: redefine the event contract, with the external responders

The two-axis design in `planning/external-event-taxonomy.md` (subject axis local
to each service; shared recovery axis `transient | precondition | permanent`)
is **not** being retrofitted onto the current contract. It lands together with
the external responder / LLM service work in
`planning/external-responder-design.md`, which is defining a new interface for
external services talking to the machine anyway. Designing one contract for both
beats bolting a field onto `PaymentError` now and redoing it in six months.

`error` / `blocked` stay as they are for the main state machine: `error` is
something that broke inside the machine, `blocked` something outside it. That
taxonomy is workable and is not changing.

---

## 1. The decision

**At-least-once is deliberate.** Better to pay a respondent twice than not at
all: they completed the survey, and a duplicate ₦800 topup is a cost overrun
while a missed payment is a broken promise. Duplicate suppression is a
platform-side concern, not something dinersclub should buy at the price of
dropped payments.

**"Never give up" is correct at the system level and wrong at the dinersclub
level.** The mistake in the incident was not that the system waited — waiting
was right, and the payments did land. The mistake was *which layer* waited.
dinersclub blocked the partition, which stalls every payment behind it,
including dean's own retries.

### The layers, and who owns what

| Layer | Mechanism | Horizon | Owns |
|---|---|---|---|
| **dinersclub** | `backoff.Retry` in-process | ~60s | absorbing a single-request blip |
| **dean** | `Payments` re-triggers anyone in `WAIT_EXTERNAL_EVENT` | 2h grace → every 6h → 14 days, 30 attempts | outages, and everything long |
| **the form** | branches on `e_payment_reloadly_success` / `_error_message` | immediate | telling the respondent |

**The rule: push each failure to the shortest layer that can outlast it.**
dinersclub executes fast and keeps the line moving; dean owns persistence; the
respondent is involved only when they hold information we don't.

### Dispositions

| Failure | Disposition |
|---|---|
| Blip — timeout, reset, one-off 5xx | retry in place (~60s), then fall through below |
| Provider down; our wallet empty | **commit, send nothing, leave them in the wait** — dean re-drives. Never a respondent-facing failure |
| Respondent holds the fix — bad number, wrong operator, `PHONE_RECENTLY_RECHARGED` | failure result → form asks them to correct/retry |
| Nobody can fix — bad SKU, misconfigured amount, auth 401/403 | failure result **+ alert us**; retrying is a lie |
| **Unrecognised error code** | treat as transient **+ alert**, so the table converges instead of rotting |

Two calls made explicitly:

- `PHONE_RECENTLY_RECHARGED` → **tell the respondent**. It is informative, it
  stops them wondering, and it avoids parking them in a 14-day dean cycle for
  what is a per-number business rule rather than an outage.
- **Empty wallet → do not tell the respondent.** It is our failure, not theirs.
  Leave them in the wait and alert loudly — see §3.

---

## 2. Phase 1 — classification and commit-and-defer

**No new state of any kind.** This is the change that matters; everything after
it is refinement.

### 1.1 Classify on the provider's error *code*, never the HTTP status

`dingconnect_test.go:422` already documents the trap: DingConnect returns
`InsufficientBalance` with **HTTP 500**. Its own comment says it "must not be
mistaken for a transient server fault." A `5xx → transient` rule would retry an
empty wallet forever.

Reloadly's balance code is not present in `go-reloadly` and must be sourced from
the provider docs, or from data — `md.e_payment_reloadly_error_code` on recent
failures carries the real values.

Write this as a pure function per provider: `classify(err) → disposition`.
Deterministic, no IO, exhaustively table-tested. This function is load-bearing
in both directions — a permanent error misclassified as transient parks someone
silently for 14 days; a transient one misclassified as permanent abandons a
payment that would have landed.

### 1.2 Stop `log.Fatalf` from being the universal response

`checkError` (`main.go:196`) kills the process on any processing error, which is
what turns a provider outage into a crash loop. Replace with dispatch on the
classification. `monitor()` — genuine Kafka faults — can keep failing hard.

### 1.3 Fix the two paths that currently drain the queue as failures

Both silently advance past a transient outage today, telling respondents their
payment failed:

- `formatError` (`reloadly.go:30`) returns `(res, nil)` for **any**
  `reloadly.APIError`, and `go-reloadly`'s `request()` synthesises an `APIError`
  from any non-2xx. A 503-shaped outage burns the whole queue.
- `checkCache` → `authError` (`main.go:100`) makes every auth failure a
  respondent-facing `AUTH_ERROR`. A 503 from `auth.reloadly.com` marks every
  payment failed and advances.

The incident blocked only because Reloadly *hung* rather than answering. Had it
returned 503s, the same outage would have failed ~230 payments irrecoverably.

### 1.4 Retune the timeout budget

Per-call timeout must be well under the retry budget or the budget buys nothing:
`DoJob` makes two sequential calls (`FindOperator` + `Topup`), so one attempt
costs 2× the per-call timeout.

| Knob | Now (`19692c1b`) | Target |
|---|---|---|
| per-call timeout | 30s | **10–15s** |
| retry budget (provider) | 45s | **60s** (≈2–3 real attempts) |
| retry budget (botserver) | 45s | 60s |

`max.poll.interval.ms` largely stops mattering — nothing blocks long enough to
approach 300s. That nothing needs raising is a good sign the design is right;
spine's hardcoded value can stay until something else needs it.

### 1.5 Rewrite the docs this supersedes

`dinersclub/README.md` and `documentation/kafka-consumer-lag-alerting.md`
currently describe the retry values as "a budget against the 300s ceiling."
That framing is being replaced by layered ownership and must be rewritten, not
appended to.

---

## 3. Phase 2 — metrics and alerts

dinersclub exports **no metrics**, which is why the incident required log
archaeology and why every number in phase 1 is reasoned from first principles
rather than measured.

1. **Provider call outcome, latency, and error code** — counters by
   `provider`, `key`, `code`. This is the dataset phase 3 depends on.
2. **Empty-wallet alert.** Highest value single alert: it happens often, it
   never self-heals, and dean's 14-day runway only helps if a human is told
   inside it. Should name the researcher/credential.
3. **Unrecognised-error-code alert**, feeding §1.1.

Alert routing: `#vlab-alerts` is currently a single flat receiver with two
permanently-firing broker alerts already being ignored
(`kafka-consumer-lag-alerting.md` §6). Adding a page-worthy alert to a channel
people have learned to ignore will not work — decide routing as part of this
phase.

---

## 4. Phase 3 — decide on retry memo, with data

Only after phase 2 produces numbers. The question is the **blip-to-outage
ratio**: how often does a payment fail once and succeed on immediate retry,
versus fail because the provider is gone for hours?

Options, cheapest first:

- **Nothing.** If blips are rare, dinersclub should not retry at all and dean
  owns everything. Least state, possibly correct.
- **Batch-scoped short-circuit.** Once one message in a batch hits a transient
  provider error, skip the rest. A fold with a local accumulator — no
  cross-invocation state. Needs a larger batch to amortise, which got cheaper
  now that transient failures no longer trigger redelivery.
- **Negative cache entry.** Memoise "this credential is currently failing" on
  `provider + key + userid` with a ~60s TTL; expiry *is* the probe. No counter,
  no half-open, no state machine.

Not a classic circuit breaker. Two constraints if any memo is added: it is
useless until §1.2 lands (a process that dies every 60s never accumulates
state), and **ristretto writes are lossy** — the `POOL_SIZE=1` note in
`dinersclub/README.md` documents messages racing past `Get()` before
`SetWithTTL` lands. A dropped write degrades to "no memo," not to wrong
behaviour, but a plain mutex-guarded map removes the ambiguity for one key per
credential.

---

## 5. Dean workstream

Dean becomes the retry engine, so its correctness now matters much more.

### 5.1 Bug: `Payments` counts the wrong thing — **DONE**

> Shipped ahead of phase 1. Turned out to be two bugs, not one; the scoping
> defect below was the larger of them. Details in `dean/README.md`
> ("`Payments` and the `repeat_payment` event"), regression tests in
> `dean/payment_scoping_test.go`.


`Payments` (`dean/queries.go:159`) gates on:

```sql
jsonb_array_length(COALESCE(state_json->'externalEvents','[]'::jsonb)) < $3
```

This is exactly the bug that was **already found and fixed** in `Timeouts`
(`queries.go:199-214`), whose comment explains it: `externalEvents` is a shared,
never-drained log holding unrelated events (e.g. `moviehouse:*` video events), so
its total length is the wrong proxy — a respondent who watched a clip is falsely
counted as having exhausted their attempts.

`Payments` never got the same fix. Today it silently stops retrying payments for
respondents who accumulated unrelated events — biased toward those furthest
through a survey. Apply the `Timeouts` pattern: count only `repeat_payment`
events dean emitted for **this** wait.

### 5.2 Review the retry window for its new role

Grace `2 hours`, interval `14 days`, max attempts `30`, cron `0 */6 * * *`.
Generous for an outage. But under the new design a *blip* that dinersclub
declines to retry also waits 2–8 hours. If phase 2 shows blips are common,
either dinersclub keeps a short retry (phase 3) or the payment grace shortens.

### 5.3 Confirm the re-trigger path end to end

`getPayment` emits a `repeat_payment` external event → botserver → replybot
re-drives the wait → new payment event. Worth an explicit end-to-end test now
that it is the primary recovery mechanism rather than a backstop.

---

## 6. Disposition of the existing commit (`19692c1b`)

| Change | Keep? |
|---|---|
| `svc.Client` bounded on both Reloadly providers | **Keep** — mechanism is right, retune to 10–15s |
| `DINERSCLUB_PROVIDER_TIMEOUT` config | Keep |
| Retry budgets 2m → 45s | **Revise** to 60s |
| `http_provider.go` `defer cancel()` vet fix | Keep — unrelated and correct |
| README / runbook prose | **Rewrite** per §1.5 |

Nothing needs reverting; the timeout work stands, the framing around it changes.

---

## 7. Open questions

1. **Reloadly's balance/wallet error code** — from provider docs, or pulled from
   `md.e_payment_reloadly_error_code` on recent failures?
2. **Alert routing** — does empty-wallet page, or land in `#vlab-alerts`
   alongside the two alerts already being ignored? (§3)
3. **`IMPOSSIBLE_AMOUNT`** — respondent-fixable, or our misconfiguration? Turns
   on whether it can be caused by operator-side pricing drift rather than bad
   input.
4. **Ordering of §5.1** — the dean cap bug is independent of phase 1 and could
   ship immediately; it is arguably the cheapest real payment recovery on this
   page.
