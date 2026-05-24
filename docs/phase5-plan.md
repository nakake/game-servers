# Phase 5 実装計画 — OIDC 化 + IAM policy tightening

最終更新: 2026-05-24 (rev6: Step 2 apply + AWS CLI 検証完了。AWS の OIDC custom provider trust policy は `aud` / `sub` の 2 つしか condition key として expose しないため、当初設計の `iss` / `jti` 多層防御を削除し、aud + sub のみで構築。jti replay 防御は Worker 側 KV self-defense に一元化)

## このドキュメントについて

`docs/design.md` §10 **Phase 5: OIDC 化 (公開前推奨)** を実行するための計画。Phase 1〜4 を通じて
Worker は **長期 IAM Access Key** (`gs-worker-caller` の AKIA キー) を Workers Secrets に保持して
EC2 / EBS / SSM を叩いてきた。公開前にこれを排除し、Worker → AWS の認証経路を
**短期 STS credentials (15min)** に置換する。

セキュリティレビューの結果、OIDC 化単独では「Workers Secret 漏洩リスクは等価」であることが判明したため、
**既存 IAM policy の wildcard 権限縮小 (least privilege 化) を同 Phase で同時実施** する方針に拡張した
(レビュー指摘 D)。

> **進捗 (2026-05-24)**: rev1 起案、未着手。**公開前必須**。

## 関連ドキュメント

- [docs/design.md](design.md) §4.4 (認証マトリクス) / §5.6 (IAM) / §9 (セキュリティ) / §10 Phase 5
- [docs/iac-migration-plan.md](iac-migration-plan.md) — `gs-worker-caller` は IaC 管理下、Access Key だけ管理外
- `infra/envs/prod/iam.tf` L70-162 — 既存 IAM user / policy 定義 (wildcard Resource = "*" 含む)
- `workers/discord-handler/src/lib/aws/client.ts` — aws4fetch ラッパ (`sessionToken` 受け入れ済)
- `workers/discord-handler/src/env.ts` — Worker env 型定義

## 0. Threat Model

明文化されていないと「OIDC 化 = 安全」と誤読されるため、本 Phase の脅威モデルをここに固定する。

### 攻撃者モデル

| ID | 攻撃者 | 入手物 |
|---|---|---|
| **(a)** | Cloudflare account compromise | Workers Secret 全件 read 権限 + Worker code 書換 |
| **(b)** | Worker repo / `wrangler.toml` の read 漏洩 | Git 履歴・設定ファイル (Secret は含まれない) |
| **(c)** | 公開 endpoint アクセス可能な第三者 | 全インターネット |

### Phase 5 で下がる脅威 / 下がらない脅威

| 攻撃者 | Phase 5 前 | Phase 5 後 | 差分 |
|---|---|---|---|
| (a) | 長期 Access Key 漏洩 = 永続フル access | OIDC private key 漏洩 = **任意 sub/aud で JWT 発行 = 永続フル access (実質等価)** | **下がらない**。private key は新たな高価値 secret |
| (b) | 通常 wrangler.toml に AKIA は書かないが、`.dev.vars` 等で混入リスクあり | 設定ファイルに長期 secret が **構造上書けない** (JWKS は public のみ、role ARN は条件突破不能) | **下がる** |
| (c) | DoS 程度 (Discord ハンドラの認証で守られる) | DoS 程度 (JWKS は public 鍵のみ、role ARN を入手しても sub/aud condition で守られる) | **横這い** (JWKS DoS は新たな表面、後述で対策) |

### Phase 5 の真の価値

1. **攻撃面 (a) を本質的に下げるには IAM policy の least privilege 化が必須** (= Step 2.5 を組込み)。policy が wildcard `Resource = "*"` のままだと、private key 漏洩時に cryptojacking amplification を許す
2. **攻撃面 (b) の漏洩窓を 24h+ → 15min** (STS session) に圧縮。Workers Secret に長期キーを置かなくて済む
3. **手動 IAM Access Key ローテーション運用 (年 1 回程度) が不要** になる。代わりに OIDC private key の rotation 運用が入る (Step 8)

要するに **「OIDC 化 + policy tightening」を 1 セットで完了させて初めて公開前セキュリティ要件達成**。OIDC 化単独はマイナーな改善に過ぎない。

---

## ゴール

> **Workers Secrets から `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` を完全に排除**し、Worker は OIDC JWT 経由で
> **15 分有効の一時 credentials** でのみ AWS API を呼ぶ。さらに **IAM policy の wildcard 権限を tags / Launch Template
> 条件で縛り**、credentials が万一漏洩しても任意 EC2 起動 (cryptojacking amplification) ができない状態にする。

成功基準:
1. ATM11 で `/start` `/stop` `/status` `/list` が長期 Access Key 無しで成功
2. Cron Trigger 経由の `snapshot-retention` / `cleanup` / `idle-fallback` が同じく成功
3. `gs-worker-caller` IAM user の Access Key と user 自体が AWS から削除されている
4. 新 `gs-worker-oidc-role` の policy 全 statement が tag / Launch Template / instance type を条件にして wildcard を持たない (`PassEc2InstanceRole` / `SsmGetCommandInvocation` 等やむを得ない場合を除き条件説明をコメントで残す)
5. 鍵 rotation runbook (定期 + 緊急) が `docs/runbook-phase5-oidc.md` に存在

## スコープ

Phase 5 で **やる** (公開前必須):

| ID | 項目 |
|---|---|
| **A** | Worker を OIDC issuer 化 (RS256 JWT + multi-kid 並走可能な JWKS + discovery doc) |
| **B** | AWS IAM OIDC provider + AssumeRole 用 Role を Terraform module 化 (trust policy に iss/aud/sub/jti 多層条件) |
| **C** | **既存 wildcard policy の tightening** (新 `gs-worker-oidc-policy` を tag / LT 条件付きで作る) |
| **D** | Worker AWS credential provider (STS AssumeRoleWithWebIdentity + KV cache + in-flight dedup) |
| **E** | Staging Worker (`[env.staging]`) のセットアップと受入テスト |
| **F** | 全 7 callsite を credential provider 経由に統一 |
| **G** | 段階移行 (`AWS_AUTH_MODE` vars) → 本番 cutover → 2-3 日観察 → 旧 Access Key 24h で即削除 |
| **H** | 鍵 rotation runbook (定期 + 緊急) と docs / メモ更新 |

Phase 5 で **やらない** (持ち越し):

- **Cloudflare DNS API Token の OIDC 化**: Cloudflare 同士で循環参照になりやすい。Zone:DNS:Edit 限定で実害が小さい
- **sidecar HMAC 共有秘密の OIDC 化**: sidecar は EC2 instance role + SSM 経由なので Worker Secrets の問題外
- **Discord public key / webhook URL**: 用途が認証ではなく署名検証 / write-only
- **EC2 instance role (`gs-phase0-ec2-role`)**: もともと AssumeRole ベース、対象外
- **独自ドメイン化**: `*.workers.dev` 固定 (issuer URL 変更は OIDC provider 再作成必要、Phase 6 以降の課題)
- **`PassEc2InstanceRole` / `SsmGetCommandInvocation` の resource 絞込**: `iam:PassRole` は対象 role ARN で既に絞られている、`SsmGetCommandInvocation` は SendCommand 直後の状態確認用で wildcard 必須

## 決定事項 (rev1 起案、レビュー反映後)

