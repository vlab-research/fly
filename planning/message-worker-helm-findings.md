# Message-Worker Helm Integration Findings

**Investigation Date:** 2026-03-22
**Scope:** Helm chart structure, Kafka configuration, and message-worker subchart integration

## Executive Summary

The fly project uses an **umbrella Helm chart** (`devops/vlab/Chart.yaml`) that manages multiple microservices as subcharts. Each service lives in its own directory with a `chart/` subdirectory. The system uses Bitnami's Kafka chart (v22.0.1) with topic definitions in the umbrella chart's templates. Message-worker is not yet added to the umbrella chart but has a prepared chart definition on the `feat/rust-replybot-migration` branch.

**Key Integration Points:**
- Umbrella chart: `/home/nandan/Documents/vlab-research/fly/devops/vlab/Chart.yaml`
- Values per environment: `/home/nandan/Documents/vlab-research/fly/devops/values/{production,staging}.yaml`
- Kafka topics defined in: `/home/nandan/Documents/vlab-research/fly/devops/vlab/templates/topics.yaml` (via KafkaTopic CRD)
- Message-worker chart ready: `feat/rust-replybot-migration:message-worker/chart/`

---

## 1. Umbrella Chart Architecture

### Overview
The project uses a **Helm umbrella chart** pattern where:
- **Parent chart:** `devops/vlab/` acts as a coordinator
- **Subcharts:** Individual services (replybot, botserver, dashboard, scribble, dinersclub, etc.) are referenced as dependencies
- **Environment values:** Each environment (dev, staging, production) has separate value files

### Current Subcharts (19 dependencies)

**OCI Registry (GCP Artifact Registry):**
```
oci://us-west1-docker.pkg.dev/toixotoixo/vlab-research/charts
```

| Service | Version | Tags | Notes |
|---------|---------|------|-------|
| replybot | 0.0.1 | - | Always deployed |
| botserver | 0.0.2 | - | Always deployed |
| linksniffer | 0.0.2 | - | Always deployed |
| dashboard | 0.0.2 | - | Always deployed |
| formcentral | 0.0.1 | - | Always deployed |
| dinersclub | 0.0.1 | payments | Optional (payments tag) |
| dean | 0.0.3 | dean | Optional |
| scribble | 0.0.1 | scribble | Optional |
| dumper | 0.0.3 | backup | Optional |
| exporter | 0.1.0 | exporter | Optional |
| exodus | 0.1.0 | - | Always deployed |
| naughtybot | 0.0.1 | naughtybot | From https://vlab-research.github.io/fly |
| botscribe | 0.0.1 | botscribe | From https://vlab-research.github.io/fly |
| scratchbot | 0.0.1 | scratchbot | From https://vlab-research.github.io/fly |
| cockroachdb | 10.0.4 | cockroach | External dependency, condition: cockroachdb.enabled |
| kafka | 22.0.1 | kafka | External dependency, condition: kafka.enabled |
| redis | 18.0.0 | redis | External dependency, condition: redis.enabled |

**TODO:** Charts for naughtybot, botscribe, and scratchbot should be migrated to OCI registry but are currently missing.

### Adding a New Subchart: The Process

**File:** `/home/nandan/Documents/vlab-research/fly/devops/vlab/Chart.yaml`

To add message-worker as a subchart:
1. Add entry to `dependencies:` section with name, version, and repository
2. Set tags if the service is optional (e.g., `tags: [messaging]`)
3. Set `condition:` if deployment should be conditional on a flag
4. Build and push chart to OCI registry via Helm package + push
5. Run `helm dependency update` in `devops/vlab/` to refresh Chart.lock
6. Add service-specific values to each environment file

---

## 2. Values and Configuration Structure

### Root Values File
**Location:** `/home/nandu/Documents/vlab-research/fly/devops/vlab/values.yaml`
- Nearly empty (delegated to environment-specific overrides)
- Example content shows it's primarily for local/dev:
  ```yaml
  cockroachdb:
    enabled: true
  kafka:
    enabled: true  # Note: typo "kakfka" also present
  exodus:
    api:
      enabled: true
  ```

### Environment-Specific Values Files

