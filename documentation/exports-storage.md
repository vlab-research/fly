# Export Storage & Retention

CSV exports (full messages, chat logs, response exports — see
`full-messages-export.md`) are written to object storage under an `exports/`
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

MinIO is a hand-rolled single-node deployment using the upstream `minio/minio`
image (not the Bitnami helm chart). Its manifests live in `devops/minio/`
(Deployment, PVC, Services, Ingresses) and are applied directly:

```
kubectl apply -f devops/minio/
```

The `minio-auth` Secret (root credentials) is managed out-of-band and is not in
the repo. The two `devops/values/minio*.yaml` Bitnami-style values files are
**not** used by this deployment (they predate it / relate to a possible future
chart migration).

The PVC size (`devops/minio/minio.yaml`, 25Gi) is sized for headroom over the
3-day retention window, since individual `*_full_messages.csv` exports can reach
~1.6G and several may coexist within the window. `standard-rwo` (GKE `pd.csi`)
supports online expansion, so growing it is a non-destructive apply.
