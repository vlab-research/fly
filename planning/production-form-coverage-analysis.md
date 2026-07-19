# Production Form Feature Prevalence → Test Coverage Analysis

**Branch:** `feature/platform-abstraction-v2`
**Worktree:** `/home/nandan/Documents/vlab-research/fly-platform-abstraction-v2`
**Author:** test-strategy research pass (read-only prod query + code/coverage cross-reference)
**DB:** `chatroach` on `gbv-cockroachdb-0` (vprod) — **all queries run READ-ONLY** (`SET default_transaction_read_only=on`)
**Scope of "recent":** surveys `created > now() - INTERVAL '18 months'` (339 distinct `formid`, 2,084 survey rows); participant weighting from `states` `updated > now() - INTERVAL '6 months'` (~48.5k users).

> This is a research deliverable. **No test code, fixtures, or app code were modified.** Every recommendation is anchored to a real prod number.

---

## 1. Methodology

### 1.1 Feature vocabulary (from code, before touching the DB)
The full custom-behaviour vocabulary was extracted from:
- `replybot/lib/typewheels/machine.js` — `categorizeEvent` (complete event list), `exec`/`apply`/`act` branches (ECHO handling of `md.stitch`, `md.type==='handoff'`, `md.wait`, `md.keepMoving`, `thankyou_screen`, `statement`; payment via `getPaymentFromMessage`; OPTIN one_time_notif tokens; BAILOUT/BLOCK_USER/UNBLOCK/RESTORE_STATE/WATERMARK/REDO/REPEAT_PAYMENT).
- `replybot/lib/typewheels/form.js` — interpolation (`{{hidden:...}}`, `{{field:...}}`), `e164` transform, `seed_N`, logic-jump engine (`getNextField`/`jump`/`getCondition`/`getChoiceValue`, var types `field`/`constant`/`hidden`/`choice`).
- `@vlab-research/translate-typeform` (`translate-fields.js`, `index.js`) — the `lookup` translator table and `addCustomType`. **Complete custom `type:` set:** `wait`, `stitch`, `handoff`, `notify`, `notification_messages`, `utility_message`, `attachment`, `upload`, `share`, `webview`, `button_choice` (plus native typeform types). Message-level `sendParams` (`messaging_type`/`tag`) is spread onto the outbound command by `formatResponse`.

**Key structural facts learned from real data (not obvious from the vocabulary list):**
- **Handoff is authored as a `handoff:` key**, usually under `type: wait` or bare — *not* as `type: handoff`. (A naïve `"type":"handoff"` search returns 0.)
- **Reloadly / payments are not `metadata.payment` blocks** in current forms — they run as `type: wait` external-event waits on `value.type: payment:reloadly` (or `payment:http`, `assessment`), then a **logic jump on `e_payment_reloadly_success`**. Provider results arrive as synthetic external events flattened to `e_payment_<provider>_*`.
- Descriptions are Typeform-escaped (`target\_app\_id`, `CONFIRMED\_EVENT\_UPDATE`); `deTypeformify` strips `\_` at runtime.

### 1.2 Measurement technique
1. **Field-type distribution** via `jsonb_array_elements(form_json->'fields')`.
2. **Custom-behaviour prevalence** via `bool_or(... LIKE ...)` over each field's `properties.description`, **reduced to one row per `formid` first, then counted** — because CockroachDB returns *wrong* results for multiple `count(DISTINCT ...) FILTER (...)` in one SELECT (verified: isolated `stitch`=192 vs. 0 when combined). The subquery-then-`count(*) FILTER` pattern is correct and is what every number below uses.
3. **Participant weighting** by joining a per-`shortcode` feature table to `states.current_form` user counts (6mo).
4. **Spot samples** of real `properties.description` blobs and `form_json->'logic'` blocks to confirm syntax and rule out false positives.

