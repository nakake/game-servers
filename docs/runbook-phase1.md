# Runbook — Phase 1 実機検証

最終更新: 2026-05-17

## このドキュメントについて

Phase 1 で組んだ「Worker → SSM Run Command → EC2 上で `docker stop`」のフルパスを **実 AWS で動かす** ための手順書。

ゴール:

- [ ] 最小権限 IAM ユーザー `gs-worker-caller` を作成し、Access Key を Worker `.dev.vars` に投入
- [ ] EC2 IAM role `gs-phase0-ec2-role` に `AmazonSSMManagedInstanceCore` を追加
- [ ] r7a.large spot を `Project=game-servers` タグ付きで起動
- [ ] nginx container で SSM 経路の smoke test (`docker stop nginx` を Worker から発火)
- [ ] ATM11 を同じ EC2 で動かし、Worker から graceful stop が走ることを確認
- [ ] 後片付け (EC2 terminate、EBS snapshot 残置 → 削除)

所要時間: 2〜3 時間 (待ち時間含む)。費用見込み: ¥100 以下。

参照: [ADR 0002](adr/0002-mc-stop-flow-docker-ssm.md), [docs/design.md](design.md), Phase 0 [runbook.md](runbook.md), [phase0-results.md](phase0-results.md)

---

## 前提

