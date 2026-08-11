# Tigo Money (Millicom MFS) — Provider Evaluation Findings

**Date**: August 1, 2026
**Status**: Evaluated — **not recommended to build now.** Shelved with explicit
revisit triggers (see "When to revisit").
**Context**: Investigated as a payout rail for Honduras, where mobile top-up is
unusable at survey-incentive amounts (both Reloadly and DingConnect floor at
$7–14 against a correct incentive of ~$1.30–2.25).
**Target if built**: a `TigoMoneyProvider` in the `dinersclub` package.

---

## Executive Summary

Tigo Money is Millicom's mobile wallet, operating in **Guatemala, El Salvador,
Honduras, Bolivia and Paraguay**, with ~15M wallet users across LatAm as of the
2025 annual report. It offers a partner API with a genuine disbursement
primitive: pre-funded e-money float, push into end-user wallets keyed on phone
number, plus account validation, reversal and status endpoints — and, unusually
for this space, **a real sandbox**.

On paper it is the right instrument for LatAm cash incentives: no bank account,
no redemption step, the wallet ID is the MSISDN we already collect, and 84% of
Honduran users had no prior banking relationship, so the base skews to exactly
the unbanked, lower-income segment our ad-recruited samples target.

**We are not building it, for three reasons:**

1. **Reach is unproven and probably insufficient.** Wallet penetration is far
   below airtime penetration. Honduras had >1M users as of ~2022 against 6.9M
   mobile subscribers; no current Honduras-specific figure is published. We would
   be trading a rail that reaches ~99% of subscribers (but costs 4× too much) for
   one that costs the right amount but may reach a quarter of them.
2. **Onboarding is a commercial project, not an integration.** Signed NDA,
   company KYC, 2-way SSL certificate exchange, IP whitelisting, per-country MFS
   account provisioning, and — the blocker — **a bank account at a local bank in
   each market** to fund the float.
3. **The per-transaction minimum is undisclosed and could kill it anyway.** The
   error catalogue has a "below minimum transaction limit" code with
   country-specific values that are not published. If Honduras floors above
   ~L 50, we have spent the integration cost to arrive at the same wall.

The upside case is real but is a *portfolio* case, not a Honduras case: one
Millicom relationship would cover five LatAm markets. Revisit when LatAm volume
justifies it.

---

## Business

### Commercial model — pre-funded e-money float

We deposit real local currency into a bank account designated by the Tigo
operation in-country and receive a mirrored e-money balance on the MFS platform.
Disbursements draw down that float. Settlement between real money and e-money is
agreed bilaterally per market.

Millicom's guide classifies partner accounts into two kinds; we would need the
first:

| Account type | Purpose | Products |
|---|---|---|
| **Pre-Funded** | Partner holds e-money in advance to push into end-user wallets | **Disbursements**, remittance transfers, transfers |
| Collection | Partner receives transfers from end users | Payments, purchases, bill pay |

This is a materially different operational posture from Reloadly/DingConnect,
where we hold a distributor balance in USD with a single global provider. Here we
would hold **per-country local-currency float**, with per-country treasury,
reconciliation and FX exposure.

### Onboarding requirements

Per-market MFS account opening requires:

- Signed NDA
- Company KYC: business name, business licence, tax identification number,
  stated capital, contact persons and their IDs
- **Bank account details for an account at a local bank**

Then, platform integration (guide §3.2):

1. Register with Millicom Tigo
2. Acquire an Apigee API key and secret
3. **Exchange SSL certificates for 2-way SSL**
4. Have MFS accounts created per country (account number + PIN code known)
5. Submit connecting server IPs for whitelisting

The local bank account is the hard item. It is plausibly weeks-to-months of
company formation or banking-relationship work per market, and it is the reason
this is a business decision rather than a sprint.

### Market coverage and the portfolio argument

Tigo Money operates in **Guatemala, El Salvador, Honduras, Bolivia, Paraguay**.
Millicom leads mobile in six markets (El Salvador, Guatemala, Honduras,
Nicaragua, Panama, Paraguay). One relationship therefore unlocks five wallet
markets and complements our existing top-up coverage.

For a single 2,250-transaction study this is not worth it to either party. If
LatAm becomes a recurring corridor for us — and the current World Bank pipeline
suggests it might — the calculus changes.

### Respondent-side economics (Honduras, from Tigo Money T&Cs)

