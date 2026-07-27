# Grafana Dashboards (Provisioned as Code)

This Helm chart provisions Grafana dashboards via ConfigMaps. The Grafana deployment includes a sidecar container that watches for ConfigMaps with label `grafana_dashboard: "1"` and automatically loads them.

## Directory Structure

```
grafana-dashboards/
├── Chart.yaml                          # Helm chart metadata
├── values.yaml                         # Chart values (currently empty)
├── README.md                           # This file
├── kafka-consumer-health.json          # Dashboard: Kafka consumer lag/drain/alerts
├── kafka-broker-app-health.json        # Dashboard: Kafka broker health + app restarts
├── study-health.json                   # Dashboard: survey error/blocked/stuck (1h diagnostics)
├── live-traffic.json                   # Dashboard: who is chatting right now (5m)
└── templates/
    ├── kafka-consumer-health-cm.yaml   # ConfigMap for consumer health dashboard
    ├── kafka-broker-app-health-cm.yaml # ConfigMap for broker/app health dashboard
    ├── study-health-cm.yaml            # ConfigMap for study health dashboard
    └── live-traffic-cm.yaml            # ConfigMap for live traffic dashboard
```

## Active Dashboards

### 1. Kafka Consumer Health (`kafka-consumer-health`)

Monitors Kafka consumer lag and processing health:
- **Consumer lag** per group/topic (messages waiting)
- **Time to drain backlog** (recording rule `kafka:consumergroup_drain_seconds`)
- **Consume rate** (messages/sec)
- **Consumer group members** (active consumers)
- **Firing alerts** (KafkaConsumerStuck, KafkaConsumerDrainSLOBreach, KafkaConsumerGroupAbsent)
- **Environment filter** (production/staging)

**Metrics sources:**
- `kminion_kafka_consumer_group_topic_lag` (from kminion exporter)
- `kminion_kafka_consumer_group_topic_offset_sum` (from kminion exporter)
- `kafka:consumergroup_drain_seconds` (recording rule in kafka-consumer-health PrometheusRule)

### 2. Kafka Broker & App Health (`kafka-broker-app-health`)

Monitors Kafka cluster and application health:
- **Offline partitions** (critical: should be 0)
- **Active controller count** (critical: should be exactly 1)
- **Under-replicated partitions** (warning: sustained >0 risks data loss)
- **Kafka PVC free space** (percent free per broker volume)
- **ReplyBot container restarts** (1h increase, by namespace)
- **All firing alerts** (across the entire cluster)

**Metrics sources:**
- `kafka_controller_kafkacontroller_offlinepartitionscount` (JMX via koperator ServiceMonitors)
- `kafka_controller_kafkacontroller_activecontrollercount` (JMX)
- `kafka_server_replicamanager_underreplicatedpartitions` (JMX)
- `kubelet_volume_stats_available_bytes` / `kubelet_volume_stats_capacity_bytes` (kubelet)
- `kube_pod_container_status_restarts_total{container="replybot"}` (kube-state-metrics)
- `ALERTS{alertstate="firing"}` (Prometheus alerting)

### 3. Study Health (`study-health`)

**Job: depth in ONE study.** Which study is bleeding, by how much relative to normal, from
what cause. 1h windows. These are the metrics the alert rules are built on.

- **Study triage table** (top, full width) — one row per form: active, errors, platform
  errors, ratio, **excess vs fleet**, actionable blocks, stuck, expired. Sorted by errors.
- **Study-fault errors by study & tag** — `FORM_NOT_FOUND`, `FIELD_NOT_FOUND`,
  `INTERPOLATION_ERROR`, `none`. Uses a **negated** regex, so a newly-added tag lands here
  automatically instead of vanishing (the taxonomy makes platform tags an allow-list).
- **Platform-fault errors by study & tag** — `INTERNAL`/`STATE_ACTIONS`/`NETWORK`.
  **Deliberately ignores `$study`, `$form` and the fallback exclusion**: a platform fault
  is not one study's business and must stay visible while the board is scoped to a study.
  Includes `form="(none)"`.
- **Error ratio per form** with the **fleet baseline overlaid**, fallback excluded.
- **Actionable blocks by study, category & code** — attrition split out to its own small
  grey panel so it stops squashing everything real.
