# IAM — EC2 instance role と Worker 呼び出し用 IAM user。
#
# Phase 1 で手動作成したものを Step 1 (docs/iac-migration-plan.md) で
# `terraform import` して取り込んだ。値は import 時点の実体に合わせてある
# (description やタグなど、HCL で宣言しない属性は apply で reconcile される)。

# ===========================================================================
# EC2 instance role: gs-phase0-ec2-role
# ===========================================================================

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "gs_phase0_ec2" {
  name = "gs-phase0-ec2-role"
  # コンソールで role を作った際の既定 description。import 後の drift を避けるため明示。
  description        = "Allows EC2 instances to call AWS services on your behalf."
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

# SSM Run Command / Session 経由で EC2 を操作するための AWS マネージドポリシー。
resource "aws_iam_role_policy_attachment" "ec2_ssm_core" {
  role       = aws_iam_role.gs_phase0_ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# launcher tarball / ゲーム設定を S3 から取得するための AWS マネージドポリシー。
resource "aws_iam_role_policy_attachment" "ec2_s3_readonly" {
  role       = aws_iam_role.gs_phase0_ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess"
}

# EC2 に attach する instance profile。コンソールで role を作ると同名で自動生成される。
resource "aws_iam_instance_profile" "gs_phase0_ec2" {
  name = "gs-phase0-ec2-role"
  role = aws_iam_role.gs_phase0_ec2.name
}

# user-data 末尾の「サーバー接続可能」通知を SNS に publish するための inline policy。
# Step 0 で apply 済 (sns.tf の gs-alerts topic を参照)。手動で attach し忘れると
# EC2 → SNS の段で AuthorizationError になり, || echo で握り潰されて Discord に
# 通知が出ない (定番の silent fail)。
resource "aws_iam_role_policy" "ec2_sns_publish" {
  name = "gs-phase0-ec2-sns-publish"
  role = aws_iam_role.gs_phase0_ec2.name

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

# ===========================================================================
# Worker 呼び出し用 IAM user: gs-worker-caller
# ===========================================================================
# Phase 5 (docs/phase5-plan.md) で OIDC + AssumeRoleWithWebIdentity に移行中。
# Step 2 (現在): 新 OIDC role を並走で作成、user 側はまだ残す (rollback 余地)。
# Step 7 (cutover 後 24h): Access Key + user + policy を削除、user 側を完全廃止する。
# 既存 Access Key (AKIA...JCUVJ74) は IaC 管理外、Step 7 で AWS CLI 経由で削除する。

resource "aws_iam_user" "gs_worker_caller" {
  name = "gs-worker-caller"
}

# Worker が EC2 / EBS / SSM を操作するためのカスタマー管理ポリシー。
# 元は runbook-phase1-production.md §3.0 で手動作成・編集したもの。
data "aws_iam_policy_document" "gs_worker_caller" {
  statement {
    sid       = "SsmSendCommandToTaggedInstances"
    effect    = "Allow"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:aws:ec2:${var.aws_region}:*:instance/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = ["game-servers"]
    }
  }

  statement {
    sid       = "SsmSendCommandWithDocument"
    effect    = "Allow"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:aws:ssm:${var.aws_region}::document/AWS-RunShellScript"]
  }

  statement {
    sid       = "SsmGetCommandInvocation"
    effect    = "Allow"
    actions   = ["ssm:GetCommandInvocation"]
    resources = ["*"]
  }

  statement {
    sid     = "SsmAmiResolve"
    effect  = "Allow"
    actions = ["ssm:GetParameters", "ssm:GetParameter"]
    resources = [
      "arn:aws:ssm:*::parameter/aws/service/ami-amazon-linux-*",
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/gs/*",
    ]
  }

  statement {
    sid    = "Ec2RunStopSnapshot"
    effect = "Allow"
    actions = [
      "ec2:RunInstances",
      "ec2:TerminateInstances",
      "ec2:DescribeInstances",
      "ec2:DescribeVolumes",
      "ec2:DescribeSnapshots",
      "ec2:CreateSnapshot",
      # DeleteSnapshot は Cron の世代管理 (Worker handlers/snapshot-retention.ts) が
      # generations を超えた古い game-world snapshot を消すために使う。DLM は Worker が
      # 作る snapshot を管理できないため Worker 側で世代管理する (Step 6)。
      "ec2:DeleteSnapshot",
      "ec2:CreateTags",
      "ec2:DeleteVolume",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "PassEc2InstanceRole"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.gs_phase0_ec2.arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_policy" "gs_worker_caller" {
  name   = "gs-worker-caller-policy"
  policy = data.aws_iam_policy_document.gs_worker_caller.json
}

resource "aws_iam_user_policy_attachment" "gs_worker_caller" {
  user       = aws_iam_user.gs_worker_caller.name
  policy_arn = aws_iam_policy.gs_worker_caller.arn
}

# ===========================================================================
# Phase 5: Worker → AWS OIDC role
# ===========================================================================
# Cloudflare Worker が自身を OIDC issuer 化し、AssumeRoleWithWebIdentity で
# 15min credentials を取得する経路 (docs/phase5-plan.md Step 2)。
# Policy attachment は Step 2.5 (least privilege 化) で別途追加する。
# 本 Step では provider + role の trust 関係のみを構築し、apply 後に AWS CLI で
# AssumeRoleWithWebIdentity が成功することを scripts/sign-test-jwt.mjs で手動検証する。

module "worker_oidc" {
  source = "../../modules/aws-oidc-cloudflare"

  worker_issuer_url = var.worker_oidc_issuer_url
  thumbprints       = var.worker_oidc_thumbprints
  expected_sub      = var.worker_oidc_sub
  role_name         = "gs-worker-oidc-role"
  # max_session_duration はモジュール default の 3600 (AWS API 最小値) を使う。
  # 実際の session 時間 (15min) は Worker 側 STS 呼び出し時の DurationSeconds で指定する。
}
