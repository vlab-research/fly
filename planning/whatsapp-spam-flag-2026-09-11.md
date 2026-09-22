# WhatsApp "sending spam" flag — findings, 2026-09-11

Meta emailed on 2026-09-11 that WABA **1054445344147090 ("Virtual Lab")** was
identified as sending spam. This is what the production database and the Graph
API say about why. Data sources: `chatroach.states`, `chatroach.messages`
(the raw event log — `chat_log` has been empty since 2026-07-27, see
`documentation/chat-message-logging.md`), Graph API `health_status` /
`quality_rating`, AlertManager.

## Where we stand with Meta (Graph API, 2026-09-11 ~14:00 UTC)

| Entity | Status |
|---|---|
| Number **+1 541-920-2635** (`phone_number_id 1203867182815254`) | `quality_rating: RED`, `code_verification_status: EXPIRED`, still `CONNECTED` |
| Number +1 202-972-1437 (`1232376313299608`) | quality UNKNOWN (unused) |
| WABA 1054445344147090 | `can_send_message: BLOCKED`, error **141006** "error with the payment method — blocks business-initiated conversations" |
| WABA 1315376680419300 (the `waba_id` stored in `credentials`) | `AVAILABLE`; lists the **same two numbers** |
| Digital Insights number +1 202-862-5969 (WABA 1989932528352675) | GREEN, healthy |

Two WABA ids answer for the same numbers. Meta's email names 1054445344147090;
our credential row stores 1315376680419300. Worth resolving in Business Manager
before any template CRUD is attempted against the "wrong" one. The 141006
payment-method error is independent of the spam flag but also needs fixing —
it blocks any business-initiated (template) send.

## Ruled out

- **Template / business-initiated sends: none in production traffic.** Over the
  whole life of the number, 4 template echoes, all to one test user
  (2026-08-09 … 08-26). No `marketing`/`utility` pricing category on any
  status event except those 4. Every real conversation was `service` /
  `free_customer_service` or `referral_conversion` / `free_entry_point`
  (click-to-WhatsApp ads, LAC study).
- **Dean re-sends: not a meaningful driver.** 4,613 `redo` events since
  2026-08-31, but only **194 were followed by an outbound message** — 90% hit
  the 201 erased-`md` `ERROR` states (the open incident in
  `planning/platform-guess-expiry.md`) and fail before sending. `follow_up`
  179, `timeout` 10, `repeat_payment` 15. The follow-ups did cause the only
  out-of-window sends: ~55 `status: failed` / **131047** "Re-engagement
  message" (free-form send >24h after last inbound, rejected by Meta, never
  delivered).

## What actually happened — three compounding things

### 1. The Nigeria smoke survey went viral (2026-08-31 21:00 → 09-01 14:00 UTC)

`vlpulseng` ("VL Pulse Nigeria - Smoke", owner nandanmarkrao@gmail.com, 500 NGN
airtime via Reloadly). One referral link (`r.AQl2bHB1bHNlbmfryTC5uw` — 400/400
sampled first messages) was shared and **11,791 Nigerian numbers** started the
survey, 6,620 of them in the single hour 22:00–23:00 UTC.

| | |
|---|---|
| Outbound messages on 2026-08-31 | **120,557** to 10,650 users (18,559 of them validation nudges/repeats) |
| Users who answered consent | 8,217 |
| Reached the payment step (`mobile_provider`) | 6,636 |
| Got a payment attempt (`reloadly_ty`) | 2,361 |
| Reached `ty_done` | 212 |

Between 00:20 and 01:59 UTC and again 15:00–15:59 UTC on 2026-09-01, **11,961
`block_user` events** were posted (manual — Dean's `spammers` cron only runs at
03:30 and emitted 3). Result: 11,209 `vlpulseng` conversations are
`USER_BLOCKED`; ~4,300 users had given a phone number for airtime and were
cut off before any payment; 1,322 blocked users *had* a successful payment
recorded; 141 a failed one. **1,140 users messaged again on 2026-09-01 after
being blocked and got no reply**, with a trickle (25–30/day) still arriving.
Content of those messages: "I don't see any airtel ooo", "This is not good at
all", "Hello".

This is the population that reported/blocked the number. A RED quality rating
is driven by user block/report rate over the last 7 days; a paid survey that
went viral, paid a minority, then went silent on thousands is the textbook
trigger.

### 2. LAC Bolivia payments are failing — DingConnect has no balance (since 2026-09-10)

`lacbopay1es` ("LAC Healthy Diets – Bolivia Pay 1"). The active
`PaymentUnclassifiedErrorCode` alerts are `InsufficientBalance` (since
2026-09-10 22:18) and `AccountNumberInvalid`. DingConnect results for LAC
users:

| day | success | InsufficientBalance | PIN_DRIFT | other |
|---|---|---|---|---|
| 09-09 | 67 | 0 | 24 | 9 |
| 09-10 | 78 | 68 (14 users) | 33 | 21 |
| 09-11 (to 14:00) | 0 | **239 (54 users)** | 2 | 1 |

