# Cloudflare Workers → AWS の OIDC 信頼関係。
#
# Worker 自身を OIDC issuer 化したものを AWS IAM が信頼し、
# Worker は AssumeRoleWithWebIdentity で 15min credentials を取得する。
#
# 詳細: docs/phase5-plan.md Step 2。

# OIDC Identity Provider。Worker の /oidc/ を issuer URL として登録する。
#
# thumbprint_list:
#   AWS は 2023 年以降 JWKS 直接検証に移行したが、provider 作成時は依然 thumbprint が必須項目。
#   現状の Cloudflare TLS cert SHA-1 fingerprint を `scripts/get-cf-thumbprint.{sh,ps1}` で取得して
#   var.thumbprints に渡す。証明書更新で thumbprint が変わっても **JWKS 直接検証が主経路**で実害なし、
#   ただし AWS 側が将来 thumbprint 検証にフォールバックする可能性を考えて半期に 1 度更新する運用にする
#   (Step 8 runbook)。
resource "aws_iam_openid_connect_provider" "worker" {
  url             = var.worker_issuer_url
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = var.thumbprints
}

# Worker が assume する IAM Role。trust policy 内で aud/sub を検証。
#
# Condition (AWS の OIDC custom provider でサポートされる condition key のみ):
#   - oidc:aud = sts.amazonaws.com  (固定)
#   - oidc:sub = var.expected_sub   (推測困難な random suffix 付き、Workers Secret 由来)
#
# iss は AWS が provider URL との一致を暗黙的に検証 (condition key として expose されない、null
# 比較で fail するため明示しない、rev6 で削除)。jti は同様に AWS が expose しないため Worker 側
# (lib/aws/credentials.ts) の `oidc-jti:<jti>` KV TTL 70s self-defense で replay 対策する。
#
# Policy attachment は env 側 (infra/envs/prod/iam.tf) で別途 attach する。
# description は IAM API の制約で ASCII / Latin-1 のみ許可 (CJK NG)。memory `iam-resource-description-ascii-only`。
resource "aws_iam_role" "worker_oidc" {
  name                 = var.role_name
  description          = "Cloudflare Worker role for AssumeRoleWithWebIdentity (Phase 5 OIDC)"
  max_session_duration = var.max_session_duration

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowWorkerOidcAssumeRole"
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.worker.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "${local.oidc_host}:aud" = "sts.amazonaws.com"
            "${local.oidc_host}:sub" = var.expected_sub
          }
          # iss / jti 等の追加 claim は AWS の OIDC custom provider では condition key として
          # 利用不可 (StringEquals/StringLike が null 比較で fail)。iss は AWS が provider URL
          # 一致を暗黙的に検証、jti は Worker 側 (Step 3 lib/aws/credentials.ts) で replay 防御。
        }
      }
    ]
  })
}

locals {
  # Condition key の prefix は OIDC provider URL から `https://` を剥がしたホスト + path 部分。
  # 例: worker_issuer_url = "https://discord-handler.<your-account>.workers.dev/oidc"
  #     → local.oidc_host = "discord-handler.<your-account>.workers.dev/oidc"
  oidc_host = replace(var.worker_issuer_url, "/^https?:\\/\\//", "")
}