- **決定1: OIDC issuer は Worker 自身が担う** (Worker-as-issuer)。Roles Anywhere は X.509 + CA で運用負荷が高く却下。「キー自動ローテ案」(Cron で 24h 毎に IAM Access Key を rotate) はレビューで検討候補に挙がったが、**漏洩窓を 24h まで圧縮しても本 Phase の威力 (= JWKS で webhook 攻撃面を構造的に消す) は得られない**ため不採用
- **決定2: 署名鍵は RS256 (RSA-2048)**。AWS IAM OIDC は ES256 サポート状況が現時点で限定的 (2026-05 確認、AWS docs URL を runbook 末尾に残す)。RS256 で確実に動かす方針
- **決定3: STS session duration は 15 分** (rev1 で 1h → 15min に短縮)。Cron は 5min 毎なので credentials 1 個で 3 周期使い回せて十分、漏洩窓を 4 倍圧縮。**注: IAM Role の `max_session_duration` は AWS API 制約で最小 3600 (1h) のため role 側は 3600 で作成、実際の 15min 縛りは STS 呼び出し時の `DurationSeconds` パラメータで指定する** (rev5 で判明)
- **決定4: KV cache TTL = `(expiration - 60s) - Math.random() * 30s`** (負方向 jitter のみ、= より早く再取得する側に振る)。cron の足並みを揃えないため分散させるが、**正方向に振ると cache から expiration 60s 未満の credentials を返す race を生む**ため不採用
- **決定5: Trust policy の condition は aud + sub のみ** (rev6 で iss / jti 削除)。AWS の OIDC custom provider は `<provider>:aud` と `<provider>:sub` の 2 つしか condition key として expose しない (`<provider>:iss` / `<provider>:jti` は null 比較で AccessDenied を引き起こす)。iss は AWS が provider URL 一致を暗黙的に検証、jti replay 防御は Worker 側 KV TTL self-defense (Step 3) に一元化
- **決定6: `AWS_AUTH_MODE` は `[vars]` (secret ではない)**。レビューで指摘された計画内矛盾を解消。`wrangler.toml [vars]` に書き、deploy で反映 / rollback。一方 **`OIDC_SUB` は Workers Secret に置く** (決定13)。`AWS_OIDC_ROLE_ARN` は vars でよい (漏れても sub/aud condition で守られる)
- **決定7: issuer URL は `*.workers.dev` のまま**。独自ドメインは Phase 6 以降
- **決定8: 鍵は配列管理 (`OIDC_PRIVATE_KEYS_JWK`)、`kid` ベースの multi-kid 並走 OK**。rotation 時の重要要件 (Step 8)
- **決定9: Rollback は 24h 観察で Access Key 即削除 + Secret 削除** (1 週間 Inactive 維持は不採用)。レビュー指摘 H により、Inactive 期間中の mode 切替で long-key が再活性化する穴を塞ぐ。rollback したい場合は「新 Access Key 発行 + Secret 再投入」の手動 1h コース
- **決定10: IAM policy tightening を Phase 5 内で同時実施** (Step 2.5)。`Ec2RunStopSnapshot` の wildcard を tag / LT / instance type 条件で縛る。新 `gs-worker-oidc-policy` として作り、旧 user policy は Step 7 で剥がす
- **決定11: Staging Worker (`[env.staging]`) を Step 4 で立てる**。本番一発 cutover はリスクが高い、別 Worker subdomain で受入テスト。**staging には専用 policy `gs-worker-oidc-staging-policy` を別途作成し、`aws:ResourceTag/Env = "staging"` 条件で本番 resource (`Env = "prod"` タグ付き) へのアクセスを構造的に遮断**。同一 policy attach は禁止 (staging から本番 EC2 を terminate できてしまう)
- **決定12: STS は regional endpoint** (`sts.ap-northeast-1.amazonaws.com`) を使う。グローバル endpoint は us-east-1 ルーティングで latency / 可用性が劣る
- **決定13: `sub = "discord-handler-<8 文字 random>"`** + **`OIDC_SUB` は Workers Secret (vars ではない)**。vars だと `wrangler.toml` read 権限 (= 攻撃者 (b)) で漏れて enumeration 緩和効果が消える。trust policy condition は完全一致なので推測困難な値を Secret に保管することで多層防御
- **決定14: `signOidcToken` は internal-only**、HTTP route として絶対に expose しない。`src/index.ts` の route 追加時 lint で `/oidc/.well-known/*` 以外を作らないことをチェック (runbook)
- **決定15: STS エラーは `code` のみ抽出**、原文 body を Discord 通知に流さない。AccessDenied レスポンスに ARN がエコーされるため
- **決定16: 緊急 rotation は 2 方式併記、方式 A (sub condition を `REVOKED` に上書きする apply 1 回) が第一選択、方式 B (role 一時削除 + 再構築) は代替**。rev2 で role 削除方式を採用したが、再レビューで dependency 連鎖 (`DeleteConflict`) リスクと apply 1 回方式の存在が判明。**方式 A は apply 1 回で全 in-flight session 即時無効化 + dependency 連鎖なし** (Step 8 に詳細)
- **決定17: Step 7 の旧 Access Key 廃止は「Worker Secret 削除 → static 経路コード commit + deploy → AWS Access Key 削除 → IAM user 削除」の時系列固定**。順序が崩れると「mode=static のままコード復活」rollback の整合性が壊れる。各操作の間に 24h 観察は挟まない (cutover 後 24h 観察 1 回で完了させる)

## 全体方針 / フロー

```
[Worker]                                       [AWS]
  |  (1) KV cache miss or expired                |
  |      in-flight Promise dedup チェック          |
  |  (2) Multi-kid から現用 (最新 iat) を選択      |
  |  (3) JWT 署名:                                |
  |      iss = https://<worker>/oidc             |
  |      sub = discord-handler-<8char>           |
  |      aud = sts.amazonaws.com                 |
  |      jti = UUID v4                           |
  |      iat = now, nbf = now, exp = now + 60s   |
  |  (4) jti を KV oidc-jti:<jti> に TTL=70s で put|
  |  (5) STS AssumeRoleWithWebIdentity ----->  [STS ap-northeast-1]
  |      RoleArn = gs-worker-oidc-role             |   ↓ JWKS verify
  |      Duration = 900s                           |   GET https://<worker>/oidc/.well-known/jwks.json
  |      SessionName = oidc-<short-jti>            |   ↓ (s-maxage=86400 でedge cache)
  |  <-- 一時 credentials (AKIA+, secret,        |
  |      sessionToken, exp = now+15min)          |
  |  (6) KV aws-creds:cache に put                |
  |      TTL = (expiration - 60s) - jitter(0-30s)|
  |  (7) AwsApiClient(credentials) で AWS API
```

実装順:
1. **OIDC 発行側を先に作り単体テスト** (Step 1)
2. **issuer URL を確定するため空 route 付き先行 deploy** (Step 1.5)
3. **AWS 側 Terraform module + policy tightening 並列** (Step 2 + 2.5)
4. **Worker credential provider 実装** (Step 3)
5. **Staging Worker 立てて受入テスト** (Step 4)
6. **本番 callsite 統一** (Step 5)
7. **本番 cutover + 2-3 日観察** (Step 6)
8. **24h 観察で旧 Access Key 削除** (Step 7)
9. **鍵 rotation runbook + docs** (Step 8)

---

## 実装ステップ

### Step 1: Worker を OIDC issuer 化 (multi-kid 対応)

`workers/discord-handler/src/lib/auth/oidc-issuer.ts` を新設、JWT 発行 + JWKS 公開を実装。

- [x] **鍵ペア生成スクリプト** `scripts/generate-oidc-keypair.mjs` (commit f8e951c):
  - `crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, hash: 'SHA-256'}, true, ['sign','verify'])` で RSA-2048 生成
  - 既存 `OIDC_PRIVATE_KEYS_JWK` (配列の JSON 文字列) を受け取り、**末尾追加** モードで出力 (rotation 用 `--rotate` フラグ) + `--fresh` / `--remove-old` も実装
  - 各 JWK には `kid = crypto.randomUUID()`、`iat`-like `created_at` (UNIX seconds) も付与
  - 投入手順 (`wrangler secret put OIDC_PRIVATE_KEYS_JWK`) を stderr に出す (stdout は JSON のみ)
