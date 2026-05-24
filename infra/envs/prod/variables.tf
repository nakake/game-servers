variable "aws_region" {
  description = "Primary AWS region (CLAUDE.md 環境前提)"
  type        = string
  default     = "ap-northeast-1"
}

variable "worker_notification_url" {
  description = "Cloudflare Worker /aws/notification endpoint (SNS HTTPS subscription 先)"
  type        = string

  validation {
    condition     = startswith(var.worker_notification_url, "https://") && endswith(var.worker_notification_url, "/aws/notification")
    error_message = "worker_notification_url must be https:// and end with /aws/notification"
  }
}

variable "monthly_budget_usd" {
  description = "月次コスト上限 (USD)。design.md §8.3: ¥3000 ≒ $20"
  type        = number
  default     = 20
}

variable "budget_warning_threshold_percent" {
  description = "Warning しきい値 (limit_amount の何%)"
  type        = number
  default     = 75
}

variable "admin_ssh_cidr" {
  description = "SSH (port 22) を許可する管理者の送信元 CIDR。ISP の IP 変更時はここを更新"
  type        = string
  default     = "126.94.68.118/32"
}

# ---- Phase 5: Worker OIDC (docs/phase5-plan.md Step 2) ----

variable "worker_oidc_issuer_url" {
  description = "Worker OIDC issuer URL (= Step 1.5 deploy 後の `https://<worker>.workers.dev/oidc`)。末尾スラッシュ無し"
  type        = string

  validation {
    condition     = startswith(var.worker_oidc_issuer_url, "https://") && endswith(var.worker_oidc_issuer_url, "/oidc")
    error_message = "worker_oidc_issuer_url must start with https:// and end with /oidc"
  }
}

variable "worker_oidc_thumbprints" {
  description = "Cloudflare TLS cert chain の SHA-1 fingerprint list (colon なし lowercase hex 40 桁)。scripts/get-cf-thumbprint.{sh,ps1} で取得"
  type        = list(string)
}

variable "worker_oidc_sub" {
  description = "AssumeRoleWithWebIdentity を許可する OIDC sub claim 値。`OIDC_SUB` Workers Secret と一致必須。tfvars に書かず `-var=worker_oidc_sub=<value>` で渡す運用 (緊急 rotation 方式 A 対応)"
  type        = string
  sensitive   = true
}

variable "worker_oidc_allowed_instance_types" {
  description = "新 gs-worker-oidc-policy の ec2:RunInstances が許可する instance type list。registry.json `instance_types[]` 全種をここに登録すること (= 新ゲーム追加で type を増やしたら本 var にも追記して terraform apply 必要)。cryptojacking 抑止の核なので最小権限で運用"
  type        = list(string)
  default = [
    # ATM11 (games/atm11/registry.json:instance_types)
    "r7a.large",
    "r6a.large",
    "m7a.xlarge",
  ]

  validation {
    condition     = length(var.worker_oidc_allowed_instance_types) > 0 && length(var.worker_oidc_allowed_instance_types) <= 10
    error_message = "worker_oidc_allowed_instance_types must contain 1 to 10 instance types (cryptojacking 抑止のため過剰な拡大を防ぐ)"
  }
}
