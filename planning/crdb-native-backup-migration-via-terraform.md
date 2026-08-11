# Replace the `dumper` CronJob with native CockroachDB scheduled BACKUP — **Terraform variant**

## Context

This is a **side-by-side alternative** to `crdb-native-backup-migration.md`, which uses an idempotent bash script (`devops/setup-crdb-backup.sh`) for the GCP-side work. Same end state: a native CockroachDB scheduled BACKUP writing to GCS, authenticated via GKE Workload Identity, dumper subchart deleted.

The point of this plan is to make the **comparison** legible. The two plans diverge only in *how the GCP-side resources are provisioned and tracked over time*. The Helm value changes inside the chart, the verification, and the rollback inside CRDB are identical between the two. The actual GCS layout differs slightly: the bash plan adds a `chatroach/` prefix to the existing `vlab-research-backups` bucket, while this plan creates two fresh dedicated buckets.

### Why Terraform with this scope is cheap

The original concern with mid-flight Terraform was the cost of *importing existing resources* (cluster, buckets, GSAs, existing IAM bindings). This plan **avoids that entirely** by:

1. Creating **two brand-new dedicated buckets** for native backups (one per env), fully owned by Terraform
2. Leaving the legacy `vlab-research-backups` bucket completely outside Terraform — it continues to receive dumper writes during the parallel period and gets `gcloud storage rm -r` ~60 days later as a manual one-off
3. Creating a fresh GSA (`cockroachdb-backup`) — also new, no import

Net result: TF only manages resources it *creates*. No `import {}` blocks, no zero-diff plan iterations, no IAM-resource-trap concerns about the legacy bucket's existing bindings. This is genuinely greenfield Terraform.

### Why two buckets, not one

Earlier discussion considered a single shared bucket with two prefixes (`chatroach/`, `chatroach-staging/`) plus IAM conditions to scope each env's GSA to its own prefix. Two dedicated buckets is materially simpler:

- **No IAM conditions**: bucket-wide `roles/storage.objectAdmin` on the per-env bucket. The condition expression goes away.
- **No lifecycle prefix matching**: the lifecycle rule applies to the whole bucket. No `matches_prefix`.
- **Reads better in TF**: each env composes one bucket + one GSA + one binding, with no cross-references.
- **Clean blast radius**: a misconfigured staging IAM cannot affect prod because they live in separate buckets.

GCS bucket cost is negligible (you pay for storage, not bucket count), so this is a pure simplicity win.

## Scope (chosen)

Terraform manages **only** the resources this migration creates:

- 2 × GCS buckets — `vlab-research-crdb-backups` (prod), `vlab-research-crdb-backups-staging` (staging)
- 1 × GSA — `cockroachdb-backup`, shared across envs
- 2 × bucket IAM bindings — one per bucket, no conditions, granting `storage.objectAdmin` to the GSA
- 2 × KSA→GSA workload-identity bindings — one per env (different KSA namespace strings: `vprod` vs. `vstag`)
- 2 × bucket lifecycle rules — 30-day delete, applies to whole bucket

Out of scope (stays as gcloud / kubectl / helm, exactly as today):

- The GKE cluster itself + node pools + the cluster's `workload-pool` setting (set once at bootstrap in `setup-kube.sh`)
- Artifact Registry, Cloud DNS, Cloud SQL, etc.
- Any pre-existing GSAs and IAM bindings created ad-hoc over the last few years
- The legacy `vlab-research-backups` bucket — manually deleted via gcloud after ~60 days
- Helm releases (the `vlab` umbrella chart)
- Kubernetes Namespaces, Secrets, ConfigMaps

This is the minimum useful Terraform: it establishes the tool with a state backend, gives you drift detection on the new resources, and creates a `cockroachdb-backup` module that the next service-needs-a-GSA situation can imitate. If the team wants to broaden TF coverage later (additional buckets, more GSAs), it's an incremental expansion of the same pattern — no big refactor required.

## Repo layout

Terraform code lives inside the `fly/` repo (single source of truth, same PRs as the values changes). New top-level directory:

