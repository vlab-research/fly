# LAC Healthy Diets — DingConnect `AccountNumberInvalid`

> Read-only investigation, 2026-09-16. Forms `lacbopay1es` (BO), `lacarpay1es`
> (AR), `lachnpay1es` (HN), WhatsApp account `1203867182815254`.
>
> **Question asked:** is `AccountNumberInvalid` caused by the number the
> participant typed, or by our survey configuration / how dinersclub builds the
> DingConnect request?
>
> **Answer:** overwhelmingly ours. 58 % of the failures (39/67) are a single
> known cascade bug in `go-dingconnect`, fixed upstream in **v0.3.2**. Only 2 of
> 67 are a participant typo, and even those were made payable by our own phone
> normalisation.
>
> **Status correction (2026-09-16).** The first draft of this document said the
> fix was "not deployed". That was read off a local checkout 10 commits behind
> `origin/main`. The fix **shipped on 2026-09-12** — see §5.1. The diagnosis
> below stands; only the deployment claims were wrong.
>
> **Related:** `documentation/payment-recovery.md`, `dinersclub/README.md`
> §DingConnect, `go-dingconnect/CLAUDE.md` §"`AccountNumberInvalid` is also a
> wrong-operator answer (measured 2026-09-12)".

---

## 1. Verdict

67 participants have a latest `p1`/`p1a`/`p1b`/`p1c` result of
`AccountNumberInvalid`. 56 of them were never paid at all.

