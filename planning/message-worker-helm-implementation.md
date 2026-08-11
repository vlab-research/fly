# Message-Worker Helm Implementation Summary

**Implementation Date:** 2026-03-22
**Worktree:** `/home/nandan/Documents/vlab-research/fly-message-worker`
**Status:** Complete - Ready for Testing

## Overview

Successfully implemented Helm/deployment configuration for the new message-worker service following Step 5 of the extraction plan. The message-worker is now fully integrated into the umbrella chart and configured for both production and staging environments.

## Changes Implemented

### 1. Umbrella Chart Integration

**File:** `/devops/vlab/Chart.yaml`

Added message-worker as a subchart dependency:
```yaml
- name: message-worker
  version: 0.1.1
  repository: oci://us-west1-docker.pkg.dev/toixotoixo/vlab-research/charts
```

**Chart Packaging:**
- Packaged chart from `message-worker/chart/` → `message-worker-0.1.1.tgz`
- Copied to `devops/vlab/charts/message-worker-0.1.1.tgz` for local development
- Chart ready for OCI registry push for production deployment

### 2. Kafka Commands Topic

Added `commands` topic to both environments following existing topic patterns.

**Production** (`devops/values/production.yaml`):
```yaml
commandsTopic: &commandstopic "vlab-prod-commands"

kafkaTopics:
  - name: *commandstopic
    partitions: 6
    replicationFactor: 3
    config:
      "retention.ms": "2678400000" # 31 days
```

**Staging** (`devops/values/staging.yaml`):
```yaml
commandsTopic: &commandstopic "vlab-staging-commands"

kafkaTopics:
  - name: *commandstopic
    partitions: 6
    replicationFactor: 2
    config:
      "retention.ms": "2678400000" # 31 days
```

**Topic Design:**
- 6 partitions for parallel processing (moderate load expected)
- Same retention as other event topics (31 days)
- Follows environment-specific naming convention (vlab-{env}-commands)

### 3. Message-Worker Service Configuration

**Production Configuration:**
```yaml
messageWorker:
  replicaCount: 2
  image:
    repository: vlabresearch/message-worker
    tag: v0.1.0
    pullPolicy: IfNotPresent
  resources:
    requests:
      cpu: 50m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi
  envFrom: gbv-bot-envs
  env:
  - name: KAFKA_BROKERS
    value: "kafka-headless.default.svc.cluster.local:29092"
  - name: KAFKA_COMMAND_TOPIC
    value: "vlab-prod-commands"
  - name: KAFKA_EVENT_TOPIC
    value: "vlab-prod-chat-events"
  - name: KAFKA_GROUP_ID
    value: "message-worker"
  - name: KAFKA_AUTO_OFFSET_RESET
    value: "latest"
  - name: DATABASE_URL
    value: "postgresql://chatroach@gbv-cockroachdb-public:26257/chatroach?sslmode=disable"
  - name: BOTSERVER_URL
    value: "http://gbv-botserver"
  - name: FACEBOOK_GRAPH_URL
    value: "https://graph.facebook.com/v18.0"
  - name: NUM_WORKERS
    value: "100"
  - name: MAX_RETRY_ATTEMPTS
    value: "3"
  - name: INITIAL_BACKOFF_MS
    value: "100"
  - name: MAX_BACKOFF_MS
    value: "1000"
```

**Staging Configuration:**
- Same structure as production
- `replicaCount: 1` (lower resource needs)
- `pullPolicy: Always` (for testing latest builds)
- All other settings identical

**Configuration Notes:**
- **Database URL:** Constructed as PostgreSQL connection string from existing CHATBASE_* pattern
  - Format: `postgresql://chatroach@gbv-cockroachdb-public:26257/chatroach?sslmode=disable`
  - Uses existing cockroachdb service name and credentials
