# Dashboard Study Health — Implementation Plan

> Surface survey health (errors / blocked / stuck / expired states) to **survey
> owners** in the dashboard's Monitor tab, complementing the **platform-owner**
> alerting that already exists in Prometheus/AlertManager → Slack.
>
> Design discussion resolved 2026-07-22. Related docs:
> `documentation/study-error-alerting.md` (taxonomy + platform alerts),
> `documentation/alerting.md` (alert inventory + routing).

---

## 1. Agreed design decisions (context for implementers)

### Two audiences, two threshold regimes, one taxonomy

- **Platform owner (Nandan)** is *interrupted* via AlertManager → Slack. Rules
  are volume-gated ("dozens of users affected — worth reaching out to the study
  owner"). These already exist (`devops/alerts/templates/study-health.yaml`)
  and are **unchanged by this work**.
- **Survey owner (researcher)** *looks* at the dashboard. The Monitor tab shows
  categorized issues at effectively **zero threshold for visibility**, with
  intentional rules deciding what rises to an *alarm* vs. a quiet *note*.
- The **shared primitive is the classification taxonomy** (error_tag → platform
  vs. study; fb_error_code → attrition / template_missing / rate_limit / …),
  NOT the alert rules. Both consumers apply their own thresholds on top of it.

### Data sources (the decision matrix)

| Concern | Source | Why |
|---|---|---|
| Health card aggregates, badge, drill-down (v1) | **CockroachDB direct** (24h window, auth-joined) | Right window semantics only expressible at source; card + drill-down list share one source so numbers always agree; zero new dependencies/failure modes; auth is a join |
| Platform notices banner (v1) | **AlertManager proxy** (whitelisted alertnames) | Firing-state IS the semantic; thresholds mean the same for both audiences; avoids logic duplication/drift |
| Trend/spike signals, sparklines (v2, deferred) | **Prometheus** | Only source with history (sql_exporter has been snapshotting aggregates every 1m since deploy — history accrues while we wait). NOT in v1 |

Explicitly rejected: driving the researcher surface from AlertManager (its
thresholds protect the platform owner's attention, wrong for someone already
looking) and re-deriving study health from Prometheus gauges (1h-window gauges
cannot produce a 24h distinct-user count; drill-down inconsistency; monitoring
fate-sharing).

### Severity is a function of issue CLASS, not just count

- **Deterministic blockers** (machinery is broken; every user on the path will
  hit it): `template_missing`, `rate_limit`, platform error tags
  (INTERNAL/STATE_ACTIONS/NETWORK). **Alarm at count ≥ 1.** 1-in-1000 here is
  not a 0.1% error rate — it's proof the door is locked.
- **Stochastic degradation** (distributed over the population): generic study
  errors (tag `none`/`FORM_NOT_FOUND`), stuck users, expired waits. **Alarm on
  proportion + small absolute floor; below that, a muted "worth a look" note.**
  1-in-1000 must NOT light the badge.
- Three finding levels:
  - `action` — amber; lights the tab badge and renders a banner. Actionable copy + link.
  - `note` — muted line in the Health card only. Zero-threshold visibility without crying wolf.
  - (healthy) — card explicitly renders "✓ No issues in the last 24h" (trust in silence must be earned).
- `attrition` category (fb codes 10/190/551) is **never** a finding — expected
  churn. May appear as a neutral funnel stat later; not in v1 findings.

### Two-plane architecture (the "declarative" requirement)

- **Data plane (fixed, dumb):** one SQL aggregation over `states` producing a
  bag of named aggregates + denominators. No judgment.
- **Interpretation plane (declarative, editable):** a versioned, data-only
  ruleset in dashboard-server mapping conditions over the aggregate bag →
  `{level, message, action}` findings. Tuning "does 1/1000 matter" is a config
  edit, not a code change. Per-survey overrides slot in later without
  rearchitecting.
- **Aggregate sources are pluggable:** rules reference aggregates by name; v1
  fills the bag from SQL. A future `error.trend_vs_baseline` can come from a
  Prometheus query into the same bag. (Caveat for that future implementer:
  real spike/flow detection wants event *counters*, not the current 1h-window
  gauges — the sql_exporter metrics are snapshots, so `rate()` over them is
  semantically mushy.)

### Presentation: three layers, silent by default

1. **Ambient badge** — dot on the Monitor tab label. Absent when healthy;
   amber when any `action` finding. Zero pixels when fine.
2. **Banners inside Monitor tab, only when firing** — amber "action needed"
   (study-scoped findings, actionable link) and blue/grey "platform notice"
   ("elevated errors platform-wide — not caused by your configuration").
3. **Health card** on Monitor → Summary — always present. "✓ No issues in the
   last 24h" when green; otherwise the findings list (`action` prominent,
   `note` muted), each with count/ratio and a link to the filtered
   respondents list.

