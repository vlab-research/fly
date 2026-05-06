# Kafka cluster upgrade plan

Status as of **2026-05-06**: Phase 0 + Phase 1a + Phase 1b complete. Brokers on Kafka 3.9.1 (adobe/kafka:2.13-3.9.1, digest-pinned). Next: Phase 0.3 (ZK pin, pending) then Phase 3 planning.

## Context

The production Kafka cluster on GKE (`gke_toixotoixo_europe-west1-b_toixo`, namespace `default`) was running on archived and end-of-life software:

- **Banzaicloud Koperator v0.24.1** — repository archived March 2025, no security or bug patches.
- **Apache Kafka 3.4.1** — past EOL since ~February 2024, multiple CVE-fix releases missed.
- **`ghcr.io/banzaicloud/kafka:latest` and `pravega/zookeeper:latest`** — floating tags; a pod restart could land on a different image than what's running.
- **Operator was degraded**: the `kube-rbac-proxy:v0.13.0` sidecar had been in `ImagePullBackOff` for ~2 days (`gcr.io/kubebuilder` was deprecated by Google in 2023). Main `manager` container ran fine, so reconciliation worked, but the pod was `1/2` Ready and metrics auth was broken.

Goal: get onto maintained software (Adobe's Koperator fork → Apache Kafka 3.9) without losing consumer-group offsets, then plan a longer-horizon migration to Strimzi.

Constraints from the user:
- **Production traffic is currently low** — direct prod work is acceptable, no parallel-cluster rehearsal needed.
- **Brief downtime is acceptable.**
- **Consumer offsets must be preserved.** Reprocessing the chat-events stream from offset 0 would be costly.
- **No replay dependency on Kafka.** Replay uses CockroachDB, so historical Kafka messages do not need to be migrated. This collapses the eventual Strimzi cutover from a MirrorMaker2 dance to a simple drain-and-cutover.

Client-side audit (already done) shows every Kafka client is on a modern librdkafka-2.x or kafkajs-2.x release. No client work required for any phase.

## Decisions locked

- **Target Kafka version**: 3.9.x (Adobe-recommended for KRaft readiness; clients all support it).
- **Phase 1a/1b ordering**: sequential with a 3–7 day soak between operator swap and version bump.
- **Phase 0.2 (broker digest pin) folded into Phase 1b** — both touch `clusterImage`. Doing them separately would mean two rolling restarts; bundling makes one image-change diff (`:latest` → 3.9 digest) and one restart.
- **Phase 0.3 (ZK image pin)** — pending; standalone change with its own rolling restart of ZK pods. Low urgency.
- **Phase 3 strategy**: drain-and-cutover (no MirrorMaker2), since CockroachDB is the replay source.

## Current state (as of 2026-05-06, post Phase 1b)

| Component | Image | Version | Status |
|---|---|---|---|
| Kafka brokers (×3) | `adobe/kafka:2.13-3.9.1@sha256:279358e7bc789aba1e3457421e251278ec993a57d0ad2b9691274f1f3ddae134` | Kafka 3.9.1 | Running, rolled during 1b |
| ZooKeeper (×3) | `pravega/zookeeper:0.2.15` (`pullPolicy: IfNotPresent`) | 0.2.15 | Running, rolled 2026-05-06 |
| Koperator (`kafka-kafka-operator-operator`) | `ghcr.io/adobe/koperator:0.28.0-adobe-20250923` + `quay.io/brancz/kube-rbac-proxy:v0.22.0` | Adobe 0.28.0 | **2/2 Running**, 0 restarts |
| Cruise Control | `ghcr.io/banzaicloud/cruise-control:2.5.101` | 2.5.101 | Running |
| KafkaCluster CR `kafka` | — | `ClusterRunning`, 0 alerts | Healthy |
| Helm release | `kafka` (NOT `kafka-operator`) | chart `0.28.0-adobe-20250923` | Deployed |

Storage: 3× 100Gi PVCs (`standard` storage class), <1% utilization.

Topics (managed by `KafkaTopic` CRs in `devops/vlab/templates/topics.yaml`):

| Topic | Partitions | RF | Retention |
|---|---|---|---|
| vlab-prod-chat-events | 48 | 3 | 31d |
| vlab-prod-state | 12 | 3 | 31d |
| vlab-prod-response | 12 | 3 | 31d |
| vlab-prod-payment | 2 | 3 | 31d |
| vlab-exports | 2 | 2 | 31d |
| vlab-prod-chat-log | 12 | 3 | 31d |

Bootstrap address used by every client: `kafka-headless.default.svc.cluster.local:29092` — defined once in `devops/values/production.yaml:12` via the `&kb` YAML anchor, so a Phase 3 cutover is a one-line change there.

Clients (all green, no upgrade needed):
- botserver: node-rdkafka 2.18.0 (producer)
- dashboard-server: kafkajs 2.2.4 (producer)
- replybot: node-rdkafka 2.10.1 via `@vlab-research/botspine@0.0.13` (producer + consumer)
- exporter: confluent-kafka 2.3.0 (consumer)
- message-worker: confluent-kafka-go 2.12.0 (producer)
- dinersclub: confluent-kafka-go 2.1.1 via spine (consumer)
- scribble: confluent-kafka-go 2.1.1 via spine (consumer, multiple groups)

## Phase 0 — Stabilization (DONE 2026-05-06)

| Step | Status | Notes |
|---|---|---|
| 0.1 — kube-rbac-proxy fix on legacy operator | **Skipped** | Superseded by Phase 1a — Adobe chart ships a working `quay.io/brancz/kube-rbac-proxy:v0.21.2` natively, and our `values.yaml` overrides it to `v0.22.0`. No need to patch the to-be-uninstalled Banzaicloud operator. |
| 0.2 — Pin `kafka:latest` to digest | **Folded into Phase 1b** | Same `clusterImage` field; bundling avoids a duplicate rolling restart. |
| 0.3 — Pin `pravega/zookeeper:latest` to `0.2.15` | **Done 2026-05-06** | Tag `0.2.15` + `pullPolicy: IfNotPresent` applied to `zookeeper.yaml`. All 3 ZK pods rolled, quorum maintained throughout. |
| 0.4 — Snapshot consumer-group offsets | **Done** | Baseline at `~/.claude/plans/kafka-snapshots/offsets-baseline-2026-05-03.txt` (all 7 groups at lag 0 pre-cutover). |

## Phase 1a — Banzaicloud Koperator → Adobe fork (DONE 2026-05-03)

CRD group is still `kafka.banzaicloud.io`, so the existing `KafkaCluster` and `KafkaTopic` resources continued to apply unchanged.

### What was done

1. Applied Adobe CRDs server-side (`cruisecontroloperations`, `kafkaclusters`, `kafkatopics`, `kafkausers`, all from `https://raw.githubusercontent.com/adobe/koperator/0.28.0-adobe-20250923/config/base/crds/`).
2. Applied **Project Contour CRDs** (`https://raw.githubusercontent.com/projectcontour/contour/release-1.28/examples/contour/01-crds.yaml`) — see gotcha #1 below.
3. `helm uninstall kafka` — removed Banzaicloud operator (release was named `kafka`, not `kafka-operator`; see gotcha #3).
4. `helm install kafka /tmp/koperator-chart/kafka-operator.tgz --namespace default --values devops/kafka-operator/prod/values.yaml`
   - Chart pulled out-of-band via OCI manifest API because `helm install oci://...` failed with anonymous-pull 403 from GHCR.
5. `helm upgrade` after detecting the namespaces config mismatch — see gotcha #2.

### Gotchas captured (see also `devops/kafka-operator/prod/README.md`)

1. **Project Contour CRDs must be present BEFORE the operator starts.** Adobe Koperator watches `HTTPProxy.projectcontour.io` for optional Contour ingress integration; if the CRDs are absent, the manager process crash-loops every ~2 min ([adobe/koperator#229](https://github.com/adobe/koperator/issues/229), still open as of 2026-02). Symptom: operator pod cycles `2/2 Running` ↔ `1/2 CrashLoopBackOff`, manager logs show `"Shutdown signal received"` with no preceding error, and a constant 10s loop of `if kind is a CRD, it should be installed before calling Start kind=HTTPProxy.projectcontour.io`. Fix: install all 5 Contour CRDs from the file above. Only `httpproxies.projectcontour.io` is strictly required; the other 4 are inert.
2. **Watch namespace defaults** — Adobe's chart defaults `operator.namespaces` to `"kafka, cert-manager"`, which would skip our `KafkaCluster` in `default`. `values.yaml` now sets it to `""` (empty → no `--namespaces` flag → cluster-wide watch).
3. **Helm release name is `kafka`, not `kafka-operator`** — the prod release was renamed long ago. `helm uninstall kafka-operator` is a no-op. The release only owns operator-side resources (Deployment, RBAC, Service, ValidatingWebhookConfiguration, the webhook-cert Secret) — it does NOT own the `KafkaCluster` CR, broker pods, PVCs, or CRDs, so uninstall is safe.
4. **GHCR anonymous pull failed** — `helm pull oci://ghcr.io/adobe/helm-charts/kafka-operator` returned 403. Workaround: fetch the manifest + chart blob via the OCI HTTP API with an anonymous token, then `helm install <local-tarball>`. See README runbook for the exact curl invocations.
5. **Brokers were rolled during the cutover.** During the ~10-min crash-loop window before fix #1 was applied, the operator's intermittent reconciliation triggered a rolling broker restart. New broker pods (`kafka-0-c4tzz`, `kafka-1-75vnd`, `kafka-2-zb68k`) replaced the originals. All 7 consumer groups returned to lag 0 within minutes; no data loss. Plan originally said "brokers should not restart"; treat that promise as aspirational, not guaranteed.

### Verification (passed 2026-05-03 17:34Z)

- Operator pod `2/2 Running`, 0 restarts on the post-fix incarnation.
- `kubectl -n default get kafkacluster kafka -o jsonpath='{.status.state}'` → `ClusterRunning`, `alertCount: 0`.
- All 3 brokers Running, ISR healthy, `rollingUpgradeStatus.lastSuccess: 2026-05-03 17:32:46`.
- All 7 consumer groups at total lag 0. Snapshot at `~/.claude/plans/kafka-snapshots/offsets-post-1a-2026-05-03-1334.txt`.
- HTTPProxy errors: 0 in the post-fix log window.

### Soak (3–7 days starting 2026-05-03)

Watch for:
- Unexpected operator restarts (`kubectl -n default get pod -l app.kubernetes.io/name=kafka-operator -w`)
- Broker restart events (`kubectl -n default get pods -l app=kafka -w`)
- Cruise Control rebalancing or alerts via `kafka-ui` and Prometheus metrics
- Consumer-lag spikes via kafka-exporter

If anything misbehaves: rollback is `helm uninstall kafka` then reinstall the Banzaicloud chart per the runbook in `devops/kafka-operator/prod/README.md`.

## Phase 1b — Kafka 3.4.1 → 3.9 rolling upgrade (after soak, week of 2026-05-10+)

Goal: get brokers onto a supported Kafka release. Done as a standard rolling upgrade; PVCs and `__consumer_offsets` ride along untouched. **Bundles the broker digest pin (formerly Phase 0.2) — both changes touch `clusterImage`.**

### 1b.1 Pre-flight

- Fresh offset snapshot via the runbook in `devops/kafka-operator/prod/README.md`.
- Confirm `inter.broker.protocol.version` and `log.message.format.version` in the running broker config (currently 3.4 implicit). These will be set explicitly to `3.4` in the CR before the binary upgrade so the cluster keeps speaking 3.4 protocol during the rolling restart, then bumped to `3.9` afterward.
- Verify Adobe's published `ghcr.io/adobe/kafka:3.9.x` (or whichever path Adobe uses) is reachable from GKE. Capture the digest.

### 1b.2 Step 1 — Set explicit protocol-version pin

Edit `devops/kafka-operator/prod/kafka.yaml`:

```yaml
spec:
  readOnlyConfig: |
    inter.broker.protocol.version=3.4
    log.message.format.version=3.4
    # ...existing config...
```

Apply. Restart-wise this is a no-op but locks the protocol so the binary upgrade is safe.

### 1b.3 Step 2 — Bump broker image to Kafka 3.9 (digest-pinned)

Edit `devops/kafka-operator/prod/kafka.yaml`:

```yaml
# was: clusterImage: ghcr.io/banzaicloud/kafka:latest
clusterImage: ghcr.io/adobe/kafka@sha256:<3.9-digest>
```

This is the consolidated diff that both pins to a digest (formerly Phase 0.2) and upgrades to 3.9.

Adobe Koperator's rolling-upgrade controller restarts brokers one at a time, waiting for ISR to recover between each. Expected timeline: ~5–10 min per broker, ~30 min total. Cluster is available throughout.

Watch: `kubectl -n default get pods -l app=kafka -w` and Cruise Control "under-replicated partitions" metric.

### 1b.4 Step 3 — Bump protocol version to 3.9

After all 3 brokers are on the 3.9 binary and ISR is healthy:

```yaml
spec:
  readOnlyConfig: |
    inter.broker.protocol.version=3.9
    log.message.format.version=3.9
```

Apply. Second rolling restart, same ~30 min.

### 1b.5 Verification

- `kubectl describe pod kafka-0-<suffix> | grep Image:` → digest, not `:latest`
- `kubectl exec` into a broker (or `kubectl run` an ephemeral pod) → confirm `kafka_2.13-3.9.x.jar` in `/opt/kafka/libs`
- All 3 brokers on the new image digest
- Consumer-group lag metrics back to baseline within 15 min
- Re-read offset snapshot — every consumer group's `CURRENT-OFFSET` is at-or-ahead-of the pre-upgrade baseline (no rewinds)
- Smoke test: produce + consume a message via every active service path

### 1b.6 Rollback

Roll the `clusterImage` back to the 3.4.1 digest (`sha256:87b867929ebfcad242e4bdd2e5557d249790918ed3da337db257edf8e26590ef`). Adobe Koperator will rolling-restart back. Protocol-version downgrades are safe as long as the binary is also downgraded. Worst case: PVC data is intact, so a fresh cluster can be re-bootstrapped on the same volumes.

## Phase 2 — Deferred (decision parked)

ZK→KRaft migration via Adobe Koperator is technically feasible but requires a redeploy (no automatic migration). Defer this until Phase 3, where Strimzi-on-KRaft is the natural target. Continuing to run ZooKeeper for another 3–6 months is acceptable.

## Phase 3 — Strimzi migration (months out, separate planning cycle)

Strategy locked: **drain-and-cutover** (no MirrorMaker2), enabled by the user's confirmation that nothing replays from Kafka.

### 3.1 Outline (full plan to be drafted closer to execution)

1. Stand up Strimzi cluster operator in `default` (or a new `kafka` namespace — open question for the dedicated planning cycle).
2. Define a Strimzi `Kafka` CR in KRaft mode, 3 brokers, matched PVC sizes.
3. Define `KafkaTopic` CRs for all 6 production topics with identical partition/RF/retention settings.
4. Schedule a maintenance window. During it:
   - Bring all consumer groups to lag = 0 (let consumers drain).
   - Stop producers.
   - Verify no in-flight (`kafka-consumer-groups --describe` shows lag = 0 across all groups).
   - Stop consumers.
   - Update `devops/values/production.yaml:12` (the `&kb` anchor) to point at Strimzi's bootstrap service: `<strimzi-cluster>-kafka-bootstrap.<ns>.svc.cluster.local:9092`.
   - Helm-upgrade the `vlab` umbrella chart to roll out the new bootstrap address to every consumer/producer.
   - Restart producers, then consumers.
   - Consumers join empty topics; nothing to reprocess.
5. Soak old cluster (read-only) for 1–2 weeks as rollback before decommission.

### 3.2 Pre-conditions to verify before Phase 3 starts

- Consumer groups regularly catch up to lag = 0 on their own (run `kafka-consumer-groups --describe` periodically over a week to confirm no chronic backlog).
- Confirm there's no service that re-reads from `earliest` on startup that would behave unexpectedly against fresh-empty topics. (Already validated: replay is via CockroachDB.)
- Confirm topic naming — Strimzi uses `KafkaTopic` CRs in the same namespace as the Kafka cluster.

## Phase 4 — Cleanup (after Phase 3)

- Remove orphan PVCs in `default` namespace: `data-gbv-kafka-0` (1Gi, 4y134d), `data-gbv-zookeeper-0` (8Gi), `datadir-gbv-kafka-0` (1Gi). Verify they're unbound from any pod first.
- Remove `devops/kafka-operator/` directory.
- Remove `devops/vlab/charts/kafka-22.0.1.tgz` and `devops/vlab/charts/redis-18.0.0.tgz` if no longer referenced.
- Update `devops/setup-kube.sh` to install Strimzi instead of Adobe Koperator.
- Update `devops/BITNAMI_MIGRATION_PLAN.md` → mark migration complete, archive or delete.
- Remove the 5 Project Contour CRDs (only needed as a workaround for Adobe Koperator; Strimzi has no such dependency). Confirm no `HTTPProxy` instances exist before deleting.

## Critical files

| File | Role | Phase touched |
|---|---|---|
| `devops/setup-kube.sh` | Initial cluster bootstrap; installs operator chart + Contour CRDs | 1a (done), 3 |
| `devops/kafka-operator/prod/kafka.yaml` | `KafkaCluster` CR — broker image, listeners, storage, Cruise Control config | 1b (digest + version + protocol) |
| `devops/kafka-operator/prod/zookeeper.yaml` | `ZookeeperCluster` CR | 0.3 (pending) |
| `devops/kafka-operator/prod/values.yaml` | Operator Helm values (cert-manager, rbac-proxy override, watch-all namespaces) | 1a (done) |
| `devops/kafka-operator/prod/kafka-prometheus.yaml` | ServiceMonitors and alert rules — verify still applies under Adobe operator | 1a (TODO: verify in soak) |
| `devops/kafka-operator/prod/README.md` | Runbook with cutover/rollback procedures + gotchas | 1a (done) |
| `devops/vlab/templates/topics.yaml` | `KafkaTopic` CRs for all production topics | 3 |
| `devops/values/production.yaml` (line 12, `&kb` anchor) | Single bootstrap address used by every client | 3 |
| `devops/BITNAMI_MIGRATION_PLAN.md` | Existing migration thinking — supersede with this plan | 4 |
| `devops/kafka-reset-offsets.sh` | Reusable for offset snapshots | 0.4 (done), 1b, 3 |

## Reusable existing utilities

- **`devops/kafka-reset-offsets.sh`** already enumerates the 7 consumer groups and uses `confluentinc/cp-kafka:7.4.0` as a client pod. The same pattern (just `--describe` instead of `--reset-offsets`) gives us offset snapshots. Don't reinvent.
- **`KafkaTopic` CRs** in `devops/vlab/templates/topics.yaml` are the canonical topic spec source. Strimzi uses an identically-named CRD (`kafka.strimzi.io/v1beta2/KafkaTopic`) — the schema differs but the data we need (partitions, replicas, config) is the same; can be templated from the existing values.

## Open items to resolve before Phase 3

- Strimzi cluster namespace — same `default` namespace, or new `kafka` namespace? (Cleaner long-term, but changes service references.)
- Phase 3 maintenance window timing.
- Confirm offset-snapshot storage location (gist? bucket? internal wiki?).

## Open items now

No open items. All stabilization and upgrade work through Phase 1b is complete. Next milestone is Phase 3 (Strimzi migration, separate planning cycle).

## End-to-end verification per phase

| Phase | Quick check | Status |
|---|---|---|
| 0 | Operator `2/2 Ready`; ZK image pinned; offset snapshots filed | **Done 2026-05-06** |
| 1a | Adobe operator running; KafkaCluster `ClusterRunning`; brokers operational; round-trip message works | **Done 2026-05-03** |
| 1b | Brokers on Kafka 3.9 jar; protocol version bumped; consumer lag returns to baseline; offsets advance not rewind | **Done 2026-05-06** |
| 3 | All clients connect to Strimzi bootstrap; lag = 0 → produce → consume cycle works on every topic | Months out |
| 4 | Orphan PVCs gone; legacy chart files removed; bootstrap script reflects new world | After 3 |
