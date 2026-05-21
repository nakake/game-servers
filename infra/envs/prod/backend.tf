# Phase 1: local state.
# Phase 4 で S3 (versioning + SSE) + DynamoDB lock の remote backend に移行予定
# (design.md §10 Phase 4 / CLAUDE.md Terraform 項)。
terraform {
  backend "local" {
    path = "terraform.tfstate"
  }
}
