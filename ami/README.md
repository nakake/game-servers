# ami/ — Packer AMI build for game-server base

Phase 3 Step 7 で導入された Packer 定義 (`docs/phase3-plan.md`)。

## 何が入った AMI か

AL2023 公式 AMI に以下を追加した base AMI:

1. **Docker Engine** (`dnf install -y docker` 済、`systemctl enable`)
2. **Docker Compose v2** (GitHub releases から binary 配置)
3. **sidecar image tar** (`/var/lib/sidecar-image.tar`) — cloud-init が起動時に `docker load`

Phase 1 で動いていた「AL2023 公式 AMI + cloud-init で docker install」フローは引き続き
冪等に動く (`dnf install -y docker` は再実行可) ため、本 AMI への切替は破壊的ではない。

## 配布経路

Packer build → 新 AMI ID 取得 → SSM Parameter `/gs/ami/game-server-latest` に put → Launch
Template `gs-game-server` が `resolve:ssm:` で次回起動から拾う (terraform apply 不要)。

詳細手順は `docs/runbook-phase3-sidecar.md` Step 7 を参照。

## 前提

- Packer ≥ 1.11 (`packer init` 対応)
- Docker Desktop が手元で動く (sidecar の `docker build` + `docker save` をローカルで実行する)
- AWS CLI v2 + 認証情報 (Packer が EC2 build instance + AMI 発行に使う)
- Packer 用 IAM 権限 (Phase 1 で作った `gs-deployer` などのユーザーに追加。最低限の policy は
  `docs/runbook-phase3-sidecar.md` Step 7 を参照)

## 1 コマンドで build

```pwsh
cd F:\project\game_servers
.\scripts\build-sidecar-ami.ps1
# → sidecar の TS build → docker build → docker save → packer build を一気通貫
# → 完了時に "Builds finished. The artifacts ..." と AMI ID が出る
```

オプション:

```pwsh
.\scripts\build-sidecar-ami.ps1 -AmiVersion "phase3-2"
# AMI 名 + Version タグを切り替え
```

## 手動で run する場合

```pwsh
cd launcher/sidecar
npm ci && npm run build
docker build --platform linux/amd64 -t gs-sidecar:latest .
docker save -o ../../.build/sidecar-image.tar gs-sidecar:latest

cd ../../ami
packer init game-server.pkr.hcl
packer build `
  -var "sidecar_tar_path=$PWD/../.build/sidecar-image.tar" `
  -var "ami_version=phase3-1" `
  game-server.pkr.hcl
```

## ファイル構成

```
ami/
├─ game-server.pkr.hcl    # メイン Packer 設定 (amazon-ebs builder)
├─ scripts/
│  ├─ install-docker.sh    # AL2023 + docker engine + compose v2
│  └─ install-sidecar.sh   # /tmp/sidecar-image.tar → /var/lib/sidecar-image.tar
├─ .gitignore             # packer_cache/ や manifest.json を除外
└─ README.md              # 本書
```

## トラブルシュート

### `packer init` で "no matching plugin found"

`packer init` の前に Packer の version が 1.11+ か確認: `packer version`。

### EC2 build instance が起動しない / Timeout

- IAM 権限不足 (ec2:RunInstances 系) → runbook §Step 7 の policy を確認
- VPC / subnet の自動選択が失敗 → `region = ap-northeast-1` 以外で動かしていないか確認
- spot 容量不足 → `build_instance_type` を別の世代に変更 (`m6a.large` 等)

### SSH connection error during provisioning

- 既知の IP allowlist が AMI builder の生成 SG に無い可能性 → Packer は temporary SG を作るので
  通常は関係ないが、企業ネットワーク経由だと outbound restriction で詰まることがある

### sidecar tar が壊れている / docker load 失敗

`scripts/build-sidecar-ami.ps1` の `docker save` 後、ローカルで `docker load -i .build/sidecar-image.tar`
を一度試して、tag `gs-sidecar:latest` が無事 load されることを確認する。
