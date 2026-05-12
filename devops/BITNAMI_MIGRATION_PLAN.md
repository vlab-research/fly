# Bitnami Migration Plan

## Executive Summary

**Why migrate away from Bitnami?**
- Broadcom acquired Bitnami and announced that starting **August 28th, 2025**, most container images will require a commercial subscription ($50,000-$72,000/year)
- Helm charts and container source code remain open under Apache 2.0, but without active maintenance
- The community is actively migrating to alternatives

**Current Bitnami dependencies in vlab-research:**
1. **Kafka** (v22.0.1) - Development only, production uses Banzaicloud/Koperator
2. **Redis** (v18.0.0) - Both development and production
3. **MinIO** (OCI registry) - Both development and production

**Data Loss Considerations:**
| Service | Data Criticality | Migration Complexity |
|---------|------------------|---------------------|
| Kafka | **Critical** - Must preserve all messages | Requires MirrorMaker2 |
| Redis | Cache only - Data loss acceptable | Simple swap |
| MinIO | Temporary data - Can be recreated | Simple swap |

---

## Service 1: Kafka

### Current Setup
- **Development**: Bitnami Kafka v22.0.1 with Zookeeper dependency
- **Production**: Banzaicloud Koperator (archived March 2025)
- **Topics**: Multiple topics with varying partitions (6-48) and replication factors
- **Retention**: 31 days

