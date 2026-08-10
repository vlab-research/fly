# MinIO: Single-Node → Distributed Redeploy

**Status: EXECUTED 2026-08-10.** Outcome, verification results, and the one problem it
surfaced are in §11. The sections below are kept as written — they are the record of why this
was done and how, and §7's remaining steps still need a human-triggered export.

**Related:** `planning/media-abstraction.md` §4.2, `planning/media-staging-runbook.md`,
`planning/media-backup.md` (VIR-24), `documentation/exports-storage.md`.

**Live state verified 2026-08-10** (`kubectl -n minio get deploy,sts,svc,pvc,pdb`, plus
`ls /data` inside the pod):

| Checked | Found |
|---|---|
| Workload | `deployment/minio`, 1/1, image `RELEASE.2025-09-07T16-13-09Z` — matches the manifest's pin |
| Volume | `pvc/minio`, 25Gi, Bound, `standard-rwo`, **272M used of 25G** |
| Buckets on disk | `fly` (271M) and `staging` (empty) only |
| `media` / `media-staging` | **Do not exist yet** — §3a's window is fully open |
| `svc/minio` | ClusterIP `10.91.9.78`, port 9000 only |
| Nodes | 4 × `gke-toixo-bigpool-*`, all `Ready` |
| PDB / ServiceMonitor / headless Service | None — all new |

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

**MinIO gets a ServiceMonitor for bucket metrics**, which is why `media-abstraction.md` §4.5's
capacity alerting was unbuildable until now. An earlier draft said MinIO "was not a Prometheus
target at all before" — false, and it matters: a three-year-old orphaned ServiceMonitor from
the retired Bitnami chart lives in `monitoring` and now triple-scrapes cluster metrics. See
§11.

## 2. Why it is a destroy-and-recreate, not a migration

Two independent reasons, both structural:

1. **A `Deployment` cannot become a `StatefulSet` in place.** Different kinds, different
   PVC ownership. The old `deployment/minio` and `pvc/minio` must be deleted by hand.
2. **A single-node backend cannot become a 4-node erasure set in place.** MinIO's on-disk
   layout is a property of how the server was started; there is no rebalance-into-erasure
   path.

**Applying `devops/minio/minio.yaml` destroys every object currently in MinIO.** That is not
a side effect to mitigate — it is what the operation is.

**The Services, by contrast, apply cleanly in place.** An earlier draft of this plan claimed
the client-facing `minio` Service had to be deleted first because `spec.clusterIP` is
immutable and the new manifest made it headless. That is not what the manifest says — only
`minio-headless` carries `clusterIP: None`; the client `minio` Service is a normal ClusterIP
(§8). Applying it adds the named `metrics` port (9002) to the existing Service, which is an
ordinary mutable update. No Service delete step is needed.

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
there is nothing to restore from. `devops/backup/minio-media-mirror.yaml` is *written* but
**not deployed**, and is blocked on an unmade decision (`BACKUP_S3_ENDPOINT` and its
provider — `planning/media-backup.md` §3).

> **So the window is: while the `media` bucket is empty.** As of 2026-08-10 it does not exist
> at all, so the window is not merely open — nothing has been staked on it yet. Doing this now
> costs a maintenance window. Doing it after adoption costs a restore from a mirror that is
> not running.

### 3b. It destroys the media service accounts, so ordering matters

MinIO service accounts live **inside MinIO**. Destroying it destroys
`media-writer` / `media-reader` — and, in production, the mirror's read-only backup account —
along with everything else.

`devops/minio/media-svcacct.sh` is idempotent, but re-running it **mints fresh key pairs**
(`openssl rand -hex 20` per account). So the secrets must be re-applied and the consuming
pods restarted, or dashboard-server and media-proxy hold credentials that no longer exist.

> **Do this redeploy BEFORE step ② of `media-staging-runbook.md`.** If you provision media
> credentials first and redeploy afterwards, you will silently invalidate them and have to
> redo steps ② and the restarts.

## 4. What is actually lost

| Lost | Impact |
|---|---|
| All export objects in `fly` (271M) and `staging` (empty) | Researchers re-run any export they still want. Nothing is unrecoverable. |
| In-flight presigned download links (≤7h old) | They 404. The export can be re-run. |
| The `media` / `media-staging` buckets | **They do not exist yet** (verified 2026-08-10) — nothing to lose. Re-confirm before proceeding. |
| MinIO service accounts and their policies | Recreated by `media-svcacct.sh`; **new keys**, so secrets must be re-applied. |
| An export running at the moment of the cutover | Fails. Re-runnable. |

