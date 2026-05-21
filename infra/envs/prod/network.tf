# Network — default VPC / Subnet の参照と、ゲームサーバー用 Security Group。
#
# default VPC / Subnet は AWS アカウント作成時から存在する共有リソースなので
# import せず data source で参照する (削除・再作成を Terraform に握らせない)。
# Security Group は Phase 1 で手動作成したものを Step 2
# (docs/iac-migration-plan.md) で `terraform import` して取り込んだ。

# ===========================================================================
# default VPC / Subnet (import せず data 参照)
# ===========================================================================

data "aws_vpc" "default" {
  default = true
}

# ゲームサーバーを起動する subnet。現状は ap-northeast-1a の default subnet 固定
# (Worker の EC2_SUBNET_ID と一致)。Step 5 の Launch Template でもこの値を使う。
data "aws_subnet" "default_a" {
  id = "<YOUR_SUBNET_ID>"
}

# ===========================================================================
# Security Group: gs-phase0-sg
# ===========================================================================
# name / description は変更すると SG が再作成される (ForceNew) ため、import 時の
# 実体に厳密に合わせる。再作成すると sg-id が変わり Worker の
# EC2_SECURITY_GROUP_ID や起動中インスタンスに波及する。
#
# 個々の ingress / egress は in-line block ではなく aws_vpc_security_group_*_rule
# リソースで管理する (HashiCorp 推奨。rule 単位の description / tag を保持できる。
# in-line block と rule リソースの併用は不可)。

resource "aws_security_group" "game_server" {
  name        = "gs-phase0-sg"
  description = "Phase 0 verification for game servers"
  vpc_id      = data.aws_vpc.default.id
}

# 管理用 SSH。接続元は管理者のグローバル IP に絞る (var で更新可能)。
resource "aws_vpc_security_group_ingress_rule" "ssh_admin" {
  security_group_id = aws_security_group.game_server.id
  description       = "Admin SSH"
  cidr_ipv4         = var.admin_ssh_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

# Minecraft (ATM11) のゲームポート。全世界公開。
# NOTE: ポート番号は本来 games/<id>/registry.json 由来にしたい。Step 5 の
# Launch Template 整理とあわせて registry 駆動に置き換える (iac-migration-plan §Step 2)。
resource "aws_vpc_security_group_ingress_rule" "minecraft" {
  security_group_id = aws_security_group.game_server.id
  description       = "Minecraft"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 25565
  to_port           = 25565
}

# egress は全許可 (SG 作成時に AWS が自動付与する既定ルートと同一)。
resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.game_server.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
