# Monitoring & Observability Stack Documentation

**Last Updated:** 2026-07-20
**Environment:** /home/nandan/Documents/vlab-research/fly

---

## Update (2026-07-20): kminion + infra-level Kafka consumer-lag alerting

Kafka consumer-lag alerting was reworked. **See
`documentation/kafka-consumer-lag-alerting.md` for the full design + runbook.**
Summary of what changed vs. the rest of this doc:

- **kminion added** (`devops/kminion/`, release `kminion` in `default` ns) —
  Redpanda's maintained exporter. Emits `kminion_kafka_consumer_group_topic_lag`,
  `..._topic_offset_sum`, `..._members`. Runs alongside the legacy
  `danielqsj/kafka-exporter` (kept for existing dashboards; now **pinned to
  `v1.9.0`**, no longer `:latest`).
- **Alerts moved from app-level to infra-level.** The old
  `devops/vlab/templates/lagging-alerts.yaml` + `processing-alerts.yaml` (driven
  by per-env `laggingAlerts`/`processingAlerts` values) are **retired**. There is
  now a **single `PrometheusRule`** for the whole shared cluster:
  `devops/kafka-consumer-health/` (release in `monitoring` ns), covering **both**
  prod and staging, keyed on **`group_id` AND `topic_name`**. Rationale: the
  cluster, Prometheus, and kminion are singletons, so their alerting is a
  singleton — `env` is a label, not a deployment boundary.
- **Rules now catch the right symptoms:** `KafkaConsumerStuck` (offset not
  advancing while backlog > 0), `KafkaConsumerDrainSLOBreach` (time-to-drain SLI),
  `KafkaConsumerGroupAbsent`. Replaces the old noisy `lag > N messages` count
  thresholds.
- **Correction to this doc:** Prometheus's `ruleSelector` **and**
  `ruleNamespaceSelector` are both `{}` → it watches PrometheusRules in **all**
  namespaces, not just `monitoring`. (That's why the single monitoring-ns rule
  set is picked up, and why the old per-env rules in `vprod` worked too.)

- **Broker/app alerts brought into Git + de-noised.** The orphaned banzaicloud
  koperator default rule set (`kafka-alerts`) fired permanently
  (`BrokerOverLoaded > 30 req/s`, `PartitionCountHigh > 100` — stale static
  thresholds against a healthy cluster). It is **retired** and replaced by a
  hand-authored, version-controlled chart **`devops/alerts/`** (release
  `vlab-alerts` in `monitoring`): Kafka **broker health** (offline partitions,
  controller count, under-replication, disk) + **ReplyBotCrashing** (rescued
  from the never-applied `prometheus/rules/replybot.yaml`). Full inventory +
  runbooks: **`documentation/alerting.md`**.

Still open: AlertManager has no severity routing yet (one flat `#vlab-alerts`
receiver — rules already carry `severity` labels), and several
kube-prometheus-stack default alerts fire and want triage (`KubeJobFailed` ×23,
`KubeProxyDown`). See `documentation/alerting.md` §5.

---

## Quick Answers to Key Questions

### Q1: What is the Prometheus URL that Grafana uses?
**Answer:** `http://prometheus-operated:9090`

**Details:**
- **Service Name:** `prometheus-operated` (created by kube-prometheus-stack Helm chart)
- **Namespace:** `monitoring`
- **Port:** `9090`
- **Full FQDN:** `prometheus-operated.monitoring.svc.cluster.local:9090`
- **Configured via:** Grafana sidecar in `/devops/prometheus/values.yaml` (line 79-89)

This URL is the default when Grafana's Prometheus datasource is automatically configured by the sidecar container.

### Q2: How are dashboards currently managed?
**Answer:** Dashboards are provisioned as code via ConfigMaps

**Current State:**
- **Active dashboards:** `/devops/grafana-dashboards/` (Helm chart that provisions via ConfigMaps)
  - `kafka-consumer-health.json` - Consumer lag, drain time, consume rate, alerts
  - `kafka-broker-app-health.json` - Broker health, disk, app restarts, all firing alerts
- **Legacy dashboards:** `/devops/grafana/dashboards/` (static files, NOT loaded)
  - These are reference-only from earlier manual imports

**How Provisioning Works:**
- Grafana sidecar container watches for ConfigMaps with label `grafana_dashboard: "1"`
- Helm chart wraps JSON dashboards in ConfigMaps and applies to monitoring namespace
- Dashboards appear automatically in Grafana UI (no manual import needed)

