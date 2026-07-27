# What Can Go Wrong: The Enumeration

**Status:** working document for the error-ontology discussion
**Method:** six parallel code sweeps (state machine, delivery, payments, survey config,
participant journey, infrastructure) + direct queries against production CockroachDB.
Claims marked ✅ were verified by reading the code or the database directly during this
pass; claims marked ⚠️ come from a sweep and are not independently confirmed.

**Companion:** `planning/error-ontology-design.md` (the first-pass design, written before
this enumeration — several of its assumptions are corrected here).

---

## 0. The thesis this enumeration produced

We set out to list the problems so we could see how they lay out. They lay out in a
pattern nobody designed and nobody would choose:

> **What we detect is what is easy to detect, and ease of detection is inversely
> correlated with harm.**

The only failure class that currently pages a human is `INTERNAL` — 49 events in 30 days,
in which a participant loses a few minutes. Meanwhile:

- **2,207 people** in 30 days were recruited, engaged, and got no survey at all. Excluded
  from every alert *by design*.
- **335+ people** completed a survey, were promised airtime, and didn't get it. No metric,
  no alert, and the true number is unknowable (§3.4).
- **An unknown number** are in the wrong study entirely, producing confidently wrong
  research data, with zero signal of any kind (§3.5, finding C1).

Every one of those is worse than what we page for. None of them is detectable by a better
error taxonomy, because none of them produces an error.

---

## 1. The three axes

The enumeration doesn't fit on one dimension. Three are needed, each answering a different
question, and each independently necessary.

### Axis 1 — Harm: what was actually lost?

Intrinsic severity. Not derived from cause, count, or who's at fault. Two families,
because there are two parties who can be harmed:

| | Participant harm | |
|---|---|---|
| **P0** | nothing — they chose to leave | expected churn |
| **P1** | the opportunity — recruited, engaged, never got a survey | |
| **P2** | their time — started, stranded mid-survey | |
| **P3** | their payment — completed, promised, unpaid | worst outcome for a real person |

| | Research harm | |
|---|---|---|
| **R0** | nothing | |
| **R1** | data missing — we know it's missing | recoverable; you can report the gap |
| **R2** | **data silently wrong** | **worst outcome, full stop** |

R2 outranks everything. Missing data you know about and can caveat. Wrong data you
publish.

### Axis 2 — Agency: who can act?

Pure routing. `platform` · `researcher` · `automatic` · `nobody`.

Not derivable from Axis 1, and **not derivable from correlation** (§4.2). Deterministic-
vs-stochastic is a *threshold policy* under this axis, not a category of its own — it
decides when to speak, not who to speak to.

### Axis 3 — Detectability: how could we possibly know?

The axis nothing in the system has today. It determines what kind of monitoring can work
at all, and no amount of taxonomy refinement substitutes for it.

| Mode | Meaning | Mechanism required |
|---|---|---|
| **D0 self-reporting** | the failure told us | error taxonomy (what we have) |
| **D1 inferable** | data exists, nothing reads it | a query nobody wrote |
| **D2 only-by-absence** | detectable only as "expected thing didn't happen" | negative-space monitoring |
| **D3 only-externally** | requires reconciling against a third party | a reconciliation job |
| **D4 undetectable** | the operation *succeeds*, wrongly | a design change, not monitoring |

---

## 2. Production baseline (30 days unless noted)

```
END                  9,048        BLOCKED breakdown        ERROR breakdown
QOUT                 4,445          10      1,750  (61%)     FORM_NOT_FOUND  2,785 (97.6%)
ERROR                2,852          551       494              INTERNAL           49
BLOCKED              2,844          100       340              STATE_ACTIONS      13
WAIT_EXTERNAL_EVENT  1,255          NULL      131              FIELD_NOT_FOUND     5
USER_BLOCKED            37          -1         88
START                   26          190        40
                                    200         1
```

**ERROR + BLOCKED = 5,696 of 20,507 — 28% of everyone the bot touched.** ✅

Three things this immediately shows: ✅

- `FORM_NOT_FOUND` is **97.6% of all errors**, and 2,207 of those 2,785 are the fallback
  form. After exclusions, the entire "error" surface is **67 events in 30 days.**
- The remaining **570 are real**: forms `slcNrF05`–`slcNrF010`, six siblings of one study
  whose follow-up forms reference IDs that don't resolve. Deterministic, researcher-fixable,
  running ≥30 days, nobody told.