- [x] **`env.ts` 拡張** (commit f8e951c):
  - `OIDC_PRIVATE_KEYS_JWK?: string` (Secret、`{"keys":[{kid, ...}, ...]}` の JSON 文字列)
  - `OIDC_SUB?: string` (**Secret**、`discord-handler-<8 文字 random>` 形式。決定13)
  - `AWS_OIDC_ROLE_ARN?: string` (vars、AssumeRole 先)
  - `AWS_AUTH_MODE?: 'static' | 'oidc'` (vars、未設定なら `'static'`)
- [x] **`lib/auth/oidc-issuer.ts`** (commit f8e951c、module-private 設計):
  - `loadPrivateKeys(env)`: JWK 配列 → `Array<{kid, privateKey: CryptoKey, publicJwk, createdAt}>`、module-scope cache。`extractable=false` で再 export 不可
  - `signOidcToken(env, {sub, aud, ttlSeconds})`: **module-private**、最新 `createdAt` の鍵で署名。header `{alg:'RS256', kid, typ:'JWT'}`、payload `{iss, sub, aud, iat, nbf:iat, exp:iat+60, jti}`
  - `issueStsWebIdentityToken(env)`: 公開 entry、sub/aud/ttl を hardcode した STS 専用 wrapper
  - `buildJwks(env)`: 配列全件を public 鍵のみで返す (rotation 中は新旧両方公開)
  - `buildDiscoveryDocument(issuerUrl)` / `deriveIssuerUrl(env)`: 必須フィールドのみ
- [x] **`src/index.ts` route 追加** (commit f8e951c、`/oidc/.well-known/*` のみ、`/oidc/sign` 等は無し):
  - `GET /oidc/.well-known/openid-configuration` → discovery doc JSON
  - `GET /oidc/.well-known/jwks.json` → JWKS JSON (配列)
  - 両者 `Cache-Control: public, max-age=3600, s-maxage=86400`
- [x] **テスト** `lib/auth/oidc-issuer.test.ts` (commit f8e951c、16 ケース全通過):
  - **`jose` を dev dependency に追加**、`jwtVerify` で署名検証成功
  - exp / iat / nbf / iss / sub / aud / jti の値検証
  - JWKS が public 鍵のみで private を漏らさない
  - kid が JWT header / JWKS で一致
  - **multi-kid シナリオ**: 2 鍵入りの env で、署名は新鍵、JWKS は両鍵を返す
  - `signOidcToken` が module export されていないこと (runtime 担保)
  - **jti が呼び出し毎に新規生成されていること** (3 連続呼び出しで全て異なる UUID)
- [x] **`package.json` 更新**: `jose` を `devDependencies` に追加 (5.10.0)
- [x] **`pnpm typecheck` / `pnpm test` (104/104) / `pnpm build` (239.16 KiB)** 通過

Worker コード変更: **あり**。AWS 変更: なし。**Step 1 完了 (commit f8e951c, 2026-05-24)**。

### Step 1.5: 確定 issuer URL 取得 (空 OIDC route 付き先行 deploy)

Step 2 の Terraform で `worker_issuer_url` を確定値で書きたいので、Step 1 で実装した route を 1 度本番 deploy する。

- [x] **`OIDC_PRIVATE_KEYS_JWK` を本番 secret に投入** (Step 1 のスクリプト出力)
- [x] **`pnpm wrangler deploy`** で本番 Worker を更新
- [x] **`curl https://discord-handler.<your-account>.workers.dev/oidc/.well-known/jwks.json`** が 200 + JWKS JSON を返す
- [x] **`curl https://discord-handler.<your-account>.workers.dev/oidc/.well-known/openid-configuration`** が 200 + discovery doc を返す
- [x] **issuer URL 確定**: `https://discord-handler.<your-account>.workers.dev/oidc`
- [-] **Cloudflare WAF rate limit は本 Phase では設定しない (rev4 で skip 確定)**。理由: **`*.workers.dev` には WAF / Rate Limiting Rules を適用できない** (Cloudflare 所有 zone のため、自前ドメインの zone WAF と違って dashboard 設定不可)。代替は (a) Workers Rate Limiting API binding か (b) 独自ドメイン化 + zone WAF だが、(a) は AWS STS の IP allowlist 追加実装で複雑化、(b) は決定 7 (workers.dev 固定) 破棄 + OIDC provider 完全再作成で重い。**主防御は edge cache (`s-maxage=86400`) で吸収**し、本格 DoS の兆候が出たら案 (a) を発動する方針 (Step 8 runbook に手順を残す)
- [x] この時点では AWS 側未設定なので Worker は依然 static credentials 経路で動作 (回帰なし確認済)

Worker コード変更: なし (deploy のみ)。**Step 1.5 完了 (2026-05-24)**。

### Step 2: AWS 側 OIDC 信頼関係を Terraform で構築

`infra/modules/aws-oidc-cloudflare/` を新設、OIDC provider + Role を IaC 化。

- [x] **モジュール構成** (commit b11a5af):
  ```
  infra/modules/aws-oidc-cloudflare/
  ├─ main.tf       # aws_iam_openid_connect_provider + aws_iam_role
  ├─ variables.tf  # worker_issuer_url, expected_sub, max_session_duration, thumbprints, role_name
  ├─ outputs.tf    # role_arn, role_name, oidc_provider_arn, oidc_provider_url
  └─ README.md     # モジュール責務、thumbprint 取得手順、緊急 rotation 手順
  ```
- [x] **`aws_iam_openid_connect_provider`** (apply 済):
  - `url = "https://discord-handler.<your-account>.workers.dev/oidc"`
  - `client_id_list = ["sts.amazonaws.com"]`
  - `thumbprint_list`: 2 件 (intermediate + leaf) — `scripts/get-cf-thumbprint.ps1` で取得
- [x] **`aws_iam_role` `gs-worker-oidc-role`** (apply 済):
  - assume_role_policy: Federated = OIDC provider ARN、Action = `sts:AssumeRoleWithWebIdentity`、Condition:
    ```
    StringEquals: {
      "<provider>:aud": "sts.amazonaws.com",
      "<provider>:sub": var.expected_sub
    }
    ```
  - rev6 で iss / jti を削除。理由: AWS の OIDC custom provider は `<provider>:aud` と `<provider>:sub` のみを condition key として expose する。iss / jti を入れると StringEquals/StringLike が null 比較で必ず fail (= AccessDenied)。iss は AWS が provider URL 一致を暗黙的に検証、jti replay 防御は Worker 側 (Step 3 `oidc-jti:<jti>` KV TTL 70s self-defense) に一元化
  - `max_session_duration = 3600` (AWS API 最小、Role 側の上限値。実際の 15min session は Worker 側 STS 呼び出しの `DurationSeconds = 900` で指定)
- [-] **JWKS thumbprint 監視** → **rev5 で Step 3 の STS failure sentinel に統合**。Worker fetch() は TLS cert thumbprint を expose しないため Worker 内では検証不可と判明。代わりに Step 3 の `getAwsCredentials` が STS error を捕捉 → Discord 通知する経路を sentinel として利用。手動 thumbprint チェック手順だけ runbook (Step 8) に残し、半期に 1 度任意で実行する
- [x] **`infra/envs/prod/iam.tf` 改修** (commit b11a5af):
  - 新 module `module "worker_oidc"` 呼び出し
  - 既存 `aws_iam_user.gs_worker_caller` および attachment は **残す** (Step 7 で剥がす)
  - `output "worker_oidc_role_arn"` / `worker_oidc_provider_arn` を追加
- [x] **terraform plan / apply** (ユーザー実行、2026-05-24):
  - provider + role の 2 リソース apply 成功 (`arn:aws:iam::123456789012:role/gs-worker-oidc-role`)
