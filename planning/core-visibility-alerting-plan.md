# Core visibility & alerting — execution plan

**For a future agent.** This is the *substrate* work: what we export and what we alert
on. It deliberately stops short of dashboard panel work.

**Status as of 2026-07-26: W1, W2, W3, W4 and W6 are DONE, deployed and verified live.**
The dashboard panels that consume them are also built (design doc §4–5). Remaining: **W5
only** (threshold recalibration), deliberately deferred ~1 week because W2b changed what
the metrics see.

| Item | State |
|---|---|
| W1 un-bucket + `provider_error` + `provider_unreachable` + `page` + `study` | ✅ deployed |
| W2a alert guards (no-op) | ✅ deployed, verified inert (3→3, 0→0, 4→4) |
| W2b NULL-form fix | ✅ deployed — `form="(none)"` now counted by `PlatformInternalErrors` |
| W3 `ProviderErrors` alert (critical, `by (page)`) | ✅ deployed + runbook written |
| W4 state-dependent `reason` on `survey_recent_states` | ✅ deployed |
| W5 threshold recalibration | ⏳ **outstanding** — needs ≥1 week of post-W2b data |
| W6 `surveys` covering index (migration 22) | ✅ applied — 300 MiB → **452 KiB** per scrape |

Also done beyond the original plan: 4 recording rules (fleet ratio, per-study excess,
platform/study-side breadth), form 305 relabelled `study="fallback (no study)"`, and both
Grafana boards rebuilt to display all of it.

The NULL `fb_error_code` question is **answered** — see
[`null-fb-error-code-findings.md`](./null-fb-error-code-findings.md). It was never a
Facebook error; it is `message-worker` failing to find a page token. **131 participants
remain permanently blocked** and are structurally unrecoverable by dean. The taxonomy now
names the class (`provider_unreachable`) but the real fix is two lines in `message-worker`
— that work is NOT done and is not in this plan's scope.

All findings below were measured on prod `2026-07-26` and each carries a command to
re-verify — **re-verify before acting**, the numbers move.

---

## 0. Scope

**In scope (core):**
- `devops/sql-exporter/templates/configmap.yaml` — what reasons we export at all
- `devops/alerts/templates/study-health.yaml` + `devops/alerts/values.yaml` — what fires
- `documentation/study-error-alerting.md` — the taxonomy contract

**Out of scope — do NOT do these here:**
- **Dashboard panels.** Fully designed in
  [`error-visibility-design.md`](./error-visibility-design.md) §4–5. Do that work *after*
  this plan lands; several of its panels depend on labels created here.
- **The live `fb_error_code = -1` incident.** 36 users blocked by Meta internal errors on
  Kenya Girl Effect / Our World In Surveys, accelerating. Tracked separately; this plan
  makes it *visible*, it does not investigate it.
- Anything in `cockroachdb-cost-reduction-plan.md`.

**Design authority:** [`error-visibility-design.md`](./error-visibility-design.md) — 1,065
lines, covers the within-survey vs cross-survey discriminator, panel designs, drill paths.
**Read it first.** This plan does not restate it; it sequences the core subset and
supersedes it in two places, flagged **[SUPERSEDES]** below.

---

## 1. Required reading, in order

1. `documentation/study-error-alerting.md` — the taxonomy contract and the INDEX
   DISCIPLINE rule. Non-negotiable.
2. `planning/error-visibility-design.md` — the design. Especially §2 (discriminator),
   §6 (exporter changes), §7 (risks).
3. `devops/sql-exporter/templates/configmap.yaml` — read the INDEX DISCIPLINE comment
   block at the top before writing any SQL.
4. `devops/alerts/templates/study-health.yaml` — the seven live rules.

**Hard constraint, repeated because it is the easiest thing to break:** `chatroach.states`
has no index leading with `updated`. Every query must pin
`current_state = ANY(<all 10 machine states>)` or it FULL SCANs 1.07M rows. `EXPLAIN` every
query you touch and confirm no `FULL SCAN` on `states`.

---

## 2. The five core defects

### D1 — Block reasons are destroyed at the exporter, for no benefit

`survey_blocked_states` runs `fb_error_code` through a `CASE` that collapses it to 5
categories. The raw code never reaches Prometheus. `other` is a garbage bucket.

**The measurement that settles it — there are only 7 distinct codes in 30 days:**

| code | n | forms |
|---|---:|---:|
| 10 | 1783 | 24 |
| 551 | 497 | 21 |
| 100 | 339 | 20 |
| (null) | 131 | 21 |
| **-1** | **119** | **2** |
| 190 | 40 | 18 |
| 200 | 1 | 1 |