- `CORRUPTED_MESSAGE`, `INTERPOLATION_ERROR`, `STATE_TRANSITION`, `NETWORK` — **zero
  occurrences.** For `STATE_TRANSITION` and `NETWORK` the code sweep found the reason:
  the first is `publish: false`, the second has no producer anywhere. Two documented
  platform-fault tags that cannot ever appear.

**Payments (90 days):** 699 failures across 14 distinct codes; **335 of them in state
`END`** — completed the survey. `INSUFFICIENT_BALANCE` ×37 means *our wallet was empty*. ✅
This figure covers Reloadly topups **only** — see §3.4.

**The 131 NULL-code cohort:** arrived in a single burst 11–14 July 2026, nothing since,
untouched for 13 days. ✅

---

## 3. The enumeration

### 3.1 Recorded and correctly classified — D0

The taxonomy we've been arguing about. Roughly 67 real events per 30 days.

| Problem | Harm | Agency | Notes |
|---|---|---|---|
| `INTERNAL` (49) | P2 | platform | the only thing that pages |
| `STATE_ACTIONS` (13) | P2 | platform | but see §3.2 — most of these are misfiled |
| `FIELD_NOT_FOUND` (5) | P2/R1 | researcher | deterministic; gated as stochastic today |
| `FORM_NOT_FOUND` non-fallback (570) | P2/R1 | researcher | one study, 30+ days, unreported |
| `INTERPOLATION_ERROR` | P2 | researcher | zero occurrences observed |
| FB codes 190/200/2022 etc. | varies | varies | see §3.3 |

### 3.2 Recorded but **misclassified** — D0, wrong destination

`transition.js:183` — `const tag = e.tag || 'STATE_ACTIONS'`. Any untagged JS error
becomes `STATE_ACTIONS`, which every consumer treats as **platform fault → page on-call**.
Seven concrete study-authoring mistakes land here: ⚠️

1. Jump condition references a nonexistent choice ref — `getChoiceValue`, no null guard
2. No default branch on the terminal question — `jump()` ends `_getNext(...).ref`, and
   `_getNext` returns `null` when the ref *is* last → `TypeError` ✅
3. Unknown jump operator
4. Unsupported Typeform field type — validator
5. Unsupported Typeform field type — translator
6. Statement/`keepMoving` cycle → stack overflow
7. Invalid webview URL object

Each pages a platform engineer, with a runbook pointing at CockroachDB and Kafka, for a
mistake only the researcher can fix. `study-error-alerting.md` warns about exactly this
failure mode in the abstract; these are seven instances of it in the concrete.

**Also here:** FB code `100` merges three unrelated causes (template missing, malformed
payload, wrong-environment attachment ID) into one bucket named `template_missing`. ⚠️

### 3.3 Recorded as **the opposite of the truth** — worse than undetected

**WhatsApp delivery failures are recorded as successful deliveries.** ✅
`event-normalizer.js:310`:
```js
const eventType = statusMap[data.status] || 'bot_message_delivered'
```
`statusMap` covers `delivered`/`read`/`sent`. A `status: "failed"` webhook — Meta
explicitly telling us delivery failed, error array attached — falls through the `||` and
is recorded as delivered. `data.errors` is never read.

**WhatsApp handoff always reports success.** `PassThreadControl` is a no-op returning
`nil`; the state machine believes a handoff completed that never happened. ⚠️

### 3.4 Recorded but structurally unreachable

**The NULL-code black hole, three innocuous parts:** ✅
1. `worker.go` — `Code int \`json:"code,omitempty"\``. Go drops zero ints; `code` is `0`
   whenever the token lookup failed or the request never completed. Field vanishes.
2. → `states.fb_error_code` is NULL.
3. `dean/queries.go:142` — `fb_error_code = ANY($1)`. `NULL = ANY(...)` is NULL, never TRUE.

Those 131 users are not unretried by misconfiguration. **No edit to `DEAN_FB_CODES` could
ever reach them.**

**Payment failures are invisible for three of four providers.** ✅
```sql
payment_error_code VARCHAR AS (CASE
  WHEN state_json->'md'->'e_payment_reloadly_error_code' IS NOT NULL ...
```
Reads `e_payment_reloadly_*` and nothing else. Gift cards (`payment:giftcard`), the generic
HTTP provider (`payment:http`, ~8% of forms), and DingConnect never populate it. **699 is
a floor across one provider, not a total.**

