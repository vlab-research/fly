# An Ontology of Errors for vlab

**Status:** design proposal / discussion document
**Scope:** what counts as an "error" on the survey-bot platform, how it should be classified once, and how the four existing health surfaces should consume that one classification
**Prompted by:** "In ERROR Now" (3) disagreeing with the ERROR band on the chart directly beneath it (~22) on the Live Traffic board

---

## 0. Executive summary

The dashboard disagreement is real and has two proximate causes (a missing label filter on panel 7, and a `max`-over-6h legend column read as "now"). But patching those two things fixes nothing structural, because they are instances of a general defect:

> **Classification of what counts as an error is not stored anywhere. It is re-derived, by hand, as filter expressions, in every consumer.**

There are today at least **14 places** that independently decide "is this row an error I care about": 8 Grafana panels on Live Traffic, 5+ on Study Health, 7 PrometheusRules, one SQL `CASE` in the exporter, a second SQL `CASE` in `states.queries.js`, a JS allow-list in `aggregate.js`, a ruleset in `rules.js`, and two hand-maintained Helm string lists in `DEAN_ERROR_TAGS` / `DEAN_FB_CODES`. Several of them express the taxonomy by **string-matching a study's display name** (`study!="fallback (no study)"`). Nothing fails when one of them is forgotten. Panel 7 is not a bug; it is the expected failure rate of that design.

This document proposes:

1. **Six orthogonal axes** for classifying a failure (§1), replacing the current implicit one-and-a-half axes (`state` + `reason`, with "deterministic vs stochastic" bolted onto the side).
2. A reconciliation showing where today's taxonomy holds up, where it drifts, and **five failure classes that fall through the cracks entirely** — including participants who complete a survey and never receive their incentive, and BLOCKED users that nothing in the system will ever retry (§2).
3. **One classification table, compiled into the data**, with each surface choosing only *window*, *threshold*, and *audience filter* — never its own notion of error (§3).
4. A prioritized fix list, P0 → P3 (§4).
5. The judgment calls that are genuinely yours (§5).

---

## 1. First principles: what IS an error?

### 1.1 Start from the participant, not the state machine

