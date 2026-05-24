# Phase 5 実装計画 — OIDC 化 + IAM policy tightening ✅ 完了 (2026-05-24)

最終更新: 2026-05-24 (rev8: Phase 5 全 Step 完了。Worker → AWS の長期 IAM Access Key を排除、AssumeRoleWithWebIdentity で 15min 短期 credentials のみで稼働。詳細は本ファイル末尾 「完了基準」 + `docs/runbook-phase5-oidc.md` 参照。次は Phase 6 = 新ゲーム追加実証)

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

- [x] **`lib/aws/credentials.ts`** (2026-05-24): 全 8 動作要件を実装。
  - `getAwsCredentials(env, ctx)` の動作: AWS_AUTH_MODE !== 'oidc' で static 即 return → in-flight Promise dedup (IIFE finally で Map cleanup 保証) → KV cache (`aws-creds:cache`、残 60s 以内は expired 扱い) → `issueStsWebIdentityToken` → STS regional (`sts.ap-northeast-1.amazonaws.com`) で `AssumeRoleWithWebIdentity` POST `DurationSeconds=900` → XML 抽出 → KV put `expirationTtl = max(60, expiration - now - 60 - random(0..30))` (**負方向 jitter のみ**、決定4) を `ctx.waitUntil` で背景化
  - エラーハンドリング: STS error の `<Code>` のみ抽出、`<Message>` / `<RequestId>` (ARN / account ID をエコーする) は捨てる。code + HTTP status だけ Discord へ。`OidcCredentialError(code, status)` を throw、`AWS_AUTH_MODE = "oidc"` で絶対 static fallback しない
  - JWT は本実装で一切 log / 通知に出さない (`issueStsWebIdentityToken` の戻り値を console / postDiscordWebhookMessage に渡す箇所が存在しないことを grep + test で担保)
  - **KV put 失敗時**: credentials は return しつつ `ctx.waitUntil` で Discord 通知 1h 1 回 (`notif-suppress: oidc-cache-kv-put-fail`)
  - **STS failure sentinel**: 全 `OidcCredentialError` 経路で Discord 通知 1h 1 回 (`notif-suppress: oidc-credential-fail`)、code + status のみ
- [x] **テスト** `lib/aws/credentials.test.ts` (2026-05-24、14/14 通過): 全 9 要件カバー
  - static mode (AWS_AUTH_MODE 未設定 / 'static'): KV / STS / JWT を一切呼ばないことを assert
  - cache hit (expiration > now + 60s) / cache miss / 期限切れ近接 (残 30s で expired 扱い再取得)
  - STS XML レスポンス parse: 正常 / 4xx (AccessDenied) / network 失敗 / JWT 発行失敗 / RoleArn 未設定
  - KV put 失敗: credentials は return + Discord 通知 1 回
  - 並列 5 呼び出し: JWT 1 回 / STS fetch 1 回 (in-flight dedup)
  - in-flight reject 後の Map cleanup: 2 回目 STS 試行成功
  - STS error の Discord 通知に ARN / account ID / `arn:aws:iam` が含まれない (negative match)
  - oidc mode で STS error → `OidcCredentialError` throw、static creds に fallback しない
  - jitter 負方向: TTL <= (expiration - now - 60)、常に 60 以上、50 サンプル中 jitter が効いていることも確認
  - 1h suppress: STS 連続失敗 2 回中通知 1 回のみ
- [x] **`pnpm typecheck` / `pnpm test` (118/118 = 既存 104 + credentials 14) / `pnpm build` (239.21 KiB)** 通過

Worker コード変更: **あり (新 module + 全 14 テスト)**。Infra 変更: なし。**Step 3 完了 (2026-05-24)**。

### Step 4: Staging Worker セットアップと受入テスト ~~(rev7 で skip 確定)~~