- **Stuck users**, and an **Expired waits (total)** stat showing the *sum* that
  `DeanExpiredWaits` actually alerts on (no per-form panel ever showed that number).
- **Fallback arrivals (form 305)** — collapsed row at the bottom.
- **Filters:** `$study`, `$form`, plus a hidden `$fallback` constant.

**Read the `excess` column first.** A 40% error ratio means something completely different
when the fleet is at 4% (that study is broken — stay here) than when the fleet is at 35%
(*everything* is broken — go to Live Traffic). That one column tells you which board to be
on.

**Why 305 gets a panel instead of just being excluded.** It is ~91% of all error volume
and would drown every other panel, so it is excluded everywhere else — but 333 users a day
reach the fallback, and a rise means a broken ad link or a study that ended without its
ads being pulled. Classified as "known-benign noise" it was watched by nobody.

**Metrics source:** `sql_exporter` → CockroachDB (`devops/sql-exporter`), 1h windows, 60s
scrape, plus four recording rules in `devops/alerts/templates/study-health.yaml`. See
`/documentation/study-error-alerting.md` for the taxonomy contract.

### 4. Live Traffic (`live-traffic`)

**Job: breadth, RIGHT NOW.** How many studies, how many pages, which reason.

- **Stat row:** chatting now / active studies / active pages / in ERROR now, plus
  **STUDIES ERRORING** and **PAGES ERRORING**.
- **Users by state** (stacked — total height is volume, band composition is health).
- **★ Studies affected per error reason** (bar gauge) — bar length is *how many distinct
  studies* carry that reason.
- **Errors by reason** — the why behind the ERROR band, on a live window.
- **Error rate by page** — **rate, not count**, so a busy page does not automatically look
  worst. This is what catches "one messaging page is failing".
- **Blocked by reason & page** — attrition excluded. This board had no blocked view at all
  before 2026-07-26.
- **Users by study**, **ERROR by study & form** (fallback excluded), **breakdown table**
  (study × form × page × state × reason).
- **Filters:** `$window` (5m / 1h / 24h), `$study`, `$page_name`.

**The two ★ stats ARE the discriminator**, in two numbers:

| Studies | Pages | Read as |
|---|---|---|
| 1 | 1 | within-survey → go to Study Health |
| ≥3 | 1 | **messaging channel** — that page's token, rate limit, or Meta app |
| ≥3 | ≥2 | **platform regression** — deploys, CockroachDB, Redis, Kafka |

Red at 3 mirrors `MultiSurveyErrorRegression` so the board and the pager tell the same
story. The bar gauge refines it further: a *study-side* tag appearing across many
unrelated studies is a **platform** problem, not many simultaneous form edits —
`FORM_NOT_FOUND` at 12 studies is formcentral, not 12 misconfigured studies.

**Metrics source:** one gauge,
`survey_recent_states{window,state,form,reason,study,page,page_name}`, from the
`study_traffic` collector. Three windows from a single 24h index scan, 60s scrape,
~370ms per query.

**Every window is a distinct-user count** — `states` holds one sticky row per (user, page),
so `24h` is *distinct people today*, not a sum of `5m` buckets. Leave the error panels on
`5m`: wider windows smear a spike and hold it visible long after it stopped.

⚠️ **Any new panel must pin the window** (`survey_recent_states{window="$window"}`).
Omitting it sums all three windows and silently triple-counts.

⚠️ **Any count-of-groups panel must use `> 0`.** These gauges emit zero-valued series for
every group seen in the 24h scan, so a bare `count()` counts the whole fleet — this bug
made "Active Studies" read 29 against a true 3. Pair it with `or vector(0)` so the panel
renders `0` rather than "No data".

**No alert rule reads `survey_recent_states`** — alerting stays on the 1h metrics; this
board is for looking at.

**Where it deliberately stops.** Aggregates only. User-level drill-down lives in the
dashboard app's Monitor tab; user ids are never exported to Prometheus.

## How to Access Dashboards

Dashboards are accessible **only via port-forward** (no ingress):

```bash
# Port-forward Grafana
kubectl -n monitoring port-forward svc/prometheus-grafana 3000:80

# Get admin password
kubectl -n monitoring get secret prometheus-grafana -o jsonpath='{.data.admin-password}' | base64 -d

# Open browser: http://localhost:3000
# Login: admin / <password>
# Search: "Kafka"
```

