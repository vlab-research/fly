# Payment Provider Landscape — Mobile Top-up Competitors & Alternative Rails

_Researched 2026-09-10/11 via web research sub-agents. Provider figures are from
marketing pages and docs as fetched; numbers change fast and must be re-verified
against live fee sheets / rate cards before any build decision. Confidence flags:
where a fact could not be confirmed from a primary source it is marked
`[uncertain]` or `[not verified]`._

Purpose: answer two questions — (1) who competes with Reloadly and DingConnect
for **mobile top-up** (airtime + data), and (2) what other payment rails exist
for sending value to respondents worldwide. Feeds the `proposals/INCENTIVES.md`
mechanism-choice step; the recommendations here map directly to its
"Providers we can reach today" table.

---

## 1. TL;DR

- The genuine **global** airtime/data aggregators are **three**: Reloadly, Ding
  (DingConnect), and **DT One** (ex-TransferTo). We already use the first two.
  DT One is the coverage leader (190 countries, eSIM, vouchers, utilities).
- **Regional providers** fill gaps the globals miss: **Tranglo Recharge**
  (South-East Asia / South Asia), **dLocal** (LatAm rails + Pix), and the African
  wallet/mobile-money rail players (Onafriq, Cellulant/Tingg, Flutterwave Bills).
- The biggest **structural gaps**: no dedicated MENA-regional top-up aggregator
  exists; no public self-serve operator top-up APIs in India/Indonesia/Philippines
  (sales-gated / wallet-mediated).
- For **money movement beyond top-up**, two complementary additions rank highest:
  a **wallet/bank payout aggregator** (Thunes or TerraPay for Africa/SA/SEA) and a
  **digital gift-card / prepaid-Visa layer** (Tremendous/Tango for zero-recipient-KYC).
- For **Latin America specifically**, **dLocal is deeper than Thunes** (Pix,
  SPEI/CLABE, Bre-B, Yape/Plin); Thunes' LatAm is bank-rail-only.
- **Brazil** is a special case: Pix (Banco Central instant rail) is the dominant
  system; keep airtime on Reloadly/Ding/DT One, add Pix payout via dLocal or EBANX.

---

## 2. Global top-up aggregators

| Provider | HQ (founded) | Coverage | Products | Pricing / self-serve | vs Reloadly & DingConnect |
|---|---|---|---|---|---|
| **Reloadly** | Barcelona, ES (`[uncertain]` ~2018) | ~170 countries, 800+ operators, 120+ direct telco | Airtime, data, gift cards, utility/bill pay, payout links ("Perq") | Usage-based, no contracts/subscription; SDKs in 6 languages, sandbox, no-code plugin | Our incumbent; developer-first |
| **Ding / DingConnect** | Dublin, IE (2006, as ezetop) | 150+ countries, 700+ operators | Airtime, data, gift cards | Consumer margins; DingConnect B2B API, white-label + reseller, webhooks, sandbox | Our incumbent; largest consumer brand (4.6★ Trustpilot) |
| **DT One** (ex-TransferTo) | Singapore (+ Dubai), 2005 | **190 countries**, 2,800+ partners, 23k+ products | Airtime, data, **eSIM**, branded vouchers/gift cards, utilities/bill pay | Wholesale margin; micro-rewards from ~$0.10; developer portal + "DT Shop" self-serve | Deepest coverage + scale (1.2bn+ txns); wholesale/enterprise-leaning |
| **Thunes** | Singapore (2016) | 140 countries, 90 currencies, 220 methods, 145 wallet brands | Payments-first; top-up/vouchers secondary | API-first, pre-funded, sales-led onboarding; no public pricing | Not a true top-up rival — use as payment rail |

Winner-by-dimension:
- **Coverage** → DT One (190) > Reloadly (~170) ≈ Ding (150+)
- **Price transparency / low minimums** → Reloadly (explicit "no contracts")
- **Developer experience** → Reloadly (SDKs, sandbox, no-code) > DingConnect (sales-led) > DT One (wholesale)
- **Reliability signals** → Thunes most funded/licensed (but payments); Ding best consumer trust; DT One largest tx history

---

## 3. Regional top-up / rail providers

### Africa & Middle East

