output "role_arn" {
  description = "AssumeRoleWithWebIdentity の対象 IAM Role ARN。Worker の wrangler.toml [vars] AWS_OIDC_ROLE_ARN に設定する"
  value       = aws_iam_role.worker_oidc.arn
}

output "role_name" {
  description = "IAM Role 名。env 側で policy attach する際に参照する"
  value       = aws_iam_role.worker_oidc.name
}

output "oidc_provider_arn" {
  description = "OIDC Identity Provider の ARN。Role の trust policy で federated principal として使う (module 内で参照済) + 監視用"
  value       = aws_iam_openid_connect_provider.worker.arn
}

output "oidc_provider_url" {
  description = "登録した OIDC provider URL (= worker_issuer_url の値)。Step 8 thumbprint 検証で `openssl s_client` する対象"
  value       = aws_iam_openid_connect_provider.worker.url
}
