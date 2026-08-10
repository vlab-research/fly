# MinIO: Single-Node → Distributed Redeploy

**Status:** Planned, not executed. Can be done now, independently of the media abstraction
build — and there are two reasons it is *better* done now than later (§3).

**Related:** `planning/media-abstraction.md` §4.2, `planning/media-staging-runbook.md`,
`planning/media-backup.md` (VIR-24), `documentation/exports-storage.md`.

---

## 1. What changes

| | Now | After |
|---|---|---|
| Workload | `Deployment`, 1 replica | `StatefulSet`, **4 replicas** |
| Storage | one 25Gi PVC (`pvc/minio`) | one 50Gi PVC per pod (`data-minio-{0..3}`) |
| Backend | `xl-single` (single-node erasure) | distributed erasure set across 4 drives |
| Raw / usable | 25Gi / 25Gi | 200Gi raw / **~100Gi usable** (EC:2 → 2 data + 2 parity) |
| Survives | nothing — one pod, one disk | disk failure and node failure |
| Extras | — | `podAntiAffinity`, PDB (`maxUnavailable: 1`), headless peer Service, ServiceMonitor |

**Note the usable figure.** Erasure coding halves it: provisioning 8× the raw disk buys 4× the
usable capacity. Exports want ~25Gi of that; the rest is media headroom.

**MinIO gets a ServiceMonitor for the first time.** It was not a Prometheus target at all
before, which is why `media-abstraction.md` §4.5's capacity alerting was unbuildable until
now.

## 2. Why it is a destroy-and-recreate, not a migration

Two independent reasons, both structural:

1. **A `Deployment` cannot become a `StatefulSet` in place.** Different kinds, different
   PVC ownership. The old `deployment/minio` and `pvc/minio` must be deleted by hand.
2. **A single-node backend cannot become a 4-node erasure set in place.** MinIO's on-disk
   layout is a property of how the server was started; there is no rebalance-into-erasure
   path.

**Applying `devops/minio/minio.yaml` destroys every object currently in MinIO.** That is not
a side effect to mitigate — it is what the operation is.

There is also a third, smaller blocker: **`spec.clusterIP` is immutable.** The client-facing
`minio` Service currently has a real ClusterIP and the new manifest declares it headless
(`clusterIP: None`), so `kubectl apply` will reject it with a field-immutable error. The
Service must be deleted before applying. See §8 — this is worth a decision, not just a step.

## 3. Why now, and why "later" is worse

### 3a. The safety argument expires

Destroying MinIO is cheap **only because nothing durable is in it.** Verified:

- The only content is CSV exports under an `exports/` prefix
  (`documentation/exports-storage.md`).
- Exports are **transient by design**: a bucket lifecycle rule (`expire-exports-3d`) deletes
  them after 3 days, and the presigned download link dies after 7 hours.
- The exporter **recreates its own bucket and re-applies the lifecycle rule** on the next
  run — `S3StorageBackend._ensure_client` does `bucket_exists` → `make_bucket` →
  `_ensure_lifecycle`, and `set_bucket_lifecycle` is idempotent. It self-heals.
- Everything in a bucket is regenerable from CockroachDB by re-running the export.

**None of that is true of media.** Media is unrecoverable by construction — we hold the only
copy, and Meta offers no download for a handle. The moment researchers upload a file, this
operation stops being "recreate an empty bucket" and becomes "restore from backup" — and
backup is deferred (VIR-24, not yet built).

> **So the window is: while the `media` bucket is empty.** Doing this now costs a maintenance
> window. Doing it after adoption costs a backup that does not exist yet.

### 3b. It destroys the media service accounts, so ordering matters

MinIO service accounts live **inside MinIO**. Destroying it destroys
`media-writer` / `media-reader` (and their staging equivalents) along with everything else.

`devops/minio/media-svcacct.sh` is idempotent, but re-running it **mints fresh key pairs**
(`openssl rand -hex 20` per account). So the secrets must be re-applied and the consuming
pods restarted, or dashboard-server and media-proxy hold credentials that no longer exist.

> **Do this redeploy BEFORE step ② of `media-staging-runbook.md`.** If you provision media
> credentials first and redeploy afterwards, you will silently invalidate them and have to
> redo steps ② and the restarts.

## 4. What is actually lost

| Lost | Impact |
|---|---|
| All export objects in `fly` and `staging` | Researchers re-run any export they still want. Nothing is unrecoverable. |
| In-flight presigned download links (≤7h old) | They 404. The export can be re-run. |
| The `media` / `media-staging` buckets | Empty at time of writing — confirm before proceeding. |
| MinIO service accounts and their policies | Recreated by `media-svcacct.sh`; **new keys**, so secrets must be re-applied. |
| An export running at the moment of the cutover | Fails. Re-runnable. |

**Choose a low-traffic window** and tell researchers exports will be briefly unavailable and
that existing download links will stop working.

## 5. Prerequisites

- [ ] Confirm the `media` bucket is **empty** (if it exists at all). If it has objects, STOP —
      this becomes a restore operation and VIR-24 must land first.