- [x] **AWS CLI 手動検証** (2026-05-24): `scripts/sign-test-jwt.mjs` 経由で JWT を発行し、`aws sts assume-role-with-web-identity` が `Credentials` を返す (15min session)。検証中に iss / jti condition key が AWS で未サポートと判明し rev6 で削除

Worker コード変更: なし (rev5 で thumbprint cron 廃止、Step 3 の sentinel に統合)。Infra 変更: **あり**。**Step 2 完了 (commit 9308f9d + b11a5af, 2026-05-24)**。

### Step 2.5: IAM policy tightening (least privilege 化)

新 `gs-worker-oidc-policy` を **wildcard 除去版** で作り、Step 2 の Role に attach する。

#### Step 2.5.0: 前提条件 — `Env=prod` tag backfill (着手前必須)

**新 policy は全 resource 系 statement に `aws:ResourceTag/Env = "prod"` 条件を付けるため、tag 未付与の既存 resource があると `/start` `/stop` / cron が即時 AccessDenied で停止する**。Step 2.5 本体の terraform apply 前に必ず以下を完了させる。

- [x] **欠落検出** (AWS CLI、2026-05-24 実施):
  - 既存 EC2: `aws ec2 describe-instances --filters "Name=tag:Project,Values=game-servers" --query "Reservations[].Instances[?!not_null(Tags[?Key=='Env'].Value | [0])].InstanceId" --output text` → 空 (current 0 instances)
  - 既存 EBS volume: 同形式の `describe-volumes` → 空 (current 0 volumes)
  - 既存 snapshot: 同形式の `describe-snapshots` → **4 件欠落** (`snap-06e434398fafc82d6` / `snap-0ea1b9f2b2642acdd` / `snap-0dfd4494f5e2b88b3` / `snap-033f6fa6ea246eecb`)
  - 注: 当初計画の `Tags[?Key==\`Env\`]` 形式は PowerShell でバックティックがエスケープされて壊れるため、`not_null(... | [0])` 形式に書き直して runbook に確定版を残した
- [x] **欠落 resource に `Env=prod` を backfill** (2026-05-24): 上記 snapshot 4 件に `aws ec2 create-tags --resources snap-... --tags Key=Env,Value=prod` 実施。AMI 由来 snapshot (`snap-033f6fa6...`) も将来一貫性のため backfill 対象に含めた
- [x] **Launch Template の `tag_specifications` 確認** (2026-05-24): `infra/envs/prod/compute.tf` L68-83 で instance / volume の双方に `Env=prod` 焼き込み済を確認。terraform apply 不要
- [x] **将来の new resource にも自動付与される経路を担保** (2026-05-24 追加対応):
  - `workers/discord-handler/src/handlers/discord/start.ts` `volumeTags` に `Env: 'prod'` 追加 (instanceTags は既存)。RunInstances の TagSpecification は LT を上書きするため Worker 側で必ず明示するコメント方針 (L179-181) に整合
  - `workers/discord-handler/src/handlers/stop-workflow.ts` `createSnapshot` の tags map に `Env: 'prod'` 追加
  - `ami/game-server.pkr.hcl` に `snapshot_tags` / `run_tags` / `run_volume_tags` を追加 (AMI 本体の `tags` block は snapshot に伝播しないため。次回 `pnpm build-sidecar-ami` から有効)
  - 上記コード修正は 104/104 test pass + Packer `validate -syntax-only` 通過
- [x] **再確認**: 3 つの検出コマンド出力すべて空であることを 2026-05-24 確認
- [x] **runbook 記載**: `docs/runbook-phase5-oidc.md` を新規作成、§0 「cutover 前の事前確認」セクションに検出 + backfill + 4 経路の自動付与一覧 + 過去対応履歴を記載

#### Step 2.5.1: 新 policy 構築

- [ ] **`infra/envs/prod/iam.tf` 改修** (新 policy 作成):
  - `data.aws_iam_policy_document.gs_worker_oidc` を新設、既存 `gs_worker_caller` をベースに以下を変更 + **全 resource 系 statement に `aws:ResourceTag/Env = "prod"` も追加 (Step 4 staging との分離)**:
    - `Ec2RunStopSnapshot` を分解:
      - `ec2:RunInstances`: Condition: `ec2:LaunchTemplate = aws_launch_template.game_server.arn`, `ec2:InstanceType` allow list (m6i.xlarge 等、`var.allowed_instance_types`)、`aws:RequestTag/Env = "prod"` 強制 (起動時 Env タグ必須)
      - `ec2:TerminateInstances`: Condition: `aws:ResourceTag/Project = "game-servers"` AND `aws:ResourceTag/Env = "prod"`
      - `ec2:CreateSnapshot` / `DeleteSnapshot`: Condition: `aws:ResourceTag/Project = "game-servers"` AND `aws:ResourceTag/Env = "prod"`
      - `ec2:DeleteVolume`: Condition: `aws:ResourceTag/Project = "game-servers"` AND `aws:ResourceTag/Env = "prod"`
      - **`ec2:CreateTags`**: Condition: `aws:RequestTag/Project = "game-servers"` (= 新規 tag を強制、無関係 resource に Project tag を貼って他 statement の tag 条件 bypass を遮断) + `ec2:CreateAction` allow list (`RunInstances` / `CreateSnapshot` 等限定) + Resource を `arn:aws:ec2:*:*:instance/*` / `volume/*` / `snapshot/*` 等で限定
      - `ec2:Describe*`: そのまま (Describe API は基本 wildcard を要する、AWS 側 API 制約)
    - `SsmSendCommandToTaggedInstances` / `SsmSendCommandWithDocument` / `SsmGetCommandInvocation`: 既存条件を維持。`SendCommand` には `aws:ResourceTag/Env = "prod"` を追加 (現状 Project tag のみ)。`GetCommandInvocation` は **wildcard 維持** (SendCommand 直後の状態確認用で AWS 側挙動として他人の CommandId 情報は漏れない)
    - **`PassEc2InstanceRole`**: 既存 `iam:PassedToService = "ec2.amazonaws.com"` 条件を **新 policy で必ず継承** (見落とすと EC2 以外への PassRole が通る)。Resource は `aws_iam_role.gs_phase0_ec2.arn` で既存通り絞り込み
    - `SsmAmiResolve`: 既存
    - **`OidcThumbprintRead`** (新規): rev5 で **削除確定**。oidc-thumbprint-check cron 自体を廃止したため `iam:GetOpenIDConnectProvider` 権限は不要。手動 thumbprint check (runbook Step 8) はユーザーの AWS CLI 権限で実行する
- [x] **新 `aws_iam_policy` "gs_worker_oidc_policy"** + `aws_iam_role_policy_attachment` で Step 2 の Role に attach (2026-05-24 commit)
- [x] **terraform plan** (2026-05-24): `Plan: 2 to add, 0 to change, 0 to destroy.` を確認。policy 1 個 + attachment 1 個 追加、既存 user 側 policy 無変更
- [x] **terraform apply** (ユーザー実行、2026-05-24): policy + attachment 作成成功 (`arn:aws:iam::123456789012:policy/gs-worker-oidc-policy`)
- [x] **AWS CLI 検証** (2026-05-24): 実 API 副作用ゼロの `aws iam simulate-principal-policy` で 8 ケース確認 (`gs-worker-oidc-role` 直接評価):
  - 未許可 LT で `ec2:RunInstances` → **implicitDeny** ✅
  - 未許可 instance type (`c5.24xlarge`) で `ec2:RunInstances` → **implicitDeny** ✅
  - 正規 LT + 許可 type + RequestTag/Env=prod で `ec2:RunInstances` → **allowed** (Matched: gs-worker-oidc-policy) ✅
  - 無 tag instance で `ec2:TerminateInstances` → **implicitDeny** ✅
  - 正規 tag (Project+Env) で `ec2:TerminateInstances` → **allowed** ✅
  - SnapshotType=game-world-data tag が無い AMI snapshot で `ec2:DeleteSnapshot` → **implicitDeny** ✅ (Packer snap 構造的保護を実証)
  - SnapshotType=game-world-data tag 付き snapshot で `ec2:DeleteSnapshot` → **allowed** ✅
  - 非許可 action (`AssociateAddress`) 経由で `ec2:CreateTags` → **implicitDeny** ✅ (`ec2:CreateAction` 制約で tag 偽装 bypass を遮断)
