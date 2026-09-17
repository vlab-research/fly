variable "gcp_project" {
  type = string
}

variable "gcp_region" {
  type    = string
  default = "europe-west1"
}

variable "bucket_name" {
  type    = string
  default = "vlab-research-crdb-backups"
}

variable "k8s_namespace" {
  type    = string
  default = "vprod"
}

variable "retention_days" {
  type    = number
  default = 90
}

resource "google_service_account" "backup" {
  account_id   = "cockroachdb-backup"
  display_name = "CockroachDB scheduled backup -> GCS (prod)"
  project      = var.gcp_project
}

module "cockroachdb_backup" {
  source         = "../../modules/cockroachdb-backup"
  gcp_project    = var.gcp_project
  bucket_name    = var.bucket_name
  location       = var.gcp_region
  k8s_namespace  = var.k8s_namespace
  retention_days = var.retention_days
  gsa_email      = google_service_account.backup.email
}

resource "google_service_account" "media_backup" {
  account_id   = "media-backup"
  display_name = "MinIO media bucket mirror -> GCS (prod)"
  project      = var.gcp_project
}

# Target of devops/backup/minio-media-mirror.yaml. That manifest's KSA annotation
# names the GSA email above, and its BACKUP_BUCKET names this bucket.
module "media_backup" {
  source      = "../../modules/media-backup"
  gcp_project = var.gcp_project
  bucket_name = "vlab-research-media-backups"
  location    = var.gcp_region
  gsa_email   = google_service_account.media_backup.email
}

output "gsa_email" {
  value = google_service_account.backup.email
}

output "backup_bucket" {
  value = module.cockroachdb_backup.bucket_url
}

output "media_backup_gsa_email" {
  value = google_service_account.media_backup.email
}

output "media_backup_bucket" {
  value = "gs://${module.media_backup.bucket_name}"
}
