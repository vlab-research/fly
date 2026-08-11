# Loki Helm Chart Quick Reference

**Chart**: grafana/loki
**Chart Version**: 6.52.0
**Loki App Version**: 3.6.4
**Service Name**: `loki` (or `<release>-loki` with helm release)
**Service Port**: 3100 (HTTP), 9095 (gRPC)

---

## Configuration Keys for Your Requirements

### 1. Single Binary / Monolithic Mode
```yaml
deploymentMode: SingleBinary
singleBinary:
  replicas: 1
```
**Why**: Sets deployment mode to single-binary and enables 1 replica. Default is `SimpleScalable` with 0 replicas.

---

### 2. Filesystem Storage Backend
```yaml
loki:
  storage_config:
    filesystem:
      chunks_directory: /var/loki/chunks
      rules_directory: /var/loki/rules
```
**Why**: Directs Loki to use filesystem instead of S3/GCS. Must enable persistence on SingleBinary StatefulSet.

---

### 3. Persistence / PVC Size
```yaml
singleBinary:
  persistence:
    enabled: true
    accessModes:
      - ReadWriteOnce
    size: 100Gi
    storageClass: null
```
**Why**: Creates PVC for filesystem storage. Default size is 10Gi; adjust for your 30-day retention needs.

---

### 4. Retention Period (30 days = 720h)
```yaml
# Soft retention (reject old samples at write time)
loki:
  limits_config:
    reject_old_samples: true
    reject_old_samples_max_age: 720h

# Hard retention (delete old data via compaction)
tableManager:
  enabled: true
  retention_deletes_enabled: true
  retention_period: 720h

compactor:
  replicas: 1
```
**Why**:
- `reject_old_samples_max_age: 720h` prevents 30+ day old logs from being written
- `tableManager` + `compactor` actually deletes old data
- Both needed for true 30-day retention window

---

### 5. Authentication: DISABLED
```yaml
loki:
  auth_enabled: false
```
**Why**: No tenants, no auth required, all requests treated as same tenant.

---

### 6. Disable Gateway (Direct Loki on Port 3100)
```yaml
gateway:
  enabled: false
```
**Why**: Removes nginx reverse proxy. Clients connect directly to Loki service on port 3100.

---

### 7. Schema Configuration (REQUIRED)
```yaml
loki:
  useTestSchema: true
  testSchemaConfig:
    configs:
      - from: 2026-04-01
        store: tsdb
        object_store: filesystem
        schema: v13
        index:
          prefix: index_
          period: 24h
```
**Why**: Compactor needs schema config to work. Test schema is sufficient for filesystem storage.

---

## Service Details

| Property | Value | Notes |
|----------|-------|-------|
| Service Name | `loki` | Use `<release>-loki` if helm release name differs |
| HTTP Port | 3100 | Standard Loki port |
| gRPC Port | 9095 | For internal communication |
| Service Type | ClusterIP | Default; change to LoadBalancer for external access |
| Grafana URL | `http://loki:3100` | Add datasource with this URL |

---

## Validation: Verify These Are Set Correctly

```bash
# Deployment mode
deploymentMode: SingleBinary

# Service access
loki:3100  # Should be accessible from Grafana pod

# Retention set correctly
reject_old_samples_max_age: 720h
retention_period: 720h

# Storage type
storage_config.filesystem  # Should exist
persistence.enabled: true  # Should be true

# Auth disabled
auth_enabled: false

# Gateway disabled
gateway.enabled: false

# Compactor enabled
compactor.replicas: 1
tableManager.enabled: true
tableManager.retention_deletes_enabled: true
```

---

## Helm Install Command

```bash
helm install loki grafana/loki \
  --namespace logging \
  --create-namespace \
  -f /path/to/loki-values-validated.yaml
```

---

## Troubleshooting

| Issue | Check |
|-------|-------|
| Data not being deleted after 30 days | Verify `compactor.replicas: 1` and `tableManager.retention_deletes_enabled: true` |
| Old samples still accepted | Verify `reject_old_samples_max_age: 720h` |
| Service not accessible on 3100 | Verify `gateway.enabled: false` and `singleBinary.service.type: ClusterIP` |
| PVC fills up too quickly | Increase `singleBinary.persistence.size` based on log volume |
| Compaction not running | Verify `compactor.persistence.enabled: true` and compactor has storage |
| Grafana can't connect | Verify datasource URL is `http://loki:3100` and Grafana is in same namespace |