| Item | Value |
|---|---|
| Max wallet balance | L 15,000 |
| Monthly throughput | L 30,000 (app) / L 40,000 (agents) |
| Monthly transaction count | 100 (app) / 50 (agents) |
| Cash-out fee, paid by recipient | **6%** on L 1–1,999.99; 5% to L 3,999.99; 4% above |
| Transfer between users | L 1.00 |
| Registration | 18+, resident in Honduras, personal ID |
| Regulator | Banco Central de Honduras; supervised by CNBS |

A L 50 incentive sits far below every limit. The 6% cash-out fee is avoidable in
practice — wallet balance buys Tigo airtime and Paquetigos directly, pays at
~12,500 merchants, settles bills, and funds a free Tigo Money Visa card. Spent
rather than withdrawn, the incentive keeps full face value.

---

## Dev

### Source and its age

*Millicom Global Mobile Financial Services Partner Developer's Guide*, **v0.12,
dated 2015–16**. Millicom has since spun Tigo Money out as a distinct fintech
unit, partnered with Visa and launched Tigo Pay. **Treat every endpoint below as
indicative.** The account model and onboarding structure are likely still
accurate; the wire format may not be. Re-request current documentation before
writing any code.

### API surface

Base: `https://secure.tigo.com/v1/`
**Sandbox: `https://securesandbox.tigo.com/v1/`** — worth noting, since
DingConnect has no sandbox at all and Reloadly's is limited.

| Operation | Endpoint | Notes |
|---|---|---|
| Generate access token | `POST /v1/oauth/generate/accesstoken?grant_type=client_credentials` | OAuth client-credentials; token is time-limited, expires per session |
| System status heartbeat | `GET /v1/tigo/systemstatus` | Useful for a provider health check |
| **Validate MFS account** | `POST /v1/tigo/mfs/validateMFSAccount` | Confirms a MSISDN has a wallet **before** we promise an incentive |
| **Deposit remittance (disburse)** | `POST /v1/tigo/mfs/depositRemittance` | The payout call |
| Reverse transaction | `POST /v1/tigo/mfs/reverseTransaction` | |
| Deposit status | `GET /v1/tigo/mfs/depositRemittance/transactions/<ref>` | |

Payment-authorization endpoints (`/v1/tigo/payment-auth/*`) are the *collection*
direction — pulling money from users. Not relevant to us.

Transport is HTTPS with **2-way SSL**; the gateway additionally enforces IP
whitelisting (`A.6.2.1: IP address not whitelisted`).

### `validateMFSAccount` is the interesting primitive

Neither Reloadly nor DingConnect gives us a clean pre-flight "can this person
actually be paid?" check that we act on before the survey ends. DingConnect's
`lookup` resolves a number to a provider; this resolves a number to *a funded,
payable wallet*.

That enables a flow our current providers cannot support: ask for the number
early, validate, and route respondents without a wallet to a different incentive
or screen them out — rather than discovering the failure at payout time and
eating both the ad spend and the completed survey.

If we build this, `validateMFSAccount` is arguably more valuable than
`depositRemittance`.

### Error handling

Errors are coded per operation, e.g.:

| Code | Meaning |
|---|---|
| `depositremittance-3017-0000-S` | Success |
| `depositremittance-3017-3013-E` | **Below minimum transaction limit** |
| `depositremittance-3017-…` | Above maximum transaction limit |
| `depositremittance-3017-2501-F` | Backend down — retryable |
| `depositremittance-3017-2502-F` | Timeout — retryable |
| `depositremittance-3017-2505/2506-F` | OWSM auth failure — Tigo-internal |

The `-S` / `-E` / `-F` suffix appears to encode Success / Error / Failure, which
maps cleanly onto a retryable-vs-permanent classification. **Confirm this rather
than assume it** — we made exactly this mistake with DingConnect, where
`InsufficientBalance` arrives as HTTP 500 despite being permanent.

**The minimum-transaction-limit values are not in the guide and are
country-specific.** Getting the Honduras number is the first question to ask
Millicom, before any other work. It determines whether the rail is viable at all.

### Integration shape

A `TigoMoneyProvider` fits the existing `dinersclub` `Provider` interface
directly:

```go
type Provider interface {
	GetUserFromPaymentEvent(*PaymentEvent) (*User, error)
	Auth(*User, string) error
	Payout(*PaymentEvent) (*Result, error)
}
```

