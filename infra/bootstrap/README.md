# Bootstrap — TF state bucket

One-time. Creates `gs://vlab-research-tfstate`, the GCS bucket that holds Terraform state for every other stack in `infra/envs/`. Chicken-and-egg: this stack uses local state because the state bucket cannot create itself.

## When to run

Only on a fresh GCP project that doesn't already have the state bucket. If `gcloud storage buckets describe gs://vlab-research-tfstate` returns OK, this has already been done — do not run again.

## Run

```bash
cd infra/bootstrap
terraform init
terraform apply -var gcp_project=toixotoixo
```

After it succeeds, discard the local `terraform.tfstate` and `terraform.tfstate.backup` — the bucket exists and the bootstrap stack is never re-applied. The bucket itself has `prevent_destroy = true`, `versioning.enabled = true`, and a 30-day soft delete policy, so accidental destruction is well-defended.

## Rollback

`terraform destroy` is blocked by `prevent_destroy`. If you genuinely need to delete the state bucket, remove `prevent_destroy` first, then destroy. Don't.