### 1.3 Exact queries (representative)
```sql
-- field-type distribution, deduped by form
SELECT t, count(*) forms FROM (
  SELECT s.formid, lower(f->>'type') t,
         row_number() OVER (PARTITION BY s.formid, lower(f->>'type')) rn
  FROM surveys s, jsonb_array_elements(s.form_json->'fields') f
  WHERE s.created > now() - INTERVAL '18 months'
) x WHERE rn=1 GROUP BY t ORDER BY forms DESC;

-- custom-behaviour prevalence (robust pattern; count AFTER reducing to one row/form)
SELECT count(*) total, count(*) FILTER (WHERE has_stitch) stitch, /* ... */
FROM (
  SELECT s.formid,
    bool_or(lower(coalesce(f->'properties'->>'description','')) LIKE '%stitch%') has_stitch,
    bool_or(lower(coalesce(f->'properties'->>'description','')) LIKE '%handoff%'
         OR lower(coalesce(f->'properties'->>'description','')) LIKE '%target%app%id%') has_handoff,
    /* wait / reloadly / attachment / webview / utility_message / keepmoving / sendparams ... */
    bool_or(jsonb_array_length(coalesce(s.form_json->'logic','[]')) > 0) has_logic
  FROM surveys s, jsonb_array_elements(s.form_json->'fields') f
  WHERE s.created > now() - INTERVAL '18 months'
  GROUP BY s.formid
) t;

-- participant weighting
WITH sc AS (SELECT s.shortcode, bool_or(...) has_x, ...
            FROM surveys s, jsonb_array_elements(s.form_json->'fields') f
            WHERE s.created > now() - INTERVAL '18 months' GROUP BY s.shortcode),
     vol AS (SELECT current_form, count(*) users FROM states
             WHERE updated > now() - INTERVAL '6 months' AND current_form IS NOT NULL
             GROUP BY current_form)
SELECT sum(users) matched, sum(users) FILTER (WHERE has_x) x, ...
FROM vol JOIN sc ON vol.current_form = sc.shortcode;

-- choice-condition logic jump (getChoiceValue), form-level
SELECT count(*) FILTER (WHERE cl) choice_logic FROM (
  SELECT formid, bool_or(form LIKE '%"type": "choice"%' OR form LIKE '%"type":"choice"%') cl
  FROM surveys WHERE created > now() - INTERVAL '18 months' GROUP BY formid) t;

-- state / error weighting
SELECT current_state, count(*) FROM states
WHERE updated > now() - INTERVAL '6 months' GROUP BY current_state ORDER BY 2 DESC;
SELECT count(*) FILTER (WHERE payment_error_code IS NOT NULL) payment_errors,
       count(*) FILTER (WHERE fb_error_code IS NOT NULL) fb_errors,
       count(*) FILTER (WHERE stuck_on_question IS NOT NULL) stuck,
       count(*) FILTER (WHERE timeout_date IS NOT NULL) waiting_timeout,
       count(*) FILTER (WHERE previous_with_token) with_notif_token
FROM states WHERE updated > now() - INTERVAL '6 months';
```

---

## 2. Prevalence data (from prod)

### 2.1 Native field types — recent, deduped by form (n=339)
| type | forms | % of forms |
|---|---:|---:|
| statement | 333 | 98% |
| multiple_choice | 325 | 96% |
| phone_number | 111 | 33% |
| number | 61 | 18% |
| short_text | 56 | 17% |
| long_text | 27 | 8% |
| yes_no | 17 | 5% |
| email | 11 | 3% |
| dropdown | 1 | <1% |

`statement` + `multiple_choice` carry essentially all custom behaviour (they hold the `properties.description` blobs). No `rating`/`opinion_scale`/`legal`/`picture_choice`/`welcome_screen` in recent forms.