**Dean's retry list is empirically inverted:** ✅ retries `2022`, `613`, `80006` — **zero
occurrences in 30 days** — and skips `10` (1,750) and `100` (340). It *does* retry `551`
and `190`, which the taxonomy classifies as terminal attrition. Both systems are
confidently wrong about each other, in both directions.

### 3.5 Not recorded at all

| Problem | Harm | Detect | Evidence |
|---|---|---|---|
| `publishCommands` throws — state says QOUT, participant never asked | P2 | **D1** | ⚠️ inferable: QOUT with no outbound `chat_log` row |
| `STATE_TRANSITION` — our own state-machine bugs | P2 | D4 | ⚠️ `publish: false`, no state write, stdout only |
| Hermes acks Meta, then drops the event | P2 | D2 | ✅ `StatusCode::OK` unconditional; producer is `tokio::spawn` + `Timeout::After(ZERO)` + `warn!` on failure. **Meta got its 200 and never resends.** |
| Payment stuck with no markers at all | **P3** | D2 | ⚠️ unrecognized provider error → no `Result` ever sent → `success` is *absent*, not `false`. One user accrued **1,424 real Reloadly calls over 1.5 years.** |
| Completed participants overwritten by stray re-referral | **R2** | D1 | ⚠️ 21 observed in one study; `states` is sticky-current-row so the evidence destroys itself |
| Gift-card double payment | P3/R1 | D3 | ✅ `FormatOrder` mints a fresh UUID `CustomIdentifier` on **every** call — any retry is guaranteed to issue a second real gift card |
| Batch replay double payment | P3 | D3 | ✅ retry exhaustion → `checkError` → `log.Fatalf` → `os.Exit(1)`; offset uncommitted; batch replays including already-charged messages |
| Delivered amount never recorded | R1 | D3 | ⚠️ `TODO` at `reloadly.go:138` discards the response; `success:true` can't distinguish requested from delivered |

### 3.6 Silently **wrong** — the R2 tier

These do not fail. They succeed, incorrectly. Nothing anywhere can currently detect any
of them.

**C1 — Shortcode collision routes participants into the wrong study.** ✅
`surveys` has `PRIMARY KEY (id)` on a UUID and `shortcode VARCHAR NOT NULL`. There is
**no UNIQUE constraint** — only indexes. `getSurveyByParams` scopes by
`(userid, shortcode, created <= timestamp)` and takes the newest.

So: Study A runs an ad with shortcode `X` in January. In March the same researcher creates
unrelated Study B reusing `X`. **Every subsequent click on Study A's still-live ad lands
the participant in Study B.** Resolution succeeds. No error. The participant takes a
coherent survey; the data is filed under the wrong study. Deterministic from the moment
B is created, and undetectable at every stage — no uniqueness check at save time, no
error at runtime.

This is the most severe finding in the enumeration: maximum research harm, zero signal.