- `Auth` — OAuth client-credentials token fetch, cached until expiry. Fits the
  existing cached-credential system.
- `Payout` — `depositRemittance`, with the partner MFS account (MSISDN + PIN) for
  the target country pulled from config.
- New surface with no home in the current interface: **`validateMFSAccount`**.
  It wants to be called during the survey, not at payout. That likely means a
  separate lookup path rather than a `Provider` method — worth designing
  deliberately if we build.

Follow the `go-dingconnect` precedent: a standalone zero-dependency client
library in its own repo, consumed by a thin `dinersclub` adapter. All wire-format
and error-classification knowledge lives in the library.

Two things that differ structurally from our existing providers and need design
attention:

1. **Per-country credentials.** Each market has its own MFS account number and
   PIN. Config is no longer one global key pair.
2. **Float management.** Someone must monitor and top up per-country e-money
   balances. Reloadly and DingConnect give us a single balance to watch; this
   gives us N. Needs alerting before it needs code.

---

## Alternatives considered for the same problem

| Option | Verdict |
|---|---|
| Reloadly / DingConnect top-up | Works everywhere except Honduras. HN floors at $7.00 (Reloadly) / $8.15 (Ding) against a correct incentive of ~$2 |
| dLocal payouts | Honduras supported, but **bank transfer only**, requiring DNI + bank account. Wrong instrument for an unbanked ad-recruited sample |
| MoneyGram / WU → Tigo Money | Real rail (Tigo Money's documented inbound channels), but flat remittance fees of $2–5 equal or exceed the incentive |
| Thunes | Honduras absent from published implementation insights; unconfirmed. One API call with an account would settle it |
| TerraPay / Nium / Paysend | No published Honduras wallet coverage; unconfirmed |
| AirTM | 0.01 USDC minimum, good AR/BO footprint, weak in Honduras; recipient must hold an account |

---

## Open questions for Millicom

1. **What is the minimum `depositRemittance` amount in Honduras?** (And Bolivia,
   Guatemala, El Salvador, Paraguay.) This gates everything.
2. Current Honduras-specific Tigo Money active user count.
3. Is a local bank account genuinely required per market, or can float be funded
   cross-border?
4. Disbursement tariff — what does *the sender* pay per transaction?
5. Is the v0.12 developer guide still current, and is there a newer API
   (post-Tigo-Pay / post-Visa)?
6. Onboarding timeline from NDA to first sandbox transaction.
7. Can one commercial agreement cover multiple markets, or is it per-country?

---

## When to revisit

Build this when **any two** of the following are true:

- We have ≥3 active or pipelined LatAm studies in Tigo Money markets
- A client specifically requires cash-equivalent (not airtime) incentives in
  Central America
- Millicom confirms a Honduras minimum at or below ~L 50 **and** a current
  wallet-user count that implies >40% subscriber penetration
- Top-up providers confirm they will not lower the Honduras floor, and Honduras
  becomes a recurring market for us rather than a one-off

Until then, Honduras incentive strategy is: pay the $7.52 top-up floor and price
it honestly to the client, or reduce n in that market.

---

## Sources

1. Millicom International Cellular, *Global Mobile Financial Services Partner
   Developer's Guide*, v0.12 (2015–16).
   https://usermanual.wiki/Document/tigoonlinepaymentapiguide.1589487399/html
2. Tigo Honduras, *Términos y condiciones de Tigo Money*.
   https://ayuda.tigo.com.hn/hc/centro-de-ayuda/articles/1740437803-cuales-son-los-terminos-y-condiciones-de-tigo-money
3. Millicom 2025 Annual Report coverage (15M LatAm wallet users), 2026-03-24.
   https://www.globenewswire.com/news-release/2026/03/24/3261824/0/en/millicom-tigo-publishes-its-2025-annual-report-highlighting-record-financial-results-and-expanded-regional-footprint.html
4. Proceso Digital / FUNDER — Tigo Money Honduras user base, financial-inclusion
   figures (>1M users, 84% previously unbanked, ~12,500 merchants).
5. Provider coverage research and country files:
   `vlab-research/proposals/countries/{AR,BO,HN}.md`
6. Related: `dinersclub-findings.md`, `dingconnect-plan.md`,
   `dingconnect-api-findings.md`