**How to Add New Dashboards:**
See Section 3 below (Dashboard Management)

### Q3: Is it kube-prometheus-stack or separate Prometheus/Grafana?
**Answer:** It's `kube-prometheus-stack` Helm chart

**Installation:**
```bash
# From /devops/setup-kube.sh (line 35)
helm install --namespace monitoring prometheus prometheus-community/kube-prometheus-stack -f prometheus/values.yaml
```

**What's Included:**
- ✓ Prometheus (metrics collection & alerting)
- ✓ Grafana (visualization & dashboarding)
- ✓ Prometheus Operator (CRD management)
- ✓ kube-state-metrics (Kubernetes metrics)
- ✓ prometheus-node-exporter (node metrics)
- ✓ AlertManager (alert routing)

---

## Architecture Overview

### Component Deployment

```
┌─────────────────────────────────────────────────────────┐
│                  monitoring namespace                    │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Prometheus   │  │   Grafana    │  │ AlertManager │  │
│  │ :9090        │  │   :3000      │  │   :9093      │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│         ↑               ↑                                 │
│         │               │                                 │
│         └───────────────┘                                 │
│         (datasource connection)                           │
│                                                           │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Prometheus Operator (manages ServiceMonitors)   │   │
│  └──────────────────────────────────────────────────┘   │
│                                                           │
│  ┌─────────────────┐  ┌──────────────────────────────┐  │
│  │ kube-state-     │  │ prometheus-node-exporter     │  │
│  │ metrics         │  │ (runs on each node)          │  │
│  │ (cluster state) │  └──────────────────────────────┘  │
│  └─────────────────┘                                    │
│                                                           │
└─────────────────────────────────────────────────────────┘
         ↑          ↑          ↑
         │          │          │
    ┌────┴──┬───────┴─┬────────┴────┐
    │       │         │             │
    │    Kafka    Redis         Kubernetes
    │  Exporter  Exporter      Kubelet
    │   (9308)    (6379)      Metrics
    │                            (10250)
    │
    └─ Scraped every 30s by Prometheus
       via ServiceMonitor discovery
```

### Metrics Flow

```
kube-state-metrics (Kubernetes state)
    ↓
    ServiceMonitor (auto-discovered by Prometheus)
    ↓
Prometheus scrapes http://kube-state-metrics:8080/metrics
    ↓
Metrics stored in 20Gi PVC (/prometheus)
    ↓
Grafana queries Prometheus via http://prometheus-operated:9090
    ↓
Dashboards display metrics to users
```

---

## Configuration Files

### 1. Main Stack Configuration
**File:** `/devops/prometheus/values.yaml`

Contains:
- `grafana:` - Grafana version (7.4.2), datasource sidecar
- `prometheus:` - Prometheus scraping config
- `alertmanager:` - AlertManager configuration
- `defaultRules:` - Built-in alert rules to enable

### 2. Production Environment Values
**File:** `/devops/values/production.yaml`

Production-specific settings:
- `laggingAlerts:` - Kafka consumer lag thresholds
- `processingAlerts:` - Processing stuck alerts
- `redis:` - Redis with metrics and replication
- `kafka:` - 3-node Kafka cluster
- Storage classes: `pd-ssd` for production SLA

### 3. Alert Rules
**File:** `/devops/prometheus/rules/lag.yaml`

Kafka lag recording and alert rules:
- `kafka:consumer_rate` - consumption rate
- `kafka:consumer_lag` - lag in messages
- `kube_job_status_failed` - failed jobs

**Dynamic Rules Template:** `/devops/vlab/templates/lagging-alerts.yaml`

Generates PrometheusRule CRDs from production values config

---

## Verifying kube-state-metrics is Scraped

### Step 1: Port-Forward to Prometheus
```bash
kubectl port-forward -n monitoring svc/prometheus-operated 9090:9090
```

### Step 2: Check Service Targets
Visit: `http://localhost:9090/targets`

Look for:
- Job name: `kube-state-metrics`
- State: **UP** (green)
- Endpoint: `http://kube-state-metrics:8080`
- Scrape interval: 30s

### Step 3: Query CronJob Metrics
In Prometheus UI, search for:
```promql
kube_cronjob_info
kube_cronjob_status_next_schedule_time
kube_job_status_active
```

All should return results if metrics are being scraped.

### Step 4: Verify via API
```bash
curl 'http://localhost:9090/api/v1/query?query=kube_cronjob_info'
```

