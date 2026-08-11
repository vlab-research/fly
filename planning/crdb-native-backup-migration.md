# Replace the `dumper` CronJob with native CockroachDB scheduled BACKUP using GKE Workload Identity

## Context

The `dumper` Kubernetes CronJob (at `vlab-research/dumper`, deployed as the `dumper-0.0.3` Helm subchart) runs `cockroach dump chatroach` daily, gzips the SQL into a 200Gi staging PVC, and uploads to `gs://vlab-research-backups/gbv-india/`. It authenticates to GCS with a static GCP service-account JSON key mounted from the `gbv-dumper-keys` secret.

This is broken or about to be:

- **`cockroach dump` was removed in CockroachDB v23.1.** The cluster now runs **v24.1.28**. The dumper image is pinned to `cockroachdb/cockroach:v20.1.4`, so today the binary still works against the v24 server, but it's a deprecated wire-protocol path with no future fixes.
- The Enterprise license is **free since v22.1**, which means `BACKUP` and `CREATE SCHEDULE FOR BACKUP` are usable at no cost.
- The current setup costs a 200Gi `pd-standard` PVC, a custom Docker image, a static GCP key on disk, and a brittle `gsutil` retention shell pipeline.

Replace this with a native CockroachDB scheduled BACKUP that writes incremental backups directly to GCS, authenticated via **GKE Workload Identity** (no static keys), and delete the dumper subchart entirely. The CockroachDB Helm chart (v13.0.3) already supports both pieces declaratively.

The migration introduces a **new GCS prefix** (proposed: `chatroach/` for prod, `chatroach-staging/` for staging) so the native backup collection lives separately from the legacy `gbv-india/` flat `.sql.gz` files during the parallel period. The legacy prefix is retained until the dumper is removed (and then can be deleted manually after the retention window expires).

## Environment & repo layout

This plan lives in the **fly** repo. The dumper source lives in a **sibling** repo. Future agents should expect this filesystem layout:

```
<workspace>/
├── fly/                     ← primary repo, this plan lives in fly/planning/
│   └── devops/
│       ├── vlab/            ← umbrella Helm chart (this is what gets deployed)
│       │   ├── Chart.yaml
│       │   └── charts/
│       │       ├── cockroachdb-13.0.3.tgz   ← upstream chart, do not edit
│       │       └── dumper-0.0.3.tgz         ← internal subchart, to be removed
│       ├── values/
│       │   ├── production.yaml              ← values for the umbrella vlab chart
│       │   └── staging.yaml
│       ├── accounts.sh                      ← creates gbv-dumper-keys (to be edited)
│       └── setup-kube.sh                    ← cluster bootstrap; new SA setup script lives next to it
└── dumper/                  ← sibling repo, source of the dumper Docker image
    ├── Dockerfile           ← cockroachdb/cockroach:v20.1.4 base
    ├── backup.sh            ← runs `cockroach dump`, gzips, gsutils to GCS
    └── keys/key.json        ← static GCP service-account JSON (mounted into the pod via gbv-dumper-keys)
```

**`production.yaml` and `staging.yaml` are values for the umbrella `vlab` chart**, in which `cockroachdb:`, `dumper:`, etc. are subchart blocks. That's why the new `serviceAccount.annotations` and `init.provisioning` blocks live nested under `cockroachdb:` rather than at the top level — they pass through to the upstream CockroachDB subchart.

### Helm release names and namespaces

| Env | Helm release | Namespace | Deploy command (run from `devops/`) |
|---|---|---|---|
| Production | `gbv` | `vprod` | `helm upgrade gbv vlab -f values/production.yaml -n vprod` |
| Staging | `gbv` | `vstag` | `helm upgrade gbv vlab -f values/staging.yaml -n vstag` |

Both environments use release name `gbv`, which is why the chart-created CockroachDB resources are prefixed `gbv-cockroachdb-*` (StatefulSet, services, ServiceAccount). The `gbv-cockroachdb` ServiceAccount is what we annotate for Workload Identity. **Source: `planning/cockroachdb-upgrade-v23-v24.md` lines 72/113, `planning/helm-structure-findings.md` line 27.**

### Where the schedule actually runs