**Production:** `/home/nandan/Documents/vlab-research/fly/devops/values/production.yaml` (737 lines)
**Staging:** `/home/nandu/Documents/vlab-research/fly/devops/values/staging.yaml` (610 lines)

Each file defines:
- **Global tags** (enable/disable optional services)
- **Kafka brokers endpoint** (YAML anchor for reuse)
- **Topic names** (YAML anchors for consistency across services)
- **Service versions** (pinned versions for each deployment)
- **Consumer group names** and alerting rules
- **Service-specific env vars** (e.g., CHATBASE_HOST, REDIS_HOST, etc.)

### Global Kafka Configuration Anchors

**Production:**
```yaml
kafkabrokers: &kb "kafka-headless.default.svc.cluster.local:29092"
chatTopic: &topic "vlab-prod-chat-events"
stateTopic: &statetopic "vlab-prod-state"
responseTopic: &responsetopic "vlab-prod-response"
paymentTopic: &paymenttopic "vlab-prod-payment"
exporterTopic: &exportertopic "vlab-exports"
chatLogTopic: &chatlogtopic "vlab-prod-chat-log"
```

**Staging:**
```yaml
kafkabrokers: &kb "kafka-headless.default.svc.cluster.local:29092"
chatTopic: &topic "vlab-staging-chat-events"
stateTopic: &statetopic "vlab-staging-state"
responseTopic: &responsetopic "vlab-staging-response"
paymentTopic: &paymenttopic "vlab-staging-payment"
exporterTopic: &exportertopic "vlab-staging-exports"
chatLogTopic: &chatlogtopic "vlab-staging-chat-log"
```

**Pattern:** Kafka brokers use internal DNS, topic names are prefixed with environment (vlab-prod-, vlab-staging-).

### Kafka Integration Values File

**Location:** `/home/nandan/Documents/vlab-research/fly/devops/values/integrations/kafka.yaml`

Defines Kafka provisioning for local dev (used when kafka.enabled=true):
- Broker image: `3.4.0-debian-11-r22`
- Auto-create disabled; explicit topic provisioning enabled
- Topics with partitions and replication factor (for local: 6 partitions, 1 replication)
- Retention: 14 days (1209600000 ms)
- Topics provisioned:
  - chat-events (6 partitions)
  - vlab-state (6 partitions)
  - vlab-response (6 partitions)
  - vlab-payment (2 partitions)
  - vlab-exports (2 partitions)

---

## 3. Kafka Topic Configuration

### Topic Definition Mechanism

**File:** `/home/nandan/Documents/vlab-research/fly/devops/vlab/templates/topics.yaml`

Uses **Banzai Cloud Kafka Operator's KafkaTopic CRD** to dynamically create topics:

```yaml
{{- if not .Values.tags.kafka  }}
{{- range .Values.kafkaTopics }}
apiVersion: kafka.banzaicloud.io/v1alpha1
kind: KafkaTopic
metadata:
  annotations:
    managedBy: koperator
  name: {{ $.Release.Name }}-topic-{{ .name }}
  namespace: default
spec:
  clusterRef:
    name: kafka
  {{- toYaml . | nindent 2 }}
```

