variable "gcp_project" {
  type        = string
  description = "GCP project hosting the bucket and GSA."
}

variable "bucket_name" {
  type        = string
  description = "GCS bucket name for the CRDB scheduled BACKUP collection."
}

variable "location" {
  type        = string
  description = "Bucket location. Use a regional location co-located with the GKE cluster (e.g. europe-west1) to avoid cross-region egress."
  default     = "europe-west1"
}

variable "k8s_namespace" {
  type        = string
  description = "Kubernetes namespace where the CRDB StatefulSet runs (vprod, vstag)."
}

variable "ksa_name" {
  type        = string
  description = "Kubernetes ServiceAccount the CRDB StatefulSet runs as. Default matches release name 'gbv' + chart 'cockroachdb'."
  default     = "gbv-cockroachdb"
}

variable "retention_days" {
  type        = number
  description = "Lifecycle delete age in days."
  default     = 90
}

variable "gsa_email" {
  type        = string
  description = "Email of the GCP service account the KSA will impersonate via Workload Identity."
}

resource "google_storage_bucket" "this" {
  name                        = var.bucket_name
  project                     = var.gcp_project
  location                    = var.location
  uniform_bucket_level_access = true

  versioning {
    enabled = false
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age = var.retention_days
    }
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

output "bucket_name" {
  value = google_storage_bucket.this.name
}

output "bucket_url" {
  value = "gs://${google_storage_bucket.this.name}?AUTH=implicit"
}
