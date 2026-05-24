variable "worker_issuer_url" {
  description = "Worker OIDC issuer URL。例: https://discord-handler.<your-account>.workers.dev/oidc。末尾スラッシュ無し、`/oidc` まで含める"
  type        = string

  validation {
    condition     = startswith(var.worker_issuer_url, "https://") && !endswith(var.worker_issuer_url, "/")
    error_message = "worker_issuer_url must start with https:// and have no trailing slash"
  }
}

variable "thumbprints" {
  description = "Cloudflare の TLS cert SHA-1 fingerprint。scripts/get-cf-thumbprint.{sh,ps1} で取得し colon を除いた小文字 hex (40 桁) で渡す。AWS は 5 件まで受け付ける"
  type        = list(string)

  validation {
    condition     = length(var.thumbprints) > 0 && length(var.thumbprints) <= 5
    error_message = "thumbprints must contain 1 to 5 SHA-1 fingerprints"
  }
}

variable "expected_sub" {
  description = "AssumeRoleWithWebIdentity を許可する OIDC sub claim の値。Workers Secret `OIDC_SUB` と一致必須。漏洩疑い時は \"REVOKED-<timestamp>\" 等に上書きすることで全 in-flight session を即時無効化 (緊急 rotation 方式 A)。**tfvars に書かず `-var` フラグでコマンドラインから渡す運用推奨**"
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.expected_sub) >= 8
    error_message = "expected_sub must be at least 8 characters (推測困難な random suffix を含めるため)"
  }
}

variable "role_name" {
  description = "作成する IAM Role の name。本番なら gs-worker-oidc-role、staging なら gs-worker-oidc-role-staging 等"
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z0-9+=,.@_-]+$", var.role_name))
    error_message = "role_name must match IAM role name pattern"
  }
}

variable "max_session_duration" {
  description = "IAM Role 自体の最大 session duration (秒)。**AWS API 最小値 3600 (1h)**、最大 43200 (12h)。これは上限値で、実際の session 時間は STS AssumeRoleWithWebIdentity 呼び出し時の `DurationSeconds` (Worker 側 lib/aws/credentials.ts) で 900 (15min) を指定する (決定3)"
  type        = number
  default     = 3600

  validation {
    condition     = var.max_session_duration >= 3600 && var.max_session_duration <= 43200
    error_message = "max_session_duration must be between 3600 and 43200 seconds (AWS API minimum is 1h)"
  }
}