**Conditional:** Topics are only created when `tags.kafka` is NOT set (i.e., not using Bitnami's Kafka, but external Kafka operator).

### Topic Definitions in Production

**Location:** `/home/nandan/Documents/vlab-research/fly/devops/values/production.yaml` lines 65-95

Topics are defined in `kafkaTopics` array with full specs:

```yaml
kafkaTopics:
  - name: vlab-prod-chat-events
    partitions: 48
    replicationFactor: 3
    config:
      "retention.ms": "2678400000"  # 31 days

  - name: vlab-prod-state
    partitions: 12
    replicationFactor: 3
    config:
      "retention.ms": "2678400000"

  - name: vlab-prod-response
    partitions: 12
    replicationFactor: 3
    config:
      "retention.ms": "2678400000"

  - name: vlab-prod-payment
    partitions: 2
    replicationFactor: 3
    config:
      "retention.ms": "2678400000"

  - name: vlab-exports
    partitions: 2
    replicationFactor: 2
    config:
      "retention.ms": "2678400000"

  - name: vlab-prod-chat-log
    partitions: 12
    replicationFactor: 3
    config:
      "retention.ms": "2678400000"
```

**Pattern:** Larger topics (chat-events, state, response, chat-log) get 12-48 partitions for parallelism. Small topics (payment, exports) get 2 partitions.

### Monitoring & Alerting Configuration

**Location:** `/home/nandu/Documents/vlab-research/fly/devops/values/production.yaml` lines 33-63

Two types of alerts defined:

1. **Processing Alerts:** Watch for lag in message processing
   ```yaml
   processingAlerts:
     - consumergroup: replybot
       topic: vlab-prod-chat-events
       window: "8h"
       limit: "1"
   ```

2. **Lagging Consumer Alerts:** Monitor consumer lag across multiple groups
   ```yaml
   laggingAlerts:
     - consumergroup: replybot
       alertname: LaggingConsumerReplybot
       window: "5m"
       limit: "20"
     - consumergroup: scribble-responses
       alertname: LaggingConsumerScribbleResponses
       window: "5m"
       limit: "200"
     # ... more consumer groups
   ```

---

## 4. Existing Services: Pattern Reference

### Service Configuration Pattern

Each service follows a consistent pattern in the values file. Example from **dinersclub**:

```yaml
dinersclub:
  replicaCount: 1                    # Deployment replicas
  image:
    repository: vlabresearch/dinersclub
    tag: *vdinersclub               # Version anchor from globals
    pullPolicy: IfNotPresent
  resources:
    requests:
      cpu: 5m
      memory: 16Mi
  envFrom: gbv-bot-envs             # Reference to ConfigMap/Secret for bulk env vars
  env:                              # Individual env vars override/supplement envFrom
    - name: KAFKA_BROKERS
      value: *kb                    # Reuse broker anchor
    - name: KAFKA_TOPIC
      value: *paymenttopic          # Topic anchor
    - name: KAFKA_GROUP
      value: "dinersclub"           # Consumer group name
    - name: CACHE_TTL
      value: "1h"
    # ... more service-specific vars
```

### Consumer Group Naming Convention

Pattern: `{service-name}` or `{service-name}-{sink}`

Examples:
- `replybot` → consumer group "replybot"
- `dinersclub` → consumer group "dinersclub"
- `scribble-states` → scribble service listening to state topic
- `scribble-responses` → scribble service listening to response topic
- `scribble-messages` → scribble service listening to chat-events topic
- `scribble-chat-log` → scribble service listening to chat-log topic

### Scribble Pattern: Multiple Sinks from One Service

**Location:** `/home/nandu/Documents/vlab-research/fly/devops/values/production.yaml` lines 234-313

Scribble is a multi-sink service defined in the values:

```yaml
scribble:
  image:
    repository: vlabresearch/scribble
    tag: *vscribble
  sinks:
    - destination: "states"
      replicaCount: 1
      env:
        - name: KAFKA_TOPIC
          value: *statetopic
        - name: KAFKA_GROUP
          value: "scribble-states"
    - destination: "responses"
      replicaCount: 1
      env:
        - name: KAFKA_TOPIC
          value: *responsetopic
        - name: KAFKA_GROUP
          value: "scribble-responses"
    # ... more sinks
```

This allows a single Helm chart to deploy multiple consumer groups from different Kafka topics.

---

## 5. Message-Worker Chart Reference

### Chart Prepared on feat/rust-replybot-migration

**Git path:** `message-worker/chart/`

**Chart.yaml:**
```yaml
apiVersion: v2
name: message-worker
description: Go-based message translation worker for vlab chatbot system
type: application
version: 0.1.1
appVersion: "0.1.0"
keywords:
  - chatbot
  - state-machine
  - kafka
  - rust
```

**Default values.yaml:**
```yaml
replicaCount: 2
image:
  repository: vlabresearch/message-worker
  tag: 0.1.0
  pullPolicy: IfNotPresent
envFrom: "gbv-bot-envs"
env:
  - name: KAFKA_BROKERS
    value: "kafka-headless.default.svc.cluster.local:29092"
  - name: LOG_LEVEL
    value: "info"
  - name: HEALTH_PORT
    value: "8081"
  - name: BOTSERVER_URL
    value: "http://gbv-botserver"
resources:
  requests:
    cpu: 50m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi
```

**Templates:**
- `deployment.yaml` — Pod spec with Prometheus annotations, preStop lifecycle hook for graceful shutdown
- `_helpers.tpl` — Standard label helpers

**Key Deployment Features:**
- Prometheus metrics scraping enabled (port 8080, path /metrics)
- Security context: `runAsNonRoot: true`, `runAsUser: 1000`, `fsGroup: 1000`
- Graceful shutdown: preStop hook with 15s sleep + terminationGracePeriodSeconds: 30
- Health port: 8081 (separate from metrics)

---

## 6. Service Discovery & Networking

### Kafka Broker Connectivity

**Internal DNS name:** `kafka-headless.default.svc.cluster.local:29092`

This is the Kubernetes headless service provided by Bitnami's Kafka chart. All services in the cluster use this single broker address, regardless of whether they run in development or production.

### Inter-Service Communication

Services communicate via Kubernetes DNS names, NOT IP addresses:

**Examples from production values:**
- `http://gbv-botserver` — References botserver Helm release
- `http://gbv-formcentral` — References formcentral Helm release
- `http://gbv-redis-master` — References Redis master
- `gbv-cockroachdb-public` — References CockroachDB

**Pattern:** Service names are constructed as `{release-name}-{service-name}` where release name is the Helm release being deployed.

---

## 7. Local Development Setup

### Kind Cluster Configuration

**Location:** `/home/nandu/Documents/vlab-research/fly/devops/dev/kind-cluster.yaml`

Setup script available: `/home/nandu/Documents/vlab-research/fly/devops/dev/kind-with-registry.sh`

**Features:**
- Kubernetes version: 1.29.2 (stable)
- Local container registry on `localhost:5000`
- 3 nodes: 1 control-plane + 2 workers
- Port mappings:
  - 80/443 → Ingress controller
  - 30092 → Kafka external access
  - 32432 → CockroachDB

### Development Workflow

**From `/home/nandu/Documents/vlab-research/fly/devops/README.md`:**

```bash
# Set up Kind cluster and deploy services
make dev

# Run integration tests
make dev-integration-tests

# Watch test logs
kubectl logs -f -l app=testrunner --tail -1
```

### Helm Chart Publishing

**Chart update workflow:**

1. Update chart files in `{service}/chart/`
2. Increment version in `Chart.yaml`
3. Build package:
   ```bash
   helm package chart
   ```
4. Push to OCI registry (requires gcloud auth):
   ```bash
   helm push {service}-{version}.tgz oci://us-west1-docker.pkg.dev/toixotoixo/vlab-research/charts
   ```
5. Update umbrella chart dependency:
   ```bash
   cd devops/vlab/
   helm dependency update
   ```

**Important:** OCI tags are immutable—cannot overwrite an existing version.

---

## 8. Environment Files & Secrets

### Environment Configuration Files

**Dev environment values:**
- `/home/nandu/Documents/vlab-research/fly/devops/values/integrations/` — Integration-specific overrides
  - `cdb.yaml` — CockroachDB overrides
  - `kafka.yaml` — Kafka Bitnami provisioning
  - `minio.yaml` — MinIO overrides
  - `fly.yaml` — Fly-specific integrations

**Environment files in `/home/nandu/Documents/vlab-research/fly/devops/dev/`:**
- `.env` — Local dev environment variables
- `.env-secret` — Secret credentials for local dev
- `.env-prod` — Example production environment

### ConfigMap for Shared Environment Variables

Services reference `gbv-bot-envs` ConfigMap/Secret via `envFrom: gbv-bot-envs`:
- Contains shared credentials and API keys
- Bulk-loaded into all bot services
- Individual env vars can override via `env:` section

---

## 9. Identified Gaps & Issues

### 1. Message-Worker Not Yet Integrated
- Chart exists on `feat/rust-replybot-migration` branch
- Not yet added to umbrella chart dependencies
- Requires Kafka topic definition once integrated

### 2. Typo in Default values.yaml
- `/home/nandu/Documents/vlab-research/fly/devops/vlab/values.yaml` line 7: `kakfka:` should be `kafka:`
- Minor, doesn't affect deployments (environment-specific values override)

### 3. OCI Chart Registry Migration Incomplete
- naughtybot, botscribe, scratchbot still use GitHub Pages repository
- Should be migrated to `oci://us-west1-docker.pkg.dev/toixotoixo/vlab-research/charts`
- Requires chart source code to be found/updated

### 4. Kafka Topic Naming Inconsistency
- Most topics use prefix: `vlab-{env}-{topic}` (e.g., `vlab-prod-chat-events`)
- Exporter topic does NOT follow pattern: `vlab-exports` (no environment prefix)
- Should be: `vlab-prod-exports`, `vlab-staging-exports` for consistency

### 5. Prometheus Metrics Not Unified
- Deployment templates show Prometheus annotations but no ServiceMonitor definitions
- Makes metrics scraping depend on autodiscovery settings
- Should have explicit ServiceMonitor CRDs for reliability

### 6. Health Check Port Separation
- Message-worker defines separate HEALTH_PORT (8081) and metrics port (8080)
- Other services don't have explicit health checks defined
- Could standardize across all services

---

## 10. Adding Message-Worker: Step-by-Step Guide

### Step 1: Define Kafka Topic (if needed)

Add to **production.yaml** in `kafkaTopics` array (if message-worker needs its own topic):

```yaml
kafkaTopics:
  # ... existing topics ...
  - name: vlab-prod-messages          # if needed
    partitions: 6
    replicationFactor: 3
    config:
      "retention.ms": "2678400000"    # 31 days
```

And add topic anchor at the top:
```yaml
messageTopic: &messagetopic "vlab-prod-messages"
```

### Step 2: Add to Umbrella Chart

**File:** `/home/nandu/Documents/vlab-research/fly/devops/vlab/Chart.yaml`

Add to `dependencies:` section (after exodus, before naughtybot):

```yaml
  - name: message-worker
    version: 0.1.1
    repository: oci://us-west1-docker.pkg.dev/toixotoixo/vlab-research/charts
```

Then run:
```bash
cd devops/vlab/
helm dependency update
```

### Step 3: Add Service Configuration to Production Values

**File:** `/home/nandu/Documents/vlab-research/fly/devops/values/production.yaml`

Add after exodus section (around line 650):

```yaml
messageWorker:
  replicaCount: 2
  image:
    repository: vlabresearch/message-worker
    tag: v0.1.0                       # Pin version
    pullPolicy: IfNotPresent
  resources:
    requests:
      cpu: 50m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi
  env:
    - name: KAFKA_BROKERS
      value: *kb
    - name: LOG_LEVEL
      value: "info"
    - name: HEALTH_PORT
      value: "8081"
    - name: BOTSERVER_URL
      value: "http://gbv-botserver"
    # Add any message-worker specific env vars here
```

### Step 4: Add Service Configuration to Staging Values

**File:** `/home/nandu/Documents/vlab-research/fly/devops/values/staging.yaml`

Add similar configuration (adjust replicaCount, resource limits, etc. for staging):

```yaml
messageWorker:
  replicaCount: 1                     # Fewer replicas for staging
  image:
    repository: vlabresearch/message-worker
    tag: v0.1.0
    pullPolicy: Always                # Always pull in staging
  resources:
    requests:
      cpu: 50m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi
  env:
    - name: KAFKA_BROKERS
      value: *kb
    - name: LOG_LEVEL
      value: "debug"                  # More verbose logging in staging
    - name: HEALTH_PORT
      value: "8081"
    - name: BOTSERVER_URL
      value: "http://gbv-botserver"
```

### Step 5 (Optional): Add Monitoring Alert

If message-worker consumes from a Kafka topic, add to lagging alerts in **production.yaml**:

```yaml
laggingAlerts:
  # ... existing alerts ...
  - consumergroup: message-worker
    alertname: LaggingConsumerMessageWorker
    window: "5m"
    limit: "20"                       # Alert if lag > 20 messages
```

### Step 6: Deploy and Test

```bash
# Update dependencies
helm dependency update

# Deploy to staging
helm upgrade --install gbv devops/vlab/ \
  -f devops/values/staging.yaml \
  --namespace default

# Verify pod is running
kubectl get pods -l app.kubernetes.io/name=message-worker

# Check logs
kubectl logs -l app.kubernetes.io/name=message-worker -f
```

---

## 11. Key Files Reference

| File | Purpose |
|------|---------|
| `/devops/vlab/Chart.yaml` | Umbrella chart with all dependencies |
| `/devops/vlab/values.yaml` | Base values (mostly empty) |
| `/devops/values/production.yaml` | Production environment config (737 lines) |
| `/devops/values/staging.yaml` | Staging environment config (610 lines) |
| `/devops/values/integrations/kafka.yaml` | Kafka Bitnami provisioning |
| `/devops/vlab/templates/topics.yaml` | Dynamic Kafka topic creation |
| `/devops/dev/kind-cluster.yaml` | Local Kind cluster config |
| `/devops/dev/kind-with-registry.sh` | Kind setup script with registry |
| `/devops/README.md` | Deployment and chart update instructions |
| `{service}/chart/Chart.yaml` | Individual service chart metadata |
| `{service}/chart/templates/deployment.yaml` | Pod spec template |
| `{service}/chart/templates/_helpers.tpl` | Label helpers |

---

## 12. Architecture Diagram

```
devops/vlab/ (Umbrella Chart)
├── Chart.yaml (19 dependencies)
├── values.yaml (delegated)
├── templates/
│   └── topics.yaml (KafkaTopic CRD)
└── charts/
    ├── replybot/ (via OCI)
    ├── botserver/ (via OCI)
    ├── dashboard/ (via OCI)
    ├── scribble/ (via OCI, multi-sink)
    ├── dinersclub/ (via OCI)
    ├── message-worker/ (TO BE ADDED)
    ├── kafka/ (Bitnami)
    ├── redis/ (Bitnami)
    └── cockroachdb/ (External)

devops/values/
├── production.yaml ← PRODUCTION CONFIG
├── staging.yaml ← STAGING CONFIG
└── integrations/
    ├── kafka.yaml
    ├── cdb.yaml
    └── minio.yaml

Kafka Topics in Production:
├── vlab-prod-chat-events (48 partitions)
├── vlab-prod-state (12 partitions)
├── vlab-prod-response (12 partitions)
├── vlab-prod-payment (2 partitions)
├── vlab-exports (2 partitions, no prefix!)
└── vlab-prod-chat-log (12 partitions)

Consumer Groups:
├── replybot
├── dinersclub
├── scribble-states
├── scribble-responses
├── scribble-messages
├── scribble-chat-log
└── exporter
```

---

## 13. Recommendations

### For Message-Worker Integration

1. **Use standard pattern** — Follow dinersclub/dean pattern (simple single-topic consumer)
2. **Define Kafka topic** — Add to kafkaTopics in production.yaml (recommend 6 partitions for chat processing)
3. **Use YAML anchors** — Reuse broker and topic anchors for consistency
4. **Add monitoring** — Include in laggingAlerts in production.yaml
5. **Graceful shutdown** — Keep preStop hook with sleep (allows Kafka commit before termination)
6. **Separate health port** — Maintain 8081 for health, separate from metrics (8080)

### For Future Improvements

1. **Fix typo** — Correct `kakfka:` to `kafka:` in `/devops/vlab/values.yaml`
2. **Unify topic naming** — Rename `vlab-exports` to `vlab-prod-exports` / `vlab-staging-exports`
3. **Add ServiceMonitor CRDs** — Create explicit ServiceMonitor resources for Prometheus
4. **Migrate charts** — Move naughtybot, botscribe, scratchbot to OCI registry
5. **Health checks** — Standardize liveness/readiness probes across all services
6. **Consumer group alerting** — Ensure all Kafka consumers have lagging alerts

---

## Investigation Notes

- Tested with `git show` on `feat/rust-replybot-migration` branch to inspect message-worker chart
- Kafka topics use **Banzai Cloud Kafka Operator** (KafkaTopic CRD) for production, **Bitnami Kafka** for local dev
- All service communication uses Kubernetes DNS, allowing seamless development-to-production transition
- Environment-specific values enable single chart to deploy across dev/staging/production with different resource allocation and replica counts
- Scribble pattern (multiple sinks) provides template for services consuming multiple topics
