# Media Backup — Deferred Plan

**Status:** Deferred 2026-08-10, deliberately. Not on the critical path for the media
abstraction build (`planning/media-abstraction.md`). This document is the plan to execute
later.

**Split out of:** `media-abstraction.md` §4.5, which now points here.

---

## 1. Why this is separable

Backup is the only part of the media build with no code dependency on the rest. It reads a
bucket and writes it somewhere else. Nothing in the send path, the upload path, the
reconciler or the proxy changes when it lands, so deferring it costs no rework — unlike,
say, deferring the handle schema.

It is also the only part whose urgency is driven by **adoption rather than deploy**. Which
is what makes deferring safe today and unsafe later.

## 2. The risk being carried in the meantime

**Media is unrecoverable by construction. We hold the only copy.**

Distributed MinIO (4 replicas, erasure coding) covers disk failure and node failure. It
does **not** cover loss of the cluster's disks — a cluster rebuild, a catastrophic storage
failure, an accidental PVC deletion, a region loss.

If that happens before the mirror is running:

- every asset URL 404s
- every survey referencing dashboard-uploaded media shows a broken image
- **there is no recovery path** — the bytes exist nowhere else, and Meta offers no download
  for an `attachment_id` (the same one-way door as §8.2), so even accounts with live handles
  cannot be used to reconstruct the originals
- researchers would have to locate and re-upload every original file by hand

Note this is strictly worse than the pre-existing exports situation, which tolerates loss
because exports are transient and regenerable from CockroachDB. Media is neither.

### Why it is acceptable right now

The bucket is empty. The feature ships dark (`MEDIA_HANDLE_USE=off`) and the media tab is
not yet in front of researchers, so nothing is being uploaded. Exposure is a function of how
many irreplaceable files are in the bucket, which is currently zero and rises only with use.

### The trigger

> **The mirror must be running before researchers are told the media tab exists.**

Not before merge. Not before the flag flips. Before anyone uploads a file they cannot
reproduce. This is an adoption event, not a date — which means whoever announces the feature
owns checking this first.

A weaker secondary trigger, if adoption is gradual and unannounced: **before the bucket
holds anything a researcher could not trivially re-upload.**

## 3. What to build

Already written and reviewable, not deployed: `devops/backup/minio-media-mirror.yaml`.

| Element | Requirement |
|---|---|
| Mechanism | `mc mirror` CronJob |
| Target | **Off-cluster.** A second bucket on the same MinIO shares the same disks and is not a backup |
| Endpoint | `BACKUP_S3_ENDPOINT` / `BACKUP_S3_BUCKET` + credentials, from env |
| Provider | **Not named anywhere.** S3 API only, per `media-abstraction.md` §4.1 |
| Residency | Operator's choice — may be a compliance constraint for respondent-adjacent data |
| Credentials | Gitignored `.env` applied via `devops/secrets.sh`, per `documentation/secrets.md` |
| Schedule | To decide. Media is write-once-never-mutated, so frequency trades cost against the window of unbacked uploads |

### The one value still missing

**`BACKUP_S3_ENDPOINT` and its bucket + credentials.** This is a decision, not a lookup: it
determines cost, residency, and which failures are actually survived. It must not be the
same MinIO.

## 4. Restore rehearsal — not optional

**A backup that has never been restored is not a backup.** Required before this is called
done:

1. Stand up a clean, empty MinIO.
2. Restore the media bucket from the mirror target into it.
3. Point a media-proxy at it and confirm assets resolve — object present, correct
   `Content-Type` and `Content-Disposition` metadata (the proxy reads those from object
   metadata, so a restore that loses them serves the wrong headers).
4. Confirm a survey referencing a restored asset URL renders.

Step 3 is the one most likely to be skipped and most likely to fail: `mc mirror` must
preserve object metadata, not just bytes. Verify that explicitly rather than assuming it.

## 5. Not deferred

**Capacity alerting stays in the initial deploy** (`media-abstraction.md` §4.5): bucket size
and PVC utilisation. Media has no lifecycle rule — unlike exports' 3-day expiry — so it only
grows. Without alerting, the first symptom of a full volume is failed uploads, which
researchers experience as the feature being broken.

## 6. Open questions for when this is picked up

- **Endpoint and provider** — §3 above. The blocking one.
- **Schedule.** Assets are immutable once written, so a missed cycle only widens the window
  of unbacked *new* uploads; it never corrupts existing backup state.
- **Retention at the target.** Assets are deleted deliberately (researcher action, §11.6).
  Should the mirror propagate deletes, or retain them as a safety net against accidental
  deletion? `mc mirror --remove` versus not. These are opposite failure modes and the choice
  should be explicit.
- **Does the backup need encryption at rest at the target**, given §4.6 states media is
  non-confidential by design? Probably not, but state it rather than assume it.