- [ ] **回帰確認**: Phase 1〜4 の挙動が新 policy で壊れていないこと (Step 5 の staging で改めて検証)。**現時点では Worker は依然 static credentials (旧 gs-worker-caller user) を使用するため Step 6 cutover まで本番挙動は無変更**、policy attach 単独では既存経路に影響しない

Worker コード変更: なし。Infra 変更: **あり**。

### Step 3: Worker AWS credential provider 実装

`lib/aws/credentials.ts` を新設、`AwsApiClient` 構築の前段で credentials を取得する 1 関数に集約。

- [ ] **`lib/aws/credentials.ts`**:
  - `getAwsCredentials(env, ctx): Promise<AwsCredentials>` の動作:
    1. `env.AWS_AUTH_MODE !== 'oidc'` → 従来の static credentials を即返す (後方互換)
    2. **in-flight Promise dedup**: module-scope `Map<string, Promise<...>>` で同 invocation 内の同時呼び出しを 1 本化。**`.finally(() => map.delete(key))` で必ず Map から削除** (Promise reject 時の残留で永久 dedup を防ぐ)
    3. KV `SERVER_STATE` の `aws-creds:cache` を読み、`expiration > now + 60s` なら返す
    4. miss → `signOidcToken(env, {sub: env.OIDC_SUB, aud: 'sts.amazonaws.com', ttlSeconds: 60})`
    5. STS regional endpoint (`https://sts.<region>.amazonaws.com/`) に Query Protocol で `AssumeRoleWithWebIdentity` POST、`DurationSeconds=900` を指定 (Role 側 `max_session_duration=3600` の上限内で 15min session を要求)
    6. XML レスポンスから `AccessKeyId` / `SecretAccessKey` / `SessionToken` / `Expiration` を抽出
    7. KV `aws-creds:cache` に put、TTL = `(expiration - now - 60) - Math.random() * 30` (**負方向 jitter のみ**、決定4)
    8. ctx.waitUntil で KV write は fire-and-forget、credentials は即 return
  - エラーハンドリング: STS error は `<ErrorResponse><Error><Code>` のみ抽出。`<Message>` はログのみ、Discord 通知には **code と HTTP status だけ** 流す (ARN/account ID をエコーするケースを遮断)
  - 失敗は `OidcCredentialError(code, status)` を throw、呼び出し側で Discord に通知する場合は code のみ。**`AWS_AUTH_MODE = "oidc"` の場合は絶対に static credentials に fallback しない** (fallback すると OIDC 化の意味が消える)
  - JWT は **どこにも log 出力しない**。`signOidcToken` の戻り値は `{ token: string }` の opaque object でなく **直接 string return** だが、`console.log` 等で出力する箇所を作らないことを test で担保
  - **KV put 失敗時の挙動**: credentials は呼び出し側に return しつつ、`ctx.waitUntil` で Phase 4 の `postDiscordWebhookMessage` で「OIDC cache put 失敗」を 1 時間 1 回まで通知 (`notif-suppress` で抑制)。silent degradation を防ぐ
  - **STS failure sentinel** (rev5 で追加役割): `OidcCredentialError` を throw する経路はすべて Phase 4 webhook に流す (1h 1 回 suppress + code/status のみ)。thumbprint mismatch / sub 不一致 / JWKS 不到達 / aud 違反など、OIDC 経路全般の異常をこの 1 経路で検知 = 別途 thumbprint 監視 cron を持たない理由
- [ ] **テスト** `lib/aws/credentials.test.ts`:
  - `AWS_AUTH_MODE = static` で KV / STS を呼ばずに即 return
  - cache hit / miss / 期限切れ近接の各ケース
  - STS XML レスポンスのパース (正常 / Error)
  - KV put 失敗時に credentials は返す (cron 本体は止めない) + Discord 通知が 1 時間 1 回まで発火
  - 同 invocation 内で並列 5 呼び出し → JWT 発行 / STS 呼び出しが 1 回のみ (in-flight dedup)
  - **in-flight Promise reject 後、再度呼び出すと map が空で 2 回目の STS 試行ができること** (finally による Map cleanup の担保)
  - STS error の場合、Discord に流せるエラーメッセージに ARN/account ID が含まれない
  - **`AWS_AUTH_MODE = "oidc"` で STS error 時に static credentials へ fallback しないこと** (`OidcCredentialError` を throw)
  - **KV jitter が負方向のみ** (= `expiration - now - 60` 以下) であること、TTL 計算結果が常に正であること
- [ ] **`pnpm typecheck` / `pnpm test` / `pnpm build`**

Worker コード変更: **あり (新 module)**。Infra 変更: なし。

### Step 4: Staging Worker セットアップと受入テスト

本番一発 cutover を避けるため別 Worker subdomain で受入テスト。

- [ ] **`wrangler.toml` に `[env.staging]` 追加**:
  - `name = "discord-handler-staging"`
  - 別 KV namespace (`SERVER_STATE_STAGING` / `GAME_REGISTRY_STAGING`)
  - vars: `AWS_AUTH_MODE = "oidc"`, `AWS_OIDC_ROLE_ARN = <staging role>` (vars)
  - **`OIDC_SUB` は secret として別途投入** (`wrangler secret put OIDC_SUB --env staging`、値は `discord-handler-<random>-stg`)
- [ ] **Staging 用 OIDC private key** を別途生成し `wrangler secret put OIDC_PRIVATE_KEYS_JWK --env staging` (**本番鍵とは独立、漏洩波及禁止**)
- [ ] **Staging 用 OIDC provider + Role + 専用 policy** を Terraform で別途構築。**tfstate 汚染を避けるため `infra/envs/staging/` 配下に独立した env として切る** (`infra/envs/prod/` への staging module 同居は禁止 — staging 試行錯誤が本番 plan に紛れる):
  - `infra/envs/staging/` を新設、独自の backend (別 S3 key) と provider 設定
  - `module "worker_oidc"` を staging 用パラメータ (sub / Env=staging policy) で呼び出し
  - 本番 module `infra/envs/prod/` には staging 関連 resource を一切置かない
  - **専用 `gs-worker-oidc-staging-policy`** を作る (本番 policy の attach は禁止、決定11)
  - 全 resource 系 statement に `aws:ResourceTag/Env = "staging"` 条件を付与 (本番 `Env = "prod"` resource にアクセス不可能になる)
  - `ec2:RunInstances` の `aws:RequestTag/Env = "staging"` 強制 (起動時 staging tag 必須)
  - これにより staging private key 漏洩しても本番 EC2 を terminate できない構造的分離
- [ ] **`pnpm wrangler deploy --env staging`** で deploy
- [ ] **Staging URL** での受入テスト (本番 ATM11 とは別 instance / 別 Game tag を使い影響分離):
  - `curl https://discord-handler-staging.<account>.workers.dev/oidc/.well-known/jwks.json` 200
  - Discord 管理画面で staging Worker URL を別アプリの interaction endpoint に登録 (検証用 Discord ギルド作成)
  - `/list` `/status` (副作用なし) を試行
  - 検証用 game の `/start` `/stop` を 1 サイクル、`wrangler tail --env staging` で STS 呼び出し / KV cache / 短期 credentials の利用を確認
  - cron が回る (5min 待機) ことを `wrangler tail --env staging` で確認
- [ ] **Staging で見つかった不具合は Step 1〜3 にループバック修正**
- [ ] 受入テストが通ったら本 Step 完了

