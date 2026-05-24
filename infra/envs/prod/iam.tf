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
# 旧 IAM user gs-worker-caller (Phase 1〜4 の Worker 呼び出し経路) は Phase 5 Step 7
# (2026-05-24) で削除済。Worker は OIDC + AssumeRoleWithWebIdentity 経由で AWS API を
# 叩く (下の module "worker_oidc" + aws_iam_policy.gs_worker_oidc)。
# 復活させたい場合は git revert で参照: 削除 commit は本ファイルの履歴を辿る。
#
# 削除した resource:
#   - aws_iam_user.gs_worker_caller
#   - aws_iam_policy.gs_worker_caller (wildcard Resource = "*" 含む旧 user policy)
#   - aws_iam_user_policy_attachment.gs_worker_caller
#   - data.aws_iam_policy_document.gs_worker_caller
# Access Key (AKIA...) は手動 (aws iam delete-access-key) で削除済。

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
  # AWS の policy evaluator は **`ec2:LaunchTemplate` / `ec2:InstanceType` / `aws:RequestTag/<key>`
  # を instance resource の evaluation context にしか attach しない**。volume を含む全ての
  # 他 resource type に対する evaluation では context が空のため、StringEquals / ArnEquals が
  # null 比較で fail する (実 /start atm11 で 2026-05-24 に 3 回観測: key-pair / volume / 等)。
  # simulate-principal-policy も同じ挙動を再現。
  #
  # 対処: instance resource のみに condition を集約し、それ以外を無条件 allow。
  # 攻撃面: attacker は同 RunInstances request の instance evaluation で必ず deny されるため、
  # 他 resource が無条件 allow でも全体としては起動不可 (= cryptojacking 抑止維持)。
  #
  #   - Ec2RunInstancesInstance : instance/* のみ、LT + InstanceType + RequestTag/Env=prod 厳格
  #   - Ec2RunInstancesSupport  : それ以外 (volume / key-pair / sg / subnet / eni / lt / image)
  #                              無条件 allow (instance side が代理 cryptojacking 抑止)
  statement {
    sid       = "Ec2RunInstancesInstance"
    effect    = "Allow"
    actions   = ["ec2:RunInstances"]
    resources = [
      "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/*",
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

    # instance resource の TagSpecifications に Env=prod が含まれていることを強制 (start.ts
    # instanceTags で渡される、Step 2.5.0 で対応済)。Volume 等の tag 強制は本 condition では
    # 担保せず、LT tag_specifications + Worker volumeTags の冗長指定 + ec2:CreateTags 別 statement
    # の多層防御で維持する。
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Env"
      values   = ["prod"]
    }
  }

  statement {
    sid       = "Ec2RunInstancesSupport"
    effect    = "Allow"
    actions   = ["ec2:RunInstances"]
    resources = [
      "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:volume/*",
      "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:key-pair/*",
      "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:security-group/*",
      "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:subnet/*",
      "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:network-interface/*",
      "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:launch-template/*",
      # image (AMI) は AWS のアカウントレス resource (Amazon 提供 / 共有 AMI 含む)
      "arn:aws:ec2:${var.aws_region}::image/*",
      # snapshot は BlockDeviceMappings.Ebs.SnapshotId で復元元として参照される。
      # account-less / account 付きの両方の ARN format があるので両方明示。
      "arn:aws:ec2:${var.aws_region}::snapshot/*",
      "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:snapshot/*",
    ]
    # condition 無し。AWS は LT / InstanceType / RequestTag を instance resource にしか attach
    # しないため、これらの statement に condition を付けると常に null 比較で fail する。
    # 攻撃面の閉鎖は Ec2RunInstancesInstance 側で行う (同 request の instance evaluation が
    # deny されれば、他 resource が allow でも RunInstances 全体は失敗 = 攻撃者は任意 LT /
    # 任意 type / Env=prod 無しの instance を起動できない)。
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
    sid     = "Ec2CreateSnapshotResource"
    effect  = "Allow"
    actions = ["ec2:CreateSnapshot"]
    # snapshot は account-less ARN format でも参照される (実 CreateSnapshot で
    # arn:aws:ec2:ap-northeast-1::snapshot/* に対して deny を 2026-05-24 観測)。
    # 両 format を allow しないと wildcard match しない。
    resources = [
      "arn:aws:ec2:${var.aws_region}::snapshot/*",
      "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:snapshot/*",
    ]

    # IfExists を使う理由: RunInstances の volume と同じく、AWS は CreateSnapshot の
    # snapshot resource evaluation context に aws:RequestTag/<key> を一貫して attach
    # しないケースがある (実 API で deny を観測)。
    # 攻撃面の閉鎖は Ec2CreateSnapshotOnVolume 側 (volume resource の ResourceTag check
    # = Worker が tag を付けた game-servers / prod volume のみ snapshot 化可能) で
    # 維持される = attacker が任意 volume を snapshot 化できない。
    condition {
      test     = "StringEqualsIfExists"
      variable = "aws:RequestTag/Project"
      values   = ["game-servers"]
    }

    condition {
      test     = "StringEqualsIfExists"
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
      # snapshot は account-less ARN format でも参照される (実 CreateSnapshot 内部の
      # implicit CreateTags 評価で arn:aws:ec2:<region>::snapshot/* に対して deny を観測、
      # 2026-05-24)。両 format を allow しないと wildcard match しない。
      "arn:aws:ec2:${var.aws_region}::snapshot/*",
    ]

    # CreateAction も AWS の attach 仕様で resource 依存。RunInstances 内部の implicit
    # CreateTags 評価では CreateAction が context に attach されるが、CreateSnapshot 内部の
    # implicit CreateTags 評価では一部 resource (account-less snapshot ARN) で attach されない
    # 可能性があるため IfExists 化。Project tag 強制 (下) で「単独 CreateTags での tag 偽装」
    # は引き続き遮断される。
    condition {
      test     = "StringEqualsIfExists"
      variable = "ec2:CreateAction"
      values   = ["RunInstances", "CreateSnapshot"]
    }

    condition {
      test     = "StringEqualsIfExists"
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