The bucketing collapses 7 values into 5 to control cardinality that does not exist. `-1`
is the **5th most common block reason** and it dies in `other`.

```bash
psql "postgres://chatroach@localhost:26257/chatroach?sslmode=disable" -c "
SELECT COALESCE(fb_error_code,'(null)') code, COUNT(*) n, COUNT(DISTINCT current_form) forms
FROM chatroach.states WHERE current_state='BLOCKED'
  AND updated > NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY n DESC;"
```

### D2 — 55% of platform-fault errors are invisible, including to the paging alert

Every `study_health` query ends `AND current_form IS NOT NULL`. Over 30 days, **37 of 67**
`INTERNAL|STATE_ACTIONS|NETWORK` errors had a NULL `current_form`. `PlatformInternalErrors`
is `severity: critical` and pages.

```bash
psql "postgres://chatroach@localhost:26257/chatroach?sslmode=disable" -c "
SELECT COUNT(*) FILTER (WHERE current_form IS NULL) null_form,
       COUNT(*) FILTER (WHERE current_form IS NOT NULL) has_form, COUNT(*) total
FROM chatroach.states WHERE current_state='ERROR'
  AND error_tag IN ('INTERNAL','STATE_ACTIONS','NETWORK')
  AND updated > NOW() - INTERVAL '30 days';"
```

### D3 — The taxonomy has no class for "the channel is failing us"

Categories are attrition / template_missing / rate_limit / unsupported / other. A Meta
Graph API internal error (`(#-1) Unexpected internal error`) is none of those: not normal
churn, not study misconfiguration, not us being throttled. It is the *provider* failing.

This is the third axis the design doc's discriminator needs — **whose fault: study / us /
the channel** — and it currently has nowhere to live.

### D4 — Nothing alerts on `other`, so D1 + D3 compound into silence

`PlatformRateLimited` fires on `category="rate_limit"`; `SurveyTemplateMissing` on
`category="template_missing"`. **No rule references `other`.** 36 users blocked in 24h by a
provider error produced no alert of any kind, by design.

### D5 — `error_tag` is sticky, so the naive `reason` label would lie

`error_tag` persists on rows whose `current_state` has moved on. Measured over 24h:

| current_state | error_tag | n |
|---|---|---:|
| ERROR | FORM_NOT_FOUND | 346 |
| **BLOCKED** | **FB** | **181** |
| **END** | **INTERNAL** | **19** |
| ERROR | INTERNAL | 18 |
| **QOUT** | **INTERNAL** | **3** |

Attaching raw `error_tag` to `survey_recent_states` would label 19 *completed* users as
`INTERNAL`. The `reason` label **must** be state-dependent (see W4).

---

## 3. Work items

Each states: change, files, blast radius, verification, rollback. **Do them in the
sequence in §4** — W2 in particular has a mandatory prerequisite.

---

### W1 — Un-bucket the block reason, and give provider errors a home

**[SUPERSEDES]** design doc §6.3, which proposes splitting one `fb_internal` category out
of `other`. Given only 7 codes exist, carry the raw code instead — strictly more
informative for the same cost, and it does not need revisiting when code 8 appears.

**Change** (`devops/sql-exporter/templates/configmap.yaml`, `survey_blocked_states`):

1. **Add** a `code` key label carrying `COALESCE(fb_error_code, '(none)')`.
2. **Keep** `category` exactly as-is — the alert rules depend on it. Add one new arm:
   ```sql
   WHEN fb_error_code = '-1' THEN 'provider_error'
   ```
   placed *before* the `ELSE 'other'`.
3. **Add `page` and `study` labels** to `survey_blocked_states` — and to the other
   `study_health` metrics, per design doc §6.2, in this same change.
4. Update the `help` string and the comment block.

#### Why `page` is not optional

`page` is what separates a channel failure from a study failure, and without it the board
draws the wrong conclusion. When a provider breaks one page, the blocks land across
*several forms served by that page* — so a form-only view shows N unrelated small study
problems instead of one channel outage. This is the same within-survey vs cross-survey
discriminator the design doc builds for errors, applied to blocks.

Concretely: the 36 `-1` blocks that motivated this plan were diagnosable as provider-side
**only** because they were all on page `101435865704727`. `survey_blocked_states` cannot
express that today.

**Cost, measured over 30 days:** `form × category` = 94 series; `form × category × page` =
**99 series**, across 15 distinct pages. A form is nearly always served from exactly one
page, so `page` is close to functionally dependent on `form` and barely multiplies. There
is no cardinality argument against it.