Should return JSON with metric results.

---

## Dashboard Management

### Current Status
```
✅ Dashboards exist:        /devops/grafana-dashboards/*.json
✅ Auto-provisioned:        YES (via ConfigMaps + Grafana sidecar)
✅ Grafana deployed:        YES
✅ Prometheus linked:       YES
✅ Access:                  Port-forward only (no ingress)
```

### Active Dashboards (Provisioned)

1. **Kafka Consumer Health** (`kafka-consumer-health`)
   - Consumer lag per group/topic (messages)
   - Time to drain backlog (recording rule `kafka:consumergroup_drain_seconds`)
   - Consume rate (msg/sec)
   - Consumer group members
   - Firing KafkaConsumer* alerts table
   - Environment filter (production/staging)

2. **Kafka Broker & App Health** (`kafka-broker-app-health`)
   - Offline partitions (should be 0)
   - Active controller count (should be 1)
   - Under-replicated partitions
   - Kafka PVC free space (%)
   - ReplyBot container restarts (1h increase)
   - All firing alerts table

### How to Access Dashboards

Dashboards are accessible **only via port-forward** (no ingress/public URL):

```bash
# Port-forward Grafana (use unique port if other port-forwards are active)
kubectl -n monitoring port-forward svc/prometheus-grafana 3000:80

# Get admin password
kubectl -n monitoring get secret prometheus-grafana -o jsonpath='{.data.admin-password}' | base64 -d

# Open browser to http://localhost:3000
# Login: admin / <password from above>
# Search for "Kafka" to find the dashboards
```

### How Provisioning Works

The Grafana deployment includes a **sidecar container** (`grafana-sc-dashboard`) that:
1. Watches for ConfigMaps in the `monitoring` namespace
2. With label `grafana_dashboard: "1"`
3. Automatically loads them into Grafana (no manual import needed)

Dashboards are version-controlled as:
- **JSON files** in `/devops/grafana-dashboards/*.json`
- **Wrapped in ConfigMaps** via Helm chart templates
- **Deployed** via `helm install grafana-dashboards` (see `setup-kube.sh`)

### How to Add a New Dashboard

#### Step 1: Create the Dashboard JSON

Create a new file in `/devops/grafana-dashboards/` (e.g., `my-new-dashboard.json`):

```json
{
  "annotations": { "list": [] },
  "editable": true,
  "gnetId": null,
  "graphTooltip": 0,
  "id": null,
  "links": [],
  "panels": [
    {
      "datasource": "Prometheus",
      "targets": [
        {
          "expr": "your_promql_query",
          "legendFormat": "{{label}}"
        }
      ],
      "title": "Panel Title",
      "type": "timeseries"
    }
  ],
  "schemaVersion": 14,
  "title": "My New Dashboard",
  "uid": "my-new-dashboard-uid",
  "version": 1
}
```

**Key requirements:**
- `"datasource": "Prometheus"` (matches the datasource name in Grafana)
- `"schemaVersion": 14` (current version used by Grafana 7.4.2)
- `"uid"`: unique identifier (lowercase-with-dashes)
- `"id": null` (Grafana assigns on import)

#### Step 2: Create the ConfigMap Template

Create `/devops/grafana-dashboards/templates/my-new-dashboard-cm.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: my-new-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  my-new-dashboard.json: |-
{{ .Files.Get "my-new-dashboard.json" | indent 4 }}
```

**Critical:** The label `grafana_dashboard: "1"` triggers the sidecar to load it.

#### Step 3: Deploy the Dashboard

```bash
# Upgrade the Helm release
helm upgrade grafana-dashboards devops/grafana-dashboards --namespace monitoring

# The sidecar picks it up within seconds (no Grafana restart needed)
```

#### Step 4: Verify It Loaded

```bash
# Port-forward Grafana
kubectl -n monitoring port-forward svc/prometheus-grafana 3000:80

# Get admin password
kubectl -n monitoring get secret prometheus-grafana -o jsonpath='{.data.admin-password}' | base64 -d

# Check via API
curl -u admin:<password> 'http://localhost:3000/api/search?query=<dashboard-title>'
```

### Legacy Dashboards (Reference Only)

`/devops/grafana/dashboards/` contains ~23 static JSON files from earlier manual imports:
- `state-dashboard.json` - State machine monitoring
- `form-status.json` - Form status tracking
- `Strimzi Kafka Exporter-*.json` - Kafka metrics

