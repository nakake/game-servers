# Storage — ゲーム設定 / launcher tarball 配布用の S3 bucket。
#
# Phase 1 で `aws s3 mb` で手動作成したものを Step 3 (docs/iac-migration-plan.md)
# で import して取り込んだ。bucket 本体・public access block・暗号化は import、
# versioning と lifecycle は import 時点で未設定だったため apply で新規作成する。
#
# SSM Parameter `/gs/atm11/rcon_password` (SecureString) は IaC 管理外。
# import すると秘密値が terraform state に平文で入るため、iac-migration-plan.md
# Step 3 / State の安全性の方針で「案 b: IaC 外に置き続け、Worker / EC2 は path
# だけ参照」を採用。生成手順は runbook-phase1-production.md §3.1 を参照。

# ===========================================================================
# S3 bucket: gs-game-configs
# ===========================================================================
# bucket 名は変更すると再作成される (ForceNew)。再作成すると Worker の
# LAUNCHER_TARBALL_S3_URI や EC2 の取得先に波及するため、import 名に厳密一致させる。

resource "aws_s3_bucket" "gs_game_configs" {
  bucket = "gs-game-configs"
}

# 完全非公開。bucket 作成時の実体 (4 項目すべて true) に一致。
resource "aws_s3_bucket_public_access_block" "gs_game_configs" {
  bucket                  = aws_s3_bucket.gs_game_configs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# SSE-S3 (AES256)。bucket 作成時の実体に一致。
resource "aws_s3_bucket_server_side_encryption_configuration" "gs_game_configs" {
  bucket = aws_s3_bucket.gs_game_configs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = false
  }
}

# versioning は import 時点で未設定。ゲーム設定ファイルの誤上書き・誤削除に対する
# 保険として Step 3 で有効化する (apply で新規作成 = 無効→Enabled)。
resource "aws_s3_bucket_versioning" "gs_game_configs" {
  bucket = aws_s3_bucket.gs_game_configs.id

  versioning_configuration {
    status = "Enabled"
  }
}

# lifecycle は import 時点で未設定。Step 3 で新規作成。
# - launcher/ : sync-launcher-to-s3.ps1 で上書き更新される。versioning ON のため
#   旧版が noncurrent version として残る → 30 日で expire。
# - modpacks/ : 永続。expire ルールを付けない (current / noncurrent とも残す)。
# - 全 prefix : 中断したマルチパートアップロードの残骸を 7 日後に掃除。
resource "aws_s3_bucket_lifecycle_configuration" "gs_game_configs" {
  bucket = aws_s3_bucket.gs_game_configs.id

  rule {
    id     = "expire-old-launcher-versions"
    status = "Enabled"

    filter {
      prefix = "launcher/"
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # noncurrent_version_expiration は versioning が有効でないと意味を持たないため、
  # versioning リソースが先に適用されるよう明示依存させる。
  depends_on = [aws_s3_bucket_versioning.gs_game_configs]
}