`CREATE SCHEDULE FOR BACKUP` registers the schedule in CRDB's system tables. When it fires, the BACKUP job is executed by **the CockroachDB cluster itself** — i.e., one of the StatefulSet pods is elected as the executor for that backup job. That's why annotating the StatefulSet's KSA (`gbv-cockroachdb`) is sufficient: the job picks up the pod's ambient identity. There is no separate "scheduler" identity.

### Background reading

A future agent picking up this work cold should read, in order:

1. `fly/CLAUDE.md` — project working philosophy (documentation-first, functional core, etc.)
2. This plan
3. `fly/devops/scripts/bootstrap-fly.sh` — illustrative `helm upgrade --install` pattern (note: that script is for the dev `fly` release with `values/integrations/fly.yaml`; production uses release `gbv` with `values/production.yaml`, but the invocation shape is identical)
4. `fly/devops/setup-kube.sh` and `fly/devops/accounts.sh` — style precedent for the new `setup-crdb-backup.sh`
5. `fly/planning/cockroachdb-upgrade-v23-v24.md` — explains how the cluster got to v24.1.28; called out two pre-existing config bugs in the same `cockroachdb:` block this plan touches (`conf.budget.maxUnavailable` should be `statefulset.budget.maxUnavailable`). If still unfixed, fix in the same PR.
6. `fly/planning/helm-structure-findings.md` — release-name and naming conventions

## Critical files

| File | Purpose |
|---|---|
| `devops/values/production.yaml` | Lines ~656–676 (`cockroachdb:` block); ~325–340 (`dumper:` block). Add `statefulset.serviceAccount.annotations` and `init.provisioning`; remove `dumper:` block in step 7. |
| `devops/values/staging.yaml` | Same structure; staging schedule, smaller scope. |
| `devops/vlab/Chart.yaml` & `Chart.lock` | Currently declares `dumper` subchart. Remove the dependency in step 7. |
| `devops/vlab/charts/dumper-0.0.3.tgz` | Delete after dependency removal. |
| `devops/vlab/charts/cockroachdb-13.0.3.tgz` | No edit — already supports `init.provisioning.databases[].backup` and `statefulset.serviceAccount.annotations`. The relevant template fragments are inlined under "Chart support (reference)" below so this plan stands without extracting the tgz. |
| **`devops/setup-crdb-backup.sh`** (new) | Idempotent script provisioning GSA, IAM bindings, KSA→GSA workload identity binding, and bucket lifecycle. See section below. |
| `devops/accounts.sh` | Stop creating `gbv-dumper-keys` secret in step 7. |
| `vlab-research/dumper/` (sibling repo) | Archive after step 7. |

## The new bash script: `devops/setup-crdb-backup.sh`

Idempotent, takes the environment as an argument, follows the style of `accounts.sh` / `setup-kube.sh`. Run once per environment (prod, staging). Each step is guarded so re-runs are safe.

