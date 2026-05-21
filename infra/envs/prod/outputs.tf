output "sns_alerts_topic_arn" {
  description = "wrangler.toml の SNS_ALLOWED_TOPIC_ARN と EC2 role inline policy の publish 先に使う値"
  value       = aws_sns_topic.gs_alerts.arn
}

output "sns_alerts_subscription_arn" {
  description = "Worker への HTTPS subscription ARN (confirm 後に PendingConfirmation から外れる)"
  value       = aws_sns_topic_subscription.worker_webhook.arn
}

output "monthly_budget_name" {
  description = "AWS Budgets 上の名前。手動 Budget を削除する際の目印"
  value       = aws_budgets_budget.monthly.name
}

output "security_group_id" {
  description = "wrangler.toml の EC2_SECURITY_GROUP_ID。Step 5 の Launch Template でも使う"
  value       = aws_security_group.game_server.id
}

output "default_subnet_id" {
  description = "wrangler.toml の EC2_SUBNET_ID。ゲームサーバーを起動する subnet"
  value       = data.aws_subnet.default_a.id
}