> **rev7 (2026-05-24): 本 Step は skip 確定**。理由: 現状 deploy 済の本番 Worker (`discord-handler.<your-account>.workers.dev`) は**友人公開前で検証用 Discord ギルドにのみ接続中**であり、計画書当初の「staging = 公開前の隔離環境」の役割を**そのまま既に果たしている**。本 Step を実施しても得られる追加価値は次の Phase 6 (新 game 追加 / 破壊的変更検証) で初めて元が取れる投資となるため、**Phase 6 着手時に再評価** とする (友人公開ギルド出来後、staging の用途が「本番影響を避けた破壊的変更の試行場」に明確化されるため)。
>
> **代替**: Step 6 を 3 段階リハーサル (Phase A 副作用ゼロ / Phase B 実起動 / Phase C rollback パス確認) に強化することで、本番 1 発 cutover のリスクを Step 4 と同等以下に圧縮する (改 Step 6 参照)。
>
> **持ち越し項目** (Phase 6 で staging を立てる際に拾い直す):
> - `wrangler.toml [env.staging]` + 専用 KV namespace
> - `infra/envs/staging/` で OIDC provider / role / **専用 `gs-worker-oidc-staging-policy`** (本番 policy 流用禁止、`aws:ResourceTag/Env = "staging"` で本番 resource を構造遮断)
> - staging 専用 OIDC private key + `OIDC_SUB`
> - 検証用 Discord アプリ + ギルドの整備
> - 詳細手順は本 rev 以前 (rev6) の本セクションを git 履歴で参照

### Step 5: 全 callsite を credential provider 経由に統一

6 callsite (`grep -n "new AwsApiClient" workers/discord-handler/src` で確定) を `getAwsCredentials(env, ctx)` 経由に置換。

- [x] **対象** (2026-05-24 commit、6 ファイル):
  - `handlers/discord/start.ts` — `executeStart` に ctx 引き継ぎ + `getAwsCredentials` で credentials 取得
  - `handlers/discord/status.ts` — `executeStatus` に ctx 引き継ぎ + 同上
  - `handlers/discord/stop.ts` — `executeStop` に ctx 引き継ぎ (`runStopWorkflow` 呼び出しで渡す)
  - `handlers/stop-workflow.ts` — `runStopWorkflow(env, ctx, game, opts)` に signature 拡張、`executeStopWorkflow` も同様、内部で `getAwsCredentials`
  - `handlers/snapshot-retention.ts` — `handleSnapshotRetention(env, ctx)` signature 拡張、内部で `getAwsCredentials`
  - `handlers/cleanup.ts` — `handleVolumeCleanup(env, ctx)` signature 拡張、内部で `getAwsCredentials`
  - `handlers/admin.ts` — `handleAdminDockerStop(request, env, ctx)` signature 拡張、内部で `getAwsCredentials`
- [x] **連鎖修正** (signature 変更の波及):
  - `handlers/idle-fallback.ts` — `handleIdleFallback(env, ctx)` 拡張 (`runStopWorkflow` 呼ぶため)
  - `handlers/sidecar/idle-detected.ts` — `runStopWorkflow` 呼び出しに ctx 追加
  - `index.ts` — `scheduled()` で 3 cron handler すべてに ctx を渡す、`/admin/docker-stop` route も ctx 引き継ぎ
- [x] **置換パターン** (採用):
  ```ts
  const credentials = await getAwsCredentials(env, ctx);
  const ec2 = new AwsApiClient({ region: env.AWS_REGION ?? 'ap-northeast-1', credentials });
  ```
- [x] **`lib/aws/index.ts`** に `getAwsCredentials` / `OidcCredentialError` を re-export 追加 (import パス統一)
- [x] **同 invocation 内 1 callsite = 1 credentials 取得**。`getAwsCredentials` は in-flight dedup + KV cache 経由なので重複呼び出ししても STS は 1 回しか叩かないが、明示的に 1 度取って AwsApiClient に渡す pattern を踏襲 (`start.ts` は EC2 + SSM を同じ credentials で使うのでなおさら)
- [x] **テスト更新不要**: handler レベルの integration test は存在せず (test 対象は decideIdleAction / postDiscordWebhookMessage / shouldNotify などの pure / mockable な lib のみ)、signature 変更の波及テスト修正は無し
- [x] **`grep env.AWS_ACCESS_KEY_ID`** で `credentials.ts` の static 経路のみが hit することを確認 (= 移行漏れ無し、Step 7 で削除予定箇所と一致)
- [x] **`pnpm typecheck` / `pnpm test` (118/118) / `pnpm build` (239 KiB 系列)** 通過
- [-] **staging で再受入テスト**: ~~Step 4~~ skip 確定のため、改 Step 6 (3 段階リハーサル) で兼ねる