These are **NOT** auto-loaded. They serve as reference/templates. To activate one:
1. Copy the JSON to `/devops/grafana-dashboards/`
2. Create a ConfigMap template (see Step 2 above)
3. Deploy via Helm

### Troubleshooting

| Symptom | Root Cause | Solution |
|---------|-----------|----------|
| Dashboard not appearing | ConfigMap missing label | Verify `grafana_dashboard: "1"` label exists |
| Dashboard shows "datasource not found" | Datasource name mismatch | Use `"datasource": "Prometheus"` (exact name) |
| Changes not applying | ConfigMap not updated | Re-run `helm upgrade` after editing JSON |
| Panels show "No data" | Query syntax or metric missing | Check PromQL in Prometheus UI first (`/targets`, `/graph`) |

---

## ServiceMonitor Pattern (How Prometheus Discovers Metrics)

Prometheus uses ServiceMonitors (Kubernetes custom resources) to discover what to scrape.

### Example: Kafka Exporter ServiceMonitor
**File:** `/devops/kafka-exporter/templates/servicemonitor.yaml`

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: kafka-exporter
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: kafka-exporter
  endpoints:
  - port: metrics
    interval: 30s
```

**How it works:**
1. Prometheus Operator watches all ServiceMonitors
2. Prometheus config selector is empty (`{}`) = match ALL
3. When ServiceMonitor matches, Prometheus adds scrape job
4. Prometheus scrapes `kafka-exporter:9308/metrics` every 30s

### Discovery Configuration
**File:** `/devops/prometheus/values.yaml` (lines 49-57)

```yaml
prometheus:
  prometheusSpec:
    # Empty selectors = match ALL ServiceMonitors
    serviceMonitorSelectorNilUsesHelmValues: false
    serviceMonitorSelector: {}
    podMonitorSelector: {}
    ruleSelector: {}
```

**Impact:** Any ServiceMonitor or PrometheusRule created in the cluster will automatically be discovered.

---

## Alerting Configuration

### Alert Rules by Source

#### 1. Kafka Consumer Lag Alerts
**File:** `/devops/vlab/templates/lagging-alerts.yaml`

Dynamically generated from `/devops/values/production.yaml`:
```yaml
laggingAlerts:
  - consumergroup: replybot
    alertname: LaggingConsumerReplybot
    window: "5m"
    limit: "20"
```

Generates:
```yaml
alert: VlabLaggingConsumerReplybot
expr: sum(kafka_consumergroup_lag_sum{consumergroup="replybot"}) > 20
for: 5m
```

#### 2. Kafka Lag Recording Rules
**File:** `/devops/prometheus/rules/lag.yaml`

Recording rules that pre-compute expensive queries:
- `kafka:consumer_rate` - offset change rate
- `kafka:consumer_lag` - current lag
- `kafka:consumer_lag_seconds` - lag in seconds

#### 3. Built-in Alert Rules
**Enabled via:** `prometheus/values.yaml` (lines 1-21)

22 rule groups covering:
- Kubernetes cluster health
- Pod/Deployment status
- Node resource pressure
- Storage warnings
- Network connectivity
- Prometheus & AlertManager health

### Alert Routing
**File:** External secret `alertmanager` (referenced in `prometheus/values.yaml`)

AlertManager routes alerts based on labels, severity, and custom routing rules.

---

## Prometheus Storage

**Configuration:** `/devops/prometheus/values.yaml` (lines 58-65)

```yaml
storage:
  volumeClaimTemplate:
    spec:
      accessModes:
      - ReadWriteOnce
      resources:
        requests:
          storage: 20Gi
```

**Details:**
- **Size:** 20Gi persistent volume
- **Access Mode:** ReadWriteOnce (single node)
- **Storage Class:** Default (can be overridden)
- **Retention:** ~15 days of metrics (default 15-day retention in Prometheus)

---

## Key Metrics Available from kube-state-metrics

For CronJob monitoring, these are available:

```promql
# CronJobs
kube_cronjob_info                       # CronJob metadata
kube_cronjob_status_next_schedule_time  # When it will run next
kube_cronjob_status_last_schedule_time  # When it last ran
kube_cronjob_status_last_successful_time

# Jobs created by CronJobs
kube_job_info                           # Job metadata
kube_job_created                        # Job creation time
kube_job_status_start_time              # Job start time
kube_job_status_completion_time         # Job completion time
kube_job_status_active                  # Currently running
kube_job_status_succeeded               # Successful count
kube_job_status_failed                  # Failed count

