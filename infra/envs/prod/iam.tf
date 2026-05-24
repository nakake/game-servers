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

# ===========================================================================
# Phase 5 Step 2.5.1: 新 gs-worker-oidc-policy (least privilege 化)
# ===========================================================================
# 既存 gs-worker-caller-policy (上記 L155 付近) は wildcard Resource = "*" を持っており、
# 万一 Worker → AWS credentials が漏洩した際の cryptojacking amplification を許す
# (任意 instance type で任意の数を起動可能)。本 policy はその経路を以下で構造的に潰す:
#
#   - ec2:RunInstances:
#       * ec2:LaunchTemplate = gs-game-server 限定 (= Worker user-data 改竄リスク低減)
#       * ec2:InstanceType ∈ var.worker_oidc_allowed_instance_types (5 個以下)
#       * aws:RequestTag/Env = "prod" 強制 (作成時に Env tag 必須)
#   - ec2:TerminateInstances / DeleteVolume / DeleteSnapshot:
#       * aws:ResourceTag/Project=game-servers + Env=prod (タグ無し他人 resource 不可)
#       * DeleteSnapshot は SnapshotType=game-world-data も必須 = Packer 由来 AMI snapshot は構造的保護
#   - ec2:CreateTags:
#       * ec2:CreateAction ∈ [RunInstances, CreateSnapshot] = 単独 CreateTags 不可 (タグ偽装防止)
#       * aws:RequestTag/Project = "game-servers" 強制
#
# 既存 gs-worker-caller-policy 側は Step 7 で剥がす (24h 観察後)。本 policy は Step 2 で作った
# OIDC role に attach、AssumeRoleWithWebIdentity 経由でのみ使われる。
#
# 詳細設計: docs/phase5-plan.md Step 2.5.1。

