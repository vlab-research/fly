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

## 2. AlertManager → Slack + PagerDuty + Email

**Status:** Version-controlled config ready for deployment (NOT YET APPLIED).

**Current (live):** All alerts route to Slack `#vlab-alerts` (flat routing, no severity distinction).

**New (designed, validated, GATED):** Severity-based routing with dead-man's switch. Config in Git at `devops/alertmanager/alertmanager.yaml`.

### Routing Model (New, Not Yet Live)

```
All Alerts
    │
    ├─ Watchdog (liveness) ──────────────────► deadmans-switch (heartbeat)
    │
    ├─ severity=critical ───────┬───────────► page (PagerDuty)
    │                            └───────────► slack-critical (#vlab-alerts-critical)
    │
    ├─ severity=warning ────────────────────► slack (#vlab-alerts)
    │
    └─ default / FYI ───────────────────────► fyi (email)
```

- **Critical** (`severity=critical`) → **PagerDuty** (page on-call) **AND** **Slack #vlab-alerts-critical** (visibility)
  - Repeat interval: 1h (re-page if not resolved)
  - Grouping: 10s wait, 2m interval (fast response)
- **Warning** (`severity=warning`) → **Slack #vlab-alerts** (ticket, preserves current behavior)
  - Repeat interval: 12h
  - Grouping: 30s wait, 5m interval
- **FYI** (no severity or `severity=info`) → **Email** (`team@vlab-research.org`)
  - Repeat interval: 24h
- **Watchdog** (always-firing liveness signal) → **Dead-man's switch** (external heartbeat monitor)
  - Check-in every ~1-2 minutes; external monitor (healthchecks.io / PagerDuty heartbeat) pages if silent → monitoring stack is down

### Inhibition Rules

- Platform-wide critical alerts (e.g., `KafkaOfflinePartitions`) mute per-survey/component warnings
- Critical Kafka broker issues mute consumer-lag warnings
- Reduces noise when root cause is already firing

### Deployment Status

**Config:** `devops/alertmanager/alertmanager.yaml` (version-controlled, no secrets)  
**Validation:** Passed `amtool check-config` + routing tests (see `devops/alertmanager/VALIDATION.md`)  
**Secrets Required:** (see `devops/alertmanager/README.md` §Secrets Required)
- `#vlab-alerts-critical` Slack webhook (TODO: create channel + webhook)
- PagerDuty Events API v2 routing key (TODO: create service + integration)
- Dead-man's switch heartbeat URL (TODO: provision healthchecks.io / PagerDuty heartbeat)
- SMTP credentials for email (TODO: SendGrid / AWS SES)

**Cutover:** GATED — do NOT apply until secrets are provisioned and human review is complete. Commands in `devops/alertmanager/CUTOVER.md`.

**Rollback:** Revert `devops/prometheus/values.yaml` to `useExistingSecret: true` + `configSecret: "alertmanager"` → kube-prometheus-stack regenerates the original flat config.

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
analyzing error, blocked, stuck, and expired states across surveys. All thresholds
are **v1 — tuned for current low traffic** (~8 active users/hr total) and will
need adjustment as traffic grows.

### PlatformInternalErrors
`sum(survey_error_states{error_tag=~"INTERNAL|STATE_ACTIONS|NETWORK"}) >= 5` for
10m — **critical**. Platform bugs (DB failures, state machine errors, network
issues). Rare and always actionable. See
`documentation/study-error-alerting.md#platforminternalerrors`.

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
(validation loop / confusing form). Study UX issue, ticket. See
`documentation/study-error-alerting.md#surveystuckusersspike`.

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

## 6. Agent-checkable monitoring

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

---

## 7. Other alert sources (aware, not yet curated)

- **kube-prometheus-stack default rules** are enabled (`defaultRules` in
  `devops/prometheus/values.yaml`). Several fire today and want triage so they
  don't re-pollute the channel: **`KubeJobFailed` (×23)**, `KubeProxyDown`,
  `CPUThrottlingHigh`, `KubeJobNotCompleted`. `Watchdog` is an always-on
  liveness signal (expected); `InfoInhibitor` is plumbing.
- **Redis** alerts ship with the redis subchart (`vlab/charts/redis`).

These are the next cleanup targets after severity routing.
