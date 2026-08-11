# Monitoring Stack Fresh Install

## Context

The monitoring stack (`loki` + `prometheus` Helm releases) is broken and abandoned:
- Loki has been in CrashLoopBackOff for 6+ days (PVC full, 124K corrupt WAL segments)
- Grafana is pinned to v7.4.2 (2021), alerting is not in use
- Both charts (`grafana/loki-stack` 2.6.5, `kube-prometheus-stack` 39.0.0) are 3+ years old and use deprecated APIs (PodSecurityPolicy), making `helm upgrade` broken
- Prometheus storage is only 20Gi

Goal: Nuke and reinstall with current charts, 30-day Loki retention, proper Loki datasource provisioning, and correct storage sizing. No data is being preserved (user confirmed OK to lose logs and metrics history).

**Reference files** (created by chart research, keep for reference):
- `planning/loki-values-validated.yaml` — full annotated loki values
- `planning/helm-charts-research-findings.md` — promtail + kube-prometheus-stack findings

---

## Pre-work (before any teardown)

### 1. Save alertmanager secret locally

Save the Slack webhook config so it can be recreated after reinstall:

```bash
kubectl get secret alertmanager -n monitoring -o yaml > devops/alertmanager-secret.local.yaml
```

Add `*.local.yaml` to `.gitignore` (if not already). This file contains the Slack webhook URL and must NOT be committed.

### 2. Check current loki chart values structure

Before editing `devops/loki.yaml`, verify the values schema for whatever version is current at install time:

```bash
helm repo update
helm show values grafana/loki | head -100
```

The `grafana/loki` chart has changed significantly across major versions (v3→v5→v6). The values snippet in Step 3 below is a starting point — adjust to match the actual schema.

---

## Step 1: Tear down existing stack

```bash
helm uninstall loki -n monitoring
helm uninstall prometheus -n monitoring

# Delete all PVCs in monitoring namespace
kubectl delete pvc --all -n monitoring
```

### CRD cleanup (important)

Helm does not delete CRDs on uninstall. The old `monitoring.coreos.com` CRDs will remain and may conflict with the new chart's CRD versions. Check and clean up:

```bash
kubectl get crd | grep monitoring.coreos.com

# If the new install fails with CRD conflict errors, delete them first:
kubectl delete crd \
  alertmanagerconfigs.monitoring.coreos.com \
  alertmanagers.monitoring.coreos.com \
  podmonitors.monitoring.coreos.com \
  probes.monitoring.coreos.com \
  prometheuses.monitoring.coreos.com \
  prometheusrules.monitoring.coreos.com \
  servicemonitors.monitoring.coreos.com \
  thanosrulers.monitoring.coreos.com
```

Note: Deleting CRDs also deletes all custom resources of those types (PrometheusRules, ServiceMonitors, etc.) — but those will be recreated in Step 4.

Note: The vprod-namespace PrometheusRules (`prometheus-consumer-*`) are also CRD instances and will be deleted. They will need to be reapplied via the `devops/vlab` Helm chart after reinstall.

---

## Step 2: Update devops/prometheus/values.yaml

**File**: `devops/prometheus/values.yaml`

Key changes from current values:
- Remove pinned Grafana version (`tag: 7.4.2`) — let chart use its default (Grafana 11.x)
- Add Loki datasource provisioning under `grafana.additionalDataSources`
- Increase Prometheus storage from 20Gi → 50Gi
- Keep all other existing config (default rules, alertmanager secret reference, selector config)

Validated against kube-prometheus-stack chart v81.5.0.

```yaml
grafana:
  enabled: true
  # Remove the image.tag: 7.4.2 block entirely
  persistence:
    type: pvc
    enabled: true
    accessModes: [ReadWriteOnce]
    size: 5Gi
  sidecar:
    datasources:
      enabled: true
      defaultDatasourceEnabled: true
      annotations: {}
  additionalDataSources:
    - name: Loki
      type: loki
      url: http://loki:3100
      access: proxy
      orgId: 1
      editable: true
      jsonData:
        maxLines: 1000

prometheus:
  prometheusSpec:
    # keep existing selector config (ruleSelectorNilUsesHelmValues etc.)
    storage:
      volumeClaimTemplate:
        spec:
          accessModes: [ReadWriteOnce]
          resources:
            requests:
              storage: 50Gi
```

---

## Step 3: Replace devops/loki.yaml with split files

The old `devops/loki.yaml` used the bundled `loki-stack` chart. Split into two files:

### devops/loki.yaml (grafana/loki chart)

Validated against chart v6.52.0 (Loki 3.6.4). Full reference in `planning/loki-values-validated.yaml`.