---

## 2. Taxonomy contract (mirrored from sql_exporter — keep in sync)

Canonical source today: `devops/sql-exporter/templates/configmap.yaml`. This
plan adds the dashboard as a second consumer. **A doc step below promotes this
to an explicit contract section in `documentation/study-error-alerting.md`;
both consumers must cite it.**

| Dimension | Mapping | Class |
|---|---|---|
| `error_tag` IN (INTERNAL, STATE_ACTIONS, NETWORK) | `error.platform` | deterministic (platform's fault — show as platform-style notice, not researcher blame) |
| `error_tag` = FORM_NOT_FOUND or NULL (`none`) | `error.study` | stochastic |
| `fb_error_code` IN (10, 190, 551) | `blocked.attrition` | excluded (expected churn) |
| `fb_error_code` = 100 | `blocked.template_missing` | deterministic |
| `fb_error_code` = 2022 | `blocked.rate_limit` | deterministic (platform-side) |
| `fb_error_code` = 200 | `blocked.unsupported` | stochastic |
| other `fb_error_code` | `blocked.other` | stochastic |
| `stuck_on_question IS NOT NULL` | `stuck_users` | stochastic |
| `current_state = 'WAIT_EXTERNAL_EVENT' AND timeout_date < NOW()` | `expired_waits` | stochastic |
| all rows in window | `active_users` | denominator |

Window: **24h** (`states.updated > NOW() - INTERVAL '24 hours'`) — distinct
from sql_exporter's 1h window (alerting cares about "now"; the card covers
"since I last looked"). Window is a constant in the query module, trivially
configurable.

Note: the states table is *current-state per user* — sticky until the user
recovers, gone once they do. The 24h `updated` filter scopes the card to
"now-ish" and ages out ancient testing noise, per design discussion.

---

## 3. Backend (dashboard-server)

Follow existing patterns: routes → controller → `queries/` module bound to the
pool. Functional core: rule evaluation is a pure function; SQL/HTTP at edges.

### 3.1 Health aggregates query — `queries/states/states.queries.js`

Add `healthSummary(email, surveyName, shortcodes)`:

- **Reuse `SCOPE_SQL`** (shortcode pre-filter + pageid ownership check +
  scalar-subquery version resolution — do NOT reinvent scoping) plus
  `AND states.updated > NOW() - INTERVAL '24 hours'`.
- One grouped query returning per-form rows with the taxonomy applied
  (CASE expressions copied from the contract above; column names per this
  table: `current_state`, `error_tag`, `fb_error_code`, `stuck_on_question`,
  `timeout_date`, `updated`):