| Provider | Region / coverage | What it fills | Caveat |
|---|---|---|---|
| **Onafriq** (ex-MFS Africa) | ~43 African markets; 1B wallets | Mobile-money interoperability, cross-border payout (not airtime) | Payments/rail, not top-up; dev portal is apidocs.beyonic.com |
| **Cellulant — Tingg** | ~35 markets (E/W/C Africa) | Local mobile money + billers | Payments platform; airtime is incidental |
| **Flutterwave Bills** | 34 African countries (strong NE/GH/KE/UG) | Airtime + data + utility bill APIs | Payments-first; airtime incidental |
| **Interswitch / Quickteller** | Nigeria core + KE/UG/GH | Best Nigerian bill/airtime coverage via local rails | Nigeria-centric |

**Finding:** there is **no dedicated MENA-regional top-up aggregator.** Middle East
top-up is served only by the globals + telco APIs (e&/Etisalat, STC, Zain, Vodafone
EG, Orange). Names like Maviance (`[Cameroon, not ME]`), Terragon (`[martech, not top-up]`),
eRetail (`[unverified]`) do not qualify.

### Latin America & Asia-Pacific / South Asia

| Provider | Region / coverage | What it fills | Caveat |
|---|---|---|---|
| **Tranglo Recharge** | SEA + South Asia; 5,000+ partners, 100+ countries | Airtime + data + bills; the only dedicated Asia airtime API found | Per-country operator lists behind login |
| **dLocal** | 17 LatAm markets + AMEA/APAC | Local payout rails: Pix (BR), SPEI/CLABE (MX), Bre-B (CO), Yape/Plin (PE) | Sales-led, no public pricing; no airtime |
| **RecargaPay** | Brazil only | Consumer recarga + Pix super-app | No public B2B top-up API |
| **Airalo / Gigs** | Global | eSIM / data-only (new category) | Data-only, not airtime |

**Provider-name cleanup** (candidates that are NOT top-up APIs): Gupshup (CPaaS),
Razorpay (payments/UPI), Jio/Airtel/Vi/Telkomsel/Globe/Smart (carrier CPaaS or
sales-gated; no public top-up API), Mobius/Preceo/Zeedee/Baddu/OneFor (`[unverifiable]`).
TransferTo = DT One (same company, rebranded). Telesign/Infobip/BICS = CPaaS/roaming,
compete only indirectly.

---

## 4. Alternative payment rails (beyond mobile top-up)

Selection matrix: which rail to add, given a rewards/top-up product.

| Need | Best rail(s) | Provider examples |
|---|---|---|
| Keep phone-number UX, lowest friction | Wallet payout aggregator | Thunes, TerraPay, Rapyd |
| Zero recipient KYC, low-value, instant | Gift cards / prepaid Visa | Tremendous, Tango Card, RewardLink, Blackhawk |
| Spend-anywhere value | Virtual Visa/MC | Stripe Issuing, Marqeta, Lithic (via aggregator) |
| Banked, higher-value | Instant bank rails | PIX (BR), UPI (IN), SEPA Instant, FedNow/FPS via Nium/Wise/Thunes |
| Unbanked / cash-out | Cash pickup + crypto off-ramp | Western Union, MoneyGram (Stellar), Ria, MoonPay |
| Global single value layer, micro-awards | Stablecoins | USDC (Circle), XLM (Stellar Disbursement Platform), on/off-ramps (Bitso, MoonPay) |

Category short-hand:

1. **Mobile money & e-wallets** — M-Pesa, MTN MoMo, Orange Money, Airtel Money
   (Africa); GCash, Maya, DANA/OVO/GoPay/LinkAja (SEA); Mercado Pago (LatAm);
   bKash/Nagad (BD), JazzCash/Easypaisa (PK), UPI (IN). Mostly single-market,
   sales-gated APIs — reach them through an aggregator, keep 1–2 strategic direct
   integrations (M-Pesa, MTN MoMo, Mercado Pago) where volume justifies.
2. **Global payout aggregators** — Thunes (140 countries, 145 wallets, best Africa/
   SEA wallet depth, $150M Series D Apr 2025), TerraPay (deep Africa + Gulf + South
   Asia, ~3.7B wallets; see §6), dLocal (LatAm-native), Rapyd (broadest catalog),
   Nium (instant bank), Wise Platform (FX transparency).