Worker コード変更: なし (env 追加のみ)。Infra 変更: **あり (staging OIDC)**。

### Step 5: 全 callsite を credential provider 経由に統一

7 callsite (`grep -n "new AwsApiClient" workers/discord-handler/src`) を `getAwsCredentials(env, ctx)` 経由に置換。

- [ ] **対象**:
  - `handlers/discord/start.ts`
  - `handlers/discord/status.ts`
  - `handlers/discord/stop.ts` (経由する `stop-workflow.ts`)
  - `handlers/stop-workflow.ts`
  - `handlers/snapshot-retention.ts`
  - `handlers/cleanup.ts`
  - `handlers/admin.ts`
- [ ] **置換パターン**:
  ```ts
  const credentials = await getAwsCredentials(env, ctx);
  const ec2 = new AwsApiClient({ region: env.AWS_REGION ?? 'ap-northeast-1', credentials });
  ```
- [ ] **`ExecutionContext` 受取**: `getAwsCredentials` が `ctx.waitUntil` で KV write を fire-and-forget するため、各 handler の signature が ctx を受けることを確認。admin.ts は未受の可能性、必要なら追加
- [ ] **同 invocation 内では credentials を 1 度取って渡しまわす** (start.ts は EC2 + SSM 両方使うため)
- [ ] **テスト更新**: 既存 handler test の AWS mock を `getAwsCredentials` の return mock に差し替え (credentials 中身は意味なし、`AwsApiClient` が受けるだけ)
- [ ] **staging で再受入テスト** (Step 4 のシナリオを通す)

Worker コード変更: **あり (全 callsite)**。Infra 変更: なし。

### Step 6: 本番 cutover + 2-3 日観察

`AWS_AUTH_MODE = oidc` で本番切り替え、平日/週末両方を見れるよう 2-3 日観察。

- [ ] **本番 `wrangler.toml [vars]` 更新**:
  - `AWS_OIDC_ROLE_ARN = "<gs-worker-oidc-role の ARN>"` (vars)
  - `AWS_AUTH_MODE` は **まだ未設定** (= static、現状維持)
- [ ] **本番 secret 投入**:
  - `wrangler secret put OIDC_PRIVATE_KEYS_JWK` (本番用、Step 1.5 で投入済の場合スキップ)
  - `wrangler secret put OIDC_SUB` (`discord-handler-<8 文字 random>`、決定13)
- [ ] **`pnpm wrangler deploy`** で本番更新 (mode は static のまま、変化なし回帰確認)
- [ ] **`AWS_AUTH_MODE = "oidc"` に切り替え**:
  - `wrangler.toml [vars]` を編集して `pnpm wrangler deploy`
  - 直後に `/list` を試す (副作用なし)、続けて `/status`、ATM11 `/start` → `/stop`
  - `wrangler tail` で STS 呼び出し / KV cache hit ratio / 短期 credentials の expiration を観察
- [ ] **Cron 経路の確認**: 5 分経過で `snapshot-retention` / `cleanup` cron、ATM11 起動中なら `idle-fallback` も `wrangler tail` で観察
- [ ] **2-3 日観察項目チェックリスト**:
  - [ ] Discord channel に新規エラー通知ゼロ
  - [ ] `/start` `/stop` `/status` `/list` 各 1 回以上成功 (週末を跨ぐ)
  - [ ] cron が 3 周期以上完走 (snapshot-retention / cleanup / idle-fallback)
  - [ ] STS API 呼び出し回数が想定通り (1h あたり数回、cron 5min ごとの cache hit を確認)
  - [ ] JWKS thumbprint 監視 cron が 1 回以上動作し OK 結果
- [ ] **rollback 手順** (失敗時、Step 7 削除前のみ有効):
  - `wrangler.toml [vars]` で `AWS_AUTH_MODE` を削除 or `"static"` に
  - `pnpm wrangler deploy` で即時反映
  - 旧 Access Key はまだ Inactive 化していないので static credentials がそのまま動く

Worker コード変更: なし (deploy のみ)。Infra 変更: なし。

### Step 7: 旧 IAM Access Key の即削除 (24h 観察後)

セキュリティ重視で 1 週間 Inactive は採用せず、24h 安定確認したら即削除する。**順序は時系列で固定** (決定17)。順序が崩れると「mode=static のままコード復活」rollback の整合性が壊れる。

- [ ] **Step 7.0: 24h 観察** (Step 6 cutover 後、Step 6 チェックリストの最低 1 周期):
  - エラー通知ゼロ
  - `/start` `/stop` 各 1 回以上成功
  - cron 3 周期以上完走

#### Step 7.1 + 7.2: Worker Secret 削除 + static 経路コード削除 (atomic 実行)

**重要**: 7.1 単独で Secret を削除した直後に `AWS_AUTH_MODE = "static"` に切替えると、`env.AWS_ACCESS_KEY_ID` が undefined のまま aws4fetch が空文字 credentials で署名し、AWS 側で「不正な署名」エラーが大量発生する dead window が生じる。**7.1 と 7.2 はユーザー手元で連続実行**し、その間に mode 切替操作を絶対にしないこと。

- [ ] **7.1.a (準備)**: コード削除 commit を **事前に PR としてレビュー / 承認済**にしておく (まだ merge せず、deploy も走らせない)
- [ ] **7.1.b**: `wrangler secret delete AWS_ACCESS_KEY_ID` → `wrangler secret delete AWS_SECRET_ACCESS_KEY`
- [ ] **7.2.a**: 即座にコード削除 PR を merge + `pnpm wrangler deploy` 実行 (7.1.b 完了から数分以内、間に他作業を挟まない)
- [ ] **7.2.b** (コード削除 PR の内容):
  - `env.ts` から `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` 型定義削除
  - `AWS_AUTH_MODE` を必須 `'oidc'` に変更 (env から削除して固定値化も可)
  - `lib/aws/credentials.ts` の static 経路 (`AWS_AUTH_MODE !== 'oidc'` 分岐) を削除
  - テスト更新 (static 経路テストを削除)
  - `pnpm typecheck` / `pnpm test` / `pnpm build` 通過
- [ ] deploy 後はコード上 OIDC 専用、AWS_AUTH_MODE 切替経路も消滅 = dead window 構造的解消

#### Step 7.3: AWS Access Key 削除 (Worker からもう使われない)
- [ ] `aws iam list-access-keys --user-name gs-worker-caller`
- [ ] `aws iam delete-access-key --user-name gs-worker-caller --access-key-id <AKIA...>`

#### Step 7.4: IAM user / 旧 policy 削除 (Terraform、独立 PR)
- [ ] `infra/envs/prod/iam.tf` から `aws_iam_user.gs_worker_caller` 関連 resource を削除
- [ ] `aws_iam_policy.gs_worker_caller` (旧 user policy) も削除
- [ ] `aws_iam_user_policy_attachment.gs_worker_caller` も削除
- [ ] `terraform plan` → 「user 1 / policy 1 / attachment 1 削除」のみ確認
- [ ] `terraform apply` (ユーザー実行)
- [ ] **rollback 不可** をこの時点で確定。再活性化したい場合は新 Access Key 発行 + Secret 再投入 + コード revert の手動 1h コース

Worker コード変更: **あり (static 経路削除)**。Infra 変更: **あり (IAM user 削除)**。

### Step 8: 鍵 rotation runbook + ドキュメント整備

