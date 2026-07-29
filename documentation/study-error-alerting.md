# Study Error Alerting — design, metrics, and runbooks

> Survey health monitoring via sql_exporter → Prometheus → AlertManager. Detects
> study misconfiguration, platform regressions, and UX issues by analyzing error,
> blocked, stuck, and expired states across surveys. All alerts are
> version-controlled in `devops/alerts/templates/study-health.yaml`.
>
> **Related:** `documentation/alerting.md` (alerting inventory + routing),
> `MONITORING_STACK.md` (stack overview).

---

## 1. Design Overview

### Metrics Source

Metrics are exported from CockroachDB by **sql_exporter** (monitoring namespace),
scraped by Prometheus every 1 minute. The queries analyze recent survey state
patterns (1h window) to detect anomalies without PII exposure. All metrics have
`form` labels (survey/form ID) and categorical labels (`error_tag`, `category`,
`state`) instead of user IDs.

**Key insight:** The 1h window is a compromise. The original lifetime queries
(`created_at` with no time filter) caused query timeouts on large state tables.
The 1h window reflects **recent activity** (users active in the last hour), not
total lifetime counts. This is sufficient for alerting (we care about current
degradation, not historical trends) and keeps query times <1s.

**Every query must pin `current_state`, or it full-scans.** `states` has no index
leading with `updated`; the usable indexes (`states_current_state_updated_idx`,
`states_current_state_current_form_updated_idx`) both lead with `current_state`. A query
filtering only on `updated > NOW() - INTERVAL ...` therefore scans the whole table —
measured on prod 2026-07-25, **1,072,959 rows / 1.23s per call**, and since `states` is
never garbage-collected that scan grows forever. Adding
`current_state = ANY(<all 10 machine states>)` lets CockroachDB build tight
`(current_state, updated > t)` spans: same result, 200–320ms.

`survey_active_users` and the retired `survey_state_total` were both full-scanning on
every 60s scrape until 2026-07-25. This is the same fix applied to dashboard-server's
`healthSummary` in commit 413d6774.

**The tradeoff, stated loudly:** a state machine state missing from the enumeration is
*invisible* to every metric — silently dropped from counts **and from the
`survey_active_users` denominator**, which would inflate `survey:error_ratio:1h` and fire
alerts. The list must stay in sync with the state machine (botserver-core) and with
dashboard-server's `STATE_MACHINE_STATES`. Verified complete against 30 days of prod data
on 2026-07-25 (zero rows outside `START`, `RESPONDING`, `QOUT`, `END`, `BLOCKED`, `ERROR`,
`WAIT_EXTERNAL_EVENT`, `USER_BLOCKED`, `RESET`, `OFF`).

**The window is also correctness, not just performance.** `states` holds one sticky
row per user and is **never garbage-collected**, so any count taken over the whole
table is a graveyard of long-fixed bugs. In July 2026 the 2,001 lifetime
`STATE_ACTIONS` states were dominated by three dead classes — 1,013 last seen in
2022, 366 in 2024, 286 in 2022 — against roughly 42 in the preceding 90 days. Always
window error-tag queries on `updated`.

### Metrics Catalog

All metrics are gauges reflecting counts in the last hour:

| Metric | Labels | Meaning |
|--------|--------|---------|
| `survey_error_states` | `form`, `error_tag`, `page` | Users in ERROR state by error_tag (INTERNAL, STATE_ACTIONS, NETWORK, FORM_NOT_FOUND, FIELD_NOT_FOUND, INTERPOLATION_ERROR, none) |
| `survey_blocked_states` | `form`, `category`, `code`, `page` | Users in BLOCKED state by category **and raw provider code** |
| `survey_stuck_users` | `form` | Users stuck on the same question (validation loop / confusing form) |
| `survey_expired_waits` | `form` | Users in WAIT_EXTERNAL_EVENT past timeout (Dean not processing) |
| `survey_active_users` | `form` | Total active users (denominator for error ratios) |

**Changed 2026-07-26 — three things that were destroying signal:**

1. **`survey_blocked_states` now carries the raw `code`.** The `CASE` bucketing discarded
   the actual reason a user was blocked. It existed to bound cardinality that does not
   exist: over 30 days there are exactly **7** distinct `fb_error_code` values. `category`
   is unchanged (the alert rules match on it); `code` sits alongside it.
2. **`form="(none)"` replaces dropped rows.** Every query used to end
   `AND current_form IS NOT NULL`, hiding **55%** of platform-fault errors (37 of 67 over
   30 days) from `PlatformInternalErrors`, a *paging* alert. Per-form rules exclude the
   sentinel via `studyHealth.nullForm`; **platform-wide rules must not** — that inclusion
   is the fix.
3. **`page` added to both.** A provider failure hits every form on a page, so a form-only
   view renders one channel outage as N unrelated study problems.

**Two categories split out of `other`** (which no alert rule has ever referenced, so this
whole class was silent):

| category | code | Meaning |
|---|---|---|
| `provider_error` | `-1` | Meta's own `(#-1) Unexpected internal error`. We reached Meta; Meta failed. Dean retries these. |
| `provider_unreachable` | `(none)` / `0` | We never reached Meta — no HTTP request was made, typically a missing page token. **Dean cannot retry these** (`= ANY` never matches NULL), so affected users stay blocked permanently. See `planning/null-fb-error-code-findings.md`. |