- [ ] Confirm no export is running: check `export_status` for in-progress rows.
- [ ] Confirm the node pool can schedule 4 pods with anti-affinity and provision 4× 50Gi.
      With `podAntiAffinity`, fewer than 4 schedulable nodes leaves pods `Pending` and the
      erasure set never forms.
- [ ] Decide the headless-Service question (§8).

## 6. Procedure

```bash
cd /home/nandan/Documents/vlab-research/fly-media-abstraction

# 1. Record what exists, so the rollback and the verification have a baseline
kubectl -n minio get deploy,sts,svc,pvc,pdb -o wide
kubectl -n minio get pvc minio -o yaml > /tmp/minio-pvc-backup.yaml

# 2. Scale down so nothing writes during the cutover
kubectl -n minio scale deployment/minio --replicas=0

# 3. Remove the old workload and its volume. THIS DELETES ALL OBJECTS.
kubectl -n minio delete deployment/minio
kubectl -n minio delete pvc/minio

# 4. Delete the client-facing Service — clusterIP is immutable and the new one
#    is headless, so apply alone will be rejected (§8)
kubectl -n minio delete svc/minio

# 5. Apply the new manifests from the repo
kubectl apply -f devops/minio/

# 6. Wait for the erasure set to form
kubectl -n minio rollout status statefulset/minio --timeout=5m
kubectl -n minio get pods -o wide      # expect 4, on distinct nodes
```

Then re-provision buckets and credentials — **for both environments**:

```bash
bash devops/minio/media-svcacct.sh production
bash devops/minio/media-svcacct.sh staging

bash devops/secrets.sh vprod dashboard-media dashboard-server/.env-media-production
bash devops/secrets.sh vprod media-proxy     media-proxy/.env-media-production
bash devops/secrets.sh vstag dashboard-media dashboard-server/.env-media-staging
bash devops/secrets.sh vstag media-proxy     media-proxy/.env-media-staging

kubectl rollout restart deployment/gbv-dashboard   -n vprod
kubectl rollout restart deployment/gbv-dashboard   -n vstag
# media-proxy too, once it is deployed
```

The exports buckets (`fly`, `staging`) need no manual step — the exporter recreates them.

## 7. Verification

1. **4 pods Running on distinct nodes**, PDB present, all PVCs Bound.
2. **Exports still work end to end** — trigger one from the dashboard, confirm the object
   lands and the presigned link downloads. This also re-creates the bucket and lifecycle rule.
3. **Lifecycle rule re-applied:** `mc ilm ls` on the exports bucket shows `expire-exports-3d`.
   (`_ensure_lifecycle` is best-effort and logs rather than failing, so a missing rule is
   silent — check it explicitly, or exports accumulate forever.)
4. **Anonymous access denied** on the media bucket — both `GetObject` *and* `ListBucket`,
   including via `storage-api.vlab.digital` (`media-abstraction.md` §4.3).
5. **ServiceMonitor scraping:** MinIO metrics present in Prometheus.
6. **Kill a pod** and confirm reads and writes continue. This is the entire point of the
   change; verify it rather than assume it.

## 8. Open question: should the client Service be headless?

The new manifest makes **both** Services headless. `minio-headless` for peer discovery is
standard and correct. Making the **client-facing** `minio` Service headless is a real change:
consumers resolving `http://minio.minio.svc.cluster.local:9000` would get DNS round-robin
across pod IPs instead of a kube-proxy virtual IP.

For MinIO that mostly works — any node serves any request — but it has consequences:

- Clients with connection keep-alive pin to whichever pod they first resolved, so load is
  unevenly distributed.
- A client that caches DNS may keep hitting a pod that has gone away.
- It is also why `svc/minio` must be deleted rather than applied.

**Recommendation: keep the client Service as a normal ClusterIP** and let only the peer
Service be headless. That preserves current client behaviour, avoids the delete-recreate step
entirely, and is the more common MinIO deployment shape. **Decide before executing** — this
is a one-line change to `devops/minio/minio.yaml`.

## 9. Rollback

There is no rollback that restores objects — they are gone once step 3 runs. What can be
restored is the *shape*:

```bash
kubectl -n minio delete statefulset/minio
kubectl -n minio delete pvc -l app=minio
git checkout HEAD~1 -- devops/minio/minio.yaml   # or the pre-change revision
kubectl apply -f devops/minio/
```

This returns a working single-node MinIO with an empty volume. Exports regenerate; media
would not, which is the whole reason for §3a's window.

## 10. Residual risks

- **Node capacity.** `podAntiAffinity` plus 4 replicas needs 4 schedulable nodes. Fewer means
  `Pending` pods and no erasure set. Check before, not during.
- **PVC sizing is a guess.** 50Gi × 4 was chosen without measured media volume — media has no
  lifecycle rule and only grows. Capacity alerting (shipped) is what makes this recoverable
  rather than a cliff.
- **The lifecycle rule is best-effort.** If `_ensure_lifecycle` fails after the redeploy it
  logs a warning and the export still succeeds — so exports would silently accumulate with no
  expiry. Verification step 3 exists specifically for this.
- **This is production infrastructure shared with staging.** There is no way to rehearse it
  on staging first, because staging *is* the same MinIO. That asymmetry is worth stating out
  loud: unlike everything else in the media build, this step has no staging dress rehearsal.