```
fly/
├── devops/                            ← unchanged; helm charts and bash scripts
└── infra/                             ← NEW
    ├── README.md                      ← what runs where, who has access
    ├── bootstrap/                     ← run once, local state, creates the state bucket
    │   ├── main.tf
    │   └── README.md                  ← "you only run this on a fresh project"
    ├── modules/
    │   └── cockroachdb-backup/        ← bucket + GSA + bucket-IAM + WI binding + lifecycle
    ├── envs/
    │   ├── prod/
    │   │   ├── backend.tf             ← GCS backend, prefix=envs/prod
    │   │   ├── providers.tf
    │   │   ├── main.tf                ← composes the cockroachdb-backup module
    │   │   └── terraform.tfvars       ← env-specific values (project, namespace, bucket name)
    │   └── staging/
    │       └── (same shape)
    └── .github/workflows/
        └── terraform-plan.yml         ← runs `terraform plan` on PRs, comments diff
```

Each env has its own state file and is applied independently. **No workspaces** — they share state implicitly and have caused enough team-level confusion to be worth avoiding. **No `imports.tf`** — no resources to import.

The GSA itself (`cockroachdb-backup`) is shared across envs, so it lives in *one* env's state — by convention, prod owns it. Staging's `main.tf` references the prod GSA email as an input variable rather than re-creating it. This sidesteps "which env owns this resource" ambiguity. (Alternative: put the shared GSA in a third stack, e.g., `infra/envs/shared/`. Overkill for one resource; revisit if more shared resources appear.)

## State backend and the bootstrap problem

Terraform state for prod and staging lives in a GCS bucket. The bucket itself can't be created by the same Terraform that uses it — chicken and egg.

**Bootstrap (one-time, manual, local state):**

```hcl
# infra/bootstrap/main.tf
resource "google_storage_bucket" "tfstate" {
  name                        = "vlab-research-tfstate"
  project                     = var.gcp_project
  location                    = "US"
  uniform_bucket_level_access = true
  versioning { enabled = true }                              # state recovery
  lifecycle { prevent_destroy = true }
  soft_delete_policy { retention_duration_seconds = 2592000 }  # 30 days
}
```

```bash
cd infra/bootstrap
terraform init                              # local state
terraform apply -var gcp_project=<PROJECT>  # creates the state bucket
# Move the resulting terraform.tfstate into the state bucket itself, or
# discard it — bootstrap only ever runs once per project.
```

After the bucket exists, every other env uses it:

```hcl
# infra/envs/prod/backend.tf
terraform {
  backend "gcs" {
    bucket = "vlab-research-tfstate"
    prefix = "envs/prod"
  }
}
```

GCS native consistency provides locking — no separate `dynamodb` equivalent needed (this is a common GCS-vs-S3 advantage).

## Provider configuration

```hcl
# infra/envs/prod/providers.tf
terraform {
  required_version = ">= 1.6"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 5.0" }
  }
}

provider "google" {
  project = var.gcp_project
  region  = var.gcp_region
}
```

`google-beta` is only needed for features still in beta — Workload Identity is GA, so we shouldn't need it.

## IAM resource trap (read this before writing IAM code)

Even with a greenfield bucket and no imports, this trap is worth knowing. Terraform's GCP provider exposes **three mutually exclusive resource types** for every IAM-bearing resource:

| Resource type | Authoritative scope | Behavior |
|---|---|---|
| `google_*_iam_policy` | The entire policy | Overwrites all bindings not in TF. Will lock people out. |
| `google_*_iam_binding` | One role | Overwrites all members for that role not in TF. |
| `google_*_iam_member` | One (role, member) pair | Non-authoritative. Coexists with manual changes. |

**Use `_iam_member` exclusively.** This is the canonical Terraform-on-GCP footgun: someone applies `google_storage_bucket_iam_policy` to a bucket and on next apply only the TF-declared bindings survive. `_iam_member` makes drift survivable instead of catastrophic. The module below uses `_iam_member` deliberately — never replace it with `_binding` or `_policy`.

## The cockroachdb-backup module

The whole functional migration in TF, simplified by the two-bucket decision (no conditions, no aggregated lifecycle, no cross-env coupling).

```hcl
# infra/modules/cockroachdb-backup/main.tf

variable "gcp_project"    { type = string }
variable "bucket_name"    { type = string }            # vlab-research-crdb-backups[-staging]
variable "location"       { type = string, default = "US" }
variable "k8s_namespace"  { type = string }            # vprod or vstag
variable "ksa_name"       { type = string, default = "gbv-cockroachdb" }
variable "retention_days" { type = number, default = 30 }
variable "gsa_email"      { type = string }            # passed in from envs/prod (which owns the GSA)

resource "google_storage_bucket" "this" {
  name                        = var.bucket_name
  project                     = var.gcp_project
  location                    = var.location
  uniform_bucket_level_access = true
  versioning { enabled = false }   # CRDB BACKUP is itself versioned by schedule-id/timestamp

  lifecycle_rule {
    action    { type = "Delete" }
    condition { age = var.retention_days }
  }
}

resource "google_storage_bucket_iam_member" "object_admin" {
  bucket = google_storage_bucket.this.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${var.gsa_email}"
}

resource "google_service_account_iam_member" "wi_binding" {
  service_account_id = "projects/${var.gcp_project}/serviceAccounts/${var.gsa_email}"
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.gcp_project}.svc.id.goog[${var.k8s_namespace}/${var.ksa_name}]"
}

output "bucket_url" {
  value = "gs://${google_storage_bucket.this.name}?AUTH=implicit"
}
```

