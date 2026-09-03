# DingConnect: pay by delivered amount + tolerance, with per-operator SKU pins

> **VIR-40.** Replace the uninterpretable `send_value` magic number with a
> declared intent (`amount` + `amount_currency` + `tolerance`) plus an optional
> per-operator pin (`operators`), verified against the intent at payment time.
>
> **Ticket:** https://linear.app/vlab-research/issue/VIR-40
>
> **Supersedes** this file's previous contents, which planned an authored
> ordered list of `(sku_code, send_value)` attempts. That list survives as the
> per-operator pin — unordered, and verified against a declared intent. The
> reason for the change is in §1.
>
> **Read first:** `dinersclub/README.md` ("DingConnect Provider", "Error
> Handling"), `documentation/payment-recovery.md`,
> `go-reloadly@v0.0.23/reloadly/{topup_worker,topups,operator}.go`.
>
> **SHIPPED across two repos.** The resolution logic lives in
> `vlab-research/go-dingconnect` (PR #1, released as **v0.3.0**); `dinersclub`
> is a thin adapter over it (`fly` PR #163). §19 records the split and why it
> is there rather than here.

---

## 1. Why the attempt list was the wrong shape

An ordered `[{sku_code, send_value}, ...]` solves operator routing and nothing
else. It leaves `send_value` a bare number with no record of what it was *for*,
so nothing can check it. When a commission rate moves, $0.79 is still a
perfectly valid send value: the transfer completes, the result says success, and
the respondent silently receives ARS 800 instead of ARS 1,000.

**A configuration that cannot fail loud on the thing that actually goes wrong is
the defect.** Declaring the intent is what makes the pinned number verifiable —
that is the entire reason for carrying both.

## 2. The vocabulary is Reloadly's, deliberately

We are porting a proven UX, not inventing one. `reloadly.TopupJob` is
`{Number, Amount, Country, Tolerance, Operator}`, `TopupWorker.DoJob` uses
`FindOperator` when an operator is named and `AutoDetect` when it is not, and
`pickAmount` takes the cheapest denomination whose **delivered** value lands in
`[amount, amount+tolerance]`.

The one thing worth stating explicitly, because it is easy to get backwards:
Reloadly's `SuggestedAmount{Pay, Sent}` has `Sent` = what the recipient gets and
`Pay` = what we spend, and `pickAmount` filters on `Sent`. **The window is on
delivered value.** DingConnect's `Price` maps straight onto it:
`ReceiveValue` ↔ `Sent`, `SendValue` ↔ `Pay`.

One deliberate divergence: `pickAmount` sorts by `Sent`; the ticket asks for
cheapest `SendValue`. They agree whenever price is monotonic in delivered value,
which is always in practice, and the ticket's phrasing is the one a researcher
would defend ("spend the least"). Following the ticket, noted in a comment.

## 3. Config

```json
"details": {
    "id": "p1",
    "account_number": "{{field:phone|e164}}",
    "distributor_ref": "ar_{{field:phone|e164}}_p1",

    "amount": 1000,
    "amount_currency": "ARS",
    "tolerance": 200,

    "operators": {
        "CLAR": {"sku_code": "CLAR5046",  "send_value": 0.79},
        "TFAR": {"sku_code": "TFAR58291", "send_value": 0.85},
        "PRAR": {"sku_code": "PRAR13725", "send_value": 0.93}
    }
}
```

Plus optional `operator` (names the operator, skips detection) and `on_drift`
(`"fail"` only — see §9).

`operators` keys are matched against `ProviderCode` **case-insensitively**.
Researchers hand-write these; the failure mode of exact matching is a payment
failure for a config that is obviously right, and the failure mode of
case-insensitive matching is nothing. A key that matches nothing still fails
loudly, so forgiveness here costs no safety.

### Validation (pure, no network)

| condition | code |
|---|---|
| `amount <= 0` with any resolution config | `INVALID_PAYMENT_DETAILS` |
| `amount` set, `amount_currency` empty | `INVALID_PAYMENT_DETAILS` |
| `tolerance < 0` | `INVALID_PAYMENT_DETAILS` |
| `amount`/`operators` mixed with top-level `sku_code`/`send_value` | `INVALID_PAYMENT_DETAILS` |
| an `operators` entry missing `sku_code` or with `send_value <= 0` | `INVALID_PAYMENT_DETAILS` |
| `operators` present but empty | `INVALID_PAYMENT_DETAILS` |
| more than `dingMaxCandidates` (5) pins | `INVALID_PAYMENT_DETAILS` |
| neither `amount` nor `sku_code` | `INVALID_PAYMENT_DETAILS` ("Missing sku_code", today's message) |

Mixing the two forms is rejected rather than resolved because it is exactly what
"I tried to share a value across operators" looks like in JSON, and because
there is no honest precedence rule between an intent and an escape hatch.

## 4. Resolution

```
legacy sku_code + send_value ──────────────────────────────► 1 POST, bare ref
                                                              (unchanged)
otherwise:
  operator = details.operator, else AccountLookup(account_number)

  ├─ operator known, pin exists ──── verify pin ───────────► 1 POST, bare ref
  ├─ operator known, pins present but none for it ─────────► NO_PIN_FOR_OPERATOR
  ├─ operator known, no operators map ── catalogue resolve ► 1 POST, bare ref
  ├─ operator unknown, pins present ─── verify all ────────► discovery cascade,
  │                                                          derived refs
  └─ operator unknown, no pins ────────────────────────────► COULD_NOT_AUTO_DETECT_OPERATOR
```

**Detection is inconclusive, not failed, when `AccountLookup` returns zero items,
several items, or a `NearestMatch` partial.** Assumption 1 says a number belongs
to exactly one operator, so several `Items` is a data quirk; we decline to
arbitrate and let discovery settle it by sending.

### Verification of a pin (pure)

Against the catalogue entry for the pinned SKU:

1. SKU absent from the catalogue → **drift**.
2. `ReceiveCurrencyIso != amount_currency` → **currency mismatch**, its own code.
3. Delivered value at the pinned `send_value` outside `[amount, amount+tolerance]`
   → **drift**.
4. Otherwise → honour the pin, **including when a cheaper in-window product
   exists**. Saying nothing there is the point: a pin that is overridden over
   pennies is not a pin.

### Catalogue resolution (no pin, pure)

Cheapest `SendValue` among the operator's products whose delivered value lands
in the window:

- **Fixed products** (`Minimum.SendValue == Maximum.SendValue`) qualify only if
  that single `ReceiveValue` is in the window.
- **Range products** are solved for the send value that delivers exactly
  `amount`, then clamped to `[Minimum.SendValue, Maximum.SendValue]`. A clamp
  upward can overshoot, so the clamped result is re-checked against the window.

Nothing in window → `IMPOSSIBLE_AMOUNT`, naming the window and what was
available, matching the shape Reloadly already returns for this.

### The linear-price assumption

`Product` gives only `Minimum` and `Maximum` prices, so the delivered value at
an arbitrary send value between them is interpolated linearly. `CommissionRate`
is a single per-product number, so this should be exact.

**Unverified.** If DingConnect ever prices a range non-linearly, a range product
could deliver slightly outside the window. Fixed products — which is what all
three Argentine pins are — are unaffected, because their single price pair is
read directly with no interpolation. `EstimatePrices` prices exactly and is the
confirmation route, at the cost of a round trip on a path the ticket wants to be
one POST.

## 5. Catalogue cache

Two scopes, both cached with a long TTL (`dingCatalogueTTL`, 6h), keyed by a
fingerprint of the API key so one researcher's commission rates can never be
read into another's payment:

| path | filter | cache key |
|---|---|---|
| pin verification | `Products{SkuCodes: pinned}` | the sorted SKU list |
| catalogue resolution | `Products{CountryISOs, ProviderCodes}` | country + provider |

Pin verification uses the SKU scope rather than the country scope because it is
narrower and, unlike country, is available on every path including discovery
(where detection failed and no country is known).

The cache lives at package scope rather than on the provider struct, because
`getProviderFromEvent` builds a fresh provider per request and only the auth
cache keeps one alive — tying catalogue lifetime to auth-cache lifetime would be
an invisible coupling.

## 6. The cascade — unchanged from the previous plan, now governing discovery

```go
func cascadeDecide(o attemptOutcome, hasNext bool) cascadeAction
```

| # | condition | action |
|---|---|---|
| 1 | completed | return |
| 2 | transport fault / no verdict | return — we do not know whether money moved |
| 3 | `RateLimited` present | return — may be a per-account fraud rule |
| 4 | `AccountNumberInvalid` present | return — no other SKU helps |
| 5 | `RechargeNotAllowed` present, nothing above | advance if `hasNext` |
| 6 | anything else | return, surfacing the code |

**Advance is an allow-list; stop is the base case.** Rule 6 is not a fallthrough
that happens to be safe. A stop code anywhere in `ErrorCodes` wins — presence
across the whole array, never `Codes[0]` — so `RateLimited` alongside
`RechargeNotAllowed` still stops.

Exhaustion returns the real last failure, never a synthetic code.

`cascadeDecide` takes `[]string` rather than `*dingconnect.Error` so the table
test needs no fixtures; extracting codes from the error is one line in the shell.

## 7. `distributor_ref`

Bare ref on every single-send path (legacy, verified pin, catalogue resolution).
Derived `<ref>_<sku_code>` on the discovery path only.

Keyed on **path, not candidate count**, so a payment already parked with a bare
ref keeps it when dean re-drives. Whether a rejected transfer consumes its ref is
unverified; deriving is correct under either answer, and a shared ref would make
every discovery cascade die at candidate 2 with `DuplicateTransactionPrevented`
if it turned out refs are consumed.

Derivation is a pure function of two stable inputs, so a retry of the same
candidate reuses the same ref. Validated against `dingMaxDistributorRefLen`
(64, a guess — no limit is documented anywhere in the client library or
`planning/dingconnect-api-findings.md`).

## 8. `RateLimited` — the layering conflict

**`dinersclub` never calls `(*dingconnect.Error).Retryable()` or
`IsRetryable()`.** Worker retry is `DC.payout`'s `backoff.Retry`, driven solely
by `ClassifyResult(r) == RecoveryTransient` over `classify.go`. `RateLimited` is
absent from `recoveryByCode`, so it hits the unknown-code default and is not
retried. **The layers agree today by accident, via a default, not by decision.**

The hazard is sharper than "it would be retried": `backoff.Retry` re-invokes
`Payout`, replaying the **whole discovery cascade from the first candidate**
against a number that may have been fraud-flagged.

Pin `"RateLimited": RecoveryPermanent` explicitly, with a comment naming the
disagreement. Do not touch the library — `Retryable()` correctly answers "could
an identical request succeed", which is a different question from "should we
send it again".

## 9. `on_drift`

Accepted as config; `"fail"` is the only implemented value and the default.
Anything else is rejected as invalid config. This keeps `"resolve"` purely
additive later, with no migration, exactly as the ticket's scope note requires.
**The resolve path is not built.**

## 10. Timeout budget

`dingconnect.go` uses the client's 90s `DefaultTimeout`, deliberately not bounded
by `DINERSCLUB_PROVIDER_TIMEOUT` (`production.yaml:295-299` records why). N
sequential sends at 90s against `max.poll.interval.ms` of 300000 with
`POOL_SIZE=2` is the 2026-08-17 incident's exact shape.

**One `context.WithTimeout(90s)` for the entire resolution** — lookup, catalogue
fetch and every send share it — plus `dingMaxCandidates = 5`. A cascading
payment then costs no more wall clock than a single payment does today, so no
value in `devops/values/*.yaml` moves and `payment-recovery.md` §7's arithmetic
is unchanged.

The cost, stated plainly: under load a late candidate may never be tried. When
the deadline expires the cascade returns the last outcome it actually has — a
real failure if one occurred, otherwise `HTTP_REQUEST_FAILED`, which is
`transient`, so nothing is sent and dean re-drives with the same refs.

## 11. Observability

One `Result` per payment point, so `recordResult` files exactly one ledger entry
per message and the "one payment event" criterion falls out of the design rather
than being enforced anywhere.

| addition | why |
|---|---|
| `dinersclub_dingconnect_pin_drift_total{reason}` | the alert the ticket asks for; `reason` ∈ {`sku_missing`, `out_of_window`, `currency_mismatch`} |
| `dinersclub_dingconnect_delivered_out_of_window_total` | post-hoc: the realised `TransferRecord.Price.ReceiveValue` was outside the window |
| `Result.Resolution` (`omitempty`) | the resolved operator, SKU, send and expected delivered values, plus per-candidate outcomes when discovery ran |
| a loud log line per resolution and per cascade stop | free, no state |

**Post-hoc delivered check.** The transfer record reports what actually landed.
If it is outside the window we log loudly and count it — but still report
success, because the respondent *was* paid and reporting failure would both lie
and cause dean to pay them again. This is the only true detector of the exact
failure this ticket exists to prevent, and it costs one comparison.

`Result.Resolution` is `omitempty` and absent on the legacy path, so no other
provider and no existing config changes shape. replybot's `_eventMetadata`
flattens it into `md`, which is the point — a researcher debugging one
respondent can see which operator was chosen and what was expected to land.

## 12. New error codes

All permanent, all added to `recoveryByCode` and pinned in `classify_test.go`:

| code | when |
|---|---|
| `PIN_DRIFT` | pinned SKU gone, or out of window at the pinned send value |
| `AMOUNT_CURRENCY_MISMATCH` | resolved product's `ReceiveCurrencyIso` ≠ `amount_currency` |
| `NO_PIN_FOR_OPERATOR` | operator detected, `operators` present, no entry for it |
| `RateLimited` | §8 |

Reused unchanged: `IMPOSSIBLE_AMOUNT`, `INVALID_PAYMENT_DETAILS`,
`COULD_NOT_AUTO_DETECT_OPERATOR`, `HTTP_REQUEST_FAILED`.

## 13. Drift in discovery — a judgement the ticket does not cover

When detection fails and several pins are verified, one stale pin blocks a
payment whose real operator may be perfectly fine.

**Decision: hard-fail uniformly**, matching "drift is a hard failure" without
carving out an exception. Dropping the drifted candidate and continuing would
pay the respondent correctly but would let a catalogue change sit behind a
counter nobody reads, which is the silent-wrong-amount failure mode this ticket
exists to remove. Assumption 2 says this is rare, and when it is not rare the
alert is the thing that should fire.

Recorded here because it is the one place I chose strictness over paying
someone, and it is the first thing to soften if the `pin_drift` alert proves
noisy.

## 14. Backward compatibility

- Legacy `sku_code` + `send_value` produces a byte-identical request, an
  identical bare `DistributorRef`, and a `Result` with no `resolution` key. The
  existing `dingconnect_test.go` cases pass unmodified; that is the check.
- No deployed config carries `amount` or `operators`, so the mutual exclusion
  cannot break anything live.
- `Result` gains one `omitempty` field.
- No `devops/values/*.yaml` change, no image bump.

## 15. Test plan

**Pure, table-driven, no fixtures:** `cascadeDecide` (full cross product of
outcomes × `hasNext`, including multi-code arrays), config parsing and
validation, `deliveredFor` interpolation and clamping, pin verification,
catalogue resolution over fixed and range products, ref derivation.

**`httptest`, asserting the number and kind of HTTP calls**, because every
"never advanced past" guarantee is a statement about a send that must not
happen: pinned operator resolves and pays; pin verified in-window; pinned SKU
missing; pinned value out of window; pin no longer cheapest honoured silently;
currency mismatch; catalogue resolution for fixed and range SKUs; nothing in
window; detection failure → discovery; `RateLimited` and `AccountNumberInvalid`
each stop without a further send; unrecognised code stops and surfaces;
transport fault stops; legacy config unchanged; catalogue cached (second payment
makes no second `GetProducts`).

## 16. Unverified

1. **`RechargeNotAllowed` as the wrong-operator signal.** Only the *advance*
   signal on the discovery path, so being wrong degrades discovery rather than
   breaking the verified path. Confirm with `ValidateOnly` against a UAT number.
2. **Whether a rejected transfer consumes its `distributor_ref`.** §7 is correct
   under either answer.
3. **`DistributorRef` length limit.** The 64 is a guess.
4. **Linear interpolation across a range product's price band** (§4).

## 17. Out of scope — companion ticket

`classify.go`'s five DingConnect rows use invented SCREAMING_SNAKE names the
provider never emits, so all five are unreachable and `InsufficientBalance` from
DingConnect is not classified `precondition` — an empty wallet is sent to the
respondent, releasing them from `WAIT_EXTERNAL_EVENT` and ending dean's ability
to pay them on top-up. Live in production since 2026-09-02. Tracked as **VIR-41**
(https://linear.app/vlab-research/issue/VIR-41); `RateLimited` is the one row
folded into this work because §8 requires it.

## 18. Documentation

- `dinersclub/README.md` — the config shape, resolution, drift, the cascade
  contract, the cache, and a correction of the six DingConnect error codes it
  currently documents that do not exist.
- `documentation/payment-recovery.md` §7 — the DingConnect clause on "one
  attempt is up to three calls, not one".
- **Not in this repo:** `docs.vlab.digital/.../incentive_payments.md` lives in
  the docs-site repo. Raised in the PR body.


---

## 19. The two-repo split (as shipped)

An earlier draft of this plan put the entire resolution in `dinersclub`. That
was wrong, and two things already in the repo said so:

- The comment at the top of `dinersclub/dingconnect.go`: *"All knowledge of
  DingConnect's wire format, **error codes**, and retry semantics lives in the
  dingconnect package."* Putting cascade error-code semantics in `dinersclub`
  contradicted a rule written in the file being edited.
- The Reloadly precedent this design's UX was modelled on keeps `pickAmount`,
  `GetSuggestedAmount`, `AutoDetect` and `AutoFallback` in `go-reloadly`.
  `dinersclub/reloadly.go`'s `Payout` is unmarshal → validate → `DoJob`. We had
  copied Reloadly's interface and ignored its architecture.

`go-dingconnect` is first-party and public. It moved.

| `go-dingconnect` v0.3.0 (`payment.go`) | `dinersclub` (`dingconnect.go`) |
|---|---|
| operator detection, catalogue fetch + cache | unmarshalling the snake_case payment block |
| amount selection (fixed + range), pin verification | `Auth` and Generic Secrets |
| the advance/stop cascade policy | mapping outcomes onto `Result`/`PaymentError` |
| `DistributorRef` derivation (idempotency is a wire property) | `classify.go` recovery classes incl. the `RateLimited` pin |
| — | Prometheus metrics, from the returned `Resolution` |

**The one real design decision in the move** was metrics. A library must not own
a metrics registry — it would force its choice of one on every consumer — so
`Pay` returns a `Resolution` (path, operator, product, expected vs delivered,
per-candidate attempts) and `dinersclub` records it. `resolutionReasonToCode` is
the boundary table: the library reports a `ResolutionReason` in its own
vocabulary, and dinersclub decides what that means for a respondent and what to
count. A reason added upstream arrives unmapped and is logged loudly rather than
silently renamed, which `TestDingEveryResolutionReasonIsMapped` also pins.

### API shape

`Client.Pay(ctx, PayRequest) (PayResult, error)` — a plain method, not
`go-reloadly`'s `Worker`/`Job`.

`TopupJob` carries a `csv:` tag on every field and `TopupWorkerResponse`
flattens errors into strings; that shape exists to serve a **CSV batch runner**,
and `Work(interface{}) interface{}` is a worker-pool interface for it. Real
reasons, for that repo. We have no CSV runner and no pool, and `dinersclub` does
not call `Work` either — it calls `DoJob` directly, which is a plain function
wearing a worker's clothes. A builder was also rejected: callers already hold a
struct from unmarshalled JSON, so struct → builder calls → struct is ceremony.
The **vocabulary** was worth copying and was copied; the plumbing was not.

### What did not survive the move

- `dingIntent`, `dingParsePlan`, `dingVerifyPin`, `dingResolveFromCatalogue`,
  `cascadeDecide`, `dingCandidateRef`, the catalogue cache and operator
  detection — all now in `go-dingconnect`, with their tests.
- The explicit `sku_code` + `send_value` path stayed in `dinersclub` and calls
  `SendTransfer` directly, which makes "the escape hatch is unchanged"
  **provably** true rather than merely tested: it is the same code it always was.

### Still unverified, now recorded in the library's `CLAUDE.md`

`RechargeNotAllowed` as the wrong-operator signal; the `DistributorRef` length
limit (64, a guess); whether a rejected transfer consumes its ref; and linear
interpolation across a range product's price band. Each is designed so that
being wrong degrades a fallback path rather than misdirecting money. The wire
questions belong in the library's contract notes, which is where they now live.
