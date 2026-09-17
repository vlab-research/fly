terraform {
  backend "gcs" {
    bucket = "vlab-research-tfstate"
    prefix = "envs/prod"
  }
}