3. **Gift cards / vouchers** — Tremendous (200+ countries, 2,500+ cards, prepaid
   Visa, PayPal/Venmo); Tango Card; RewardLink; xoxoday/Plum (APAC/MEA catalog).
   Lightest KYC; favorable float/breakage.
4. **Prepaid cards** — Visa Direct / Mastercard Send rails + issuers (Stripe
   Issuing US/EU, Marqeta, Lithic). Heavier KYC than gift cards.
5. **Bank transfer / instant rails** — SEPA Instant, Faster Payments, FedNow, RTP,
   Pix, UPI, CoDi/SPEI, PromptPay, PayNow. Exposed via aggregators.
6. **Cash pickup + crypto off-ramp** — WU/MoneyGram/Ria; MoneyGram Access
   (USDC↔cash via Stellar, ~185 countries); MoonPay/Bitso.
7. **Crypto/stables** — USDC (Circle), XLM + Stellar Disbursement Platform
   (open-source bulk micro-payout tool, ~$0.01/10k txns); on/off-ramps.

---

## 5. LatAm deep-dive: Thunes vs dLocal vs Pix

### Thunes in LatAm — bank-rail only, its thinnest region

| Market | Thunes method |
|---|---|
| Brazil | Bank (TED) + Pix key push |
| Mexico | SPEI (CLABE) only |
| Colombia | ACH + Bre-B (instant) |
| Chile | TEF only |
| Peru | Bank + cash pickup (rare; no Yape) |
| Argentina / DR | Bank only |

Gaps: no Mercado Pago, no Yape/Plin, no named wallets in BR/MX/PE, no cards;
cash pickup only Peru + Jamaica. LatAm ≈ a bank-transfer rail; Africa/SEA are far
deeper (145 wallet brands concentrated there).

### dLocal — LatAm-native, deeper

- 17 LatAm markets; owns local rails (Pix, Bre-B, SPEI/CLABE, Yape/Plin).
- **Pix payout** = `payment_method_id=INSTANT_PAYMENT`, any Pix key (PHONE/CPF/CNPJ/
  email/random). Also Pix Automático / SmartPix / Pix-with-Biometrics (pay-in side).
- Trust: NASDAQ DLO, $41B processed 2025; Muddy Waters short (Nov 2022, denied, no
  regulator finding to date). Sales-led, no public pricing, no self-serve; mid/low
  volume may be routed to partners or dMoRe.
- **No airtime product** — payouts are bank transfer (+ Pix + wallet where supported).

Verdict: **LatAm payouts → dLocal; Africa/SA/SEA wallets → Thunes.** They complement,
not substitute.

### dLocal coverage for the specific markets asked (Bolivia / Honduras / Argentina)

All three are supported, **bank transfer only** (no instant rails, no wallets, no cash):

| Country | Code | Currency | Notes |
|---|---|---|---|
| Bolivia | `BO` | BOB or USD | ~49 banks incl. cooperativas; CI/CE/NIT document ID |
| Honduras | `HN` | HNL or USD | 16 banks; DNI (13) / RTN (14) document ID |
| Argentina | `AR` | ARS (local) | CBU/CVU (22) or **Alias**; full ACH Interbanking + CVU (`000` = Mercado Pago/neobanks) |

Argentina CVU reach is the interesting bit — pays into Mercado Pago/neobanks via
a "000" CVU. None of the three has a Pix-style instant rail.

### Brazil / Pix

- Pix: Banco Central instant rail (2020). ~93% of Brazilian adults, ~R$3.4T/mo.
- Launched internationally 3 Aug 2026 (8 countries) — tourism/payments first;
  cross-border remittance rolling out.
- **A phone number is a valid Pix key**, but only if the recipient registered it at
  their bank; fallback is CPF/email/random key. So phone→Pix is feasible but not
  universal.
- Two distinct rails — do not conflate:
  1. **Pix payout** = send BRL cash-equivalent → dLocal or EBANX.
  2. **Airtime/recarga** = push carrier credit → Reloadly / Ding / DT One (all cover
     Claro/Vivo/TIM/Oi).
  3. Pix is also the standard *funding* layer for locally-initiated recarga, but it
     is not an airtime-delivery mechanism.

---

## 6. Thunes vs TerraPay (wallet payout aggregator shortlist)