data "aws_iam_policy_document" "gs_worker_oidc" {
  # ---- SSM ----
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

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Env"
      values   = ["prod"]
    }
  }

  statement {
    sid       = "SsmSendCommandWithDocument"
    effect    = "Allow"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:aws:ssm:${var.aws_region}::document/AWS-RunShellScript"]
  }

  # ssm:GetCommandInvocation は SendCommand 直後の status 取得に使う。AWS の API 制約で
  # CommandId 単位の Resource 指定は不可、wildcard 維持 (他 user の CommandId 情報は AWS 側で漏れない)。
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

  # ---- EC2 Describe (API 制約で wildcard 必須) ----
  statement {
    sid    = "Ec2Describe"
    effect = "Allow"
    actions = [
      "ec2:DescribeInstances",
      "ec2:DescribeVolumes",
      "ec2:DescribeSnapshots",
    ]
    resources = ["*"]
  }

  # ---- EC2 RunInstances (cryptojacking 抑止の核) ----
  # RunInstances は複数 resource type に対して評価される (instance / volume / key-pair /
  # security-group / subnet / network-interface / launch-template / image)。
  #
  # 当初は Resource = "*" + StringEqualsIfExists(aws:RequestTag/Env) で全 resource を 1 statement
  # に統合する設計を試みたが、AWS の実装では non-taggable resource (key-pair 等) に対しては
  # Resource = "*" の wildcard 自体が match せず、`UnauthorizedOperation: no identity-based
  # policy allows ec2:RunInstances on resource: arn:aws:ec2:...:key-pair/...` が発生する。
  # simulate-principal-policy でも同じ挙動を再現 (本番 ATM11 /start で 2026-05-24 観測)。
  #
  # 対処: resource type を taggable / non-taggable で 2 statement に分割する:
  #   - Ec2RunInstancesTaggable    : instance / volume を Resource として明示、Env=prod tag 必須
  #   - Ec2RunInstancesNonTaggable : key-pair / security-group / subnet / network-interface /
  #                                  launch-template / image を Resource として明示、tag 条件無し
  # どちらの statement にも LaunchTemplate + InstanceType condition があるので、攻撃者が任意
  # LT / 任意 type で起動できない = cryptojacking 抑止は維持。
  statement {
    sid       = "Ec2RunInstancesTaggable"
    effect    = "Allow"
    actions   = ["ec2:RunInstances"]
    resources = [
      "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/*",
      "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:volume/*",
    ]

    condition {
      test     = "ArnEquals"
      variable = "ec2:LaunchTemplate"
      values   = [aws_launch_template.game_server.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "ec2:InstanceType"
      values   = var.worker_oidc_allowed_instance_types
    }

    # 起動時に Env=prod tag を強制する条件。
    #
    # IfExists を使う理由: AWS の policy evaluator は `aws:RequestTag/Env` を
    # **instance resource の evaluation context にしか attach しない** (実 RunInstances
    # API で 2026-05-24 観測。Worker は volumeTags=[Env=prod] を正しく送っているにも関わらず
    # volume context には request tag が現れず、StringEquals が null 比較で fail → deny)。
    # IfExists で「context に tag があれば match、無ければ skip」にすることで volume の
    # evaluation を pass させる。
    #
    # Env=prod 強制の構造的担保は本 condition 単独ではなく多層防御で維持:
    #   1. LT (gs-game-server) の tag_specifications で instance/volume に必ず Env=prod 焼き付け
    #   2. Worker (start.ts) は instanceTags/volumeTags の双方で Env=prod を冗長指定
    #   3. ec2:CreateTags statement で aws:RequestTag/Project=game-servers + ec2:CreateAction を限定
    #      (= 単独 CreateTags での Env tag 偽装を遮断)
    # この 3 層により attacker が credentials 漏洩しても Env=prod 無し instance/volume は作れない。
    condition {
      test     = "StringEqualsIfExists"
      variable = "aws:RequestTag/Env"
      values   = ["prod"]
    }
  }

  statement {
    sid       = "Ec2RunInstancesNonTaggable"
    effect    = "Allow"
    actions   = ["ec2:RunInstances"]
    resources = [
      "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:key-pair/*",
      "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:security-group/*",
      "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:subnet/*",
      "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:network-interface/*",
      "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:launch-template/*",
      # image (AMI) は AWS のアカウントレス resource (Amazon 提供 / 共有 AMI 含む)
      "arn:aws:ec2:${var.aws_region}::image/*",
    ]
    # condition 無し (= 無条件 allow)。理由:
    #   - これらの resource type の evaluation context には ec2:LaunchTemplate /
    #     ec2:InstanceType / aws:RequestTag/<key> が存在しない (実 RunInstances API で
    #     2026-05-24 UnauthorizedOperation を 2 回踏んで判明: AWS の policy evaluator は
    #     request-context key を「該当 resource type に attach されるもの」のみに limit する)。
    #     StringEquals / ArnEquals は null 比較で必ず fail し UnauthorizedOperation になる。
    #   - これらは「Worker が参照するだけの既存 resource」(key-pair, sg, subnet, eni,
    #     launch-template) または AMI で、Worker が新規作成しない。account 共有なので
    #     attacker が用意した resource を埋め込むことも不可。
    #   - cryptojacking 抑止は instance resource を扱う Ec2RunInstancesTaggable 側で
    #     LT + InstanceType + Env=prod 条件付き = 攻撃者は任意 LT / 任意 type で
    #     instance を起動できない (= 本 statement に condition を付けても多層防御
    #     としての価値はゼロ)。
  }

  # ---- EC2 TerminateInstances ----
  statement {
    sid       = "Ec2TerminateInstances"
    effect    = "Allow"
    actions   = ["ec2:TerminateInstances"]
    resources = ["arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = ["game-servers"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Env"
      values   = ["prod"]
    }
  }

  # ---- EC2 CreateSnapshot ----
  # AWS の CreateSnapshot は volume と snapshot の 2 resource に作用する:
  #   - volume には ResourceTag condition (元 volume の tag をチェック)
  #   - snapshot には RequestTag condition (作成する snapshot に貼る tag をチェック)
  # 2 statement に分けて両方の制約を満たす設計。stop-workflow.ts が Project + Env + SnapshotType
  # を tag に渡すため satisfy できる (Step 2.5.0 で Env を追加済)。
  statement {
    sid       = "Ec2CreateSnapshotOnVolume"
    effect    = "Allow"
    actions   = ["ec2:CreateSnapshot"]
    resources = ["arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:volume/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = ["game-servers"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Env"
      values   = ["prod"]
    }
  }

  statement {
    sid       = "Ec2CreateSnapshotResource"
    effect    = "Allow"
    actions   = ["ec2:CreateSnapshot"]
    resources = ["arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:snapshot/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Project"
      values   = ["game-servers"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Env"
      values   = ["prod"]
    }
  }

  # ---- EC2 DeleteSnapshot ----
  # SnapshotType=game-world-data 条件で Packer 由来 AMI snapshot (このタグを持たない) を
  # 構造的に保護する。snapshot-retention.ts はこの tag を持つ snapshot のみを削除対象に
  # するため satisfy できる。
  statement {
    sid       = "Ec2DeleteSnapshot"
    effect    = "Allow"
    actions   = ["ec2:DeleteSnapshot"]
    resources = ["arn:aws:ec2:${var.aws_region}::snapshot/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = ["game-servers"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Env"
      values   = ["prod"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/SnapshotType"
      values   = ["game-world-data"]
    }
  }

  # ---- EC2 DeleteVolume ----
  statement {
    sid       = "Ec2DeleteVolume"
    effect    = "Allow"
    actions   = ["ec2:DeleteVolume"]
    resources = ["arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:volume/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = ["game-servers"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Env"
      values   = ["prod"]
    }
  }

  # ---- EC2 CreateTags ----
  # 単独 CreateTags を許すと「他人 resource に Project=game-servers tag を貼って他 statement の
  # ResourceTag 条件を bypass」できてしまうため、ec2:CreateAction で「RunInstances や
  # CreateSnapshot 経由でのみ tag 作成可」に縛る。さらに新規 tag に Project=game-servers を強制。
  statement {
    sid     = "Ec2CreateTags"
    effect  = "Allow"
    actions = ["ec2:CreateTags"]
    resources = [
      "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/*",
      "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:volume/*",
      "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:snapshot/*",
    ]

    condition {
      test     = "StringEquals"
      variable = "ec2:CreateAction"
      values   = ["RunInstances", "CreateSnapshot"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Project"
      values   = ["game-servers"]
    }
  }

  # ---- iam:PassRole (既存 gs-worker-caller-policy から継承) ----
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

resource "aws_iam_policy" "gs_worker_oidc" {
  name        = "gs-worker-oidc-policy"
  description = "Phase 5 least-privilege policy for Worker via OIDC AssumeRole (Step 2.5.1)"
  policy      = data.aws_iam_policy_document.gs_worker_oidc.json
}

resource "aws_iam_role_policy_attachment" "gs_worker_oidc" {
  role       = module.worker_oidc.role_name
  policy_arn = aws_iam_policy.gs_worker_oidc.arn
}
