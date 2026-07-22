# Backups

## Overview

The `chatroach` database is backed up daily to Google Cloud Storage by **CockroachDB native scheduled BACKUP**. Each run writes a complete full backup as a structured collection suitable for `RESTORE FROM LATEST IN ...`. CockroachDB authenticates to GCS via **GKE Workload Identity** — no static service-account key on disk.

| Env | Schedule | Bucket | Retention | Identity |
|---|---|---|---|---|
| Production (`vprod`) | `@daily`, `FULL BACKUP ALWAYS`, `revision_history` | `gs://vlab-research-crdb-backups` (europe-west1) | 90-day lifecycle delete | KSA `gbv-cockroachdb` → GSA `cockroachdb-backup@toixotoixo.iam.gserviceaccount.com` via WI |
| Staging (`vstag`) | not yet wired (deferred until staging CRDB is healthy) | will be `gs://vlab-research-crdb-backups-staging` | 90 days | will be `cockroachdb-backup-staging@` |

Each daily run lands at `gs://vlab-research-crdb-backups/<YYYY>/<MM>/<DD-HHMMSS.SS>/` containing a `BACKUP-LOCK-*` marker, a `data/` tree of SST files, and a `progress/` tree of checkpoints. As of writing, prod's `chatroach` snapshot is ~545 GB compressed in GCS (~672 GB logical, dominated by `messages` at 624 GB, `responses` at 37 GB, `states` at 10.5 GB).

### Replaces the legacy dumper

The previous `dumper` CronJob ran `cockroach dump chatroach` from a `cockroachdb/cockroach:v20.1.4` image, gzipped to `gs://vlab-research-backups/gbv-india/`, and authenticated with a static GCP service-account key (`gbv-dumper@`, mounted via the `gbv-dumper-keys` secret). It is being retired because:

- `cockroach dump` was removed in CRDB v23.1; the cluster runs v24.1.28. The deprecated wire-protocol path still works against newer servers but receives no fixes.
- Static GCP keys on disk are a security regression vs. Workload Identity.
- Native scheduled BACKUP gives PITR, restore-from-latest, and `SHOW BACKUP` introspection that gzipped SQL dumps don't.

**Retired 2026-07-21** — after confirming the native scheduled BACKUP is `ACTIVE` and landing daily (collections through `2026/07/21`). The IaC + live teardown is done; see **Dumper teardown** below for exactly what was removed and the residual GCP-side cleanup deferred to ~day 60.

## Where the schedule actually lives

`CREATE SCHEDULE FOR BACKUP` registers the schedule in CockroachDB's system tables. When it fires, the BACKUP job is executed by **the CockroachDB cluster itself** — one of the StatefulSet pods is elected as executor for that job. There is no separate scheduler identity. That's why annotating the StatefulSet's KSA (`gbv-cockroachdb`) is sufficient: the BACKUP job picks up the pod's ambient identity through the metadata server.

This is what `AUTH=implicit` in the `INTO` URL means: use ambient GKE/GCE metadata-server credentials. With Workload Identity, those credentials are the GSA token. No `CREDENTIALS=` URL parameter and no key file are involved.

**Gotcha**: `AUTH=implicit` does not work from outside the cluster. Running `cockroach sql` on a laptop and issuing `BACKUP INTO 'gs://...?AUTH=implicit'` will either fail (no metadata server) or use your laptop's `gcloud` identity (which lacks the bucket binding). For ad-hoc operations, `kubectl exec` into `gbv-cockroachdb-0` and use the in-pod `cockroach sql`.

## How the schedule gets created

Two pieces, kept deliberately separate:

1. **The KSA → GSA annotation** lives in `devops/values/production.yaml` under `cockroachdb.statefulset.serviceAccount.annotations`. This is what gives the StatefulSet pods the `cockroachdb-backup@` identity at the metadata-server layer. Helm-managed because it's chart configuration.

