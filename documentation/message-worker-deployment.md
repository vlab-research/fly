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
- **Message Worker:** `ghcr.io/vlab-research/message-worker:v0.1.1` (current)
- **Replybot:** `ghcr.io/vlab-research/replybot:v0.0.202` (includes handoff wait guard — see `replybot/HANDOFF_PROTOCOL.md`)

## Deployment Steps

### 1. Build and Push Docker Images

Images are built by the CI pipeline (`release.yml`) when git tags are pushed:

```bash
# Tag and push to trigger CI builds
git tag message-worker-v0.1.1
git push origin message-worker-v0.1.1

git tag replybot-v0.0.202
git push origin replybot-v0.0.202
```

CI pushes to `ghcr.io/vlab-research/`. Verify images exist:
```bash
docker pull ghcr.io/vlab-research/message-worker:v0.1.1
docker pull ghcr.io/vlab-research/replybot:v0.0.202
```

### 2. Bump Replybot Version in Values Files

After the replybot image is built, update the version in both environment files:

```yaml
# devops/values/production.yaml
versionReplybot: &vreplybot v0.0.202

# devops/values/staging.yaml
versionReplybot: &vreplybot v0.0.202
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
| `KAFKA_GROUP_ID` | `vlab-prod-message-worker` | Consumer group. **Required — no default**; startup fails loudly if unset. Must be env-scoped (`vlab-<env>-message-worker`) because the Kafka cluster is shared with staging, and must have a matching row in `devops/kafka-consumer-health/values.yaml`. See `documentation/kafka-consumer-lag-alerting.md`. |
| `KAFKA_AUTO_OFFSET_RESET` | `latest` | Only process new commands |
| `DATABASE_URL` | `postgresql://chatroach@gbv-cockroachdb-public:26257/chatroach?sslmode=disable` | For token lookup |
| `BOTSERVER_URL` | `http://gbv-botserver` | For error reporting (synthetic events) |
| `FACEBOOK_GRAPH_URL` | `https://graph.facebook.com/v25.0` | Must match replybot's version |
| `NUM_WORKERS` | `1` | In-process goroutine count. Safe to raise as of burrow v0.1.5 (key-affinity dispatch); held at 1 pending UAT. See [Scaling](#scaling) below. |
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

## Scaling

Outbound throughput scales two ways, and since burrow v0.1.5 both preserve
ordering.

Replybot keys every command by `user_id` (`replybot/lib/index.js`), so all of one
user's commands land on a single partition of `vlab-prod-commands` and are
delivered in order. Anything that adds parallelism has to keep that true:

| Lever | Effect | Ordering |
|---|---|---|
| `replicaCount` | Partitions spread across pods | **Safe** — a partition has exactly one consumer |
| `NUM_WORKERS` | Goroutines inside one pod | **Safe as of burrow v0.1.5** — dispatch routes by `hash(key)` to a fixed worker, so one user's commands always share a worker and stay FIFO |

A reordered send is not a cosmetic bug: it can put a survey question ahead of the
preamble that explains it, which corrupts the response. Before v0.1.5 burrow
dispatched through one shared channel with no key affinity, so `NUM_WORKERS > 1`
did exactly that; `message-worker` now sets `KeyAffinity` unconditionally, so the
guarantee does not depend on remembering to enable it alongside a worker bump.

The two levers compose: replicas parallelise across partitions, workers
parallelise across users within a partition. Prefer replicas up to the partition
count first, since they also isolate failures.

Note the one cost of key affinity: per-worker queues are `JobQueueSize /
NumWorkers`, and burrow's poll loop is single-threaded, so a worker that backs
up stalls polling for the whole pod — including workers sitting idle. See
`KEY_AFFINITY.md` in the burrow repo.

**The ceiling is the partition count.** `vlab-prod-commands` has 6 partitions, so
6 replicas is maximum useful parallelism — a 7th pod idles. Going beyond that
means adding partitions first.

Production runs **3 replicas** (`devops/values/production.yaml:1093`, confirmed
against the live deployment 2026-09-04) against a 6-partition topic, so each pod
owns **2 partitions**. That is deliberate: more partitions than consumers means
headroom to scale pods without repartitioning, which would remap key to
partition and break the per-key ordering that key affinity exists to provide.

> An earlier version of this line said "6 replicas as of 2026-08-17" and treated
> 6 as the tuned state. That was stale.

### Rebalance replays duplicate sends

Burrow builds a rebalance callback that drains in-flight work and commits before
surrendering partitions (`pool.go:300-347`), but `cmd/message-worker/main.go`
subscribes with `SubscribeTopics(topics, nil)` — the callback is never wired up,
and its `partitions assigned` / `partitions revoked` log lines never appear.

Consequence: on **any** rebalance — scaling, a rolling deploy, a pod restart —
offsets processed since the last commit are replayed by the partition's new
owner, and those commands send twice. With `CommitInterval: 5s` that is up to
~5 seconds of duplicate outbound messages.

This predates multi-replica operation (a single pod already replayed on every
deploy), but rebalances are more frequent now. The fix belongs in the `burrow`
repo: expose the callback so `SubscribeTopics` can pass it instead of `nil`.

### A slow send stalls commits for the whole pod

The three levers above assume `ProcessCommand` returns quickly. It is worth
stating what breaks when it does not, because the answer is not "that one
message is late."

Burrow's `SequenceTracker` assigns **one monotonic sequence across all
partitions**, and `FindCommittableOffset` (`gap.go:6-15`) walks forward from the
last committed sequence and stops at the first unprocessed one. So a single
worker blocked in `processFunc` (`pool.go:153`) holds a gap open, and **no
offsets commit behind it, on any partition, until it returns.**

Combined with the unwired rebalance callback above, that turns the duplicate-send
window from `CommitInterval` (5s) into however long the slowest in-flight command
takes. A rolling deploy during a 3-minute stall re-sends 3 minutes of traffic.

Two further thresholds follow, in order:

| after | what happens | why |
|---|---|---|
| ~10 queued commands for one worker | the **whole pod** stops polling | per-worker buffers are `JobQueueSize / NumWorkers` (`pool.go:75`) = 1000/100 = 10; `pollLoop` blocks on the send at `pool.go:206`, and polling is single-threaded (`pool.go:118`) |
| 5 minutes without polling | consumer evicted, rebalance | `max.poll.interval.ms` is not set in the consumer `ConfigMap` (`main.go:75-80`), so librdkafka's 300000ms default applies |

Note the second row's interaction with `NUM_WORKERS`: because per-worker buffers
are `JobQueueSize / NumWorkers` and `JobQueueSize` stays at burrow's default
1000, **raising `NUM_WORKERS` shrinks each buffer and makes the poll stall
arrive sooner.** Raise `JobQueueSize` alongside it, or the extra workers make
this failure mode worse rather than better.

burrow's `KEY_AFFINITY.md` calls the poll stall low-risk on the grounds that "a
single user cannot receive enough commands to fill a buffer." That holds while
processing is fast. It is not one user's commands that fill a buffer — it is
every user id hashing to the same worker index.

One further consequence of the global tracker, which matters at 2 partitions per
pod: the stall is not confined to the partition that caused it. Burrow assigns a
single sequence across every assigned partition, so a gap on one blocks commits
on the other.

This is the constraint that bounds any in-worker retry or backoff scheme; see
`planning/`-adjacent work on WhatsApp error 131056 for a worked example.

### Status: fixed in burrow, adopted here

Everything above describes burrow `v0.1.5`. `message-worker` runs `v0.2.0`,
which fixes all of it:

| the problem above | how it was fixed |
|---|---|
| a gap on one partition blocks commits on the other | offsets are tracked per partition; there is no global sequence |
| ~10 queued commands stop the whole pod polling | work is claimed by key, not by a queue bound to a worker, so a slow key holds one worker and blocks nothing |
| raising `NUM_WORKERS` shrinks buffers and makes it worse | `QueueSizePerWorker` is per worker and is not divided by anything |
| the rebalance callback is never attached | `main.go` calls `pool.Subscribe`; subscribing the consumer directly cannot attach it |
| a slow message widens the redelivery window | a stalled partition no longer holds back the others' commits |

`max.poll.interval.ms` is set explicitly in the consumer `ConfigMap` at
librdkafka's own default of 300000ms — a no-op in value, but the eviction budget
is now a number someone chose.

#### Ordering needs no configuration

Commands are keyed by `user_id`. Burrow processes a key on at most one worker at
a time, so a user's messages reach the platform in the order replybot produced
them, whatever `NUM_WORKERS` is set to. The v0.1.5-era `KeyAffinity` flag is
gone; there is no longer a setting to forget.

Because nothing is bound to a worker, `NUM_WORKERS` can also be changed freely.
The old warning about only changing it on a planned restart — it remapped which
worker served which key — no longer applies.

#### `NUM_WORKERS` is pool-wide

It is this pod's worker count, full stop. It was briefly per-partition in
`v0.1.6`; in `v0.2.0` it is pool-wide again and does not move with partition
assignment, so a scale-down no longer concentrates concurrency onto one pod.

| env | value | pods | in flight |
|---|---|---|---|
| production | 48 | 3 | **144** |
| staging | 48 | 1 | **48** |

Both were raised so fleet-wide concurrency stays where `v0.1.6` put it, which
was itself a deliberate increase over `v0.1.5`'s 72. Two reasons:

- **A retry ladder parks a worker for its whole duration.** Headroom is what
  stops one parked user from costing every other user their throughput.
- **It does not widen 131056 exposure.** That error is a
  *(business account, consumer account)* **pair** rate limit, scoped to one
  recipient. Sends to different users never contend for it, and a single user is
  already serialized onto one worker. The trigger is one user generating events
  faster than the cooldown, not the fleet sending faster in aggregate.

#### Backpressure

The pool buffers at most `QueueSizePerWorker x NUM_WORKERS` jobs — 10 × 48 = 480
per pod. Beyond that the poll loop waits.

That bound is a real overload signal: reaching it means every worker is busy
*and* the buffer behind them is full. One slow key cannot cause it, because a
slow key holds one worker and leaves the rest free.

Keep the depth small. Buffered jobs are uncommitted offsets, redelivered on any
crash or rebalance — and here redelivery means re-sending to real people. Kafka
already holds them durably for 31 days.

`Stats.JobsQueued` sitting at the bound means saturation; `Stats.KeysPending`
shows how many distinct users have work outstanding.

### Retry: what retries where

Two mechanisms retry a failed send, and they own different error codes.

**In the worker, in place.** `WHATSAPP_RETRY_CODES` (default `131056`) lists the
Cloud API codes retried inside `processFunc`, bounded by `MAX_RETRY_ATTEMPTS`,
`INITIAL_BACKOFF_MS`, `MAX_BACKOFF_MS` and `MAX_RETRY_ELAPSED`. All four are read
together and the tightest bound wins; `MAX_RETRY_ELAPSED` is the real control,
because under a doubling delay the attempt count is a poor proxy for elapsed
time.

Only 131056 by default. It is the *(business account, consumer account)* pair
rate limit — scoped to **one recipient**, with a cooldown measured at ≤88.6s.
Retrying it in place is safe because commands are keyed by `user_id` and burrow
processes a key on one worker at a time, so the retry cannot contend with itself
and delays no other recipient.

**In dean, on a schedule.** `DEAN_FB_CODES` covers the rest: the account-wide
throughput limits (4, 80007, 130429) and the long-lived ones (131048 spam,
131057 maintenance). Retrying account-wide limits per message across every
worker is a thundering herd — each worker backs off independently and they all
return together to re-trip the limit. Those want a scheduled sweep, which is
what dean's `respondings` CronJob (`*/30`) provides.

The split is deliberate: **per-recipient limits retry in place, account-wide and
long-lived limits retry on a schedule.**

Note the two lists disagree on purpose, and both are environment variables — if
you move a code from one to the other, move it out of the list it was in.

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

### Command outcomes and offset commits

A failed send must still commit its Kafka offset — replaying it would re-send a
message the user may already have received, and the failure has already been
handed to the state machine via machine_report. But "commit the offset" is not
the same as "this worked", so `ProcessCommand` distinguishes three outcomes:

| Return | Meaning | Offset | Log line |
|--------|---------|--------|----------|
| `nil` | Sent | committed | info `command processed successfully` |
| `*HandledError` | Send failed, reported to botserver | committed | warn `command send failed but handled/reported` |
| any other error | Processing failed (malformed payload, unknown command type) | not committed | error `failed to process command` |

`HandledError` is minted inside `reportError`, so every path that reports a
failure returns it automatically. It wraps the original error and implements
`Unwrap()`, so `errors.Is`/`errors.As` (and `IsPlatformError`) still reach the
underlying `*PlatformError` through it.

Two failures deliberately fall outside this scheme:

- **WhatsApp echo failures** (`emitWhatsAppEcho`) are logged as a warning and
  otherwise ignored. The message was delivered; only the internal Kafka echo
  that advances RESPONDING → QOUT failed. Reporting a send failure would be
  untruthful in the other direction, and a hard error would replay the command
  and duplicate the message. The symptom is a stalled conversation, not a
  missed send.
- **Legacy `native` commands** are rejected with a hard error, so their offset
  is never committed — see finding 13.

**Known asymmetry:** the code also defines `message_failed`/`message_sent` Kafka
events, but emission is currently commented out in `worker.go` and replybot only
handles machine_report. The HTTP machine_report → botserver path is the only
live error-handling route; the event-emitting functions are reachable from tests
only. Both mechanisms should be consolidated in a future refactor.

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

3. **NUM_WORKERS was 100:** Configured for 100 goroutines but the initial deployment uses 1 worker thread. Fixed to `1` for safety.

   Superseded twice. "Can scale up later" was wrong at the time — raising it
   reordered a user's messages. Burrow v0.1.5 added key-affinity dispatch,
   which makes it safe again. See [Scaling](#scaling).

4. **go.work did not include message-worker:** The Go workspace file didn't list `./message-worker`, causing `go test ./...` to fail. Added to go.work.

5. **Staging.yaml had old versions:** The feature branch had reverted staging versions to older values. The rebase resolved this by keeping main's updated versions and adding only `versionMessageWorker`.

6. **Helm chart already pushed:** The message-worker chart (v0.1.1) was already packaged and pushed to the OCI registry during feature development. Chart.lock is current — no `helm dependency update` needed.

7. **Replybot needs a new image:** The replybot code changes (deleting `sendMessage`, adding `publishCommands`) are on this feature branch. A new replybot image must be built and deployed simultaneously with message-worker.

8. **Prometheus annotations:** The deployment template has Prometheus scrape annotations on port 8081 (health port), not 8080 as originally documented. The `/metrics` path is referenced but the Go service doesn't currently expose Prometheus metrics — this is a placeholder for future instrumentation.

9. **Helm values key must match chart name:** The chart is named `message-worker` (hyphenated), so the values key in production.yaml/staging.yaml must be `message-worker:` — not `messageWorker:` (camelCase). Using the wrong key causes Helm to silently ignore all overrides and fall back to chart defaults. This was a deployment blocker: the chart defaulted to a Docker Hub image from an older build (rust branch) that had different config validation, and none of the env vars (DATABASE_URL, KAFKA_COMMAND_TOPIC, etc.) were applied.

10. **Production.yaml had uncommitted changes on main:** The main worktree had uncommitted version bumps (replybot v0.0.200, dinersclub v0.0.40, exodus v0.2.2, dean config tweaks) that were already live in production but never committed to git. These had to be merged into the feature branch's production.yaml to avoid regressing those services during the message-worker deploy.

11. **MESSENGER_URL env var required:** The Docker image built by CI contains a config validation from the rust branch that requires at least one of `MESSENGER_URL`, `WHATSAPP_URL`, or `INSTAGRAM_URL` to be set. Even though our branch's config.go doesn't have this validation, the packaged Helm chart was built from the rust branch. Adding `MESSENGER_URL=https://graph.facebook.com/v22.0` to the env config satisfies this validation.

12. **Send failures used to log as successes:** When a send failed, the worker
    reported the failure to botserver and returned `nil`, so main.go logged
    "command processed successfully". Real production failures were invisible —
    the only trace was the resulting BLOCKED/ERROR state transition, with nothing
    in the worker's own logs. Fixed by the `HandledError` type described under
    "Command outcomes and offset commits" above. When auditing logs from before
    that fix, treat "command processed successfully" as "the command was
    processed", not "the message was delivered".

13. **A hard error blocks its partition:** `processFunc` returns non-nil only for
    genuine processing failures, and burrow does not commit the offset in that
    case. For a permanently-unprocessable message — a legacy `native` command, or
    an unrecognised `type` — that means the same message is retried forever and
    its partition stops advancing. This is intentional loud failure (both paths
    are meant to be extinct), but if either ever reappears on the `commands`
    topic in production, the symptom is consumer lag on one partition plus a
    repeating "failed to process command" error, not a dropped message.
