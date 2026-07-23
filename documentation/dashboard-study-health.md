# Dashboard Study Health

> Surfaces survey health (error / blocked / stuck / expired states) to **survey
> owners** in the dashboard's Monitor tab, complementing the **platform-owner**
> alerting in Prometheus/AlertManager → Slack.
>
> **Related:** `documentation/study-error-alerting.md` (taxonomy contract +
> platform alerts), `documentation/alerting.md` (alert inventory + routing),
> `dashboard-server/README.md` (API), `dashboard-client/README.md` (UI).

---

## 1. Two audiences, two threshold regimes, one taxonomy

- **Platform owner** is *interrupted* via AlertManager → Slack. Those rules are
  volume-gated ("dozens of users affected — worth reaching out to the study
  owner") and live in `devops/alerts/templates/study-health.yaml`. Unchanged
  by this feature.
- **Survey owner (researcher)** *looks* at the dashboard. The Monitor tab
  shows categorized issues at effectively **zero threshold for visibility**,
  with intentional rules deciding what rises to an *alarm* vs. a quiet *note*.
- The **shared primitive is the classification taxonomy** (see the "Taxonomy
  contract" section of `documentation/study-error-alerting.md`), NOT the
  alert rules. Both consumers apply their own thresholds on top of it.

## 2. Data sources (decision matrix)

| Concern | Source | Why |
|---|---|---|
| Health card aggregates, badge, drill-down (v1) | **CockroachDB direct** (24h window, auth-joined) | Right window semantics only expressible at source; card + drill-down list share one source so numbers always agree; zero new dependencies; auth is a join |
| Platform notices banner (v1) | **AlertManager proxy** (whitelisted alertnames) | Firing-state IS the semantic; thresholds mean the same for both audiences; avoids logic duplication/drift |
| Trend/spike signals, sparklines (v2, deferred) | **Prometheus** | Only source with history (sql_exporter snapshots aggregates every 1m — history accrues while we wait) |

Explicitly rejected: driving the researcher surface from AlertManager
thresholds (they protect the platform owner's attention — wrong for someone
already looking), and re-deriving study health from Prometheus gauges
(1h-window gauges cannot produce a 24h distinct-user count; drill-down
inconsistency; monitoring fate-sharing).

## 3. Two-plane architecture

- **Data plane (fixed, dumb):** one SQL aggregation over `states`
  (`healthSummary` in `dashboard-server/queries/states/states.queries.js`)
  producing rows that `buildAggregates`
  (`dashboard-server/api/health/aggregate.js`) folds into a bag of named
  aggregates + denominators. No judgment. Window: **24h** on
  `states.updated` (constant `HEALTH_WINDOW_HOURS` in the query module) —
  distinct from sql_exporter's 1h alerting window (alerting cares about
  "now"; the card covers "since I last looked"). The states table is
  current-state per user — sticky until the user recovers — so the window
  also ages out ancient testing noise.
- **Interpretation plane (declarative, editable):** a data-only ruleset
  (`dashboard-server/api/health/rules.js`) mapping conditions over the
  aggregate bag → `{level, message, action}` findings, evaluated by a pure
  engine (`api/health/evaluate.js`). Tuning "does 1/1000 matter" is a config
  edit, not a code change. Per-survey overrides can slot in later without
  rearchitecting.
- **Aggregate sources are pluggable:** rules reference aggregates by
  dot-path name; v1 fills the bag from SQL. A future
  `error.trend_vs_baseline` can come from a Prometheus query into the same
  bag. (Caveat for that future implementer: real spike/flow detection wants
  event *counters*; the sql_exporter metrics are 1h-window gauge snapshots,
  so `rate()` over them is semantically mushy.)

### Aggregate bag shape

```js
{
  window_hours: 24,
  active_users: 1043,            // all rows in window (denominator)
  error:   { platform: 0, study: 1, by_tag: { none: 1 } },
  blocked: { attrition: 5, template_missing: 2, rate_limit: 0, unsupported: 0, other: 0 },
  stuck_users: 0,
  expired_waits: 0,
  by_form: { "XYZ12": { /* same shape per form */ } }
}
```

## 4. Severity: a function of issue CLASS, not just count

- **Deterministic blockers** (machinery broken; every user on the path hits
  it): `blocked.template_missing`, `blocked.rate_limit`, `error.platform`
  (INTERNAL/STATE_ACTIONS/NETWORK tags). **Alarm (`action`) at count ≥ 1** —
  1-in-1000 here is not a 0.1% error rate; it's proof the door is locked.
- **Stochastic degradation** (distributed over the population):
  `error.study` (tag `none`/`FORM_NOT_FOUND`/unknown), `stuck_users`,
  `expired_waits`. **`action` on proportion (≥5%) + absolute floor (≥3);
  below that, a muted `note`.** 1-in-1000 must NOT light the badge.
- `blocked.attrition` (fb codes 10/190/551) is **never** a finding —
  expected churn. May appear as a neutral funnel stat later.
- Rules are implicitly grouped by metric; the highest matching level per
  metric wins (`action` > `note`), so spike rules supersede their trickle
  siblings. Thresholds are v1 proposals — revisit with real traffic.

Finding levels:

| Level | Rendering |
|---|---|
| `action` | amber; lights the Monitor tab badge and renders a banner; actionable copy + link |
| `note` | muted line in the Health card only — zero-threshold visibility without crying wolf |
| (healthy) | card explicitly renders "✓ No issues in the last 24h" (trust in silence must be earned) |

## 5. Endpoints (dashboard-server)

### `GET /surveys/:surveyName/health`

Scoped via `validateSurveyNameAccess` (reused from `api/states`). Pipeline:
`healthSummary` (SQL) → `buildAggregates` (pure) → `evaluate` (pure) →

```js
{ window_hours: 24, findings: [...], aggregates: {...} }
```

Findings arrive fully resolved (`{count}`/`{active}`/`{ratio}` templating is
server-side); the client renders strings verbatim and holds **no health
logic**. `aggregates` is included for debuggability and future client uses.
Unknown metric names in a rule are skipped with a `console.warn` (fail loud
in logs, soft in product).

### `GET /platform/notices`

Auth required, **no survey scoping** — platform alerts have no form label
and apply to everyone. Proxies `${ALERTMANAGER_URL}/api/v2/alerts?active=true`
(in-cluster: `http://alertmanager-operated.monitoring:9093`), filters to the
declarative whitelist + translation table `platformNotices` in
`api/health/rules.js` (unlisted alertnames — all infra — are dropped,
duplicates deduped), and returns:

```js
{ notices: [{ alertname, message, since }] }   // since = startsAt
```

**Fail-soft:** `ALERTMANAGER_URL` unset → `{ notices: [] }` (feature cleanly
off in dev); 2s timeout; any error → `{ notices: [] }` + log. Monitoring
being down must never break the researcher dashboard.

## 6. Presentation: three layers, silent by default (dashboard-client)

1. **Ambient badge** — amber dot on the Monitor tab label
   (`SurveyScreen.js`). Only `action` findings light it; `note`s and
   platform notices do not. Zero pixels when healthy.
2. **Banners inside the Monitor tab** (`HealthBanners` in
   `SurveyScreen.js`), above the sub-tabs, only when firing: blue `info`
   alerts for platform notices ("not caused by your configuration"); one
   amber `warning` alert for study `action` findings (collapsed to
   "N issues need attention — see Health below" when more than one).
3. **Health card** (`StatesExplorer/HealthCard.js`) at the top of
   Monitor → Summary — always present once loaded. Healthy: "✓ No issues in
   the last 24h". Otherwise `action` findings prominent, `note` findings
   muted, each with a link resolved by `destToUrl`
   (`StatesExplorer/healthNav.js`): `states-list` → the existing
   StatesList query-param convention; `message-templates` → the
   MessageTemplates route; unknown dest → message without link
   (forward-compat).

Data flow: `useSurveyHealth(surveyName)`
(`SurveyScreen/useSurveyHealth.js`) fetches both endpoints on mount and
polls every 60s; it lives at SurveyScreen level so the badge works without
entering the tab. `findings` is `null` until the first successful load (no
false "✓" flash); failed polls keep the last known state.

## 7. v2 doors (explicitly deferred)

- **Prometheus-backed trends/sparklines/baselines** — history accruing now;
  see the event-counters caveat in §3.
- **Push notifications to survey owners** — would reuse `evaluate` on a
  cron; not now.
- **Per-survey rule overrides** — ruleset structure supports it; no
  UI/storage now.
- **Cross-survey rollup badge** on the Surveys list — cheap later via the
  same endpoint.
- **Attrition/funnel stats** in the card.
- Changes to AlertManager routing or platform alert thresholds.