- Phase 0 が完了している (Launch Template `gs-phase0-lt`, IAM role `gs-phase0-ec2-role`, Security Group `gs-phase0-sg`, Key Pair `gs-phase0-key` が AWS に存在)
- `pnpm install` + `pnpm typecheck` がローカルで通る (Task #6, #8 完了)
- Docker Desktop でローカル Worker (`pnpm dev`) が動く

---

## Step 1: IAM ユーザー `gs-worker-caller` を作成

Worker から AWS API を叩くための最小権限ユーザー。Phase 2 で OIDC 化するまでの繋ぎ。

### 1.1 ユーザー作成

1. AWS Console → **IAM → Users → Create user**
2. User name: `gs-worker-caller`
3. **Provide user access to the AWS Management Console** はチェック外す (CLI/API のみ)
4. **Next**

### 1.2 Permissions

1. **Attach policies directly** を選択
2. **Create policy** (右上、新タブで開く):
   - JSON タブを選択
   - 以下を貼り付け:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SsmSendCommandToTaggedInstances",
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": "arn:aws:ec2:ap-northeast-1:*:instance/*",
      "Condition": {
        "StringEquals": {
          "aws:ResourceTag/Project": "game-servers"
        }
      }
    },
    {
      "Sid": "SsmSendCommandWithDocument",
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": "arn:aws:ssm:ap-northeast-1::document/AWS-RunShellScript"
    },
    {
      "Sid": "SsmGetCommandInvocation",
      "Effect": "Allow",
      "Action": "ssm:GetCommandInvocation",
      "Resource": "*"
    }
  ]
}
```

3. **Next** → Name: `gs-worker-caller-policy` → **Create policy**
4. ユーザー作成タブに戻り、Refresh → `gs-worker-caller-policy` を選択 → **Next** → **Create user**

### 1.3 Access Key 発行

1. 作成した `gs-worker-caller` を開く → **Security credentials** タブ
2. **Create access key** → Use case: **Application running outside AWS** → **Next** → **Create**
3. **Access key ID** と **Secret access key** を控える (Secret はこの画面でしか表示されない)

### 1.4 `.dev.vars` に投入

```powershell
cd F:\project\game_servers\workers\discord-handler
Copy-Item .dev.vars.example .dev.vars
# .dev.vars を開いて AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, ADMIN_API_KEY を埋める
```

---

## Step 2: EC2 IAM role に SSM 権限を追加

SSM agent が AWS と通信して Run Command を受け取れるようにする。

1. AWS Console → **IAM → Roles → gs-phase0-ec2-role**
2. **Add permissions → Attach policies**
3. **AmazonSSMManagedInstanceCore** を選択 → **Add permissions**

> Phase 0 で付けた `AmazonS3ReadOnlyAccess` はそのまま残す (将来の config sync で使う)。

---

## Step 3: EC2 起動 (r7a.large spot, `Project=game-servers` タグ)

### 3.1 Launch Template から起動

1. EC2 → **Launch Templates → gs-phase0-lt** を選択 → **Actions → Launch instance from template**
2. **Instance type override**: `r7a.large` に変更 (Phase 0 計測結果で確定した第一候補)
3. **Tags** セクションで Resource tags に以下を追加 (Phase 0 のタグに加えて):
   - Key: `Project`, Value: `game-servers` ★ **これがないと Worker の IAM Condition で弾かれる**
   - Key: `Env`, Value: `phase1`
4. **Launch instance**

### 3.2 起動確認

1. Instances → 起動したインスタンスが `Running` + `2/2 checks passed` まで待つ
2. **Public IPv4 DNS** をメモ
3. SSH 疎通:

```powershell
$IP = "13.158.47.122"
$KEY = "F:\project\game_servers\.secrets\gs-phase0-key.pem"
ssh -i $KEY ec2-user@$IP
```

### 3.3 SSM agent 接続確認

EC2 上で:

```bash
sudo systemctl status amazon-ssm-agent
# active (running) が出ること
```

AWS Console から:

1. **Systems Manager → Fleet Manager** (or **Compliance**) → Managed instances に該当インスタンスが出ていること
2. 出ない場合は IAM role への AmazonSSMManagedInstanceCore アタッチ漏れ。Step 2 を再確認 → インスタンス再起動

### 3.4 Instance ID をメモ

EC2 Console で確認した **Instance ID** (`i-0xxxxxxxxxxx`) を控える。後で `/admin/docker-stop` の body に使う。

---

## Step 4: SSM 経路 smoke test (nginx)

ATM11 を立ち上げる前に、**Worker → SSM → EC2 → docker stop** の最小経路を nginx で確認する。失敗時に切り分けやすい。

### 4.1 EC2 上で nginx を起動

```bash
docker run -d --name nginx -p 8080:80 nginx:alpine
docker ps
# nginx container が Up になっていること
```

### 4.2 Worker をローカル起動

別ターミナル (ローカル PC):

```powershell
cd F:\project\game_servers\workers\discord-handler
pnpm dev
# http://localhost:8787 で listen
```

### 4.3 Worker から docker stop を発火

別ターミナル (ローカル PC) で:

```powershell
$INSTANCE_ID = "i-0xxxxxxxxxxx"
$ADMIN_KEY = "<.dev.vars に入れた ADMIN_API_KEY と同じ値>"

curl.exe -X POST http://localhost:8787/admin/docker-stop `
  -H "authorization: Bearer $ADMIN_KEY" `
  -H "content-type: application/json" `
  -d "{`"instanceId`":`"$INSTANCE_ID`",`"containerName`":`"nginx`",`"graceSeconds`":10}"
```

期待する response:

```json
{
  "commandId": "...",
  "status": "Success",
  "responseCode": 0,
  "stdout": "nginx\n",
  "stderr": ""
}
```

`status: "Success"` + `responseCode: 0` であれば SSM 経路は OK。

EC2 上で確認:

```bash
docker ps -a | grep nginx
# Exited (137) で停止していること (nginx は SIGTERM で 137 になる)
```

### 4.4 nginx を片付け

```bash
docker rm nginx
```

---

## Step 5: ATM11 を EC2 で動かす

### 5.1 ATM11 ディレクトリを EC2 に転送

**選択 A: Phase 0 の EBS snapshot が残っていれば復元**

1. EC2 → **EBS → Snapshots** で Phase 0 で取った `phase0 verification snapshot` を確認
2. 残っていれば: **Actions → Create volume from snapshot** → AZ=ap-northeast-1a, gp3 30GiB → **Create**
3. Volume → **Attach volume** → 上で起動した EC2 → Device: `/dev/sdf`
4. EC2 上で:

```bash
sudo mkdir -p /opt/atm11
sudo mount /dev/nvme1n1 /opt/atm11
sudo chown -R ec2-user:ec2-user /opt/atm11
ls /opt/atm11  # mods/, libraries/, etc. が見えること
```

**選択 B: snapshot がなければローカルから tar 転送**

ローカル PC で (PowerShell):

```powershell
cd F:\Games\minecraft\ATM
tar -czf atm11.tar.gz ATM11
scp -i F:\project\game_servers\.secrets\gs-phase0-key.pem atm11.tar.gz ec2-user@${IP}:/tmp/
```

EC2 上で:

```bash
sudo mkdir -p /opt/atm11
sudo chown ec2-user:ec2-user /opt/atm11
cd /opt/atm11
tar -xzf /tmp/atm11.tar.gz --strip-components=1
ls   # mods/, libraries/, etc. が見えること
rm /tmp/atm11.tar.gz
```

### 5.2 Dockerfile 一式を EC2 に転送

ローカル PC で:

```powershell
scp -i F:\project\game_servers\.secrets\gs-phase0-key.pem -r `
  F:\project\game_servers\launcher\images\atm11 `
  ec2-user@${IP}:/home/ec2-user/
```

### 5.3 EC2 上で .env を作成して docker compose up

```bash
cd /home/ec2-user/atm11
cp .env.example .env
# .env を編集:
#   RCON_PASSWORD=<.dev.vars と無関係な値、ローカル検証用>
#   ATM11_DATA_DIR=/opt/atm11
nano .env

docker compose up -d --build
# 初回 build は image pull + mcrcon ダウンロードで 1〜2 分
# 起動完了は docker logs で確認

docker logs -f atm11
# "Done (XX.XXXs)! For help, type "help"" まで待つ (初回はかなり時間がかかる、libraries 初回ロード)
```

### 5.4 (任意) Minecraft クライアントから接続

セキュリティグループ `gs-phase0-sg` に 25565/tcp が空いていることを Phase 0 で確認済み。

```
Direct Connect: <EC2 public IP>:25565
```

数分プレイして world data に変化を加える (graceful stop で save されることを後で確認する用)。

---

## Step 6: Worker から ATM11 graceful stop 検証

```powershell
$INSTANCE_ID = "i-0xxxxxxxxxxx"
$ADMIN_KEY = "<.dev.vars の ADMIN_API_KEY>"

curl.exe -X POST http://localhost:8787/admin/docker-stop `
  -H "authorization: Bearer $ADMIN_KEY" `
  -H "content-type: application/json" `
  -d "{`"instanceId`":`"$INSTANCE_ID`",`"containerName`":`"atm11`",`"graceSeconds`":60}"
```

期待: 60 秒前後で `status: "Success"`、`stdout: "atm11\n"` (docker stop が返した container name)。

EC2 上で確認:

```bash
docker ps -a | grep atm11
# Exited (143) になっていること (SIGTERM → rcon save-all → stop で graceful 終了、143 は ADR 0002 の通り cosmetic)

docker logs atm11 | tail -50
# [entrypoint] SIGTERM/SIGINT received, ...
# [entrypoint] shutdown complete
# が出ていること
```

### 6.1 World データ破損確認

```bash
docker compose up -d
docker logs -f atm11
# 再起動成功
```

Minecraft クライアントから再接続し、Step 5.4 で加えた変化 (ブロック設置等) が残っていること。

---

## Step 7: 後片付け

```bash
# EC2 上
docker compose down
sudo umount /opt/atm11  # EBS マウントしている場合
```

AWS Console で:

1. EC2 → 起動したインスタンスを **Terminate**
2. EBS Volume を **Delete** (snapshot 復元したものは即削除、Phase 0 オリジナルの snapshot は保持)
3. 念のため EBS Snapshot 一覧で **Phase 1 で増えたものがないこと** を確認
4. AWS Billing → Cost Explorer で当日の支出が ¥200 以下であること

---

## Troubleshoot

### `/admin/docker-stop` が 500 (`phase: "send"`)

- error message に `UnauthorizedOperation` が含まれる → IAM policy の Condition (`aws:ResourceTag/Project=game-servers`) でブロック。EC2 のタグを Step 3.1 のとおり付与しているか確認
- error message に `InvalidInstanceId` → EC2 の SSM agent が AWS と通信できていない。Step 2 (IAM role に AmazonSSMManagedInstanceCore) と Step 3.3 (Fleet Manager で managed 表示) を確認
- error message に `SignatureDoesNotMatch` → Access Key の secret が正しくコピーできていない、または時計ずれ

### `status: "Failed"` + `stderr: "permission denied"`

- SSM agent は root で動くので docker socket への権限は問題ないはず
- 念のため EC2 上で `sudo docker ps` が動くか確認

### `status: "Failed"` + `stderr: "No such container"`

- container 名が違う。`docker ps -a` で実際の名前を確認 (`atm11` か `nginx` か)

### waitForCommand timeout

- `graceSeconds` を増やす (ATM11 の save-all が想定外に長い場合)
- `docker logs atm11` で何で詰まっているか確認

### EC2 上で `docker compose up` が `Cannot connect to the Docker daemon`

- Phase 0 user-data で `systemctl enable --now docker` が走るが、たまに反映待ち
- `sudo systemctl restart docker` + `sudo usermod -aG docker ec2-user` → 一度 logout/login で解消

---

## Phase 1 着地後の次タスク

このフルパスが通れば、Phase 1 の停止経路は完成。次は:

- [ ] `lib/aws/ec2.ts` (EC2 RunInstances / DescribeInstances / TerminateInstances)
- [ ] `lib/aws/ebs.ts` (CreateSnapshot)
- [ ] Discord interaction endpoint (ed25519 検証 + PING/PONG)
- [ ] `/start atm11` ハードコード版で EC2 起動 → DNS 更新 → 完了通知
- [ ] `/aws/notification` (SNS → Discord) + Budget alert 切替

`/admin/docker-stop` は Phase 2 で Discord 経由 `/stop` に置き換わったら削除する。
