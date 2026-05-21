# 月次コスト上限アラート (design.md §8.3)
#
# 75% (=$15) で warning, 100% (=$20) で critical の 2 段。
# SNS topic gs-alerts → Worker /aws/notification → Discord に流れる。
#
# 手動で作った既存 Budget がある場合は apply 後にコンソールで削除すること
# (この Terraform は新名 gs-monthly-cap で作成するので衝突はしない)。

resource "aws_budgets_budget" "monthly" {
  name         = "gs-monthly-cap"
  budget_type  = "COST"
  time_unit    = "MONTHLY"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"

  # 75% で 1 段目 (warning 相当)
  notification {
    comparison_operator       = "GREATER_THAN"
    notification_type         = "ACTUAL"
    threshold                 = var.budget_warning_threshold_percent
    threshold_type            = "PERCENTAGE"
    subscriber_sns_topic_arns = [aws_sns_topic.gs_alerts.arn]
  }

  # 100% で 2 段目 (critical 相当)
  notification {
    comparison_operator       = "GREATER_THAN"
    notification_type         = "ACTUAL"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    subscriber_sns_topic_arns = [aws_sns_topic.gs_alerts.arn]
  }

  depends_on = [aws_sns_topic_policy.gs_alerts]
}