2. **The schedule itself** lives in `devops/migrations/prod/15-chatroach-scheduled-backup.sql` and is applied like every other DB migration:

   ```bash
   ./devops/run-prod-migration.sh devops/migrations/prod/15-chatroach-scheduled-backup.sql
   ```

   It's under `migrations/prod/` (not the top-level `migrations/`) because dev/test runs a single-node CRDB without GCS access — `CREATE SCHEDULE FOR BACKUP` validates the destination at create time and fails there. The bulk dev runners (`Makefile` `test-db`, `scripts/bootstrap-fly.sh`) glob `migrations/*.sql` and skip the subdirectory. See `devops/migrations/prod/README.md` for the full convention.

   The migration is `CREATE SCHEDULE IF NOT EXISTS chatroach_scheduled_backup ...`, so re-running in prod is a no-op. To change the schedule (e.g., switch to weekly fulls + daily incrementals), `DROP SCHEDULES` it manually and write a new migration.

This keeps schedule SQL alongside other DB schema changes (in `devops/migrations/`) instead of buried in a chart's `init.provisioning` block. Schedule changes get the same review and runner as any other migration.

## GCP-side resources (Terraform)

Managed by Terraform under `infra/envs/prod/`:

| Resource | Identifier |
|---|---|
| GCS bucket | `gs://vlab-research-crdb-backups` (europe-west1, 90-day lifecycle delete, uniform bucket-level access) |
| GCP service account | `cockroachdb-backup@toixotoixo.iam.gserviceaccount.com` |
| Bucket IAM binding | `roles/storage.objectAdmin` on the bucket → GSA (`google_storage_bucket_iam_member`, non-authoritative) |
| Workload Identity binding | `roles/iam.workloadIdentityUser` on the GSA → `serviceAccount:toixotoixo.svc.id.goog[vprod/gbv-cockroachdb]` |

State lives in `gs://vlab-research-tfstate`, prefix `envs/prod`. See `infra/README.md` for apply order, the IAM-resource-trap warning (`_iam_member` only — never `_binding` or `_policy`), and how to add a staging stack later.

**Not managed by Terraform**:

- **Cluster Workload Identity bootstrap** — cluster-level `--workload-pool=toixotoixo.svc.id.goog` and node-pool `--workload-metadata=GKE_METADATA` were enabled by hand on cluster `toixo` (region `europe-west1-b`). The node-pool flag triggers a rolling node recreation, which is why this step is out-of-band. Verify with:
  ```bash
  gcloud container clusters describe toixo --region=europe-west1-b --project=toixotoixo \
    --format='value(workloadIdentityConfig.workloadPool)'
  # → toixotoixo.svc.id.goog
  gcloud container node-pools describe bigpool --cluster=toixo --region=europe-west1-b --project=toixotoixo \
    --format='value(config.workloadMetadataConfig.mode)'
  # → GKE_METADATA
  ```
- **The KSA annotation on `gbv-cockroachdb`** — that's Helm chart configuration (`devops/values/production.yaml`), applied via `helm upgrade`. TF could in principle manage it, but the chart owns the KSA's lifecycle.
- **The legacy `gs://vlab-research-backups` bucket** — stays out of TF; manual deletion ~60 days after dumper retirement.

## Restoring a backup

### List available backups

```bash
kubectl exec -it gbv-cockroachdb-0 -n vprod -- \
  /cockroach/cockroach sql --insecure --host=gbv-cockroachdb-public \
  --execute="SHOW BACKUPS IN 'gs://vlab-research-crdb-backups?AUTH=implicit';"
```

### Inspect the latest backup

```bash
kubectl exec -it gbv-cockroachdb-0 -n vprod -- \
  /cockroach/cockroach sql --insecure --host=gbv-cockroachdb-public \
  --execute="SHOW BACKUP LATEST IN 'gs://vlab-research-crdb-backups?AUTH=implicit';"
```

### Restore into a side database (non-destructive)

Whole DB:

```sql
RESTORE DATABASE chatroach
  FROM LATEST IN 'gs://vlab-research-crdb-backups?AUTH=implicit'
  WITH new_db_name = 'chatroach_restore_test';

SELECT count(*) FROM chatroach_restore_test.<largest_table>;
DROP DATABASE chatroach_restore_test CASCADE;
```

