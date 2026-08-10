# Export Storage & Retention

CSV exports (full messages, chat logs, response exports — see
`full-messages-export.md` and `exporter/README.md`) are written to object storage under an `exports/`
prefix. In production the backend is a single-node MinIO (S3-compatible); the
exporter selects the backend via the `STORAGE_BACKEND` env var
(`google` → GCS, `s3` → MinIO, unset → dev no-op). See
`exporter/exporter/storage.py`.

## Lifecycle: exports are temporary

Exports are transient by design. After an export completes, the exporter hands
the dashboard a **presigned download URL that expires after 7 hours**
(`generate_link` in `storage.py`). The object itself, however, is not deleted by
the application — so without a retention policy, exports accumulate indefinitely
and eventually fill the MinIO volume.

Retention is therefore enforced **server-side by a MinIO bucket lifecycle
rule**, not by the app deleting files and not by any cron/manual step:

| Rule (`expire-exports-3d`, prefix `exports/`) | Effect |
|---|---|
| `Expiration: 3 days` | Objects are deleted 3 days after creation. The download link is dead after 7h, so 3 days is a generous buffer. |
| `AbortIncompleteMultipartUpload: 1 day` | Abandoned multipart uploads (orphaned parts left by failed large-CSV uploads) are reclaimed 1 day after initiation. |

Expiration is asynchronous — MinIO's scanner applies it on a periodic sweep
(~daily), so objects are removed *on or after* the day count, not at an exact
timestamp. That is fine for temp storage.

### Why a lifecycle rule, not per-object TTL

S3/MinIO has **no per-object, write-time TTL**. `x-amz-expiration` is a response
header computed from the bucket lifecycle config; a client cannot set expiry on a
`PUT`. The only write-time lever is object tagging combined with a tag-filtered
lifecycle rule, which is only worth it when different objects need different
TTLs. All exports share one TTL, so a single prefix-scoped rule is the correct,
idiomatic mechanism.

Lifecycle requires MinIO's erasure backend (`xl-single` for single-node,
identified by `xl.meta` files on disk). The legacy `filesystem` backend rejected
lifecycle (`GetLifecycle is not supported for filesystem`) and was removed in
`RELEASE.2022-10-29`; all current deployments use the erasure backend.

## Where the rule is defined (infrastructure as code)

The rule is applied declaratively by the exporter itself, in
`S3StorageBackend._ensure_lifecycle` (`exporter/exporter/storage.py`), called
from `_ensure_client` alongside the bucket-existence check.
`set_bucket_lifecycle` is idempotent, so it is safely re-applied on every export
and self-heals if the bucket is recreated. It is best-effort: a lifecycle API
error is logged (`log.warning`) but never fails an export.

There is intentionally **no** standalone `mc` command, Kubernetes Job, or CronJob
maintaining this — the policy lives with the code that writes the objects and is
applied on deploy.

## Deployment & volume sizing

MinIO is a hand-rolled deployment using the upstream `minio/minio` image (not the
Bitnami helm chart). Its manifests live in `devops/minio/` (StatefulSet, Services,
Ingresses, ServiceMonitor) and are applied directly:

```
kubectl apply -f devops/minio/
```

The `minio-auth` Secret (root credentials, keys `root-user` / `root-password`) is
managed out-of-band and is not in the repo. The `devops/values/minio*.yaml`
Bitnami-style values files are **not** used by this deployment (they predate it /
relate to a possible future chart migration) — `devops/values/minio.yaml` is kept
in sync with `devops/minio/minio.yaml` by hand and says so at the top.

### Distributed, since media

It was a **single-node Deployment with one 25Gi RWO PVC** until media assets
arrived. It is now a **4-replica StatefulSet, one 50Gi PVC each**, erasure-coded
(`planning/media-abstraction.md` §4.2).

Exports never needed that: they are transient and regenerable from CockroachDB,
so losing a disk cost a re-run. **Media is unrecoverable by construction** — the
bucket holds the only copy of a researcher's uploaded file, and Meta offers no
download for an `attachment_id` — so a single disk stopped being an acceptable
floor. Exports get the redundancy as a side effect of sharing the cluster.

Two consequences worth knowing before touching it:

- **Usable capacity is half of raw.** With 4 drives MinIO defaults to EC:2 (2
  data + 2 parity shards), so 4 × 50Gi = 200Gi raw ≈ 100Gi usable. It survives
  the loss of any 2 drives or nodes and no more.
- **Changing the shape is destroy-and-recreate, not a migration.** MinIO cannot
  resize an erasure set, and a Deployment cannot become a StatefulSet in place.
  The conversion was safe *only* because exports are transient and the exporter
  recreates its bucket and lifecycle rule via `_ensure_client`. Once the media
  bucket holds real assets that is no longer true, and any further change
  requires a restore from the off-cluster mirror
  (`devops/backup/minio-media-mirror.yaml`). Growing capacity means growing the
  PVCs (`standard-rwo` expands online) or adding a server pool — never editing
  the replica count.

Capacity is now alerted on: see `documentation/alerting.md` §10. Metrics reach
Prometheus through `devops/minio/servicemonitor.yaml`; MinIO was not a target at
all before this.

### One MinIO, several buckets

A single MinIO instance in the `minio` namespace serves both environments, split
by bucket. All reach it in-cluster at `minio.minio.svc.cluster.local:9000`, and
the exporters also over `storage-api.vlab.digital`:

| Env | Bucket | Contents | Credential |
|---|---|---|---|
| `vprod` | `fly` | exports (3-day lifecycle) | MinIO **root** credentials |
| `vstag` | `staging` | exports (3-day lifecycle) | `staging-exporter` service account, scoped to `staging` |
| `vprod` | `media` | **permanent** media assets | three scoped accounts — see below |
| `vstag` | `media-staging` | **permanent** media assets | three scoped accounts — see below |

### The media buckets are deliberately outside the lifecycle rule

`media` / `media-staging` are separate buckets rather than a prefix beside
`exports/`, and they have **no lifecycle rule at all**. An asset URL is
permanently readable by anyone holding it, so nothing may expire objects out from
under a published survey. Different posture, different blast radius — and the
reason capacity alerting exists for media and not for exports.

They are also **fully private with no anonymous policy of any kind**. The only
read path is the media-proxy on `media.vlab.digital` (`media-proxy/README.md`).
MinIO's canned anonymous policies are traps: `download` grants `s3:GetObject`
*and* `s3:ListBucket` — exactly the enumeration it appears to prevent — and
`public` grants write.

Three scoped service accounts per media bucket, provisioned by
`devops/minio/media-svcacct.sh` from policy files checked in at
`devops/minio-media-*.json`:

| Account | Consumer | Grants |
|---|---|---|
| `<bucket>-writer` | dashboard-server | Get/Put/Delete on `<bucket>/*` |
| `<bucket>-reader` | media-proxy | Get on `<bucket>/*`, **no ListBucket** |
| `<bucket>-backup` | the `mc mirror` CronJob | Get + List (production only) |

The reader has no `ListBucket` because asset URLs are unguessable capability
URLs; the backup account is a separate identity precisely because `mc mirror`
does need it. None of the three can reach the exports buckets.

The env-scoped split (`media` vs `media-staging`) mirrors the existing
`fly`/`staging` split and is **not** specified in the media plan — it is here
because a shared bucket would give a staging deploy `DeleteObject` on production
media, and would make staging test uploads permanent objects served from
`media.vlab.digital`.

Production using root credentials is legacy, not a pattern to copy — a scoped
service account per environment is the intended shape. Staging's is provisioned
declaratively by `devops/minio/staging-svcacct.sh`, which creates the bucket and
the service account (with an embedded policy granting object read/write plus
`Get/PutLifecycleConfiguration` on that bucket only), then writes the generated
credentials into the gitignored `exporter/.env-staging`. It runs `mc` inside the
cluster so the root credentials are read from `minio-auth` by the pod and never
touch a shell or the repo. Re-running it rotates the key pair.

The lifecycle rule requires `s3:PutLifecycleConfiguration` on the bucket — a
scoped policy that omits it leaves exports accumulating forever, silently, since
`_ensure_lifecycle` is best-effort.

The PVC size (`devops/minio/minio.yaml`, 25Gi) is sized for headroom over the
3-day retention window, since individual `*_full_messages.csv` exports can reach
~1.6G and several may coexist within the window. `standard-rwo` (GKE `pd.csi`)
supports online expansion, so growing it is a non-destructive apply.