### 2.2 Custom behaviours — recent forms (n=339) and participant-weighted (n=47,416 matched users, 6mo)
| behaviour | forms | % forms | users (6mo) | % users |
|---|---:|---:|---:|---:|
| logic jump (any) | 280 | 83% | 47,069 | **99%** |
| └ **choice-condition jump** (`getChoiceValue`) | **234** | **69%** | (subset of above) | — |
| stitch (form→form) | 192 | 57% | 37,122 | **78%** |
| `{{hidden:...}}` interpolation | 169 | 50% | 27,915 | 59% |
| custom messages (`messages_json`) | 237 | 70% | — | — |
| translation (`translation_conf`) | 308 | **91%** | — | — |
| has_followup | 236 | 70% | — | — |
| wait (external/timeout) | 153 | 45% | 12,134 | 26% |
| `{{field:...}}` interpolation | 105 | 31% | — | — |
| **reloadly payment** | 101 | 30% | 9,317 | **20%** |
| seed_N randomisation | 136 | 40% | — | — |
| **message-tag / `sendParams`** | 61–77 | 18–23% | 11,323 | **24%** |
| keepMoving | 73 | 22% | — | — |
| attachment (bot→user image/video) | 50 | 15% | 2,130 | 4.5% |
| webview | 32 | 9% | 3,901 | 8% |
| button_choice | 29 | 9% | — | — |
| utility_message (template) | 28 | 8% | 4,190 | 9% |
| payment:http | 27 | 8% | — | — |
| e164 phone transform | 14 | 4% | — | — |
| handoff/handover | 5 | 1.5% | 2 | ~0% |
| assessment (external wait) | 5 | 1.5% | — | — |
| notify / one_time_notif | 1 | <1% | 0 tokens | **0%** |
| upload (user→bot media) | 0 | 0% | — | 0% |
| share | 0 | 0% | — | — |

All-time context: handoff = **5 forms out of 866 all-time** (still ~1%).

### 2.3 Participant state distribution (6mo, ~48,468 users) — weights the state-machine branches
| current_state | users | % |
|---|---:|---:|
| QOUT (awaiting answer) | 15,433 | 32% |
| END | 13,992 | 29% |
| **BLOCKED** (FB delivery error) | 9,104 | 19% |
| **ERROR** (bad form / state-action) | 7,969 | 16% |
| WAIT_EXTERNAL_EVENT (handoff/payment/timeout) | 1,705 | 3.5% |
| USER_BLOCKED | 184 | <1% |
| RESPONDING / START | 81 | <1% |

Derived signals (6mo): `fb_error_code` set on **9,033** users; **893** users hit a reloadly `payment_error_code`; **5,615** users stuck in a validation/repeat loop; **1,351** waiting on a timeout; **0** users carried a one_time_notif token.

---

## 3. Coverage matrix

Integration = `facebot/testrunner/test.tc.ts` (testcontainers, shared stack). Smoke = `facebot/testrunner/test.ts` (real k8s cluster).