`study` rides along in the same edit — same SQL, same deploy, same alert-safety review, so
splitting them would pay that review twice for no benefit.

**Blast radius of the added labels: none**, for the same reason as `code` — see the table
below; every rule aggregates with `sum` or `sum by (form)`.

**Blast radius: none.** Verified — every rule touching this metric aggregates the new
label away:

| Rule | Expression | Safe? |
|---|---|---|
| `PlatformRateLimited` | `sum(survey_blocked_states{category="rate_limit"})` | ✅ bare `sum` |
| `SurveyTemplateMissing` | `sum by (form) (survey_blocked_states{category="template_missing"})` | ✅ `sum by (form)` |

Moving `-1` out of `other` changes no rule, because **no rule reads `other`** (D4).

**Cardinality:** `form × category × code`. `code` is functionally dependent on `category`
except within `other`, so this adds ~2–3 series, not a multiple. Confirm after deploy.

**Verify:**
```bash
# raw codes now present, and -1 is no longer in `other`
curl -s localhost:9401/metrics | grep '^survey_blocked_states' | grep -c 'code='
curl -s localhost:9401/metrics | grep 'code="-1"'
# both blocked alerts still evaluate to the same numbers as before the change
curl -s --data-urlencode 'query=sum(survey_blocked_states{category="rate_limit"})' \
  localhost:9090/api/v1/query
```

**Rollback:** revert the configmap hunk, `helm upgrade sql-exporter`.

---

### W2 — Fix the NULL-form blind spot

**This is the highest-blast-radius item in the plan.** It makes a *paging* alert strictly
more sensitive, by design — that is the point, but it must be sequenced.

#### W2a — Land the guards first, as a no-op (separate commit)

Add `form!="(none)"` to every rule that is *per-form* and would otherwise start matching a
synthetic form label:

- `survey:error_ratio:1h` (recording rule)
- `SurveyErrorSpike`
- `MultiSurveyErrorRegression`
- `SurveyTemplateMissing`, `SurveyStuckUsersSpike` — audit and guard if per-form

Do **not** guard `PlatformInternalErrors` or `PlatformRateLimited` — those are bare `sum`
and *must* see NULL-form errors; that is the entire fix.

While no `(none)` label can exist, these guards match everything and change nothing.
**Confirm that:** compare each rule's value before and after; must be identical.

#### W2b — Then change the exporter (separate commit)

In each `study_health` query, replace `AND current_form IS NOT NULL` with
`COALESCE(current_form, '(none)') AS form` and drop the filter.

⚠️ **Do not drop the filter without W2a deployed and confirmed.**

⚠️ **Re-check the index plan.** Removing a predicate can change the plan. `EXPLAIN` each
modified query; confirm index spans, no `FULL SCAN`.

**Expected effect:** `PlatformInternalErrors` starts seeing ~55% more errors. Against the
current threshold this may fire immediately — **that is a true positive**, not a
regression. Do not raise the threshold to silence it; triage what it finds, then do W5.

**Verify:**
```bash
# the previously-invisible errors now appear under form="(none)"
curl -s --data-urlencode 'query=sum by (form) (survey_error_states{error_tag=~"INTERNAL|STATE_ACTIONS|NETWORK"})' \
  localhost:9090/api/v1/query
# and no per-form alert has started matching "(none)"
curl -s --data-urlencode 'query=survey:error_ratio:1h{form="(none)"}' localhost:9090/api/v1/query
```

**Rollback:** revert W2b only; leave W2a guards in place (harmless).

---

### W3 — Alert on provider errors

Once W1 gives `provider_error` a name, add a rule. Currently this class is silent.

**Proposed** (`devops/alerts/templates/study-health.yaml`, thresholds in `values.yaml`):

```yaml
- alert: ProviderErrors
  expr: |
    sum by (page) (survey_blocked_states{category="provider_error"}) >= {{ .Values.studyHealth.providerErrorsThreshold }}
  for: {{ .Values.studyHealth.providerErrorsFor }}
  labels:
    severity: critical
  annotations:
    summary: "Messaging provider returning internal errors ({{ $value }} users blocked on page {{ $labels.page }})"
    runbook_url: "{{ $runbook }}#providererrors"
```

**Severity `critical` — decided 2026-07-26.** A provider outage silently eats real
participants and nothing else in the system will tell you. Start loud. **Demote to
`warning` if it proves chatty** — that is the expected direction of travel, and it is the
safe direction: an alert that turns out to be noisy gets tuned down, whereas a class that
stays silent teaches nobody anything. Record the demotion and the reason in
`documentation/alerting.md` if it happens.