```sql
SELECT
  states.current_form AS form,
  states.current_state AS state,
  COALESCE(states.error_tag, 'none') AS error_tag,
  CASE
    WHEN states.fb_error_code IN ('10','190','551') THEN 'attrition'
    WHEN states.fb_error_code = '100'  THEN 'template_missing'
    WHEN states.fb_error_code = '2022' THEN 'rate_limit'
    WHEN states.fb_error_code = '200'  THEN 'unsupported'
    ELSE 'other'
  END AS fb_category,
  COUNT(*) FILTER (WHERE states.stuck_on_question IS NOT NULL)::int AS stuck,
  COUNT(*) FILTER (WHERE states.current_state = 'WAIT_EXTERNAL_EVENT'
                     AND states.timeout_date < NOW())::int AS expired,
  COUNT(*)::int AS count
${SCOPE_SQL}
  AND states.updated > NOW() - INTERVAL '24 hours'
GROUP BY 1, 2, 3, 4
```

  (Exact shape may be adjusted at implementation — e.g. separate simple
  queries are fine if clearer; requirement is: one round-trip preferred,
  correct distinct-user counting, taxonomy per contract.)

- A pure helper `buildAggregates(rows)` folds rows into the aggregate bag:

```js
{
  window_hours: 24,
  active_users: 1043,            // all rows in window
  error:   { platform: 0, study: 1, by_tag: { none: 1 } },
  blocked: { attrition: 5, template_missing: 2, rate_limit: 0, unsupported: 0, other: 0 },
  stuck_users: 0,
  expired_waits: 0,
  by_form: { "XYZ12": { /* same shape, per form — for copy like "in form XYZ12" */ } }
}
```

### 3.2 Declarative ruleset — `api/health/rules.js`

Data-only module (no functions in rule objects — keeps it declarative,
serializable, and per-survey-overridable later):

```js
module.exports.rules = [
  // ---- deterministic blockers: existence == broken -------------------
  { id: 'template-missing',
    when:   { metric: 'blocked.template_missing', count_gte: 1 },
    level:  'action',
    message: '{count} respondent(s) blocked: your Facebook message template appears to be missing or unapproved.',
    action: { label: 'Check message templates', dest: 'message-templates' } },

  { id: 'rate-limited',
    when:   { metric: 'blocked.rate_limit', count_gte: 1 },
    level:  'action',
    message: '{count} respondent(s) blocked by Facebook rate limits. This is a platform-side issue; delivery resumes automatically when the limit lifts.',
    action: { label: 'View affected respondents', dest: 'states-list', filter: { state: 'BLOCKED' } } },

  { id: 'platform-errors',
    when:   { metric: 'error.platform', count_gte: 1 },
    level:  'action',
    message: '{count} respondent(s) hit platform errors (not caused by your survey configuration). The platform team is notified automatically.',
    action: { label: 'View affected respondents', dest: 'states-list', filter: { state: 'ERROR' } } },

  // ---- stochastic degradation: proportion + floor --------------------
  { id: 'error-spike',
    when:   { metric: 'error.study', ratio_gte: 0.05, count_gte: 3 },
    level:  'action',
    message: '{count} of {active} respondents ({ratio}) hit errors in the last 24h — this may indicate a form configuration problem.',
    action: { label: 'View affected respondents', dest: 'states-list', filter: { state: 'ERROR' } } },

  { id: 'error-trickle',
    when:   { metric: 'error.study', count_gte: 1 },
    level:  'note',
    message: '{count} respondent(s) hit an error ({ratio}).',
    action: { label: 'View', dest: 'states-list', filter: { state: 'ERROR' } } },

  { id: 'stuck-spike',
    when:   { metric: 'stuck_users', ratio_gte: 0.05, count_gte: 3 },
    level:  'action',
    message: '{count} respondents appear stuck on a question — possibly a validation loop or confusing wording.',
    action: { label: 'View stuck respondents', dest: 'states-list', filter: {} } },

  { id: 'stuck-trickle',
    when:   { metric: 'stuck_users', count_gte: 1 },
    level:  'note',
    message: '{count} respondent(s) stuck on a question.',
    action: { label: 'View', dest: 'states-list', filter: {} } },

  { id: 'expired-waits',
    when:   { metric: 'expired_waits', count_gte: 1 },
    level:  'note',
    message: '{count} respondent(s) waiting on an external event past its timeout.',
    action: { label: 'View', dest: 'states-list', filter: { state: 'WAIT_EXTERNAL_EVENT' } } },
];
```