**Prod composition** (owns the shared GSA):

```hcl
# infra/envs/prod/main.tf

resource "google_service_account" "backup" {
  account_id   = "cockroachdb-backup"
  display_name = "CockroachDB scheduled backup -> GCS"
  project      = var.gcp_project
}

module "cockroachdb_backup" {
  source         = "../../modules/cockroachdb-backup"
  gcp_project    = var.gcp_project
  bucket_name    = "vlab-research-crdb-backups"
  k8s_namespace  = "vprod"
  gsa_email      = google_service_account.backup.email
}

output "gsa_email"     { value = google_service_account.backup.email }
output "backup_bucket" { value = module.cockroachdb_backup.bucket_url }
```

**Staging composition** (consumes the prod-owned GSA via tfvars, so plan/apply order is prod first then staging):

```hcl
# infra/envs/staging/main.tf

variable "gsa_email" { type = string }   # supplied via terraform.tfvars; copy from `terraform output -state=...`

module "cockroachdb_backup" {
  source         = "../../modules/cockroachdb-backup"
  gcp_project    = var.gcp_project
  bucket_name    = "vlab-research-crdb-backups-staging"
  k8s_namespace  = "vstag"
  gsa_email      = var.gsa_email
}

output "backup_bucket" { value = module.cockroachdb_backup.bucket_url }
```

The values of `gsa_email` and `backup_bucket` flow into `devops/values/{production,staging}.yaml`:

```yaml
cockroachdb:
  statefulset:
    serviceAccount:
      annotations:
        iam.gke.io/gcp-service-account: cockroachdb-backup@<PROJECT>.iam.gserviceaccount.com  # from `terraform output gsa_email`
  init:
    provisioning:
      enabled: true
      databases:
        - name: chatroach
          backup:
            into: "gs://vlab-research-crdb-backups?AUTH=implicit"   # from `terraform output backup_bucket`
            recurring: "@daily"
            options: ["revision_history"]
            schedule:
              options: ["first_run = 'now'", "on_execution_failure = 'retry_soon'", "on_previous_running = 'wait'"]
```

The chart's post-install/post-upgrade init Job then issues `CREATE SCHEDULE IF NOT EXISTS chatroach_scheduled_backup ...`. **Same Helm flow as the bash plan.**

## CI/CD

PR-driven plan, manual apply. Github Actions workflow at `.github/workflows/terraform-plan.yml`:

- On PR: `terraform plan` for any env touched. Plan output posted as PR comment.
- On merge to `main`: no automatic apply. A human runs `terraform apply` from a workstation or a privileged runner. (Atlantis can automate this later if desired.)

Auth from Github Actions to GCP: **Workload Identity Federation** (no static keys), pointing at a `terraform-ci` GSA with `roles/viewer` for plan-only and a separate apply identity for actual apply runs.

Apply auth: a small set of named humans, each with their own `gcloud auth application-default login` session. State locks via the GCS backend.

## Migration sequence