| feature | prod prevalence | integration | smoke | notes |
|---|---|---|---|---|
| Referral → first question | universal | ✅ | ✅ (DNS/wiring) | |
| Logic jump — field/constant/hidden vars | 83% forms | ✅ (idx 0/1, prev-question, seed_2, seed_16 or-clauses) | — | |
| **Logic jump — `choice` var (`getChoiceValue`)** | **69% forms / 99% hit logic** | ✅ (new: `forms/choiceJump.json`) | ❌ | **Correction**: `forms/jISElk.json`'s existing "logic jump from previous question" test already exercised the `is()`-true branch of a `field`+`choice` condition incidentally (gender=Male path) — this row was wrongly marked zero coverage. The new `choiceJump.json` fixture makes the coverage explicit and, unlike the incidental case, drives *both* branches (Red/Blue) to two distinct target fields in one parametrized test. |
| Stitch (basic + seed + no-retake) | 57% forms / 78% users | ✅ | ✅ (partial) | |
| **Stitch `metadata:` overrides** | subset of 78% users | ❌ | ❌ | `_stitch` `...stitch.metadata` merge path unexercised |
| `{{hidden:...}}` runtime interpolation | 50% forms / 59% users | ✅ (new) | ❌ | |
| Handoff / `e_handover_metadata_*` | 1.5% forms / ~0% users | ✅ (new, +unit) | ❌ | high-risk, low-prevalence; broke in prod once |
| Wait external event + timeout (rel+abs) | 45% forms / 26% users | ✅ | ✅ (real-cron absolute) | |
| BLOCKED / fb_error delivery path | 19% of all users | ✅ | ✅ | largest error surface — well covered |
| ERROR / bad-form path | 16% of all users | ✅ | ❌ | |
| Validation failure / repeat loop | 5,615 users stuck | ✅ | ❌ | |
| Translation (`translation_conf`) | 91% forms | ✅ (1 test) | ❌ | near-universal; single test may under-cover |
| keepMoving + multi-link | 22% forms | ✅ | ❌ | |
| Attachment (bot→user, multi-part) | 15% forms / 4.5% users | ✅ | ❌ | |
| e164 phone transform → payment | 4% forms | ✅ | ❌ | |
| Payment logic-jump — **fake** provider | proxy for 20% users | ✅ | ❌ | mechanics only |
| **Payment — reloadly provider path** | 30% forms / 20% users / 893 errors | ⚠️ logic only (fake) | ❌ | provider HTTP + `e_payment_reloadly_*` keys untested |
| **Message-tag / `sendParams`** | 18–23% forms / 24% users | ❌ | ❌ | **absent from tests AND from the deferred-gaps list** |
| **utility_message (template)** | 8% forms / 9% users | ❌ | ❌ | newer, growing (`recontact_*`, `reloadly_makeup`) |
| webview | 9% forms / 8% users | ✅ (new: `forms/webviewTest.json`) | ❌ | pure translation, low risk; confirmed via `machine.js` that a bare webview field blocks on `WAIT_RESPONSE` (no button-postback path for a `web_url` button) — the fixture pairs it with `keepMoving: true` to auto-advance, matching how it'd need to be authored in practice |
| button_choice (+ >3 RangeError) | 9% forms | ❌ | ❌ | fail-loud `RangeError` path untested |
| Bailout | — | ✅ | ❌ | |
| Retry on fb error | 9,033 users w/ errors | ✅ (fires) | ❌ | retry **cap** unverified (dean `retries`) |
| notify / one_time_notif token | **0% users (dead)** | ✅ | ❌ | test maintains a dead feature |
| WATERMARK/BLOCK_USER/UNBLOCK/RESTORE_STATE/reset | <1% users | ❌ | ❌ | branch-level; unit-test candidates |
| User→bot MEDIA / upload | **0% recent (dead)** | ❌ | ❌ | low value — do not invest |

---

## 4. Prioritised recommended integration tests (ranked by prevalence × risk)

All of these **fit the existing shared testcontainers stack** unless noted — the fixed `before()` cost (build replybot/message-worker/botserver/facebot/cockroach/redpanda/redis/formcentral/dinersclub) is already paid, so each is a cheap fixture + `it()`.

1. **Choice-condition logic jump (`getChoiceValue`)** — *69% of forms, 99% of users hit logic; zero coverage.* **Highest bang-for-buck.**
   - Fixture: one `multiple_choice` question + a `logic` block whose condition is `{op:"is", vars:[{type:"field",...},{type:"choice",value:<choiceRef>}]}`, branching to two different fields.
   - Effort: **XS.** Shared stack. Drive one QR pick per branch and assert the landing field. This is the most common branching idiom in prod and is completely untested.

