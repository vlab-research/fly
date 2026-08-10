# Media Abstraction — Staging Deployment Runbook

**Purpose:** deploy and verify the media abstraction on staging, ahead of production.
**Plan:** `planning/media-abstraction.md` (§9.2 deploy sequence, §9.3 release artifacts).

Every command applies a file from the repo. Nothing here is an ad-hoc mutation
(`CLAUDE.md` — Everything Is Infrastructure as Code).

---

## The one thing that makes staging cheap

**Skip the distributed MinIO rewrite for staging.**

MinIO is a **shared singleton** — one Deployment (1 replica, 25Gi PVC) in the `minio`
namespace, serving `storage-api.vlab.digital` for *both* environments: buckets `fly`
(production exports), `staging`, and now `media` / `media-staging`.

So §9.2 step 1 — the Deployment → 4-replica StatefulSet rewrite — is **not a staging-scoped
change**. It is destroy-and-recreate on infrastructure production depends on, and it cannot
be done "just for staging".

It is also **not required to test this feature.** Distributed mode buys durability against
disk and node failure; it changes nothing functional. Everything below works on the existing
single-node MinIO.

> **Do the distributed rewrite as its own maintenance window before production, not before
> staging.** It is safe only while the `media` bucket is empty — see `planning/media-backup.md`.

**Ordering caveat, if that window is imminent.** "Not before staging" means staging does not
*depend* on the rewrite — not that step 2 below should run first. The rewrite destroys MinIO's
service accounts, and `media-svcacct.sh` mints fresh keys on every run, so provisioning
staging credentials first and rewriting afterwards **silently invalidates them**: you would
have to redo step 2 and the step 6 restart. If the window is imminent, do the rewrite first,
then run step 2 once. See `planning/minio-distributed-redeploy.md` §3b.

## Known staging limitations, before you start

Measured 2026-08-10 against the staging database:

| Fact | Consequence |
|---|---|
| **0 `whatsapp_business` credentials** | The WhatsApp half of the smoke test **cannot run on staging**. Fan-out targets 2 Facebook pages only. Anything WhatsApp-specific stays unverified until production — do not read a green staging run as full coverage. |
| 2 `facebook_page` credentials | Each asset should produce exactly 2 handle rows. |
| 16 rows in the legacy `chatroach.media` table | Dropped by migration 24. Loses list-view history only; no send path reads that table. |
| 26 surveys | Small enough to eyeball. |

---

## 1. Release artifacts (post-merge, pre-deploy)

Neither image exists yet, and neither can be built before merge — a tag builds from the
tagged commit (§9.3).

```bash
git push origin <merge-target>
git tag media-proxy-v0.0.1 && git push origin media-proxy-v0.0.1
git tag dashboard-v0.0.72  && git push origin dashboard-v0.0.72
```

Both are already wired: `media-proxy` was added to `.github/workflows/release.yml`'s service
map (it would otherwise fail with *"Unknown service"*), and `versionDashboard: v0.0.72` /
`versionMediaProxy: v0.0.1` are set in both values files.

**Wait for CI to publish both images before step 4.** A values file pointing at an image that
does not exist gives `ImagePullBackOff` for media-proxy, and an hourly `Cannot find module`
for the reconciler CronJob (which does fire `KubeJobFailed` to `#vlab-alerts` — loud, but
avoidable).

## 2. Storage: bucket and scoped credentials

**Non-destructive.** Creates a bucket and service accounts on the existing MinIO; touches
nothing that exists.

```bash
bash devops/minio/media-svcacct.sh staging
bash devops/secrets.sh vstag dashboard-media dashboard-server/.env-media-staging
```

Three scoped credentials are created, deliberately (§4.3 specifies one; three are needed):

| Credential | Grants | Why separate |
|---|---|---|
| dashboard-server | Get/Put/Delete on `media-staging/*` | The writer |
| media-proxy | `GetObject` only — **no `ListBucket`** | A compromised proxy must not be able to enumerate the bucket |
| mirror | Get + List | Backup only; deferred (VIR-24) |

None is the root `minio-auth`, and none can reach the exports bucket, which holds respondent
data.

## 3. DNS — do this early, it is the long pole

`staging.media.vlab.digital` → the same nginx ingress load balancer as the other
`vlab.digital` hosts.