| # | Country | Cause | Whose fault |
|---|---|---|---|
| **39** | HN | Discovery cascade stops on `AccountNumberInvalid`; only `HN_CL_TopUp` (Claro) is ever tried, so every Tigo number is refused and Tigo is never attempted | **ours** — `go-dingconnect` v0.3.1; fixed in v0.3.2, shipped 2026-09-12 |
| **10** | AR | The *same* number was paid on another payment id seconds earlier; Claro AR refuses the 2nd/3rd back-to-back top-up | **ours** — survey sends 3 × ARS 1 000 within ~30 s |
| **16** | AR | Real `+54` number (14/16 the participant's own WhatsApp line), one pinned operator resolved, refused on every attempt, no fallback | **mixed / unresolved** — see §4 |
| **2** | AR | Participant typed a bare national number; `\|e164` turned it into a **US** number and we paid `+1…` | participant omitted `+54`, **we** silently rewrote it |

Bolivia is clean: 0 of 220 BO participants end on `AccountNumberInvalid`.

---

## 2. Honduras — proven, single cause, 100 % ours

`chatroach.messages`, all `p1` attempts in `lachnpay1es`:

| national prefix | distinct numbers | attempts | outcome |
|---|---|---|---|
| `3…` | 13 | 15 | **all succeeded**, operator `CLHN` |
| `8…` | 16 | 16 | **all succeeded**, operator `CLHN` |
| `9…` | 65 | 179 | **all failed**, `AccountNumberInvalid` |

Zero overlap. Prefix `3` and `8` are Claro Honduras ranges; **prefix `9` is
Tigo** ([Telephone numbers in Honduras](https://en.wikipedia.org/wiki/Telephone_numbers_in_Honduras)).

Every one of the 179 failing attempts logs exactly one attempt:

```json
resolution.path     = "discovery"
resolution.operator = ""                       // lookup inconclusive
resolution.attempts = [{"sku_code":"HN_CL_TopUp","code":"AccountNumberInvalid","success":false}]
response.ErrorCodes = [{"Code":"AccountNumberInvalid","Context":"ProviderRefusedRequest"}]
```

`HN_TG_TopUp` was **never sent, not once**, despite being pinned in every
version of the survey.

Mechanism, all three links confirmed in code:

1. `GetAccountLookup` returns two Items for every `+504` number (`CLHN`+`S5HN`
   or `PQHN`+`TGHN`, sharing the regex `^504([0-9]{8})$`), so
   `detectOperator` (`payment.go:869`) reports "inconclusive" → `PathDiscovery`.
2. `pinnedCodes` (`payment.go:492`) sorts candidates alphabetically → `CLHN`
   always before `TGHN`.
3. `decideCascade` (`payment.go:566`, **v0.3.1**) returns `actionReturn` on
   `CodeAccountNumberInvalid` — "The account number itself is bad. No other
   product can help." That premise is false: DingConnect documents
   `Context: ProviderRefusedRequest` as *"the target account is not eligible for
   the chosen product"*, i.e. it is also the wrong-operator answer.

**The fix has shipped.** `go-dingconnect` commit `9a1f30a` (2026-09-12,
released as **v0.3.2**) advances the cascade on `AccountNumberInvalid` when
`hasNext`. `dinersclub` picked it up in commit `0467e938`, tagged
`dinersclub-v0.0.53`, and both `vstag` and `vprod` have run that image since
2026-09-12. See §5.1 for the verification.

Cost: 68 Honduran participants reached a payment, **29 were paid, 39 were not** —
a 57 % failure rate entirely attributable to this.

---

## 3. Argentina — three separate things, none of them "the participant mistyped"

### 3a. `|e164` strips the Argentine mobile `9` (every AR payment)

`replybot/lib/typewheels/form.js:83` — `e164: v => normalizePhone(v, '', false)`
— runs `phone@2.4.22`, which **removes the 9** from Argentine mobiles:

```
phone('+5491124020794','',true) -> ['+541124020794','ARG']
```

Verified against production data: **every** AR `account_number` we have ever
sent is `+54` + 10 digits. Not one carries the `9`, including the 114 that were
paid successfully. So the missing `9` is not on its own fatal — DingConnect
accepts the 9-less form — but we are silently sending a number the participant
did not type, in a form that is not the canonical mobile E.164. Whether the AR
SKUs' `ValidationRegex` or the operators' portability lookup behave differently
with the `9` is **not established**; DingConnect's public docs do not say.

### 3b. `|e164` and `validatePhone` both default to country `US`

Both the transform (`form.js:83`) and the validator
(`replybot/lib/generic-validator.js:193`, `phone(r,'',true)`) pass an empty
default country. `phone` then falls back to **USA**:

```
phone('3404435349','',true) -> ['+13404435349','USA']   // accepted as valid
```

So a participant who types their national number without `+54` passes
validation and we attempt a payment to a **US** number. Observed in production:

| study | distinct wrong-country numbers sent | participants |
|---|---|---|
| `lacar` | 20 (`+1…` ×17, `+55…`, `+351…`) | 18 |
| `lacbo` | 6 (`+1`, `+509`, `+56`, `+592`, `+7`) | 6 |
| `lachn` | 1 (`+502…`) | 1 |

These are the only failures in the whole set whose `Context` is
`AccountNumberFailedRegex` (33 AR + 5 BO + 1 HN attempts) — genuine malformed
input. Most participants recovered by retyping with `+54`; **2** are still stuck
on it.

The `pay_1_phone` field carries **no `validate.country`** metadata in any
version of any of the three forms. Setting it (AR/BO/HN per study) would both
reject the input and stop the US rewrite.

### 3c. Three back-to-back top-ups trigger an operator repeat-refusal

`lacarpay1es` sends `p1a`, `p1b`, `p1c` — 3 × ARS 1 000 — within ~15–30 s of
each other. Per distinct AR number:

| operator | always paid | mixed (paid *and* refused) | never paid |
|---|---|---|---|
| `CLAR` (Claro) | 12 | **39** | 2 |
| `PRAR` (Personal) | 54 | 0 | 10 |
| `TFAR` (Movistar) | 23 | 0 | 13 |
| none (discovery) | 0 | 0 | 26 |

The `mixed` column is entirely Claro, and the shape is always the same —
`p1a` succeeds, `p1b`/`p1c` come back `AccountNumberInvalid` seconds later,
then succeed on a later retry, then tip over into `RateLimited`. Example
(`userid 5491178898074`, one number, 2026-09-11 22:25–22:31): p1a ✓, p1b ✗,
p1a ✓, p1b ✗, p1a ✓, p1b ✗, p1a ✓, p1b ✓, p1c ✗, then 10 × `RateLimited`.
That is a per-account velocity rule, provoked by our own payment design, not by
the number. All **10** of the AR failures whose number was paid on another
payment id are `CLAR`.

### 3d. The residual 16 — not typos, cause unproven

16 AR participants end on `AccountNumberInvalid` with a well-formed `+54`
number, an operator resolved (`TFAR` 8, `PRAR` 7, `CLAR` 1), `Context:
ProviderRefusedRequest`, and **every** attempt refused. **14 of the 16 sent the
participant's own WhatsApp number** (`account_number == '+54' + userid[3:]`),
which is by construction a live mobile line. These are not mistyped numbers.

Two candidate causes, neither provable from our data:

- **Wrong operator, no fallback.** On `PathPinned` there is exactly one
  candidate, so a mis-resolved operator is terminal. Direct evidence:
  `userid 5493534796633` answered `"+54 9 353 479 6633 claro"`, then
  `"...claro argentina"`, then `"Claro"` — we resolved **`PRAR` (Personal)** and
  refused 11 times without ever trying `CLAR`. Argentina has had mobile number
  portability since 2012; a 9-less number makes the lookup harder, not easier
  (see 3a).
- **Ineligible line.** `userid 5491170659750` replied
  *"No es prepaga es con abono"* — a postpaid line, which airtime top-up
  products generally cannot serve. Genuinely unpayable, correctly refused.

Note the asymmetry: `PRAR`/`TFAR` have **zero** mixed numbers — a number either
always works or never works on them — whereas `CLAR` is dominated by mixed.
That is consistent with "wrong operator / ineligible line" for PRAR and TFAR and
"velocity rule" for CLAR.

---

## 4. Two things that made it worse for the respondent

**The failure message tells them the wrong thing.** `pay_1_fail` reads *"Suele
ser porque al número le falta un dígito"* ("usually because the number is
missing a digit"). `AccountNumberInvalid` is classified **permanent**
(`dinersclub/classify.go`), so the respondent is released to the form and
re-asked. 39 Honduran participants whose numbers were perfectly correct retyped
them 4–15 times each and concluded the study was a fraud —
`"Ese es mi número"`, `"El numero esta bien"`, `"Son unos mentirosos"`,
`"Estáfadores 😡"`. The message is accurate only for the ~3 % of cases whose
`Context` is `AccountNumberFailedRegex`.

**`distributor_ref` and `account_number` disagree in the `_re` fields.** Every
`p1*_send_re` variant uses `account_number: {{field:pay_1_phone|e164}}` but
`distributor_ref: lac??_{{hidden:phone}}_p1*`. `hidden:phone` is not always set,
which produces refs like `lacar__p1` — visible in the 3
`INVALID_PAYMENT_DETAILS` results. Cosmetic here (the ref is not a working
idempotency key anyway, per `go-dingconnect/CLAUDE.md`), but it makes support
lookups by ref unreliable.

---

## 5. What would change

Ordered by how much of the 67 it recovers.

1. **Ship `go-dingconnect` v0.3.2 in dinersclub** — **DONE, 2026-09-12.**
   Commit `0467e938` bumps `dinersclub/go.mod` to v0.3.2 and `versionDinersclub`
   to `v0.0.53` in both values files; CI built the image from tag
   `dinersclub-v0.0.53`; `vstag` (helm revision 105) and `vprod` (revision 670)
   both run `ghcr.io/vlab-research/dinersclub:v0.0.53`, identical digest
   `sha256:8b31e0c2`, healthy since.
   This recovers the Honduras 39 for **future** participants only. The existing
   39 were already released from `WAIT_EXTERNAL_EVENT` and **still need a
   deliberate re-drive** — that has not been done.
2. **Give `pay_1_phone` a `validate.country`** per study (AR/BO/HN) so a bare
   national number is rejected at the question instead of being rewritten to a
   US number. Removes the `AccountNumberFailedRegex` class (39 attempts across
   the three studies) and the `+1` payments.
3. **Rewrite `pay_1_fail`.** Branch on
   `e_payment_dingconnect_error_message` / `_resolution_*` instead of asserting
   "missing a digit". A `ProviderRefusedRequest` on a well-formed number should
   say "that number's operator would not accept the top-up — try a different
   number", not "check your digits".
4. **Space the AR top-ups**, or send one ARS 3 000 top-up instead of three of
   ARS 1 000. The `p1a`/`p1b`/`p1c` burst is what produces the Claro refusals
   and the `RateLimited` cascade behind them.
5. **Consider a fallback on `PathPinned`.** The HN fix only covers discovery. A
   single mis-resolved operator on the pinned path is still terminal, which is
   the best available explanation for part of §3d. Before that, measure: run
   `GetAccountLookup` against a sample of the 16 AR numbers, with and without
   the `9`, and see whether the operator it names changes.

---

## 6. Provenance

- `chatroach.surveys` — 31 versions across the three shortcodes; the payment
  block is stable apart from `account_number` moving from `{{hidden:phone}}` to
  `{{field:pay_1_phone|e164}}` and BO/HN amount changes. No version difference
  explains the failures.
- `chatroach.messages` — 1 638 payment results for LAC users on
  `pageid=1203867182815254`; 1 090 are `p1*` results in the three pay-1 forms.
  Driven from a `chatroach.states` userid list, never scanned by account/time.
- `chatroach.responses` — 2 080 `pay_1_phone` answers, used to compare typed
  input against the `account_number` we sent.
- `replybot/lib/typewheels/form.js`, `replybot/lib/generic-validator.js`,
  `phone@2.4.22` (behaviour confirmed by running it).
- `go-dingconnect` v0.3.1 (the version that produced the failures analysed
  here) vs v0.3.2 (fixed; live since 2026-09-12).
