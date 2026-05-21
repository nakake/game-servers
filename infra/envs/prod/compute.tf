# Compute — EC2 関連リソース: SSH ログイン用 Key Pair (data 参照) と、
# ゲームサーバー起動用の Launch Template (docs/iac-migration-plan.md Step 5)。
#
# Key Pair `gs-phase0-key` (Phase 1 で作成した ed25519 鍵) は data source で参照する。
# resource として import すると public_key (Required・非 Computed 属性 = state 値は
# config 由来) が state に取り込めず、次の apply で鍵が ForceNew 再作成されてしまう
# ため (provider v5.100 の既知挙動)。default VPC / Subnet と同じ「既存・再作成しない
# 共有リソース」扱いとし、TF 管理下には置かない (docs/iac-migration-plan.md Step 4)。
# 秘密鍵 .secrets/gs-phase0-key.pem は .gitignore 配下で運用継続し、IaC では扱わない。

data "aws_key_pair" "gs_phase0" {
  key_name = "gs-phase0-key"
}

# ===========================================================================
# Launch Template: gs-game-server
# ===========================================================================
# 案 B「薄い LT」(docs/iac-migration-plan.md §Launch Template の方針)。
# AMI / Key / SG / IAM profile / EBS base / tag spec / spot 設定を一元管理し、
# ゲーム別の値 (user-data / 復元元 snapshot / EBS サイズ / instance type) は
# Worker が RunInstances 時に override する。LT 自体に game_id を持たせない
# ことで CLAUDE.md「registry 駆動を死守」と整合させる。
#
# Step 5a 時点ではこの LT は宣言・apply するだけで Worker はまだ参照しない
# (Worker の切替は Step 5b)。

resource "aws_launch_template" "game_server" {
  name        = "gs-game-server"
  description = "Game server base LT. user-data / snapshot / EBS size / instance type are overridden per launch by the Worker."

  # AMI は SSM public parameter の resolve: 形式を LT に直書きする。EC2 が起動毎に
  # 最新 AL2023 を解決するため、現状の Worker (EC2_IMAGE_ID = resolve:ssm:...) と
  # 挙動が一致する。apply 時点の ami-id に固定する data 参照ではなく「起動毎 latest」
  # を維持する選択 (docs/iac-migration-plan.md Step 5)。
  image_id = "resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"

  key_name = data.aws_key_pair.gs_phase0.key_name

  vpc_security_group_ids = [aws_security_group.game_server.id]

  iam_instance_profile {
    name = aws_iam_instance_profile.gs_phase0_ec2.name
  }

  # Spot 固定。max_price は指定しない = on-demand 価格を暗黙の上限とする
  # (現状の Worker と同じ挙動。中断は容量要因のみ、価格要因では起こさない)。
  instance_market_options {
    market_type = "spot"
    spot_options {
      spot_instance_type             = "one-time"
      instance_interruption_behavior = "terminate"
    }
  }

  # ゲーム world 用の追加 EBS (/dev/sdf) の base 設定のみ。復元元 snapshot_id と
  # volume_size はゲーム別 (registry.json の ebs_size_gb) なので、Worker が
  # RunInstances 時に同じ device_name で override する。
  block_device_mappings {
    device_name = "/dev/sdf"
    ebs {
      volume_type           = "gp3"
      delete_on_termination = false
    }
  }

  # instance / volume に焼く静的タグ。ゲーム別の Game / Name タグは Worker が
  # RunInstances の TagSpecification で追加する (同 resource type のタグはマージ)。
  tag_specifications {
    resource_type = "instance"
    tags = {
      Project = "game-servers"
      Env     = "prod"
    }
  }

  tag_specifications {
    resource_type = "volume"
    tags = {
      Project = "game-servers"
      Env     = "prod"
      Purpose = "game-world"
    }
  }

  # instance_type は registry.json の instance_types[] 由来で Worker が指定するため
  # LT には入れない (案 B: LT に game 固有値を持たせない)。
  # user_data も Worker が override で渡すため LT 側は空のまま。

  # console / CLI から LT で直接起動した場合も最新版を引くよう default version を更新。
  update_default_version = true
}
