# Grafana Loki Helm Chart Research Findings

**Date**: 2026-04-18
**Chart Version**: 6.52.0
**Loki App Version**: 3.6.4

## Executive Summary

The Grafana Loki Helm chart (v6.52.0, app v3.3.4) supports three deployment modes:
- **SingleBinary** (0 replicas by default) - for small installations up to 10s of GB/day
- **SimpleScalable** (default) - for medium installations up to ~1TB/day
- **Distributed** - for large installations >1TB/day

For your requirements (single binary, filesystem storage, 30-day retention, no auth, no gateway), the chart provides the necessary configuration keys and defaults.

---

## 1. Deployment Mode: SingleBinary

### Key Finding
The chart uses `deploymentMode: SimpleScalable` by default. To switch to SingleBinary, you need:

```yaml
deploymentMode: SingleBinary

singleBinary:
  replicas: 1  # Set to 1 to enable single binary deployment
```

**Location**: Top-level `deploymentMode` key in values.yaml

### What It Does
- Creates a single StatefulSet that runs all Loki components (ingester, querier, distributor, etc.)
- Good for small installations, testing, and development
- Default replicas is 0 (disabled), so you must explicitly set `replicas: 1`

---

## 2. Filesystem Storage Backend

### Key Finding
The chart supports filesystem storage via the `loki.storage_config.filesystem` section:

```yaml
loki:
  storage_config:
    filesystem:
      chunks_directory: /var/loki/chunks
      rules_directory: /var/loki/rules
```

**Critical**: For SingleBinary deployments, filesystem storage requires persistent volume. The chart creates a StatefulSet with a PVC automatically.

### Storage Configuration Path
The default storage is configured in `loki.config` template which references `loki.storage_config`. For filesystem:
- Must NOT use `use_thanos_objstore: true`
- Set object storage type via the `loki.storage` section
- The `filesystem` block under `storage_config` defines chunk and rules directories

### Persistence (PVC)
For SingleBinary with filesystem storage:

```yaml
singleBinary:
  persistence:
    enabled: true        # Enable persistent volume
    accessModes:
      - ReadWriteOnce
    size: 100Gi         # Adjust based on 30-day retention needs
    storageClass: null  # Uses default storage class if null
```

**Location**: `singleBinary.persistence.*` keys

---

## 3. Retention Period (30 days = 720h)

### Key Finding
Loki has **two separate retention mechanisms**:

#### A. Sample Rejection (limits_config)
Controls which logs are accepted into Loki:

```yaml
loki:
  limits_config:
    reject_old_samples: true
    reject_old_samples_max_age: 168h  # 7 days by default
```

**For 30-day retention, set this to 720h**:
```yaml
loki:
  limits_config:
    reject_old_samples: true
    reject_old_samples_max_age: 720h  # 30 days
```

This prevents old samples from being ingested, but doesn't delete existing data.

#### B. Compaction-Based Deletion (tableManager + compactor)
For actual deletion of old data:

```yaml
tableManager:
  enabled: true
  retention_deletes_enabled: true
  retention_period: 720h  # 30 days

loki:
  compactor:
    # Configuration for the compactor to enable deletion
    working_directory: /var/loki/compactor
    compaction_interval: 10m
    # retention_enabled needs to be set in compactor config
```

**Default State**: Both `tableManager.enabled` and `tableManager.retention_deletes_enabled` default to `false`!

### Important Caveat
- The chart defaults to `useTestSchema: false`
- Loki **requires** a proper `schemaConfig` for retention to work with filesystem storage
- For TSDB (Thanos storage), retention uses compactor
- For boltdb_shipper (older), retention uses table-manager

**Recommendation**: Use test schema for simple filesystem deployments, or provide a minimal `schemaConfig`.

---

## 4. Auth Disabled

### Key Finding
Disabling authentication is straightforward:

```yaml
loki:
  auth_enabled: false
```

**Default**: `auth_enabled: true`

**Location**: `loki.auth_enabled` at the top level of loki config section.

When auth is disabled:
- No tenant isolation
- No authentication required for API access
- Tenants list is ignored

---

## 5. Disable Gateway, Expose Loki Service Directly on Port 3100

### Key Finding
The gateway is **enabled by default** and acts as a reverse proxy in front of Loki.

To disable the gateway and expose the Loki service directly:

```yaml
gateway:
  enabled: false
```

### Service Details
When gateway is disabled, the Loki service is exposed directly:
- **Service Name**: `loki` (from `include "loki.name"`)
- **Port**: 3100 (HTTP)
- **gRPC Port**: 9095

For SingleBinary deployments with gateway disabled:
```yaml
singleBinary:
  service:
    type: "ClusterIP"
    # Service will be named: <release-name>-loki
    # or just 'loki' if no release name override
```

**Grafana Datasource Compatibility**: The service on port 3100 is compatible with Grafana's Loki datasource. Datasource URL would be:
- `http://loki:3100` (if in same namespace)
- `http://loki.logging:3100` (with namespace)

---

## 6. Service and Component Configuration

### Loki Server Settings
```yaml
loki:
  server:
    http_listen_port: 3100
    grpc_listen_port: 9095
    http_server_read_timeout: 600s
    http_server_write_timeout: 600s
```

These are hardcoded in the template and match Grafana's expectations.

### SingleBinary Service Type
```yaml
singleBinary:
  service:
    type: "ClusterIP"  # Default, good for in-cluster access
    # Or "LoadBalancer" or "NodePort" if external access needed
```

