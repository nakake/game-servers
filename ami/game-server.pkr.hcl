# Packer 定義: gs-game-server AMI (Phase 3 Step 7 で導入)。
#
# 出来上がる AMI = AL2023 base + docker + docker compose v2 + sidecar image preloaded。
# cloud-init (workers/discord-handler/src/lib/launcher/user-data.ts) は dnf install -y docker
# を **依然として実行** する (idempotent) が、本 AMI ではすでに入っているため事実上 no-op で済む。
#
# 焼き込み: sidecar image は事前にローカルで `docker save` して tar 化、
# `var.sidecar_tar_path` で Packer に渡す。scripts/build-sidecar-ami.ps1 がこの流れを
# 1 コマンドで orchestrate する。
#
# 起動経路: 本 AMI を SSM Parameter `/gs/ami/game-server-latest` に書き込み、Launch Template
# `gs-game-server` (`infra/envs/prod/compute.tf`) が `resolve:ssm:` 形式で解決する。
# AMI 更新 → SSM put-parameter で次回起動から即反映 (terraform apply 不要)。

packer {
  required_plugins {
    amazon = {
      source  = "github.com/hashicorp/amazon"
      version = "~> 1.3"
    }
  }
}

variable "aws_region" {
  type    = string
  default = "ap-northeast-1"
}

variable "sidecar_tar_path" {
  type        = string
  description = "Local path to the sidecar docker image tar (output of `docker save`)."
}

variable "ami_version" {
  type        = string
  default     = "phase3-1"
  description = "Human-readable version tag baked into the AMI name and Tags."
}

# Packer build を走らせるインスタンスタイプ。最終 AMI は別 instance type で使われるので、
# build 中は安いものでよい (但し x86_64 必須、AL2023 base AMI は x86_64)。
variable "build_instance_type" {
  type    = string
  default = "m7a.large"
}

source "amazon-ebs" "gs_game_server" {
  region          = var.aws_region
  instance_type   = var.build_instance_type
  ssh_username    = "ec2-user"
  ami_name        = "gs-game-server-${var.ami_version}-{{timestamp}}"
  ami_description = "game-servers base AMI (Phase 3): AL2023 + docker + compose v2 + sidecar image preloaded"

  source_ami_filter {
    filters = {
      name                = "al2023-ami-2023.*-x86_64"
      virtualization-type = "hvm"
      root-device-type    = "ebs"
      architecture        = "x86_64"
    }
    owners      = ["amazon"]
    most_recent = true
  }

  launch_block_device_mappings {
    device_name           = "/dev/xvda"
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }

  # Launch Template `gs-game-server` (infra) が tag:Project=game-servers + tag:Name=gs-game-server
  # の AMI を期待しないため、ここは documentation 目的のみ。SSM Parameter で参照されるので
  # 名前で絞る運用ではない。
  tags = {
    Project = "game-servers"
    Env     = "prod"
    Name    = "gs-game-server"
    Version = var.ami_version
    BuiltBy = "packer"
  }

  # AMI と一緒に作られる EBS snapshot に付くタグ。Phase 5 Step 2.5 の IAM policy
  # tightening が `aws:ResourceTag/Env = "prod"` 条件を全 snapshot に要求するため、
  # Packer 由来の AMI snapshot にも明示的に付与する (= 将来 Env tag 欠落で新 snapshot
  # が policy 条件を満たさず Worker から見えなくなる事故を防ぐ)。
  snapshot_tags = {
    Project = "game-servers"
    Env     = "prod"
    Name    = "gs-game-server"
    Version = var.ami_version
    BuiltBy = "packer"
  }

  # Packer build 中の builder EC2 / EBS volume に付くタグ。build 中の resource にも
  # Project + Env を貼っておくと、ビルド失敗で残存した resource を tag 検索で発見できる。
  run_tags = {
    Project = "game-servers"
    Env     = "prod"
    Name    = "gs-game-server-builder"
    BuiltBy = "packer"
  }
  run_volume_tags = {
    Project = "game-servers"
    Env     = "prod"
    Name    = "gs-game-server-builder"
    BuiltBy = "packer"
  }
}

build {
  name    = "gs-game-server"
  sources = ["source.amazon-ebs.gs_game_server"]

  # 1. docker + compose v2 を AMI に入れる。docker-compose-plugin パッケージは AL2023
  # repo に無いため GitHub releases から binary を取る (memory: al2023-docker-compose)。
  provisioner "shell" {
    script          = "scripts/install-docker.sh"
    execute_command = "sudo -E bash '{{ .Path }}'"
  }

  # 2. ローカルで docker save した sidecar image tar を AMI builder に転送。
  provisioner "file" {
    source      = var.sidecar_tar_path
    destination = "/tmp/sidecar-image.tar"
  }

  # 3. tar を `/var/lib/sidecar-image.tar` に移動。cloud-init が `docker load -i` で読む。
  # ここで `docker load` してしまうと AMI snapshot 内の Docker storage に image が入り、
  # AMI サイズが膨らむ。snapshot 後の起動時に load する方が AMI サイズが小さく済むため、
  # AMI には tar だけ置く (user-data.ts の Step 6 の `docker load -i` 行と整合)。
  provisioner "shell" {
    script          = "scripts/install-sidecar.sh"
    execute_command = "sudo -E bash '{{ .Path }}'"
  }
}
