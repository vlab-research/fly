# Message Worker Deployment Guide

## Overview

The Message Worker is a Go service that consumes message-sending commands from Kafka and forwards them to platform APIs (Facebook Messenger, WhatsApp, Instagram). It replaces the direct Facebook API calls that were previously embedded in Replybot.

**Phase 1 (current):** Replybot still formats messages as Facebook-native payloads. Message Worker forwards them as-is (passthrough mode). Only Messenger is supported. One worker thread.

**Architecture:**
```
Before:  Kafka events → Replybot → state machine → sendMessage() → Facebook API
After:   Kafka events → Replybot → state machine → publish commands → Kafka (commands topic)
                                                              ↓
                                                   Message Worker (Go)
                                                     ├─ type: "native" → POST /me/messages
                                                     └─ type: "pass_thread_control" → POST /me/pass_thread_control
                                                              ↓
                                                   Facebook Graph API
                                                              ↓
                                                   (on error) → botserver /synthetic → Kafka → Replybot
```

## Coordinated Deployment

**Critical:** Replybot and Message Worker must be deployed together. Replybot no longer calls the Facebook API directly — it publishes commands to Kafka. Without Message Worker running, messages will pile up in the commands topic unsent.

Both services need new Docker images:
- **Message Worker:** `ghcr.io/vlab-research/message-worker:v0.1.0` (new service)
- **Replybot:** `ghcr.io/vlab-research/replybot:v0.0.201` (code changed — `sendMessage`/`passThreadControl` deleted, `publishCommands` added)

## Deployment Steps

### 1. Build and Push Docker Images

Images are built by the CI pipeline (`release.yml`) when git tags are pushed:

```bash
# Tag and push to trigger CI builds
git tag message-worker-v0.1.0
git push origin message-worker-v0.1.0

git tag replybot-v0.0.201
git push origin replybot-v0.0.201
```

CI pushes to `ghcr.io/vlab-research/`. Verify images exist:
```bash
docker pull ghcr.io/vlab-research/message-worker:v0.1.0
docker pull ghcr.io/vlab-research/replybot:v0.0.201
```

### 2. Bump Replybot Version in Values Files

After the replybot image is built, update the version in both environment files:

```yaml
# devops/values/production.yaml
versionReplybot: &vreplybot v0.0.201

# devops/values/staging.yaml
versionReplybot: &vreplybot v0.0.201
```

### 3. Verify Helm Chart (Already Done)

The message-worker Helm chart (v0.1.1) has already been packaged and pushed to the OCI registry. The umbrella chart `Chart.yaml` and `Chart.lock` are current. No action needed.

### 4. Deploy to Staging First

```bash
helm upgrade --install gbv devops/vlab/ \
  -f devops/values/staging.yaml \
  --namespace default
```

Verify:
```bash
kubectl get pods -l app.kubernetes.io/name=message-worker
kubectl logs -l app.kubernetes.io/name=message-worker -f
```

### 5. Deploy to Production

```bash
helm upgrade --install gbv devops/vlab/ \
  -f devops/values/production.yaml \
  --namespace default
```

### 6. Create Kafka Topic (Production)

The `vlab-prod-commands` topic is defined in `production.yaml` under `kafkaTopics`. It will be created automatically by the Kafka operator during Helm deploy. Verify:

```bash
kubectl exec kafka-0 -- /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 --list | grep commands
```

## Configuration

### Kafka Topics

| Topic | Purpose | Partitions | Replication |
|-------|---------|------------|-------------|
| `vlab-prod-commands` | Replybot → Message Worker commands | 6 | 3 |
| `vlab-prod-chat-events` | Message Worker → event notifications | 48 | 3 (existing) |

### Key Environment Variables (Message Worker)

| Variable | Production Value | Notes |
|----------|-----------------|-------|
| `KAFKA_BROKERS` | `kafka-headless.default.svc.cluster.local:29092` | Same as all services |
| `KAFKA_COMMAND_TOPIC` | `vlab-prod-commands` | Input topic from replybot |
| `KAFKA_EVENT_TOPIC` | `vlab-prod-chat-events` | Output topic for events |
| `KAFKA_GROUP_ID` | `message-worker` | Consumer group |
| `KAFKA_AUTO_OFFSET_RESET` | `latest` | Only process new commands |
| `DATABASE_URL` | `postgresql://chatroach@gbv-cockroachdb-public:26257/chatroach?sslmode=disable` | For token lookup |
| `BOTSERVER_URL` | `http://gbv-botserver` | For error reporting (synthetic events) |
| `FACEBOOK_GRAPH_URL` | `https://graph.facebook.com/v22.0` | Must match replybot's version |
| `NUM_WORKERS` | `1` | Single worker thread for initial deployment |
| `MAX_RETRY_ATTEMPTS` | `3` | Exponential backoff: 100ms → 200ms → 400ms |
| `HEALTH_PORT` | `8081` | Health endpoint (/healthz) |

### New Replybot Environment Variable

| Variable | Value | Notes |
|----------|-------|-------|
| `KAFKA_COMMANDS_TOPIC` | `vlab-prod-commands` (prod) / `vlab-staging-commands` (staging) | Topic where replybot publishes commands |