**C2 — Silent restart to question 1.** ✅ `form.js:191-205`:
```js
function _isLast(form, field) {
  const idx = form.fields.findIndex(({ ref }) => ref === field)
  return idx === form.fields.length - 1
}
function _getNext(form, currentRef) {
  if (_isLast(form, currentRef)) return null
  const idx = form.fields.findIndex(({ ref }) => ref === currentRef)
  return form.fields[idx + 1]
}
```
If `currentRef` isn't in the form, `findIndex` returns `-1`. `_isLast` compares `-1` to
`length - 1` → false. Execution falls through to `form.fields[-1 + 1]` = **`form.fields[0]`**.
The participant is silently sent back to the first question. No error, no tag, nothing to
distinguish it from a legitimate jump. (The code carries the author's own `TODO: work out
this ending logic.... this should never be reached??`)

**C3 — Conditions on unanswered fields silently take the wrong branch.** ⚠️
`getFieldValue` returns `null` for unanswered; `castValue(null)` stays `null`; `null > 5`
is `false`. The participant goes down the "no" branch when the truth is "unknown."
Note the asymmetry: interpolation on an unanswered field throws loudly
(`INTERPOLATION_ERROR`); a *condition* on the same field fails silently and wrongly.

**C4 — A bad Typeform ID saves the API error body as the survey.** ✅
`TypeformFormList` checks `res.ok`. `TypeformForm` and `TypeformMessages` do not — both
`return res.text()` unconditionally. A wrong or access-revoked form ID stores
`{"code":"NOT_FOUND",...}` as the form. The Joi validator only checks `form` is a string,
so it passes. Every respondent then crashes, untagged → `STATE_ACTIONS` → pages an
engineer for a researcher's typo.

**C5 — Bail conditions referencing dead forms/refs are silently inert.** ⚠️ They never
match, never error; indistinguishable from "correctly zero matches so far."

**C6 — Missing `{{hidden:key}}` renders as empty string.** ⚠️ By design. `"Hi , welcome!"`

**C7 — Malformed custom-type YAML is silently ignored.** ⚠️ `catch(e) { return field }` —
the field silently behaves as an ordinary question instead of the intended `wait`/`notify`.

### 3.7 Undetectable in principle — D2/D4

Every alert in the repo is a presence-of-badness detector. ✅ Verified: nothing anywhere
fires on the *absence* of expected activity. The only `absent()` usage is
`KafkaConsumerGroupAbsent`, which detects a vanished consumer group — not zero traffic
through a healthy one.

| Failure | What the dashboards do |
|---|---|
| Meta webhook subscription lapses | flat — no request means no signal, by definition |
| Cert expiry on the webhook ingress | flat — TLS fails before Hermes sees anything |
| CockroachDB down or slow | **the alerting system itself goes stale** — sql_exporter reads CRDB ✅ no CRDB alert exists |
| `scribble-states` wedged | flat, then decays toward zero — looks like a quiet day |
| Study/campaign traffic drops to zero | **reads as healthy** |
| Prometheus/AlertManager/Slack dies | everything goes dark at once (dead-man's switch designed, not applied) |

Two structural consequences: ✅

- **Volume gates invert.** Proportional alerts require `active_users >= 10`. A study going
  dead falls *below* the gate and produces silence rather than alarm.
- **"✓ No issues in the last 24h" renders identically** for "everything is fine" and
  "nothing happened at all."

Also verified: no cert-expiry alert; and the Redis alert that `documentation/alerting.md`
lists as live **does not render** — the subchart defaults `prometheusRule.enabled: false`
and production never overrides it. ✅

### 3.8 Not errors — the suggestions class

Twenty-two catalogued; nearly all unmeasured. The distinction holds: these are cases where
nothing is broken and the outcome is still bad. They belong on a **separate surface** — an
error surface earns its value by being silent when things are fine, and a suggestions
surface is always showing something. Mixing them destroys the first.

Representative, with real numbers:

- **QOUT = 4,445 (22%)** — and "never answered question 1" is indistinguishable from
  "quit at question 30." ⚠️ Trivially computable from `qa.length`; nothing does it.
- **1,055 respondents completed all 35 Bauchi questions and were then disqualified by the
  final screener.** ⚠️ Nothing broke. Only a researcher can fix it.
- `stuck_on_question` is boolean — 3 repeats and 24 repeats are identical. 76 of 79 stuck
  users had typed free text at a buttons-only question. ⚠️
- **No duplicate detection exists anywhere** — `states` is keyed `(userid, pageid)`, so one
  person via two pages is two participants, possibly double-paid. ⚠️
- Attrition is computed into the aggregate bag and referenced by **zero rules** — present
  in the data plane, absent from the interpretation plane. ⚠️

### 3.9 The lifecycle gap

**There is no study status field.** ⚠️ No draft / piloting / live / closed anywhere in
`surveys`. The only lifecycle primitive is `survey_settings.off_time` — a one-way kill
switch. A survey is live to real traffic the instant its row is inserted; there is no
publish step and no way to stage.

This matters for the taxonomy directly: **absolute volume is currently the only available
proxy for whether a study is live**, which is why 570 affected respondents reads as "in
production and bleeding" while 5 reads as "probably a draft." That proxy is load-bearing
precisely because the real field doesn't exist.

(Killed surveys also leave respondents permanently in `RESPONDING`, re-sent the "survey
closed" message forever, indistinguishable from genuine stuck users. ⚠️)

---

## 4. What the layout reveals

### 4.1 Harm and detectability are inversely correlated

| | D0 self-report | D1 inferable | D2 absence | D3 external | D4 undetectable |
|---|---|---|---|---|---|
| **R2 data wrong** | | overwritten completions | | | **C1 shortcode collision**, C2, C3 |
| **P3 payment** | reloadly topups | giftcard/http/ding | stuck-no-marker | balance, reversals, dupes | |
| **P2 time** | INTERNAL (49) ⚑ | publishCommands | hermes drop, pipeline | | STATE_TRANSITION |
| **P1 opportunity** | 305 (2,207) ✂ | | dead campaign | | |
| **P0 none** | 551, USER_BLOCKED | | | | |

⚑ = the only thing that pages. ✂ = detected but excluded from alerting by policy.

The alerting sits in the bottom-left. The harm sits in the top-right.

### 4.2 Correlation across studies cannot identify platform fault

You proposed that errors correlated across surveys indicate a platform problem. It's a
good heuristic and it only works in §3.1–3.2.

**Every failure in §3.7 is correlated across all studies simultaneously and emits nothing
to correlate.** Kafka down, CRDB down, cert expired, subscription lapsed — maximal blast
radius, zero signal. They're worse than uncorrelated: they suppress the volume-gated
alerts that would catch lesser problems.

And correlation fails in the other direction too: the 570-respondent `slcNrF0*` breakage
is confined to one study and is definitely the researcher's; the 131-user cohort is
confined to one incident and is definitely ours. **Fault must come from the failure's
nature; correlation only adjusts urgency.**

### 4.3 "The participant was paid" is not a platform-level fact

`waitConditionFulfilled` filters events by `type` and never inspects `success`. ✅ A failed
payment and a successful one fulfill the wait identically. Whether a participant whose
airtime failed is routed anywhere different depends entirely on whether the survey author
hand-wired a jump on `e_payment_reloadly_success` — and nothing checks that they did.

The platform has a concept of *a payment event occurred*. It has no concept of
*the participant received what we promised*. That gap is where the 335 sit, and no
taxonomy fixes it — it needs the platform to assert the invariant instead of delegating it.

### 4.4 Payments alone need all four detection modes

The strongest evidence that Axis 3 is real rather than over-engineering — one domain,
four mechanisms:

- **D0** Reloadly topup business errors — already in the column
- **D1** giftcard/http failures — data is in `state_json.md`, the column doesn't read it
- **D2** stuck-forever with no markers — only "waiting too long" reveals it
- **D3** wallet balance, async reversals, duplicates — needs provider reconciliation

No refinement of the error taxonomy reaches D1–D3.

---

## 5. Open questions

1. **Is FB code 10 really attrition?** 1,750 users — 27% of all problem states, the single
   largest population in the system. Filed as expected churn. If it actually means we tried
   to send outside Meta's 24-hour window, it's our scheduling bug, ~58 people/day, written
   off as inevitable. **This one answer moves more than anything else here.**
2. **Should a study have an explicit status?** Without it, volume is the only proxy for
   stakes, and it fails exactly when a study goes dead (§3.7).
3. **`CUSTOM_IDENTIFIER_ALREADY_USED` ×271** — "already paid" (fine) or "idempotency
   collision" (never paid)? Opposite meanings, same code, currently indistinguishable.
4. **Should researchers see platform-fault errors at all**, or only a no-blame notice?
5. **Is there any stated reliability target?** Without one, every threshold is a guess
   rather than a derivation.
6. **Who owns payment failures** — researcher, platform, or both? Decides which surface
   owns them and how loudly.
7. **What happens to a `terminal-abandoned` cohort when detected** — auto-requeue, runbook,
   or accept and report? Determines whether it's a page or a digest.

---

## 6. Findings that are bugs, not taxonomy

Independent of the ontology work, verified, and live:

| # | Bug | Severity |
|---|---|---|
| 1 | WhatsApp `status:"failed"` recorded as `bot_message_delivered` ✅ | corrupting delivery data now |
| 2 | No UNIQUE constraint on `(userid, shortcode)` ✅ | silent wrong-study routing |
| 3 | `omitempty` on `Code int` → NULL → `NULL = ANY()` never matches ✅ | 131 users permanently abandoned |
| 4 | `_getNext` `findIndex` −1 → `fields[0]` ✅ | silent restart to question 1 |
| 5 | `TypeformForm`/`TypeformMessages` skip `res.ok` ✅ | error body saved as the survey |
| 6 | Gift-card `CustomIdentifier` regenerated per call ✅ | guaranteed double payment on retry |
| 7 | `checkError` → `log.Fatalf` → batch replay ✅ | double payment on crash |
| 8 | Hermes acks Meta before confirming the Kafka write ✅ | silent message loss, no retry |
| 9 | Redis alert documented as live, never renders ✅ | false coverage in the inventory |
| 10 | Live Traffic panel 7 lacks the fallback exclusion ✅ | the original reported symptom |