> These two categories exist in **sql_exporter only**. dashboard-server still buckets
> `-1` and `NULL`/`0` into `other`. See "Known divergences" in the Taxonomy contract below.

**Live traffic metric** (5m window, `study_traffic` collector — *not* alerted on):

| Metric | Labels | Meaning |
|--------|--------|---------|
| `survey_recent_states` | `window`, `state`, `form`, `study`, `page`, `page_name` | Distinct users active within `window` (`5m` / `1h` / `24h`), by state machine state, form (shortcode), study (`surveys.survey_name`), and messaging page |

`survey_recent_states` backs the **Live Traffic** Grafana board (`/d/live-traffic`) and
answers "who is talking to the bot right now, on which page, in which study, in which
state". The board's `$window` variable switches between the three windows in the UI.

> **⚠️ Always pin the window in PromQL.** `sum by (state) (survey_recent_states)` sums all
> three windows and silently triple-counts. Write
> `sum by (state) (survey_recent_states{window="5m"})`.

**Every window is a distinct-user count, not a sum of buckets.** `states` holds one sticky
row per (user, page), so `window="24h"` is *distinct people we talked to today* (2,951 on
2026-07-26) and `window="5m"` is *who is here right now* (7 at the same moment). They
answer different questions and are not scaled versions of each other.

Keep the **error spike panel on `5m`**. The 1h windows used by the alerting metrics smear
a spike across an hour and hold it visible for an hour after it stopped — right for "is
this study broken", wrong for "what is happening now".

**One scan, three windows.** The exporter uses `COUNT(*) FILTER (WHERE updated > ...)` over
a single 24h index span rather than three separate queries, and resolves the study/page
labels *after* the `GROUP BY` — against ~124 grouped rows instead of ~2,951 raw ones.
Joining before aggregating measured 2x slower (1.03s vs 420–500ms) and the gap widens with
traffic, since group count grows far slower than row count.

Study and page names are resolved **in SQL** (`LEFT JOIN LATERAL` to the newest `surveys`
row for the shortcode; `LEFT JOIN credentials` on `facebook_page_id`) rather than by a
PromQL `group_left` join against an info metric. An info-metric join silently *drops* any
series with no match — on a traffic board that means traffic disappearing with no
indication. `COALESCE` guarantees every row is emitted: an unmapped form appears as
`study="unknown"`. The study mapping takes the newest `surveys` row rather than the
version-aware one dashboard-server uses (`created <= form_start_time`); over a 5m window
of currently-active users these agree except when a study is renamed mid-conversation.

> **Retired 2026-07-25:** `survey_state_total{form,state}` (1h state distribution).
> Superseded by `survey_recent_states`, which answers the same question on a live window
> and adds the study/page dimensions. Nothing alerted on it.

**All five 1h metrics also carry `study`** (from `surveys.survey_name`, resolved *after*
aggregation via the covering index added in migration 22). Form `305` is relabelled
`study="fallback (no study)"` — it previously inherited the newest matching survey's name
and the boards showed 331 users at a 100% error rate under a real study's name.

**Recording rules** (group `vlab-study-health-recordings`; no alert reads any of them):

| Rule | Meaning |
|---|---|
| `survey:error_ratio:1h{form}` | Error ratio per form. Denominator clamped to 1 against div-by-zero on inactive forms. Excludes `(none)`. |
| `survey:error_ratio:fleet:1h` | **What "normal" is right now.** Fleet-wide ratio, fallback and `(none)` excluded from both sides so the permanent-100% fallback cannot drag the baseline up and mask a real regression. |
| `survey:error_ratio_excess:1h{form}` | **How far above normal one study sits** — the per-form ratio minus the fleet baseline. |
| `survey:erroring_studies:platform:1h` | Count of distinct studies carrying platform-fault tags. |
| `survey:erroring_studies:study_side:1h` | Count of distinct studies carrying study-fault tags (fallback excluded). |

**Why `excess` and not just `ratio`** — this is the column that tells you which board to
be on. A 40% error ratio means something completely different when the fleet is at 4%
(that study is broken → stay on Study Health) than when the fleet is at 35% (*everything*
is broken → go to Live Traffic). During a platform-wide event every study rises together
and excess collapses toward zero. **That asymmetry is the point**: excess is an excellent
within-survey detector and a deliberately useless cross-survey one.

> ⚠️ **Two idioms in the breadth rules are load-bearing, do not "simplify" them:**
> - **`> 0`** — these gauges emit *zero-valued* series for every group seen in the scan
>   window, so a bare `count()` counts the entire fleet. This exact bug shipped to Live
>   Traffic's stat panels on 2026-07-25 (read 29 against a true 3).
> - **`or vector(0)`** — without it the series vanishes when nothing is erroring and a
>   Grafana stat renders "No data" instead of a reassuring `0`.

### Error Taxonomy

**error_tag** (ERROR state, `survey_error_states`):
- **INTERNAL / STATE_ACTIONS / NETWORK** — platform bugs (database failures, state machine errors, network issues). Rare, always actionable → **page**.
- **FORM_NOT_FOUND** — study misconfiguration (no form/study exists for that user). Study-level issue → **ticket**.
- **FIELD_NOT_FOUND** — the form does not contain a field it refers to (a jump target, or the field the respondent is sitting on after the owner edited the form). Study-level issue → **ticket**.
- **INTERPOLATION_ERROR** — a question interpolates a value that does not exist: `{{field:ref}}` for an answer the respondent never gave (questions reordered, or the branch that asks it was skipped), or an unknown transform. Study-level issue → **ticket**. Note `{{hidden:key}}` cannot trigger this — a missing metadata key interpolates to `""`.
- **none** — ERROR state with no specific tag. Often study logic errors.