**Decided 2026-08-10: losing the exports is accepted.** They are regenerable from CockroachDB
and this is not a reason to delay. What remains is operational courtesy, not a blocker:
**choose a low-traffic window** and tell researchers exports will be briefly unavailable and
that existing download links will stop working.

## 5. Prerequisites

- [x] **`media` bucket empty** — verified 2026-08-10: it does not exist. `ls /data` in the
      pod shows only `fly`, `staging`, `lost+found`. If it ever *does* hold objects, STOP —
      this becomes a restore operation and VIR-24 must land first.
- [ ] Confirm no export is running: check `export_status` for in-progress rows. (Point-in-time
      — re-check immediately before step 2.)
- [x] **Node pool** — 4 `Ready` nodes as of 2026-08-10, and 4× 50Gi is dynamically
      provisioned from `standard-rwo`. Note the anti-affinity in the manifest is
      `preferredDuringSchedulingIgnoredDuringExecution`, **not** `required`: with fewer than
      4 nodes the pods still schedule and the erasure set still forms — two shards just share
      a node, which is a redundancy loss, not an outage. Deliberate; see the manifest comment.
- [x] **Headless-Service question** — already settled in the manifest (§8). No decision left.
- [x] **The five gitignored `.env` files exist** — created from their templates 2026-08-10.
      `media-svcacct.sh` refuses to create them and exits before doing any work, so a missing
      file means a destroyed MinIO with no way to mint the media accounts until you notice:

          dashboard-server/.env-media-production   .env-media-staging
          media-proxy/.env-media-production        .env-media-staging
          devops/backup/.env-media-mirror          (production run only)

      They are empty templates; the script writes the keys into them.

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

# 4. Apply the new manifests from the repo. svc/minio is updated in place —
#    it stays a normal ClusterIP and just gains the `metrics` port (§8).
kubectl apply -f devops/minio/

# 5. Wait for the erasure set to form
kubectl -n minio rollout status statefulset/minio --timeout=5m
# Expect 4 Running. With 4 Ready nodes they should land on distinct ones, but
# the affinity is only `preferred` — check placement, do not assume it (§10).
kubectl -n minio get pods -o wide
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

`media-svcacct.sh production` also mints the mirror's read-only backup account and rewrites
`devops/backup/.env-media-mirror`. Nothing consumes it yet — the CronJob is not deployed
(`media-backup.md`) — but if it ever *is* running when this redeploy happens, that secret
must be re-applied and the CronJob's next run will otherwise fail on stale credentials.

The exports buckets (`fly`, `staging`) need no manual step — the exporter recreates them.

## 7. Verification

1. **4 pods Running on distinct nodes**, PDB present, all PVCs Bound.
2. **Exports still work end to end** — trigger one from the dashboard, confirm the object
   lands and the presigned link downloads. This also re-creates the bucket and lifecycle rule.
3. **Lifecycle rule re-applied:** `mc ilm ls` on the exports bucket shows `expire-exports-3d`.
   (On Arch the client is `pacman -S minio-client` and the binary is **`mcli`** — Midnight
   Commander already owns the name `mc`. The provisioning script is unaffected: it runs `mc`
   in an ephemeral in-cluster pod, not on your machine.)
   (`_ensure_lifecycle` is best-effort and logs rather than failing, so a missing rule is
   silent — check it explicitly, or exports accumulate forever.)
4. **Anonymous access denied** on the media bucket — both `GetObject` *and* `ListBucket`,
   including via `storage-api.vlab.digital` (`media-abstraction.md` §4.3).
5. **ServiceMonitor scraping:** MinIO metrics present in Prometheus.
6. **Kill a pod** and confirm reads and writes continue. This is the entire point of the
   change; verify it rather than assume it.

## 8. Settled: only the peer Service is headless

Recorded because an earlier draft of this plan raised it as an open question and got the
premise wrong. The manifest was checked: **only `minio-headless` sets `clusterIP: None`.**
The client-facing `minio` Service is a normal ClusterIP, which is what we want, for the
reasons that made it a question at all —

- headless would mean DNS round-robin across pod IPs instead of a kube-proxy virtual IP;
- clients with connection keep-alive would pin to whichever pod they first resolved;
- a client caching DNS could keep hitting a pod that has gone away.

Two details of the manifest are worth knowing rather than rediscovering:

- `minio-headless` sets `publishNotReadyAddresses: true`. It must — a distributed MinIO is
  only Ready once it has quorum, and quorum requires peers to resolve each other first.
  Without it, startup deadlocks.
- The client Service's readiness selection is load-bearing in the other direction: it serves
  only Ready pods, so a node that has lost quorum is taken out of rotation automatically.