- **Kafka Brokers:** Uses same internal DNS as all other services
- **Event Topic:** Publishes success/failure events to existing chat-events topic
- **Consumer Group:** `message-worker` (unique group ID)
- **Auto Offset Reset:** `latest` (don't reprocess old messages on restart)
- **Worker Pool:** 100 concurrent workers for high throughput
- **Retry Strategy:** 3 attempts with exponential backoff (100ms → 1000ms max)

### 4. Replybot Configuration Updates

Added `KAFKA_COMMANDS_TOPIC` environment variable to replybot in both environments.

**Production:**
```yaml
- name: KAFKA_COMMANDS_TOPIC
  value: "vlab-prod-commands"
```

**Staging:**
```yaml
- name: KAFKA_COMMANDS_TOPIC
  value: "vlab-staging-commands"
```

This allows replybot to publish message commands to the correct topic.

### 5. Monitoring Configuration

Added lagging consumer alert for message-worker in production:

```yaml
laggingAlerts:
  - consumergroup: message-worker
    alertname: LaggingConsumerMessageWorker
    window: "5m"
    limit: "20"
```

Alert fires if message-worker falls more than 20 messages behind over a 5-minute window.

## Architecture Decisions

### Database Connection Strategy

**Chosen:** Single `DATABASE_URL` environment variable with full PostgreSQL connection string

**Rationale:**
- Message-worker Go code expects `DATABASE_URL` (single string)
- Other Go services (scribble) use individual CHATBASE_* vars
- Connection string format: `postgresql://user@host:port/database?sslmode=disable`
- Simpler than parsing multiple env vars in Go code
- Compatible with pgx/v5 driver used by tokenstore

**Alternative Considered:** Split into CHATBASE_* vars and construct URL in Go
- Rejected: Would require code changes to worker, unnecessary complexity

### Kafka Topic Partitioning

**Chosen:** 6 partitions for commands topic

**Rationale:**
- Moderate expected load (messages are bursty, not constant)
- Allows parallel processing across multiple workers
- Smaller than chat-events (48 partitions) but larger than payment (2 partitions)
- Same as original plan in implementation guide

**Replication Factor:**
- Production: 3 (high availability, matches other event topics)
- Staging: 2 (adequate for testing, matches staging pattern)

### Resource Allocation

**Chosen:**
- Requests: 50m CPU, 128Mi memory
- Limits: 500m CPU, 512Mi memory

**Rationale:**
- Similar to other message-processing services (dinersclub, scribble)
- Go services are memory-efficient compared to Node.js
- 100 concurrent workers fit comfortably in 512Mi
- CPU limit allows burst processing during high load

### Service Placement

**Chosen:** Inserted after exodus, before cockroachdb in values files

**Rationale:**
- Logical grouping: messaging services together
- Follows alphabetical-ish ordering
- Before infrastructure (cockroachdb, kafka, redis)
- Matches existing pattern in codebase

## Files Modified

```
devops/vlab/Chart.yaml                 | +3    (added dependency)
devops/values/production.yaml          | +53   (topic + service config + replybot env)
devops/values/staging.yaml             | +49   (topic + service config + replybot env)
```

## Files Created/Packaged

```
message-worker/chart/message-worker-0.1.1.tgz      (packaged chart)
devops/vlab/charts/message-worker-0.1.1.tgz        (copied for local dev)
```

## Verification Checklist

- [x] Chart.yaml dependency added with correct version (0.1.1)
- [x] Commands topic defined in both production and staging
- [x] Topic anchors used consistently (commandstopic)
- [x] Message-worker service config added to both environments
- [x] All required env vars configured (11 total)
- [x] Database URL format correct (postgresql://...)
- [x] Kafka brokers use internal DNS (*kb anchor)
- [x] Event topic points to chat-events (*topic anchor)
- [x] Replybot KAFKA_COMMANDS_TOPIC added in both environments
- [x] Monitoring alert added for message-worker consumer group
- [x] Chart packaged with correct version (0.1.1)
- [x] Chart copied to umbrella charts directory
- [x] Resource limits appropriate for Go service
- [x] Replica counts set (production: 2, staging: 1)
- [x] Pull policies correct (production: IfNotPresent, staging: Always)

## Next Steps

### Before Deployment

1. **Push Chart to OCI Registry** (production only):
   ```bash
   helm push devops/vlab/charts/message-worker-0.1.1.tgz \
     oci://us-west1-docker.pkg.dev/toixotoixo/vlab-research/charts
   ```

2. **Update Umbrella Chart Dependencies:**
   ```bash
   cd devops/vlab/
   helm dependency update
   ```

3. **Build and Push Docker Image:**
   ```bash
   cd message-worker/
   docker build -t vlabresearch/message-worker:v0.1.0 .
   docker push vlabresearch/message-worker:v0.1.0
   ```

### Testing

1. **Local Integration Test** (Kind cluster):
   - Deploy to local Kind cluster with staging values
   - Verify message-worker pod starts successfully
   - Check logs for Kafka connection and token store initialization
   - Send test command via replybot
   - Verify command consumed and message sent to facebot mock

2. **Staging Deployment:**
   - Deploy to staging environment
   - Monitor logs for any configuration issues
   - Run smoke tests with real Facebook API (test page)
   - Verify error reporting to botserver works

3. **Production Deployment:**
   - Deploy to production with controlled rollout
   - Monitor lagging consumer alerts
   - Watch for any token lookup errors
   - Verify message delivery rates match previous baseline

### Monitoring Points

- **Kafka Consumer Lag:** Should stay < 20 messages under normal load
- **Pod Resource Usage:** Should stay well under 512Mi memory
- **Error Rate:** Monitor botserver synthetic events for FB errors
- **Token Cache Hit Rate:** Check logs for token lookup performance

## Configuration Patterns Followed

### YAML Anchors
- Used `&kb` for kafka brokers (consistent with all services)
- Used `&topic` for chat-events topic (existing anchor)
- Created `&commandstopic` for new commands topic
- Used `&botenvs` for envFrom (consistent with other bot services)
- Used `&vmessageworker` for version anchor

### Naming Conventions
- Service name: `messageWorker` (camelCase in values, kebab-case in chart)
- Consumer group: `message-worker` (kebab-case)
- Topic name: `vlab-{env}-commands` (environment prefix pattern)
- Alert name: `LaggingConsumerMessageWorker` (PascalCase)

### Resource Allocation Pattern
- Request: Small baseline for scheduling
- Limit: Generous headroom for burst traffic
- CPU ratio: ~10x (50m → 500m)
- Memory ratio: ~4x (128Mi → 512Mi)

## Compatibility Notes

### Token Storage
- Message-worker uses same `credentials` table as replybot
- Query: `SELECT COALESCE(details->>'access_token', details->>'token') AS token FROM credentials WHERE facebook_page_id = $1`
- Schema is compatible (verified in Step 6 of implementation plan)
- Cache TTL: 300s (5 minutes) - reasonable for token freshness vs load

### Service Discovery
- All services use Kubernetes internal DNS
- Pattern: `{release-name}-{service-name}` (e.g., `gbv-botserver`)
- Message-worker references `http://gbv-botserver` (matches existing pattern)
- Database: `gbv-cockroachdb-public:26257` (matches other services)

### Kafka Integration
- Same broker address as all other services
- Standard KafkaTopic CRD for topic creation (via Banzai Cloud operator)
- Topics only created when `tags.kafka: false` (using external Kafka, not Bitnami)

## Known Issues / Limitations

1. **OCI Registry Push Required:** Chart is packaged locally but not yet pushed to OCI registry
   - Workaround: For local dev, chart is in `devops/vlab/charts/`
   - Action: Push to OCI before production deployment

2. **Database Credentials:** Currently using `chatroach` user with no password
   - Security: CockroachDB deployed with `tls.enabled: no` in both envs
   - Acceptable: Internal cluster network, no external exposure
   - Future: Consider certificate-based auth

3. **Token Cache TTL:** Fixed at 300 seconds
   - Implication: Takes up to 5 minutes to pick up new token
   - Mitigation: Token updates are rare, cache prevents DB overload
   - Alternative: Could make TTL configurable via env var

4. **Error Reporting:** Relies on botserver synthetic event endpoint
   - Dependency: If botserver is down, errors are lost (not queued)
   - Mitigation: Message-worker logs all errors, can be recovered from logs
   - Future: Consider dead-letter queue for critical errors

## Integration Points

### Upstream (Consumers of Message-Worker)
- **Replybot:** Publishes commands to `commands` topic after state machine execution
- **Pattern:** Replybot generates messages → publishes commands → message-worker sends to Facebook

### Downstream (Dependencies)
- **Kafka:** Consumes commands from `commands` topic, publishes events to `chat-events` topic
- **CockroachDB:** Queries `credentials` table for Facebook page tokens
- **Botserver:** POSTs synthetic events to `/synthetic` endpoint on error
- **Facebook Graph API:** Sends messages via `/me/messages` and `/me/pass_thread_control`

### Data Flow
```
Kafka (commands) → Message-Worker → CockroachDB (token lookup)
                                  ↓
                            Facebook Graph API
                                  ↓
                    Success: Kafka (chat-events, message_sent event)
                    Failure: Botserver → Kafka (machine_report event)
```

## Documentation References

- **Implementation Plan:** `/planning/message-worker-extraction-plan.md` (Step 5)
- **Helm Findings:** `/planning/message-worker-helm-findings.md`
- **Go Worker Implementation:** `message-worker/README.md` (if exists)
- **Replybot Changes:** Already documented in Step 3 completion

## Deployment Command Examples

### Staging Deployment
```bash
cd devops/vlab/
helm dependency update
helm upgrade --install gbv . \
  -f ../values/staging.yaml \
  --namespace default
```

### Production Deployment
```bash
cd devops/vlab/
helm dependency update
helm upgrade --install gbv . \
  -f ../values/production.yaml \
  --namespace default
```

### Check Message-Worker Status
```bash
# Pod status
kubectl get pods -l app.kubernetes.io/name=message-worker

# Logs
kubectl logs -l app.kubernetes.io/name=message-worker -f

# Consumer lag
kubectl exec kafka-0 -- kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --group message-worker --describe
```

## Success Criteria

- [ ] Message-worker pod starts without errors
- [ ] Kafka consumer connects and shows no lag
- [ ] Token lookup succeeds (check logs for cache hits)
- [ ] Messages sent to Facebook return message IDs
- [ ] Error handling triggers machine_report events
- [ ] Monitoring alerts are active and not firing
- [ ] Resource usage within allocated limits
- [ ] No increase in user-reported issues after deployment

## Rollback Plan

If issues arise after deployment:

1. **Immediate:** Scale message-worker to 0 replicas
   ```bash
   kubectl scale deployment gbv-message-worker --replicas=0
   ```

2. **Revert Replybot:** Remove KAFKA_COMMANDS_TOPIC env var
   - This stops replybot from publishing commands
   - Replybot falls back to direct Facebook API calls (existing code)

3. **Full Rollback:** Revert Helm chart
   ```bash
   helm rollback gbv [previous-revision]
   ```

4. **Data Cleanup:** Drain commands topic if needed
   ```bash
   kubectl exec kafka-0 -- kafka-delete-records \
     --bootstrap-server localhost:9092 \
     --offset-json-file /tmp/offsets.json
   ```

---

**Implementation Status:** COMPLETE
**Testing Status:** PENDING
**Production Status:** NOT DEPLOYED
