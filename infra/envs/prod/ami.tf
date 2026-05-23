# SSM Parameter で Launch Template `gs-game-server` の AMI ID を間接参照する。
#
# Phase 3 Step 7 で導入された経路:
#   - Packer (`ami/game-server.pkr.hcl`) が AL2023 base + docker + sidecar image preloaded
#     の AMI を発行する。
#   - 発行後、scripts/build-sidecar-ami.ps1 の出力に従って `aws ssm put-parameter --overwrite`
#     でこの parameter の value を書き換える (Terraform apply 不要)。
#   - Launch Template (compute.tf) は image_id に `resolve:ssm:/gs/ami/game-server-latest`
#     を渡すため、起動時に最新 AMI ID へ自動解決される。
#
# 「Terraform で初期値を作る」ためだけのリソース。Packer での書き換えが TF apply で巻き戻る
# のを防ぐため `lifecycle.ignore_changes = [value]`。新環境構築時は AL2023 公式 AMI を引き
# 込んで初期値とする (Packer build 前でも Worker から /start できる)。

data "aws_ssm_parameter" "al2023_latest" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_ssm_parameter" "game_server_ami_id" {
  name        = "/gs/ami/game-server-latest"
  type        = "String"
  description = "Latest gs-game-server AMI ID. Updated by scripts/build-sidecar-ami.ps1 after Packer build (Phase 3 Step 7)."

  # 初期値は AL2023 公式 AMI ID (Packer build 前の fallback)。`data.aws_ssm_parameter` は
  # `insecure_value` を String として返すため、SecureString でない普通の AMI ID 用途では問題なし。
  value = data.aws_ssm_parameter.al2023_latest.insecure_value

  lifecycle {
    # Packer build orchestrator の `aws ssm put-parameter --overwrite` を TF apply が
    # 巻き戻さないよう、value 変更は drift 扱いにしない。
    ignore_changes = [value]
  }

  tags = {
    Project = "game-servers"
    Purpose = "ami-pointer"
  }
}
