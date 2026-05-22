# EventBridge — AWS イベント → SNS gs-alerts (design.md §4.6, iac-migration-plan.md Step 7)
#
# Spot 中断警告を捕捉して通知系に流す。EC2 は Spot インスタンスを回収する約 2 分前に
# default event bus へ "EC2 Spot Instance Interruption Warning" イベントを出す。これを
# EventBridge rule で拾い、input_transformer で人間可読な 1 行に整形してから SNS
# gs-alerts に publish する → Worker /aws/notification → Discord embed に届く。
#
# SNS topic policy (sns.tf の AllowAwsServicesPublish) は events.amazonaws.com の
# SNS:Publish を既に許可済のため、topic 側の変更は不要。
#
# 当初計画 (Step 7) には DLM Policy 失敗を拾う aws_cloudwatch_event_rule.dlm_policy_failed
# もあったが、Step 6 で DLM を不採用 (snapshot 世代管理は Worker Cron) としたため監視対象
# の DLM ポリシーが存在せず空振りになる。よって作らない (ユーザー判断 2026-05-22)。
# 任意項目だった IAM 異常ログイン rule も CloudTrail 依存のため本 Step では見送り。

resource "aws_cloudwatch_event_rule" "spot_interruption" {
  name        = "gs-spot-interruption-warning"
  description = "EC2 Spot Instance Interruption Warning を SNS gs-alerts に転送する"

  # AWS サービスイベントは default event bus に届くため event_bus_name は既定 ("default")。
  event_pattern = jsonencode({
    source        = ["aws.ec2"]
    "detail-type" = ["EC2 Spot Instance Interruption Warning"]
  })
}

resource "aws_cloudwatch_event_target" "spot_interruption_to_sns" {
  rule      = aws_cloudwatch_event_rule.spot_interruption.name
  target_id = "sns-gs-alerts"
  arn       = aws_sns_topic.gs_alerts.arn

  # 生イベント JSON のままだと Discord embed 本文が読みにくいため、必要なフィールドだけ
  # 抜いて 1 行のメッセージに整形する。EventBridge → SNS は SNS Subject を設定できない
  # ので embed タイトルは Worker 側で "AWS notification" 固定になる (Worker コード変更なし
  # の制約)。本文に "interruption" を含むため Worker の inferSeverity は critical 判定。
  input_transformer {
    input_paths = {
      instance = "$.detail.instance-id"
      action   = "$.detail.instance-action"
      region   = "$.region"
      time     = "$.time"
    }
    # input_template を引用符で囲むと SNS には素の文字列として届く (JSON 値ではなく)。
    # action 値 (terminate / stop / hibernate) は語形変化させず action= で素のまま出す。
    input_template = "\"Spot interruption warning: instance <instance> (<region>); action=<action>; reclaimed in ~2 min; event time <time>\""
  }
}