## How to Add a New Dashboard

### Step 1: Create the Dashboard JSON

Create a new file `my-dashboard.json` in this directory:

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
          "expr": "up{job=\"my-job\"}",
          "legendFormat": "{{instance}}"
        }
      ],
      "title": "My Panel",
      "type": "timeseries"
    }
  ],
  "schemaVersion": 14,
  "title": "My Dashboard",
  "uid": "my-dashboard-uid",
  "version": 1
}
```

**Key requirements:**
- `datasource: "Prometheus"` (exact name of the Grafana datasource)
- `schemaVersion: 14` (current version for Grafana 7.4.2)
- `uid`: unique lowercase-with-dashes identifier
- `id: null` (Grafana assigns on import)

### Step 2: Create the ConfigMap Template

Create `templates/my-dashboard-cm.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: my-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  my-dashboard.json: |-
{{ .Files.Get "my-dashboard.json" | indent 4 }}
```

**Critical:** The label `grafana_dashboard: "1"` triggers the Grafana sidecar to load it.

### Step 3: Deploy

```bash
helm upgrade grafana-dashboards devops/grafana-dashboards --namespace monitoring
```

The sidecar picks up the new ConfigMap within seconds (no Grafana restart needed).

### Step 4: Verify

```bash
# Port-forward Grafana (if not already)
kubectl -n monitoring port-forward svc/prometheus-grafana 3000:80

# Check via API
curl -u admin:<password> 'http://localhost:3000/api/search?query=My%20Dashboard'
```

## How the Sidecar Works

The Grafana Deployment includes a sidecar container (`grafana-sc-dashboard`):

```yaml
containers:
- name: grafana-sc-dashboard
  image: quay.io/kiwigrid/k8s-sidecar:1.19.2
  env:
  - name: METHOD
    value: WATCH
  - name: LABEL
    value: grafana_dashboard
  - name: LABEL_VALUE
    value: "1"
  - name: FOLDER
    value: /tmp/dashboards
  - name: RESOURCE
    value: both  # ConfigMaps and Secrets
```

The sidecar:
1. Watches the `monitoring` namespace (its own namespace)
2. Looks for ConfigMaps with label `grafana_dashboard: "1"`
3. Extracts the JSON and writes it to `/tmp/dashboards/`
4. Grafana auto-loads from that directory

No manual import, no Grafana restart needed.

## Troubleshooting

### Dashboard not appearing

```bash
# Check ConfigMap exists and has correct label
kubectl -n monitoring get configmap my-dashboard -o yaml | grep -A 2 labels

# Check sidecar logs
kubectl -n monitoring logs deployment/prometheus-grafana -c grafana-sc-dashboard

# Check Grafana API
curl -u admin:<password> 'http://localhost:3000/api/search?query='
```

### Dashboard shows "Datasource not found"

- Verify `"datasource": "Prometheus"` (exact name, case-sensitive)
- Check datasource exists: `curl -u admin:<password> 'http://localhost:3000/api/datasources'`

### Panels show "No data"

1. Test the query in Prometheus UI first:
   ```bash
   kubectl -n monitoring port-forward svc/prometheus-kube-prometheus-prometheus 9090:9090
   # Visit http://localhost:9090/graph
   ```
2. Check the metric exists: `/targets` (is the exporter scraped?)
3. Verify the PromQL syntax

### Changes not applying

- Re-run `helm upgrade` after editing JSON files
- The sidecar watches ConfigMaps, not the local filesystem

## Deployment

This chart is installed by `devops/setup-kube.sh`:

```bash
helm install grafana-dashboards grafana-dashboards --namespace monitoring
```

To update:

```bash
helm upgrade grafana-dashboards devops/grafana-dashboards --namespace monitoring
```

## Related Documentation

- **Monitoring stack overview:** `/MONITORING_STACK.md`
- **Alerting inventory:** `/documentation/alerting.md`
- **Kafka consumer-lag alerting:** `/documentation/kafka-consumer-lag-alerting.md`
- **Legacy dashboards (reference only):** `/devops/grafana/dashboards/`
