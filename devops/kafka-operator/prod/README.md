# Kafka operator — production runbook

This directory holds the production `KafkaCluster`, `ZookeeperCluster`, and operator chart values for the GKE prod cluster (`gke_toixotoixo_europe-west1-b_toixo`, namespace `default`).

## Current pinned versions

| Component | Version / digest |
|---|---|
| Kafka operator chart | `oci://ghcr.io/adobe/helm-charts/kafka-operator` `0.28.0-adobe-20250923` |
| Kafka broker image | `ghcr.io/banzaicloud/kafka@sha256:87b867929ebfcad242e4bdd2e5557d249790918ed3da337db257edf8e26590ef` (Kafka 3.4.1) |
| ZooKeeper image | `pravega/zookeeper:0.2.15` (digest `sha256:c498ebfb76a66f038075e2fa6148528d74d31ca1664f3257fdf82ee779eec9c8`) |
| kube-rbac-proxy sidecar | `quay.io/brancz/kube-rbac-proxy:v0.22.0` (set in `values.yaml`) |

The Pravega ZK operator does not support digest-pinning the ZK image (`spec.image` only takes `repository` + `tag`), so we pin tag `0.2.15` and rely on `pullPolicy: IfNotPresent` to avoid re-pulling on node restarts.

## Phase 0.1 — kube-rbac-proxy fix on the legacy Banzaicloud operator

Background: the live Banzaicloud v0.24.1 operator pod is `1/2 Ready` because the `gcr.io/kubebuilder/kube-rbac-proxy:v0.13.0` image was retired by Google. The main `manager` container is fine; only the metrics-auth sidecar is broken.

**If you are about to do the Adobe cutover (Phase 1a) within a few days, skip the in-place patch — Adobe's chart ships a working `quay.io/brancz/kube-rbac-proxy:v0.21.2` natively, and our `values.yaml` overrides it to `v0.22.0`.** The patch below is only worth doing if the cutover is delayed.

In-place patch (only if Phase 1a is delayed):

```bash
kubectl -n default set image deploy/kafka-kafka-operator-operator \
    kube-rbac-proxy=quay.io/brancz/kube-rbac-proxy:v0.22.0
kubectl -n default rollout status deploy/kafka-kafka-operator-operator
kubectl -n default get pod -l app.kubernetes.io/name=kafka-operator
# expect 2/2 Ready
```

Rollback: `kubectl -n default rollout undo deploy/kafka-kafka-operator-operator`.

## Phase 0.4 — consumer-group offset snapshot

Take before any cutover and save somewhere durable.

```bash
GROUPS=(replybot scribble-states scribble-responses scribble-messages \
        scribble-chat-log dinersclub exporter)
OUT=~/kafka-offsets-baseline-$(date +%F).txt
: > "$OUT"
for grp in "${GROUPS[@]}"; do
    echo "=== $grp ===" >> "$OUT"
    kubectl run -n default kafka-snap-$grp \
        --image=confluentinc/cp-kafka:7.4.0 --restart=Never --quiet --command -- \
        kafka-consumer-groups --bootstrap-server kafka-headless.default.svc.cluster.local:29092 \
        --group "$grp" --describe
    sleep 6
    kubectl -n default logs kafka-snap-$grp >> "$OUT" 2>/dev/null
    kubectl -n default delete pod kafka-snap-$grp --wait=false >/dev/null 2>&1
done
```

Confirm every group shows recent `CURRENT-OFFSET` values, then commit `$OUT` to a private gist or internal storage.

## Phase 1a — cutover from Banzaicloud Koperator v0.24.1 to Adobe fork

CRDs use the `kafka.banzaicloud.io` group in both, so the existing `KafkaCluster` and `KafkaTopic` resources will be picked up by the new operator unchanged.

### Adobe-specific gotchas (apply BEFORE the helm install)