**No action, and no Service delete step.** The plan previously carried one; it has been
removed from §6.

## 9. Rollback

There is no rollback that restores objects — they are gone once step 3 runs. What can be
restored is the *shape*:

```bash
kubectl -n minio delete statefulset/minio
kubectl -n minio delete pdb/minio
# NOTE the label. The volumeClaimTemplate labels PVCs with
# app.kubernetes.io/instance=minio — there is no `app=minio` label anywhere in
# the manifest, so `-l app=minio` matches nothing and silently deletes no PVCs.
kubectl -n minio delete pvc -l app.kubernetes.io/instance=minio

# 95e74fdf is the last single-node revision (Deployment + one 25Gi PVC).
# HEAD~1 is NOT it — the StatefulSet rewrite landed in 6c91adbb, one commit
# before the plan commit.
git show 95e74fdf:devops/minio/minio.yaml > devops/minio/minio.yaml
kubectl apply -f devops/minio/minio.yaml
```

`devops/minio/servicemonitor.yaml` has no single-node counterpart; leave it applied or delete
it, either is harmless.

This returns a working single-node MinIO with an empty volume. Exports regenerate; media
would not, which is the whole reason for §3a's window.

## 10. Residual risks

- **Node capacity — a redundancy risk, not a scheduling one.** The anti-affinity is
  `preferred`, so fewer than 4 schedulable nodes does *not* leave pods `Pending`; it silently
  co-locates shards, so one node loss can take two of four drives. That is still within EC:2
  tolerance, but it eliminates the margin. 4 nodes are `Ready` today; verify placement after
  the rollout (`get pods -o wide`) rather than trusting the node count at apply time.
- **PVC sizing is a guess.** 50Gi × 4 was chosen without measured media volume — media has no
  lifecycle rule and only grows. Today's whole dataset is 272M, so the guess is generous for
  exports; it is media that is unmodelled. `standard-rwo` expands online, so growing is safe;
  shrinking and changing the replica count are not. Capacity alerting (shipped) is what makes
  this recoverable rather than a cliff.
- **The lifecycle rule is best-effort.** If `_ensure_lifecycle` fails after the redeploy it
  logs a warning and the export still succeeds — so exports would silently accumulate with no
  expiry. Verification step 3 exists specifically for this.
- **This is production infrastructure shared with staging.** There is no way to rehearse it
  on staging first, because staging *is* the same MinIO. That asymmetry is worth stating out
  loud: unlike everything else in the media build, this step has no staging dress rehearsal.

## 11. Executed 2026-08-10 — outcome and one thing it surfaced

Executed in full. Result: 4/4 pods `Running` on four distinct nodes, `1 set(s), 4 drives per
set` formatted, PDB allowing 1 disruption, all four 50Gi PVCs Bound, `service/minio`
**configured in place** (confirming §8 — no delete was needed).

Verified, not assumed:

| Check | Result |
|---|---|
| No in-flight export | Both exporter pods idle since 2026-08-07 18:21, last line `finished` |
| Round-trip write/read | 3MB object, sha256 match |
| **Kill a pod, keep serving** | `minio-2` deleted; read *and* write both succeeded while it was `0/1`, sha256 match; pod recovered to `1/1` |
| Anonymous access | 403 on `GET`/list for `media` and `media-staging`, via `storage-api.vlab.digital` |
| Prometheus | All 4 pods `up=1` |
| Buckets + accounts | `media`, `media-staging` created; six service accounts minted; four secrets applied; both `gbv-dashboard` deployments restarted |

**Still outstanding — needs a human-triggered export** (§7 steps 2 and 3). The `fly` and
`staging` buckets are gone and are recreated by the exporter's next run, so nothing proves
that path works until someone triggers an export from the dashboard. When you do, also check
the lifecycle rule landed — `_ensure_lifecycle` is best-effort and fails silently, and without
it exports accumulate forever:

```bash
kubectl -n minio port-forward svc/minio 9900:9000 &
mcli alias set m http://127.0.0.1:9900 "$ROOT_USER" "$ROOT_PASSWORD"
mcli ilm ls m/fly          # expect expire-exports-3d
```

### The orphaned ServiceMonitor

The cutover surfaced a pre-existing problem it did not cause. A **second ServiceMonitor named
`minio`, in the `monitoring` namespace, 3 years old**, left by the retired Bitnami chart
(`minio-12.6.4`), scrapes `/minio/v2/metrics/cluster` on port `minio-api`. Nothing in this
repo governs it — it is pure drift, and it invalidated the claim that MinIO had no
ServiceMonitor.

