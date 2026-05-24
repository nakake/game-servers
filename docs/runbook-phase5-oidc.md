# Runbook: Phase 5 OIDC

Phase 5 (OIDC 化 + IAM policy tightening) の運用手順集。計画書は [docs/phase5-plan.md](phase5-plan.md)。

各セクションは独立して使えるように書いてある (ある時点だけ切り取って再現できる)。

---

## 0. cutover 前の事前確認 — `Env=prod` tag backfill

Phase 5 Step 2.5.1 で導入する新 `gs-worker-oidc-policy` は **全 resource 系 statement に `aws:ResourceTag/Env = "prod"` 条件を付ける**。tag 未付与の resource が 1 件でも残っていると、Worker は `/start` / `/stop` / cron で即時 AccessDenied を踏む。Step 2.5.1 の `terraform apply` 前に必ず本セクションの (1)〜(3) を完了させること。

将来 staging Worker (Step 4) を作る際は同じ手順を `Env=staging` 版で実行する。

### (1) 欠落検出

3 つの resource type を AWS CLI で列挙し、`Env` tag が無いものを抽出する。**PowerShell ではバックティック (`` ` ``) がエスケープとして解釈されるため、JMESPath は `not_null(Tags[?Key=='Env'].Value | [0])` 形式で書く** (`Tags[?Key=` ` `Env` ` `]` 形式は壊れる)。

```powershell
# EC2 instance
aws ec2 describe-instances `
  --filters "Name=tag:Project,Values=game-servers" `
  --query "Reservations[].Instances[?!not_null(Tags[?Key=='Env'].Value | [0])].InstanceId" `
  --output text

# EBS volume
aws ec2 describe-volumes `
  --filters "Name=tag:Project,Values=game-servers" `
  --query "Volumes[?!not_null(Tags[?Key=='Env'].Value | [0])].VolumeId" `
  --output text

# EBS snapshot (AMI 由来の snapshot も含む)
aws ec2 describe-snapshots --owner-ids self `
  --filters "Name=tag:Project,Values=game-servers" `
  --query "Snapshots[?!not_null(Tags[?Key=='Env'].Value | [0])].SnapshotId" `
  --output text
```

3 つすべての出力が **空** であることがゴール。1 つでも ID が返ってきたら (2) に進む。

### (2) 欠落 resource に `Env=prod` を backfill

```powershell
aws ec2 create-tags --resources <ID1> <ID2> ... --tags Key=Env,Value=prod
```

複数 ID をスペース区切りで渡せる。`describe-instances` / `describe-volumes` / `describe-snapshots` の各出力 ID を分けずに 1 コマンドで投入して構わない (全 ec2 resource で `ec2:CreateTags` は同じ API)。

### (3) 再確認 + 将来の new resource 担保

(1) のコマンドを再実行し、3 つすべての出力が空になっていることを確認する。

加えて、将来 `/start` / `/stop` / Packer build で **新規生成される resource にも `Env=prod` が自動付与される** ことを以下 4 箇所で担保している (2026-05-24 時点で対応済):

| 経路 | 場所 | 何が付くか |
|---|---|---|
| `/start` で起動する EC2 instance | `infra/envs/prod/compute.tf` `aws_launch_template.game_server` の `tag_specifications` (instance) + `workers/discord-handler/src/handlers/discord/start.ts` `instanceTags` | LT と Worker の双方で `Env=prod` を冗長に指定 (RunInstances の TagSpecification は LT を上書きするため Worker 側必須) |
| `/start` で attach される EBS data volume | LT `tag_specifications` (volume) + start.ts `volumeTags` | 同上 |
| `/stop` で作成される EBS snapshot | `workers/discord-handler/src/handlers/stop-workflow.ts` `createSnapshot` の `tags` map | `Env=prod` 含む |
| Packer build で作成される AMI snapshot / 一時 builder EC2 / volume | `ami/game-server.pkr.hcl` の `snapshot_tags` / `run_tags` / `run_volume_tags` | AMI 本体 (`tags`) と分離して必ず明示する。次回 `pnpm build-sidecar-ami` から有効 |

これら 4 箇所のうち 1 箇所でも `Env` 指定が抜けると、新 resource が policy 条件から外れて Worker から見えなくなる。コード review 時の確認ポイントとして CLAUDE.md / phase5-plan に追記推奨。

### 過去対応履歴

- **2026-05-24**: Step 2.5.0 初回実施。既存 snapshot 4 件 (`snap-06e434398fafc82d6` / `snap-0ea1b9f2b2642acdd` / `snap-0dfd4494f5e2b88b3` / `snap-033f6fa6ea246eecb`) に `Env=prod` を backfill。EC2 / volume は当時ゼロ件のため backfill 不要。同日 Worker (`start.ts` `volumeTags` / `stop-workflow.ts` snapshot tags) と Packer (`game-server.pkr.hcl` `snapshot_tags` / `run_tags` / `run_volume_tags`) のコードにも `Env=prod` 自動付与を追加。

---

## 1. 定期 rotation (半期に 1 回、無停止)

OIDC private key を 6 ヶ月毎に rotate する手順。Worker は multi-kid 並走対応なので新旧両方の鍵が JWKS endpoint で公開されている期間に AWS STS が新 kid を受け入れる経路で無停止 rotate できる。

```powershell
cd F:\project\game_servers

# 1. 既存の secret 値をローカルに dump (ローカルファイルは rotation 後に削除)
# wrangler secret は read 不可なので、初回投入時の出力を保存していない場合は --fresh で完全置換しか出来ない。
# multi-kid 並走で rotate するなら、初回 secret put の stdout を保管しておくのが運用上重要。
# (運用見直し: scripts/generate-oidc-keypair.mjs --rotate を未来の secret put 時の input から取る方が安全)

# 2. 新鍵を末尾追加 (既存配列に append、新鍵が現用、旧鍵は JWKS に残り検証可能)
node scripts/generate-oidc-keypair.mjs --rotate < .secrets/oidc-private-keys.json > .secrets/oidc-private-keys-new.json
# scripts/generate-oidc-keypair.mjs の stdout は更新後の JWK 配列、stderr に投入手順

# 3. 新配列を Workers Secret に投入
Get-Content .secrets/oidc-private-keys-new.json | pnpm wrangler secret put OIDC_PRIVATE_KEYS_JWK
# secret put は値を全置換するため、新旧両 kid を含んだ配列を 1 度の操作で投入する

# 4. JWKS endpoint に両 kid が出ることを確認
curl -s https://discord-handler.<your-account>.workers.dev/oidc/.well-known/jwks.json | python -m json.tool
# 期待: keys 配列に 2 件、両方の kid が含まれる

# 5. 最低 90 秒待機 (= JWT exp 60s + clock skew 30s)。それより短いと旧 kid 発行 JWT で STS 中の
#    in-flight session が「削除直後」を踏む race を生む。STS の JWKS cache は新 kid を取り込む側
#    なので 24h 待機は不要。
Start-Sleep -Seconds 90

# 6. 24h 観察 (任意): wrangler tail で STS が新 kid で AssumeRole 成功することを確認
#    通常 cron 経路だけで 24h 経つと数十回新 kid 利用される

# 7. 旧 kid 削除
node scripts/generate-oidc-keypair.mjs --remove-old < .secrets/oidc-private-keys-new.json > .secrets/oidc-private-keys-final.json
Get-Content .secrets/oidc-private-keys-final.json | pnpm wrangler secret put OIDC_PRIVATE_KEYS_JWK

# 8. ローカル中間ファイル削除 (.secrets/ は gitignore 済だがディスク上に残さない)
Remove-Item .secrets/oidc-private-keys-new.json, .secrets/oidc-private-keys-final.json
```

**注意**: `.secrets/oidc-private-keys.json` を恒常保持するかは運用判断。保持すれば rotation 操作が楽だが漏洩リスクが上がる。**推奨**: rotation 時に `--fresh` で完全新規生成 + 24h grace 経て旧キーは破棄 (= worker-secret-read-via-trust-policy memory の方針)。

---

## 2. 緊急 rotation (private key 漏洩疑い時、復旧 5〜10 分)

`OIDC_PRIVATE_KEYS_JWK` の漏洩疑いが出たら、**AWS 側 sub condition を無効値に上書きして全 in-flight session を即時無効化**する (方式 A、決定 16 第一選択)。

```powershell
cd F:\project\game_servers

# 1. AWS trust policy の sub condition を到達不能値に上書き (= 漏洩鍵で生成した JWT も assume 不可)
$revoked = "REVOKED-" + (Get-Date -Format 'yyyyMMddTHHmmssZ')
.\infra\tf.ps1 apply -auto-approve "-var=worker_oidc_sub=$revoked"
# apply 完了の瞬間に全 in-flight session が無効化される (dependency 連鎖なし、apply 1 回で完結)

# 2. ローカルで新鍵生成 (旧鍵は完全廃棄、--fresh で配列ごと置換)
node scripts/generate-oidc-keypair.mjs --fresh > .secrets/oidc-private-keys-emergency.json

# 3. 新 sub 値を生成
$newSub = "discord-handler-" + (-join ((48..57) + (97..122) | Get-Random -Count 8 | ForEach-Object {[char]$_}))

# 4. Worker secret に新鍵 + 新 sub を投入
Get-Content .secrets/oidc-private-keys-emergency.json | pnpm wrangler secret put OIDC_PRIVATE_KEYS_JWK
echo $newSub | pnpm wrangler secret put OIDC_SUB

# 5. AWS trust policy の sub を新値に戻す
.\infra\tf.ps1 apply -auto-approve "-var=worker_oidc_sub=$newSub"

# 6. Worker deploy (secret 反映には deploy 不要、ただし念のため)
cd workers\discord-handler; pnpm wrangler deploy; cd ..\..

# 7. Discord で /status 動作確認
# 8. ローカル中間ファイル削除
Remove-Item .secrets/oidc-private-keys-emergency.json
```

**復旧見込み**: 5〜10 min (apply 2 回 + secret put 2 回 + deploy 1 回)。role ARN 不変なので `wrangler.toml` 編集不要。

**代替: 方式 B (role 削除 + 再構築)** は dependency 連鎖 (`DeleteConflict`) を踏むので非推奨。実装するなら事前に `aws iam detach-role-policy --role-name gs-worker-oidc-role --policy-arn arn:aws:iam::123456789012:policy/gs-worker-oidc-policy` で attachment を AWS CLI 経由で剥がしてから terraform destroy → 再 apply → 再 attachment。復旧見込み 10〜15min。

---

## 3. JWKS thumbprint 検証 (半期に 1 回任意)

AWS は 2023 年以降 JWKS 直接検証が主経路だが、provider 作成時に登録した SHA-1 thumbprint がフォールバック検証で使われる可能性がある。Cloudflare TLS cert が rotation すると thumbprint が変わるので半期に 1 回確認。

```powershell
cd F:\project\game_servers

# 1. 現状の Cloudflare TLS cert thumbprint 取得
.\scripts\get-cf-thumbprint.ps1 discord-handler.<your-account>.workers.dev
# 出力: 2 件の SHA-1 fingerprint (intermediate + leaf)

# 2. AWS 側に登録されている thumbprint 取得
$providerArn = (aws iam list-open-id-connect-providers --query "OpenIDConnectProviderList[?contains(Arn, 'discord-handler')].Arn | [0]" --output text)
aws iam get-open-id-connect-provider --open-id-connect-provider-arn $providerArn --query 'ThumbprintList' --output json

# 3. 差分があれば terraform で更新
# `infra/envs/prod/terraform.tfvars` の worker_oidc_thumbprints を新値に編集
.\infra\tf.ps1 plan -out=thumbprint-rotate.tfplan
.\infra\tf.ps1 apply thumbprint-rotate.tfplan
```

**自動監視は無し** (Worker fetch() は TLS cert の thumbprint を expose しないため Worker 内で検証不可)。代わりに Step 3 の **STS failure sentinel** (`oidc-credential-fail` Discord 通知) が thumbprint mismatch を含む全 OIDC 異常を 1h 1 回まで通知する経路で事後検出を担う。

---

## 4. DoS 兆候時の Workers Rate Limiting API 導入

`/oidc/.well-known/*` への DoS 兆候が出たら以下を実装。**主防御は edge cache (`s-maxage=86400`)** でオリジン到達抑制、二次防御は本 Phase では未設定 (Phase 5 計画書 決定: `*.workers.dev` には zone WAF 適用不可)。

```toml
# wrangler.toml に追加
[[unsafe.bindings]]
type = "ratelimit"
name = "OIDC_RATE_LIMITER"
namespace_id = "<assign at apply>"
simple = { limit = 100, period = 60 }   # IP あたり 60s で 100 req
```

```typescript
// src/index.ts の oidc route 前に挿入
if (url.pathname.startsWith('/oidc/.well-known/')) {
  const clientIp = request.headers.get('cf-connecting-ip') ?? 'unknown';
  // AWS STS の発信 IP allowlist (AWS の ip-ranges.json から AMAZON_STS を抽出)
  if (!STS_IP_ALLOWLIST.includes(clientIp)) {
    const { success } = await env.OIDC_RATE_LIMITER.limit({ key: clientIp });
    if (!success) return new Response('rate limited', { status: 429 });
  }
}
```

**実装着手時は AWS の STS 発信 IP がドキュメント化されているか再確認が必要** (現在は AWS の ip-ranges.json の `AMAZON` / `EC2` を粗く allowlist する形で運用)。

---

## 5. rollback (Step 7 削除前のみ有効)

Phase 5 cutover が完了した状態 (= Step 7.4 IAM user 削除済) では rollback は不可。手動で IAM user + Access Key 再発行 + Worker secret 再投入 + コード revert の 1h コース (= 緊急対応として実質「再構築」)。

Step 7 完了前なら以下で static 経路に即時復帰できる:

```powershell
# wrangler.toml の AWS_AUTH_MODE 行をコメントアウト
# (`# AWS_AUTH_MODE = "oidc"` にする)
cd F:\project\game_servers\workers\discord-handler
pnpm wrangler deploy
# 旧 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY secret はまだ存在するので static 経路がそのまま動く
```
