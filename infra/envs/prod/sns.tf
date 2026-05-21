# SNS topic gs-alerts (design.md §4.6)
#
# AWS Budgets / EventBridge / CloudWatch Alarm からの通知をここに集約し,
# HTTPS subscription で Cloudflare Worker /aws/notification → Discord に流す。
#
# 既存の手動作成 topic は `terraform import` で取り込む。CreateTopic API は
# トピック自体には冪等だが, Tags 付き CreateTopic を「既存 topic かつタグ不一致」で
# 呼ぶと InvalidParameter (Topic already exists with different tags) の 400 になり,
# apply 任せの自動取り込みはできない (Step 0 で表面化)。取り込み手順:
#   terraform import aws_sns_topic.gs_alerts arn:aws:sns:ap-northeast-1:<account>:gs-alerts

data "aws_caller_identity" "current" {}

resource "aws_sns_topic" "gs_alerts" {
  name = "gs-alerts"

  # 手動作成時 (runbook-phase1-production.md §3.4) に設定済の display name。
  # 明示しないと import 後の apply で null 化される。
  display_name = "gs-alerts"

  tags = {
    Purpose = "aws-alerts-to-discord"
  }
}

# topic policy — AWS マネージドサービスからの publish を明示許可する。
# コンソール経由で Budget を SNS に紐付けた場合は AWS 側が裏で policy を追加するが,
# その追加が漏れたり手動で消えたりすると通知が silent fail する。IaC で明示する。
data "aws_iam_policy_document" "gs_alerts" {
  statement {
    sid    = "AllowOwnerFullAccess"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions = [
      "SNS:GetTopicAttributes",
      "SNS:SetTopicAttributes",
      "SNS:AddPermission",
      "SNS:RemovePermission",
      "SNS:DeleteTopic",
      "SNS:Subscribe",
      "SNS:ListSubscriptionsByTopic",
      "SNS:Publish",
    ]

    resources = [aws_sns_topic.gs_alerts.arn]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceOwner"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid    = "AllowAwsServicesPublish"
    effect = "Allow"

    principals {
      type = "Service"
      identifiers = [
        "budgets.amazonaws.com",
        "events.amazonaws.com",
      ]
    }

    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.gs_alerts.arn]
  }

  # EC2 instance role (gs-phase0-ec2-role) からの ready 通知 publish は
  # role 側 inline policy で許可済 (runbook-phase1-production.md §3.0.1)。
  # トピック policy としては AllowOwnerFullAccess で同一アカウント内なら通る。
}

resource "aws_sns_topic_policy" "gs_alerts" {
  arn    = aws_sns_topic.gs_alerts.arn
  policy = data.aws_iam_policy_document.gs_alerts.json
}

# HTTPS subscription → Worker /aws/notification
# Worker 側 (handlers/aws-notification.ts) が SubscribeURL を自動 GET して confirm するので,
# endpoint_auto_confirms = true で「待たずに前進してよい」と Terraform に伝える。
resource "aws_sns_topic_subscription" "worker_webhook" {
  topic_arn              = aws_sns_topic.gs_alerts.arn
  protocol               = "https"
  endpoint               = var.worker_notification_url
  endpoint_auto_confirms = true
}
