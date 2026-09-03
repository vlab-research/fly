# DingConnect attempt cascade — Plan

> **VIR-40.** Let a DingConnect payment block carry an ordered list of
> `(sku_code, send_value)` attempts and cascade over them inside the provider,
> returning ONE `Result` for the payment point.
>
> **Status: PLAN ONLY, nothing implemented.** Written 2026-09-02 against
> `dinersclub/dingconnect.go` at `ebb117a7`. Awaiting review.
>
> **Read first:** `dinersclub/README.md` ("DingConnect Provider", "Error
> Handling"), `documentation/payment-recovery.md`,
> `planning/external-event-taxonomy.md` §1.
>
> **Ticket:** https://linear.app/vlab-research/issue/VIR-40

---

## 0. Summary of what I am proposing

| # | decision | confidence |
|---|---|---|
| 1 | `attempts: [{sku_code, send_value}]`, mutually exclusive with the top-level pair | high |
| 2 | The policy is a pure `cascadeDecide(attemptOutcome, hasNext) → action`, **advance only on an allow-list**, stop by default | high |
| 3 | **Per-attempt derived `distributor_ref`** (`<ref>_<sku_code>`), only for the `attempts` form | high — safe under both answers |
| 4 | Pin `RateLimited` as `RecoveryPermanent` in `classify.go`, contradicting the client library's `Retryable()` in a comment | high |
| 5 | **One deadline for the whole cascade**, not one per attempt | needs your call (§7) |
| 6 | Attempt trace via log line + bounded metric + `Result.Attempts` (only when >1 attempt ran) | needs your call (§8) |
| 7 | A transport fault stops the cascade — it is not in the advance allow-list | high, and **not in the ticket** |

Three things I want decided before I write code: §7 (the timeout hazard, which I
think is the largest defect in the ticket as written), §8 (how much attempt
detail lands in respondent state), and §11 (whether `GetAccountLookup` should
replace the blind cascade).

Two things I found while reading that are **out of scope but live in production
today**: §10.2 (every DingConnect error code is unclassified, including
`InsufficientBalance`) and §12 (the README documents six DingConnect error codes
that do not exist).

---

## 1. What is true today

`dinersclub/dingconnect.go` `Payout` reads one `sku_code` + one `send_value`
from `PaymentEvent.Details`, validates four fields locally, makes exactly one
`SendTransfer`, and maps the outcome onto a `Result`.

The conventions it has to keep:

- **A payment rejection is `(Result{Success:false}, nil)`.** A non-nil error is
  reserved for faults worth retrying at the worker level. This is load-bearing
  for `documentation/payment-recovery.md` — `DC.payout` treats a non-nil error
  as "no verdict exists".
- **The error code is DingConnect's own, passed through verbatim.**
  `dingConnectErrorToResult` uses `e.Code()`, so the code that reaches
  `classify.go` and the respondent's `md` is `RechargeNotAllowed`, not some
  normalised name.
- **`DistributorRef` is stable across retries of a payment event**, which is
  the only reason a retry is safe.
- **The details snake_case names are vlab's contract, not DingConnect's.** The
  PascalCase mapping happens in `Payout`.

## 2. The data model

```go
// DingConnectAttempt is one (product, price) candidate in a cascade.
//
// SendValue is per-attempt and NOT shareable. The USD send value that delivers
// a given local amount differs per operator because commission rates differ:
// ARS 1,000 is $0.79 on Claro, $0.85 on Movistar, $0.93 on Personal. A single
// shared value would deliver a different amount depending on which attempt
// happened to succeed -- silently, reported as a success.
type DingConnectAttempt struct {
	SkuCode   string  `json:"sku_code"`
	SendValue float64 `json:"send_value"`
}
```

`DingConnectPaymentDetails` gains `Attempts []DingConnectAttempt
\`json:"attempts"\`` and keeps `SkuCode` / `SendValue` unchanged.

Normalisation is a pure function, separate from `Payout`:

```go
func dingConnectAttempts(d *DingConnectPaymentDetails) ([]DingConnectAttempt, error)
```

| config | result |
|---|---|
| top-level pair only | one-element list, legacy ref semantics (§4) |
| `attempts` only | the list as written, derived ref semantics (§4) |
| both | **error** — ambiguous, and it is exactly what "I tried to share a value" looks like |
| neither | error — `Missing sku_code` (today's message, unchanged) |
| `attempts: []` | error — an empty cascade pays nobody |
| an attempt with no `sku_code` | error |
| an attempt with `send_value <= 0` | error |
| the same `sku_code` twice | error (§4 makes it a duplicate ref, and it is always a config mistake) |
| more than `maxDingAttempts` (5) | error (§7) |

All of these become `INVALID_PAYMENT_DETAILS`, which is already
`RecoveryPermanent` in `classify.go` — sent, respondent released, researcher
sees the message. No new classification rows needed for validation.

### 2.1 On rejecting a "shared value" config — a narrower rule than the ticket suggests

The ticket asks whether validation should reject a config that looks like
someone tried to share a value. I propose rejecting the two shapes that are
**unambiguously** that mistake:

- `send_value` at the top level *and* an `attempts` list, and
- an attempt with a missing or non-positive `send_value`.

I propose **not** rejecting a list whose values happen to be equal. Two
operators in one country can genuinely price the same local amount at the same
USD send value, and a false rejection here is an unrecoverable permanent failure
for a respondent who has already finished the survey. The cost of the false
positive is much higher than the cost of the false negative, which is a
delivered amount that is wrong rather than a payment that never happens.

**Open question:** do you want the equal-values rejection anyway, perhaps as a
loud log line rather than a rejection? I lean towards a log line and no
rejection.

## 3. The pure decision function

The whole policy is one function with no IO, no client types, and no loop:

```go
// attemptOutcome is what one SendTransfer produced, reduced to the three facts
// the policy needs. The shell builds it; the policy never sees an HTTP client.
type attemptOutcome struct {
	completed bool     // a TransferRecord came back Completed
	codes     []string // DingConnect error codes, response order
	fault     bool     // no verdict at all: transport failure, undecodable body
}

type cascadeAction string

const (
	actionReturn  cascadeAction = "return"  // this outcome is the answer
	actionAdvance cascadeAction = "advance" // try the next attempt
)

func cascadeDecide(o attemptOutcome, hasNext bool) cascadeAction
```

The rules, in evaluation order:

| # | condition | action | why |
|---|---|---|---|
| 1 | `o.completed` | return | paid |
| 2 | `o.fault` | return | **we do not know whether money moved** (§3.1) |
| 3 | `codes` contains `RateLimited` | return | may be a per-account fraud rule; never retried, never advanced past |
| 4 | `codes` contains `AccountNumberInvalid` | return | the number is bad; no other SKU helps |
| 5 | `codes` contains `RechargeNotAllowed` and nothing above matched | advance if `hasNext`, else return | wrong operator for this number (**unverified — §9.1**) |
| 6 | anything else | return | unrecognised; surface it, never swallow it |

**The shape that matters: advance is an allow-list, stop is the default.** Rule
6 is not a fallthrough that happens to be safe, it is the base case. That is
what makes the two unverified assumptions in §9 safe to be wrong about, and it
is what makes rule 3 hold even when DingConnect returns `RateLimited` *and*
`RechargeNotAllowed` in the same `ErrorCodes` array — a stop code anywhere in
the array wins, because we check for presence with `Has`-equivalent semantics
rather than reading `Codes[0]`.

`cascadeDecide` takes `[]string` rather than `*dingconnect.Error` deliberately:
the table test then has no fixture setup at all, and the extraction of codes
from the error (which is the only part that knows about the client library) is
one line in the shell.

### 3.1 A transport fault stops the cascade — this is not in the ticket

The ticket's contract table covers only code-bearing outcomes. It says nothing
about a request that times out or never lands, which is the case where money may
have moved without us hearing about it. DingConnect's own instant-transfer
timeout is 90 seconds, and the client returns `Error{ResultCode: 0}` for that.

Advancing to the next SKU after a timeout risks paying twice — once on the SKU
we stopped listening to, once on the next one. So a fault returns, and it
returns as `HTTP_REQUEST_FAILED`, which `classify.go` already calls
`transient`: nothing is sent, the respondent stays parked, and dean re-drives
the whole cascade later with **the same refs**, so a replay is caught by
DingConnect's duplicate protection rather than paying again.

This is the one place where the cascade's correctness depends on §4 being
deterministic, and it is the strongest argument for §4's default.

### 3.2 Exhaustion returns the real last failure

Rule 5 with `hasNext == false` returns the outcome unchanged. So three
`RechargeNotAllowed`s in a row produce a `Result` whose code is
`RechargeNotAllowed` — the honest answer ("no configured operator serves this
number"), not a synthetic `ALL_ATTEMPTS_EXHAUSTED` that would need its own
`classify.go` row and would tell the respondent less. The loop keeps the last
`*Result` it built and returns it; no synthesis anywhere.

## 4. `distributor_ref`: derive per attempt

**Decision: derive a per-attempt ref, `<distributor_ref>_<sku_code>`, and only
for the `attempts` form.** A legacy single-attempt config sends the bare ref it
sends today, byte for byte.

### The reasoning

The open question is whether a *failed* transfer consumes its `DistributorRef`.
I cannot answer it without a funded live account, so I chose by asking what each
choice costs when its assumption turns out to be wrong:

| | ref is NOT burned by a failure | ref IS burned by a failure |
|---|---|---|
| **shared ref** | works, marginally simpler | **cascade never works**: attempt 2 comes back `DuplicateTransactionPrevented`, which is not in the advance allow-list, so every cascade stops at attempt 2 with a confusing code |
| **derived ref** | works; the refs are merely more unique than they needed to be | works |

The derived ref is correct under both answers and costs nothing under either.
The shared ref is a coin flip on an unverifiable fact, and it loses the flip
loudly rather than dangerously — but it loses it in production, on a feature
that would appear to work in every httptest.

Neither choice can double-pay, because both are deterministic: a retry of the
same attempt reuses the same ref either way. That is the property that must not
be given up, and `<ref>_<sku>` is a pure function of two stable inputs.

### Why only for the `attempts` form

A payment already parked in production was submitted with the bare ref. If
deriving applied to the legacy form too, dean's next re-drive of that payment
would submit `<ref>_<sku>` — a ref DingConnect has never seen — and duplicate
protection would not catch it. Keying the derivation on the config *shape*, not
on the attempt count, makes the legacy path provably identical to today's, which
is the backward-compatibility acceptance criterion.

**Migration hazard to document:** editing a live survey's payment block from the
legacy form to the `attempts` form changes the ref for payments already parked
on that payment point. Do not do it while payments are in flight.

### Length

Neither `go-dingconnect`'s types nor `planning/dingconnect-api-findings.md`
records a length or charset limit for `DistributorRef`, and I could not find one
without live API access. Real refs look like `ar_{{field:phone|e164}}_p1`
(~20 chars) and SKU codes like `PRAR13725` (~10), so the derived form is ~35.

**Proposal:** validate the longest derived ref against a constant
`dingMaxDistributorRefLen = 64` up front and reject the config with a message
naming the limit. Fail fast, before money is involved, on the first payment
rather than intermittently.

I considered deterministic truncation with a hash suffix instead, which can
never invent a rejection. I rejected it because a mangled ref is unsearchable in
DingConnect's own transfer records, which is precisely when you need it, and
because a config error a researcher can fix in ten seconds is a better outcome
than a support lookup that cannot be done. **The 64 is a guess and is cheap to
raise** — flagged in §9.3.

## 5. The shell

```
Payout
  ├─ unmarshal details                      (unchanged)
  ├─ dingConnectAttempts(details)           pure; all validation
  ├─ derive refs                            pure
  ├─ one context for the whole cascade      §7
  └─ for i, a := range attempts:
        res  := sendOne(ctx, a, ref[i])     the only IO
        out  := outcomeOf(res, err)         pure-ish: reads the client error
        trace = append(trace, ...)          §8
        if cascadeDecide(out, i < len-1) == actionReturn { return resultFor(...) }
```

`sendOne` is the existing body of today's `Payout` from `SendTransferRequest`
onwards. `resultFor` is the existing `dingConnectErrorToResult` /
success-mapping code, unchanged. Nothing about the mapping from one attempt to
one `Result` changes; the cascade only chooses which attempt's `Result` is
returned.

## 6. `RateLimited`: the layering conflict, traced

**`dinersclub` never calls `(*dingconnect.Error).Retryable()` or
`dingconnect.IsRetryable()`. Not once, in any file.** I grepped the whole
module. The client library's opinion that `RateLimited` is retryable is, from
dinersclub's point of view, dead code.

What actually drives retry at the worker level is `DC.payout`
(`dinersclub/main.go:176-206`): `backoff.Retry` over `provider.Payout`, and the
only thing that makes a *declined* payment retryable is

```go
if recovery, _ := ClassifyResult(r); recovery == RecoveryTransient {
    return &transientResultError{r}
}
```

`ClassifyResult` reads `classify.go`'s `recoveryByCode`. `RateLimited` is not in
that table, so `Classify` returns `(RecoveryPermanent, false)` — not retried,
sent to the respondent, counted by `dinersclub_unclassified_error_codes_total`.

**So the two layers agree today — by accident, via the unknown-code default,
not by decision.** That is not a guarantee, it is a coincidence that survives
until someone reads the library's `Retryable()` and adds the obvious row.

The hazard is worse than "it would be retried". `backoff.Retry` re-invokes
`provider.Payout(pe)`, which **replays the entire cascade from attempt 1**. A
single `RateLimited` row in `recoveryByCode` would therefore not just retry the
rate-limited attempt, it would re-run every attempt before it — against an
account number that may have been flagged by a fraud rule, which is the exact
thing the ticket says must never happen.

**Proposal:**

1. Add `"RateLimited": RecoveryPermanent` to `recoveryByCode`, with a comment
   stating plainly that this contradicts `(*dingconnect.Error).Retryable()` and
   why: DingConnect returns `RateLimited` both for transport throttling and for
   a per-account-number fraud rule, and the two are indistinguishable in the
   response, so the safe reading is the one that does not hammer a flagged
   number.
2. Pin it in `classify_test.go` (whose "nothing unpinned" assertion forces this
   anyway) with a test named for the guarantee, not the code.
3. **Do not touch `go-dingconnect`.** `Retryable()` answers "could an identical
   request plausibly succeed", which is a different question from "should we
   send it again", and it is right about its own question. The disagreement is
   real and belongs in dinersclub, where the account-fraud reading lives.

If you would rather resolve this in the library, that is a separate PR against a
separate repo and I would want the ticket to say so.

## 7. The timeout hazard — the largest defect in the ticket as written

`dingconnect.go` builds its context from `dingconnect.DefaultTimeout`, which is
**90 seconds**, and `devops/values/production.yaml:295-299` records this as
deliberate: `DINERSCLUB_PROVIDER_TIMEOUT` (15s) does *not* bound this provider,
because cutting a transfer at 15s risks money moving after we stop listening.

A three-attempt cascade under today's code is therefore **up to 270 seconds in
one `Payout` call**, and `backoff.Retry` cannot interrupt it — backoff only
checks elapsed time *between* attempts. `max.poll.interval.ms` is 300000.
`POOL_SIZE` is 2.

That is the 2026-08-17 incident's exact shape: the batch is never committed,
Kafka evicts the consumer, the pod restarts, reads the same messages, and hangs
again. `documentation/payment-recovery.md` §7 exists because of it and says in
terms that raising any of these must be re-checked against the 300s ceiling. A
cascade raises the effective per-message cost by N× and the ticket does not
mention it.

**Proposal: one `context.WithTimeout(90s)` for the whole cascade, shared by
every attempt, plus `maxDingAttempts = 5` enforced in validation.** A cascading
payment then costs no more wall clock than a single payment does today, so no
value in `production.yaml` has to move and the §7 budget arithmetic is unchanged.

The cost is real and I want it acknowledged: **a later attempt may never be
tried** because the deadline expired. When it does, the cascade returns the last
outcome it actually has — a real failure if one occurred, otherwise
`HTTP_REQUEST_FAILED`, which is `transient`, so nothing is sent and dean
re-drives the whole cascade with the same refs. Safe, but a slow first operator
can starve the third.

**Alternatives, if you would rather not have that:**

| option | cascade worst case | needs a values change |
|---|---|---|
| (a) one 90s deadline for the cascade **(proposed)** | 90s | no |
| (b) 90s per attempt, cap at 2 attempts | 180s | no, but `POOL_SIZE`/batch arithmetic gets tight |
| (c) 90s per attempt, cap at 5 | 450s | yes — and it breaches 300s. Not viable without deferred transfers |
| (d) shrink the per-call timeout to ~30s and cap at 3 | 90s | no, but re-opens the "money moves after we stop listening" decision |

I recommend (a). I would like your call, because (a) silently changes what
"three attempts" means under load.

## 8. Observability

The ledger stays honest for free: `recordResult` files exactly one
`dinersclub_payment_results_total` per message, and the cascade returns exactly
one `Result` per message. **One payment event per payment point** falls out of
the design rather than being enforced anywhere. No change to `metrics.go`'s
existing collectors.

Three additions, in decreasing order of my confidence:

1. **A structured log line per cascade** naming the account number's payment id,
   each attempt's SKU, and each attempt's outcome code — plus a separate, loud
   line whenever the cascade stops on an unrecognised code, matching the
   existing `deliver` log for unclassified codes. Free, no state, no cardinality.

2. **`dinersclub_dingconnect_attempts_total{position, outcome, code}`** —
   attempt-level counts, distinct from the payment ledger so the ledger cannot
   be double-counted. `position` is bounded by `maxDingAttempts`; `code` is
   restricted to a closed allow-list of cascade-relevant codes plus `"other"`,
   because `metrics.go` already flags `unclassifiedErrorCodes` as the one
   collector with open cardinality and I do not want to add a second.

3. **`Result.Attempts []AttemptTrace \`json:"attempts,omitempty"\``**, populated
   only when more than one attempt actually ran. `omitempty` keeps it invisible
   for every other provider and for every single-attempt DingConnect payment.

Point 3 is the one I want your call on. It is the only option that puts
attempt-level outcomes where a researcher debugging one respondent can see them,
but replybot's `_eventMetadata` flattens **every** key of a `Result` recursively
into `md`, arrays included — so five attempts × three fields becomes fifteen
`e_payment_dingconnect_attempts_0_sku_code`-style keys in `states`, on a table
there is active work to shrink. Points 1 and 2 arguably satisfy the ticket's
"observable for debugging without emitting separate payment events" on their
own.

I lean towards including it, capped at 5 attempts and omitted for the
single-attempt case, because the alternative is asking someone to correlate a
log line to a respondent by timestamp.

## 9. What I could not verify

### 9.1 Is `RechargeNotAllowed` the wrong-operator signal?

Unconfirmed. It is documented against "product/send amount", not against
operator mismatch. It is the obvious candidate and the phrasing fits, but no
production observation of it exists — DingConnect was only enabled in production
on 2026-09-02 (`devops/values/production.yaml:288`).

**Design tolerance:** if it is wrong, the cascade simply never advances, because
advance is an allow-list. Every payment behaves exactly as it does today. The
feature would be inert, not dangerous, and the metric in §8.2 would show it
immediately (`RechargeNotAllowed` never appearing, or appearing and the cascade
never reaching position 2).

**How to confirm, cheaply and without a funded balance:** send
`SendTransfer{ValidateOnly: true}` with a known-good number and a SKU belonging
to a different operator in the same country.
`planning/dingconnect-api-findings.md` §"ValidateOnly Behavior" records that
ValidateOnly validates syntax and provider availability, deducts no balance, and
assigns no TransferId. If the wrong-operator SKU comes back `RechargeNotAllowed`
under ValidateOnly, the assumption is confirmed for the cost of one unauthenticated-
by-money API call. DingConnect also publishes UAT test numbers per product that
always succeed and never deduct, which gives the known-good half.

**I recommend running this before merge if anyone has API-key access**, even
without funds. It is the cheapest confirmation in this document.

### 9.2 Does a failed transfer burn its `distributor_ref`?

Unconfirmed, and §4 is designed so that either answer is safe. If you want it
confirmed: submit a transfer that fails without moving money (a deliberately
invalid account number), then submit a valid transfer reusing that exact ref and
see whether it comes back `DuplicateTransactionPrevented`. A cheaper partial
signal: query `ListTransferRecords` filtered on `DistributorRefs` for the failed
ref and see whether a record exists at all. The `ValidateOnly` note that no
TransferId is assigned is weak evidence that a non-executed transfer does not
consume a ref, but ValidateOnly is not the same path as a rejected real send.

### 9.3 The `DistributorRef` length limit

Not documented in the client library, in `planning/dingconnect-api-findings.md`,
or anywhere in this repo. The 64 in §4 is a guess. Confirming it needs one
`SendTransfer` with a deliberately long ref, or a line from DingConnect support.

## 10. Out of scope, but found while reading, and live in production

### 10.1 `dinersclub/README.md` documents six DingConnect error codes that do not exist

The "Error codes" list under "DingConnect Provider" (`INSUFFICIENT_BALANCE`,
`INVALID_ACCOUNT_NUMBER`, `INVALID_SKU_CODE`, `PROVIDER_UNAVAILABLE`,
`PROVIDER_TIMED_OUT`, `DUPLICATE_REFERENCE`) is invented. The provider passes
DingConnect's own PascalCase codes through verbatim via `e.Code()`, so the real
codes are `InsufficientBalance`, `AccountNumberInvalid`, `RechargeNotAllowed`,
`RateLimited`, `DuplicateTransactionPrevented`, and the rest of
`go-dingconnect/errors.go`. I will fix this section as part of this PR's
documentation, since I am editing it anyway.

### 10.2 Every DingConnect error code is currently unclassified — including `InsufficientBalance`

This is the serious one and I do not think it should ride along on this PR.

`classify.go`'s five DingConnect rows use the same invented names as the README:

```go
"PROVIDER_UNAVAILABLE": RecoveryTransient,   // dingconnect: operator down
"PROVIDER_TIMED_OUT":   RecoveryTransient,   // dingconnect: operator slow
"INVALID_ACCOUNT_NUMBER": RecoveryPermanent, // dingconnect
"INVALID_SKU_CODE":       RecoveryPermanent, // dingconnect
"DUPLICATE_REFERENCE":    RecoveryPermanent, // dingconnect equivalent
```

None of those strings can ever reach `Classify`, because the provider emits
`AccountNumberInvalid`, not `INVALID_ACCOUNT_NUMBER`. All five rows are dead.

The consequence that matters: **`InsufficientBalance` from DingConnect is not
classified as `precondition`.** It falls to the unknown-code default, so an
empty DingConnect wallet is *sent* to the respondent, releasing them from
`WAIT_EXTERNAL_EVENT` and ending dean's ability to pay them when the researcher
tops up. That is precisely the incident `documentation/payment-recovery.md` §3
exists to prevent, reintroduced for one provider. `dingconnect_test.go:437`
already asserts the real code is `InsufficientBalance`, so the two files
disagree with each other in the same package.

DingConnect went live in production **today** (2026-09-02, config-only enable),
so the blast radius is currently zero-to-small, but it grows with every study
that switches provider.

**Recommendation: a companion ticket, done first or in parallel** — map the real
PascalCase codes in `recoveryByCode`, retire the five dead rows, pin them in
`classify_test.go`. It is a behaviour change to production payments and the repo
is explicit that changing a code's class is a decision, not a refactor, so it
should not be smuggled into a feature PR. Say the word and I will open it.

The one exception I am proposing to make is `RateLimited` (§6), because the
ticket makes that guarantee a requirement of *this* work.

## 11. The alternative the ticket does not consider: `GetAccountLookup`

`go-dingconnect` exposes `Client.AccountLookup(ctx, accountNumber)`, which
"resolves an account number to the products that can top it up" and returns
`Items []{ProviderCode, SkuCodes}`.

So the wrong-operator problem has a direct answer that needs **no unverified
assumption at all**: look the number up once, intersect the result with the
configured attempts, and send the one that matches.

| | blind cascade (the ticket) | lookup-first |
|---|---|---|
| depends on §9.1 | yes | no |
| depends on §9.2 | yes (resolved by §4) | no |
| money-moving calls, wrong operator | up to N POSTs | 1 POST |
| extra calls, right operator first | 0 | 1 GET |
| behaviour when inconclusive | works | needs a cascade fallback anyway |

The lookup is not free of failure modes — number portability, and the
`NearestMatch` partial case where `Items` comes back empty while the normalised
number does not — so it cannot fully replace a cascade; it can only *order* one.

**My recommendation: build the cascade as the ticket specifies, and record
lookup-first as a follow-on that reorders the configured attempts and falls back
to the authored order when the lookup is inconclusive.** The cascade is the
thing that has to exist either way, and it is the thing that works when the
lookup does not. But if you would rather spend the round trip and skip §9.1
entirely, that is a defensible different shape for this ticket and now is the
time to say so.

## 12. Backward compatibility

- A legacy `sku_code` + `send_value` config produces a byte-identical
  `SendTransferRequest`, an identical `DistributorRef`, and a `Result` with no
  `attempts` key. Every existing test in `dingconnect_test.go` should pass
  unmodified; that is the check.
- No existing config supplies `attempts`, so making it mutually exclusive with
  the top-level pair cannot break anything deployed.
- `Result` gains one `omitempty` field, invisible to every other provider.
- No `devops/values/*.yaml` change and no image-version bump in this PR (§7(a)
  is chosen partly so that stays true).

## 13. Test plan

**Pure, table-driven over `cascadeDecide`** — the full cross product of
{completed, fault, each stop code, `RechargeNotAllowed`, an unknown code,
multi-code arrays including `RateLimited`+`RechargeNotAllowed`} × {hasNext true,
false}. No fixtures, no server.

**Pure, table-driven over `dingConnectAttempts`** — every row of §2's validation
table, plus the ref derivation and its length bound.

**`httptest`, asserting the number of HTTP calls, not just the `Result`** —
because every "never advanced past" guarantee is a statement about a call that
must not happen:

| case | calls | assertion |
|---|---|---|
| success on attempt 1 | 1 | success; attempts 2-3 never requested |
| `RechargeNotAllowed` then success | 2 | success; the second request carries attempt 2's SKU **and** attempt 2's `send_value` |
| `AccountNumberInvalid` on attempt 1 | 1 | failure code passed through |
| `RateLimited` on attempt 1 | 1 | **the guarantee** |
| unrecognised code on attempt 1 | 1 | code surfaced verbatim, not swallowed |
| all attempts `RechargeNotAllowed` | 3 | the last real failure returned, no synthetic code |
| transport fault on attempt 1 | 1 | `HTTP_REQUEST_FAILED`, cascade stopped (§3.1) |
| per-attempt `send_value` on the wire | 3 | each request body's `SendValue` matches its own attempt |
| derived refs | 3 | each request's `DistributorRef` is `<base>_<sku>`, and a replay of the same event reproduces them exactly |
| legacy single-attempt | 1 | request identical to today's, bare `DistributorRef`, no `attempts` in the `Result` |

**`classify_test.go`** — `RateLimited` pinned, with a test named for the
guarantee (§6).

Tests needing the database (`getPool`, the `Auth` tests) will be run if the
5433 test database is reachable in this worktree and reported honestly as
skipped if not; `go build ./...` and `go vet ./...` must be clean regardless.

## 14. Documentation to update

- **`dinersclub/README.md`** — the `attempts` config shape, the cascade contract
  table, the ref derivation, the attempt cap and the cascade deadline, and the
  §10.1 error-code correction.
- **`documentation/payment-recovery.md`** — one paragraph in §7, because "one
  attempt is up to three calls, not one" now has a DingConnect clause, and §3
  gains the fact that a cascade still produces exactly one classified result.
- **Not in this repo:** the ticket names
  `docs.vlab.digital/content/fly/reference/incentive_payments.md`. There is no
  such file here (`docs/` is an unrelated helm-chart archive). That page needs a
  separate change in the docs-site repo and the PR body must say so.