### Koperator Status
The Banzaicloud Koperator repository was **archived on March 26, 2025**. The project maintainers recommend migrating to [Adobe's fork](https://github.com/adobe/koperator).

### Decision: Stay on Adobe Koperator (For Now)

**Immediate Action:** Migrate from archived Banzaicloud Koperator to Adobe's actively maintained fork.

| Aspect | Details |
|--------|---------|
| Repository | https://github.com/adobe/koperator |
| Compatibility | Direct drop-in replacement for Banzaicloud Koperator |
| Maintenance | Adobe actively maintaining |

**Why stay on Koperator:**
- Minimal disruption to production
- Adobe fork is actively maintained
- Allows time to properly plan Strimzi migration
- Fine-grained broker configuration (non-StatefulSet architecture)
- Cruise Control integration for auto-scaling

### Future Migration: Koperator to Strimzi

When ready to migrate to Strimzi (CNCF-backed, largest community), use **MirrorMaker2** for zero data loss:

#### Migration Strategy: MirrorMaker2

```
┌─────────────────┐     MirrorMaker2      ┌─────────────────┐
│   Koperator     │ ──────────────────►   │    Strimzi      │
│   (Source)      │   Real-time sync      │   (Target)      │
└─────────────────┘                       └─────────────────┘
        │                                         │
        ▼                                         ▼
   Producers ─────── migrate ──────────►    Producers
   Consumers ─────── migrate ──────────►    Consumers
```

**Migration Steps:**
1. Deploy Strimzi cluster alongside existing Koperator cluster
2. Deploy MirrorMaker2 to replicate all topics in real-time
3. Verify data sync and lag metrics
4. Migrate consumers first (read from new Strimzi cluster)
5. Migrate producers (write to new Strimzi cluster)
6. Monitor for stability period
7. Decommission Koperator cluster and MirrorMaker2

**Strimzi Benefits (for future reference):**
- CNCF sandbox project with largest community
- KRaft mode eliminates Zookeeper dependency (since v0.46)
- Extensive documentation and enterprise features included
- Long-term viability assured

### Development Kafka

For development, continue using Bitnami until August 2025, then migrate to Strimzi. Development can serve as a practice run for the production Strimzi migration.

---

## Service 2: Redis

### Current Setup
- **Development (fly)**: Standalone, no auth, 1Gi storage
- **Staging**: Replication (1 replica), 2Gi storage, pd-ssd
- **Production**: Replication (1 replica), 8Gi storage, pd-ssd, metrics enabled
- **Dependents**: replybot connects via `gbv-redis-master:6379`
- **Data Criticality**: Cache only - data loss is acceptable

### Migration Approach
Since Redis is used as a cache with no persistence requirements:
1. Deploy new Redis solution
2. Update connection strings
3. Delete old Bitnami Redis
4. Cache rebuilds naturally

**No data migration needed.**

### Alternatives (Choose One for Both Dev and Prod)

#### Option A: DandyDeveloper redis-ha (Recommended)
**Mature community chart - battle-tested**

| Aspect | Details |
|--------|---------|
| Repository | https://dandydeveloper.github.io/charts |
| Current Version | 4.35.3 |
| HA Mode | Master/Slave with Sentinel sidecars |
| Images | Official Redis images (not Bitnami) |

**Pros:**
- VSHN chose this after extensive evaluation for failover capabilities
- Uses official Redis images, no vendor dependency
- HAProxy support for external access
- Prometheus metrics exporter available
- Battle-tested (migrated from official helm/stable)
- Proven, stable, well-understood technology

**Cons:**
- Different values structure than Bitnami
- Traditional Redis architecture

**Installation:**
```bash
helm repo add dandydev https://dandydeveloper.github.io/charts
helm install redis dandydev/redis-ha
```

#### Option B: Dragonfly Operator
**Modern Redis alternative with 25x performance**

| Aspect | Details |
|--------|---------|
| Repository | https://github.com/dragonflydb/dragonfly-operator |
| Compatibility | Redis & Memcached API compatible |
| Performance | 25x throughput, 80% less resources |

**Pros:**
- Drop-in Redis replacement (API compatible)
- Dramatically better performance (25x throughput)
- 80% less resource consumption
- Modern architecture designed for cloud
- Active development with Kubernetes Operator GA
- Auto-failover with operator
- Vertical scaling up to 1TB in-memory

**Cons:**
- Newer project (less battle-tested than traditional Redis)
- Some edge cases with Redis compatibility may exist
- Requires validation with replybot usage patterns
- Horizontal scaling under active development

**Installation:**
```bash
kubectl apply -f https://raw.githubusercontent.com/dragonflydb/dragonfly-operator/main/manifests/dragonfly-operator.yaml
```

### Recommendation

**Option A (DandyDeveloper redis-ha)** is the safer choice:
- Proven technology, minimal risk
- Well-understood failure modes
- Direct Redis, guaranteed compatibility

**Option B (Dragonfly)** is worth considering if:
- Performance is a concern
- You want to reduce resource costs
- You're willing to validate compatibility with replybot first

**Decision Required:** Choose one option for both development and production environments.

---

## Service 3: MinIO

### Current Setup
- **Development (fly)**: Bitnami chart, local ingress, inline credentials
- **Production**: Bitnami OCI chart, `storage.vlab.digital`, external secrets
- **Dependents**: exporter uses MinIO for data export storage
- **Data Criticality**: Temporary data - can be recreated

### Migration Approach
Since MinIO stores temporary data that can be recreated:
1. Deploy new MinIO Operator
2. Create buckets with matching names
3. Update connection strings/ingress
4. Delete old Bitnami MinIO

**No data migration needed.**

### Recommendation: Official MinIO Operator

| Aspect | Details |
|--------|---------|
| Repository | https://operator.min.io/ |
| Maintained By | MinIO Inc. |
| Minimum K8s | 1.30.0+ (as of v7.1.1) |
| Helm Version | 3.17+ recommended |

**Why MinIO Operator:**
- Official MinIO support and maintenance
- Production-ready with tenant management
- Regular updates and security patches
- Console UI included
- MinIO explicitly recommends Operator for production

**Installation:**
```bash
# Install the Operator
helm repo add minio https://operator.min.io/
helm install minio-operator minio/operator \
  --namespace minio-operator \
  --create-namespace

# Create a Tenant
helm install minio-tenant minio/tenant \
  --namespace minio-tenant \
  --create-namespace
```

---

## Migration Priority

### Urgency Assessment

| Service | Urgency | Reason | Action |
|---------|---------|--------|--------|
| **Koperator** | HIGH | Archived March 2025 | Switch to Adobe fork immediately |
| **Redis** | MEDIUM | August 2025 Bitnami deadline | Plan migration Q2 2025 |
| **MinIO** | MEDIUM | August 2025 Bitnami deadline | Plan migration Q2 2025 |
| **Kafka (Dev)** | LOW | Development only | Migrate with or after prod Strimzi |

### Recommended Migration Order

1. **Phase 1: Adobe Koperator** (Immediate)
   - Update Helm references to Adobe's fork
   - Minimal changes, drop-in replacement
   - Validates production stability

2. **Phase 2: Redis** (Before August 2025)
   - Choose between redis-ha or Dragonfly
   - Deploy new solution
   - Update replybot connection strings
   - Cache rebuilds automatically

3. **Phase 3: MinIO** (Before August 2025)
   - Deploy MinIO Operator
   - Create tenant with matching bucket names
   - Update ingress and connection settings
   - Data recreates as needed

4. **Phase 4: Strimzi Migration** (When Ready)
   - Deploy Strimzi alongside Koperator
   - Set up MirrorMaker2
   - Migrate consumers, then producers
   - Decommission Koperator

---

## Implementation Checklist

### Phase 1: Adobe Koperator
- [ ] Update Helm chart references to Adobe fork
- [ ] Test in staging environment
- [ ] Deploy to production
- [ ] Verify all topics and consumers functioning

### Phase 2: Redis Migration
- [ ] Decide: DandyDeveloper redis-ha OR Dragonfly
- [ ] If Dragonfly: Test Redis API compatibility with replybot
- [ ] Deploy chosen solution in development
- [ ] Update connection strings in replybot (dev)
- [ ] Validate cache operations
- [ ] Deploy to staging/production
- [ ] Update connection strings in replybot (prod)
- [ ] Remove Bitnami Redis

### Phase 3: MinIO Migration
- [ ] Deploy MinIO Operator in development
- [ ] Create tenant with required buckets
- [ ] Update ingress configuration
- [ ] Update exporter connection settings
- [ ] Deploy to production
- [ ] Update production ingress (`storage.vlab.digital`)
- [ ] Remove Bitnami MinIO

### Phase 4: Strimzi Migration (Future)
- [ ] Deploy Strimzi Operator in staging
- [ ] Create Kafka cluster with matching topic configuration
- [ ] Deploy MirrorMaker2
- [ ] Verify replication lag is acceptable
- [ ] Migrate consumers to Strimzi
- [ ] Migrate producers to Strimzi
- [ ] Monitor stability (1-2 weeks recommended)
- [ ] Decommission Koperator cluster
- [ ] Remove MirrorMaker2

---

## Configuration Examples

### DandyDeveloper redis-ha

**Development:**
```yaml
# values-redis-ha-dev.yaml
replicas: 1

redis:
  port: 6379
  resources:
    requests:
      memory: 64Mi
      cpu: 50m
    limits:
      memory: 128Mi
      cpu: 100m

sentinel:
  port: 26379

haproxy:
  enabled: false

persistentVolume:
  enabled: true
  size: 1Gi

auth: false
```

**Production:**
```yaml
# values-redis-ha-prod.yaml
replicas: 3

redis:
  port: 6379
  resources:
    requests:
      memory: 256Mi
      cpu: 250m
    limits:
      memory: 512Mi
      cpu: 500m

sentinel:
  port: 26379
  resources:
    requests:
      memory: 64Mi
      cpu: 50m

haproxy:
  enabled: true
  replicas: 2

persistentVolume:
  enabled: true
  storageClass: pd-ssd
  size: 8Gi

auth: true
existingSecret: gbv-redis

exporter:
  enabled: true
  serviceMonitor:
    enabled: true
```

### Dragonfly Operator

**Development:**
```yaml
# dragonfly-dev.yaml
apiVersion: dragonflydb.io/v1alpha1
kind: Dragonfly
metadata:
  name: fly-cache
spec:
  replicas: 1
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 100m
      memory: 128Mi
```

**Production:**
```yaml
# dragonfly-prod.yaml
apiVersion: dragonflydb.io/v1alpha1
kind: Dragonfly
metadata:
  name: gbv-cache
spec:
  replicas: 2  # 1 primary + 1 replica for HA
  resources:
    requests:
      cpu: 250m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi
  args:
    - "--maxmemory=400mb"
```

### MinIO Operator Tenant

**Development:**
```yaml
# minio-tenant-dev.yaml
apiVersion: minio.min.io/v2
kind: Tenant
metadata:
  name: fly-storage
  namespace: minio
spec:
  image: minio/minio:latest
  pools:
    - servers: 1
      volumesPerServer: 1
      volumeClaimTemplate:
        spec:
          resources:
            requests:
              storage: 10Gi
  mountPath: /export
  requestAutoCert: false
```

**Production:**
```yaml
# minio-tenant-prod.yaml
apiVersion: minio.min.io/v2
kind: Tenant
metadata:
  name: vlab-storage
  namespace: minio
spec:
  image: minio/minio:latest
  pools:
    - servers: 4
      volumesPerServer: 4
      volumeClaimTemplate:
        spec:
          storageClassName: standard-rwo
          resources:
            requests:
              storage: 10Gi
  mountPath: /export
  requestAutoCert: false
  features:
    bucketDNS: false
  env:
    - name: MINIO_PROMETHEUS_URL
      value: "http://prometheus-kube-prometheus-prometheus.monitoring.svc.cluster.local:9090"
```

### Strimzi Kafka (Future Reference)

**Development:**
```yaml
# strimzi-kafka-dev.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaNodePool
metadata:
  name: dual-role
  labels:
    strimzi.io/cluster: fly-kafka
spec:
  replicas: 1
  roles:
    - controller
    - broker
  storage:
    type: persistent-claim
    size: 1Gi
---
apiVersion: kafka.strimzi.io/v1beta2
kind: Kafka
metadata:
  name: fly-kafka
  annotations:
    strimzi.io/node-pools: enabled
    strimzi.io/kraft: enabled
spec:
  kafka:
    version: 3.8.0
    listeners:
      - name: plain
        port: 9092
        type: internal
        tls: false
      - name: external
        port: 9094
        type: nodeport
        tls: false
    config:
      offsets.topic.replication.factor: 1
      transaction.state.log.replication.factor: 1
      transaction.state.log.min.isr: 1
  entityOperator:
    topicOperator: {}
```

### MirrorMaker2 (For Kafka Migration)

```yaml
# mirrormaker2.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaMirrorMaker2
metadata:
  name: koperator-to-strimzi
spec:
  version: 3.8.0
  replicas: 1
  connectCluster: "strimzi-target"
  clusters:
    - alias: "koperator-source"
      bootstrapServers: kafka-headless.default.svc.cluster.local:29092
    - alias: "strimzi-target"
      bootstrapServers: fly-kafka-kafka-bootstrap:9092
      config:
        config.storage.replication.factor: 1
        offset.storage.replication.factor: 1
        status.storage.replication.factor: 1
  mirrors:
    - sourceCluster: "koperator-source"
      targetCluster: "strimzi-target"
      sourceConnector:
        config:
          replication.factor: 1
          offset-syncs.topic.replication.factor: 1
          sync.topic.acls.enabled: "false"
      heartbeatConnector:
        config:
          heartbeats.topic.replication.factor: 1
      checkpointConnector:
        config:
          checkpoints.topic.replication.factor: 1
      topicsPattern: ".*"
      groupsPattern: ".*"
```

---

## Sources

### General Bitnami Migration
- [Bitnami Deprecation Announcement - Northflank](https://northflank.com/blog/bitnami-deprecates-free-images-migration-steps-and-alternatives)
- [Migrating Away from Bitnami - Medium](https://medium.com/@PlanB./migrating-away-from-bitnami-alternatives-challenges-and-lessons-learned-78b94a1c8302)

### Kafka
- [Strimzi Documentation](https://strimzi.io/docs/operators/latest/deploying)
- [Strimzi GitHub](https://github.com/strimzi/strimzi-kafka-operator)
- [Koperator Archived Notice](https://github.com/banzaicloud/koperator)
- [Adobe Koperator Fork](https://github.com/adobe/koperator)

### Redis
- [DandyDeveloper redis-ha](https://github.com/DandyDeveloper/charts/tree/master/charts/redis-ha)
- [VSHN ADR on Redis Alternative](https://kb.vshn.ch/app-catalog/adr/0038-appcat-redis-alternative.html)
- [Dragonfly Kubernetes Operator](https://www.dragonflydb.io/kubernetes)
- [Dragonfly GitHub](https://github.com/dragonflydb/dragonfly-operator)

### MinIO
- [MinIO Operator Documentation](https://min.io/docs/minio/kubernetes/upstream/operations/install-deploy-manage/deploy-operator-helm.html)
- [MinIO Operator GitHub](https://github.com/minio/operator)