Cheap drill (one small table — useful for routine "are bytes restorable" checks):

```sql
DROP DATABASE IF EXISTS chatroach_restore_test CASCADE;
CREATE DATABASE chatroach_restore_test;
RESTORE TABLE chatroach.users
  FROM LATEST IN 'gs://vlab-research-crdb-backups?AUTH=implicit'
  WITH into_db = 'chatroach_restore_test';
SELECT count(*) FROM chatroach_restore_test.users;
DROP DATABASE chatroach_restore_test CASCADE;
```

Restoring an arbitrary single table often hits foreign-key references to siblings that aren't being restored; pass `skip_missing_foreign_keys` to bypass:

```sql
RESTORE TABLE chatroach.credentials
  FROM LATEST IN 'gs://vlab-research-crdb-backups?AUTH=implicit'
  WITH into_db = 'chatroach_restore_test', skip_missing_foreign_keys;
```

`users` happens to have no out-FK so it's the easiest standalone drill target.

### Restore over the live database (destructive — coordinate first)

```sql
DROP DATABASE chatroach CASCADE;        -- ⚠️ destructive
RESTORE DATABASE chatroach FROM LATEST IN 'gs://vlab-research-crdb-backups?AUTH=implicit';
```

Don't do this without coordination — the app's running connections will fail.

### Point-in-time restore

`revision_history` is enabled, so PITR is available within CockroachDB's GC TTL window:

```sql
RESTORE DATABASE chatroach FROM LATEST IN 'gs://vlab-research-crdb-backups?AUTH=implicit'
  AS OF SYSTEM TIME '2026-01-15 12:00:00';
```

## Disabling / pausing the schedule

```sql
PAUSE SCHEDULES SELECT id FROM [SHOW SCHEDULES] WHERE label = 'chatroach_scheduled_backup';
RESUME SCHEDULES SELECT id FROM [SHOW SCHEDULES] WHERE label = 'chatroach_scheduled_backup';
DROP SCHEDULES SELECT id FROM [SHOW SCHEDULES] WHERE label = 'chatroach_scheduled_backup';  -- last resort
```

The schedule lives in CRDB's system tables, not in Helm. Removing the `init.provisioning` block from values **does not** remove the schedule — you must `DROP SCHEDULES` it manually.

## Adding staging

When staging CockroachDB is healthy:

1. Create `infra/envs/staging/` mirroring `infra/envs/prod/`. See `infra/README.md`.
2. Apply: creates `cockroachdb-backup-staging@` GSA, `gs://vlab-research-crdb-backups-staging`, IAM, and WI binding for `vstag/gbv-cockroachdb`.
3. Add the `serviceAccount.annotations` block to `devops/values/staging.yaml` under `cockroachdb.statefulset.serviceAccount` (same shape as `production.yaml`, different GSA email).
4. `helm upgrade gbv vlab -f values/staging.yaml -n vstag`.
5. Add a parallel migration `devops/migrations/prod/16-chatroach-scheduled-backup-staging.sql` (or run the existing prod SQL adapted to the staging bucket URL) and apply via `run-prod-migration.sh` against `vstag` — the runner currently hard-codes `vprod`, so adapt the script or run the SQL by hand against `vstag`.
6. Drop the staging `dumper:` block and the `gbv-dumper-keys` secret in the same teardown shape as prod.

## Dumper teardown

**Done 2026-07-21.** Precondition met: native scheduled BACKUP `ACTIVE`, daily
collections landing (through `2026/07/21`). What was removed:

1. ✅ Deleted the `dumper:` block from `devops/values/production.yaml` (replaced
   with a retirement comment).
2. ✅ Dropped the `dumper` dependency from `devops/vlab/Chart.yaml`, ran
   `helm dependency update` (Chart.lock regenerated), deleted
   `devops/vlab/charts/dumper-0.0.3.tgz`.
