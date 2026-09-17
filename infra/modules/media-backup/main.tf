variable "gcp_project" {
  type        = string
  description = "GCP project hosting the bucket and GSA."
}

variable "bucket_name" {
  type        = string
  description = "GCS bucket receiving the off-cluster copy of the MinIO media bucket."
}

variable "location" {
  type        = string
  description = "Bucket location. Co-located with the GKE cluster so the nightly copy pays no cross-region egress."
  default     = "europe-west1"
}

variable "k8s_namespace" {
  type        = string
  description = "Namespace the mirror CronJob runs in (the MinIO namespace)."
  default     = "minio"
}

variable "ksa_name" {
  type        = string
  description = "Kubernetes ServiceAccount the mirror CronJob runs as (devops/backup/minio-media-mirror.yaml)."
  default     = "minio-media-mirror"
}

variable "gsa_email" {
  type        = string
  description = "Email of the GCP service account the KSA will impersonate via Workload Identity."
}

variable "noncurrent_retention_days" {
  type        = number
  description = "Days an overwritten or deleted object version is kept before it is purged."
  default     = 30
}

resource "google_storage_bucket" "this" {
  name                        = var.bucket_name
  project                     = var.gcp_project
  location                    = var.location
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Media assets are permanent, so there is no age-based delete. Versioning keeps
  # the replaced bytes when an object is overwritten or deleted, for
  # noncurrent_retention_days.
  versioning {
    enabled = true
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      with_state                 = "ARCHIVED"
      days_since_noncurrent_time = var.noncurrent_retention_days
    }
  }

  # This bucket can be the only surviving copy of researcher uploads.
  lifecycle {
    prevent_destroy = true
  }
}

# objectUser, not objectAdmin: read, list, create and delete objects, but no IAM
# on them. Delete is required because GCS treats an overwrite as a delete of the
# live version; versioning above keeps what was replaced.
resource "google_storage_bucket_iam_member" "object_user" {
  bucket = google_storage_bucket.this.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${var.gsa_email}"
}

# `gcloud storage rsync` reads the destination bucket's own metadata before it
# lists objects, which objectUser does not grant. legacyBucketReader adds only
# storage.buckets.get and storage.objects.list.
resource "google_storage_bucket_iam_member" "bucket_reader" {
  bucket = google_storage_bucket.this.name
  role   = "roles/storage.legacyBucketReader"
  member = "serviceAccount:${var.gsa_email}"
}

resource "google_service_account_iam_member" "wi_binding" {
  service_account_id = "projects/${var.gcp_project}/serviceAccounts/${var.gsa_email}"
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.gcp_project}.svc.id.goog[${var.k8s_namespace}/${var.ksa_name}]"
}

output "bucket_name" {
  value = google_storage_bucket.this.name
}