2. **Message-tag / `sendParams` passthrough** — *24% of users, 18–23% of forms; not on anyone's radar.*
   - Fixture: a `statement`/question whose description carries `{"sendParams":{"tag":"CONFIRMED_EVENT_UPDATE","messaging_type":"MESSAGE_TAG"}}`.
   - Assert the outbound command the **facebot mock** receives carries `messaging_type`/`tag` (i.e. `formatResponse`'s `extraParams` survive replybot → worker → send). If this regresses, ~1 in 4 users' out-of-window messages silently fail.
   - Effort: **S.** Shared stack (assert on already-captured mock traffic).

3. **Stitch `metadata:` override** — *stitch = 78% of users; the metadata-carry subset is common (`hpvbl`, `gelangchoice`).*
   - Extend the existing stitch fixture with a `stitch.metadata` block; assert the override lands in the second form's `md` (e.g. a `{{hidden:...}}` in form B renders the injected value, and `startTime` refreshes while `seed` persists).
   - Effort: **XS.** Folds into the current consolidated stitch test.

4. **reloadly-keyed payment logic** — *30% of forms, 20% of users, 893 real payment errors.*
   - Cheap slice: mirror the existing fake-provider payment test but drive a `payment:reloadly` synthetic external event and assert (a) the logic jump on `e_payment_reloadly_success` and (b) the `payment_error_code` generated column populates on failure. This covers the reloadly-specific metadata/branch shape without a reloadly mock.
   - Effort: **S**, shared stack. **The real reloadly provider HTTP call still needs a reloadly mock → new infra (expensive); defer that to smoke/manual (see §5).**

5. **utility_message template** — *9% of users, growing.*
   - Fixture: a `utility_message` field (`template` + `language` + optional `params`/choices). Assert the worker emits a `template` payload with `messaging_type: UTILITY` and the approved button `payload`.
   - Effort: **M** — verify the facebot mock accepts the template send shape; `translateUtilityMessage` throws loudly on missing `template`/`language`, so also add a negative fixture.

6. **button_choice incl. >3 `RangeError`** — *9% of forms.*
   - Cheapest as a **unit test in `@vlab-research/translate-typeform`** (3-button postback template renders; 4 choices throws `RangeError`). No stack needed.
   - Effort: **XS.**

7. **webview** — *8% of users, low risk (pure translation).* Unit-level assertion on `translateWebview` (string URL + object-URL `makeUrl`). **XS, low priority.**

8. **Retry cap (dean `retries`)** — the dropped-duplicate intent from WS3a. Requires `triggerDean(..., 'retries')`; verifies resend stops after N and `next_retry` backoff. **M**, shared stack, but needs the dean-retry query wired into the harness.

**Explicit non-recommendations (prevalence says skip):** user→bot MEDIA/`upload` (0% recent), `share` (0%), and dedicating new work to **notify/one_time_notif** (0 tokens in 6mo — the existing notify test guards a dead feature; consider *demoting* it rather than extending it).

---

## 5. Smoke-tier recommendation (keep it minimal)

The smoke tier should catch **only what a real cluster can catch** — DNS, secrets, real CronJob, real external connectivity — not logic. Everything in §4 is logic and belongs in integration.

**One defensible addition: real reloadly provider connectivity.** 30% of forms and 9,317 users (6mo) depend on reloadly, with 893 real payment failures — and the *only* thing the shared stack cannot fake is whether the deployed `dinersclub` service actually reaches reloadly with valid credentials/DNS. A minimal smoke test that drives a single reloadly payment and asserts the failure it gets back is a *reloadly business error*, not a DNS/credential/connectivity error, would catch a class of outage that no integration test can.
- **Caveat:** only worth adding if a reloadly **sandbox** is reachable from the cluster. If not, do **not** add it — a smoke test that can't distinguish "reloadly down" from "we can't reach reloadly" has no value.

**Otherwise, no new smoke tests are warranted.** The current 4 (referral/DNS, BLOCKED delivery, real-cron absolute timeout, stitch) already cover the highest-volume real-infra paths (BLOCKED alone is 19% of all users). Do fix the known `'true'` vs `'Yes'` stitch assertion noted in the improvement plan.

---

## 6. Parallelisation / consolidation opportunities

The shared-stack model means the win is **fixtures that exercise several high-prevalence behaviours in one referral flow**, amortising the (already-paid) setup and avoiding N separate `it()` round-trips.

**Best consolidated fixture — "the realistic survey" (one referral, ~6 fields, covers 4 top gaps at once):**
```
field[0] multiple_choice  ─ choice-condition logic jump (#1, 69% forms)
   ├─ branch A → field[1] statement with sendParams message-tag (#2, 24% users)
   └─ branch B → field[2] ...
field[3] stitch WITH metadata: override (#3, 78% users)  → form B
form B[0] utility_message template (#5, 9% users)
```
One flow validates choice-jump + message-tag + stitch-metadata + utility_message — the four biggest uncovered gaps — for roughly the cost of one existing test. This mirrors how real production forms actually compose these features (they are not used in isolation), so it is also a more faithful regression than four synthetic single-feature fixtures.

**Cheap, no-stack batch:** button_choice (#6) and webview (#7) are pure `translate-typeform` translations — put them in that package's unit suite, zero stack cost, run in the fast test tier.

**New-infra cost callouts (so the tradeoff is explicit):**
- A **real reloadly mock** (to exercise the dinersclub → reloadly HTTP path end-to-end) is the only item that adds a new service to `before()`. Given the fake-provider test already covers the *machine* logic and a reloadly-keyed variant (#4) covers the *metadata/branch* shape cheaply, the full reloadly mock is **not** worth the shared-stack setup cost — push provider connectivity to smoke (§5).
- A **media-upload endpoint** for user→bot `upload` — **do not build**; 0% recent prevalence.

---

## 7. Surprising things real forms do (that the team likely isn't tracking)

1. **Message-tags / `messaging_type` are used by ~1 in 4 participants (18–23% of forms)** — `CONFIRMED_EVENT_UPDATE`, `MESSAGE_TAG`, `UTILITY` — yet this passthrough has **zero test coverage and isn't even on the deferred-gaps list.** It's the highest-prevalence blind spot. A silent regression here breaks out-of-24h-window delivery and would only show up as a spike in `fb_error`/BLOCKED.
2. **Handoff is authored as a `handoff:` key, not `type: handoff`** — any coverage or monitoring keyed on `"type":"handoff"` silently matches nothing. (This is exactly why a first pass shows 0 handoff forms.)
3. **Reloadly payments run through the generic `wait`/external-event machinery**, branching on `e_payment_reloadly_success`, *not* through a `metadata.payment` block. The payment "feature" is really "wait for a synthetic external event + logic jump" — the same primitive as timeouts and handoff. Test it as such.
4. **`translation_conf` is on 91% of recent forms** — translation is effectively the default, not an edge case. A single translation integration test is thin coverage for something nearly universal.
5. **choice-condition logic jumps (69% of forms) are the dominant branching idiom** and are the largest *logic* coverage gap — the current logic tests all use `field`/`constant`/`hidden` conditions and never resolve a choice label.
6. **notify/one_time_notif and user-upload are effectively dead** (0 tokens, 0 recent upload forms) — yet notify has a dedicated integration test. Effort is currently mis-allocated toward a dead feature and (justifiably, on risk grounds) toward handoff (5 forms all-time), while choice-jumps (234 forms) and message-tags (61–77 forms) have none.
7. **BLOCKED is 19% of all participants (9,033 fb_errors in 6mo)** — the delivery-error path is the single most-traveled non-happy path in the whole system. Good news: it's the one error path covered in *both* tiers. Keep it that way.

---

## Appendix — feature → code anchors
- Logic jump / choice conditions: `replybot/lib/typewheels/form.js:191-308` (`getNextField`, `jump`, `getCondition`, `getChoiceValue`, `getVar`).
- Custom-type resolution: `form.js:335-359` / `translate-typeform/index.js:36-63` (`addCustomType`).
- Handoff / handover flattening: `machine.js:19-56` (`makeEventMetadata`, `e_handover_metadata_*`), ECHO branch `machine.js:416-428`.
- Stitch + metadata merge: `machine.js:204-217` (`_stitch`), ECHO `md.stitch` `machine.js:412-414`.
- Wait / timeout / payment external events: `machine.js:430-444`, `102-141` (`_handleExternalEvent`), `replybot/lib/typewheels/waiting.js`.
- `sendParams` passthrough: `translate-typeform/translate-fields.js:386-402` (`formatResponse`, `translator`).
- Payment side-effect extraction: `machine.js:702-730`.
- State generated columns (weighting source): `states` — `current_state`, `current_form`, `fb_error_code`, `payment_error_code`, `stuck_on_question`, `timeout_date`, `previous_with_token`.
- Current tests: `facebot/testrunner/test.tc.ts` (integration), `test.ts` (smoke); deferred gaps in `planning/integration-test-improvements.md`.
