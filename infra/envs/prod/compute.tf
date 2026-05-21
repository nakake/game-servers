# Compute — EC2 関連リソース。現状は SSH ログイン用の Key Pair のみ。
# Step 5 で Launch Template (aws_launch_template) がここに加わる予定。
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