**It must resolve *before* step 4 applies the ingress.** Otherwise the ACME HTTP-01 challenge
cannot complete and cert-manager leaves a *stuck Order* rather than reporting an obvious
failure — a slow, confusing failure mode.

## 4. Schema

```bash
bash devops/run-migration.sh vstag devops/migrations/24-media-assets.sql
```

Drops `chatroach.media` (16 rows on staging) and creates `media_asset` / `media_handle`.
Verify grants afterwards as `chatreader` and `chatroach`.

## 5. Deploy

```bash
kubectl apply -f devops/media-ingress.yaml          # applies BOTH documents; vstag is the second
helm upgrade gbv devops/vlab -f devops/values/staging.yaml -n vstag
kubectl rollout restart deployment/gbv-dashboard -n vstag   # pods do not reload secrets
```

`MEDIA_HANDLE_USE` is `false` in the staging values. **Leave it false for step 6.**

## 6. Verify with the flag OFF — nothing respondent-visible changes

1. `curl -I https://staging.media.vlab.digital/a/00000000-0000-0000-0000-000000000000` → 404
   (proves TLS, ingress and the proxy's path validation, without needing an asset)
2. Upload a file via the dashboard media page. It must succeed **with no page selector**.
3. Confirm the object exists in `media-staging` with the right `Content-Type` and
   `Content-Disposition` — the proxy reads those from object metadata, not the database.
4. `curl` the returned URL over TLS from outside the cluster.
5. Confirm **2 `media_handle` rows** appear (one per Facebook page) from upload fan-out.
6. Confirm a non-GET/HEAD request is rejected, and that a malformed path 404s.

## 7. Smoke survey assets

Upload three files through the media page and substitute their URLs into
`smoke-test/form-a.json`, replacing the placeholders:

| Placeholder UUID | Needs |
|---|---|
| `11111111-…` | image (JPEG/PNG, 8-bit, ≤5MB) — used by **both** `media_asset_image` and `media_asset_repeat`, which must stay identical |
| `22222222-…` | video (MP4/3GPP, ≤16MB) |
| `33333333-…` | PDF (≤100MB) |

## 8. Enable the handle layer

```bash
# devops/values/staging.yaml: MEDIA_HANDLE_USE -> "true"
helm upgrade gbv devops/vlab -f devops/values/staging.yaml -n vstag
```

**This is the first behaviour change on real traffic, and the first time anything touches
real Meta.** Rollback is the same line back to `"false"` plus a rollout restart — every
message under this flag has a URL fallback beneath it.

Then run the smoke survey on Messenger. Expected:

- `media_legacy_attachment_id` — sends (the BC guard; ~100% of live production media traffic
  takes this path)
- `media_third_party_url` — sends by URL
- `media_asset_image` / `_repeat` / `_video` / `_file` — send, and **`_repeat` must send by
  the same handle**, which is what distinguishes handle reuse from silent URL fallback
- WhatsApp fields — **not testable on staging**, no credentials

## 9. Reconciler

Runs hourly at `:47` on staging (`:17` on production, staggered deliberately). After a tick:

- `media_handles_missing` → 0
- forced-expiry rehearsal: set `expires_at` into the past on one handle, wait a tick, confirm
  it is re-uploaded and `uploaded_at` restamped

## 10. Monitoring

`devops/sql-exporter` exposes seven `media_*` gauges and `devops/alerts` carries
`MediaHandlesExpired` and `MediaHandleFanoutGap` (both `warning`, `for: 6h`). Runbooks are in
`documentation/alerting.md` §11.

Both alerts read metrics served from an index span, so the alerting path does not degrade as
the library grows.

---

## Rollback

| Step | Reverse |
|---|---|
| 8 (flag) | `MEDIA_HANDLE_USE: "false"` + `helm upgrade` + rollout restart. Instant, no data change |
| 5 (deploy) | `helm rollback gbv -n vstag` |
| 4 (schema) | No reverse. `media_asset`/`media_handle` are additive; the dropped `media` table is gone. Nothing reads it |
| 2 (storage) | Delete the service accounts. The bucket can stay |

The handle layer is designed so that **every failure degrades to a URL send** (§13). If
anything looks wrong at step 8, set the flag back to false first and diagnose afterwards —
there is no state to unwind.
