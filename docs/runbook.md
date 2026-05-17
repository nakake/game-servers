# Runbook — Phase 0 検証手順

最終更新: 2026-05-17 (rev 2: Phase 0 トラブル履歴を反映)

## このドキュメントについて

`design.md` の **Phase 0: 検証** を AWS マネコンで手動実行するための手順書。
目的は **インスタンスタイプと EBS サイズの確定**、および **snapshot 復元動作の確認**。

所要時間: 半日〜1 日 (待ち時間含む)。
費用見込み: ¥100 以下 (3〜4 時間の spot 稼働 + 少量 EBS / snapshot)。

---

## 前提

- [ ] AWS アカウントが作成済み
- [ ] IAM ユーザー(管理者権限)でマネジメントコンソールにログインできる
- [ ] リージョン: **ap-northeast-1 (東京)** で作業
- [ ] 自宅などの作業 IP を把握している (SSH ホワイトリスト用)
- [ ] Minecraft クライアント (NeoForge 26.1.2 + ATM11) が手元にある
- [ ] SSH クライアント (Windows: OpenSSH / PowerShell, または Tera Term)

---

## Step 1: AWS 事前準備

### 1.1 キーペア作成

1. EC2 コンソール → **Network & Security → Key Pairs**
2. **Create key pair**
   - Name: `gs-phase0-key`
   - Type: ED25519
   - Format: `.pem`
3. ダウンロードした `gs-phase0-key.pem` を `F:/project/game_servers/.secrets/` に保管 (gitignore 対象)
4. Windows の場合は権限制限:
   ```powershell
   icacls F:\project\game_servers\.secrets\gs-phase0-key.pem /inheritance:r /grant:r "$env:USERNAME:R"
   ```

### 1.2 Security Group 作成

1. EC2 コンソール → **Network & Security → Security Groups**
2. **Create security group**
   - Name: `gs-phase0-sg`
   - Description: `Phase 0 verification for game servers`
   - VPC: default
3. Inbound rules:

| Type | Protocol | Port | Source | Description |
|---|---|---|---|---|
| Custom TCP | TCP | 25565 | 0.0.0.0/0 | Minecraft |
| SSH | TCP | 22 | `<自宅IP>/32` | 管理用 SSH |

> 自宅 IP は https://checkip.amazonaws.com/ で確認できる。
> 変動 IP なら都度更新。

4. Outbound: デフォルトのまま (all traffic)

### 1.3 IAM ロール (EC2 用)

S3 アクセス用に最小ロールを作る:

1. IAM → **Roles → Create role**
2. Trusted entity: **AWS service → EC2**
3. Policy: 一旦 `AmazonS3ReadOnlyAccess` (Phase 0 は read 不要だが将来用)
4. Name: `gs-phase0-ec2-role`

---

## Step 2: EBS ボリューム準備

ATM11 を入れる用の専用 EBS を先に作っておく(EC2 とは別ライフサイクル)。

1. EC2 コンソール → **Elastic Block Store → Volumes**
2. **Create volume**
   - Volume type: **gp3**
   - Size: **30 GiB**
   - IOPS: 3000 (デフォルト)
   - Throughput: 125 MiB/s (デフォルト)
   - Availability Zone: **ap-northeast-1a** (固定。spot もここで起こす)
   - Tags:
     - `Project = game-servers`
     - `Game = atm11`
     - `Purpose = game-world`
     - `Name = gs-atm11-world`
3. **Create volume**

Volume ID をメモ (`vol-xxxxxxxx`)。

---

## Step 3: Spot EC2 起動

### 3.1 Launch Template (一回限り)

毎回パラメータ入力するのを避けるため、Launch Template を作る。

1. EC2 → **Instances → Launch Templates → Create launch template**
2. 設定:
   - Name: `gs-phase0-lt`
   - AMI: **Amazon Linux 2023** (x86_64, kernel 6.1, gp3) — 最新を選択
   - Instance type: **m7a.xlarge**
   - Key pair: `gs-phase0-key`
   - Subnet: ap-northeast-1a の default subnet
   - Security groups: `gs-phase0-sg`
   - IAM instance profile: `gs-phase0-ec2-role`
   - Storage (root): gp3 8 GiB (デフォルトでOK)
   - Tags:
     - `Project = game-servers`
     - `Game = atm11`
     - `Env = phase0`
   - **Advanced details**:
     - Purchasing option: **Request Spot Instances**
     - Maximum price: blank (on-demand 価格まで許容)
     - Interruption behavior: **terminate**
     - User data: 後述 (3.2)

