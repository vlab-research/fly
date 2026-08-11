# Alerting — inventory & runbooks

> Every alert we rely on, where it's defined (all version-controlled), and what
> to do when it fires. AlertManager routes everything to Slack `#vlab-alerts`.
>
> **Related:** `MONITORING_STACK.md` (stack overview),
> `documentation/kafka-consumer-lag-alerting.md` (consumer-lag alerts + runbook).

---

## 1. Where alerts are defined (all in Git)

The monitoring stack (Prometheus/AlertManager/Grafana) is a **singleton** in the
`monitoring` namespace, shared by prod and staging. Prometheus watches
PrometheusRules in **all** namespaces (`ruleSelector: {}`,
`ruleNamespaceSelector: {}`), so hand-authored rules live in the `monitoring`
namespace and are versioned as Helm charts.

| Source (repo path) | Release / how applied | Alerts |
|---|---|---|
| **`devops/alerts/`** | Helm `vlab-alerts` (monitoring) | Kafka **broker health** + **app health** + **study health** (this doc) |
| **`devops/kafka-consumer-health/`** | Helm `kafka-consumer-health` (monitoring) | Kafka **consumer-lag** — see the dedicated doc |
| `devops/kminion/` | Helm `kminion` (default) | *(metrics source for consumer-lag; no alerts)* |
| `devops/sql-exporter/` | Helm `sql-exporter` (monitoring) | *(metrics source for study health; no alerts)* |
| `devops/vlab/charts/redis/templates/prometheusrule.yaml` | vlab umbrella (`gbv`) | Redis health (subchart) |
| `devops/prometheus/values.yaml` → `defaultRules` | kube-prometheus-stack | Kubernetes/node/Prometheus infra alerts (`Kube*`, `Node*`, `Watchdog`, …) |

**Retired:** the banzaicloud koperator default `kafka-alerts` (was
`devops/kafka-operator/prod/kafka-prometheus.yaml`) — stale static thresholds
that fired permanently; replaced by `devops/alerts/kafka-broker-health.yaml`.
The static `prometheus/rules/lag.yaml` (superseded by kafka-consumer-health) and
`prometheus/rules/replybot.yaml` (migrated here) were deleted.

### Editing / adding alerts

Edit the chart values or templates and re-run its `helm upgrade`:

```bash
helm upgrade --install vlab-alerts devops/alerts --namespace monitoring
```

Thresholds live in `devops/alerts/values.yaml`. To delete a rule, remove it from
the template (or gate it behind a value) and upgrade. Everything is ours to
change — no orphaned operator defaults.

---

## 2. AlertManager routing

**Status: LIVE.** `devops/alertmanager/alertmanager.yaml` is the deployed config.
Apply changes with `devops/alertmanager/apply.sh` (injects the webhooks from the
gitignored `secret.env`, validates with `amtool`, writes the `alertmanager` secret;
the operator regenerates the mounted config and AlertManager hot-reloads within
~1m — **no `helm upgrade` needed**).

PagerDuty, email/FYI routing and the dead-man's switch were **designed but never
built** — there is no paging vendor and no heartbeat monitor. Phone paging is
handled by **ntfy** instead (§8), attached to the `slack-critical` receiver.

### Routing model

```
All Alerts
    │
    ├─ Watchdog ────────────────────────────► null   (no dead-man's switch yet)
    ├─ InfoInhibitor ───────────────────────► null   (plumbing, not an alert)
    ├─ KubeJobFailed / KubeJobNotCompleted ─► null   (replaced by §6 cronjob rules)
    │
    ├─ severity=critical ───────┬───────────► slack-critical (#vlab-alerts-critical)
    │                           └───────────► ntfy phone push (priority 4)
    │
    └─ everything else ─────────────────────► slack-warning (#vlab-alerts)
```

Group by `alertname`; `group_wait` 30s, `group_interval` 5m, `repeat_interval` 12h
(4h for criticals). `send_resolved: true` everywhere — **every episode is two
messages**, which is what makes a flapping alert so expensive.

Note the default receiver is a catch-all: anything without `severity=critical`
lands in `#vlab-alerts`, **including `severity=info` and `severity=none`**. That
is why the inhibit rules below are load-bearing rather than cosmetic.

### Inhibition rules

The three stock kube-prometheus-stack rules, plus the `InfoInhibitor` null route:

| Source | Mutes | Keyed on |
|---|---|---|
| `severity=critical` | `severity=warning\|info` | `namespace`, `alertname` |
| `severity=warning` | `severity=info` | `namespace`, `alertname` |
| `alertname=InfoInhibitor` | `severity=info` | `namespace` |

> ⚠️ **Restored 2026-08-04 after being silently lost.** This config replaced the
> operator-generated default *wholesale*, which dropped all `inhibit_rules` and the
> `InfoInhibitor` null route. `InfoInhibitor` is plumbing — it exists only so the
> third rule has a source to key on — but with `severity=none` it fell through the
> catch-all and posted to Slack; and with the third rule gone, chronic `info` alerts
> were never muted. Between them they produced **251 of the 310 firing episodes (81%)
> in the 4 days to 2026-08-04**. If you ever regenerate this file from scratch, carry
> the inhibit rules over.

`severity=info` is deliberately **not** null-routed outright. The third rule's design
is that an info alert *does* surface when a warning/critical is firing in the same
namespace — that is precisely when `InfoInhibitor` stops firing, and precisely when
the info alert has diagnostic value. Muting info unconditionally discards that.

**Rollback:** `apply.sh` writes `alertmanager.live-backup.yaml` (gitignored, contains
real webhooks) before each apply; the restore command is printed on success.

---

## 3. Kafka broker health — runbooks

Defined in `devops/alerts/templates/kafka-broker-health.yaml`. These fire only
when the cluster is **actually** unhealthy (unlike the retired koperator
defaults). Metrics come from the koperator JMX ServiceMonitors in
`devops/kafka-operator/prod/kafka-prometheus.yaml`.

### KafkaOfflinePartitions
`max(kafka_controller_kafkacontroller_offlinepartitionscount) > 0` — **critical**.
One or more partitions have no leader → produce/consume on them fails.
1. `kubectl -n default get pods -l app=kafka` — is a broker down/NotReady?
2. Check broker logs and disk (see disk alert). A dead broker or full disk is the
   usual cause.
3. Check the controller: `KafkaControllerCountAbnormal`. If a broker is
   recoverable, restart it; leadership should re-elect and partitions come online.
4. CruiseControl (`kafka-cruisecontrol` in `default`) can rebalance once brokers
   are healthy.

### KafkaControllerCountAbnormal
`sum(activecontrollercount) != 1` — **critical**. Should be exactly 1 controller.
- **0** = no controller electing leaders (often a ZooKeeper/KRaft or network
  issue). Check ZooKeeper pods and broker↔ZK connectivity.
- **>1** = split brain. Check for a network partition between brokers.
- `kubectl -n default get pods` for kafka + zookeeper; restart the misbehaving
  broker if needed.

### KafkaUnderReplicatedPartitions
`max(underreplicatedpartitions) > 0` for 15m — **warning**. ISR below replication
factor for a sustained time (transient during rolling restarts is normal).
1. Identify the lagging broker; check its CPU/disk/network.
2. Sustained under-replication risks data loss if another broker fails — treat as
   urgent if it persists or climbs.
3. Once the broker catches up, ISR recovers automatically.

### KafkaBrokerDiskSpace
`KafkaBrokerDiskSpaceLow` (< 20% free, **warning**) / `KafkaBrokerDiskSpaceCritical`
(< 10% free, **critical**). A full Kafka log dir takes the broker offline.
1. `kubectl -n default get pvc | grep kafka` — which volume.
2. Expand the PVC (storageClass `pd-ssd` supports online resize) **or** reduce
   topic `retention.ms` (see `kafkaTopics` in `devops/values/*.yaml`).
3. Don't let it hit 0 — that causes `KafkaOfflinePartitions`.

---

## 4. Study health — runbooks

Defined in `devops/alerts/templates/study-health.yaml`. Metrics from sql_exporter
(CockroachDB survey states, 1h window). Full design doc + runbooks:
`documentation/study-error-alerting.md`.

These alerts detect study misconfiguration, platform regressions, and UX issues by
analyzing error, blocked, stuck, and expired states across surveys.

> ⚠️ **All thresholds are stale by roughly 20×.** They were tuned against ~8 active
> users/hr across 5 forms. Measured 2026-07-26: **~156/hr across 11 shortcodes**, 2,951
> distinct users/24h. Recalibration is outstanding work — see
> `planning/core-visibility-alerting-plan.md` W5.