Worker コード変更: **あり (全 callsite + 連鎖 = 9 ファイル + lib/aws/index.ts re-export)**。Infra 変更: なし。**Step 5 完了 (2026-05-24)**。

### Step 6: 本番 cutover (3 段階リハーサル) + 2-3 日観察

> **rev7 (2026-05-24)**: Step 4 スキップに伴い、本 Step を **3 段階リハーサル (Phase A 副作用ゼロ / Phase B 実起動 / Phase C rollback 試行)** に強化。検証用 Discord ギルド = 本番 Worker への切替を staging cutover の代替として扱う。

#### Step 6.0: 事前準備 (deploy 前)

- [ ] **本番 secret 投入** (Step 1.5 で `OIDC_PRIVATE_KEYS_JWK` 投入済、Step 2 で `OIDC_SUB` 投入済の場合スキップ):
  - `wrangler secret put OIDC_PRIVATE_KEYS_JWK` (本番用)
  - `wrangler secret put OIDC_SUB` (`discord-handler-<8 文字 random>`、決定13)
- [ ] **本番 `wrangler.toml [vars]` 更新** (まだ static のまま):
  - `AWS_OIDC_ROLE_ARN = "arn:aws:iam::123456789012:role/gs-worker-oidc-role"` (vars)
  - `AWS_AUTH_MODE` は **まだ未設定** (= static、現状維持)
- [ ] **`pnpm wrangler deploy`** で本番更新 (mode は static のまま、変化なし回帰確認)
- [ ] **検証ギルドで `/list` 1 回** 動作確認 (= 回帰なし、ここで失敗すれば AWS_OIDC_ROLE_ARN 追加経路自体に問題あり)

#### Step 6.A: Phase A — 副作用ゼロ確認 (oidc mode 切替直後)

- [ ] **`AWS_AUTH_MODE = "oidc"` に切り替え** ([vars] 編集 + `pnpm wrangler deploy`)
- [ ] **`wrangler tail` を開始**
- [ ] 検証ギルドで以下を順に試行 (= EC2 起動を伴わない describe 系のみ):
  - `/list` (KV `GAME_REGISTRY` 経由、AWS 呼び出し無しのため OIDC 経路には乗らない = 起点確認)
  - `/status` (= `ec2:DescribeInstances` のみ、OIDC credentials の最初の本物利用)
- [ ] **`wrangler tail` で確認** (各 1 件以上 observable):
  - STS `AssumeRoleWithWebIdentity` 呼び出しが発生
  - 短期 credentials の `expiration` が +900s
  - 2 回目の `/status` で KV cache hit になり STS が呼ばれない (cache hit ratio が正しく上がる)
- [ ] **失敗時の即時 rollback** (Phase B には進まず Step 6.D で復帰)

#### Step 6.B: Phase B — 実起動確認 (1 サイクル)

- [ ] ATM11 で `/start` → ready 通知到達まで待機
- [ ] `wrangler tail` で `ec2:RunInstances` / `ssm:SendCommand` / `ec2:DescribeInstances` が新 policy + 短期 credentials で成功することを観察
- [ ] サーバー接続テスト (Minecraft client から接続 1 回 = port + DNS 健全性)
- [ ] `/stop` → snapshot 完成 + volume cleanup まで観察 (cleanup cron は 5 min 後)
- [ ] **失敗時の即時 rollback** (Step 6.D)

#### Step 6.C: Phase C — cron + rollback 経路の確認

- [ ] **cron 経路**: ATM11 停止後 5〜10 min 待機し、`snapshot-retention` / `cleanup` cron が短期 credentials で完走することを `wrangler tail` で確認
- [ ] **rollback 経路の試行** (任意、自信が無ければ実施):
  - `AWS_AUTH_MODE` を `[vars]` から削除 + `pnpm wrangler deploy` (static 経路即時復帰)
  - `/status` で static creds 経路が動くことを確認
  - `AWS_AUTH_MODE = "oidc"` に再度戻して deploy (元に戻す)
  - **狙い**: Step 7 削除前なら rollback パスが live であることを実証 (Step 7 後は不可)

#### Step 6.D: 失敗時の rollback (Phase A / B 中の異常用)