`FIELD_NOT_FOUND` and `INTERPOLATION_ERROR` are thrown by `form.js` and carry their
`tag` on the error object; `transition.js` reads it. Anything untagged falls to
`STATE_ACTIONS`, which every consumer reads as *platform fault* — so a study-authoring
mistake must be given a tag, or it pages the platform on-call with a runbook that leads
nowhere. Downstream needs no change per tag: `DEAN_ERROR_TAGS` and the dashboard's
`PLATFORM_ERROR_TAGS` are both allow-lists, and unrecognized tags default to the study.

**category** (BLOCKED state, `survey_blocked_states`):
- **attrition** (codes 10, 190, 551) — normal user churn (user blocked the page, opted out, etc.). **Excluded from alerts** (expected behavior).
- **template_missing** (code 100) — Facebook template missing/unapproved. Study-level config issue → **ticket**.
- **rate_limit** (code 2022) — Facebook rate-limiting the page. Platform issue (hitting Meta API limits) → **page**.
- **unsupported / other** — rare edge cases.

### Taxonomy contract

**This table is the single source of truth for the classification.** There is no
code generation and no conformance test — the contract holds only because every
change to a classification is made here first, then applied to each consumer in
the inventory below.

| Dimension | Mapping | Class |
|---|---|---|
| `error_tag` IN (INTERNAL, STATE_ACTIONS, NETWORK) | `error.platform` | deterministic (platform's fault) |
| `error_tag` = FORM_NOT_FOUND, FIELD_NOT_FOUND, INTERPOLATION_ERROR, NULL (`none`), or any unrecognized tag | `error.study` | stochastic |
| `fb_error_code` IN (10, 190, 551) | `blocked.attrition` | excluded (expected churn) |
| `fb_error_code` = 100 | `blocked.template_missing` | deterministic |
| `fb_error_code` = 2022 | `blocked.rate_limit` | deterministic (platform-side) |
| `fb_error_code` = 200 | `blocked.unsupported` | stochastic |
| `fb_error_code` = -1 | `blocked.provider_error` | deterministic (provider-side, retryable) |
| `fb_error_code` IS NULL or = 0 | `blocked.provider_unreachable` | deterministic (**not** retryable) |
| any other `fb_error_code` | `blocked.other` | stochastic |
| `stuck_on_question IS NOT NULL` | `stuck_users` | stochastic (platform alerting only — **no dashboard rule** since 2026-07-29, see `documentation/dashboard-study-health.md` §4) |
| `current_state = 'WAIT_EXTERNAL_EVENT' AND timeout_date < NOW()` | `expired_waits` | stochastic |
| all rows in window | `active_users` | denominator |

Consumers intentionally use **different windows** (1h alerting vs 24h dashboard)
and **different thresholds** — the contract is the classification, not the rules
on top of it.

### Consumer inventory — check every row before changing a classification

The classification is hand-maintained in **six places across four languages**.
"Keep consumers in sync" is not actionable without the list, so here it is. The
two halves of the taxonomy are classified at *different layers*, which is why
there is no single place to change:

- **`fb_error_code` → category** is classified **early**, in SQL, so the category
  becomes a metric label / query column.
- **`error_tag` → platform-vs-study** is classified **late**, at consumption time.
  sql_exporter exports `error_tag` **raw** and the split lives in PromQL matchers;
  dashboard-server does the same split in a JS array.

| # | Site | Form | Covers |
|---|---|---|---|
| 1 | `dashboard-server/queries/states/states.queries.js` (`healthSummary`) | SQL `CASE` | `fb_error_code` → category |
| 2 | `dashboard-server/api/health/aggregate.js` (`FB_CATEGORIES`) | JS array — allow-list that must match site 1 | category names |
| 3 | `dashboard-server/api/health/aggregate.js` (`PLATFORM_ERROR_TAGS`) | JS array | `error_tag` → platform/study |
| 4 | `devops/sql-exporter/templates/configmap.yaml` | SQL `CASE` | `fb_error_code` → category |
| 5 | `devops/alerts/templates/study-health.yaml` | PromQL label matchers on `category` (3 sites) | which categories alert |
| 6 | `devops/alerts/templates/study-health.yaml` | PromQL regex `error_tag=~"INTERNAL\|STATE_ACTIONS\|NETWORK"` — **repeated 3×** | `error_tag` → platform/study |

A seventh coupling is adjacent but *not* the taxonomy: `rules.js` →
`platformNotices` is a whitelist keyed on **AlertManager alertnames**, and
`notices.js` silently drops any alert not in it. Renaming an alert in
`study-health.yaml` therefore removes a researcher-facing notice with no error.
AlertManager itself knows nothing about the taxonomy — it routes on `severity`
only.

### Divergences — resolved 2026-07-29

All consumers now implement the contract table above. Three divergences were
closed together, because the failure class this doc calls "the serious one" — the
missing-page-token case that left 131 participants permanently blocked for 12
days — was **invisible to researchers by three independent routes**:

| Was | Sites | Fix |
|---|---|---|
| `provider_error` / `provider_unreachable` missing (added to sql_exporter 2026-07-26, never propagated) | 1, 2 | Both added to the `healthSummary` CASE and to `FB_CATEGORIES`. |
| No rule read `blocked.other` **or** `blocked.unsupported` — both classified, neither surfaced | `rules.js` | `provider-unreachable` (action), `provider-error-spike`/`-trickle`, `blocked-unsupported` and `blocked-other` (notes). Every blocked category except `attrition` now reaches a rule. |
| `ProviderErrors` absent from `platformNotices` | `rules.js` | Added. |

Two deliberate copy decisions worth preserving:

- **`provider-unreachable` does not say delivery resumes automatically.** It
  can't: dean retries via `fb_error_code = ANY(...)` and SQL `= ANY` never
  matches NULL, so these respondents are structurally unrecoverable and the copy
  tells the researcher to contact support instead of waiting.
- **`provider_error` (-1) is treated as stochastic, not deterministic.** The
  provider was reached and failed its own way; dean *does* retry these, so a
  trickle is a note and only a spike (≥5% and ≥3) is an action.

`blocked.attrition` remains intentionally rule-free — it is expected churn.
Because `blocked-other` is now a catch-all note, a future category added to the
taxonomy without its own rule degrades to a visible note rather than silence.

### Alerting Logic

Alerts distinguish **platform regressions** (page immediately) from **study issues** (ticket).

**Platform signals (critical, page):**
- Sum of INTERNAL/STATE_ACTIONS/NETWORK errors ≥ 5 (any count is bad; threshold is noise gate).
- Sum of rate_limit blocks ≥ 10 (Facebook throttling us).
- ≥3 active surveys erroring at once (>30% error rate each) — multi-survey pattern = platform.

**Study signals (warning, ticket):**
- Single study: template_missing ≥ 5, or error_ratio >50% (with volume gate), or stuck_users ≥ 10.
- Dean not processing: expired_waits ≥ 10.

**Form 305 exclusion:** Form 305 is the **fallback form** (catches users with no
assigned study). It has permanent FORM_NOT_FOUND errors by design. All per-study
alerts exclude `form!="305"`.

**Attrition exclusion:** The `attrition` category (codes 10/190/551) is normal
user churn and is **never alerted on**. Only actionable blocked categories fire
alerts.

### Volume-Gating Reality

> **⚠️ These figures are stale and the thresholds rest on them.** The numbers below
> described traffic when the rules were written (July 2026, ~8 active users/hr across 5
> forms). Measured on prod **2026-07-25**, actual traffic is roughly **20× higher**:
>
> | window | active rows | distinct shortcodes | pages |
> |--------|------------|---------------------|-------|
> | 5 min  | ~9         | —                   | —     |
> | 1 hour | ~156       | 11                  | 5     |
> | 24 h   | 2,917      | 83                  | 9     |
>
> Every absolute threshold in `study-health.yaml` (platform errors ≥5, rate_limit ≥10,
> stuck ≥10, expired ≥10) was calibrated as a noise gate against the *old* volume, so
> they now sit far closer to normal traffic than intended — a single busy study can
> plausibly reach them. **Recalibration is outstanding work**; the Live Traffic board
> exists partly to give the real baseline to recalibrate against. The reasoning below is
> still correct, the constants are not.

**Traffic was LOW when these rules were written:** ~8 active users/hr total across 5
forms; per-form traffic is 0–3 users/hr. Error/blocked/stuck/expired counts are all 0–2
now. This means:

1. **Absolute thresholds must be low** (5–10 range) to detect real issues.
2. **Per-form proportion alerts must gate on minimum volume** (≥10 active users +
   ≥5 errors) to avoid noise on low-traffic forms.
3. **These thresholds are v1 and WILL NEED TUNING** as traffic grows. They're
   calibrated to detect real degradation at current scale without false positives.

**Verification:** A correctly calibrated rule set will NOT fire on deploy (all
metrics ~0 now). If any alert fires immediately, the threshold is too low or the
expression is wrong.

---

## 2. Alerts — Runbooks

All alerts defined in `devops/alerts/templates/study-health.yaml`, configured via
`devops/alerts/values.yaml`. Severity labels drive the staged AlertManager routing
(critical → page + Slack, warning → Slack). Today all alerts go to `#vlab-alerts`.

### providererrors

**Signal:** `sum by (page) (survey_blocked_states{category=~"provider_error|provider_unreachable"}) >= 10` for 30m
**Severity:** critical (pages)
**Meaning:** The messaging channel is failing users on a specific page. These people
wanted to participate and the platform could not deliver — this is neither churn nor a
study misconfiguration.

**First: read the `code` label. The two classes have completely different causes.**

| `category` | `code` | What it means |
|---|---|---|
| `provider_error` | `-1` | A genuine Meta error: `(#-1) Unexpected internal error`. We reached Meta; Meta failed. Usually transient. Dean **does** retry these (`-1` is in `DEAN_FB_CODES`). |
| `provider_unreachable` | `(none)` / `0` | We **never reached Meta**. `status 0` means no HTTP request was made — almost always a missing page access token. Dean **cannot** retry these. |

**`provider_unreachable` is the serious one.** Users land permanently blocked and nothing
recovers them: `dean/queries.go:136` retries via `fb_error_code = ANY($1)`, and SQL
`= ANY` never matches NULL, so these are structurally invisible to the retry path. The
July 2026 incident left 131 participants blocked for 12 days this way.

**What to do:**

1. **Split the two classes:**
   ```promql
   sum by (page, code) (survey_blocked_states{category=~"provider_error|provider_unreachable"})
   ```

2. **If `provider_unreachable`** — check whether the page's credentials resolve:
   ```sql
   SELECT facebook_page_id, details->>'name'
   FROM chatroach.credentials WHERE facebook_page_id = '<page>';
   ```
   Confirm `message-worker` is reading the **right database** — the known root cause was
   staging's worker consuming production traffic and querying the staging DB, which held
   no production tokens. Check the message-worker logs for
   `failed to get token: token not found for platform account`.

3. **If `provider_error` (-1)** — check whether Meta is degraded
   (<https://metastatus.com>). Dean retries these; confirm the retry path is actually
   draining rather than assuming it.

4. **Find the affected users** (they will not self-heal if `provider_unreachable`):
   ```sql
   SELECT userid, pageid, current_form, updated
   FROM chatroach.states
   WHERE current_state='BLOCKED' AND (fb_error_code IS NULL OR fb_error_code IN ('0','-1'))
     AND updated > NOW() - INTERVAL '24 hours'
   ORDER BY updated DESC LIMIT 50;
   ```

**Known outstanding fix:** `message-worker` tags pre-flight failures as `FB`
(`worker.go:328-335`), which routes them to `BLOCKED` instead of `ERROR`, and drops the
status code via `json:"code,omitempty"` (`worker.go:317`). Until both are fixed, this
class stays unrecoverable by design. See `planning/null-fb-error-code-findings.md`.

---

### platforminternalerrors

**Signal:** `sum(survey_error_states{error_tag=~"INTERNAL|STATE_ACTIONS|NETWORK"}) >= 5` for 10m  
**Severity:** critical (pages when staged routing is live)  
**Meaning:** Platform regression — database issues, state machine bugs, network failures, or infrastructure problems. These errors are never expected.

**What to do:**
1. **Identify the error_tag breakdown:** Port-forward Prometheus (`kubectl port-forward -n monitoring svc/prometheus-kube-prometheus-prometheus 9091:9090; exit 0`) and query:
   ```promql
   sum by (error_tag) (survey_error_states{error_tag=~"INTERNAL|STATE_ACTIONS|NETWORK"})
   ```
   — which tag(s) are spiking?

2. **Check CockroachDB for recent ERROR states:**
   ```sql
   SELECT userid, form, error_tag, updated_at
   FROM states
   WHERE state = 'ERROR'
     AND error_tag IN ('INTERNAL', 'STATE_ACTIONS', 'NETWORK')
     AND updated_at > NOW() - INTERVAL '1 hour'
   ORDER BY updated_at DESC
   LIMIT 50;
   ```

3. **Correlate with platform components:**
   - **INTERNAL:** Check replybot/hermes logs for exceptions, CockroachDB connectivity, Redis failures.
   - **STATE_ACTIONS:** State machine logic bug. Check botserver-core/replybot state transition code + recent deploys.
   - **NETWORK:** Network issues between services (formcentral, Facebook Graph, CockroachDB). Check service logs + k8s network.

4. **Check recent deploys:** `helm history gbv -n vprod` — was a bad image deployed? Roll back if needed.

5. **Monitor Kafka consumer lag:** Platform internal errors often correlate with message processing failures. Check `/study-health` or the consumer-lag dashboard.

**Resolution:** Fix the root cause (rollback bad deploy, restart failed service, fix bug). Errors should clear once the platform is healthy again.

---

### platformratelimited

**Signal:** `sum(survey_blocked_states{category="rate_limit"}) >= 10` for 10m  
**Severity:** critical (pages when staged routing is live)  
**Meaning:** Facebook is rate-limiting the platform (code 2022). We're hitting Meta's API limits across surveys.

**What to do:**
1. **Confirm the volume:** Query Prometheus:
   ```promql
   sum by (form) (survey_blocked_states{category="rate_limit"})
   ```
   — is it spread across forms or concentrated on one?

2. **Check Facebook API usage:** Meta Business Manager → API usage dashboard. Identify which limits we're hitting (send rate, message volume, etc.).

3. **Check for message-sending spikes:** Did a study launch a broadcast or high-volume campaign? Query CockroachDB:
   ```sql
   SELECT form, COUNT(*) AS blocked_users
   FROM states
   WHERE state = 'BLOCKED' AND facebook_code = 2022
     AND updated_at > NOW() - INTERVAL '1 hour'
   GROUP BY form
   ORDER BY blocked_users DESC;
   ```

4. **Temporary mitigation:** If a single study is causing the spike, pause it (disable the form in the dashboard or deactivate the study). If it's platform-wide, we may need to throttle message sending in replybot/hermes.

5. **Long-term fix:** Implement rate-limiting in the message-sending layer (replybot/hermes) to stay under Meta's limits. Investigate switching to a higher-tier Meta Business account if needed.

**Resolution:** The rate limit will lift after the time window expires (usually 1–24 hours depending on the limit). Users blocked during the window will recover automatically once the limit clears.

---

### surveytemplatemissing

**Signal:** `sum by (form)(survey_blocked_states{category="template_missing"}) >= 5` for 15m  
**Severity:** warning (ticket)  
**Meaning:** A single study's Meta message template is missing or not approved (code 100). This is a study configuration issue, not platform-wide.

**What to do:**
1. **Identify the study:** The `form` label shows which survey. Look up the study owner in the dashboard or CockroachDB:
   ```sql
   SELECT id, name, created, updated, metadata
   FROM surveys
   WHERE form_id = '<form>';
   ```

2. **Check Meta template status:** Meta Business Manager → Message Templates. Is the template pending approval, rejected, or deleted? The study must have an approved template to send messages.

3. **Contact the study owner:** Create a Linear ticket assigned to the study team. Template: "Survey X is blocked due to missing Meta template (code 100). Y users affected in the last hour. Please submit/resubmit the template for approval."

4. **Temporary workaround:** If the study is urgent and the template is pending approval, expedite the approval process with Meta support (if available). Otherwise, users are blocked until the template is approved.

**Resolution:** Once the template is approved, users will unblock automatically on their next message attempt. No platform action needed.

---

### surveyerrorspike

**Signal:** `survey:error_ratio:1h{form!="305"} > 0.5` AND `sum by (form)(survey_error_states) >= 5` AND `sum by (form)(survey_active_users) >= 10` for 15m  
**Severity:** warning (ticket)  
**Meaning:** A single study has >50% of users hitting errors, with sufficient volume to avoid noise (≥10 active users, ≥5 errors). This is a study-level issue (bad form configuration, broken question logic, or study-specific integration problem).

**What to do:**
1. **Identify the study and error breakdown:** Query Prometheus:
   ```promql
   sum by (form, error_tag) (survey_error_states{form="<form>"})
   ```
   — what error_tag(s) are spiking?

2. **Check the form configuration in CockroachDB:**
   ```sql
   SELECT id, name, created, updated, metadata
   FROM surveys
   WHERE form_id = '<form>';
   
   SELECT userid, form, error_tag, updated_at
   FROM states
   WHERE form = '<form>' AND state = 'ERROR'
     AND updated_at > NOW() - INTERVAL '1 hour'
   ORDER BY updated_at DESC
   LIMIT 20;
   ```

3. **Common causes:**
   - **FORM_NOT_FOUND:** The survey/form doesn't exist in formcentral or the mapping is broken. Check formcentral API.
   - **none:** Often a study logic error (bad question skip logic, required field missing, etc.). Review the form structure in the dashboard.

4. **Contact the study owner:** Create a Linear ticket with the error details. If it's a configuration issue, guide them to fix the form. If it's a platform bug exposed by this study, escalate to the engineering team.

**Resolution:** Fix the study configuration or form logic. Users will recover on their next interaction once the issue is resolved.

---

### multisurveyerrorregression

**Signal:** `count( (survey:error_ratio:1h{form!="305"} > 0.3) and on(form) (sum by (form)(survey_active_users) >= 10) ) >= 3` for 10m  
**Severity:** critical (pages when staged routing is live)  
**Meaning:** Three or more active studies are experiencing >30% error rates simultaneously. This pattern indicates a platform regression, not study-specific issues.

**What to do:**
1. **Confirm the pattern:** Query Prometheus:
   ```promql
   (survey:error_ratio:1h{form!="305"} > 0.3) and on(form) (sum by (form)(survey_active_users) >= 10)
   ```
   — which forms are erroring? What's the common thread?

2. **Check for platform-wide issues:**
   - CockroachDB down or slow? Check `kubectl -n default get pods` and CockroachDB logs.
   - Redis down? Check `kubectl -n vprod get pods -l app.kubernetes.io/name=redis`.
   - formcentral unreachable? Check formcentral service logs.
   - Facebook Graph API issues? Check replybot/hermes logs for 5xx errors from Facebook.

3. **Check recent deploys:** `helm history gbv -n vprod` — was a bad botserver-core or replybot image deployed? Roll back if needed.

4. **Check Kafka consumer lag:** Platform-wide errors often correlate with message processing backlog. Query `/study-health` or the consumer-lag dashboard.

5. **Check the PlatformInternalErrors alert:** If it's also firing, the error_tag breakdown will guide you to the root cause (INTERNAL = DB/Redis, STATE_ACTIONS = state machine, NETWORK = service connectivity).

**Resolution:** Fix the platform issue (restart failed service, rollback bad deploy, fix infra). Errors should clear across all studies once the platform is healthy.

---

### surveystuckusersspike

**Signal:** `survey_stuck_users >= 10` for 20m  
**Severity:** warning (ticket)  
**Meaning:** Users are stuck on a single question for an extended period (validation loop or confusing form UX). This is a study-level UX issue, not a platform bug.

**What to do:**
1. **Identify the study and stuck question:** Query CockroachDB:
   ```sql
   -- Assuming stuck_users logic queries for users with >N repeats on the same question
   -- (exact schema TBD; this is illustrative)
   SELECT form, question_ref, COUNT(*) AS stuck_count
   FROM states
   WHERE updated_at > NOW() - INTERVAL '1 hour'
     -- AND <stuck condition: e.g., same question_ref for >5 state updates>
   GROUP BY form, question_ref
   HAVING COUNT(*) >= 10
   ORDER BY stuck_count DESC;
   ```

2. **Review the question logic in the dashboard:** Is the validation impossible to satisfy? Is the question unclear? Common issues:
   - Required field with no valid input (e.g., "enter a number between 1 and 10" but all inputs rejected).
   - Skip logic broken (user can't advance past this question).
   - Confusing wording (user doesn't understand what's being asked).

3. **Contact the study owner:** Create a Linear ticket with the question details. Guide them to fix the validation or clarify the question. If it's a platform bug (validation logic broken in botserver-core), escalate to engineering.

**Resolution:** Fix the form (relax validation, clarify question, fix skip logic). Users will unblock on their next attempt once the fix is deployed.

---

### deanexpiredwaits

**Signal:** `sum(survey_expired_waits) >= 10` for 15m  
**Severity:** warning  
**Meaning:** Users are in WAIT_EXTERNAL_EVENT state past their timeout. Dean (the external event processor) is not clearing these timeouts. This is a platform issue (Dean down, not processing events, or integration failure).

**What to do:**
1. **Check Dean status:** Is Dean running? Check the deployment:
   ```bash
   kubectl -n default get pods -l app=dean
   kubectl -n default logs -l app=dean --tail=100
   ```
   — is it crash-looping? Are there errors in the logs?

2. **Check Dean's event processing:** Dean consumes events from Kafka and updates states in CockroachDB. Check:
   - Kafka consumer lag for Dean's consumer group (`/study-health` or consumer-lag dashboard). If lag is high, Dean is behind.
   - CockroachDB connectivity from Dean. Are there DB errors in the logs?

3. **Check for event source issues:** Is the external service (e.g., a webhook, third-party API) sending events? If Dean is waiting for events that never arrive, users will timeout. Check the study configuration — are the external event triggers still active?

4. **Temporary mitigation:** If Dean is down, restart it (`kubectl -n default rollout restart deployment/dean`). If the event source is broken, contact the study owner to fix the integration or disable the WAIT_EXTERNAL_EVENT step.

**Resolution:** Restart Dean or fix the event source. Users past timeout may need manual state cleanup (transition them out of WAIT_EXTERNAL_EVENT if the event will never arrive).

---

## 3. Threshold Tuning Guidance

All thresholds are **v1 — calibrated to current low traffic** (~8 active users/hr
total, 0–3 per form). As traffic grows, these will need adjustment. Thresholds
are configured in `devops/alerts/values.yaml` under `studyHealth.*`.

### Current Thresholds

| Alert | Threshold | Rationale |
|-------|-----------|-----------|
| **PlatformInternalErrors** | ≥5 errors/10m | Any count is bad; 5 is noise gate at current scale |
| **PlatformRateLimited** | ≥10 blocks/10m | Facebook rate limits are rare; 10 is significant |
| **SurveyTemplateMissing** | ≥5 blocks/15m | Per-form; 5 is meaningful at 0–3 users/hr/form |
| **SurveyErrorSpike** | >50% ratio + ≥5 errors + ≥10 active | Needs volume to avoid noise on low-traffic forms |
| **MultiSurveyErrorRegression** | ≥3 forms >30% + ≥10 active/form | Pattern detection; 3 is min to distinguish from coincidence |
| **SurveyStuckUsersSpike** | ≥10 stuck/20m | Stuck is rare; 10 is significant |
| **DeanExpiredWaits** | ≥10 expired/15m | Expired waits are rare; 10 is significant |

### Tuning Process

1. **Monitor alert frequency:** Are alerts firing too often (noise) or not often enough (missing real issues)?
2. **Check Prometheus queries:** Port-forward and query the metrics to see actual values during normal operation.
3. **Adjust thresholds in values.yaml:** Bump up if too noisy, lower if missing issues.
4. **Deploy and verify:** `helm upgrade vlab-alerts devops/alerts -n monitoring` and watch for a week.

**Traffic scaling:** When per-form traffic reaches 10–50 users/hr, the volume gates
(≥10 active users) will be more meaningful. The proportion-based alerts
(SurveyErrorSpike, MultiSurveyErrorRegression) will become more reliable. The
absolute thresholds (PlatformInternalErrors, etc.) may need to scale up to avoid
noise.

---

## 4. Grafana Dashboard

**Name:** "Study Health"  
**Location:** `devops/grafana-dashboards/study-health.json`  
**Deployed as:** ConfigMap `study-health-dashboard` (monitoring namespace, labeled `grafana_dashboard=1`)  
**Auto-loaded by:** Grafana sidecar (watches ConfigMaps with that label)

### Panels

1. **Error Ratio per Form (1h window)** — recording rule `survey:error_ratio:1h`. Thresholds at 30% (yellow) and 50% (red).
2. **Active Users per Form (1h window)** — denominator for error ratio.
3. **Blocked States by Category (stacked)** — attrition greyed out (expected), rate_limit (red), template_missing (orange).
4. **Error States by Tag (stacked)** — INTERNAL/STATE_ACTIONS/NETWORK (red), FORM_NOT_FOUND (orange), none (yellow).
5. **Stuck Users per Form** — threshold line at 10 (alert level).
6. **Expired Waits per Form** — threshold line at 10 (alert level).
7. **Recent State Distribution (all forms)** — 1h window, NOT lifetime totals (labeled as such). For debugging state patterns.

**Template variable:** `$form` (multi-select, all forms by default) — filters all panels by form.

### Verification

Port-forward Grafana and check the dashboard loads:

```bash
# Unique port to avoid conflict
kubectl port-forward -n monitoring svc/prometheus-grafana 3001:80 & PF_PID=$!
sleep 2

# Get admin password
GRAFANA_PW=$(kubectl get secret -n monitoring prometheus-grafana -o jsonpath="{.data.admin-password}" | base64 --decode)

# Check dashboard exists
curl -u "admin:$GRAFANA_PW" http://localhost:3001/api/dashboards/uid/study-health | jq -r '.dashboard.title'

# Cleanup
kill $PF_PID 2>/dev/null
exit 0
```

Expected output: `"Study Health"`.

---

## 5. Deployment Checklist

### Pre-Deploy

- [x] PrometheusRule template written (`devops/alerts/templates/study-health.yaml`)
- [x] Values configured (`devops/alerts/values.yaml` under `studyHealth`)
- [x] Grafana dashboard JSON created (`devops/grafana-dashboards/study-health.json`)
- [x] Dashboard ConfigMap template created (`devops/grafana-dashboards/templates/study-health-cm.yaml`)
- [x] Documentation written (this file)
- [x] Alerting inventory updated (`documentation/alerting.md`)

### Deploy

```bash
# 1. Deploy the PrometheusRules
helm upgrade --install vlab-alerts devops/alerts --namespace monitoring

# 2. Deploy the Grafana dashboard
helm upgrade --install grafana-dashboards devops/grafana-dashboards --namespace monitoring

# 3. Verify rules loaded in Prometheus
kubectl port-forward -n monitoring svc/prometheus-kube-prometheus-prometheus 9092:9090 & PF_PID=$!
sleep 2
curl -s http://localhost:9092/api/v1/rules | jq '.data.groups[] | select(.name | contains("study-health"))'
kill $PF_PID 2>/dev/null
exit 0

# 4. Verify NO alerts are firing (metrics all ~0 now)
kubectl port-forward -n monitoring svc/prometheus-kube-prometheus-prometheus 9093:9090 & PF_PID=$!
sleep 2
curl -s http://localhost:9093/api/v1/alerts | jq '.data.alerts[] | select(.labels.component == "study-health")'
# Should be empty or all state=inactive
kill $PF_PID 2>/dev/null
exit 0

# 5. Verify dashboard loaded in Grafana
kubectl port-forward -n monitoring svc/prometheus-grafana 3002:80 & PF_PID=$!
sleep 2
GRAFANA_PW=$(kubectl get secret -n monitoring prometheus-grafana -o jsonpath="{.data.admin-password}" | base64 --decode)
curl -u "admin:$GRAFANA_PW" http://localhost:3002/api/dashboards/uid/study-health | jq -r '.dashboard.title'
kill $PF_PID 2>/dev/null
exit 0
```

### Post-Deploy

- [ ] All PromQL expressions parse (no errors in Prometheus logs)
- [ ] NO study-health alerts are firing (all metrics ~0 at current traffic)
- [ ] Dashboard loads and displays all panels
- [ ] Recording rule `survey:error_ratio:1h` is being evaluated
- [ ] Document the deploy in `#vlab-alerts` Slack (new alerts active, thresholds are v1)

---

## 6. Future Enhancements

### Short-term (as traffic grows)

- **Tune thresholds** based on observed traffic patterns. Current values are v1.
- **Add per-study alerting context:** Enrich alert annotations with study name, owner, and dashboard link (requires CockroachDB join in sql_exporter or a separate enrichment step).
- **Histogram metrics:** Replace gauge counts with histograms (error rate distribution over time) for better trend detection.

### Medium-term

- **Anomaly detection:** Use Prometheus recording rules + `predict_linear()` to detect error rate spikes relative to historical baseline, not just absolute thresholds.
- **Correlation with deploys:** Integrate with deploy events (annotations in Grafana) to correlate error spikes with releases.
- **User-facing status page:** Expose aggregated study health (green/yellow/red) to study owners in the dashboard (pull from Prometheus, not CockroachDB).

### Long-term

- **Lifetime state metrics:** Solve the query timeout issue (partitioning, materialized views, or a separate OLAP DB) to restore lifetime state totals alongside the 1h window metrics. Note lifetime totals over `states` are close to meaningless as a health signal (see below); the value would be historical trend analysis, not alerting.
- **Real-time alerting on critical errors:** Kafka stream processor (ksqlDB, Flink) to alert on INTERNAL errors in <1 min (Prometheus polling is 1m min).
- **Predictive alerting:** ML model to predict study degradation before users are impacted (error rate trending up, lag building, etc.).

---

## 7. Related Documentation

- **Metric source:** `sql_exporter` chart + queries deployed by sibling agent (not committed; check monitoring namespace for the ConfigMap).
- **Alerting inventory:** `documentation/alerting.md` — all alert sources, routing, and runbooks.
- **Monitoring stack:** `MONITORING_STACK.md` — Prometheus, AlertManager, Grafana overview.
- **Consumer-lag alerting:** `documentation/kafka-consumer-lag-alerting.md` — Kafka-specific alerts (separate from study health).
- **Study health skill:** `.opencode/skills/study-health/SKILL.md` — agent-invokable health check (queries Prometheus + AlertManager + CockroachDB).