**Changed 2026-07-26 — two things that affect what these rules see:**

- **The `"(none)"` form sentinel.** States with no `current_form` used to be dropped by
  the exporter, hiding **55%** of platform-fault errors from `PlatformInternalErrors`.
  They are now exported. Per-form rules exclude the sentinel via `studyHealth.nullForm`;
  **`PlatformInternalErrors`, `PlatformRateLimited` and `DeanExpiredWaits` deliberately
  do not** — that inclusion is the fix, and adding a guard there would restore the bug.
- **Four new recording rules** (group `vlab-study-health-recordings`, no alert reads
  them): `survey:error_ratio:fleet:1h`, `survey:error_ratio_excess:1h`,
  `survey:erroring_studies:platform:1h`, `survey:erroring_studies:study_side:1h`. They
  back the Study Health triage table. `> 0` guards and `or vector(0)` are load-bearing —
  see `study-error-alerting.md`.

### ProviderErrors
`sum by (page) (survey_blocked_states{category=~"provider_error|provider_unreachable"}) >= 10`
for 30m — **critical**. The messaging channel is failing users on a specific page: either
Meta returning its own internal error (code `-1`) or the platform never reaching Meta at
all (code `(none)`/`0`, typically a missing page access token).

Scoped `by (page)`, not by form — a provider failure hits every form on that page, so a
form-scoped rule fires N times and reads as N unrelated study problems instead of one
channel outage.

This whole class was **silent until 2026-07-26**: both categories fell into `other`, which
no rule has ever referenced. **Read the `code` label first** — `provider_error` is
transient and dean retries it; `provider_unreachable` is *not retryable* and leaves users
blocked permanently. See
`documentation/study-error-alerting.md#providererrors`.

**Second, lower-threshold consumer:** the dashboard's Monitor tab surfaces
the same study-health signals to **survey owners** at effectively zero
threshold (quiet notes) with its own alarm rules, via a direct CockroachDB
query (24h window) — it does not read these alert rules. It shares only the
classification taxonomy (see the "Taxonomy contract" section of
`documentation/study-error-alerting.md`). The dashboard additionally proxies
a whitelist of the alerts on this page (`ProviderErrors`,
`PlatformInternalErrorsSevere`, `PlatformRateLimited`,
`MultiSurveyErrorRegression`, `DeanExpiredWaits`) as in-product platform
notices via `GET /platform/notices`. Full design:
`documentation/dashboard-study-health.md`.

> ⚠️ **A paging threshold is not a notice threshold.** Whitelisting an alert
> there shows it to every survey owner, and their only available response is to
> stop their surveys. Paging thresholds are deliberately low noise gates for an
> on-call who can triage; reused as notices they cry wolf. `PlatformInternalErrors`
> is whitelisted **only** in its `Severe` variant for exactly this reason (see
> below). When the two audiences need different bars, add a second alert rule —
> the notice is driven by firing state, so that is the only way to express it.

### PlatformInternalErrors
`sum(survey_error_states{error_tag=~"INTERNAL|STATE_ACTIONS|NETWORK"}) >= 15` for
30m — **critical**. Platform bugs (DB failures, state machine errors, network
issues). See `documentation/study-error-alerting.md#platforminternalerrors`.

**Not researcher-facing** — see the Severe variant below.

> **Retuned 2026-08-04 (was `>= 5` for 10m).** At 5 this was not a low noise gate,
> it was a coin flip: over the 4 days to 2026-08-04 the signal's **median was 4 and
> its max 8**, so the threshold sat *inside* the background band and the alert
> flapped across it — **21 firing episodes in 4 days**, i.e. ~5 phone pushes a day,
> none a live fault. The background is the known lost-`md` stuck population Dean
> re-emits every 30m, not a regression. 15 clears the observed max with headroom
> while staying under the Severe variant's 25, so the on-call is still paged well
> before any researcher sees a banner. The 30m `for:` does equal work — it stops a
> threshold crossing becoming a page when the count wobbles back on the next
> evaluation.

### PlatformInternalErrorsSevere
Same signal, gated for the **researcher** audience: `>= 25` affected users AND
`>= 25%` of active users AND `>= 50` active users, for 30m — **info** (does not
page; the on-call is already paged by `PlatformInternalErrors`). Its only
consumer is the dashboard's platform-notices banner.