- [ ] `wrangler.toml [vars]` で `AWS_AUTH_MODE` を削除 (or `"static"`)
- [ ] `pnpm wrangler deploy` で即時反映
- [ ] 旧 Access Key はまだ Inactive 化していないので static credentials がそのまま動く
- [ ] エラー内容を `wrangler tail` ログ + Discord `oidc-credential-fail` 通知から特定
- [ ] 修正 → Phase A から再リハーサル

#### Step 6.E: 2-3 日観察 (Phase A〜C 通過後)

平日/週末両方を見れるよう **最低 48h** 観察。

- [ ] Discord channel に新規 `oidc-credential-fail` / `oidc-cache-kv-put-fail` 通知ゼロ
- [ ] `/start` `/stop` `/status` `/list` 各 1 回以上成功 (週末を跨ぐ)
- [ ] cron が 3 周期以上完走 (snapshot-retention / cleanup / idle-fallback、ATM11 起動中のみ後者)
- [ ] STS API 呼び出し回数が想定通り (1h あたり数回、cron 5 min ごとに 1 回程度の cache hit を確認)

Worker コード変更: なし (deploy のみ)。Infra 変更: なし。

### Step 7: 旧 IAM Access Key の即削除 (24h 観察後)

セキュリティ重視で 1 週間 Inactive は採用せず、24h 安定確認したら即削除する。**順序は時系列で固定** (決定17)。順序が崩れると「mode=static のままコード復活」rollback の整合性が壊れる。

- [ ] **Step 7.0: 24h 観察** (Step 6 cutover 後、Step 6 チェックリストの最低 1 周期):
  - エラー通知ゼロ
  - `/start` `/stop` 各 1 回以上成功
  - cron 3 周期以上完走

#### Step 7.1 + 7.2: Worker Secret 削除 + static 経路コード削除 (atomic 実行)

**重要**: 7.1 単独で Secret を削除した直後に `AWS_AUTH_MODE = "static"` に切替えると、`env.AWS_ACCESS_KEY_ID` が undefined のまま aws4fetch が空文字 credentials で署名し、AWS 側で「不正な署名」エラーが大量発生する dead window が生じる。**7.1 と 7.2 はユーザー手元で連続実行**し、その間に mode 切替操作を絶対にしないこと。

- [x] **7.1.a (準備)**: コード削除 commit (`f7f4595`) を事前に master HEAD に置く (単独 dev のため PR レビューは無し、commit を deploy 直前まで反映しない運用)
- [x] **7.1.b**: `wrangler secret delete AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` 完了 (2026-05-24)
- [x] **7.2.a**: 即 `pnpm wrangler deploy` で commit `f7f4595` 反映 (OIDC-only コード)
- [x] **7.2.b** (`f7f4595`): `env.ts` から AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_AUTH_MODE 削除、OIDC_* 系を必須化、`credentials.ts` static 経路完全削除、test 3 件削除 (115/115 pass)、`wrangler.toml` から AWS_AUTH_MODE 行削除
- [x] deploy 後: コード上 OIDC 専用、`grep AWS_ACCESS_KEY_ID` で hit ゼロ確認

#### Step 7.3: AWS Access Key 削除 (Worker からもう使われない)
- [x] `aws iam list-access-keys --user-name gs-worker-caller` で削除対象 ID を特定
- [x] `aws iam delete-access-key --user-name gs-worker-caller --access-key-id <AKIA...>` 実行完了 (2026-05-24)

#### Step 7.4: IAM user / 旧 policy 削除 (Terraform、commit `59ba03a`)
- [x] `infra/envs/prod/iam.tf` から `aws_iam_user.gs_worker_caller` + `aws_iam_policy.gs_worker_caller` + `aws_iam_user_policy_attachment.gs_worker_caller` + `data.aws_iam_policy_document.gs_worker_caller` 削除
- [x] `terraform plan`: `Plan: 0 to add, 0 to change, 3 to destroy.` 確認
- [x] `terraform apply` 完了 (2026-05-24、ユーザー実行)
- [x] **rollback 不可確定**。再活性化は新 Access Key 発行 + Secret 再投入 + コード revert の手動 1h コース

Worker コード変更: **あり (static 経路削除、commit `f7f4595`)**。Infra 変更: **あり (IAM user 削除、commit `59ba03a`)**。**Step 7 完了 (2026-05-24)**。

