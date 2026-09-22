# Media Backup — Plan

**Status:** Backup running since 2026-09-12 — nightly copy of MinIO `media` into
`gs://vlab-research-media-backups` under Workload Identity. **The restore rehearsal (§4) is
still outstanding**; until it passes, this is an untested backup.

Operator doc: `documentation/backups.md` § "Media backup (MinIO -> GCS)".
Split out of `media-abstraction.md` §4.5. Tracked in Linear as VIR-24.

---

## 1. Why this is separable

Backup is the only part of the media build with no code dependency on the rest. It reads a
bucket and writes it somewhere else. Nothing in the send path, the upload path, the
reconciler or the proxy changes when it lands.

It was deferred out of the initial deploy on 2026-08-10 because the bucket was empty and the
feature shipped dark. That stopped being true: by 2026-09-12 production held 73 assets
(32.6 MiB) from 3 accounts with `MEDIA_HANDLE_USE=true`, and the backup was built then.

## 2. The risk it covers

**Media is unrecoverable by construction. We hold the only copy.**

Distributed MinIO (4 replicas, erasure coding) covers disk failure and node failure. It
does **not** cover loss of the cluster's disks — a cluster rebuild, a catastrophic storage
failure, an accidental PVC deletion.

Without an off-cluster copy:

- every asset URL 404s
- every survey referencing dashboard-uploaded media shows a broken image
- **there is no recovery path** — the bytes exist nowhere else, and Meta offers no download
  for an `attachment_id`, so even accounts with live handles cannot reconstruct the originals
- researchers would have to locate and re-upload every original file by hand

## 3. What was built, and why

| Element | Decision |
|---|---|
| Target | `gs://vlab-research-media-backups`, `europe-west1`, same GCP project as the cluster. Off-cluster: survives cluster, disk and PVC loss. Does not survive loss of the GCP project — the same trade the CockroachDB backup makes |
| Identity | Workload Identity: KSA `minio/minio-media-mirror` → GSA `media-backup@`. No GCS credential on disk, in the repo, or in Terraform state |
| Tool | `gcloud storage rsync`, in `devops/backup/minio-media-mirror.yaml` |
| Schedule | Daily, 03:00 UTC |
| Deletes | Not propagated (no `--delete-unmatched-destination-objects`). A backup that copies deletions is a replica: an accidental delete reaches the only other copy before anyone notices |
| Overwrites | Bucket is versioned; noncurrent versions are purged after 30 days |
| Encryption at rest | GCS default (Google-managed keys). Media is non-confidential by design (`media-abstraction.md` §4.6), so no CMEK |
| Failure alerting | Generic CronJob rules; the run fails if any source key is absent from the target |
| IaC | `infra/modules/media-backup` (bucket, IAM, WI binding) + the CronJob manifest |

### Relationship to the S3-only rule

`media-abstraction.md` §4.1 says the application reaches storage over the S3 API only. The
backup job is infrastructure beside the application, like CockroachDB's GCS backup, so it
uses GCS's native API and Workload Identity. The application's storage access is unchanged.

A provider-neutral alternative — `mc mirror` to GCS's S3-compatible XML API — was rejected:
an S3 client can only authenticate there with a long-lived HMAC key. If a second target is
ever needed, the shape is a writer per provider (GCS native + WI, AWS native + IRSA, generic
S3), not one S3 client for all of them.

### Why gcloud and not rclone

rclone was tried first and its first run passed every byte and count check — and silently
dropped `Content-Disposition` on all 73 objects. rclone's GCS backend has no metadata
support (`ReadMetadata`/`WriteMetadata: false`), so only `Content-Type` survives, in either
direction. media-proxy serves both headers from object metadata, so a restore from that copy
would lose every original filename. `gcloud storage cp` / `rsync` from S3 into GCS preserves
both, verified on a copied object.

A byte-and-count check cannot catch this class of failure. The metadata check in
`documentation/backups.md` is the one that does.

## 4. Restore rehearsal — not optional, still outstanding

**A backup that has never been restored is not a backup.** Required before this is called
done:

1. Stand up a clean, empty MinIO.
2. Restore the media bucket from `gs://vlab-research-media-backups` into it with
   `gcloud storage rsync` (not rclone — §3).
3. Point a media-proxy at it and confirm assets resolve — object present, correct
   `Content-Type` and `Content-Disposition` served (the proxy reads those from object
   metadata, so a restore that loses them serves the wrong headers).
4. Confirm a survey referencing a restored asset URL renders.

Step 3 is the one most likely to be skipped and most likely to fail. The GCS → S3 direction
has not been verified to preserve metadata; §3 only covers S3 → GCS.

## 5. Not deferred

**Capacity alerting shipped with the feature** (`media-abstraction.md` §4.5): bucket size and
PVC utilisation. Media has no lifecycle rule — unlike exports' 3-day expiry — so it only
grows.

## 6. Still open

- **Self-service delete.** Dropped from v1 partly because delete plus no backup meant one
  click was permanent loss. With the backup running, a deleted asset survives in GCS
  (deletes are not propagated), so this can be revisited once §4 passes.