Added 2026-07-30. The paging threshold of 5 sits *inside* the measured 1–6
background, which is essentially all the lost-`md` stuck population rather than a
live fault — so `PlatformInternalErrors` flapped through **4 firing episodes in
the 4 days to 2026-07-30**, each one banner-ing every researcher. Both extra
gates are load-bearing: active users swing 13 → 1107 across a day while the error
count stays flat, so a ratio with no volume floor fires at a quiet hour on 6 stuck
users, and a floor with no ratio ignores traffic entirely. Verified not to fire at
any point in the available history. See
`documentation/study-error-alerting.md#platforminternalerrorssevere`.

### PlatformRateLimited
`sum(survey_blocked_states{category="rate_limit"}) >= 10` for 10m — **critical**.
Facebook rate-limiting the platform (code 2022). We're hitting Meta API limits. See
`documentation/study-error-alerting.md#platformratelimited`.

### SurveyTemplateMissing
`sum by (form)(survey_blocked_states{category="template_missing"}) >= 5` for 15m —
**warning**. A study's Meta template is missing/unapproved (code 100). Study config
issue, ticket to that study. See
`documentation/study-error-alerting.md#surveytemplatemissing`.

### SurveyErrorSpike
Single study with >50% error ratio + volume gate (≥10 active users, ≥5 errors) for
15m — **warning**. Study-level issue (bad form, broken logic). Excludes form 305
(fallback). See `documentation/study-error-alerting.md#surveyerrorspike`.

### MultiSurveyErrorRegression
≥3 active surveys erroring at once (>30% error rate each, ≥10 active users per
form) for 10m — **critical**. Multi-survey pattern = platform regression, not study
issues. Excludes form 305. See
`documentation/study-error-alerting.md#multisurveyerrorregression`.

### SurveyStuckUsersSpike
`survey_stuck_users >= 10` for 20m — **warning**. Users stuck on a question
(validation loop / confusing form). Study UX issue, ticket. Excludes form 305
(fallback) and the `"(none)"` sentinel. See
`documentation/study-error-alerting.md#surveystuckusersspike`.

> **Fallback-form exclusion added 2026-08-04.** This rule excluded the `"(none)"`
> sentinel but not form 305, unlike every other per-form rule here. 305 holds users
> who never resolved to a real form, so they are "stuck" permanently and by design
> and there is no study to ticket — it was the noisiest study alert we had (13
> episodes / 29h firing in 4 days, **all** of it form 305).

### DeanExpiredWaits
`sum(survey_expired_waits) >= 10` for 15m — **warning**. WAIT_EXTERNAL_EVENT past
timeout. Dean (external event processor) not clearing timeouts. Platform issue. See
`documentation/study-error-alerting.md#deanexpiredwaits`.

---

## 5. Application health — runbooks

Defined in `devops/alerts/templates/app-health.yaml`.

### ReplyBotCrashing
`delta(kube_pod_container_status_restarts_total{container="replybot"}[10m]) > 2`
for 1m — **warning**. A replybot container is crash-looping; users' messages are
dropped/delayed while it restarts. The `namespace` label shows prod (`vprod`) vs
staging (`vstag`).
1. `kubectl -n <vprod|vstag> get pods -l app.kubernetes.io/name=replybot`
2. `kubectl -n <ns> logs <pod> --previous --tail=200` — why it exited (OOM? bad
   config? dependency down — CockroachDB / Redis / formcentral / Facebook Graph?).
3. Check recent deploys (`helm history gbv -n <ns>`); roll back if a bad image.
4. If OOM, bump `replybot.resources` in the values file.

---

## 6. CronJob health — runbooks

Defined in `devops/alerts/templates/cronjob-health.yaml`. Thresholds in
`devops/alerts/values.yaml` (`cronjob:`).

**Philosophy:** a single failed cronjob run is expected noise and is **not**
alerted on. The kube-prometheus-stack default `KubeJobFailed` (fires on *any*
failed Job object, and lingers until that object is deleted — that's how failed
jobs sat firing for 79 days) and `KubeJobNotCompleted` are **null-routed in
AlertManager**. We alert only on *repeated* failure, via two complementary rules
keyed on `kube_job_owner` (Job → owning CronJob) and the cronjob status metrics.
Both are **warning** → `#vlab-alerts`, and the `namespace` label shows prod
(`vprod`) vs staging (`vstag`).