### Step 8: 鍵 rotation runbook + ドキュメント整備

- [x] **`docs/runbook-phase5-oidc.md`** (Step 2.5.0 で初稿、Step 8 で拡充):
  - **§0** 事前確認 (Env=prod tag backfill)
  - **§1** 定期 rotation 手順 (90s 待機 + multi-kid 並走)
  - **§2** 緊急 rotation 方式 A (sub 上書き、5〜10min 復旧)
  - **§3** JWKS thumbprint 検証 (半期に 1 回)
  - **§4** Workers Rate Limiting 導入手順 (DoS 兆候時)
  - **§5** rollback (Step 7 削除前のみ有効)
  - 残: ~~Staging 用 rotation 手順~~ → Phase 6 で staging 立てる際に追加
  - 残: ~~6 ヶ月定期 rotation の元 design 詳細~~ → 上記 runbook §1 のとおり実装、本計画書は完了として処理
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
- [x] **`docs/design.md` 更新** (本 Step で実施):
  - §4.4: AWS 行を `OIDC token + STS AssumeRole (15min)` に
  - §5.6: Phase 1 Access Key 記述削除、OIDC role + policy 構成を記載
  - §10 Phase 5: checkbox 全 [x]、policy tightening の達成も明記
- [x] **`docs/iac-migration-plan.md`** (本 Step): `gs-worker-caller` Access Key が IaC 管理外だった注記を「Phase 5 で廃止」に書き換え
- [x] **CLAUDE.md** (本 Step): 秘密情報セクションの AWS Access Key 行を「(廃止済、過去 Phase 1〜4)」に
- [x] **`workers/discord-handler/src/env.ts`** (Step 7.2 で対応済): AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_AUTH_MODE 削除、OIDC_* 必須化
- [x] **メモ更新** (本 Step):
  - `phase-roadmap-2026-05-23.md`: Phase 5 完了反映 (Phase 6 へ)
  - 新規メモ 4 件: [[aws-policy-context-instance-only]] [[aws-snapshot-arn-account-less]] [[aws-policy-simulate-false-positive]] [[workers-secret-read-via-trust-policy]]
- [ ] **Cloudflare WAF IaC 化検討メモ**: `infra/cloudflare/` 配下に Terraform で WAF rule (`/oidc/*` rate limit) を入れるか検討。**Phase 6 以降の追加課題として記録** (本 Phase では `*.workers.dev` zone WAF 不可 + Workers Rate Limiting API は DoS 兆候出現後に導入する方針、runbook §4 参照)

Worker コード変更: なし (docs のみ)。**Step 8 完了 (2026-05-24)**。

---

## 完了基準

- [x] `gs-worker-caller` IAM user が AWS から削除された (Terraform state にも残らない、commit `59ba03a`)
- [x] Workers Secrets から `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` が削除された (Step 7.1.b)
- [x] `AWS_AUTH_MODE` は env.ts から削除済 (Step 7.2、commit `f7f4595`)
- [x] `gs-worker-oidc-policy` が tag / LT / instance type 条件付き、wildcard `Resource = "*"` を持つ statement は Describe 系 + GetCommandInvocation のみ (AWS API 制約)
- [x] ATM11 で `/start` `/stop` `/status` `/list` の各成功実績 (Step 6.B/E、2.3h 観察期間で全部通過)
- [x] cron (snapshot-retention / cleanup / idle-fallback) が異常なく回った (Step 6.C で実機確認、cleanup の InvalidVolume.NotFound bug は commit `d339e9b` で fix 済)
- [x] `pnpm typecheck` / `pnpm test` (115/115) / `pnpm build` 通過 (Step 7.2 で確認)
- [x] `docs/design.md` §4.4 / §5.6 / §10 が新方式で更新済 (本 Step、§0 threat model は phase5-plan §0 を正本として参照)
- [x] `docs/runbook-phase5-oidc.md` に事前確認 / 定期 rotation / 緊急 rotation / thumbprint 検証 / rate limit / rollback の全手順が残っている (本 Step で §0〜§5 完成)
- [-] ~~Staging Worker (`discord-handler-staging`) が引き続き利用可能~~ → Step 4 skip により unrelated、Phase 6 で立てる際に rev7 の判断を踏襲

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