```bash
#!/usr/bin/env bash
# devops/setup-crdb-backup.sh
#
# Provisions GCP-side resources for CockroachDB native scheduled BACKUP using
# GKE Workload Identity. Idempotent — safe to re-run.
#
# Usage:
#   ./setup-crdb-backup.sh <env>
#     where <env> is "prod" or "staging"
#
# Required env vars (or pass inline):
#   GCP_PROJECT       — e.g., vlab-research (the GCP project hosting the cluster + bucket)
#   GKE_CLUSTER       — e.g., vlab-prod
#   GKE_REGION        — e.g., us-central1
#   GCS_BUCKET        — e.g., vlab-research-backups
#   KSA_NAME          — Kubernetes ServiceAccount; chart default is "gbv-cockroachdb"
#                       (release name "gbv" + chart "cockroachdb"; do not change unless
#                       the helm release name changes)

set -euo pipefail

ENV="${1:?usage: $0 <prod|staging>}"
: "${GCP_PROJECT:?}" "${GKE_CLUSTER:?}" "${GKE_REGION:?}" "${GCS_BUCKET:?}"
: "${KSA_NAME:=gbv-cockroachdb}"

GSA_NAME="cockroachdb-backup"
GSA_EMAIL="${GSA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com"

case "$ENV" in
  prod)
    BUCKET_PREFIX="chatroach"
    K8S_NAMESPACE="vprod"
    ;;
  staging)
    BUCKET_PREFIX="chatroach-staging"
    K8S_NAMESPACE="vstag"
    ;;
  *) echo "env must be prod or staging" >&2; exit 1 ;;
esac

echo "==> 1/5 Verifying Workload Identity is enabled on $GKE_CLUSTER"
WI_POOL=$(gcloud container clusters describe "$GKE_CLUSTER" \
  --region="$GKE_REGION" --project="$GCP_PROJECT" \
  --format='value(workloadIdentityConfig.workloadPool)')
if [[ -z "$WI_POOL" ]]; then
  echo "ERROR: Workload Identity is not enabled on cluster $GKE_CLUSTER."
  echo "Enable it manually (cluster + node pool) before re-running:"
  echo "  gcloud container clusters update $GKE_CLUSTER --region=$GKE_REGION \\"
  echo "    --workload-pool=${GCP_PROJECT}.svc.id.goog"
  echo "  gcloud container node-pools update <NODE_POOL> --cluster=$GKE_CLUSTER \\"
  echo "    --region=$GKE_REGION --workload-metadata=GKE_METADATA"
  exit 1
fi
echo "    workload pool: $WI_POOL"

echo "==> 2/5 Creating GSA $GSA_EMAIL (skip if exists)"
gcloud iam service-accounts describe "$GSA_EMAIL" --project="$GCP_PROJECT" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "$GSA_NAME" \
    --project="$GCP_PROJECT" \
    --display-name="CockroachDB scheduled backup -> GCS"

echo "==> 3/5 Granting object admin on gs://$GCS_BUCKET/$BUCKET_PREFIX/* to $GSA_EMAIL"
# add-iam-policy-binding is idempotent for the same role+member
gcloud storage buckets add-iam-policy-binding "gs://$GCS_BUCKET" \
  --member="serviceAccount:$GSA_EMAIL" \
  --role="roles/storage.objectAdmin" \
  --condition="title=${BUCKET_PREFIX}-prefix-only,expression=resource.name.startsWith(\"projects/_/buckets/${GCS_BUCKET}/objects/${BUCKET_PREFIX}/\")" \
  >/dev/null

echo "==> 4/5 Binding KSA $K8S_NAMESPACE/$KSA_NAME to GSA $GSA_EMAIL"
gcloud iam service-accounts add-iam-policy-binding "$GSA_EMAIL" \
  --project="$GCP_PROJECT" \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:${GCP_PROJECT}.svc.id.goog[${K8S_NAMESPACE}/${KSA_NAME}]" \
  >/dev/null

echo "==> 5/5 Applying lifecycle rule (30-day retention on $BUCKET_PREFIX/)"
# Read current lifecycle, merge our rule in, write back. This avoids stomping
# unrelated rules on a shared bucket.
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
gcloud storage buckets describe "gs://$GCS_BUCKET" --format=json \
  | jq --arg prefix "$BUCKET_PREFIX/" '
      .lifecycle_config // {rule: []}
      | .rule = ((.rule // []) | map(select(
          (.condition.matchesPrefix // []) != [$prefix]
        )))
      | .rule += [{
          action: {type: "Delete"},
          condition: {age: 30, matchesPrefix: [$prefix]}
        }]
      | {lifecycle: .}
    ' > "$TMP"
gcloud storage buckets update "gs://$GCS_BUCKET" --lifecycle-file="$TMP"

echo "Done. Annotate the chart's KSA in values/${ENV}.yaml with:"
echo "  iam.gke.io/gcp-service-account: $GSA_EMAIL"
```

The script is the **single source of truth** for what was run on GCP. To re-bootstrap a destroyed environment, run this script. To audit drift, re-run it — it's a no-op when state matches.

## Chart support (reference)

These two fragments from the upstream `cockroachdb-13.0.3` chart are why no chart edits are needed. Inlined here so this plan stays valid even if the chart tgz is removed or upgraded.

**`templates/serviceaccount.yaml`** (annotations pass-through):