1. **Project Contour CRDs must be present** — Adobe Koperator watches `HTTPProxy.projectcontour.io` for optional Contour ingress integration. If the CRDs are absent, the manager process crash-loops every ~2 min ([adobe/koperator#229](https://github.com/adobe/koperator/issues/229)). Apply the Contour CRD set even if you don't use Contour:
   ```bash
   kubectl apply --server-side --force-conflicts \
       -f https://raw.githubusercontent.com/projectcontour/contour/release-1.28/examples/contour/01-crds.yaml
   ```
   Only `httpproxies.projectcontour.io` is strictly required; the other 4 CRDs in that file are inert (no controllers, no instances) and added for compliance with the upstream fix instructions.

2. **Watch namespace defaults** — Adobe's chart defaults `operator.namespaces` to `"kafka, cert-manager"`, which would skip our `KafkaCluster` in `default`. Our `values.yaml` sets it to `""` (cluster-wide watch). The chart template only emits `--namespaces=` when the value is non-empty, so an empty string drops the flag entirely.

3. **Helm release name is `kafka`, not `kafka-operator`** — the prod release was renamed long ago. `helm uninstall kafka-operator` is a no-op; the correct command is `helm uninstall kafka`. The release only owns operator-side resources (Deployment, RBAC, Service, ValidatingWebhookConfiguration, the webhook-cert Secret) — it does NOT own the `KafkaCluster` CR, broker pods, PVCs, or CRDs, so uninstall is safe.

```bash
# 0. Take a fresh offset snapshot (see Phase 0.4 above).

# 1. Apply Adobe CRDs (server-side apply handles existing CRDs gracefully).
KOPERATOR_VERSION=0.28.0-adobe-20250923
for crd in cruisecontroloperations kafkaclusters kafkatopics kafkausers; do
    kubectl apply --server-side --force-conflicts \
        -f "https://raw.githubusercontent.com/adobe/koperator/${KOPERATOR_VERSION}/config/base/crds/kafka.banzaicloud.io_${crd}.yaml"
done

# 2. Uninstall the Banzaicloud operator (this leaves CRDs and the KafkaCluster
#    resource alone — only the Deployment / RBAC / webhook are removed).
helm uninstall kafka-operator

# 3. Install Adobe operator with our prod values.
helm install kafka-operator oci://ghcr.io/adobe/helm-charts/kafka-operator \
    --version "${KOPERATOR_VERSION}" \
    --namespace default \
    --values ./values.yaml

# 4. Wait for the operator pod to come up 2/2 Ready.
kubectl -n default rollout status deploy -l app.kubernetes.io/name=kafka-operator --timeout=5m
kubectl -n default get pods -l app.kubernetes.io/name=kafka-operator

# 5. Verify the existing KafkaCluster is reconciled by the new operator
#    without a broker restart.
kubectl -n default get kafkacluster kafka -o jsonpath='{.status.state}{"\n"}'
# expect: ClusterRunning
kubectl -n default get pods -l app=kafka
# expect: 0 restarts since cutover, same image digest
```

Soak: 3–7 days before bumping Kafka 3.4.1 → 3.9 in Phase 1b.

### Rollback (if Adobe operator misbehaves during soak)

Broker state is untouched — rollback is purely on the operator side:

```bash
helm uninstall kafka-operator
helm repo add banzaicloud-stable https://kubernetes-charts.banzaicloud.com
helm install kafka-operator banzaicloud-stable/kafka-operator
kubectl -n default set image deploy/kafka-kafka-operator-operator \
    kube-rbac-proxy=quay.io/brancz/kube-rbac-proxy:v0.22.0
```

## Verification checklist

- [ ] Operator pod `2/2 Running` on Adobe image
- [ ] `kubectl -n default get kafkacluster kafka -o jsonpath='{.status.state}'` → `ClusterRunning`
- [ ] Brokers on the same digest, 0 new restarts since cutover
- [ ] Round-trip a test message via `kafka-ui` (or `kafka-console-producer`/`-consumer` from an ephemeral pod)
- [ ] All 7 consumer groups within their normal lag bounds vs. the pre-cutover snapshot