# Pods created by Jobs
kube_pod_info                           # Pod metadata
kube_pod_status_phase                   # Pod phase (Running, Failed, etc)
kube_pod_status_container_ready         # Container readiness
```

---

## Testing the Connection

### 1. Verify Prometheus is Up
```bash
kubectl get pods -n monitoring | grep prometheus-operated
kubectl get svc -n monitoring | grep prometheus-operated
```

### 2. Verify Grafana Datasource
```bash
# Port-forward Grafana
kubectl port-forward -n monitoring svc/prometheus-grafana 3000:80

# Visit http://localhost:3000
# Login → Settings → Data Sources → Prometheus
# Click "Test" button → should show green checkmark
```

### 3. Query from CLI
```bash
# Get one metric value
kubectl exec -n monitoring deployment/prometheus-operator -- \
  wget -O- 'http://prometheus-operated:9090/api/v1/query?query=up'

# Port-forward for easier testing
kubectl port-forward -n monitoring svc/prometheus-operated 9090:9090 &
curl 'http://localhost:9090/api/v1/query?query=kube_cronjob_info'
```

### 4. Check ServiceMonitor Discovery
```bash
# List all ServiceMonitors
kubectl get servicemonitors -A

# Check what Prometheus found
kubectl port-forward -n monitoring svc/prometheus-operated 9090:9090
# Visit http://localhost:9090/service-discovery
```

---

## File Manifest

| Path | Purpose | Key Content |
|------|---------|-------------|
| `/devops/setup-kube.sh` | Installation | Helm install kube-prometheus-stack |
| `/devops/prometheus/values.yaml` | Configuration | Grafana, Prometheus, AlertManager settings |
| `/devops/prometheus/rules/lag.yaml` | Alert Rules | Kafka consumer lag rules |
| `/devops/vlab/templates/lagging-alerts.yaml` | Alert Template | Dynamic lag alerts |
| `/devops/vlab/templates/processing-alerts.yaml` | Alert Template | Processing stuck alerts |
| `/devops/kafka-exporter/templates/servicemonitor.yaml` | Service Discovery | Kafka metrics scraping |
| `/devops/vlab/charts/redis/templates/servicemonitor.yaml` | Service Discovery | Redis metrics scraping |
| `/devops/values/production.yaml` | Production Config | Alert thresholds, Redis/Kafka config |
| `/devops/values/integrations/fly.yaml` | Dev/Integration Config | Simplified settings for testing |
| `/devops/grafana/dashboards/*.json` | Dashboards | Static dashboard files (not auto-loaded) |

---

## Next Steps for CronJob Monitoring

1. **Verify kube-state-metrics metrics are present** (use Section "Verifying kube-state-metrics is Scraped")

2. **Design CronJob dashboard** with queries like:
   - `kube_cronjob_status_next_schedule_time` - scheduled runs
   - `increase(kube_job_status_failed[24h])` - failed jobs
   - `sum(kube_job_status_active) by (cronjob)` - currently running

3. **Create dashboard ConfigMap** (Method 2 in Dashboard Management section)

4. **Deploy via Helm** with updated `prometheus/values.yaml`

5. **Test in Grafana UI** at `http://localhost:3000`

---

## Troubleshooting

| Symptom | Root Cause | Solution |
|---------|-----------|----------|
| Prometheus targets not up | ServiceMonitor not created/matched | Check `kubectl get servicemonitors -A` |
| Grafana can't connect | Service name wrong or namespace issue | Verify datasource URL: `http://prometheus-operated:9090` |
| Dashboard not appearing | ConfigMap not labeled correctly | Add label: `grafana_dashboard: "1"` |
| No metrics in Prometheus | Scrape job not configured | Check `/targets` in Prometheus UI |
| AlertManager not receiving alerts | AlertManager config secret missing | Check secret: `kubectl get secret -n monitoring alertmanager` |

---

## References

- **Setup Script:** `/devops/setup-kube.sh`
- **Main Config:** `/devops/prometheus/values.yaml`
- **Alert Rules:** `/devops/prometheus/rules/`
- **Production Values:** `/devops/values/production.yaml`
- **Existing Dashboards:** `/devops/grafana/dashboards/`
- **kube-prometheus-stack Chart:** https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack

---

*Documentation created as part of monitoring stack exploration. For updates, edit this file directly.*