```yaml
{{- if .Values.statefulset.serviceAccount.create }}
kind: ServiceAccount
apiVersion: v1
metadata:
  name: {{ template "cockroachdb.serviceAccount.name" . }}
  namespace: {{ .Release.Namespace | quote }}
  ...
  {{- if .Values.statefulset.serviceAccount.annotations }}
  annotations:
    {{- with .Values.statefulset.serviceAccount.annotations }}
      {{- toYaml . | nindent 4 }}
    {{- end }}
  {{- end }}
{{- end }}
```

**`templates/job.init.yaml`** (the BACKUP schedule provisioning loop, condensed):

```yaml
{{- range $database := .Values.init.provisioning.databases }}
  CREATE DATABASE IF NOT EXISTS {{ $database.name }} ... ;

  {{- if $database.backup }}
    CREATE SCHEDULE IF NOT EXISTS {{ $database.name }}_scheduled_backup
      FOR BACKUP DATABASE {{ $database.name }} INTO '{{ $database.backup.into }}'
    {{- if $database.backup.options }}
      WITH {{ join "," $database.backup.options }}
    {{- end }}
      RECURRING '{{ $database.backup.recurring }}'
    {{- if $database.backup.fullBackup }}
      FULL BACKUP '{{ $database.backup.fullBackup }}'
    {{- else }}
      FULL BACKUP ALWAYS
    {{- end }}
    {{- if and $database.backup.schedule $database.backup.schedule.options }}
      WITH SCHEDULE OPTIONS {{ join "," $database.backup.schedule.options }}
    {{- end }}
    ;
  {{- end }}
{{- end }}
```

The whole init job is rendered as a `helm.sh/hook: post-install,post-upgrade` Job with `helm.sh/hook-delete-policy: before-hook-creation`, so it re-runs cleanly on every `helm upgrade`. The Job runs as the same `gbv-cockroachdb` ServiceAccount as the StatefulSet (template line: `serviceAccountName: {{ template "cockroachdb.serviceAccount.name" . }}`), but the BACKUP itself is executed by the cluster, not by the init Job — the init Job only issues the `CREATE SCHEDULE` SQL.

## Helm value changes

### `devops/values/production.yaml` — under `cockroachdb:`

Add two blocks. The first annotates the chart-created ServiceAccount; the second enables provisioning so the post-install/post-upgrade init Job creates the schedule.

```yaml
cockroachdb:
  image:
    tag: v24.1.28
  statefulset:
    replicas: 4
    resources:
      requests:
        cpu: 200m
        memory: 8000Mi
    budget:
      maxUnavailable: 1
    serviceAccount:
      create: true                  # default; explicit for clarity
      annotations:
        iam.gke.io/gcp-service-account: cockroachdb-backup@<GCP_PROJECT>.iam.gserviceaccount.com

  init:
    provisioning:
      enabled: true
      databases:
        - name: chatroach
          backup:
            into: "gs://vlab-research-backups/chatroach?AUTH=implicit"
            recurring: "@daily"
            options:
              - "revision_history"
            schedule:
              options:
                - "first_run = 'now'"
                - "on_execution_failure = 'retry_soon'"
                - "on_previous_running = 'wait'"
```

Notes:

- `AUTH=implicit` tells CockroachDB to use ambient GCE/GKE metadata-server credentials. With Workload Identity, those credentials are the GSA token. **No `CREDENTIALS=` URL parameter and no static key file are needed.**
- **Gotcha**: `AUTH=implicit` only works from inside a GKE pod that has the right KSA — the metadata server is what supplies the credential. If you `cockroach sql` from your laptop and run a one-off `BACKUP INTO 'gs://...?AUTH=implicit'`, it will fail (no metadata server, or worse, return your local `gcloud` identity which lacks the bucket binding). For ad-hoc operations, `kubectl exec` into `gbv-cockroachdb-0` and run `cockroach sql` there.
- `INTO 'gs://...'` (no trailing path beyond the prefix) makes a **collection** path; CRDB writes a structured tree (`/<schedule-id>/...`) suitable for incremental + restore-from-latest.
- `revision_history` enables point-in-time restore within the schedule's GC TTL window.
- `FULL BACKUP ALWAYS` is the chart's default when `fullBackup` isn't set — that's fine to start. After the migration is verified, consider switching to a weekly `FULL BACKUP '@weekly'` plus daily incrementals; this requires re-creating the schedule.
- Schedule name is fixed by the chart at `chatroach_scheduled_backup` (template line 194). The chart uses `CREATE SCHEDULE IF NOT EXISTS`, so re-running the init Job is idempotent.

