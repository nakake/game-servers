# Terraform state — S3 リモート backend (iac-migration-plan.md Step 8)
#
# state バケット gs-tfstate-prod-123456789012 は tfstate.tf で宣言・apply 済
# (versioning + SSE-KMS + public access block)。backend ブロックは変数参照不可の
# ため bucket / key / region はリテラル直書きし、tfstate.tf の bucket 名と一致させる。
#
# ロックは S3 ネイティブロック (use_lockfile)。Terraform 1.10+ が apply 中に
# <key>.tflock をバケット内に置いて排他する。当初計画の DynamoDB テーブルは使わない
# (TF 1.15 では dynamodb_table 引数が非推奨、iac-migration-plan.md Step 8 / 決定1)。
#
# local → S3 への切替は `terraform init -migrate-state` で実施 (Step 8 手順 3)。
terraform {
  backend "s3" {
    bucket       = "gs-tfstate-prod-123456789012"
    key          = "envs/prod/terraform.tfstate"
    region       = "ap-northeast-1"
    encrypt      = true
    use_lockfile = true
  }
}
