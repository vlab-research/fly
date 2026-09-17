terraform {
  required_version = ">= 1.6"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

variable "gcp_project" {
  type        = string
  description = "GCP project that owns the state bucket. e.g. toixotoixo"
}

variable "gcp_region" {
  type        = string
  description = "Region for the state bucket. Use a regional bucket co-located with the cluster."
  default     = "europe-west1"
}

variable "state_bucket_name" {
  type    = string
  default = "vlab-research-tfstate"
}

provider "google" {
  project = var.gcp_project
  region  = var.gcp_region
}

resource "google_storage_bucket" "tfstate" {
  name                        = var.state_bucket_name
  project                     = var.gcp_project
  location                    = var.gcp_region
  uniform_bucket_level_access = true

  versioning {
    enabled = true
  }

  soft_delete_policy {
    retention_duration_seconds = 2592000
  }

  lifecycle {
    prevent_destroy = true
  }
}

output "state_bucket" {
  value = google_storage_bucket.tfstate.name
}
