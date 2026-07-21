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
└── templates/
    ├── kafka-consumer-health-cm.yaml   # ConfigMap for consumer health dashboard
    └── kafka-broker-app-health-cm.yaml # ConfigMap for broker/app health dashboard
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