### `devops/values/staging.yaml` — under `cockroachdb:`

Same shape, with staging path:

```yaml
        - name: chatroach
          backup:
            into: "gs://vlab-research-backups/chatroach-staging?AUTH=implicit"
            recurring: "@daily"
            options:
              - "revision_history"
            schedule:
              options:
                - "first_run = 'now'"
```

Same GSA can serve both clusters: re-running `setup-crdb-backup.sh staging` adds an additional bucket-prefix IAM condition for `chatroach-staging/` and an additional KSA binding for the staging cluster's KSA.

### `devops/values/production.yaml` — remove the `dumper:` block (step 7 only)

After the parallel-run period, delete the entire `dumper:` block (lines ~325–340). Helm upgrade will then delete the CronJob, recent Job pods, and the 200Gi PVC.

### `devops/vlab/Chart.yaml` and `Chart.lock`

Remove the `dumper` entry from `dependencies:` (currently at line ~71 of `Chart.yaml`) in step 7. Re-run `helm dependency update` to regenerate `Chart.lock` and prune `charts/dumper-0.0.3.tgz`.

## Migration order

Do staging end-to-end first, then production. Keep the dumper running in production until at least one native restore has been validated.

1. **Run** `GCP_PROJECT=... GKE_CLUSTER=... GKE_REGION=... GCS_BUCKET=vlab-research-backups ./devops/setup-crdb-backup.sh staging`.
2. **Update staging values** with the SA annotation and `init.provisioning.databases[0].backup` (path: `chatroach-staging`). Keep the `dumper:` block in staging *for now*.
3. **`helm upgrade` staging.** The chart's post-install/post-upgrade init Job (`templates/job.init.yaml`) executes `CREATE SCHEDULE IF NOT EXISTS chatroach_scheduled_backup ...`.
4. **Verify** (next section).
5. **Restore drill in staging**: `RESTORE DATABASE chatroach FROM LATEST IN 'gs://vlab-research-backups/chatroach-staging?AUTH=implicit' WITH new_db_name = 'chatroach_restore_test'`. Sanity-check row counts. `DROP DATABASE chatroach_restore_test CASCADE`. **This is the gate** for moving to production.
6. **Run** `./devops/setup-crdb-backup.sh prod` and apply the same value changes to production — but **do not remove the `dumper:` block yet.** Run dumper + native scheduled backup in parallel for ~7 days.
7. After ~7 days of native scheduled backups in production and one successful restore drill, **remove the `dumper:` block from prod values, remove the chart dependency, run `helm dependency update`, `helm upgrade`.** Helm deletes the CronJob, recent Job pods, and the 200Gi PVC. Then manually:
   - `kubectl delete secret gbv-dumper-keys -n vprod` (created outside Helm by `accounts.sh`)
   - `kubectl delete secret gbv-dumper-keys -n vstag` (same, in staging namespace)
   - Edit `accounts.sh` to remove the `gbv-dumper-keys` line
   - Optionally `gcloud storage rm -r gs://vlab-research-backups/gbv-india/` once the legacy retention window has expired and you no longer need legacy SQL dumps
   - Archive the sibling `dumper/` repo (README pointer to this plan).
8. **Documentation pass.** Per `fly/CLAUDE.md`'s documentation-first protocol, before closing the PR write `fly/documentation/backups.md` describing the new flow at the cross-component level (what runs, where, on whose identity, how to restore, where the lifecycle rule lives). Don't duplicate this plan — the doc captures *steady-state* behavior, the plan captures the migration. If `documentation/` doesn't exist yet, create it; this is also a good moment to retire any stale references to the old dumper from `replybot/README.md` or other app READMEs.

## Verification

Replace `<NS>` with `vprod` (production) or `vstag` (staging) below.

