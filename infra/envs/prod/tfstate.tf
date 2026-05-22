# Terraform state backend 用 S3 バケット (iac-migration-plan.md Step 8)
#
# 現状 state は backend.tf の backend "local" でローカルファイル。これを S3 に移し
# versioning + SSE-KMS + ロックで堅牢化する。Step 9 で Cloudflare API Token が state
# に入るため、暗号化 backend はその前提でもある。
#
# 鶏と卵: state を入れるバケット自体を Terraform で作る。手順は:
#   1. backend "local" のまま本ファイルを apply → ローカル state に記録
#   2. backend.tf を backend "s3" に書き換え
#   3. terraform init -migrate-state でローカル state を S3 にコピー
#   4. ローカル terraform.tfstate* を削除
# 適用後はバケットが「自分自身を管理する state」を保持する (標準構成で問題なし)。
#
# ロックは DynamoDB ではなく S3 ネイティブロック (backend.tf の use_lockfile=true)。
# 当初計画は aws_dynamodb_table.tf_lock だったが、Terraform 1.10+ は S3 上のロック
# ファイルで排他でき、backend の dynamodb_table 引数はむしろ非推奨化された。現環境は
# TF 1.15 のためリソースを増やさず use_lockfile を採用 (ユーザー判断 2026-05-22)。

# ===========================================================================
# S3 bucket: gs-tfstate-prod-123456789012
# ===========================================================================
# bucket 名はグローバル一意・ForceNew。backend.tf の bucket 引数とリテラルで一致
# させること (backend ブロックは変数参照不可のためリテラル直書き)。

resource "aws_s3_bucket" "tf_state" {
  bucket = "gs-tfstate-prod-123456789012"

  # state を保持するバケットの誤 destroy を防ぐ。terraform destroy や ForceNew を
  # 伴う変更を terraform 自身が plan 段階で拒否する。
  lifecycle {
    prevent_destroy = true
  }
}

# 完全非公開 (4 項目すべて true)。
resource "aws_s3_bucket_public_access_block" "tf_state" {
  bucket                  = aws_s3_bucket.tf_state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# versioning ON — state を誤って壊した際に過去バージョンから復旧できる。
# リモート backend では必須級のため Step 8 で有効化する。
resource "aws_s3_bucket_versioning" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

# SSE-KMS (AWS マネージドキー aws/s3)。sse_algorithm = "aws:kms" かつ
# kms_master_key_id 省略で S3 は aws/s3 マネージドキーを使う。カスタマー管理 CMK
# ($1/月) は採らない (iac-migration-plan.md 決定2 / ユーザー判断 2026-05-22)。
# bucket_key_enabled = true で S3 Bucket Keys を効かせ KMS リクエスト料を抑える。
resource "aws_s3_bucket_server_side_encryption_configuration" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}