Today "error" operationally means **`states.current_state = 'ERROR'`**. That is a mechanism, not a concept. It is the set of failures that happen to have been implemented as a state transition. It excludes several things that are unambiguously failures, and includes at least one thing that is unambiguously *not* (form 305's by-design `FORM_NOT_FOUND`).

A concept-first definition:

> **An error is any deviation from the intended participant journey that a human might need to know about.**

The intended journey is: a person is reached → answers questions → completes → (if promised) receives their incentive. Anything that stops, stalls, corrupts, or silently drops that journey is a failure, regardless of whether the state machine noticed.

This immediately surfaces the system's biggest blind spot, addressed in §2.4: **failures that leave no state row are invisible to every current surface.** All four surfaces read `states`. `states` is a *stock of things the machine knows went wrong*. A stalled Kafka consumer produces a perfectly healthy-looking `states` table.

### 1.2 The six axes

Four axes describe the **failure**. Two describe the **response**. They are orthogonal: knowing one tells you little about the others, and every pairing has real occupants.

---

#### **A1 — Fault domain: whose defect is it?**

| Value | Meaning | Examples |
|---|---|---|
| `platform` | our code, our infrastructure | `INTERNAL`, `STATE_ACTIONS`, `CORRUPTED_MESSAGE`, missing page token (`code=NULL`) |
| `study` | the survey's configuration or design | `FIELD_NOT_FOUND`, `INTERPOLATION_ERROR`, template missing (100), a validation loop causing stuck users |
| `provider` | Meta / Reloadly / DingConnect behaving as designed or misbehaving | rate limit (2022), unsupported (200), airtime provider rejection |
| `participant` | the person's own choice or circumstance | blocked the page (190/551), out of the 24h window (10) |
| `infrastructure` | the substrate, not the app | Kafka offline partitions, CrashLoopBackOff, cron not firing |
| `unknown` | not yet attributed | `(untagged)`, `other` fb codes |

**Key property: `unknown` must be a first-class value, not a default into some other bucket.** `aggregate.js` gets the *direction* of the default right ("platform classification must be explicit — an unrecognized tag is not proof of platform fault") but the destination wrong: it dumps unknowns into `error.study`, which quietly asserts a fault domain we have not established, and blames the researcher for it. `unknown` should be visible and its growth should itself be a signal.

---

#### **A2 — Actor: who can actually do something?**

`on-call` · `researcher` · `automatic` (dean will retry) · `nobody` (expected/terminal by design)

**A2 is not derivable from A1.** The cross-product is populated:

- rate limit (2022): fault=`provider`, actor=`on-call` (we're sending too fast / need a higher tier)
- template missing (100): fault=`study`, but reported *by* the provider, actor=`researcher`
- `NETWORK`: fault=`platform`, actor=`automatic` (dean retries; a human only cares about the rate)
- code 10 / 190: fault=`participant`, actor=`nobody`
- `NULL` fb code: fault=`platform`, actor=`on-call`, and **nothing automatic will ever touch it** (§2.3)

This axis alone determines **which surface a failure belongs on**. It is the axis the current system most nearly has (platform vs study) and most often conflates with A1.

---

#### **A3 — Evidence class: what does one occurrence prove?**

| Value | Meaning | Threshold policy |
|---|---|---|
| `deterministic` | the mechanism is broken; every user down this path hits it | alarm at count ≥ 1 |
| `stochastic` | distributed over the population; a background rate is normal | alarm on ratio + absolute floor |
| `benign-baseline` | proves nothing; expected churn, tracked for trend only | never alarms; excluded from headline error counts |

`rules.js` already implements this distinction well, with a good comment ("1-in-1000 here is proof the door is locked"). **But it derives A3 from A1**, and that is wrong. `FIELD_NOT_FOUND` and `INTERPOLATION_ERROR` are *deterministic* — a bad jump target breaks the form for every respondent who reaches that branch — yet because they are study-domain they land in `error.study` and are gated behind `ratio_gte: 0.05 AND count_gte: 3`. On a study with 4 respondents an hour, a definitively broken form renders as a muted grey note. **A3 is a property of the mechanism, not of who owns it.**

---

#### **A4 — Temporal form: stock or flow?**

| Value | Question it answers | Correct primitive |
|---|---|---|
| `condition` (stock) | "how many users are broken **right now**" | gauge over current state, aged by **onset** |
| `occurrence` (flow) | "at what **rate** are errors happening" | monotonic counter of events |

This is the axis at the dead centre of the reported bug. "In ERROR Now" is a stock. The stacked time series' `max` column over a 6h range is neither a stock nor a flow — it is *the maximum instantaneous stock over a window*, which reads to a human like a flow ("22 errors happened") and is neither. `documentation/error-events.md` §4 states this correctly and precisely ("a gross rate a sampled stock provably can't reconstruct"), and then defers the piece that would fix it.

Two consequences the current design has not absorbed:

- **A stock aged by `updated` is a lie**, because dean re-warms `updated` on every retry. A user broken once at 09:00 and retried six times looks like a fresh error at 15:00. Migration `23-states-errored-at.sql` has already shipped `errored_at`; **nothing reads it yet**.
- **A sticky field on a stock row is a lie about a different row.** This is exactly the D5 bug the planning docs found (19 completed users still labelled `INTERNAL`, 181 blocked users under stale FB tags) and fixed with the state-dependent `reason` CASE. That fix is correct and is a direct consequence of A4 — worth naming as such so the next instance is recognized.

---

#### **A5 — Blast radius: how many, and correlated how?**

`user` → `form` (one question/branch) → `study` → `channel` (one Meta page / token / app) → `fleet`

This is the "breadth × taxonomy × page" discriminator from `error-visibility-design.md` §2.2, which is the single best idea in the existing planning docs and should be kept verbatim. Generalized as an axis it also resolves an ambiguity the current design has not noticed:

> **`expired_waits` has no fixed fault domain.** Narrow (one study) it means the external event never arrived — a study/integration problem. Broad (fleet) it means dean isn't running — a platform problem. Today the *same number* feeds `DeanExpiredWaits` (critical-ish, platform, on-call) and an in-app `note` (researcher). Both are right, and only A5 tells you which.

The same applies to platform-tagged errors: narrow = that study's integration is flaky, don't page; broad = platform regression, page. The docs already say this. The axis makes it general.

---

#### **A6 — Disposition: what happens if nobody acts?**

`self-healing` (user replies again, rate limit lifts) · `auto-retried` (dean, bounded attempts) · `terminal-recoverable` (a human can unstick it) · `terminal-abandoned` (**nothing will ever touch this user again**)

**This axis does not exist anywhere in the system today**, and its absence has already cost real participants. `DEAN_FB_CODES` and `DEAN_ERROR_TAGS` are hand-typed strings in `devops/values/production.yaml`; retryability is decided at Helm-template time and is never reconciled against the classification table. The consequences are documented in §2.3.

`terminal-abandoned` is the most important value on the most important axis, because it is the only class where *the count only ever goes up*. Every dashboard today shows recent-window stocks, so a permanently abandoned cohort **ages out of every single surface** and becomes invisible precisely when it becomes permanent.

---

### 1.3 Severity is a *function* of the axes, not an axis

Deliberately: there is no "severity" or "priority" axis. Severity is policy, and policy is per-surface. Given the axes, it is computable:

```
page (Slack/PagerDuty)  ⟸  actor = on-call
                            ∧ ( evidence = deterministic
                                ∨ blast_radius ≥ channel )
                            ∧ disposition ≠ self-healing

researcher action        ⟸  actor = researcher ∧ evidence = deterministic
researcher note          ⟸  actor = researcher ∧ evidence = stochastic ∧ over floor
dashboard only           ⟸  actor ∈ {automatic, nobody}
never surfaced as error  ⟸  evidence = benign-baseline
```

Every threshold number in the system (5, 10, 30%, 50%, 5%+3) is a *tuning parameter of the last two conditions*, not a definition of error. Keeping those two things apart is the whole point of this document.

---

## 2. Reconciling against what exists today

### 2.1 What the current taxonomy gets right

Genuinely good, and to be preserved:

- **The two-audience model.** "Study Health = depth in one study, Live Traffic = breadth across studies" is the right decomposition and should survive intact.
- **The breadth × taxonomy × page discriminator** (§2.2 of `error-visibility-design.md`). Best idea in the corpus. It *is* axis A5 combined with A1.
- **Raw `fb_error_code` instead of pre-bucketing** (decision W1). Correct instinct: preserve information in the metric, classify at read time. Bucketing at the exporter destroyed the real reason and made everything `other`.
- **The `form IS NOT NULL` removal** (W2b). 55% of platform-fault errors (37 of 67) were invisible because they happen *before* form resolution. This is the single highest-value finding in the existing docs.
- **The state-dependent `reason` CASE** (W4, from finding D5). Correct, and now explicable as an A4 consequence.
- **Fail-soft everywhere**: unknown metric paths `console.warn` rather than blanking the researcher's dashboard; unknown tags don't auto-escalate to platform. Right calls.
- **Different windows on purpose** (1h alerting vs 24h researcher). Right — window is policy.
- **Volume gating on low traffic** (~8 active users/hr). Right, and honestly labelled v1.

### 2.2 Where it drifts

**(a) Classification is expressed as filters, so it silently diverges.** Measured across the two boards:

| Panel | Selector | Verdict |
|---|---|---|
| 4 · In ERROR Now | `state="ERROR", study!="fallback (no study)"` | — |
| **7 · Users by State** | `state` only — **no exclusion** | **bug** (the reported symptom) |
| **11 · Blocked by reason & page** | `reason!~"\|10\|190\|551"`, **no study exclusion** | **bug**; also hardcodes the attrition set as a regex literal |
| **14 · Current breakdown (table)** | no exclusion | **bug** — this is panel 4's drill-down; a headline and its drill-down that don't reconcile is worse than no drill-down |
| 5/6/8 · ★ panels | `study!="fallback"`, **ignore `$study`/`$page_name`** | intentional (global breadth) but only signposted by a `★` |
| **10 · Error rate by page** | ignores `$study`/`$page_name` | **inconsistent** — silently ignores the picker with no `★` |
| SH · Study-fault errors | `error_tag!~"INTERNAL\|…", form!="$fallback"` | **correct** |
| SH · Platform-fault errors | `error_tag=~"INTERNAL\|…"`, no form filter | **correct, and mis-flagged as a bug** — see below |

The audit scout flagged three "critical inconsistencies". **Only two are defects.** "Platform-fault errors" including form 305 is *right*: that is where the majority of platform faults live (W2b). The asymmetry with "Study-fault errors" is correct and load-bearing — it is just undocumented, so it reads as an oversight and will eventually be "fixed" into a regression by someone tidying up. **A correct asymmetry with no written reason is a latent bug.**

**(b) Classification logic is duplicated across four implementations in three languages.** The SQL `CASE` in `devops/sql-exporter/templates/configmap.yaml` and the one in `dashboard-server/queries/states/states.queries.js` are currently byte-identical — by discipline, not by construction. `aggregate.js` holds `PLATFORM_ERROR_TAGS` as a third copy. `DEAN_FB_CODES` in Helm values is a fourth, and **has already drifted** (§2.3). No test asserts they agree.

**(c) A3 is derived from A1** — deterministic study-config faults are muted as stochastic (§1.2, A3).

**(d) The taxonomy doc is incomplete and, in one place, fictional.**
- `CORRUPTED_MESSAGE` and `STATE_TRANSITION` are assigned in `transition.js` (lines 114, 120, 156) and appear in **no** taxonomy table.
- `STATE_TRANSITION` carries `publish: false` (since commit `cb87b858`, 2020) — it reaches no table, only stdout. A platform-fault error class with **zero observability by design**, retained for six years on an inferred rationale ("most likely a loop guard").
- `documentation/states-debugging.md` §"error tags" documents `FB_API_ERROR`, `PAYMENT_ERROR`, `VALIDATION_ERROR`, `TIMEOUT_ERROR`. **None of these exist in production code.** `grep` finds them only in `dashboard-server/api/health/evaluate.test.js` and `api/states/states.test.js` fixtures. This is worse than a stale doc: the health rules engine's tests exercise a taxonomy that the platform does not produce, so the tests cannot catch a real taxonomy regression.

**(e) `study` is identified by display string.** `study!="fallback (no study)"` couples eight PromQL expressions to a human-readable label produced by a SQL `CASE`. Renaming that string breaks the dashboards silently and with no error.

**(f) Denominator semantics are unverified across surfaces.** `aggregate.js` increments `active_users` for *every* row including ERROR/BLOCKED; the exporter's `survey_active_users` is "all rows in window". These are probably the same, but "probably" is doing load-bearing work in an alert that pages people.

### 2.3 Reason values that fall through the cracks

| Reason | What happens today | Why it's a hole |
|---|---|---|
| **`fb_error_code = NULL` / `0`** | message-worker sets `StatusCode: 0` when it cannot fetch a page token → stored as NULL. Dean's `fb_error_code = ANY($1)` **never matches NULL**. | `terminal-abandoned`. 131 users sat BLOCKED for 12+ days after the July 2026 Kafka leak. The exporter now carries the raw `code` label so it's *visible*, but nothing alerts, nothing retries, and it ages out of every 1h/24h window. |
| **fb code `10`** | classed `attrition` alongside 190/551, but is **not** in `DEAN_FB_CODES` | The bucket asserts "expected churn, same as the other two" while the retry config asserts something different. Two systems, two answers, no test. |
| **`-1`** | in `DEAN_FB_CODES`, retried, **undocumented anywhere** | A retryable code with no definition of what it means. |
| **`STATE_TRANSITION`** | `publish: false` | Invisible to every surface by construction. |
| **`CORRUPTED_MESSAGE`** | recorded, not in the taxonomy → falls to `error.study` in `aggregate.js` | A platform parse failure blamed on the researcher. |
| **`(untagged)` / `none`** | → `error.study`, stochastic | Silently attributes unknown fault to the study owner; growth of this bucket (the most important signal that the taxonomy is decaying) is measured by nobody. |
| **`other` fb codes** | ELSE branch | No inventory exists of what actually lands here. |

### 2.4 Failure classes with no state row at all

The deepest gap. Every surface reads `states`; these produce no `states` error.

1. **Payment failures.** `payment_error_code` is a *stored, indexed column* on `states` (`migrations/01-init.sql:147`), computed from `state_json.md.e_payment_reloadly_error_code` where `e_payment_reloadly_success` is not true. It is read by exactly one query (`states.queries.js:242`, the detail view). **No metric, no rule, no alert, no dashboard panel.** A participant who completed the survey and was promised airtime, and did not get it, is the single worst outcome the platform can produce for a person — and it is the one failure class with zero monitoring.
2. **Pipeline stall.** If replybot stops consuming, no state changes, so no error state appears. `states`-based error metrics go *quieter*, not louder. The only tell is "Chatting Now" falling toward zero, and no alert reads it. Kafka broker alerts exist (`kafka-broker-health.yaml`) but are on a different plane and are not represented on either survey board — so a Live Traffic board that is calm because the pipeline is dead is indistinguishable from a calm board.
3. **`STATE_TRANSITION`** (above) — deliberately unlogged.
4. **Silent non-delivery.** A send that fails without a code leaves the user in `QOUT`/`RESPONDING` looking healthy while waiting forever.
5. **Mis-routing.** Referral/form-resolution sending a participant to the wrong study is a successful conversation with the wrong content. Nothing detects it.

An ontology that only classifies the errors the state machine happened to record will keep producing dashboards that are green during outages. **Negative-space monitoring — "expected traffic that did not happen" — is a required member of the taxonomy, not an add-on.**

---

## 3. One taxonomy, many views

### 3.1 The law

> **A surface may choose its window, its thresholds, and its audience filter. A surface may not choose what an error is.**

Everything in this section follows from that one sentence.

### 3.2 The source of truth: one table, compiled outward

Create **one** classification table as data — `devops/taxonomy/error-taxonomy.yaml` — keyed by `(state, reason)` and valued by the six axes:

```yaml
- match: { state: ERROR, tag: INTERNAL }
  fault: platform      # A1
  actor: on-call       # A2
  evidence: deterministic  # A3
  disposition: auto-retried  # A6
  label: "Internal platform error"

- match: { state: ERROR, tag: FIELD_NOT_FOUND }
  fault: study
  actor: researcher
  evidence: deterministic          # ← corrects today's stochastic gating
  disposition: terminal-recoverable
  label: "Form refers to a field that doesn't exist"

- match: { state: ERROR, tag: FORM_NOT_FOUND, form: "305" }
  fault: none
  actor: nobody
  evidence: benign-baseline        # ← the honest way to express "exclude 305"
  disposition: terminal-by-design
  label: "No study assigned (fallback)"

- match: { state: BLOCKED, code: null }
  fault: platform
  actor: on-call
  evidence: deterministic
  disposition: terminal-abandoned  # ← makes the black hole nameable
  label: "Never reached Meta (no page token)"
```

From this one file, generate (checked in, CI-verified to be in sync):

| Artifact | Consumer |
|---|---|
| a SQL `CASE` fragment emitting `fault`/`evidence` labels | `devops/sql-exporter/templates/configmap.yaml` |
| the same fragment | `dashboard-server/queries/states/states.queries.js` |
| a JS lookup map | `dashboard-server/api/health/aggregate.js` (replaces `PLATFORM_ERROR_TAGS`) |
| `DEAN_ERROR_TAGS` / `DEAN_FB_CODES` values | `devops/values/*.yaml` — **derived from `disposition: auto-retried`, never hand-typed** |
| the markdown table | `documentation/study-error-alerting.md` |

A CI check that regenerates and diffs turns "four implementations kept in sync by discipline" into "one implementation, mechanically enforced". This is the fix that makes panel-7-class bugs structurally impossible rather than individually patchable.

### 3.3 The cheap 80%: classify at the exporter, filter on labels

Full codegen is a week. **Most of the benefit lands in a day**: add the derived labels to `survey_recent_states` and the `study_health` metrics.

```promql
# before — every panel re-derives the taxonomy from a display string
sum(survey_recent_states{window="5m", state="ERROR", study!="fallback (no study)"})

# after — the taxonomy is in the data; the panel states its intent
sum(survey_recent_states{window="5m", state="ERROR", evidence!="benign-baseline"})
```

Two properties worth noting:

- **`fault` and `evidence` are functionally dependent on `(state, reason)`, so they add zero series.** Cardinality cost is nil; only the label-set width grows.
- A panel author can no longer *forget* the exclusion, because the exclusion is no longer a special case they have to remember — it is the normal selector.

Also add **window-pinning recording rules** so no human ever types `window="5m"`:

```yaml
- record: survey:states:5m
  expr: survey_recent_states{window="5m"}
```

The existing configmap comment — `!! Any PromQL over this metric MUST pin the window ... omitting it silently triple-counts` — is excellent documentation of a hazard that should not exist. A rule that must be remembered by every future query author will eventually not be.

### 3.4 Surface assignment: one question each

| Surface | The one question it answers | Window | Filter (in terms of the axes) | Must not |
|---|---|---|---|---|
| **Live Traffic** (Grafana) | *"Is something broken right now, and where?"* | 5m stock, plus 1h/24h for context | `evidence != benign-baseline`; **no** fault filter — show platform, study, provider, unknown side by side; A5 breadth stats are global by design | have thresholds or colours implying severity; be the place anyone looks for "how many errors today" (that's a flow, and this is a stock) |
| **Study Health** (Grafana) | *"Which study is degraded, and is it the platform or the study?"* | 1h | split by `fault`, per-study, with excess-vs-fleet-baseline | be a second Live Traffic; own its own reason lists |
| **In-app Monitor** (CockroachDB) | *"Is MY study healthy, and what do I do about it?"* | 24h | `actor = researcher` → findings; `actor = on-call` → no-blame notice; `actor ∈ {automatic, nobody}` → invisible | show raw tags; make the researcher classify anything; be the only place a payment failure could have been noticed but isn't |
| **AlertManager → Slack** | *"Should a human be interrupted?"* | 1h + `for:` | `actor = on-call ∧ (evidence = deterministic ∨ radius ≥ channel) ∧ disposition ≠ self-healing` | fire on anything a researcher owns; fire on `benign-baseline`; be the discovery mechanism for `terminal-abandoned` cohorts (they need a *backlog* alert, not a rate alert) |

Two structural corollaries:

- **Only the in-app surface has user IDs, and that is correct by design.** User IDs are never exported to Prometheus — for cardinality (millions of series) and for privacy (Grafana has no per-study auth scope; the app does). Grafana's job ends at *(study, form, page, reason)*; the app's begins at the individual. This should be **written on the dashboard** as a text panel with a link, not left as tribal knowledge — right now it reads as a missing feature.
- **A headline stat and its drill-down must be the same query with fewer aggregations.** Panel 4 and panel 14 must be generated from one expression. If they can drift, they will.

---

## 4. Prioritized recommendations

### P0 — hours, high impact, do this week

**P0.1 — Make panel 7 agree with panel 4.**
The narrow fix is to copy panel 4's selector onto panel 7. Do that today for consistency, but understand it is the *wrong long-term fix* (see P1.2): the fallback bucket contains both by-design noise and the majority of real platform faults, and blanket-excluding it by study name throws away the second to suppress the first. Correct final form:

```promql
sum by (state) (survey_recent_states{window="$window", study=~"$study",
                                     page_name=~"$page_name",
                                     evidence!="benign-baseline"})
```

**P0.2 — Remove `max` from panel 7's legend calcs; set `calcs: ["last"]`.**
This is very likely the actual source of "~22" against a headline of 3: a 6h-range chart showing the peak stock in a column next to the current stock. Also pin the dashboard's default time range to something proportionate to the window (5m window → 1h range), and retitle to state the semantics: *"Users currently in each state (5m snapshot)"*.

**P0.3 — Fix panels 11 and 14.** Panel 11 gains the same treatment as the ERROR panels and stops hardcoding `reason!~"|10|190|551"`. **Panel 14 is the most important of the three**: it is panel 4's drill-down and must reconcile exactly, or the drill-down actively misleads. Better than filtering it: add `evidence`/`fault` as *columns* so the table explains itself.

**P0.4 — Mark or fix panels 10, 5, 6, 8.** These ignore `$study`/`$page_name`. For 5/6/8 that's intentional (breadth is the point) — say so in the panel description, not just a `★`. Panel 10 (error rate by page) looks unintentional; either wire the variables in or mark it global.

**P0.5 — Write down the platform-fault/study-fault asymmetry on Study Health.** Add to both panel descriptions: *"Platform-fault errors intentionally include form 305 — most platform faults occur before form resolution (55% in the July 2026 measurement). Study-fault errors intentionally exclude it — 305's FORM_NOT_FOUND is by design."* This is a two-line change that prevents someone "fixing" a correct asymmetry into a regression.

**P0.6 — Resolve the branch/prod split.** `live-traffic.json` is running in production as a ConfigMap while its source sits on 56 unmerged commits on `feature/live-traffic-dashboard`. Per this repo's own IaC rule ("the repo is the source of truth; the cluster is a build artifact"), prod is currently a build artifact of something that isn't on `main`. Merge it, or revert the ConfigMap. This is the cheapest item here and the one most likely to cost a day later.

**P0.7 — Delete the fictional error tags from `documentation/states-debugging.md`** and fix `evaluate.test.js` / `states.test.js` to use real tags. Tests written against a taxonomy the platform doesn't emit cannot detect taxonomy regressions.

---

### P1 — days, structural

**P1.1 — Emit `fault` and `evidence` labels from the exporter; rewrite every panel and rule to filter on them** (§3.3). Zero cardinality cost. This is the change that ends the whole bug class. Add window-pinning recording rules at the same time.

**P1.2 — Give the fallback/unknown bucket first-class treatment.**
The current handling — exclude by display string, in 8 of 11 places — is wrong in both directions: it hides the real platform faults that live there, and it treats a real population as noise.

- Split it at the exporter. `study="(pre-form)"` for form 305, with `reason` preserved, and `evidence: benign-baseline` **only** on the `(305, FORM_NOT_FOUND)` pair — not on the whole bucket. Every other reason on 305 is a genuine pre-form-resolution platform fault and must be counted.
- Add a first-class Live Traffic stat: **"Errors before form resolution"**. This is where platform regressions appear *first*, because they happen before the form is known. It should be prominent, not excluded.
- Keep `study="unknown"` (shortcode present, no `surveys` row) **separate** from `(pre-form)`. They are different failures — the second is a data-integrity problem worth its own low-threshold alert.

**P1.3 — Build the drill-down ladder, and label it.**
Make the path from "N in ERROR now" to specifics explicit *on the board*:

> **4 · In ERROR Now** → **8 · which reasons, across how many studies** → **13 · which study × form** → **14 · exact row (study × form × page × state × reason)** → **link out to the app for individual respondents.**

Add Grafana data links on panel 14 rows to the dashboard-client Monitor tab with prefilled filters (`/surveys/<study>/monitor?state=ERROR&form=<form>`) — verify the query-param contract `StatesList` accepts. Add a text panel stating plainly: *"Individual respondent IDs are deliberately never exported to Prometheus (per-user series would be unbounded, and Grafana has no per-study access control). Respondent-level detail lives in the app's Monitor tab, scoped to the studies you own."* Framing this as a **design boundary rather than a missing feature** is most of the value.

**P1.4 — Model `disposition`, and close the `terminal-abandoned` black hole.**
- Generate `DEAN_FB_CODES` / `DEAN_ERROR_TAGS` from the taxonomy table so the retry config and the classification cannot disagree.
- Reconcile the code-10 discrepancy explicitly (attrition-bucketed, not retried).
- Add a metric and an alert for **BLOCKED users whose code matches no retry rule** — including `NULL`. Today those users are invisible from the moment they become permanent. This alert must be a **backlog/age** alert (`count of users terminal-abandoned for > 24h`), not a rate alert, because the population is a stock that only grows.
- Define `-1`.

**P1.5 — Fix the evidence-class conflation in `rules.js`.** `FIELD_NOT_FOUND`, `INTERPOLATION_ERROR`, and non-305 `FORM_NOT_FOUND` are deterministic: `count_gte: 1`, level `action`. Only `(untagged)`/`none` remains stochastic. A definitively broken form on a 4-respondent study should not render as grey text.

**P1.6 — Age the error stock by `errored_at`, not `updated`.** Migration 23 has shipped; nothing reads it. This de-flaps the alerts that dean's retries currently re-warm, and it requires no new infrastructure. `error-events.md` §4 already identifies this as the one piece of the deferred design that isn't blocked — it is the highest value-per-hour item on this entire list.

**P1.7 — Add `unknown` as a visible fault domain** and stop defaulting untagged errors into `error.study`. Chart the unknown share; a rising unknown fraction is the leading indicator that the taxonomy has decayed.

---

### P2 — weeks

**P2.1 — Build the `errors` flow projection** (`error-events.md` piece B). The A4 axis is the deepest missing thing. Note the documented blocker is real and specific: `FB` delivery errors carry no `form`/`platform` because `send_message` never told message-worker which survey it was for, so attribution today happens via `states`. That wire-format change is the prerequisite; scope it as such rather than as part of the projection.

**P2.2 — Cover the failures with no state row.**
- **Payments first.** Add `survey_payment_failures{form, study, provider, code}` from the existing `payment_error_code` column, an in-app finding, and an alert. A participant who earned an incentive and didn't receive it should not be the least-monitored failure on the platform.
- Decide `STATE_TRANSITION`'s fate: publish it, or document the 2020 loop-guard rationale properly and count it in-process. "Probably a loop guard" is not a monitoring posture.
- Put a **pipeline-liveness indicator** on Live Traffic (Kafka lag, replybot consumption) so a board that is calm because nothing is flowing cannot be mistaken for a board that is calm because everything is fine.

**P2.3 — Collapse to one metric family.** `survey_recent_states` (multi-state, multi-window, with `reason`/`study`/`page`) can express everything `survey_error_states`, `survey_blocked_states`, and `survey_active_users` express. Two families with two naming schemes and two fallback-identification conventions (`study!="fallback (no study)"` vs `form!="$fallback"`) is the second-order cause of the dashboard divergence. Migrate alerts, then deprecate the singles.

**P2.4 — Do W5 (threshold recalibration) from observed distributions**, now with ≥1 week of post-W2b data. Set thresholds from percentiles, and record the derivation next to the numbers so the next tuner isn't re-guessing.

**P2.5 — CI-enforce the taxonomy** (§3.2): regenerate all consumers from the table, diff, fail the build. Plus one integration test asserting the exporter and `healthSummary` return identical classifications for identical rows.

---

### P3 — later / explicitly deferred

- Per-survey rule overrides (`rules.js` is already data-only, so the door is open).
- Prometheus-backed sparklines in the app.
- Fold infra alerts (Kafka, cron, app-health) into the same ontology as `fault: infrastructure` so there is one health model rather than two planes.
- An on-call-only user-level surface, if §5 concludes Grafana → app linking isn't enough.

---

### 4.x What the existing planning docs got right vs. missed

**Keep (already right):** the two-audience model; the breadth × taxonomy × page discriminator; raw codes over pre-bucketed categories; the NULL-form fix; the state-dependent `reason` CASE; deterministic-vs-stochastic as a concept; different windows on purpose; fail-soft defaults; honest v1 labelling of thresholds; the stock/flow distinction in `error-events.md` §4 (correctly articulated even though the implementation is deferred).

**Missed:**
1. **Classification lives in filter expressions, not in the data** — so "one taxonomy, four consumers" is enforced by discipline and is already drifting.
2. **`disposition` was never modelled** — hence the NULL-code black hole and the code-10 disagreement.
3. **Evidence class was derived from fault domain** — deterministic study-config faults are muted.
4. **Failures with no state row** — payments, pipeline stall, `STATE_TRANSITION`, silent non-delivery, mis-routing.
5. **No reconciliation contract between a stat and its drill-down.**
6. **The fallback bucket was treated as noise to exclude** rather than a population to explain — the exclusion is applied inconsistently precisely because it has no principled definition.
7. **`errored_at` shipped and nothing reads it** — the de-flapping benefit was designed and then left on the table.
8. **No lifecycle owner for the taxonomy itself.** When someone adds a new `error_tag` tomorrow, nothing fails, nothing warns, and it silently becomes the researcher's fault.

---

## 5. Open questions for you

These are judgment calls the research cannot settle.

**Audience & blame**
1. Should researchers see platform-fault errors *at all*, or only a no-blame notice? Today they get a count plus a respondent list. Showing the count is honest; it also invites tickets we'd rather absorb.
2. When a study is 100% broken but has only 4 respondents/hour, is that a page at 03:00? A 4-respondent study may be a pilot — or a $50k RCT in its final week. Is there a per-study importance/tier the taxonomy should carry?

**Thresholds & SLO**
3. **There is no stated reliability target anywhere.** Something like *"fewer than 1% of participants per day hit an error they don't recover from"* would turn every threshold from a guess into a derivation. Is there an implicit target we can write down?
4. Should Live Traffic carry any thresholds/colours, or stay purely descriptive? Colours make it scannable; they also make it a second, unmanaged alerting system.

**Classification calls**
5. Is fb code **10** ("outside allowed window") really participant attrition, or a delivery-timing bug on our side that we've been classifying as inevitable? The answer changes whether it's `benign-baseline` or `actor: platform`.
6. Are **payment failures** the researcher's problem, the platform's, or both? This decides which surface owns them and how loudly they alarm.
7. What is the acceptable rate for the **pre-form / no-study-resolved** population? Is a participant arriving with no resolvable study a bug we should be driving to zero, or an expected consequence of how ads and referral links work?
8. What should happen to the **131-user-class `terminal-abandoned` cohort** when detected — auto-requeue, manual runbook, or accept and report? Whether the alert is a page or a weekly digest depends on this.

**Boundaries & sequencing**
9. Is Grafana → app linking sufficient for on-call to reach individual users, or does on-call need a user-level surface of its own? (I'd argue the app is correct and the linking is the fix, but PII posture is your call.)
10. Which comes first — the taxonomy-as-data codegen (P1.1/P2.5, higher ceiling, ~a week) or the `errors` flow projection (P2.1, unblocks honest rates but needs a wire-format change across replybot + message-worker)? They're independent; doing both at once will stall.
11. Merge or revert the Live Traffic branch (P0.6)? 56 commits unmerged against a ConfigMap already live in prod is a decision that gets more expensive every week it's deferred.

---

## Appendix — provenance & verification

Produced 2026-07-27 by a multi-agent pass: seven parallel scouts over the four
health surfaces, the taxonomy source, the metrics pipeline, provider-error
handling, the existing planning docs, the `rules.js` severity model, and a
panel-by-panel audit of both Grafana boards; synthesized into this document.

The originating symptom was reproduced live against prod Prometheus:
`sum(survey_recent_states{window="5m",state="ERROR",study!="fallback (no study)"})`
= 1 vs `sum(...{state="ERROR"})` = 4, fallback alone contributing 3. A 6h range
query showed the gap fluctuating, consistent with the reported 3-vs-~22 read.

Claims spot-checked against the repo after synthesis (all confirmed):

| Claim | Verification |
|---|---|
| `errored_at` shipped but has no reader | replybot *writes* episode-onset `ts` correctly (`replybot/lib/typewheels/machine.js:251`, retry-immune by design), but `errored_at` appears in **no** query in `dashboard-server/`, `devops/sql-exporter/`, or `devops/alerts/`. Write side shipped; read side did not. |
| `payment_error_code` has zero monitoring | Read at exactly one line — `dashboard-server/queries/states/states.queries.js:242` (detail view). Zero references in the exporter or alert rules. |
| `documentation/states-debugging.md` documents tags production never emits | `FB_API_ERROR`, `PAYMENT_ERROR` appear only in docs/planning. `VALIDATION_ERROR`, `TIMEOUT_ERROR` appear only in docs/planning **and test fixtures** (`api/health/evaluate.test.js`, `api/states/states.test.js`). None in production source. |
| Panels 7, 11, 14 lack the fallback exclusion; panel 10 ignores `$study`/`$page_name` | Confirmed by direct read of `live-traffic.json` on `feature/live-traffic-dashboard`. |

Un-verified claims carried from scout reports (flagged rather than dropped —
confirm before acting): the "55% of platform faults occur pre-form-resolution
(37 of 67)" measurement, the "131 users blocked 12+ days" cohort size, and the
`STATE_TRANSITION` `publish: false` rationale attributed to commit `cb87b858`.