`ratio` = `count / max(active_users, 1)`. Rules are grouped implicitly by
`metric`: evaluate all, keep the **highest level that matched per metric**
(`action` > `note`), so `error-spike` supersedes `error-trickle`. Findings
sorted `action` first.

v1 thresholds above are proposals — same spirit as the alert values ("v1,
will need tuning"); revisit after seeing real traffic.

### 3.3 Rule engine — `api/health/evaluate.js` (pure)

`evaluate(aggregates, rules) -> findings[]`. No IO, no Date, no config reads —
takes the bag and the ruleset, returns:

```js
[ { id, level, message, count, ratio, active, action: { label, dest, filter } } ]
```

Message templating (`{count}`, `{active}`, `{ratio}` as percent) resolved
server-side; client renders strings verbatim (no health logic in client).
Unknown `metric` in a rule → skip + `console.warn` (fail loud in logs, soft in
product).

### 3.4 Endpoint — `GET /surveys/:surveyName/health`

New `api/health/` (routes/controller/index following `api/states/` shape),
mounted alongside states routes and **reusing `validateSurveyNameAccess`**
middleware (export it or lift it to shared middleware). Controller:
`healthSummary` → `buildAggregates` → `evaluate` →

```js
{ window_hours: 24, findings: [...], aggregates: {...} }
```

(Aggregates included for debuggability and future client uses.)

### 3.5 Platform notices proxy — `GET /platform/notices`

- Auth required (same auth middleware as everything else), **no survey
  scoping** — platform alerts have no form label and apply to everyone.
- Fetches `${ALERTMANAGER_URL}/api/v2/alerts?active=true` (in-cluster:
  `http://alertmanager-operated.monitoring:9093`). New env var in chart
  values + `.env-dev`; **unset → endpoint returns `{ notices: [] }`** (feature
  cleanly off in dev / if monitoring moves).
- Filter to a declarative whitelist + translation table (same `rules.js` file):

```js
module.exports.platformNotices = {
  PlatformInternalErrors:     'The platform is currently experiencing elevated internal errors. Your survey may be affected; this is not caused by your configuration.',
  PlatformRateLimited:        'Facebook is currently rate-limiting the platform. Message delivery may be delayed across surveys.',
  MultiSurveyErrorRegression: 'The platform is currently experiencing elevated errors across multiple surveys. The team has been alerted.',
  DeanExpiredWaits:           'Scheduled/externally-triggered messages are currently delayed platform-wide.',
};
```

- Unlisted alertnames (all infra) are dropped. Response:
  `{ notices: [{ alertname, message, since }] }` (`since` = `startsAt`).
- **Fail-soft:** 2s timeout; on any error return `{ notices: [] }` and log.
  Monitoring being down must never break the researcher dashboard.

### 3.6 Backend tests

- `evaluate.js`: pure-function unit tests — deterministic count=1 fires
  `action`; stochastic 1/1000 yields `note` not `action`; spike supersedes
  trickle; attrition produces nothing; empty bag → no findings.
- `buildAggregates`: row-folding cases incl. NULL error_tag, unknown fb codes.
- `states.test.js` pattern for `healthSummary`: scoping respected (other
  owner's states invisible), 24h window excludes old rows, taxonomy CASE
  correct per contract.
- Notices proxy: whitelist filtering; AlertManager unreachable → `[]`.

---

## 4. Frontend (dashboard-client)

All rendering is dumb: findings/notices arrive fully resolved; the client maps
`level` → style and `action.dest` → URL. No thresholds, no taxonomy.

### 4.1 API + polling

- `useSurveyHealth(surveyName)` hook: fetch
  `/surveys/:surveyName/health` + `/platform/notices` on mount, poll every 60s
  while mounted. Lives at `SurveyScreen` level so the tab badge works without
  entering the tab.

### 4.2 Ambient badge (Layer 1)

- Monitor tab label in `SurveyScreen` tabs gets an antd `<Badge dot>` (amber)
  when any finding has `level === 'action'`. Nothing otherwise. `note`-only
  and platform notices do NOT light the badge.

### 4.3 HealthCard (Layer 3) — `containers/StatesExplorer/HealthCard.js`

- Rendered at top of `StatesSummary` (above the Statistic card).
- Healthy: single-line card, "✓ No issues in the last 24h", subtle.
- Otherwise: `action` findings as prominent list items (amber icon, message,
  action button/link); `note` findings as muted secondary lines below.
- `action.dest` mapping:
  - `states-list` → `${match.url}/list?…` from `filter` (existing
    query-param convention in `StatesSummary`/`StatesList` — reuse exactly).
  - `message-templates` → the MessageTemplates container route.
  - Unknown dest → render message without link (forward-compat).

### 4.4 Banners (Layer 2)

- Inside `MonitorSection`, above the sub-tabs:
  - Platform notices → antd `<Alert type="info">` (blue/grey, calm copy from
    server, `showIcon`, not dismissible — disappears when resolved).
  - Study `action` findings → antd `<Alert type="warning">`; if >1, a single
    banner "N issues need attention — see Health below" rather than stacking.
- Nothing renders when arrays are empty (silent by default).

### 4.5 Frontend tests

- HealthCard: healthy state, action+note mix, dest→URL mapping, unknown dest.
- Badge logic: only `action` lights it.

---

## 5. Documentation step (per CLAUDE.md, separate from implementation)

1. **New:** `documentation/dashboard-study-health.md` — the two-audience /
   two-plane design, decision matrix (CRDB vs Prometheus vs AlertManager),
   endpoint shapes, ruleset semantics, presentation layers, v2 doors
   (Prometheus trend source, per-survey overrides, researcher notifications —
   and the event-counters caveat for spike detection).
2. **Update:** `documentation/study-error-alerting.md` — promote the taxonomy
   to an explicit "Taxonomy contract" section; list both consumers
   (sql_exporter ConfigMap + `dashboard-server/api/health/`) with a keep-in-
   sync warning both files cross-reference in comments.
3. **Update:** `dashboard-server/README.md` (health API, `ALERTMANAGER_URL`),
   `dashboard-client/README.md` (Monitor tab health surface).
4. **Update:** `documentation/alerting.md` §7-adjacent: note the dashboard as
   a second, lower-threshold consumer of study-health signals.

---

## 6. Sequencing (worktree: `../fly-dashboard-health`, branch `feature/dashboard-study-health`)

| # | Step | Verify |
|---|---|---|
| 1 | Pure core: `rules.js`, `evaluate.js`, `buildAggregates` + unit tests | `npm test` green |
| 2 | `healthSummary` query + `EXPLAIN` against a real survey (check the `(current_state, current_form, …)` index usage with the 24h filter; if slow, add 30–60s in-memory cache per survey — safety valve, only if needed) | query <1s on prod-sized data |
| 3 | `/surveys/:surveyName/health` endpoint + tests | curl via dev setup |
| 4 | `/platform/notices` proxy + env plumbing (chart values, `.env-dev`) + tests | with/without `ALERTMANAGER_URL` |
| 5 | Client: hook + HealthCard + badge + banners + tests | local dev against dev server |
| 6 | Documentation pass (§5) | — |
| 7 | Deploy: dashboard-server image bump + helm values; client via Netlify (`/netlify-check`) | staging first; confirm healthy survey shows "✓", inject a test error state in staging → card/badge/banner light correctly |

## 7. Out of scope (explicit, agreed)

- Prometheus-backed trends/sparklines/baselines (v2; history accruing now).
- Push notifications to survey owners (email/etc.) — would reuse `evaluate`
  on a cron; not now.
- Per-survey rule overrides (structure supports it; no UI/storage now).
- Changes to AlertManager routing or the platform alert thresholds (framed as
  "reach-out triggers"; tune later as traffic grows).
- Cross-survey rollup badge on the Surveys list (cheap later via the same
  endpoint; decide after v1 lands).
- Attrition/funnel stats in the card.