**Workload Identity (run from a throwaway pod that uses the `gbv-cockroachdb` SA):**

```bash
kubectl run -it --rm wi-test --image=google/cloud-sdk:slim \
  --serviceaccount=gbv-cockroachdb -n <NS> -- \
  bash -c "gcloud auth list && gcloud storage ls gs://vlab-research-backups/"
```

Should show the GSA (`cockroachdb-backup@...`) as the active identity and list the bucket. If you get `AccessDeniedException`, the binding from the script didn't take.

**Schedule creation (immediately after `helm upgrade`):**

```bash
kubectl exec -it gbv-cockroachdb-0 -n <NS> -- \
  /cockroach/cockroach sql --insecure --host=gbv-cockroachdb-public \
  --execute="SHOW SCHEDULES;"
```

Look for a row labelled `chatroach_scheduled_backup`, status `ACTIVE`, with `next_run` set in the near future.

**First backup ran:**

```bash
gcloud storage ls -r gs://vlab-research-backups/chatroach/ | head
```

Should show a structured collection layout (`<schedule-id>/<timestamp>/...`), not flat `.sql.gz` files.

**Inside CRDB:**

```sql
SHOW BACKUPS IN 'gs://vlab-research-backups/chatroach?AUTH=implicit';
SHOW BACKUP LATEST IN 'gs://vlab-research-backups/chatroach?AUTH=implicit';
```

Sanity-check the size against the live DB.

**Restore drill (staging only, before cutting over prod):**

```sql
RESTORE DATABASE chatroach
  FROM LATEST IN 'gs://vlab-research-backups/chatroach-staging?AUTH=implicit'
  WITH new_db_name = 'chatroach_restore_test';

SELECT count(*) FROM chatroach_restore_test.<largest_table>;
DROP DATABASE chatroach_restore_test CASCADE;
```

## Rollback

If the BACKUP schedule misbehaves, the dumper is still running in parallel through step 7. To roll back inside CRDB without touching Helm:

```sql
PAUSE SCHEDULES SELECT id FROM [SHOW SCHEDULES] WHERE label = 'chatroach_scheduled_backup';
-- or, harder rollback:
DROP SCHEDULES SELECT id FROM [SHOW SCHEDULES] WHERE label = 'chatroach_scheduled_backup';
```

To roll back the Helm changes: revert the `cockroachdb.serviceAccount.annotations` and `cockroachdb.init.provisioning` blocks in values, `helm upgrade`. The init Job is `helm.sh/hook-delete-policy: before-hook-creation`, so the hook re-runs cleanly. The schedule will remain in CRDB until you `DROP SCHEDULES` it — there's no Helm-side cleanup of schedules.

To roll back GCP-side IAM, the script's actions are individually reversible:

```bash
# Replace <NS> with vprod (prod) or vstag (staging)
gcloud iam service-accounts remove-iam-policy-binding "$GSA_EMAIL" --role=roles/iam.workloadIdentityUser --member="serviceAccount:${GCP_PROJECT}.svc.id.goog[<NS>/gbv-cockroachdb]"
gcloud storage buckets remove-iam-policy-binding "gs://vlab-research-backups" --member="serviceAccount:$GSA_EMAIL" --role=roles/storage.objectAdmin --all
gcloud iam service-accounts delete "$GSA_EMAIL"
```

## Open decisions to confirm before executing

- **GCP project ID** for production and staging (placeholder `<GCP_PROJECT>` above).
- **GKE cluster name and region** for production and staging (script inputs).
- **Bucket prefix name**: provisional `chatroach/` and `chatroach-staging/`. Tell me if you want a different name (e.g., `vlab-crdb/`, `cockroach-backups/`).
- **Production vs. staging GSA**: plan assumes one shared `cockroachdb-backup` GSA with two prefix-scoped IAM conditions and two KSA bindings. Confirm or split into per-env GSAs.
- **Retention**: script applies a 30-day lifecycle delete rule (vs. legacy 6 days). Confirm 30 days is acceptable.
- **Workload Identity status on each cluster**: the script will fail-fast with instructions if it's not enabled. Confirm it's already on, or schedule a maintenance window.
