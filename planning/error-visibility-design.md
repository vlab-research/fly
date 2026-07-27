# Error visibility design — Study Health & Live Traffic

> **Status:** design only. Nothing here is implemented. Measurements taken against
> prod CockroachDB and Prometheus on **2026-07-26**.
>
> **Goal (user's words):** *"I want to better be able to see the details of errors to
> see if there is an issue. Right now I have a hard time seeing that."*
>
> **The split we are designing toward:**
> - **Study Health** — problems *inside one survey/study*: a broken form, a bad jump
>   target, one study bleeding users.
> - **Live Traffic** — problems that *cut across* surveys: a platform regression, one
>   messaging page failing, a Kafka/Dean stall.
>
> **Required reading:** `documentation/study-error-alerting.md` (taxonomy contract),
> `devops/grafana-dashboards/README.md`, `documentation/alerting.md`,
> `documentation/states-debugging.md`.

---

## 1. Problem statement — what you cannot see today, panel by panel

### 1.1 Two Live Traffic stat panels are numerically wrong

This is the single worst problem on either board, and it is a pure PromQL bug.

`survey_recent_states` is emitted from a **24h index scan** and gauges *all three
windows on every group*. A (state, form, page) group that had traffic 20 hours ago but
none in the last 5 minutes is still emitted, with `window="5m"` **value 0**. `count by`
counts *series*, not non-zero values. So:

| Panel (live-traffic.json) | Expression | Reads | Truth |
|---|---|---|---|
| **Active Studies** (id 2) | `count(count by (study) (survey_recent_states{window="$window",…}))` | **29** | **3** |
| **Active Pages** (id 3) | `count(count by (page) (survey_recent_states{window="$window",…}))` | **7** | **4** |

Measured 2026-07-26 at `window="5m"`. `count(sum by (study)(…{window="5m"}) > 0)` = 3;
`count(sum by (page)(…{window="5m"}) > 0)` = 4.

Consequences: both numbers are effectively **constants** — they barely move between the
5m, 1h and 24h windows because they are really "distinct studies/pages seen in the last
24h". The one number on the board that should answer *"is this one study or everything?"*
never changes, so nobody looks at it. Every future breadth panel will inherit this bug
unless the `> 0` filter is treated as mandatory.

### 1.2 Study Health's error panel is drowned by form 305 and sums away `form`

Panel id 4, "Error States by Tag (1h window, all forms)":

```promql
sum by (error_tag) (survey_error_states{form=~"$form"})
```

Live values right now: `FORM_NOT_FOUND = 17` (100% of it form 305, by design),
`INTERNAL = 3` (three *different, unrelated* studies — `banglahpv`, `dreampay1`,
`girleffectincentive`). Over 24h: `FORM_NOT_FOUND = 346` of which **333 are form 305**.

So the panel shows one permanent orange mountain and a 3-pixel red sliver, and the red
sliver is the only thing that matters. Worse, `sum by (error_tag)` **discards `form`** —
you cannot tell whether `INTERNAL = 3` is *one study with three broken users* (probably a
study integration) or *three studies with one each* (which is what it actually is, and
reads as a platform smell). The panel answers "what kind of error" and refuses to answer
"whose".

### 1.3 The blocked panel does the same thing, and its biggest bucket is `other`

Panel id 3: `sum by (category) (survey_blocked_states{form=~"$form"})`. Current 1h
values: `attrition = 6`, `other = 11`. Over 24h the raw codes are:

| fb_error_code | users (24h) | bucket today | reality |
|---|---|---|---|
| 551 | 101 | attrition | normal churn |
| **-1** | **36** | **`other`** | **`(#-1) Unexpected internal error`** — Meta-side failure |
| **100** | **26** | template_missing | **one study**: *Bauchi HPV MNCH Week* |
| 10 | 16 | attrition | normal churn |
| 190 | 2 | attrition | normal churn |

Two failures here. (a) `attrition` is stacked into the same panel it is meant to be
excluded from — it is greyed but still inflates the stack height, so the actionable
categories are visually squashed. (b) **36 users blocked by Facebook's own internal error
are labelled `other`** and are indistinguishable from genuine long-tail noise. And because
`form` is summed away, you cannot see that the 26 `template_missing` blocks are *all one
study* — which is precisely the within-survey signal Study Health exists to surface.

### 1.4 55% of platform-fault errors are invisible to every metric

Every `study_health` query ends with `AND current_form IS NOT NULL`. Measured over 30 days:

```
ERROR states with error_tag IN (INTERNAL, STATE_ACTIONS, NETWORK):
  total 67   |   current_form IS NULL: 37   →  55.2% invisible
```

On several days (2026-07-18, -17, -16, -09) **every single** platform-tagged error had a
NULL `current_form` and was therefore dropped from `survey_error_states` entirely. Those
days show `sum(survey_error_states{error_tag=~"INTERNAL|…"}) = 0` while 1–6 users were
actually hitting internal errors.

This is not just a dashboard gap — `PlatformInternalErrors` (threshold ≥ 5, critical,
pages) reads exactly that expression. **The page-worthy alert is blind to more than half
its own signal.** The same filter drops those rows from `survey_active_users` and from
`survey_recent_states`, so they are invisible on both boards too.

(NULL `current_form` also affects 26 `START` rows and 1 `USER_BLOCKED` row over 30d —
users who hit an error before a form was ever resolved. That is *exactly* the population
you want visible when form resolution breaks.)

### 1.5 `study` is missing from every 1h metric, so Study Health cannot filter by study

Study Health's only template variable is `$form`. But a study is a `survey_name` spanning
**many shortcodes** (`documentation/states-debugging.md` §Survey to States Mapping). A
person who knows "the MENtality study looks wrong" has to know its shortcodes to use the
board. There is no `$study` variable because `survey_error_states` and friends carry only
`form`.

### 1.6 Form 305's `study` label is actively misleading on Live Traffic

`survey_recent_states` resolves `study` as the **newest** `surveys` row for the shortcode.
For the fallback form:

```
shortcode | survey_name        | created
305       | MENtality          | 2026-06-22   ← wins
305       | MENtality          | 2026-06-18
305       | HPV Nigeria Study   | 2026-06-16
305       | Kenya Girl Effect  | 2026-06-15
```

So on the Live Traffic board, **`study="MENtality"` shows 331 users at a 100% error rate**
— across three different pages. It is the loudest thing on "ERROR States by Study & Form"
and on the breakdown table, and it is a lie: those users have *no* study, which is the
whole point of the fallback. The real MENtality study is buried underneath its own
impostor.

Measured error attribution over 24h (with the same resolution the exporter uses):

| study | page | errors | active | ratio |
|---|---|---|---|---|
| MENtality *(= form 305 fallback)* | TM Project | 254 | 254 | 100% |
| MENtality *(= form 305 fallback)* | Global Health Hub | 74 | 74 | 100% |
| **unknown** | TM Project | **13** | 13 | 100% |
| VaxSocial Endline | Global Health Hub | 3 | 7 | 43% |
| Kenya Girl Effect | Our World In Surveys | 2 | 387 | 0.5% |
| *(8 more, ≤1 error each)* | | | | |

The `unknown / 13` row is a **real, actionable, currently-unnoticed problem**:
shortcodes `slcNrF05`, `slcNrF06`, `slcNrF08`, `slcNrF09`, `slcNrF010` are throwing
`FORM_NOT_FOUND` and **have no row in `surveys` at all**. Nobody can see it, because it
sits at 4% of the height of the fallback form's bar.

### 1.7 The 1h window smears; the 5m window has no *why*

Already documented and correct: Study Health's 1h window holds a spike visible for an hour
after it stops. Live Traffic's 5m window is the spike detector. But Live Traffic's ERROR
panels carry **no error taxonomy at all** — `survey_recent_states` has `state="ERROR"` and
nothing more. So the drill path is: *see a spike on Live Traffic → click through to Study
Health → lose the time resolution and gain form-summed tags*. The handoff loses the thing
you came for.

### 1.8 Summary — the questions you cannot answer today

| Question | Answerable today? |
|---|---|
| Is this one study or all of them? | No — the breadth stats are broken (§1.1) |
| Which study is bleeding? | No — `form` is summed away (§1.2, §1.3) |
| Is this a platform fault or a study's own misconfig? | Partly — the tags exist but 305 buries them and 55% of platform errors are dropped (§1.2, §1.4) |
| Is this one messaging page or all pages? | Only for raw ERROR counts; nothing by error kind (§1.7) |
| Which *question/field* broke? | No — and correctly so; that belongs in the Monitor tab |
| What is normal? | No — no fleet baseline anywhere |

---

## 2. The discriminator — within-survey vs cross-survey

This is the crux, so it gets its own section.

### 2.1 Candidates, evaluated

**(a) Number of distinct studies erroring simultaneously.**
This is what `MultiSurveyErrorRegression` already uses (≥3 forms with ratio > 0.3).
*Verdict: necessary but not sufficient.* Three problems: it counts **forms**, not studies,
and one study spans many shortcodes — so a single study with 4 broken forms *looks like*
a platform regression. It has no volume-independent meaning at current traffic (a form
with 1 active user and 1 error scores ratio 1.0 — three such forms trip a critical page).
And form 305 guarantees breadth ≥ 1 permanently.

**(b) Error concentration — is one study an outlier vs the fleet?**
Compute the fleet-wide ratio and each study's excess over it. Fully computable from
existing metrics today, no new SQL:
```promql
sum(survey_error_states{form!="305"}) / clamp_min(sum(survey_active_users{form!="305"}), 1)
```
= **0.0385** right now. Per-form excess validated live: `banglahpv` +0.96, `dreampay1`
+0.96, `girleffectincentive` +0.29.
*Verdict: the right shape, wrong on its own.* Its failure mode is exactly the platform
case — when the platform breaks, *everyone's* ratio rises together, the fleet baseline
rises with it, and **every study's excess goes to ~zero**. Excess-vs-fleet is a superb
*within-survey* detector and a terrible cross-survey one. That asymmetry is useful: put it
on **Study Health only**.

**(c) The error_tag allow-list (platform tags vs study tags).**
`INTERNAL / STATE_ACTIONS / NETWORK` = platform. `FORM_NOT_FOUND / FIELD_NOT_FOUND /
INTERPOLATION_ERROR` and anything unrecognised = study. This is the *semantic* answer and
it is already in the data.
*Verdict: the strongest single signal, and the boards barely use it.* But it is not
sufficient alone, in both directions: an untagged error (`none`) says nothing; and a
**study-side tag appearing in many unrelated studies at once is a platform regression** —
if formcentral goes down, every study throws `FORM_NOT_FOUND`, which the tag alone would
misread as 40 simultaneous study misconfigurations.

**(d) Clustering by `page` rather than by `study`.**
Measured 24h error rate by page: TM Project 27.9%, Virtual Lab 16.7%, Global Health Hub
5.6%, Our World In Surveys 1.0%, Digital Insights 0%. (TM Project's number is the fallback
form; strip that and it collapses.)
*Verdict: essential, and it is the axis nobody has.* It discriminates a **third** class
that neither (a) nor (c) can see: a *messaging-channel* failure. Broad across studies but
narrow on one page = expired page token, page-level rate limit, one Meta app misbehaving.
Broad across studies *and* pages = code regression. `survey_recent_states` already carries
`page`/`page_name`, so this needs no new SQL — only panels.

**(e) The same error_tag spiking across unrelated studies.**
*Verdict: this is the actual answer.* It is (c) crossed with (a), and it resolves both of
their failure modes. Needs `error_tag` and `study` on the same metric — which today exists
on **neither** (`survey_error_states` has `form`+`error_tag` but no `study`;
`survey_recent_states` has `study`+`page` but no tag).

### 2.2 The discriminator, stated

> **Breadth × taxonomy, with `page` as the third axis.**

| | **narrow** (1 study) | **broad** (≥3 unrelated studies) |
|---|---|---|
| **platform tag** (INTERNAL / STATE_ACTIONS / NETWORK) | One study's integration is flaky (payments, external events). Platform-adjacent — investigate, don't page. | **PLATFORM REGRESSION.** Page. Check deploys, CockroachDB, Redis, Kafka lag. |
| **study tag** (FORM_NOT_FOUND / FIELD_NOT_FOUND / INTERPOLATION_ERROR) | **STUDY MISCONFIG.** The classic. Ticket the owner. | **PLATFORM.** Form resolution / formcentral / interpolation engine regression, *not* 40 simultaneous edits. |

…and orthogonally:

> If breadth is broad across **studies** but narrow on one **page** → it is the
> messaging channel (token, rate limit, Meta app), not the code.

Two rules follow that shape every panel below:

1. **Study Health measures depth**: for *one* study — how much, which tag, how far above
   the fleet baseline, which question.
2. **Live Traffic measures breadth**: how many studies / how many pages carry each error
   reason, right now.

### 2.3 What is computable today vs what needs new SQL

| Signal | Today? |
|---|---|
| Fleet baseline ratio, per-form excess | **Yes** — validated live, PromQL only |
| Breadth in **forms**, per platform/study tag class | **Yes** — `count(count by (form)(survey_error_states{…} > 0))` = 3 right now |
| Breadth in **studies** | **No** — needs `study` on an error-bearing metric |
| Breadth in **pages**, per error reason | **No** — needs `reason` on `survey_recent_states` |
| Raw ERROR count by page | Yes |
| Which study a `template_missing` block belongs to | **No** — needs `study` on `survey_blocked_states` |
| Platform errors with no resolved form | **No** — dropped by `current_form IS NOT NULL` |

So: **two additive exporter changes** unlock everything — a `reason` label on
`survey_recent_states` (breadth, Live Traffic) and a `study` label on the `study_health`
metrics (depth + attribution, Study Health). Both are measured below and both are cheap.

---

## 3. Is a new metric needed? (answering the brief's Q4 honestly)

**No new metric. Two new labels on two existing metrics, plus a filter removal.**

### 3.1 Adding `reason` to `survey_recent_states` — recommended, cost ≈ zero

The brief asks specifically about adding `error_tag`. I recommend something slightly
better: **one `reason` label that is state-dependent** —

```sql
CASE
  WHEN current_state = 'ERROR'   THEN COALESCE(error_tag, 'none')
  WHEN current_state = 'BLOCKED' THEN <the existing fb_error_code bucketing>
  ELSE ''
END AS reason
```

Why not a bare `error_tag` column: **`error_tag` is sticky on non-ERROR rows.** Measured
over 24h with `error_tag IS NOT NULL`:

```
ERROR   / FORM_NOT_FOUND  346
BLOCKED / FB             181     ← stale tag on a BLOCKED row
END     / INTERNAL        19     ← stale tag on a completed user
ERROR   / INTERNAL         18
QOUT    / INTERNAL          3     ← stale tag on a live user
QOUT    / FB                1
```

A raw `error_tag` label would put 19 completed users under `INTERNAL` and 181 blocked
users under a bogus `FB` tag. The state-dependent `CASE` blanks those and, as a bonus,
folds the BLOCKED categories into the same label — giving Live Traffic the blocked
breakdown by **page and study** that Study Health has only by form.

**Cardinality — measured, not estimated.** Grouping the live 24h traffic query by
`(state, form, page)` vs `(state, form, page, reason)`:

```
124 groups  →  127 groups        (+3)
```

× 3 windows = **372 → 381 series**. With the NULL-form fix and fallback relabel the
measured plan produced **129 groups → ~387 series**. Series growth is ~4%. The reason it
is this cheap is structural: `reason` is `''` for the ~85% of groups that are neither
ERROR nor BLOCKED, so it cannot multiply the dominant states.

**Bound, not just today's number.** Distinct `error_tag` values on ERROR rows over 90
days: `FORM_NOT_FOUND`, `INTERNAL`, `STATE_ACTIONS` — 3. The taxonomy adds
`FIELD_NOT_FOUND`, `INTERPOLATION_ERROR`, `NETWORK`, `none` → 7 possible. Blocked adds 6
buckets. Worst case is bounded at `states × forms × pages × 13`, but the state-dependence
means the realistic ceiling is roughly `(#error forms × #pages × 7) + (#blocked forms ×
#pages × 6)` added to the current 124 — order **+30 groups** even at a much worse day than
today. Safe.

**Query cost — measured.** Proposed query (with `reason`, NULL-form fix and fallback
relabel) vs current, 3 runs each:

```
current:   601ms / 489ms / 563ms
proposed:  288ms / 343ms / 561ms
```

A wash. The plan confirms index discipline is preserved:

```
scan  table: states@states_current_state_updated_idx
      spans: [/'BLOCKED'/'2026-07-25 14:34…' - /'BLOCKED'] [/'END'/… ] … (6 more)
      actual row count: 2,970   KV time: 29ms
```

Adding `error_tag` / `fb_error_code` to the projection does force an index join back to
`states@primary` (+77ms KV, +3 MiB) because they are not in the covering index — absorbed
into the noise, but stated for the record.

### 3.2 Adding `study` to the `study_health` metrics — recommended, cost small

Same `LEFT JOIN LATERAL` the traffic collector already uses. Measured, 3 runs each:

| query | current | with `study` join |
|---|---|---|
| `survey_error_states` | 12–29ms, 24 KiB | **62–144ms, 7 MiB** |
| `survey_active_users` | — | **87–123ms, 16 MiB** |

Acceptable at a 60s scrape. **Crucially, series count does not grow**: `study` is
functionally determined by `form` (exactly one newest `surveys` row per shortcode), so
each existing series simply gains a label. Blast radius is analysed in §7.

### 3.3 An observation worth acting on separately

The `study_traffic` query's dominant cost is **not** `states`. The plan shows:

```
scan  table: surveys@primary   spans: FULL SCAN
      actual row count: 5,059   KV bytes read: 300 MiB   KV time: 412ms
      estimated row count: 4,087 (100% of the table; stats collected 185 days ago)
```

The shortcode→`survey_name` lookup full-scans `surveys` and reads **300 MiB per scrape**,
because `survey_name` is not stored in `surveys_shortcode_userid_created_idx` (which does
store the enormous `form_json`). Every additional `study` join inherits this. A covering
index would fix it for the current query *and* every proposed one:

```sql
CREATE INDEX surveys_shortcode_created_name_idx
  ON surveys (shortcode, created DESC) STORING (survey_name);
```

`surveys` is 5,059 rows — the index is trivial. Also: `ANALYZE surveys` (stats are 185
days stale) and `ANALYZE states` (the plan emits `WARNING: the row count estimate is
inaccurate`). **Uncertain:** I have not measured the post-index plan, because creating an
index on prod is out of scope for a design task. Measurement that would resolve it: create
the index in a staging CockroachDB with prod-shaped `surveys`, re-run the traffic query,
compare `KV bytes read`. I would expect 300 MiB → <1 MiB.

Do **not** attempt the "obvious" alternative of a scalar subquery instead of the LATERAL —
measured at **3.1s / 3.8s / 6.0s**, an order of magnitude worse. The existing LATERAL form
is correct.

---

## 4. Study Health — proposed changes

**Job:** *depth in one study.* Which study is bleeding, by how much relative to normal,
from what cause, and where to click next.

Add a `$study` template variable (needs §6.2):

```json
"definition": "label_values(survey_active_users, study)"
```

…and keep `$form` as a secondary filter. Add a `$fallback` constant variable
(`hide: 2`, value `305`) so the exclusions are not string-literals scattered across nine
panels.

### 4.1 ADD — "Study triage" table (new panel, top of board, full width)

The one panel that answers *"which study is bleeding, and is it worse than normal?"*
Grafana 7.4.2 table panel, six instant queries merged on the `form` label with the
**Merge** transformation (available since 7.1), then **Organize fields** to order/rename.

| refId | expr | column |
|---|---|---|
| A | `sum by (study, form) (survey_active_users{form!="$fallback"})` | active (1h) |
| B | `sum by (study, form) (survey_error_states{form!="$fallback"})` | errors |
| C | `sum by (study, form) (survey_error_states{form!="$fallback", error_tag=~"INTERNAL\|STATE_ACTIONS\|NETWORK"})` | platform errs |
| D | `survey:error_ratio:1h{form!="$fallback"}` | ratio |
| E | `survey:error_ratio_excess:1h{form!="$fallback"}` | **excess vs fleet** |
| F | `sum by (study, form) (survey_blocked_states{form!="$fallback", category!="attrition"})` | blocked (actionable) |
| G | `sum by (study, form) (survey_stuck_users{form!="$fallback"})` | stuck |
| H | `sum by (study, form) (survey_expired_waits{form!="$fallback"})` | expired |

All `format: table, instant: true`. Sort descending by *errors*. Cell thresholds on
**excess** (yellow ≥ 0.2, red ≥ 0.5) and on **ratio**, but *not* on raw counts — counts
without volume are meaningless at this traffic (validated: `banglahpv` shows ratio 1.0 on
1 error / 1 user).

Column E needs the recording rules in §4.6. Live-validated shape:

```promql
survey:error_ratio:1h{form!="305"} - on() group_left() survey:error_ratio:fleet:1h
→ {form="banglahpv"} 0.9615   {form="dreampay1"} 0.9615   {form="girleffectincentive"} 0.2949
```

> **Why "excess vs fleet" and not just "ratio".** A 40% error ratio means something
> completely different when the fleet is at 3.8% than when the fleet is at 35%. In the
> first case that study is broken. In the second case *everything* is broken and this
> study is unremarkable — go look at Live Traffic. This one column tells you which board
> you should be on.

### 4.2 CHANGE — split the error panel in two, and stop summing away `form`

**REMOVE** panel id 4 ("Error States by Tag (1h window, all forms)") in its current shape.
**ADD** two panels in its place:

**"Study-fault errors — by study & tag"** (stacked timeseries, left)
```promql
sum by (study, form, error_tag) (
  survey_error_states{form!="$fallback", form=~"$form", study=~"$study",
                      error_tag!~"INTERNAL|STATE_ACTIONS|NETWORK"}
)
```
`legendFormat: "{{study}} / {{form}} — {{error_tag}}"`. This is the within-survey panel:
`FORM_NOT_FOUND`, `FIELD_NOT_FOUND`, `INTERPOLATION_ERROR`, `none`. Excludes 305.
*Note the negated regex, not a positive list:* the taxonomy contract says platform tags
are an explicit **allow-list** and anything unrecognised is study-side — a new tag must
land here automatically, not vanish.

**"Platform-fault errors — by study & tag"** (stacked timeseries, right)
```promql
sum by (study, form, error_tag) (
  survey_error_states{error_tag=~"INTERNAL|STATE_ACTIONS|NETWORK"}
)
```
**Deliberately not filtered** by `$form`, `$study` or `$fallback`: a platform fault is not
one study's business, and you must be able to see it while the board is scoped to a study.
Once §6.2 lands this panel also shows `form="(none)"` — the 55% that is invisible today.
Red thresholds; annotate the panel description with the `PlatformInternalErrors` threshold
(≥5).

### 4.3 CHANGE — blocked, split benign from actionable, attributed to a study

**REMOVE** panel id 3 in its current shape (attrition stacked in, `form` summed away).

**ADD "Actionable blocks — by study & category"** (stacked timeseries, ~⅔ width)
```promql
sum by (study, form, category) (
  survey_blocked_states{category!="attrition", form=~"$form", study=~"$study"}
)
```
`legendFormat: "{{study}} — {{category}}"`. Colour: `rate_limit` red, `template_missing`
orange, `fb_internal` red (see §6.3), `unsupported`/`other` yellow. Right now this panel
would immediately show **Bauchi HPV MNCH Week / template_missing = 26** — a live,
ticketable, currently-invisible problem.

**ADD "Attrition (benign baseline)"** (small timeseries, ~⅓ width, grey)
```promql
sum(survey_blocked_states{category="attrition"})
```
Keep it on the board — it is the churn baseline and a *collapse* in it is also
informative — but off the actionable stack so it stops squashing everything else.

### 4.4 CHANGE — the panels that are basically fine

- **Error Ratio per Form** (id 1): add `form!="$fallback"` so 305's permanent 1.0 stops
  pinning a red line at the top of the chart. Change `legendFormat` to
  `"{{study}} / {{form}}"`.
- **Active Users per Form** (id 2): `sum by (study, form)`, same legend change.
- **Stuck Users** (id 5) and **Expired Waits** (id 6): keep, add `study` to the legend.
  Add a small **stat** next to Expired Waits showing `sum(survey_expired_waits)` with a
  red threshold at 10 — because `DeanExpiredWaits` alerts on the *sum*, and the per-form
  panel never shows the number the alert actually reads.

### 4.5 ADD — "Fallback arrivals (form 305)", collapsed row at the bottom

```promql
sum by (page_name) (survey_error_states{form="$fallback", error_tag="FORM_NOT_FOUND"})
```
(`page_name` requires §6.2 to also carry page on the error metric — if that is dropped for
cost, use `sum(...)`.)

**Do not simply exclude 305 everywhere.** 333 users in 24h reached the fallback: those are
real people who messaged a page with no valid study assignment. That is a business signal
(a broken ad link, a study that ended without its ads being pulled), and today it is
classified as "known-benign noise" and therefore watched by nobody. Give it one collapsed
panel with its own baseline, and exclude it from every *other* panel.

### 4.6 ADD — recording rules (additive, no alert depends on them)

In `devops/alerts/templates/study-health.yaml`, group `vlab-study-health-recordings`:

```yaml
# Fleet-wide error ratio — what "normal" is right now. The denominator excludes
# the fallback form (permanent 100% error by design) so it cannot drag the
# baseline up and hide a real study regression.
- record: survey:error_ratio:fleet:1h
  expr: |
    sum(survey_error_states{form!="305", form!="(none)"})
    /
    clamp_min(sum(survey_active_users{form!="305", form!="(none)"}), 1)

# How far above normal one study is. Near zero during a platform-wide event
# (everyone rises together) — that asymmetry is the point.
- record: survey:error_ratio_excess:1h
  expr: |
    survey:error_ratio:1h{form!="305", form!="(none)"}
    - on() group_left()
    survey:error_ratio:fleet:1h

# Breadth. `> 0` is mandatory: these gauges emit zero-valued series (see §1.1).
- record: survey:erroring_studies:platform:1h
  expr: |
    count(count by (study) (survey_error_states{error_tag=~"INTERNAL|STATE_ACTIONS|NETWORK"} > 0))
    or vector(0)

- record: survey:erroring_studies:study_side:1h
  expr: |
    count(count by (study) (survey_error_states{error_tag!~"INTERNAL|STATE_ACTIONS|NETWORK", form!="305"} > 0))
    or vector(0)
```

Live-validated (form-level variants, before the `study` label lands):
`survey:error_ratio:fleet:1h` → **0.0385**;
`count(count by (form)(survey_error_states{error_tag=~"INTERNAL|…"} > 0)) or vector(0)` → **3**.

`or vector(0)` matters: without it the series disappears entirely when nothing is erroring,
and a Grafana stat panel renders "No data" instead of a reassuring `0`.

### 4.7 Study Health, after

```
┌───────────────────────────────────────────────────────────────────────────┐
│ STUDY TRIAGE  study│form│active│errors│ratio│EXCESS│platform│blocked│stuck│exp │
├──────────────────────────────────┬────────────────────────────────────────┤
│ Study-fault errors by study&tag  │ Platform-fault errors by study&tag  ●  │
├──────────────────────────────────┼────────────────────────────────────────┤
│ Error ratio per form (excl. 305) │ Active users per study/form            │
├───────────────────────────┬──────┴────────────┬────────────────────────────┤
│ Actionable blocks by study│ Attrition (grey)  │ Stuck users │ Expired+stat │
├───────────────────────────┴───────────────────┴─────────────┴──────────────┤
│ ▸ Fallback arrivals (form 305) — collapsed                                 │
└────────────────────────────────────────────────────────────────────────────┘
                                                    ● = never filtered by $study
```

---

## 5. Live Traffic — proposed changes

**Job:** *breadth, right now.* How many studies, how many pages, which reason.

### 5.1 FIX — the two broken stat panels (highest value, zero risk)

```promql
# Active Studies (id 2)  — was: count(count by (study) (survey_recent_states{...}))
count(sum by (study) (survey_recent_states{window="$window", study=~"$study", page_name=~"$page_name"}) > 0) or vector(0)

# Active Pages   (id 3)  — was: count(count by (page)  (survey_recent_states{...}))
count(sum by (page)  (survey_recent_states{window="$window", study=~"$study", page_name=~"$page_name"}) > 0) or vector(0)
```

Reads 29 → **3** and 7 → **4**. Pure JSON change, no exporter or alert involvement.

### 5.2 ADD — the breadth stat row (the cross-survey headline)

Two new stats beside the existing four (shrink the row to 6 × 4-wide, or make it two rows
of four):

**"Studies Erroring"**
```promql
count(
  sum by (study) (
    survey_recent_states{window="$window", state="ERROR", study!="fallback (no study)"}
  ) > 0
) or vector(0)
```
Thresholds: green `null`, yellow `2`, **red `3`** — deliberately mirroring
`MultiSurveyErrorRegression`'s `≥3` so the board and the pager tell the same story.

**"Pages Erroring"**
```promql
count(
  sum by (page_name) (
    survey_recent_states{window="$window", state="ERROR", study!="fallback (no study)"}
  ) > 0
) or vector(0)
```

Read them together — that pair *is* the discriminator, in two numbers:

| Studies | Pages | Read as |
|---|---|---|
| 1 | 1 | within-survey → Study Health |
| ≥3 | 1 | **messaging channel** — that page's token / rate limit / Meta app |
| ≥3 | ≥2 | **platform regression** — deploys, CockroachDB, Redis, Kafka |

### 5.3 ADD — "Studies affected, per error reason" (bar gauge, the money panel)

Requires the `reason` label (§6.1).

```promql
count by (reason) (
  count by (reason, study) (
    survey_recent_states{window="$window", state="ERROR", reason!="",
                         study!="fallback (no study)"} > 0
  )
)
```

One bar per error reason; bar length = **how many distinct studies carry it**.
`legendFormat: "{{reason}}"`, thresholds green/yellow at 2/red at 3.

This is the whole §2.2 matrix in one picture. `FIELD_NOT_FOUND` at 1 → one study edited
its form. `INTERNAL` at 8 → platform. `FORM_NOT_FOUND` at 12 → **not** twelve
misconfigured studies, it is formcentral. Nothing else on either board can say that.

### 5.4 ADD — "Errors by reason" (stacked timeseries)

```promql
sum by (reason) (
  survey_recent_states{window="$window", state="ERROR", study=~"$study",
                       page_name=~"$page_name", study!="fallback (no study)"}
)
```
Same colour contract as Study Health: platform tags red, study tags orange, `none` yellow.
Gives the 5m board the *why* it currently lacks (§1.7) without a round trip.

### 5.5 ADD — "Error rate by page" (timeseries, percentunit)

```promql
sum by (page_name) (survey_recent_states{window="$window", state="ERROR", study!="fallback (no study)"})
/
clamp_min(sum by (page_name) (survey_recent_states{window="$window", study!="fallback (no study)"}), 1)
```

Validated live (unfiltered, 24h): TM Project **0.278**, Listening Project 1.0, Virtual Lab
0.167, Global Health Hub 0.057, Our World In Surveys 0.010. Rate not count, so a busy page
does not automatically look worst. This is the panel that catches "one FB page is failing".

### 5.6 ADD — "Blocked by reason & page" (stacked timeseries)

```promql
sum by (page_name, reason) (
  survey_recent_states{window="$window", state="BLOCKED", reason!~"|attrition"}
)
```
(`reason!~"|attrition"` excludes both the empty string and attrition in one matcher.)
Live Traffic has no blocked view at all today. With `reason`, `rate_limit` and
`fb_internal` become visible **per page**, which is exactly where they are caused.

### 5.7 CHANGE — stop the fallback form dominating

- **"ERROR States by Study & Form"** (id 8): add `study!="fallback (no study)"`. Today
  this panel is 331 users of fallback vs 13 of everything real.
- **Breakdown table** (id 10): add `reason` to the `sum by (…)` and to the columns.
- **"In ERROR Now"** (id 4): keep, but exclude the fallback so the colour thresholds mean
  something. Its description already says the thresholds are a reading aid, not an alert —
  keep that caveat.
- **`$study` variable**: `label_values(survey_recent_states{window="24h"}, study)` — note
  `window="24h"` not `"5m"`; with the zero-series behaviour the 5m variant is already
  returning the 24h set anyway, so make it honest.

### 5.8 REMOVE

- **"Users by Form"** (id 9) — `sum by (study, form)` of everything. It duplicates "Users
  by Study" plus the breakdown table, and it is the panel with the most series and the
  least information. Reclaim its slot for "Error rate by page" (§5.5).

### 5.9 Live Traffic, after

```
┌──────────┬──────────┬──────────┬──────────┬──────────────┬──────────────┐
│ Chatting │ Active   │ Active   │ In ERROR │ STUDIES      │ PAGES        │
│ Now      │ Studies✓ │ Pages ✓  │ Now      │ ERRORING  ★  │ ERRORING  ★  │
├──────────┴──────────┴──────────┴──────────┴──────────────┴──────────────┤
│ Users by State ($window) — the traffic curve                             │
├────────────────────────────────────┬─────────────────────────────────────┤
│ ★ Studies affected per error reason│ Errors by reason ($window)          │
├────────────────────────────────────┼─────────────────────────────────────┤
│ Error rate by page ($window)       │ Blocked by reason & page            │
├────────────────────────────────────┼─────────────────────────────────────┤
│ Users by Study                     │ ERROR by study & form (excl. fallbk)│
├────────────────────────────────────┴─────────────────────────────────────┤
│ Breakdown table (study × form × page × state × reason)                   │
└──────────────────────────────────────────────────────────────────────────┘
                        ✓ = bug fix    ★ = new discriminator
```

---

## 6. Exporter changes (`devops/sql-exporter/templates/configmap.yaml`)

Add to `values.yaml` so the fallback form is not a literal in SQL, mirroring
`devops/alerts/values.yaml`'s `studyHealth.fallbackForm`:

```yaml
database:
  fallbackForm: "305"     # replybot's FALLBACK_FORM env var; keep in sync
```

### 6.1 `survey_recent_states` — add `reason`, fix NULL form, relabel the fallback

```yaml
key_labels: [state, form, study, page, page_name, reason]
```

```sql
WITH agg AS (
  SELECT
    current_state AS state,
    COALESCE(current_form, '(none)') AS form,
    pageid AS page,
    CASE
      WHEN current_state = 'ERROR'   THEN COALESCE(error_tag, 'none')
      WHEN current_state = 'BLOCKED' THEN CASE
        WHEN fb_error_code IN ('10', '190', '551') THEN 'attrition'
        WHEN fb_error_code = '100'  THEN 'template_missing'
        WHEN fb_error_code = '2022' THEN 'rate_limit'
        WHEN fb_error_code = '200'  THEN 'unsupported'
        WHEN fb_error_code = '-1'   THEN 'fb_internal'
        ELSE 'other'
      END
      ELSE ''
    END AS reason,
    COUNT(*) FILTER (WHERE updated > NOW() - INTERVAL '5 minutes') AS c5m,
    COUNT(*) FILTER (WHERE updated > NOW() - INTERVAL '1 hour')    AS c1h,
    COUNT(*)                                                       AS c24h
  FROM states
  WHERE current_state = ANY(ARRAY['START','RESPONDING','QOUT','END','BLOCKED',
                                  'ERROR','WAIT_EXTERNAL_EVENT','USER_BLOCKED','RESET','OFF'])
    AND updated > NOW() - INTERVAL '24 hours'
  GROUP BY 1, 2, 3, 4
)
SELECT
  a.state, a.form,
  CASE WHEN a.form = '{{ .Values.database.fallbackForm }}'
       THEN 'fallback (no study)'
       ELSE COALESCE(sv.survey_name, 'unknown') END AS study,
  a.page,
  COALESCE(cr.details->>'name', a.page) AS page_name,
  a.reason,
  a.c5m AS "5m", a.c1h AS "1h", a.c24h AS "24h"
FROM agg a
LEFT JOIN LATERAL (
  SELECT survey_name FROM surveys WHERE shortcode = a.form ORDER BY created DESC LIMIT 1
) sv ON true
LEFT JOIN credentials cr ON cr.facebook_page_id = a.page;
```

Three changes, each justified above: `AND current_form IS NOT NULL` → `COALESCE(…,
'(none)')` (§1.4); the `reason` CASE (§3.1); the fallback relabel (§1.6).
**Measured:** 129 groups → ~387 series; 288–561ms; index spans preserved.

### 6.2 `study_health` metrics — add `study`, stop dropping NULL forms

Same treatment for all five. `survey_error_states` shown; the others are mechanical:

```yaml
key_labels: [form, study, error_tag]
```

```sql
WITH agg AS (
  SELECT COALESCE(current_form, '(none)') AS form,
         COALESCE(error_tag, 'none')      AS error_tag,
         COUNT(*)                          AS value
  FROM states
  WHERE current_state = 'ERROR'
    AND updated > NOW() - INTERVAL '1 hour'
  GROUP BY 1, 2
)
SELECT a.form, a.error_tag,
  CASE WHEN a.form = '{{ .Values.database.fallbackForm }}'
       THEN 'fallback (no study)'
       ELSE COALESCE(sv.survey_name, 'unknown') END AS study,
  a.value
FROM agg a
LEFT JOIN LATERAL (
  SELECT survey_name FROM surveys WHERE shortcode = a.form ORDER BY created DESC LIMIT 1
) sv ON true;
```

**Measured:** 62–144ms / 7 MiB (was 12–29ms / 24 KiB). `survey_active_users` equivalent:
87–123ms / 16 MiB. Series count unchanged (`study` is functionally dependent on `form`).

> `survey_expired_waits` keeps `AND timeout_date < NOW()`; its `current_state =
> 'WAIT_EXTERNAL_EVENT'` already pins the index. `survey_stuck_users` filters on
> `stuck_on_question IS NOT NULL` with **no** `current_state` pin — it therefore
> **full-scans today**. Not part of this design's scope, but flagging it: it should get
> `current_state = ANY(ARRAY[...])` added, exactly as `survey_active_users` did in the
> 2026-07-25 fix. **Uncertain** — I did not EXPLAIN it; measurement that resolves it is one
> `EXPLAIN ANALYZE` of that query looking for `spans: FULL SCAN`.

### 6.3 Blocked bucketing — split `fb_internal` out of `other`

Add `WHEN fb_error_code = '-1' THEN 'fb_internal'` to `survey_blocked_states` (and to the
`reason` CASE in §6.1). 36 users in 24h, message `(#-1) Unexpected internal error`, all in
one study on one page. Today they are indistinguishable from long-tail noise; they are
Meta-side failures and behave like a platform signal.

---

## 7. Risks and blast radius

Ordered most to least dangerous.

### R1 — Dropping `current_form IS NOT NULL` changes what alerts see (**highest**)

A new `form="(none)"` series appears on `survey_error_states`, `survey_active_users` and
`survey_recent_states`.

| Alert | Expression shape | Effect |
|---|---|---|
| `PlatformInternalErrors` | `sum(survey_error_states{error_tag=~"…"})` | **Becomes more sensitive.** Today reads 3; would read 4 right now, and up to +6 on a bad day. This is the *intended fix* (§1.4) — but it is a live behaviour change against a `>=5` critical/paging threshold. |
| `SurveyErrorSpike` | `survey:error_ratio:1h{form!="305"} > 0.5` and volume gates | **Can now fire on `form="(none)"`.** Those rows are overwhelmingly ERROR, so the ratio is near 1.0. **Mitigation is mandatory**: add `form!="(none)"` to this rule, to `MultiSurveyErrorRegression`, and to the `survey:error_ratio:1h` recording rule. |
| `MultiSurveyErrorRegression` | `count(...) >= 3` | Same — `(none)` would count as a "survey". Same mitigation. |
| `SurveyStuckUsersSpike` | `survey_stuck_users >= 10` (bare vector) | No effect (stuck rows always have a form), but see R2. |

**Ship the alert-rule guards in the same commit as the exporter change**, or in a commit
that lands first. Cleanest sequencing: add `form!="(none)"` guards to the alert rules while
the metric cannot yet produce that label (a no-op), *then* change the exporter.

**Alternative if the sensitivity change is unwelcome:** emit the NULL-form errors under a
*separate* metric name (`survey_unformed_error_states{error_tag}`) so nothing existing
changes and the board gains a panel. Lower risk, more surface area, and it leaves
`PlatformInternalErrors` still blind — I do not recommend it, but it is the safe fallback
if the page threshold cannot be touched right now.

### R2 — Adding `study` changes alert *identity*, not alert *values*

`SurveyStuckUsersSpike` uses a bare vector, so its alert instances inherit every label on
the series — including the new `study`. Any instance firing across the deploy will
**resolve and re-fire** with a new fingerprint (one duplicate Slack/ntfy notification,
one spurious "resolved"). Values are unchanged because `study` is functionally dependent
on `form`. Deploy during a quiet period, or accept one duplicate notification. Every other
study-health alert aggregates with `sum`/`sum by (form)`/`count`, so it is unaffected.

**Upside:** once `study` is on the metric, alert annotations can carry the study name —
closing a "Future Enhancements" item that has been open in
`documentation/study-error-alerting.md` §6 since the rules were written.

### R3 — DB read amplification

Each `study` join costs 7–16 MiB and 60–140ms per scrape; five of them ≈ 50 MiB, 400ms/min.
The `study_traffic` query already reads **300 MiB per scrape** from a `surveys` full scan
(§3.3). Adding joins without the covering index roughly doubles a cost that is already the
largest thing the exporter does. **Recommendation: land the covering index + `ANALYZE`
first, or add `study` only to `survey_error_states`, `survey_blocked_states` and
`survey_active_users` (the three the triage table needs) and leave `survey_stuck_users` /
`survey_expired_waits` on `form` alone.**

### R4 — Cardinality

Measured, not modelled: `survey_recent_states` 372 → ~387 series (+4%). `study_health`
metrics unchanged in count. `fb_internal` adds at most one series per (form) already
emitting `other`. Negligible. The one thing that would *not* be negligible is putting
`page` on the 1h metrics (a form can appear on several pages — the fallback appears on
three) — **do not do it**; the page axis belongs on Live Traffic, which already has it.

### R5 — The fallback relabel changes a label *value*

`study="MENtality"` → `study="fallback (no study)"` for form 305. Grafana `$study`
variable options change; any saved dashboard link or ad-hoc query pinning
`study="MENtality"` silently changes meaning. Low impact (the old value was wrong), but it
is a *semantic* change to existing data, so Prometheus history before and after will not
line up on that label. Note it in the changelog.

### R6 — Panel expressions that forget the guards

Two guards are now load-bearing on every new panel and must be documented in
`devops/grafana-dashboards/README.md` next to the existing `window` warning:

1. **Always pin `window`** (existing rule).
2. **Always `> 0` before counting series** — otherwise you count the 24h scan's groups,
   not the window's entities. This is what broke Active Studies and Active Pages.

### R7 — What this design deliberately does *not* do

No user ids reach Prometheus. No per-question / per-field breakdown reaches Prometheus
(field refs are unbounded cardinality *and* arguably study-private). Both belong in the
dashboard-client Monitor tab, which is where §8 hands off.

---

## 8. Drill-path walkthroughs

### Scenario A — one study's form edit broke a jump target

*Symptom:* `FIELD_NOT_FOUND` climbing.

1. **Live Traffic**, `$window=5m`. "Studies Erroring" = **1**, "Pages Erroring" = **1**.
   → narrow. Not a platform event.
2. **"Studies affected per error reason"**: `FIELD_NOT_FOUND` bar = **1**. Confirms:
   one study, study-side tag → §2.2 top-left→bottom-left = **study misconfig**.
3. **"ERROR States by Study & Form"** names the study and the shortcode.
4. Click the **Study Health** dashboard link (already in `links[]`), select that `$study`.
5. **Study triage table**: that row shows errors, ratio, and **excess vs fleet** ≫ 0 while
   every other study sits near 0 → confirms the fleet is fine and this study is not.
6. **"Study-fault errors by study & tag"** confirms `FIELD_NOT_FOUND`, and its rise time
   is the edit time. Cross-reference the study's `surveys.created` for a version bump.
7. **Hand off to dashboard-client Monitor tab** (`SurveyScreen` → Monitor →
   `/surveys/:surveyName/states/list`): filter `state=ERROR`, `error_tag=FIELD_NOT_FOUND`.
   Open a `StateDetail` → `state_json.error` gives the missing field ref, `state_json.qa`
   shows where the respondent was sitting.
8. **Or in SQL** (`documentation/study-error-alerting.md#surveyerrorspike`):
   ```sql
   SELECT userid, current_form, error_tag, state_json->'error'->>'message', updated
   FROM states
   WHERE current_state = 'ERROR' AND error_tag = 'FIELD_NOT_FOUND'
     AND current_form = '<shortcode>'
     AND updated > NOW() - INTERVAL '1 hour'
   ORDER BY updated DESC LIMIT 20;
   ```
9. **Outcome:** ticket the study owner with the field ref. No page.

### Scenario B — Dean stalls, every study's waits expire

*Symptom:* users pile up in `WAIT_EXTERNAL_EVENT` past `timeout_date`.

1. **Live Traffic**, `$window=5m`. **"Users by State"**: the `WAIT_EXTERNAL_EVENT` band
   grows while the total is flat — the shape the panel description promises. `ERROR` is
   *not* rising, so the error panels stay quiet. **This is the case that error breadth
   cannot catch**, which is why the state-band panel stays on the board.
2. **"Studies Erroring"** = 0–1. Errors are the wrong lens; states are the right one.
3. **Study Health** → **"Expired Waits per Form"** rising across *many* forms, and the new
   **total stat** crosses the red 10 line (the number `DeanExpiredWaits` actually reads).
4. Breadth check: expired waits across ≥3 unrelated studies with no shared page → platform.
5. Runbook `documentation/study-error-alerting.md#deanexpiredwaits`:
   `kubectl -n default get pods -l app=dean`; `kubectl -n default logs -l app=dean --tail=100`.
6. Cross-check the **Kafka Consumer Health** board — Dean behind = consumer lag. The
   `ALERTS{alertstate="firing"}` annotation already overlays firing alerts on Live Traffic's
   time axis, so a `KafkaConsumerStuck` firing shows as a red marker at the moment the
   `WAIT_EXTERNAL_EVENT` band starts climbing. That correlation is the diagnosis.
7. **Outcome:** platform. Restart Dean; expect the band to drain.

### Scenario C — one FB page gets rate-limited

*Symptom:* `fb_error_code = 2022`, `BLOCKED` climbing.

1. **Live Traffic**, `$window=5m`. **"Studies Erroring" = 4, "Pages Erroring" = 1.**
   → §5.2 row 2: **messaging channel, not code.** Diagnosis in two numbers, five seconds.
2. **"Blocked by reason & page"** (§5.6): `rate_limit` stacked entirely on one `page_name`.
3. **"Error rate by page"** (§5.5): that page's rate is an outlier; every other page normal.
4. **"Studies affected per error reason"**: `rate_limit` bar = 4 — broad across studies.
   Broad-across-studies + narrow-on-one-page is the channel signature, and it is *not*
   something the study-vs-platform tag axis could ever have told you.
5. **Study Health** → **"Actionable blocks by study & category"** shows which studies are
   collateral damage — those are the owners to notify.
6. Runbook `documentation/study-error-alerting.md#platformratelimited`; SQL:
   ```sql
   SELECT pageid, current_form, COUNT(*)
   FROM states
   WHERE current_state = 'BLOCKED' AND fb_error_code = '2022'
     AND updated > NOW() - INTERVAL '1 hour'
   GROUP BY 1, 2 ORDER BY 3 DESC;
   ```
7. **Outcome:** platform/critical. Meta Business Manager API usage; consider pausing the
   study driving volume on that page.

### Scenario D — the one happening right now (worked example)

`study="unknown"`, 13 `FORM_NOT_FOUND` on the *TM Project* page, shortcodes `slcNrF05`,
`slcNrF06`, `slcNrF08`, `slcNrF09`, `slcNrF010` — **none of which exist in `surveys`**.

Today: invisible. It is 4% of the height of the fallback form's bar on the one panel that
would show it, and Study Health sums `form` away entirely.

After: "Studies affected per `FORM_NOT_FOUND`" = 1 (`unknown`), narrow, study-side tag →
study misconfig. The Study Health triage table shows `study=unknown` with a 100% ratio and
a large excess. Someone is generating referral links for shortcodes that were never
created — a broken ad or a deleted study whose ads are still live.

---

## 9. Recommended phasing — visibility per unit of risk

| Phase | Change | Files | Risk | Visibility won |
|---|---|---|---|---|
| **0** | Fix the two broken stat panels: `count(sum by (…)(…) > 0)` | `live-traffic.json` | **none** — pure PromQL, no alert reads it | **Highest.** The board's only cross-survey numbers stop lying (29→3, 7→4) |
| **1** | Study Health panel surgery: split platform/study error panels, exclude 305 from ratio panel, split attrition out of the blocked stack, add the expired-waits total stat | `study-health.json` | **none** — dashboard JSON only | High. Form 305 stops drowning the error panel; the platform sliver becomes the panel |
| **2** | Recording rules: fleet baseline, excess, breadth (form-level) | `devops/alerts/templates/study-health.yaml` (recordings group only) | **very low** — additive records, no alert reads them | Medium. Enables the triage table's "excess" column and breadth stats |
| **3** | `reason` label + fallback relabel + NULL-form fix on `survey_recent_states`; new Live Traffic panels (§5.2–5.6), remove "Users by Form" | `sql-exporter` configmap + `values.yaml`, `live-traffic.json` | **low** — no alert rule reads `survey_recent_states`; measured cost-neutral, +4% series | **Highest after phase 0.** The discriminator becomes a picture: reason × studies × pages |
| **4** | Alert-rule guards `form!="(none)"` on `SurveyErrorSpike`, `MultiSurveyErrorRegression`, `survey:error_ratio:1h` — landed **before** phase 5, as a no-op | `study-health.yaml` | **none** while the label cannot exist | Prep only |
| **5** | `study` label + NULL-form fix on the `study_health` metrics; `fb_internal` category; `$study` variable and the triage table on Study Health | `sql-exporter` configmap, `study-health.json` | **medium** — R1 (`PlatformInternalErrors` gets more sensitive, by design), R2 (one alert-identity churn) | High. Attribution: every error and block is named with its study |
| **6** | `surveys (shortcode, created DESC) STORING (survey_name)` + `ANALYZE surveys` + `ANALYZE states`; pin `current_state` in `survey_stuck_users` | migration, `sql-exporter` configmap | **low**, but it is a prod schema change | None visible; removes a 300 MiB/scrape full scan and pays for phase 5 |

**Do phases 0 and 1 today.** They are dashboard JSON, take an hour, need no `helm upgrade`
beyond `grafana-dashboards`, and between them they fix the two most misleading things on
either board. Phase 3 is the design's centrepiece and is genuinely low-risk because
nothing alerts on `survey_recent_states`. Phase 5 is the one that needs care, and phase 4
exists purely to de-risk it.

If only **one** thing gets done: **phase 0**, then §5.2's two breadth stats using the
existing labels —

```promql
count(sum by (study)(survey_recent_states{window="$window", state="ERROR"}) > 0) or vector(0)
count(sum by (page_name)(survey_recent_states{window="$window", state="ERROR"}) > 0) or vector(0)
```

They need no exporter change at all (only the fallback still pollutes `study`, and you can
work around that with `study!="MENtality"` until phase 3), and they answer the user's
actual question — *is this one study or everything?* — in two numbers.

---

## 10. Open questions / what would resolve them

1. **Does the covering index actually kill the 300 MiB scan?** Not measured — creating a
   prod index is out of scope here. *Resolve:* create it on staging with prod-shaped
   `surveys`, re-run the traffic query, compare `KV bytes read`.
2. **Does `survey_stuck_users` full-scan?** Its query has no `current_state` pin, which is
   the exact pattern the INDEX DISCIPLINE block warns about. *Resolve:* one `EXPLAIN
   ANALYZE`, look for `spans: FULL SCAN`.
3. **Is `>= 3 studies` the right red threshold for "Studies Erroring"?** Inherited from
   `MultiSurveyErrorRegression`, which the docs themselves say was calibrated against
   traffic **20× lower** than today's. *Resolve:* once phase 3 ships, read
   `survey:erroring_studies:*` over two weeks and set the threshold at p95 of normal.
4. **Should `form="(none)"` errors page?** They are 55% of platform-fault errors, so
   arguably yes — but they will move `PlatformInternalErrors` closer to its threshold
   without any real change in platform health. *Resolve:* ship phase 5, watch the metric
   for a week, then re-calibrate the threshold in `devops/alerts/values.yaml`. Do not
   re-calibrate speculatively.
5. **Is `fb_error_code = -1` retryable?** 36 users in 24h, one study, one page, message
   `(#-1) Unexpected internal error`. Splitting it out makes it visible; whether it wants
   an alert or a Dean retry policy is a separate question this design does not answer.

---

## 11. Documentation to update when this is implemented

Per the repo's documentation-first protocol, the implementing change must also update:

- **`documentation/study-error-alerting.md`** — metrics catalog (new `study` / `reason`
  labels, `fb_internal` category), the new recording rules, the `> 0` breadth rule, and
  the NULL-`current_form` blind spot (§1.4) which the doc currently does not mention.
- **`devops/grafana-dashboards/README.md`** — the two mandatory PromQL guards (pin
  `window`; `> 0` before counting series), and the revised panel lists for both boards.
- **`documentation/alerting.md`** §4 — any threshold or expression change to the
  study-health alerts.