Because its selector matches the labels on **both** `minio` and the new `minio-headless`
Service, and both expose a port named `minio-api`, cluster metrics are now ingested **three
times per pod** — measured: 12 series for `minio_cluster_capacity_usable_free_bytes` where 4
are expected.

Consequences, in order of importance:

1. **`MinioDrivesOffline` reports a wrong number.** Its expression is
   `sum(minio_cluster_drive_offline_total) > 0`. `minio_cluster_drive_offline_total` is a
   *cluster-wide* value reported by *every* node, so `sum()` already over-counted 4× before
   this change; it is now 12×. The alert still fires correctly (0 sums to 0), but its summary
   would say "12 drive(s) offline" when one is. **`max()` is the correct aggregator here**, as
   `MediaBucketSizeHigh` already uses.
2. `MediaBucketSizeHigh` is unaffected — `max() by (bucket)` is idempotent over duplicates.
3. Three times the storage for those series.

Not fixed, deliberately: deleting live state that no repo file governs, and changing an
alert's aggregation, are both decisions rather than cleanup.

## 12. Monitoring, 2026-08-10 — and a third "written but not deployed"

Checked after the cutover, because §7 step 5 only proves *scraping* works, not that anything
would ever tell a human.

**Prometheus and Alertmanager were fine.** All 4 pods `up=1`; `minio_bucket_usage_total_bytes`
present for `media` and `media-staging`. (`fly` lags — those series come from MinIO's
background scanner, not per scrape.) Alertmanager healthy, `Watchdog` firing as designed,
routing to `#vlab-alerts` / `#vlab-alerts-critical` + ntfy per `documentation/alerting.md`.

**But none of the media alerting was deployed.** Zero PrometheusRules in the cluster contained
`MinioPVCSpaceCritical`, `MediaBucketSizeHigh`, `MinioDrivesOffline`, or any media-handle
alert. Cause: the `vlab-alerts` release was at revision 9 from **2026-08-04**, and both media
templates landed after it (`6c91adbb`, `a2c661fe`). Written, committed, `enabled: true`, never
applied.

That mattered here specifically. The 50Gi × 4 sizing in §10 is justified by "capacity alerting
is what makes this recoverable rather than a cliff" — and it was not running, over volumes
holding a bucket with no lifecycle rule.

> Three times in one day the repo described something as in place when only the file existed:
> the mirror CronJob, MinIO's ServiceMonitor history, and this. **"Committed" and "running"
> are different claims.** Prefer checking the cluster over reading the doc that asserts it.

### Fixed before deploying, not after

`MinioDrivesOffline` used `sum(minio_cluster_drive_offline_total)`. That metric is
**cluster-wide but reported by every node**, so `sum()` over-counted 4× before today and 12×
after the triple-scrape. `> 0` still fired correctly, but the page would have claimed *12
drives offline when one was* — a critical alert misstating its own severity. Changed to
`max()`, which is correct under any number of duplicate series, then deployed.

`helm upgrade --install vlab-alerts devops/alerts -n monitoring` → **revision 10**. Verified
first that `kafka-consumer-health`, which exists in the cluster but not in this chart, belongs
to a *different* release and so would not be swept: the upgrade added 2 rules and deleted none.

(`--install` is an upsert and a no-op against an existing release; it is in `alerting.md` so
the command also works on a fresh cluster. Its one cost is that a mistyped release name
silently creates a new release instead of erroring.)

### The orphaned ServiceMonitor — deleted 2026-08-10

Confirmed a true tombstone first: no helm release named `minio` exists, not even a failed one,
and no release secrets for it. Then `kubectl -n monitoring delete servicemonitor minio`.
A copy of the manifest was taken beforehand.

Triplication resolved, verified rather than assumed:

- **Before:** 12 series for `minio_cluster_capacity_usable_free_bytes` across three
  `(job, endpoint)` pairs. **After:** 4, from one — `job=minio, endpoint=metrics`.
- Active scrape pools are now only `serviceMonitor/minio/minio/{0,1}` (this repo's).

**A trap worth knowing if you ever re-verify this:** for several minutes after the delete, an
instant query still returns the dead series. That is not a failed deletion — Prometheus looks
back 5 minutes, so a removed target's last sample stays visible until it ages out. Waiting for
the count to drop looks like a hang. The signal that actually distinguishes "still scraped"
from "already dead" is **sample age**:

```promql
max by (endpoint) (time() - timestamp(minio_cluster_capacity_usable_free_bytes))
```

A live endpoint sits near the scrape interval (~25s here); a dead one climbs without bound
(236s and rising, at the moment of checking). Age answers in one query what a count takes five
minutes to answer.