---

## 7. Compactor Configuration

### Compactor for Retention
For filesystem-based retention to work, the compactor must be enabled:

```yaml
compactor:
  replicas: 1  # Enable at least 1 replica
  persistence:
    enabled: true
    claims:
      - name: data
        size: 10Gi
        accessModes:
          - ReadWriteOnce
```

**Default**: `replicas: 0` (disabled)

The compactor needs persistent storage for its working directory.

---

## 8. Schema Configuration

### Current Defaults
The chart defaults to:
```yaml
loki:
  schemaConfig: {}  # Empty - no schema defined!
  useTestSchema: false
```

**For filesystem storage + compaction to work**, you need either:

**Option A**: Enable test schema (simplest)
```yaml
loki:
  useTestSchema: true
  testSchemaConfig:
    configs:
      - from: 2024-04-01
        store: tsdb
        object_store: filesystem  # For filesystem storage
        schema: v13
        index:
          prefix: index_
          period: 24h
```

**Option B**: Provide custom schemaConfig
```yaml
loki:
  schemaConfig:
    configs:
      - from: 2026-04-18
        store: tsdb
        object_store: filesystem
        schema: v13
        index:
          prefix: index_
          period: 24h
```

---

## 9. Authentication & Tenants

### Key Configuration
```yaml
loki:
  auth_enabled: false  # Disables all auth
  tenants: []          # No tenants configured
```

When auth is disabled:
- Tenants list is irrelevant
- No OIDC, OAuth2, or basic auth available
- All requests treated as the same tenant

---

## 10. Image Configuration

### Chart Defaults
```yaml
loki:
  image:
    registry: docker.io
    repository: grafana/loki
    tag: 3.6.4  # Matches chart's appVersion
    pullPolicy: IfNotPresent
```

Chart version 6.52.0 bundles Loki app version 3.6.4.

---

## Complete Configuration Summary

### Minimal Values for SingleBinary + Filesystem + 30-day Retention

```yaml
# Deployment mode
deploymentMode: SingleBinary

# Global auth
loki:
  auth_enabled: false

  # Server settings (defaults to 3100/9095)
  server:
    http_listen_port: 3100
    grpc_listen_port: 9095

  # Sample retention (30 days)
  limits_config:
    reject_old_samples: true
    reject_old_samples_max_age: 720h

  # Storage: filesystem
  storage_config:
    filesystem:
      chunks_directory: /var/loki/chunks
      rules_directory: /var/loki/rules

  # Schema (required for retention)
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

  # Compactor for actual data deletion
  compactor:
    working_directory: /var/loki/compactor
    compaction_interval: 10m
    retention_enabled: true
    retention_grace_period: 0h

# SingleBinary deployment
singleBinary:
  replicas: 1

  persistence:
    enabled: true
    accessModes:
      - ReadWriteOnce
    size: 100Gi  # Adjust for 30-day retention
    storageClass: null  # Use default

  service:
    type: ClusterIP

# Table manager for retention (optional but recommended)
tableManager:
  enabled: true
  retention_deletes_enabled: true
  retention_period: 720h

# Disable gateway
gateway:
  enabled: false

# Disable components not needed for SingleBinary
distributor:
  replicas: 0
ingester:
  replicas: 0
querier:
  replicas: 0
query_frontend:
  replicas: 0
query_scheduler:
  replicas: 0
compactor:
  replicas: 1  # Keep for retention
indexGateway:
  replicas: 0
ruler:
  replicas: 0
```

---

## Key Risks & Considerations

1. **No Schema = No Compaction**: Without a proper `schemaConfig`, the compactor cannot delete old data even if configured.

2. **Retention is Soft + Hard**:
   - Soft: `reject_old_samples_max_age` prevents NEW old samples
   - Hard: Compactor actually deletes old data (requires table-manager or compactor config)
   - Both needed for true 30-day window

3. **PVC Sizing**: 100Gi is a starting point; adjust based on:
   - Log volume (GB/day)
   - Retention period (30 days)
   - Compression ratio (~3-5:1 typical)

4. **No Gateway = Direct Exposure**: Clients must hit `http://loki:3100` directly. No reverse proxy, auth, or routing layer.

5. **StatefulSet Requirement**: Filesystem storage with SingleBinary requires StatefulSet (not Deployment) to maintain persistent identity.

---

## Files Referenced in Chart

- `loki.config` template: Dynamically builds Loki config from values
- `singleBinary` section: StatefulSet and service for single-binary deployment
- `loki.storage_config.*`: All storage backends
- `tableManager.*`: Retention deletion configuration
- `compactor.*`: Compaction and retention settings

---

## Validation Checklist

- [ ] `deploymentMode: SingleBinary` set
- [ ] `singleBinary.replicas: 1` set
- [ ] `loki.auth_enabled: false` set
- [ ] `gateway.enabled: false` set
- [ ] `singleBinary.persistence.enabled: true` set
- [ ] `singleBinary.persistence.size` adequate for data + 30 days
- [ ] `loki.limits_config.reject_old_samples_max_age: 720h` set
- [ ] `loki.useTestSchema: true` or proper `schemaConfig` provided
- [ ] `tableManager.enabled: true` and `retention_deletes_enabled: true` set
- [ ] `tableManager.retention_period: 720h` set
- [ ] Service port verification: `loki:3100` accessible
