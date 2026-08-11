# Helm Charts Research Findings

## 1. grafana/promtail Chart

### Chart Metadata
- **Chart Version**: 6.17.1
- **App Version**: 3.5.1
- **Repository**: grafana (Grafana official Helm charts)

### Configuration Keys - CONFIRMED

#### Loki Push URL Configuration
- **Key Path**: `config.clients`
- **Format**: Array of objects with `url` property
- **Default Value**:
  ```yaml
  config:
    clients:
      - url: http://loki-gateway/loki/api/v1/push
  ```
- **Must-Have Property**: Each client object requires `url` field
- **Note**: The key is NOT `config.lokiAddress` — it is `config.clients` with url sub-field

#### Extra Scrape Configs
- **Key Path**: `config.snippets.extraScrapeConfigs`
- **Format**: String (YAML-formatted, passed through template)
- **Default Value**: Empty string `""`
- **Location**: Found at `config.snippets.extraScrapeConfigs`
- **Usage**: Any additional scrape jobs (like kafka) go here as a multi-line string

#### Full Config Structure
```yaml
config:
  enabled: true
  logLevel: info
  logFormat: logfmt
  serverPort: 3101
  clients:
    - url: http://loki-gateway/loki/api/v1/push
  positions:
    filename: /run/promtail/positions.yaml
  enableTracing: false
  snippets:
    pipelineStages:
      - cri: {}
    common:
      # ... common relabel configs
    addScrapeJobLabel: false
    extraLimitsConfig: ""
    extraServerConfigs: ""
    extraScrapeConfigs: ""  # ADD KAFKA JOB HERE
    extraRelabelConfigs: []
    scrapeConfigs: |
      - job_name: kubernetes-pods
        # ... standard k8s scrape config
```

### Recommended devops/promtail.yaml Values

```yaml
# Override Loki push URL and add Kafka scrape job
config:
  clients:
    - url: http://loki:3100/loki/api/v1/push
  snippets:
    extraScrapeConfigs: |
      - job_name: kafka
        kafka:
          use_incoming_timestamp: true
          brokers: [kafka-headless.default.svc.cluster.local:29092]
          group_id: loki
          topics: [vlab-prod-payment, vlab-prod-response, ^promtail.*]
          labels: {job: kafka}
        relabel_configs:
          - {action: replace, source_labels: [__meta_kafka_topic], target_label: topic}
          - {action: replace, source_labels: [__meta_kafka_partition], target_label: partition}
          - {action: replace, source_labels: [__meta_kafka_group_id], target_label: group}
```

### Key Observations
1. The `clients` is an array — can specify multiple Loki instances if needed
2. `extraScrapeConfigs` is a string that gets templated — preserve YAML formatting
3. The chart uses Grafana's official Loki-compatible configuration patterns
4. No breaking changes expected between minor versions in 6.x

---

## 2. prometheus-community/kube-prometheus-stack Chart

### Chart Metadata
- **Chart Version**: 81.5.0
- **App Version (Prometheus Operator)**: v0.88.1
- **Bundled Grafana**: Deployed as sub-chart (included as dependency)
- **Repository**: prometheus-community (Prometheus Community Helm Charts)

### Configuration Keys - CONFIRMED

#### Additional Datasources Configuration
- **Key Path**: `grafana.additionalDataSources`
- **Format**: Array of datasource configuration objects
- **Default Value**: Empty array `[]`
- **Templating**: Values are passed through `tpl` function (supports Helm templating)
- **Alternative Path**: `grafana.additionalDataSourcesString` for templated string format

#### Datasource Format (Grafana Provisioning)
Each datasource object follows Grafana's provisioning format:
- `name` - Display name in Grafana
- `type` - Datasource type (e.g., `prometheus`, `loki`, `jaeger`)
- `url` - Connection URL
- `access` - Access mode (`proxy` or `direct`)
- `orgId` - Grafana organization (typically `1`)
- `jsonData` - Additional settings as JSON
- `basicAuth` - Boolean to enable basic auth
- `secureJsonData` - Sensitive auth data (password, tokens)
- `editable` - Boolean whether datasource can be modified in UI
- `version` - Integer version number

### Recommended devops/prometheus/values.yaml - grafana.additionalDataSources

```yaml
# Add Loki datasource alongside default Prometheus
grafana:
  additionalDataSources:
    - name: Loki
      type: loki
      url: http://loki:3100
      access: proxy
      orgId: 1
      editable: true
      jsonData:
        maxLines: 1000
```

### Complete Example with All Options
```yaml
grafana:
  additionalDataSources:
    - name: Loki
      type: loki
      url: http://loki:3100
      access: proxy
      orgId: 1
      editable: true
      version: 1
      jsonData:
        maxLines: 1000
        tlsSkipVerify: false
```

### Key Observations
1. The `additionalDataSources` is a **list** — can add multiple datasources
2. The format is standard Grafana datasource provisioning YAML
3. Supports Helm templating if needed: `url: http://{{ .Release.Name }}-loki:3100`
4. For Loki specifically:
   - `type: loki` (not `prometheus`)
   - Standard Loki URL format: `http://<service>:3100`
   - `access: proxy` is recommended (Grafana backend connects)
5. The chart also includes `grafana.deleteDatasources` list for cleanup
6. Provisioning is automatic — no additional setup needed

### Helm Chart Dependencies
The kube-prometheus-stack includes these bundled components:
- Prometheus Operator (v0.88.1)
- Grafana (version managed by sub-chart)
- Alertmanager
- Node Exporter
- kube-state-metrics
- Prometheus instances

### Integration Notes
- Grafana is deployed by the sub-chart automatically when `grafana.enabled: true`
- Datasources are provisioned on pod startup
- Changes to `additionalDataSources` require pod restart
- The provisioning happens via ConfigMap volume mounts (managed by Helm)

---

## Summary Comparison

| Aspect | promtail | kube-prometheus-stack |
|--------|----------|----------------------|
| Chart Version | 6.17.1 | 81.5.0 |
| Loki Config | `config.clients[].url` | N/A (Grafana datasource) |
| Scrape Configs | `config.snippets.extraScrapeConfigs` | N/A (not applicable) |
| Grafana Datasources | N/A (promtail doesn't provision) | `grafana.additionalDataSources[]` |
| Format | YAML/String | YAML Array of Objects |
| Key Finding | Kafka job goes in `extraScrapeConfigs` string | Loki datasource added via `grafana.additionalDataSources` |

---

## Implementation Ready

Both charts are ready for configuration. The exact key paths and formats have been confirmed through official Helm values inspection.

### For promtail.yaml:
- Override `config.clients[0].url` to point to Loki
- Add Kafka scrape job to `config.snippets.extraScrapeConfigs`

### For prometheus/values.yaml:
- Add Loki datasource to `grafana.additionalDataSources` array
- Supports Loki URL templating if needed for multi-environment setups