### CronJobRepeatedlyFailing
`>= 3` distinct failed runs of one cronjob within a rolling `6h` window (Rule A).
Uses `max_over_time(kube_job_failed{condition="true"}[6h])`, so it counts from
Prometheus history and **still works after `ttlSecondsAfterFinished` deletes the
Job object**. Covers frequent crons (sub-hourly … hourly). One or two transient
failures never trip it.
1. `kubectl -n <ns> get jobs | grep <cronjob-name>` — see the recent runs.
2. `kubectl -n <ns> logs job/<most-recent-failed-job> --tail=200` — root cause.
3. Fix the underlying issue (dependency down, bad image, auth/creds, upstream API).
4. The alert self-resolves once the window rolls past the failures (≤ 6h) or the
   cron starts succeeding.

### CronJobNotSucceeding
`(now - last_successful_time) > 50h` **AND** `(now - last_schedule_time) < 26h`
(Rule B). Absolute-time, **not** period-relative — KSM's `next_schedule_time`
gives unreliable periods for daily/seasonal crons. The 50h floor means a single
missed daily run can't trip it (only ~2+ consecutive misses can); the 26h
schedule-recency gate **excludes seasonal / yearly crons** (e.g. the `bailer-*`
crons, whose last schedule is months ago). Covers slow (daily) crons that Rule
A's 6h window can't see.
1. `kubectl -n <ns> get cronjob <name>` — confirm `LAST SCHEDULE`; it *is* running.
2. `kubectl -n <ns> get jobs | grep <name>` then `logs job/<latest>` — why no success.
3. Self-resolves on the next successful run.

> Not covered by design: crons scheduled less often than daily (weekly+) are
> excluded by the 26h gate to keep seasonal crons quiet. If a weekly cron needs
> coverage later, widen `activeWithinHours` carefully (re-check it doesn't
> re-admit the seasonal `bailer-*` crons).

---

## 7. Agent-checkable monitoring

The `/study-health` skill provides an end-to-end health check that agents can invoke to assess platform + study health. It queries Prometheus, AlertManager, and CockroachDB and returns a structured JSON verdict identifying:

- **Broker health:** offline partitions, controller count, under-replication, disk free %.
- **Consumer lag:** drain time per group/topic vs. SLO.
- **Error anomalies:** ERROR/BLOCKED state spikes in CockroachDB, per survey + study owner.
- **Synthetic diagnosis:** ≥3 surveys spiking = platform regression; 1–2 = study-level issue.
- **Firing alerts:** currently-active Kafka/app alerts from AlertManager.
- **Overall verdict:** green/degraded/critical + actionable next steps.

**Invoke with:** `/study-health` (an agent will run the helper script and report findings).

**Location:** `.opencode/skills/study-health/SKILL.md` (skill definition) + `study-health.sh` (helper script).

### How agents reach Prometheus

There is **no ingress** on the monitoring stack (no k8s auth/MFA model), so agents
reach it the same way `mcp__postgres` reaches CockroachDB — over `localhost` via a
port-forward:

- **`prometheus` MCP server** (`~/.claude.json`, project scope) → `uvx
  prometheus-mcp-server`, `PROMETHEUS_URL=http://localhost:9090`. Gives agents a
  first-class PromQL tool (`mcp__prometheus`). **Requires a Claude Code restart to
  activate**, and a running Prometheus port-forward.
- **`devops/port-forwards.sh`** opens the forwards the MCP servers + `/study-health`
  expect: Prometheus `9090`, AlertManager `9093`, CockroachDB `26257`. Idempotent.
- The `/study-health` helper works today via `kubectl port-forward` + `curl`
  (unique ports) and should prefer the MCP tools once available.

### Connect → read → investigate alerts (agent runbook)

**1. Connect to AlertManager.** No ingress on the raw stack — three ways in:
- **Port-forward (preferred for local agents):** `devops/port-forwards.sh` opens
  `localhost:9093` (AlertManager), `:9090` (Prometheus), `:26257` (CockroachDB).
  Idempotent.
- **In-cluster service:** `prometheus-kube-prometheus-alertmanager.monitoring:9093`
  (what Karma reads).
- **No local tooling?** Exec the AM pod:
  `kubectl -n monitoring exec $(kubectl -n monitoring get pod -l app.kubernetes.io/name=alertmanager -o name | head -1) -c alertmanager -- wget -qO- http://localhost:9093/api/v2/alerts`

