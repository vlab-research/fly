# Redis Chart Migration: bitnami → official redis:7-alpine (prod)

## Context

Dev has been migrated to `dandydeveloper/redis-ha` using `redis:7-alpine` (official image)
with HAProxy for client routing (1 replica, no auth). Production still runs
`bitnamilegacy/redis:8.2.1` via the bitnami Helm chart. `bitnamilegacy` is a community
fork with no SLA — this plan migrates production to the same `dandydeveloper/redis-ha`
chart, keeping dev and prod consistent.

Redis is **cache only** in this stack (replybot state cache). Data loss is acceptable —
the cache rebuilds naturally as messages flow through. This makes the migration low-risk.

## Current state (production)

| Property | Value |
|---|---|
| Chart | `bitnami/redis` v18.0.0 (via `oci://registry-1.docker.io/bitnamicharts`) |
| Image | `docker.io/bitnamilegacy/redis:8.2.1-debian-12-r0` |
| Architecture | Replication (1 master + 1 replica) |
| Auth | Enabled — secret `gbv-redis`, key `redis-password` |
| Persistence | 8Gi pd-ssd per pod |
| Service names | `gbv-redis-master` (write), `gbv-redis-replicas` (read) |
| Metrics | `bitnamilegacy/redis-exporter`, ServiceMonitor enabled |
| Consumers | replybot (`REDIS_HOST=gbv-redis-master`, `REDIS_PORT=6379`) |

## Target state

| Property | Value |
|---|---|
| Chart | `dandydeveloper/redis-ha` (https://dandydeveloper.github.io/charts) |
| Image | `redis:7-alpine` (official Docker Hub image) |
| Architecture | 3 replicas with Sentinel (HA) |
| Auth | Same secret `gbv-redis`, key `redis-password` |
| Persistence | 8Gi pd-ssd |
| Service name | `gbv-redis-ha` — **requires replybot config update** |
| Metrics | `oliver006/redis_exporter` via chart's built-in exporter option |

## Migration steps

### Phase 1 — Add chart repo and validate values (no cluster changes)

```bash
helm repo add dandydev https://dandydeveloper.github.io/charts
helm repo update dandydev
helm show values dandydev/redis-ha --version 4.35.3 > /tmp/redis-ha-defaults.yaml
```

Review defaults and confirm the following values file works:

```yaml
# devops/values/integrations/redis-ha.yaml
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
  enabled: false

persistentVolume:
  enabled: true
  storageClass: pd-ssd
  size: 8Gi

auth: true
existingSecret: gbv-redis
existingSecretPasswordKey: redis-password

exporter:
  enabled: true
  serviceMonitor:
    enabled: true
    namespace: default
```

### Phase 2 — Deploy new redis-ha alongside existing redis

This is a side-by-side install. The old `gbv-redis-master` keeps serving replybot
throughout.

```bash
helm upgrade --install gbv-redis-ha dandydev/redis-ha \
  --version 4.35.3 \
  --namespace default \
  --values devops/values/integrations/redis-ha.yaml \
  --wait --timeout 10m
```

Verify:
```bash
kubectl get pods -l app=gbv-redis-ha-redis-ha
# Expect 3 pods (redis + sentinel sidecars) Running

kubectl exec -it gbv-redis-ha-redis-ha-server-0 -c redis -- \
  redis-cli -a "$(kubectl get secret gbv-redis -o jsonpath='{.data.redis-password}' | base64 -d)" ping
# Expect: PONG
```

### Phase 3 — Update replybot to point at new redis

In `devops/values/production.yaml`, change:

```yaml
# Before
- name: REDIS_HOST
  value: "gbv-redis-master"

# After
- name: REDIS_HOST
  value: "gbv-redis-ha-redis-ha"
```

Note: with `redis-ha` + Sentinel the service name format is `<release>-redis-ha`.
Confirm the actual service name after install with `kubectl get svc | grep redis`.

Deploy the replybot config change:
```bash
helm upgrade fly vlab -f devops/values/production.yaml --timeout 10m --wait
```

Monitor replybot for errors — redis is cache-only so a brief cold-cache period is normal.

### Phase 4 — Tear down old bitnami redis

Once replybot has been stable on the new redis for at least 30 minutes:

```bash
helm uninstall gbv-redis
kubectl delete pvc -l app.kubernetes.io/name=redis,app.kubernetes.io/instance=gbv-redis
```

Also remove the old redis config block from `production.yaml` and the bitnami chart
dependency from `Chart.yaml`/`Chart.lock` (or keep with `condition: redis.enabled` and
set `redis.enabled: false`).

## Rollback

If anything goes wrong after Phase 3, point replybot back at `gbv-redis-master` and
redeploy. The old bitnami redis is untouched until Phase 4.

```bash
# In production.yaml, revert REDIS_HOST to "gbv-redis-master"
helm upgrade fly vlab -f devops/values/production.yaml --timeout 10m --wait
```

## Chart.yaml / Chart.lock changes

The `redis` dependency currently in `Chart.yaml` is used by both dev (now disabled via
`redis.enabled: false`) and prod. Once production migrates to `redis-ha` installed
separately, remove or disable the bitnami redis dependency entirely:

```yaml
# Remove this block from Chart.yaml:
  - name: redis
    version: 18.0.0
    repository: oci://registry-1.docker.io/bitnamicharts
    condition: redis.enabled
    tags:
      - redis
```

Then run `helm dep update devops/vlab/` to regenerate `Chart.lock`.

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| replybot cold-cache slowdown | Low — cache rebuilds fast | Monitor for 30 min, rollback if error rate spikes |
| Service name wrong after install | Low | Confirm with `kubectl get svc` before updating config |
| Sentinel connection format incompatible with replybot | Low — replybot uses standard redis client | replybot connects to primary directly via `REDIS_HOST`, not sentinel |
| pd-ssd PVC not provisioning | Low | Check StorageClass with `kubectl get sc` first |
