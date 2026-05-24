# aws-oidc-cloudflare

Cloudflare Workers から AWS への OIDC 信頼関係を構築する Terraform module。Worker 自身が
OIDC issuer (RS256 JWT 発行 + `/oidc/.well-known/jwks.json` 公開) で、AWS IAM がそれを信頼し、
`sts:AssumeRoleWithWebIdentity` で短期 credentials を発行する。

## 構成

- `aws_iam_openid_connect_provider`: Worker の OIDC issuer URL を AWS に登録
- `aws_iam_role`: Worker が assume する role。trust policy で aud/sub/iss/jti を多層検証

Policy attachment は **本 module の責務外**。env 側 (`infra/envs/prod/iam.tf` 等) で
`aws_iam_role_policy_attachment` を別途定義し、最小権限化された policy を attach する
(`gs-worker-oidc-policy` for prod, `gs-worker-oidc-staging-policy` for staging)。

## 使用例 (prod)

```hcl
module "worker_oidc" {
  source = "../../modules/aws-oidc-cloudflare"

  worker_issuer_url    = "https://discord-handler.<your-account>.workers.dev/oidc"
  thumbprints          = ["abcdef0123456789..."]  # scripts/get-cf-thumbprint.{sh,ps1} で取得
  expected_sub         = var.worker_oidc_sub      # tfvars に書かず -var で渡す
  role_name            = "gs-worker-oidc-role"
  max_session_duration = 900
}

resource "aws_iam_role_policy_attachment" "worker_oidc" {
  role       = module.worker_oidc.role_name
  policy_arn = aws_iam_policy.gs_worker_oidc.arn
}
```

## thumbprint 取得

```sh
# bash
./scripts/get-cf-thumbprint.sh discord-handler.<your-account>.workers.dev
```

```powershell
# PowerShell
.\scripts\get-cf-thumbprint.ps1 -Host discord-handler.<your-account>.workers.dev
```

出力 (40 桁の lowercase hex、colon なし) を `thumbprints` 変数に list で渡す。

## 緊急 rotation (方式 A、apply 1 回で session 無効化)

漏洩疑い時:

```sh
cd infra/envs/prod
terraform apply -var="worker_oidc_sub=REVOKED-$(date +%s)"
```

これで trust policy の sub condition が漏洩した値と一致しなくなり、全 in-flight session が
即時無効化される。続いて新鍵生成 + 新 `OIDC_SUB` Secret 投入後、`-var="worker_oidc_sub=<新値>"`
で再 apply して復旧 (詳細 docs/phase5-plan.md Step 8)。

**注: `-var` で渡し、tfvars には書かない**。terraform の plan/apply 出力には sensitive=true により
マスクされるが、tfvars 経由だと git 履歴に残るリスクがある。

## 関連ドキュメント

- [docs/phase5-plan.md](../../../docs/phase5-plan.md) — Phase 5 全体
- [docs/runbook-phase5-oidc.md](../../../docs/runbook-phase5-oidc.md) — cutover / rotation / 緊急対応