### 3.2 user-data スクリプト

Launch Template の User data 欄に貼る:

```bash
#!/bin/bash
set -eux

# ── 1. 基本パッケージ ──────────────────────
dnf update -y
dnf install -y docker tmux htop jq amazon-cloudwatch-agent

# ── 2. Docker ────────────────────────────
systemctl enable --now docker
usermod -aG docker ec2-user

# ── 3. Java 25 (Corretto) ────────────────
# AL2023 リポジトリに 25 が無ければ Adoptium に変更
curl -L -o /tmp/corretto25.rpm \
  https://corretto.aws/downloads/latest/amazon-corretto-25-x64-linux-jdk.rpm
dnf install -y /tmp/corretto25.rpm
java -version

# ── 4. EBS マウント ────────────────────────
# 注意: VOLUME_ID は手動で書き換えるか、起動後に手動 attach
mkdir -p /opt/atm11
# attach は手動 (Step 3.4) で行うため、ここでは何もしない

echo "user-data done" > /var/log/gs-userdata.log
```

> **重要**: EBS の attach は user-data から自動化せず、**Step 3.4** で手動実行する。
> 自動化は Phase 1 以降。

### 3.3 インスタンス起動

1. Launch Templates 一覧 → 作ったテンプレ選択 → **Actions → Launch instance from template**
2. **Launch instance**
3. Instances 画面で `running` 待ち (1〜2 分)
4. Public IPv4 をメモ

### 3.4 EBS attach

1. EBS Volumes → `gs-atm11-world` 選択
2. **Actions → Attach volume**
3. Instance: 上で起動した EC2 を選択
4. Device: `/dev/sdf` (Linux 内では `/dev/nvme1n1` として見える)
5. **Attach**

### 3.5 SSH ログイン + ボリューム初期化

```bash
ssh -i F:/project/game_servers/.secrets/gs-phase0-key.pem ec2-user@<public-ip>
```

初回のみフォーマット (新規ボリューム時):

```bash
# デバイス確認
lsblk
# /dev/nvme1n1 が attach されたボリューム

# フォーマット (初回のみ!)
sudo mkfs.ext4 /dev/nvme1n1

# マウント
sudo mkdir -p /opt/atm11
sudo mount /dev/nvme1n1 /opt/atm11
sudo chown ec2-user:ec2-user /opt/atm11

# fstab 登録 (再起動時自動マウント)
UUID=$(sudo blkid -s UUID -o value /dev/nvme1n1)
echo "UUID=$UUID /opt/atm11 ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab
```

---

## Step 4: ATM11 サーバー配置

### 4.1 ファイル転送

ローカル PC から(別ターミナルで):

```powershell
# Windows PowerShell から
$IP = "<public-ip>"
$KEY = "F:\project\game_servers\.secrets\gs-phase0-key.pem"

# ATM11 サーバーディレクトリを圧縮して転送
cd F:\Games\minecraft\ATM
tar -czf atm11.tar.gz ATM11
scp -i $KEY atm11.tar.gz ec2-user@${IP}:/opt/atm11/
```

転送量目安: 500MB 前後、数分。

### 4.2 サーバー側で展開

```bash
cd /opt/atm11
tar -xzf atm11.tar.gz
mv ATM11/* ATM11/.[!.]* . 2>/dev/null || true
rmdir ATM11
ls   # mods/, config/, neoforge-*-installer.jar 等が並んでいることを確認
```

### 4.3 NeoForge 初期化

```bash
cd /opt/atm11
bash startserver.sh
# 初回は依存ライブラリのダウンロード + eula 警告で停止
```

eula 同意:

```bash
sed -i 's/eula=false/eula=true/' eula.txt
```

### 4.4 起動

```bash
tmux new -s mc
bash startserver.sh
# Done (XX.XXXs)! For help, type "help"  が出れば起動成功
```

