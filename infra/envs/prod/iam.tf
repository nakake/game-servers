# EC2 instance role 周りの IAM。
#
# 現状の方針:
#   - role 本体 (gs-phase0-ec2-role) は手動作成のまま (runbook-phase1.md Step 2)
#   - 追加で必要な inline policy だけここで管理する
#   - role 自体を Terraform 化するのは Phase 4 (拡張順 §infra/README.md)
#
# role を import する時には, この aws_iam_role_policy の role 引数を
# 文字列リテラルから aws_iam_role.gs_phase0_ec2.name に切り替えればよい。

# user-data 末尾の「サーバー接続可能」通知を SNS に publish するために必要。
# 手動で attach し忘れると EC2 → SNS の段で AuthorizationError になり,
# || echo で握り潰されるため Discord に通知が出ない (定番の silent fail)。
resource "aws_iam_role_policy" "ec2_sns_publish" {
  name = "gs-phase0-ec2-sns-publish"
  role = "gs-phase0-ec2-role"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "PublishReadyToGsAlerts"
        Effect   = "Allow"
        Action   = "sns:Publish"
        Resource = aws_sns_topic.gs_alerts.arn
      }
    ]
  })
}