Two top candidates for a wallet/bank payout aggregator. Both are pre-funded,
sales-led, unpriced publicly — cost/minimums must come from sales.

| Dimension | Thunes | TerraPay |
|---|---|---|
| HQ / licenses | Singapore; MAS MPI + FCA + ACPR/EU passport + 50-state US MTL | London; FCA + ~32 markets (ISO 22301/27701, SOC 2) |
| Coverage | 140 countries, 145 wallet brands, 8B bank / 15B card | ~3.7B wallets, 7.5B bank; 158 network / 150+ pay-out countries |
| Region strength | Deep Africa + SEA + named wallets; stronger LatAm placement | Deepest Africa + Gulf + South Asia direct mobile-money |
| Cash pickup | Yes (agent network) | Not advertised |
| Stablecoin payout | Yes (USDC/USDT, via third-party) | Not a core line |
| API | docs.thunes.com; REST + callbacks; no self-serve sandbox | developers.terrapay.com; sandbox+SDK; onboarding NDA-gated |
| Funding | $150M Series D (Apr 2025) | >$100M Series B (2023, IFC); profitability self-described; no confirmed unicorn |

For a rewards product paying M-Pesa/MTN/GCash at small ticket, **Thunes** wins on
named-wallet breadth + US/EU licensing + explicit $1 support and stablecoin.
**TerraPay** wins on raw Africa/Gulf/South-Asia mobile-money depth. LatAm for both
is bank-heavy — use dLocal there instead.

---

## 7. Recommendations

Shortlists, mapped to mechanism:

| Goal | Pick |
|---|---|
| Widen top-up coverage (esp. SEA/South Asia) | **DT One** (global breadth) + **Tranglo Recharge** (Asia airtime/data/bills) |
| Africa wallet/mobile-money payouts | **Thunes** or **TerraPay** (Thunes if we also want cash + stablecoin) |
| LatAm cash payouts, incl. Brazil Pix | **dLocal** (or EBANX as Pix-payout alternative) |
| Brazil airtime/recarga | Keep **Reloadly / Ding / DT One** (Claro/Vivo/TIM/Oi) |
| Zero-KYC low-value incentives (US/EU/other) | **Tremendous** / **Tango Card** gift cards |
| Micro-awards / accumulating balances / unbanked reach | **Stellar Disbursement Platform + USDC**, MoneyGram-Stellar cash-out |

Open items to confirm with sales before building:
- DT One / Tranglo exact per-country operator lists and minimums.
- Thunes vs TerraPay corridor-level minimums and FX spreads (both unpriced publicly).
- dLocal Bolivia/Honduras/Argentina: confirm no cash/wallet option is a hard
  limit for those studies, and Argentina CVU target-bank reach.

---

## 8. Sources

Top-up global: reloadly.com, developers.reloadly.com · ding.com / dingconnect.com
· dtone.com / developers.dtone.com · thunes.com / docs.thunes.com · bics.com · comviva.com.
Regional Africa/ME: onafriq.com / apidocs.beyonic.com · tingg.africa / docs.tingg.africa
· developer.flutterwave.com · interswitchgroup.com / developer.interswitchgroup.com
· korapay.com · momodeveloper.mtn.com · developer.safaricom.co.ke · airtel.africa
· maviance.com. Regional LatAm/APAC: tranglo.com / tranglo.com/tranglo-recharge
· dlocal.com / docs.dlocal.com · recargapay.com.br · airalo.com / partners.airalo.com
· gigs.com.
dLocal country payouts: docs.dlocal.com/docs/{bolivia,honduras,argentina}-payouts-v3
(API docs confirm bank-transfer-only for all three).
Alternatives: docs.thunes.com · developers.terrapay.com (bot-blocked; corroborated via
prnewswire Series-B 301788424, blog-us.inter.co) · thunes press (series D, finextra
45886) · tremendous.com · tangocard.com · bhnetwork.com · rewardlink.io · xoxoday.com
· stripe.com/issuing, marqeta.com · circle.com/usdc, stellar.org · eu.europa.eu/SEPA,
npci.org.in/UPI, bcb.gov.br/PIX · westernunion.com/business, moneygram.com, riamoneytransfer.com.
Facts with confidence flags in the body are not re-flagged here; treat all provider
counts as marketing-sourced and re-verify before contracting.