Note `critical` routes to PagerDuty/ntfy phone push, not just Slack — so the `for:`
duration matters more than the threshold for suppressing transient blips. Prefer a longer
`for:` over a high threshold: a provider blip that self-heals in 5 minutes should not page,
but 30 sustained minutes at any volume should.

**`by (page)`, not `by (form)`** — deliberate, and the whole point. A provider failure is a
*channel* fault: it hits every form served by that page, so a form-scoped alert fires N
times looking like N unrelated study problems. Page is the axis that makes it one incident.

This depends on the `page` label added in **W1** — W3 cannot be built before W1 ships.

**Threshold:** calibrate from real data before choosing — the current `-1` rate is ~1–11/hr,
119/30d. Do not guess.

**Write the runbook section** in `documentation/study-error-alerting.md` §2 in the same
change; every other alert has one and a rule without one is a page that leads nowhere.

---

### W4 — Add a state-dependent `reason` to `survey_recent_states`

Gives Live Traffic the cross-survey *why* it completely lacks. Design doc §6.1 has the
full SQL — follow it, with D5 as the reason the naive version is wrong.

**Must be state-dependent.** Raw `error_tag` would mislabel 19 completed and 181 blocked
users (D5). Shape:

```sql
CASE
  WHEN current_state = 'ERROR'   THEN COALESCE(error_tag, '(untagged)')
  WHEN current_state = 'BLOCKED' THEN COALESCE(fb_error_code, '(none)')
  ELSE ''
END AS reason
```

**Blast radius: low — no alert rule reads `survey_recent_states`.** Confirm that is still
true before starting:
```bash
grep -rn "survey_recent_states" devops/alerts/
```

**Cost:** design doc measured 124 → 127 groups, 372 → ~387 series, query 288–561ms vs the
current 601/489/563ms — a wash. **Re-measure; do not trust the number.**

⚠️ **Every PromQL over this metric must pin `window`** or it triple-counts. Adding
`reason` does not change that.

---

### W5 — Recalibrate thresholds against real traffic

Every absolute threshold in `study-health.yaml` was calibrated against "~8 active
users/hr across 5 forms". Measured 2026-07-26: **~156/hr across 11 shortcodes**, 2,951
distinct users/24h across 83 shortcodes and 9 pages. Roughly 20× off.

The staleness warning is already in `documentation/study-error-alerting.md` §"Volume-Gating
Reality". **Do this last** — W2b changes what the metrics see, so calibrating before it
lands would calibrate against numbers that are about to move.

Let the system run ≥1 week post-W2b, then set thresholds from observed distributions
rather than from first principles.

---

### W6 — `surveys` covering index (performance, independent)

`survey_recent_states` does `surveys@primary — FULL SCAN, KV bytes read: 300 MiB` **per
scrape, every 60s** (~430 GB/day of prod reads) because
`surveys_shortcode_userid_created_idx` does not store `survey_name`.

```bash
psql ... -c "EXPLAIN ANALYZE <the survey_recent_states query>" | grep -A2 surveys
```

**Fix:** a covering index on `surveys` (5,059 rows — small, not write-hot):
```sql
CREATE INDEX ON chatroach.surveys (shortcode, created DESC) STORING (survey_name);
```

Per the IaC rule this is `devops/migrations/NN-*.sql` applied with
`devops/run-migration.sh` — **never** ad hoc. Re-`EXPLAIN` after; confirm the full scan is
gone. Independent of W1–W5; can be done any time.

---

## 4. Sequencing

| Order | Item | Gate before proceeding |
|---|---|---|
| 1 | **W1** un-bucket + `provider_error` | Blocked alerts evaluate unchanged; `code` label present |
| 2 | **W6** surveys covering index | `EXPLAIN` shows no full scan (independent — can run in parallel) |
| 3 | **W4** `reason` on `survey_recent_states` | No alert reads it; series +~4%; no `FULL SCAN` on `states` |
| 4 | **W2a** alert guards, no-op | Every guarded rule's value identical before/after |
| 5 | **W2b** NULL-form fix | W2a confirmed deployed. Expect `PlatformInternalErrors` to get louder — triage, don't silence |
| 6 | **W3** provider alert | W1 deployed; threshold calibrated from data; runbook written |
| 7 | **W5** recalibration | ≥1 week of post-W2b data |

W1 first because it is zero-risk and alone answers the question that started this
("girleffect is blocked — why?"). W2 last among the exporter changes because it is the
only one that can wake someone up.

---

## 5. Verification protocol (every step)