3. ✅ Live resources removed directly via `kubectl` (the CronJob, its Jobs/pods
   including one mid-run, **and the 4 leaked 200 Gi `*-dumper-scratch` PVCs =
   800 Gi reclaimed**). NB: the formal `helm upgrade gbv vlab -f
   values/production.yaml -n vprod` was intentionally **not** run in the same
   pass because `production.yaml` carried unrelated pending changes (replybot
   bump); run it with the next deploy to reconcile Helm's release state.
4. ✅ `kubectl delete secret gbv-dumper-keys -n vprod`.
5. ✅ N/A — `devops/accounts.sh` no longer references `gbv-dumper-keys` (already
   clean; the secret was a pre-existing out-of-band artifact).

Residual GCP-side cleanup (deferred, harmless in the meantime):

6. The legacy `gbv-dumper@toixotoixo.iam.gserviceaccount.com` GSA still has
   `objectAdmin` + `objectCreator` on `gs://vlab-research-backups`. Once the
   legacy bucket is gone (~day 60), delete the GSA with
   `gcloud iam service-accounts delete`.
7. Archive the sibling `vlab-research/dumper` repo with a README pointer here.
8. ~Day 60 — when nobody has needed a legacy SQL dump for ~30 days —
   `gcloud storage rm -r gs://vlab-research-backups/gbv-india/`.

## Verification

### Workload Identity is wired up correctly

```bash
kubectl run wi-test --rm -i --restart=Never -n vprod \
  --overrides='{"spec":{"serviceAccountName":"gbv-cockroachdb"}}' \
  --image=google/cloud-sdk:slim --pod-running-timeout=5m -- \
  bash -c "gcloud auth list && gcloud storage ls gs://vlab-research-crdb-backups/"
```

Active identity should print `cockroachdb-backup@toixotoixo.iam.gserviceaccount.com`. If it shows the node's default Compute SA (`<projectnumber>-compute@developer.gserviceaccount.com`), the node pool's `workloadMetadataConfig.mode` is not `GKE_METADATA` — see the GCP-side resources section. If it returns `AccessDeniedException` on the bucket, the IAM binding hasn't applied — re-check `infra/envs/prod` state.

(Note: `kubectl run --serviceaccount=` does not exist; the JSON `--overrides=` form above is the correct way to pin a KSA on a one-off pod.)

### Schedule is registered

```bash
kubectl exec -it gbv-cockroachdb-0 -n vprod -- \
  /cockroach/cockroach sql --insecure --host=gbv-cockroachdb-public --database=chatroach \
  --execute="SELECT id, label, schedule_status, next_run, recurrence FROM [SHOW SCHEDULES] WHERE label = 'chatroach_scheduled_backup';"
```

Expect one row, `schedule_status = ACTIVE`, `recurrence = @daily`, `next_run` near 00:00 UTC tomorrow.

### Backups are landing

```bash
gcloud storage ls -r gs://vlab-research-crdb-backups/ | head -20
gcloud storage du -s gs://vlab-research-crdb-backups
```

Expect a `<YYYY>/<MM>/<DD-HHMMSS.SS>/` collection layout (not flat `.sql.gz` files), with size growing daily until it hits the 90-day lifecycle steady state.

To inspect the latest backup's contents from inside the cluster:

```bash
kubectl exec -it gbv-cockroachdb-0 -n vprod -- \
  /cockroach/cockroach sql --insecure --host=gbv-cockroachdb-public --database=chatroach \
  --execute="SELECT object_name, object_type, size_bytes, rows FROM [SHOW BACKUP LATEST IN 'gs://vlab-research-crdb-backups?AUTH=implicit'] WHERE object_type = 'table' ORDER BY size_bytes DESC;"
```

### Restore drill (recommended quarterly)

A backup that hasn't been restored isn't a backup. The `users`-table drill in **Restoring a backup → Cheap drill** above takes seconds and proves the bytes-on-disk are restorable end-to-end. Run it on a recurring schedule, or after any infra change that touches IAM, WI, or the bucket.
