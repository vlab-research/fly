# `infra/` — Terraform-managed GCP resources

Scope is deliberately narrow: this directory manages only off-cluster backup targets — the bucket for CockroachDB's native scheduled BACKUP and the bucket for the MinIO media mirror — each with its GSA, bucket IAM and Workload Identity binding. It is the seed for future Terraform usage, not a full infra rewrite. Most GCP resources (the GKE cluster itself, Cloud SQL, Artifact Registry, the legacy `vlab-research-backups` bucket) remain managed by hand and are explicitly out of scope.

**DNS is not here either, and not in Cloud DNS at all** — the project has zero managed zones. `vlab.digital` is hosted on **NS1**, and records (`alerts`, `grafana`, `ntfy` → `vlab-cluster.vlab.digital`) are added there by hand.

## Layout

```
infra/
├── bootstrap/                 ← one-time, local state, creates the state bucket
├── modules/
│   ├── cockroachdb-backup/    ← reusable module: bucket + IAM + WI binding
│   └── media-backup/          ← versioned bucket + objectUser + WI binding for minio/minio-media-mirror
└── envs/
    └── prod/                  ← prod stack; owns the cockroachdb-backup and media-backup GSAs
```

The media-backup outputs (`media_backup_gsa_email`, `media_backup_bucket`) are consumed by `devops/backup/minio-media-mirror.yaml` — the KSA annotation and `BACKUP_BUCKET` there must match them. See `documentation/backups.md` § "Media backup (MinIO -> GCS)".

`envs/staging/` will be added when staging CockroachDB is healthy again — it'll mirror `envs/prod/` with its own `cockroachdb-backup-staging` GSA. No cross-stack coupling.

## What is deliberately NOT in Terraform

**OAuth clients for the internal tools** (`grafana.vlab.digital`, `alerts.vlab.digital`). Google has no live API for creating a "Sign in with Google" web OAuth client:

- The only Terraform-supported path was `google_iap_brand` + `google_iap_client`, which requires the project to belong to an organization — `toixotoixo` does not (`gcloud iap oauth-brands list` → `INVALID_ARGUMENT: Project must belong to an organization`).
- Those resources ride the IAP OAuth Admin API, which Google **permanently shut down on 2026-03-19**.

So these clients are created **by hand in the Google Cloud Console**, once, and their id/secret flow into a gitignored `.env` like every other secret in the repo (`documentation/secrets.md`). See `devops/grafana/README.md` for the walkthrough.

This is a conscious choice, not a gap to close later. Routing the login through an identity broker purely to make the client Terraform-manageable would add a vendor to the critical login path and require a standing broker-admin credential — a worse system in exchange for a tidier `.tf` file. "Everything is infrastructure as code" (CLAUDE.md) is about never hand-mutating **live cluster state**; a one-time OAuth client registration is a different category, in the same bucket as the hand-managed GKE cluster and DNS above.

## State

State for every env lives in `gs://vlab-research-tfstate`, prefix `envs/<env>`. Locking is provided by GCS native consistency — no `dynamodb` equivalent needed.

The state bucket itself is created by `bootstrap/` using local state. Bootstrap is run once per project and never re-run.

## Apply order (first-time)

1. `cd infra/bootstrap && terraform init && terraform apply -var gcp_project=toixotoixo` — creates `gs://vlab-research-tfstate`.
2. `cd infra/envs/prod && terraform init && terraform apply` — creates the prod GSA, prod backup bucket, IAM bindings, WI binding.

After `apply` succeeds in step 2:

```bash
terraform output gsa_email      # cockroachdb-backup@toixotoixo.iam.gserviceaccount.com
terraform output backup_bucket  # gs://vlab-research-crdb-backups?AUTH=implicit
```

These outputs flow into `devops/values/production.yaml` (the `cockroachdb.statefulset.serviceAccount.annotations` and `cockroachdb.init.provisioning.databases[0].backup.into` fields).

## Workload Identity prerequisite

Both modules' WI bindings only take effect if **Workload Identity is enabled on the cluster + the bigpool node pool uses `GKE_METADATA`**. Verify with:

```bash
gcloud container clusters describe toixo --region=europe-west1-b --project=toixotoixo \
  --format='value(workloadIdentityConfig.workloadPool)'
# Expect: toixotoixo.svc.id.goog
gcloud container node-pools describe bigpool --cluster=toixo --region=europe-west1-b --project=toixotoixo \
  --format='value(config.workloadMetadataConfig.mode)'
# Expect: GKE_METADATA
```

Both empty? Run `gcloud container clusters update --workload-pool=...` and `gcloud container node-pools update --workload-metadata=GKE_METADATA`. The node-pool update is a rolling node recreation — every pod on `bigpool` is evicted and rescheduled. Plan accordingly.

## IAM resource trap (read before editing module)

Terraform's GCP provider exposes three mutually exclusive IAM resource types. **Use `_iam_member` only.**

| Type | Scope | Behavior |
|---|---|---|
| `google_*_iam_policy` | Whole policy | Authoritative. Wipes manual bindings. Will lock people out. |
| `google_*_iam_binding` | One role | Authoritative for that role. Wipes other members. |
| `google_*_iam_member` | (role, member) pair | Non-authoritative. Coexists with manual bindings. ✓ |

The module deliberately uses `_iam_member` only. Never replace it with `_binding` or `_policy` — the legacy `vlab-research-backups` bucket has out-of-band bindings (e.g., `gbv-dumper@`) that an authoritative resource would silently delete on next apply.

## Adding a new env (when staging comes back)

1. Create `infra/envs/staging/` mirroring `prod/` (`backend.tf`, `providers.tf`, `main.tf`, `terraform.tfvars`).
2. `backend.tf` prefix = `envs/staging`.
3. `main.tf` creates its own `google_service_account "backup"` (account_id `cockroachdb-backup-staging`), invokes the module with `bucket_name = "vlab-research-crdb-backups-staging"` and `k8s_namespace = "vstag"`.
4. `terraform init && terraform apply`.
5. Wire the outputs into `devops/values/staging.yaml`.

## Adding a new resource family

The cockroachdb-backup module is the prototype: a Cloud-resource + IAM-binding + WI-binding triple. Future GSA-bearing services (e.g., a "Cloud Pub/Sub publisher" or "Secret Manager reader" pattern) should follow the same shape — module under `modules/`, composed in each `envs/<env>/main.tf` that needs an instance.

If you ever add a module using a non-`hashicorp/` provider, it **must declare that provider in its own `required_providers`** block. Without it Terraform resolves e.g. `foo` to the nonexistent `hashicorp/foo` and `init` fails, even when the calling stack declares the source correctly.

## CI

Currently no Terraform CI workflow. Plans/applies are run by hand. Re-evaluate when `infra/` grows to a second resource family or two more envs.

## Drift detection

`terraform plan` from each env directory shows drift. With one-shot manual applies, expect drift only if someone edits the bucket or GSA out-of-band via gcloud. Treat such drift as a bug to fix in TF, not in console.
