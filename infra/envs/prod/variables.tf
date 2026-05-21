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