**2. Read the CURRENT firing alerts** (state, not history) via the AM v2 API:
```bash
curl -s 'http://localhost:9093/api/v2/alerts?active=true&silenced=false&inhibited=false' \
  | jq -r '.[] | "\(.labels.severity)\t\(.labels.alertname)\t\(.labels.namespace // "-")\t\(.annotations.summary // "")"'
```
Each alert has `.labels.alertname`, `.labels.severity`, `.labels.namespace`
(prod=`vprod`, staging=`vstag`), `.annotations.summary/description`, and
`.status.state`. `amtool alert query --alertmanager.url=http://localhost:9093` is
the CLI equivalent. **Humans:** use the **Karma** board (`https://alerts.vlab.digital`,
Google login) — same data as a live state view; resolved alerts disappear.

**3. Investigate a firing alert:**
- **What it means + fix:** find the alertname in §§3–6 of this doc (runbooks). Every
  alert is documented with its PromQL and remediation steps.
- **Where it's defined / its exact threshold:** the PrometheusRule — `devops/alerts/`
  (broker/app/study/cronjob), `devops/kafka-consumer-health/` (lag),
  `devops/vlab/charts/redis/` (redis). Grep the alertname to find the `expr`.
- **Underlying metrics:** run the rule's `expr` (or narrower) against Prometheus via
  the **`mcp__prometheus`** tool (PromQL at `:9090`).
- **Study/error alerts** (`Platform*`, `Survey*`, `MultiSurvey*`, `Dean*`):
  cross-reference CockroachDB survey states (port-forward `:26257`,
  `mcp__postgres`) and `documentation/study-error-alerting.md`; the `/study-health`
  skill returns a one-shot green/degraded/critical verdict with next steps.

---

## 8. Alert overview, phone push, dashboards (Karma + ntfy + Grafana)

Slack `#vlab-alerts` is a firehose — poor for *overview* when several alerts fire
chronically, and it can't push to a phone selectively. Two OSS, self-hosted pieces
fill the gap (both in the `monitoring` namespace). Full build/rollout plan:
`planning/karma-ntfy-alerting-plan.md`.

**Grafana** joins them as the third browser-facing surface — where you go *after*
an alert, to see magnitude and history. All three now have public hostnames with
Google login; the two auth patterns in use are compared below and in
`devops/grafana/README.md`.

| Host | What | Auth |
|---|---|---|
| `alerts.vlab.digital` | Karma — live alert board | oauth2-proxy (nginx `auth_request`) → Auth0 → Google |
| `grafana.vlab.digital` | Grafana — dashboards | Grafana's own `auth.google` → Google (no broker) |
| `ntfy.vlab.digital` | ntfy — phone push | ntfy's own users/tokens (clients can't do browser OIDC) |