1. `helm template sql-exporter devops/sql-exporter` and `helm template vlab-alerts
   devops/alerts` render.
2. Run any modified SQL against prod **and `EXPLAIN` it** — no `FULL SCAN` on `states`.
3. `helm upgrade` from the repo (IaC rule — never `kubectl patch`/`edit`).
4. Exporter pod rolls (checksum annotation) and logs clean:
   `kubectl -n monitoring logs deploy/sql-exporter --tail=20`
5. Scrape the exporter directly and confirm the new labels/series.
6. Wait one scrape, confirm in Prometheus.
7. For alert changes: compare each rule's value before/after.
8. Update `documentation/study-error-alerting.md` in the **same** commit — the taxonomy
   contract is the thing consumers read.

**Port-forwards:** `bash devops/port-forwards.sh` (Prometheus 9090, AlertManager 9093,
CockroachDB 26257). For the exporter use a *fresh* local port —
`kubectl -n monitoring port-forward svc/sql-exporter 9401:9399`.

> ⚠️ Never `pkill -f "port-forward svc/sql-exporter"` — the pattern matches the invoking
> shell's own command line and kills the session. Use a new port instead.

---

## 6. Definition of done

- [ ] "Why is study X's users blocked?" answerable from Prometheus without opening a SQL
      client — the raw provider code is a label.
- [ ] A platform error with no `current_form` is counted by `PlatformInternalErrors`.
- [ ] A provider-side failure raises *something*.
- [ ] Live Traffic's ERROR/BLOCKED counts carry a `reason` that is correct per state.
- [ ] No metric feeding an alert changed shape without its guard landing first.
- [ ] `documentation/study-error-alerting.md` matches what the exporter actually emits.
- [ ] No new `FULL SCAN` on `states`; `surveys` scan eliminated.

---

## 7. Open questions to resolve while working

1. ~~Does `survey_blocked_states` get `page`?~~ **Resolved 2026-07-26: yes, in W1,
   together with `study`.** Measured cost is 94 → 99 series over 30 days (15 pages), because
   a form is nearly always served from one page. `page` is what distinguishes a channel
   failure from a study failure — without it, one page outage reads as several unrelated
   form problems. See W1.
2. ~~Is `-1` alertable or just visible?~~ **Resolved 2026-07-26: it pages.** `severity:
   critical`, on the reasoning in W3 — start loud, demote to `warning` later if it proves
   chatty. Tune the `for:` duration rather than the threshold.
3. **What is a NULL `fb_error_code`?** 131 rows over 30 days across 21 forms, rank 4 of 7
   — genuinely unknown. `fb_error_code` is a *computed* column
   (`state_json->'error'->>'code'`), so NULL means the error object has no `code` key, or
   there is no error object at all — a BLOCKED state with no error at all would be a much
   more interesting finding. **Under active investigation**; findings will land in
   `planning/null-fb-error-code-findings.md` with a taxonomy recommendation. **W1 must not
   ship its bucketing decision for this class until that lands** — W1 exposes it as
   `code="(none)"` regardless, which is safe and non-committal.
4. ~~`survey_stuck_users` has no `current_state` pin.~~ **Resolved 2026-07-26: not a full
   scan, leave it alone.**
   ```
   table: states@states_stuck_on_question_current_state_current_form_updated_idx
   spans: (/NULL - ]        -- "stuck_on_question IS NOT NULL"
   74,298 rows / 8.3 MiB read → 8 rows returned, 84-200ms
   ```
   The index leads with `stuck_on_question`, so `IS NOT NULL` builds a valid span. The span
   is *wide* (6.9% of the table) because `updated` is the **4th** key column, behind
   `current_form` — so the 1h filter cannot bound it. Adding a `current_state` pin would
   **not** help for the same reason.
   Nothing like the pathology INDEX DISCIPLINE warns about (1.07M rows / 1.23s). At 8.3 MiB
   per scrape it is ~1/36th the cost of the `surveys` full scan in W6. **Not worth an
   index; revisit only if `states` grows an order of magnitude.**

---

## 8. Related documents

- [`error-visibility-design.md`](./error-visibility-design.md) — the design; panels (§4–5),
  discriminator (§2), drill paths (§8). Do panel work after this plan.
- `documentation/study-error-alerting.md` — taxonomy contract; **update as you go**.
- `devops/grafana-dashboards/README.md` — board inventory.
- [`cockroachdb-cost-reduction-plan.md`](./cockroachdb-cost-reduction-plan.md) — unrelated,
  but also touches `states` indexes. Do not let W6 collide with its migration numbering.