The survey loops on failure: `pay_1_phone` → `p1_send` ("Still working on it")
→ `pay_1_fail` → `pay_1_phone` again. Every retry the participant makes costs
**3 outbound messages**, and participants retry hard — one user re-sent the
same valid `+591 …` number 11 times in 6 minutes ("Ya van como 20 veces que me
lo piden"), then 15 stickers, each sticker earning a nudge + repeat. This is
the `survey_stuck_users{form="lacbopay1es"}` = 10 signal (54 states stuck on
`pay_1_phone`, 21 more on a null question). Per-user outbound for the stuck
cohort averages 126 messages; the worst real participant has 167.

Validation is **not** the problem — `translate-typeform` 0.2.17 accepts
`+591 62598216` (verified locally against the exact field definition). The
phone is accepted, the top-up is attempted, and DingConnect refuses it.

### 3. Structural: validation loops are 16% of all WhatsApp outbound

Across the number's lifetime: 138,030 bot messages, of which 11,142 nudges +
11,134 repeats (5,289 users). Each failed validation is two messages. 258
users have received 60+ messages; 94 more 30–59.

## Suggested actions (not taken — decisions for a human)

1. **Top up DingConnect now.** Every Bolivia participant reaching payment today
   is being looped and will report us. This is the only live fire.
2. **Stop the Bolivia loop from re-asking on provider failure** — a
   `pay_1_fail` that leads back to `pay_1_phone` turns a balance problem into
   a message storm. Route provider-side failures (InsufficientBalance,
   ProviderError, RateLimited) to a "we'll retry, no action needed" wait
   rather than re-prompting; Dean's `payments` cron already exists to retry.
3. **Decide what to do with the ~11k blocked Nigerians.** Either pay the
   ~4,300 who gave a number (a template is now the only way to reach them,
   which needs the WABA payment method fixed first) or accept the reports and
   let the 7-day window roll off. Silence is what earned the flag.
4. **Fix the WABA payment method (141006)** and reconcile which WABA id is
   canonical; update `credentials.details.waba_id` if it is 1054445344147090.
5. **Rate-limit nudges** — cap repeats per question per hour, or after N
   failed validations send one message and go quiet. Both platforms.
6. Consider a per-account inbound surge breaker (new conversations/hour) so a
   viral link cannot start 6,600 paid surveys in an hour again.

## Queries used

Scratchpad SQL is not committed; the shapes are: states by
`pageid='1203867182815254'` grouped by `current_form,current_state`;
`messages` joined to those userids (index is on `userid`, so always drive from
`states`) classified by `content::jsonb` (`source=synthetic` → event type,
`status` + `pricing.category`, `type=bot_echo` + `metadata.repeat/isRepeat`);
DingConnect outcomes from `event.value.error.code` on `type=external` events.

## Update 2026-09-14 — account locked

- **Lock time: 2026-09-13 08:00 UTC.** Last `sent` status 07:00:20, first
  `131031 "Business Account locked"` failure 08:00:07. Every outbound since
  fails with 131031. Graph API still reports the number `CONNECTED` / RED and
  WABA 1315376680419300 `AVAILABLE`; the lock is only visible in status
  webhooks and in WhatsApp Manager.
- **Message-worker sees success.** Meta accepts the send (202) and fails it
  asynchronously, so `command processed successfully` is logged and replybot
  leaves the participant in `QOUT`. Nothing in hermes/replybot/message-worker
  handles `status: failed` webhooks (grep for `131031` / `"failed"` finds no
  handler), so these participants are not `BLOCKED`, Dean will not retry them
  when the lock lifts, and no alert fires. Inbound keeps arriving (AR, HN, BO,
  NG, IN, CL numbers) and gets no reply.
- **Between the warning email and the lock**, LAC Argentina + Honduras went
  live (2026-09-11 17:00 UTC, click-to-WhatsApp ads): 31,365 outbound to 526
  users in 29h, peaks of 3,300/hour, top conversations 150–238 messages,
  2,176 validation repeats, 461 `pay_1_fail` loops. DingConnect was topped
  up on 09-12 (InsufficientBalance stops) but `AccountNumberInvalid` (397)
  and `RateLimited` (132) kept failing payments and re-prompting.
- WABA 1054445344147090 is not owned by business 492613781268090
  (`owned_whatsapp_business_accounts` lists only 1315376680419300 and
  1989932528352675) yet returns the same numbers and the same template object
  ids. App Dashboard → WhatsApp → API Setup lists three number/WABA pairs;
  the pairing for +1 541-920-2635 is the one to record here.

## Retry / spam-pattern audit (run 2026-09-14, all traffic since 2026-08-05)

373,873 non-status events across 15,423 conversations on +1 541-920-2635.

| Dean / synthetic event | events | followed by a send within 90s |
|---|---|---|
| `block_user` | 11,965 | 0 |
| `redo` | 4,687 | 266 |
| `external` (payment results) | 3,631 | 3,314 (the normal "paid / failed" message) |
| `follow_up` (reminder) | 567 | 566 |
| `repeat_payment` | 84 | 3 |
| `timeout` | 10 | 4 |

Dean-originated sends total ≈ 840 of ~190,000 outbound (<0.5%).

Runs of consecutive bot messages with no inbound in between: 147,169 runs
of 1–2, 3,382 of 3–4, 287 of 5–9, 2 of 10–19 (one user). There is no
unattended blast pattern; essentially every outbound is a reply.

Same question re-sent to one person ≥3× within an hour (validation and
payment loops, user-driven): `phone_number` 631 user-hours (max 21/h),
`reloadly_ty` 468 (max 39/h), fallback-form field 398, `pay_1_phone` 225
(max 25/h), `consent_1` 243 (max 38/h). Exact duplicate sends within 3s:
140 messages to 51 users.

Per-user-per-day outbound: 417 user-days of 100–199 messages, 2 of 200+,
all LAC (AR/HN/BO) on 2026-09-10..12.

Conclusion: no retry storm. The volume is the survey engine replying in
real time, amplified by validation loops and the pay-fail → re-ask loop.
The reports that produced the RED rating are consistent with unpaid
participants (Nigeria after the block; LAC after DingConnect failures),
not with unsolicited sends.