- [ ] **`docs/runbook-phase5-oidc.md` 新規**:
  - **cutover 手順** (Step 6 の再現用)
  - **rollback 手順** (Step 6 までの場合 / Step 7 後の場合)
  - **6 ヶ月定期 rotation 手順** (本番、無停止):
    1. `node scripts/generate-oidc-keypair.mjs --rotate` で新鍵を末尾追加
    2. `wrangler secret put OIDC_PRIVATE_KEYS_JWK` で配列更新 (新旧両方入り)
    3. `pnpm wrangler deploy` → JWKS endpoint が両 kid を返すことを確認
    4. **最低 90 秒待機** (JWT exp 60s + clock skew 30s)。これより短いと旧 kid 発行 JWT で AssumeRole 中の in-flight session がある状態で削除する race を生む。STS の JWKS cache は新 kid を取り込む側なので 24h 待機は不要
    5. 24h 観察 (STS が新 kid で AssumeRole 成功することを `wrangler tail`)
    6. `scripts/generate-oidc-keypair.mjs --remove-old` で旧 kid を削除
    7. `wrangler secret put` で更新、deploy
  - **Staging 用の独立 rotation 手順**: 上記と同じ手順だが `--env staging` 付き、staging private key の漏洩は本番に波及しないため別ライフサイクルで管理 (年 1 回程度の節目で実施)
  - **漏洩時 1h 緊急 rotation 手順** (決定16): 2 つの方式を併記。状況に応じて使い分け。
    - **方式 A (推奨): sub condition を無効値に上書き (apply 1 回、高速)**
      1. 漏洩疑い検知
      2. ローカルで `infra/modules/aws-oidc-cloudflare/variables.tf` の `expected_sub` を一時的に `"REVOKED-<timestamp>"` 等の到達不能値に変更 (or terraform variable 経由)
      3. `terraform apply` (`gs-worker-oidc-role` の trust policy の sub condition だけが差分。**全 in-flight session 即時無効化**、apply 1 回で完結 = dependency 連鎖なし)
      4. ローカルで新鍵生成 (`scripts/generate-oidc-keypair.mjs --fresh`)、旧鍵廃棄
      5. `wrangler secret put OIDC_PRIVATE_KEYS_JWK` で新鍵投入
      6. 新 `OIDC_SUB` 値を生成し `wrangler secret put OIDC_SUB`、`expected_sub` を新値に戻して `terraform apply`
      7. `pnpm wrangler deploy`
      8. Discord で動作確認
      9. 復旧見込み: 5〜10min (apply 2 回で済む、role ARN 不変なので `AWS_OIDC_ROLE_ARN` vars 変更不要)
    - **方式 B (代替): IAM role 一時削除 + 再構築 (apply 2 回、確実だが dependency 注意)**
      1. 漏洩疑い検知
      2. **事前確認**: `terraform state list | grep oidc` で dependency 列挙、`aws iam list-attached-role-policies --role-name gs-worker-oidc-role` で policy attachment 確認
      3. **事前 detach** (terraform 削除前): `aws iam detach-role-policy --role-name gs-worker-oidc-role --policy-arn <policy_arn>` を AWS CLI で実行 (DeleteConflict 回避)
      4. Terraform で `aws_iam_role.gs_worker_oidc` 削除 → apply (この瞬間に全 in-flight session 即時無効化)
      5. 新鍵生成 → `OIDC_PRIVATE_KEYS_JWK` 投入 → 新 `OIDC_SUB` 投入
      6. Terraform で新 role 再作成 + policy attachment 再構築 → apply
      7. `AWS_OIDC_ROLE_ARN` vars 更新 (新 ARN になっている場合) → deploy
      8. 復旧見込み: 10〜15min。Worker → AWS は role 削除〜再構築の間ダウン
    - **どちらを選ぶか**: 方式 A は apply 1 回で session を即時無効化できる速さの利点があり、dependency 連鎖もない。**第一選択は方式 A**。方式 B は role ARN ごと刷新したい強制リセット時の選択肢
    - **共通注意**: いずれの場合も「rotation 直前に `/stop` を手動で打って動いている game を停止しておく」のが安全 (Worker 復旧中の cron 失敗回避)
    - 旧 rev1 手順 (sub 一時変更 + 旧 kid 削除 + sub 戻し) は方式 A の sub 上書きと本質的に同じだが、kid 操作も挟むため複雑。本 rev は **方式 A の単純化版** に統一
  - **JWKS thumbprint 検証手順** (半期に 1 回任意 / sentinel 発火時の対応):
    1. `scripts/get-cf-thumbprint.{sh,ps1} discord-handler.<account>.workers.dev` で現状を取得
    2. `aws iam get-open-id-connect-provider --open-id-connect-provider-arn <ARN>` で AWS 側現値を取得
    3. 差分があれば `terraform apply -var='worker_oidc_thumbprints=["<intermediate>","<leaf>"]'` で更新
    4. **rev5 で `oidc-thumbprint-check` Worker cron は廃止** (Worker fetch() は TLS cert を expose しないため検証不可)、代わりに Step 3 の STS failure sentinel (Discord 通知) が事後検出を担う
  - **DoS 兆候時の Workers Rate Limiting API 導入手順**: 本 Phase では設定せず (workers.dev 制約)。`wrangler.toml` の `[[unsafe.bindings]] type = "ratelimit"` で binding を追加、`/oidc/.well-known/*` route の前に `env.OIDC_RATE_LIMITER.limit({key: clientIp})` を挟む。AWS STS の発信 IP range は AWS の `ip-ranges.json` から抽出して allowlist (rate limit を bypass)。実装着手時は AWS の STS 発信 IP がドキュメント化されているか再確認が必要
- [ ] **`docs/design.md` 更新**:
  - §4.4: AWS 行を `OIDC token + STS AssumeRole (15min)` に
  - §5.6: Phase 1 Access Key 記述削除、OIDC role + policy 構成を記載
  - §9 セキュリティ: 脅威モデル節 (本書 §0) のサマリ追加
  - §10 Phase 5: checkbox 全 [x]、policy tightening の達成も明記
  - §11 Open Questions: OIDC 行は閉じ済
- [ ] **`docs/iac-migration-plan.md`**: `gs-worker-caller` Access Key が IaC 管理外だった注記を「Phase 5 で廃止」に書き換え
- [ ] **CLAUDE.md**: 秘密情報セクションの AWS Access Key 行を「(廃止済、過去 Phase 1〜4)」に
- [ ] **`workers/discord-handler/src/env.ts`**: Phase 2→5 移行の注記をクリーンアップ
- [ ] **メモ更新**:
  - `phase-roadmap-2026-05-23.md`: Phase 5 完了反映 (Phase 6 へ)
  - 新規メモ候補: 「Cloudflare TLS thumbprint の確認手順」「STS regional endpoint と global の差」「OIDC private key の rotation 流儀 (multi-kid 並走、最低 90s 待機)」「AWS IAM policy で `ec2:LaunchTemplate` 条件は ARN 完全一致」「緊急 rotation は role 削除 + 再構築が最速」など、詰まったポイントを記録
- [ ] **Cloudflare WAF IaC 化検討メモ**: `infra/cloudflare/` 配下に Terraform で WAF rule (`/oidc/*` rate limit) を入れるか検討 (現状ダッシュボード手動設定でドリフトリスクあり)。Phase 6 以降の追加課題として記録

Worker コード変更: なし (docs のみ)。

---

## 完了基準

- [ ] `gs-worker-caller` IAM user が AWS から削除された (Terraform state にも残らない)
- [ ] Workers Secrets から `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` が削除された
- [ ] `AWS_AUTH_MODE` は実質 `'oidc'` 固定 (env.ts から削除可)
- [ ] `gs-worker-oidc-policy` が tag / LT / instance type 条件付き、wildcard `Resource = "*"` を持つ statement は Describe 系のみ
- [ ] ATM11 で `/start` `/stop` `/status` `/list` の各成功実績 (cutover 後 2-3 日の実機ログ)
- [ ] cron (snapshot-retention / cleanup / idle-fallback / oidc-thumbprint-check) が 1 週間異常なく回った
- [ ] `pnpm typecheck` / `pnpm test` / `pnpm build` 通過
- [ ] `docs/design.md` §0 (threat model) / §4.4 / §5.6 / §9 / §10 が新方式で更新済
- [ ] `docs/runbook-phase5-oidc.md` に cutover / rollback / 定期 rotation / 緊急 rotation / thumbprint 検証 の全手順が残っている
- [ ] Staging Worker (`discord-handler-staging`) が引き続き利用可能 (将来の検証用に温存)