### Resource Limits (Production)

```yaml
resources:
  requests:
    cpu: 50m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi
```

## Token Store Compatibility

Message Worker queries the same `credentials` table as Replybot for Facebook page tokens:

**Message Worker (Go):**
```sql
SELECT COALESCE(details->>'access_token', details->>'token') AS token
FROM credentials WHERE facebook_page_id = $1
ORDER BY created DESC LIMIT 1
```

**Replybot (Node.js):**
```sql
SELECT details->>'access_token' AS token
FROM credentials WHERE facebook_page_id = $1
ORDER BY created DESC LIMIT 1
```

The Go version adds a `COALESCE` fallback to `details->>'token'` for testrunner compatibility. In production, `access_token` is always present, so both queries return the same value. No schema changes needed.

The `credentials` table has a covering index on `facebook_page_id` that includes `details`, so the query is served entirely from the index without a table lookup.

## Monitoring

A lagging consumer alert is configured for the message-worker consumer group:

```yaml
laggingAlerts:
  - consumergroup: message-worker
    alertname: LaggingConsumerMessageWorker
    window: "5m"
    limit: "20"
```

This alerts if the consumer group falls behind by more than 20 messages over 5 minutes.

## Error Handling Flow

1. Message Worker tries to send a message (up to 3 retries with exponential backoff)
2. If all retries fail, it POSTs a `machine_report` to `{BOTSERVER_URL}/synthetic`
3. Botserver publishes this as a synthetic event on the chat-events Kafka topic
4. Replybot consumes the synthetic event and transitions the user to BLOCKED or ERROR state

The error tag in the machine_report determines the state transition:
- `"FB"` → BLOCKED state (platform errors: user blocked the bot, etc.)
- `"STATE_ACTIONS"` → ERROR state (config/client errors)

## Health Checks

The message-worker exposes a health endpoint on port 8081:
- `GET /healthz` → `200 OK` with body `"ok"`

Kubernetes liveness and readiness probes are configured in the Helm chart:
- `livenessProbe`: checks `/healthz` every 10s (initial delay 5s)
- `readinessProbe`: checks `/healthz` every 10s (initial delay 5s)

Graceful shutdown: preStop hook sleeps 15s to allow Kafka offset commits before termination (terminationGracePeriodSeconds: 30).

## Non-Obvious Findings

1. **Image registry mismatch was fixed:** The original values files referenced Docker Hub (`vlabresearch/message-worker`) but CI pushes to GHCR (`ghcr.io/vlab-research/message-worker`). Fixed to use GHCR.

2. **FACEBOOK_GRAPH_URL was v18.0:** The message-worker config had `v18.0` while replybot uses `v22.0`. Fixed to `v22.0`. Using different API versions can cause subtle behavior differences.

3. **NUM_WORKERS was 100:** Configured for 100 goroutines but the initial deployment uses 1 worker thread. Fixed to `1` for safety — can scale up later.

4. **go.work did not include message-worker:** The Go workspace file didn't list `./message-worker`, causing `go test ./...` to fail. Added to go.work.

5. **Staging.yaml had old versions:** The feature branch had reverted staging versions to older values. The rebase resolved this by keeping main's updated versions and adding only `versionMessageWorker`.

6. **Helm chart already pushed:** The message-worker chart (v0.1.1) was already packaged and pushed to the OCI registry during feature development. Chart.lock is current — no `helm dependency update` needed.

7. **Replybot needs a new image:** The replybot code changes (deleting `sendMessage`, adding `publishCommands`) are on this feature branch. A new replybot image must be built and deployed simultaneously with message-worker.

8. **Prometheus annotations:** The deployment template has Prometheus scrape annotations on port 8081 (health port), not 8080 as originally documented. The `/metrics` path is referenced but the Go service doesn't currently expose Prometheus metrics — this is a placeholder for future instrumentation.

9. **Helm values key must match chart name:** The chart is named `message-worker` (hyphenated), so the values key in production.yaml/staging.yaml must be `message-worker:` — not `messageWorker:` (camelCase). Using the wrong key causes Helm to silently ignore all overrides and fall back to chart defaults. This was a deployment blocker: the chart defaulted to a Docker Hub image from an older build (rust branch) that had different config validation, and none of the env vars (DATABASE_URL, KAFKA_COMMAND_TOPIC, etc.) were applied.

10. **Production.yaml had uncommitted changes on main:** The main worktree had uncommitted version bumps (replybot v0.0.200, dinersclub v0.0.40, exodus v0.2.2, dean config tweaks) that were already live in production but never committed to git. These had to be merged into the feature branch's production.yaml to avoid regressing those services during the message-worker deploy.

11. **MESSENGER_URL env var required:** The Docker image built by CI contains a config validation from the rust branch that requires at least one of `MESSENGER_URL`, `WHATSAPP_URL`, or `INSTAGRAM_URL` to be set. Even though our branch's config.go doesn't have this validation, the packaged Helm chart was built from the rust branch. Adding `MESSENGER_URL=https://graph.facebook.com/v22.0` to the env config satisfies this validation.