```yaml
deploymentMode: SingleBinary

loki:
  auth_enabled: false

  commonConfig:
    replication_factor: 1

  storage_config:
    filesystem:
      chunks_directory: /var/loki/chunks
      rules_directory: /var/loki/rules

  # Required for retention to work — use tsdb schema v13
  useTestSchema: true
  testSchemaConfig:
    configs:
      - from: "2026-04-01"
        store: tsdb
        object_store: filesystem
        schema: v13
        index:
          prefix: index_
          period: 24h

  limits_config:
    reject_old_samples: true
    reject_old_samples_max_age: 720h

  compactor:
    working_directory: /var/loki/compactor
    retention_enabled: true
    shared_store: filesystem

  podSecurityContext:
    fsGroupChangePolicy: OnRootMismatch  # avoids slow chown on large volumes

singleBinary:
  replicas: 1
  persistence:
    enabled: true
    size: 200Gi

tableManager:
  enabled: true
  retention_deletes_enabled: true
  retention_period: 720h   # 30 days

compactor:
  replicas: 1

gateway:
  enabled: false  # Direct access on port 3100 — compatible with Grafana datasource url http://loki:3100

# Disable all multi-component replicas (not used in SingleBinary mode)
read:
  replicas: 0
write:
  replicas: 0
backend:
  replicas: 0

monitoring:
  selfMonitoring:
    enabled: false
    grafanaAgent:
      installOperator: false
```

> **Note**: If the install fails due to `storage.type` validation errors, add `loki.storage.type: filesystem` — some chart versions require it for template rendering even when using `storage_config.filesystem` directly.

### devops/promtail.yaml (grafana/promtail chart)

Validated against chart v6.17.1 (Promtail 3.5.1).

```yaml
config:
  clients:
    - url: http://loki:3100/loki/api/v1/push

  snippets:
    extraScrapeConfigs: |
      - job_name: kafka
        kafka:
          use_incoming_timestamp: true
          brokers:
          - kafka-headless.default.svc.cluster.local:29092
          group_id: loki
          topics:
          - vlab-prod-payment
          - vlab-prod-response
          - ^promtail.*
          labels:
            job: kafka
        relabel_configs:
          - action: replace
            source_labels: [__meta_kafka_topic]
            target_label: topic
          - action: replace
            source_labels: [__meta_kafka_partition]
            target_label: partition
          - action: replace
            source_labels: [__meta_kafka_group_id]
            target_label: group
```

---

## Step 4: Install in order

```bash
# 1. Update helm repos
helm repo update

# 2. Create alertmanager secret BEFORE installing prometheus
#    (prometheus values use useExistingSecret: true — alertmanager won't start without it)
kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f devops/alertmanager-secret.local.yaml

# 3. Install kube-prometheus-stack (includes Grafana, Prometheus, AlertManager)
helm install prometheus prometheus-community/kube-prometheus-stack \
  -n monitoring \
  -f devops/prometheus/values.yaml

# 4. Apply custom prometheus rules
kubectl apply -f devops/prometheus/rules/lag.yaml
kubectl apply -f devops/prometheus/rules/replybot.yaml
kubectl apply -f devops/kafka-operator/prod/kafka-prometheus.yaml

# 5. Install loki
helm install loki grafana/loki \
  -n monitoring \
  -f devops/loki.yaml

# 6. Install promtail
helm install promtail grafana/promtail \
  -n monitoring \
  -f devops/promtail.yaml

# 7. Reapply vprod alert rules (if CRDs were deleted in Step 1)
helm upgrade vlab devops/vlab -n vprod   # or however the vlab chart is deployed
```

---

## Files to modify

| File | Change |
|------|--------|
| `devops/prometheus/values.yaml` | Remove Grafana pin, add Loki datasource, bump Prometheus storage to 50Gi |
| `devops/loki.yaml` | Replace with grafana/loki chart values (30d retention, 200Gi PVC) |
| `devops/promtail.yaml` | New file — grafana/promtail chart with kafka config |
| `.gitignore` | Add `*.local.yaml` |

---

## kafka-exporter

The `kafka-exporter` Helm chart (`devops/kafka-exporter/`) is a separate release and does **not** need to be reinstalled — it runs independently of the monitoring stack. Its ServiceMonitor will be re-discovered automatically by the new Prometheus once it's running, since `serviceMonitorSelectorNilUsesHelmValues: false` is set.

If for some reason the ServiceMonitor is missing after reinstall:
```bash
helm upgrade --install kafka-exporter devops/kafka-exporter -n <kafka-exporter-namespace>
```

---

## Verification

1. `kubectl get pods -n monitoring` — all pods Running
2. Grafana accessible via ingress/port-forward — Loki datasource shows green (provisioned automatically)
3. Explore Logs in Grafana — confirm promtail is shipping logs
4. Check AlertManager UI — confirm Slack receiver is configured and `#vlab-alerts` channel receives a test alert
5. `kubectl get prometheusrule -n monitoring` — kafka-alerts and custom rules present
6. `kubectl get prometheusrule -n vprod` — per-app lag rules present (reapply vlab chart if missing)
7. Check Prometheus targets page — kafka-exporter ServiceMonitor showing up as a scrape target