`Ctrl+B → D` で detach。再 attach は `tmux a -t mc`。

---

## Step 5: 接続テスト

### 5.1 Minecraft クライアントから接続

1. Minecraft Launcher で NeoForge 26.1.2 + ATM11 プロファイル起動
2. Multiplayer → **Direct Connect** → `<public-ip>:25565`
3. 接続成功確認
4. **5 分プレイ** (移動、ブロック設置、夜を1回越える)

### 5.2 spark profiler 計測

ゲーム内チャットで:

```
/spark profiler --timeout 300
```

5 分後に URL が出力される。クライアント側コンソールにも同じ URL。

### 5.3 メモリ計測

```
/spark heapsummary
```

→ JVM ヒープの実使用量を確認。10 GB に対して何 GB 使ったか。

### 5.4 計測結果記録

`docs/phase0-results.md` に以下を記録:

| 項目 | 値 |
|---|---|
| 起動時間 | _秒 |
| 起動直後 ヒープ実消費 | _GB / 10GB |
| 5 分プレイ後 ヒープピーク | _GB / 10GB |
| 平均 mspt | _ms |
| 最大 mspt | _ms |
| GC pause 平均 | _ms |
| GC pause 最大 | _ms |
| Allocation stall 発生有無 | あり / なし |
| Spot 中断有無 | あり / なし |

### 5.5 判定基準

| 結果 | アクション |
|---|---|
| ヒープピーク < 7 GB | **Xmx 8GB / G1GC 検討** (m7a.large に下げて半額) |
| ヒープピーク 7〜8.5 GB | **現状の Xmx 10GB / ZGC でOK** |
| ヒープピーク > 8.5 GB | **Xmx 12GB に戻す** or **r7a.xlarge (32GB)** |
| mspt 常時 < 50ms | OK |
| mspt 50〜100ms 散発 | OK だがプレイヤー増で要再評価 |
| mspt 常時 > 100ms | **c7a.2xlarge (8vCPU)** に変更 |
| Allocation stall 頻発 | **Xmx を 2GB 増** or **G1GC に戻す** |

---

## Step 6: EBS Snapshot + 復元検証

### 6.1 サーバー停止 + snapshot 作成

```bash
# サーバー側 (tmux 内)
stop  # graceful stop、save-all 含む
# プロンプトに戻ったら exit で tmux 抜ける
```

アンマウント:

```bash
sudo umount /opt/atm11
```

AWS マネコンで:

1. EBS → Volumes → `gs-atm11-world` 選択
2. **Actions → Create snapshot**
3. Description: `phase0 verification snapshot`
4. Tags:
   - `Project = game-servers`
   - `Game = atm11`
   - `Purpose = game-world`
5. **Create snapshot**

Snapshots 画面で `completed` 待ち (初回フル: 数分〜10 分)。

### 6.2 旧 EC2 / 旧 EBS を削除

1. 元の EC2 を **Terminate** (`Actions → Terminate instance`)
2. 元の EBS Volume を **Delete** (`Actions → Delete volume`)

これでクリーンな状態。

### 6.3 Snapshot から新 EBS 作成

1. EBS → Snapshots → 作った snapshot 選択
2. **Actions → Create volume from snapshot**
3. Volume type: gp3 / Size: 30 GiB / AZ: ap-northeast-1a
4. Tags: 同じ Project/Game/Purpose を再付与
5. **Create volume**

### 6.4 新 EC2 起動 + 復元検証

1. 同じ Launch Template から新規インスタンス起動 (Step 3.3 と同じ)
2. 新しい EBS volume を attach (Step 3.4)
3. SSH ログイン
4. マウント (**今回はフォーマットしない!**):

```bash
sudo mkdir -p /opt/atm11
sudo mount /dev/nvme1n1 /opt/atm11
ls /opt/atm11   # mods/, world/, etc. が見えるはず
```

5. サーバー起動:

```bash
cd /opt/atm11
tmux new -s mc
bash startserver.sh
```

6. Minecraft クライアントから接続(新しい public IP)
7. **前回プレイした地点に居る、設置したブロックが残っている** ことを確認

### 6.5 後片付け

検証完了したら全部削除:

1. tmux 内で `stop`
2. EC2 **Terminate**
3. EBS Volume **Delete**
4. Snapshot **Delete** (Phase 1 で再作成するため不要)
5. Security Group, Key Pair, Launch Template は残しても安全 (Phase 1 で流用)

---

## Step 7: コスト確認

1. AWS Billing → **Cost Explorer**
2. 今日の支出が ¥100 以下であることを確認
3. 想定外のリソース(NAT Gateway, ELB 等)が無いことを確認

---

## トラブルシュート

### Launch Template 作成時に "fail to request credential"

新規アカウント直後の伝搬遅延で AMI カタログ取得に失敗するケース。
AMI 欄に SSM パラメータの **直接参照** を入力して回避:

```
resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64
```

(Phase 0 で実際に発生。トラブル #1)

### Launch instance 直後に SSH connection timed out

確認画面で **default SG が紛れ込み**、`gs-phase0-sg` が外れている可能性あり (Phase 0 トラブル #2 で実際に発生)。

確認・修正:

1. EC2 → 該当インスタンス → Security タブで attach されている SG を確認
2. `gs-phase0-sg` 以外があれば: **Actions → Security → Change security groups** で `gs-phase0-sg` のみに置換
3. Launch Template から起動する際は **Network settings 確認画面で SG リストを必ず目視**

Phase 4 で Terraform 化する際に Network Interface 厳格指定で再発防止。

### ssh: connection refused / timed out

- Security Group の inbound に **現在の** 自宅 IP が入っているか
- インスタンス state が `running` か (`Status check 2/2 passed` を待つ)
- 自宅 IP が変わってないか (`https://checkip.amazonaws.com/`)
- 上記 Launch Template の SG 取り違えではないか

### startserver.sh で Java not found

- `java -version` が 25 を返すか
- corretto インストールに失敗した場合は手動で:
  ```bash
  dnf install -y java-25-amazon-corretto-headless
  # または Adoptium temurin
  ```

### サーバーが OOMKilled

- `dmesg | grep -i oom` で確認
- インスタンスタイプの RAM が足りていない → r7a.xlarge (32GB) に変更

### Spot 中断通知が来た

- IMDS で確認:
  ```bash
  TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
  curl -H "X-aws-ec2-metadata-token: $TOKEN" \
    http://169.254.169.254/latest/meta-data/spot/instance-action
  ```
- 2 分以内に `stop` → アンマウント → snapshot 作成
- 復元は Step 6.3 と同じ

### EBS マウント後にファイルが見えない

- フォーマット済みボリュームに `mkfs` を再実行していないか?
  - すでに使ったボリュームに `mkfs` するとデータ消える
  - **初回のみ** が鉄則
- `sudo file -s /dev/nvme1n1` で何のFSか確認

### 接続できるが TPS が低い

- view-distance / simulation-distance が 8 / 5 になっているか
- spark profiler で何処にCPU使ってるか確認

### `stop` を送ってもサーバーが再起動する / umount が target busy

ATM11 同梱の `startserver.sh` は MC プロセス終了後に再起動するラッパループ構造になっている。
tmux に `stop` を送っても MC が落ちた瞬間に `startserver.sh` が次のループで再起動する (Phase 0 トラブル #4)。

対処: tmux session ごと kill:

```bash
tmux kill-session -t mc
```

これで startserver.sh と java が SIGHUP で停止する。`umount /opt/atm11` が target busy になる場合も大抵これが原因。

注意: SSH 経由で `pkill -f "java"` を呼ぶ場合、コマンド文字列に "java" が含まれていると shell 自身も殺してしまうので避ける。tmux kill-session が最も安全。

---

## Phase 0 完了条件

- [ ] ATM11 サーバーが m7a.xlarge spot で起動した
- [ ] 5 分プレイで mspt と heap を計測した
- [ ] EBS snapshot から復元したサーバーで前回の続きを確認できた
- [ ] 計測結果を `docs/phase0-results.md` に記録した
- [ ] 後片付けが完了し、Cost Explorer で予期しない費用が無いことを確認した
- [ ] Phase 1 に進めるインスタンスタイプを確定した

完了したら `design.md` の **構築フェーズ計画 → Phase 0** の各チェックボックスを更新する。