## リスクと対応

| リスク | 対応 |
|---|---|
| Cloudflare TLS cert ローテで OIDC provider thumbprint が無効化 | AWS 2023+ は JWKS 直接検証が主経路なので普段は無害。万一 AWS が fallback して thumbprint 検証 → STS error 発生時は Step 3 の sentinel で Discord 即時通知 → 手動 `scripts/get-cf-thumbprint` + `terraform apply -var=worker_oidc_thumbprints=[...]` で更新 |
| Worker isolate lifecycle で in-memory cache が頻繁に失効 | KV を primary cache、in-memory は補助。isolate 切替時の overhead は数 ms、許容 |
| STS の AssumeRoleWithWebIdentity 失敗 (JWKS 到達不能) | KV cache のおかげで通常は影響なし。完全停止時は cutover rollback (Step 6 手順) |
| KV cache race (複数 isolate 同時 miss) | in-flight Promise dedup (同 isolate 内、`.finally` で Map cleanup) + 負方向 jitter TTL (cross-isolate 分散) で緩和。AssumeRoleWithWebIdentity 自体は idempotent |
| KV put 失敗 silent degradation | KV put 失敗を `ctx.waitUntil` で Discord 通知、`notif-suppress` で 1h 1 回まで (Step 3) |
| Staging private key 漏洩が本番に波及 | Step 4 で staging 専用 `gs-worker-oidc-staging-policy` を作り `aws:ResourceTag/Env = "staging"` 条件で本番 resource を構造的に遮断 (決定11) |
| `oidc-jti` KV の eventual consistency | jti は `signOidcToken` 内で `crypto.randomUUID()` で必ず新規生成 (固定化テストで担保)。並列発行は理論上通るが各 jti が異なれば実害なし |
| JWKS 5xx 時に static fallback 退行 | Step 3 で `AWS_AUTH_MODE = "oidc"` 時は STS error 全て `OidcCredentialError` を throw、static credentials へ fallback しない (テスト担保) |
| JWT clock skew | `nbf = iat` 設定 + AWS STS 側 clock skew tolerance (デフォルト ±5min) で十分。Worker 側で `iat` を 30s 前に倒す等の補正は不要 |
| JWT replay (5min 窓内) | `exp = iat + 60s` で窓を 60s に圧縮 + Worker 側 `oidc-jti:<jti>` KV (TTL 70s) で同一 jti 再使用を遮断 |
| `signOidcToken` 誤 expose | `lib/auth/oidc-issuer.ts` を internal-only、HTTP route として export しないことを test で担保 |
| Discord 通知への credential 漏洩 | STS error は code のみ抽出 (Step 3)、JWT は log/通知に出さない、`OIDC_PRIVATE_KEYS_JWK` は env から読んだ後 toString 禁止 |
| Rollback 時の long-key 再活性化 | Step 7 で 24h 観察 → Access Key 即削除、Inactive 状態を維持しない |
| issuer 鍵漏洩 = 永続 AWS access | (= threat (a) 等価リスク) — policy tightening (Step 2.5) で被害最大値を抑える。Wrangler API token の取り扱いは別途運用課題 |
| `ec2:RunInstances` を任意 LT で発火 (cryptojacking) | Step 2.5 の `ec2:LaunchTemplate` 条件 + `ec2:InstanceType` allow list で遮断 |
| AWS STS region failure (ap-northeast-1) | 致命的だが対象が広範。手動で `AWS_REGION = us-east-1` に切替 + STS global endpoint fallback (runbook に手順) |
| JWKS endpoint への DoS / 無料枠消費 | **主防御**: `Cache-Control s-maxage=86400` で edge cache (オリジン到達抑制)。**二次防御は本 Phase で未設定** (`*.workers.dev` には WAF 適用不可、Workers Rate Limiting API は AWS STS allowlist が必要で複雑)。本格 DoS の兆候が出たら Workers Rate Limiting API を導入 |

## 工数見積もり (rev3)

- Step 1 (OIDC issuer + multi-kid + jti 新規生成テスト): 3〜4h
- Step 1.5 (確定 URL deploy + WAF rate limit + best-effort 明記): 1h
- Step 2 (Terraform module + thumbprint cron + jti v4 厳密 pattern): 2〜3h (rev2 から +30min)
- Step 2.5.0 (Env=prod tag backfill 事前確認): 1〜2h (新規、resource 数次第で変動)
- Step 2.5.1 (policy tightening + thumbprint read 権限): 3h
- Step 3 (credential provider + dedup + KV put 失敗通知): 3〜4h
- Step 4 (staging Worker + 専用 policy + `infra/envs/staging/` 分離): 4〜5h (rev2 から +1h、staging tfstate 独立化)
- Step 5 (callsite 統一): 1h
- Step 6 (cutover + 2-3 日観察): 1h + 観察 3 日
- Step 7 (atomic 7.1+7.2 + 段階削除): 2h + 観察 24h
- Step 8 (docs + runbook + 緊急 rotation 2 方式): 3〜4h (rev2 から +1h、方式 A/B 併記)

実作業 **24〜28h** (rev2 の 22〜25h から +3h、staging tfstate 独立化と tag backfill が主)。観察期間込みで実 **1 週間**。

---

## 未解決の Open Question

- [x] OIDC issuer 方式選定 (Worker-as-issuer / Roles Anywhere / long-key auto rotate) → **Worker-as-issuer** に確定 (決定 1)
- [x] `AWS_OIDC_ROLE_ARN` を vars or secret → **vars** (決定 6)
- [x] `OIDC_SUB` を vars or secret → **Secret** (rev2 で確定、決定 13)
- [x] issuer URL `*.workers.dev` or 独自ドメイン → **`workers.dev`**、独自ドメインは Phase 6 以降 (決定 7)
- [x] `jose` を dev dep に → **入れる** (Step 1)
- [x] policy tightening を Phase 5 に含めるか → **含める** (ユーザー判断 2026-05-24、決定 10)
- [x] Rollback policy → **24h 即削除** + 4 段階時系列固定 (決定 9 / 17)
- [x] Staging policy 設計 → **専用 `gs-worker-oidc-staging-policy`** で `Env=staging` tag 限定 (rev2 で確定、決定 11)
- [x] 緊急 rotation 方式 → **方式 A (sub condition `REVOKED` 上書き、apply 1 回) 第一選択 + 方式 B (role 削除 + 再構築) 代替** (rev3 で確定、決定 16)
- [ ] **AWS の RS256/ES256 サポート状況の確認**: 着手時に AWS docs を再読し、ES256 が利用可なら検討余地あり (本 Phase は RS256 で進める、決定 2)
- [ ] **`allowed_instance_types` の具体的な list**: Step 2.5 で確定する。現状 ATM11 = m6i.xlarge 等の運用実績から、起動可能 type を 3〜5 個に絞る
- [x] **既存 EC2 / EBS / snapshot に `Env=prod` tag が貼られているか確認** → **Step 2.5.0 (前提条件) として組込み済**。Step 2.5.1 着手前に必ず backfill 完了 + 検出スクリプト出力空であること確認
- [ ] **Staging Worker の Discord ギルド**: 検証用 Discord アプリ + ギルドを別途用意するか、本番ギルドのテスト channel で OIDC dev mode を回すか。Step 4 着手時に決定
- [x] **Cloudflare WAF を Terraform IaC 化** → **rev4 で skip 確定** (`*.workers.dev` には zone WAF 適用不可と判明)。代替は Workers Rate Limiting API binding だが本 Phase では入れない (Step 8 runbook に発動条件 + 手順を残す)