### Karma — the overview board (`devops/karma/`)
[Karma](https://github.com/prymitive/karma) at **`https://alerts.vlab.digital`**
reads AlertManager (`prometheus-kube-prometheus-alertmanager:9093`, **read-only**)
and shows **all** live alerts grouped/collapsed — the at-a-glance state view. Works
in a phone browser, so it's also how you *see everything* on your phone.

- **Auth:** Karma has no built-in auth, so it's fronted by **oauth2-proxy**
  (`devops/oauth2-proxy/`) doing OIDC to **Auth0** (`https://virtuallab.auth0.com/`);
  Auth0's Universal Login shows **"Sign in with Google."** Access is gated by an
  **email allowlist** (`oauth2-proxy-emails` ConfigMap). oauth2-proxy runs in nginx
  `auth_request` mode; two ingresses on the host (`/oauth2/*` open, `/` gated).
- **Auth0 app:** a dedicated **Regular Web Application** (confidential client) — NOT
  the dashboard SPA. Client id/secret live in `devops/alerts/.env-karma`
  (gitignored). Callback `…/oauth2/callback`, logout `https://alerts.vlab.digital`.

### ntfy — phone push for criticals (`devops/ntfy/`)
[ntfy](https://ntfy.sh) at **`https://ntfy.vlab.digital`** pushes to the ntfy phone
app on topic **`vlab-alerts`**. **Only `severity=critical` pushes** (low noise —
everything is still visible in Slack + Karma). Achieved by adding a `webhook_configs`
(ntfy's built-in `template=alertmanager`) to the **`slack-critical`** receiver in
`devops/alertmanager/alertmanager.yaml`, so criticals hit **both** Slack and phone.
The publish token is injected via `secret.env` → `apply.sh` (`${NTFY_TOKEN}`), same
pattern as the Slack webhooks — never committed.

- **Auth (deliberately different from Karma):** ntfy's clients are the **phone app**
  (streaming subscribe) and **AlertManager** (machine publish) — neither can do the
  browser OIDC flow, so ntfy uses its **own** auth (users + tokens + per-topic ACLs,
  `auth-default-access: deny-all`), **not** oauth2-proxy. See `devops/ntfy/README.md`
  for the user/token/access setup.

### Grafana — the dashboards board (`devops/grafana/`)
Grafana at **`https://grafana.vlab.digital`** is the third browser-facing piece on
the cluster, and the one you reach for when an alert tells you *that* something
is wrong and you need to see *how much* and *since when*. It reads Prometheus,
Loki, and prod CockroachDB (via a `PostgreSQL` datasource). Previously
port-forward-only.

- **Auth: deliberately unlike Karma.** Karma has no login of its own, hence
  oauth2-proxy in front reaching Google *through* Auth0 as an OIDC broker.
  Grafana has a first-class OAuth client, so it goes **straight to Google**
  (`auth.google`) — **one** ingress, no `auth_request` annotations, no
  oauth2-proxy, no broker, and real per-user identity instead of one shared
  anonymous session.
- **Who may log in** is enforced in Grafana: a `role_attribute_path` JMESPath
  allowlist plus `role_attribute_strict = true`, which denies any email that
  doesn't map to a role. Adding a teammate means editing that line in
  `devops/prometheus/values.yaml` and running `helm upgrade` — the counterpart to
  Karma's `oauth2-proxy-emails` ConfigMap. Not `allowed_domains`: the team is not
  on one Workspace domain.
- **The OAuth client is created by hand in the Google Cloud Console**, once, and
  that is on purpose. Google has no live API for creating "Sign in with Google"
  web clients (the IAP OAuth Admin API that Terraform used was shut down
  2026-03-19, and needed an org this project doesn't have). Brokering through
  Auth0 *would* make it Terraformable — that design was rejected, because it adds
  a vendor to the critical login path and a standing tenant-admin credential to
  avoid one console form. See `devops/grafana/README.md`.
- **Config lives in `devops/prometheus/values.yaml`**, not in a `grafana` Helm
  release — Grafana is a subchart of `kube-prometheus-stack`. Client id/secret
  arrive as `GF_*` env vars from the `grafana-oauth` secret so they never land in
  the ConfigMap that `grafana.ini` renders into.

### Why not Grafana OnCall
OnCall **OSS is archived** (2026-03-24) and its mobile push/SMS/phone features (which
were Cloud-backed) stopped working for OSS users the same day; push now lives only in
paid Grafana Cloud IRM. Karma + ntfy keeps the whole path OSS + self-hosted.

## 9. Other alert sources (aware, not yet curated)

- **kube-prometheus-stack default rules** are enabled (`defaultRules` in
  `devops/prometheus/values.yaml`). Triage status:
  - `KubeProxyDown` — **resolved**: GKE false positive (kube-proxy healthy, metrics
    not scrapeable). `kubeProxy.enabled: false` added to `devops/prometheus/values.yaml`
    (matching `kubeScheduler`/`kubeControllerManager`); live rule/ServiceMonitor removed.
  - `KubeJobFailed` / `KubeJobNotCompleted` — **replaced**: null-routed in
    `devops/alertmanager/alertmanager.yaml`; superseded by the cronjob-health rules
    in §6 (alert on *repeated* failure only). Rules remain in Prometheus for debugging.
  - `CPUThrottlingHigh` (info; chronic on `kminion` in `default` and
    `gbv-redis-replicas-0` in `vstag`) — **now inhibited**, not muted. It flaps
    constantly (202 firing episodes in the 4 days to 2026-08-04, 65% of all alert
    activity) and the stock `InfoInhibitor` rule exists precisely to swallow it; that
    rule had been lost and is restored (§2). The rule itself is left enabled — if the
    underlying throttling ever matters it will surface alongside a real warning in the
    same namespace.
  - `Watchdog` is an always-on liveness signal (expected) and is null-routed;
    `InfoInhibitor` is plumbing and is **also** null-routed (§2) — it is not an alert
    and must never reach a human.
- **Redis** alerts ship with the redis subchart (`vlab/charts/redis`).