1. **Bootstrap state bucket** (`infra/bootstrap/`, run once, local state). Cost: ~10 min.
2. **Stand up `infra/envs/prod/`** (owns the shared GSA): `backend.tf`, `providers.tf`, `main.tf`. `terraform init && terraform apply` — creates the GSA, the prod bucket, the prod IAM binding, the prod WI binding.
3. **Capture outputs**: `terraform output gsa_email` and `terraform output backup_bucket`.
4. **Stand up `infra/envs/staging/`**, passing `gsa_email` via tfvars from step 3. `terraform apply` — creates the staging bucket, staging IAM binding, staging WI binding.
5. **Update `values/staging.yaml`** with the SA annotation and `init.provisioning.databases[0].backup` block (using `gs://vlab-research-crdb-backups-staging?AUTH=implicit`). Keep the `dumper:` block in staging *for now*.
6. **`helm upgrade gbv vlab -f values/staging.yaml -n vstag`** — chart's init Job creates `chatroach_scheduled_backup`.
7. **Verify + restore drill in staging** (identical to bash plan): `SHOW SCHEDULES`, `SHOW BACKUP LATEST IN 'gs://...'`, `RESTORE DATABASE chatroach FROM LATEST IN '...' WITH new_db_name = 'chatroach_restore_test'`. **Gate** for moving to prod.
8. **Update `values/production.yaml`** with the SA annotation and provisioning block (using `gs://vlab-research-crdb-backups?AUTH=implicit`). Keep `dumper:` block in prod for now.
9. **`helm upgrade gbv vlab -f values/production.yaml -n vprod`**.
10. **Parallel run** dumper + native scheduled backup in prod for ~7 days.
11. **Remove dumper from Helm**: drop the `dumper:` block from `production.yaml`/`staging.yaml`, drop the dependency from `Chart.yaml`, `helm dependency update`, `helm upgrade` both envs. Manually delete `gbv-dumper-keys` secret in `vprod` and `vstag`. Edit `accounts.sh` to remove the dumper line. Archive the sibling `dumper/` repo.
12. **Documentation pass**: write `documentation/backups.md` describing the new flow at the cross-component level. Update `infra/README.md` to describe the TF setup for future agents. Update each app `README.md` if the dumper was referenced.
13. **Day ~60 — delete the legacy bucket**: when nobody has needed a legacy SQL dump for the past month, run `gcloud storage rm -r gs://vlab-research-backups/` *manually*. (Don't put this in TF — TF doesn't own that bucket. Recommend doing it from a documented one-line command in a checklist issue, not a script, because it's a one-time destructive action.)

## Cost / benefit comparison vs. bash plan

| Dimension | Bash script | Terraform (this plan) |
|---|---|---|
| Effort to do this migration | ~0.5 day | ~1 day (bootstrap + module + migration; no imports) |
| Repeatability | Re-run the script | `terraform apply` |
| Drift detection on the new resources | None (re-run is the audit) | `terraform plan` shows drift |
| Drift detection on the rest of GCP | None | None (out of scope) |
| Onboarding cost for next infra change | None | New contributor must learn project layout, CI flow, the IAM resource trap |
| Rollback | Reversible gcloud commands | `terraform destroy` of specific resources, or revert + apply |
| Risk during this migration | Low (script is small, idempotent) | Low-medium (bootstrap is one-shot, module is small, no imports to mis-write) |
| Long-term value | Diminishes as infra grows (more shell scripts) | Compounds in the *resource families it covers* — buckets, GSAs, bindings |
| Lock-in | None | Some — state migration to another tool is non-trivial |

**Honest assessment of this scope**: the gap between the two plans is much smaller than at broader Terraform scopes. Greenfield TF with two new buckets is roughly half a day more work than the bash script and gives you drift detection on the new resources plus a reusable module for the next service that needs a GSA. If the next 6 months will see ≥2 new GSAs or buckets, TF pays for itself. If it'll be quiet, the bash script is right-sized.

The scope here is **deliberately small** so that the choice between TF and bash isn't a "rewrite all our infra" decision — it's a "do we want to start this Terraform habit" decision that can be reversed cheaply if the team doesn't take to it.

## Open decisions

- **GCP project ID** for prod and staging (placeholder `<PROJECT>` throughout — same as the bash plan).
- **State backend bucket name** (proposed: `vlab-research-tfstate`).
- **GSA ownership**: prod owns the shared `cockroachdb-backup` GSA, staging consumes it via tfvars. Confirm or split into per-env GSAs.
- **CI runner identity**: WIF-federated `terraform-ci` GSA — confirm Github org allows OIDC trust to GCP.
- **Apply policy**: human-only `terraform apply`, or automate via Atlantis once stable?
- **Bash plan as fallback**: keep `setup-crdb-backup.sh` written-but-unused as a documented escape hatch in case TF hits a blocker mid-migration? (Recommend: no — duplicating the path doubles maintenance and the migration is small. Pick one and commit.)
- **Bucket retention**: 30 days. Confirm vs. legacy 6 days.
- **Legacy bucket deletion timing**: 60 days from dumper removal, manual one-line gcloud. Confirm.

## When to revisit this decision

Pick one path now and commit. But mark a calendar reminder: **6 months in, audit the choice.**

- If you went bash and the `devops/` directory has 3+ new ad-hoc shell scripts for similar GCP work, that's the signal to migrate to TF.
- If you went TF and nobody but the original author touches `infra/`, that's the signal to consolidate or roll back.
