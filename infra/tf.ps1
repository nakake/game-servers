# infra/tf.ps1 — Terraform ラッパー (Windows 作業マシン用)
#
# なぜ必要か:
#  1. このマシンの AWS CLI v2 はカスタム "login" 方式 (SSO セッション) で認証して
#     おり、Terraform の AWS provider が credential chain を直接解決できない。
#     `aws configure export-credentials` で解決済み認証情報を環境変数に渡す。
#  2. terraform.exe は winget 配置でパスが長く、手打ち/貼り付けで壊れやすい。
#
# 使い方 (リポジトリのどこからでも可):
#   .\infra\tf.ps1 plan -out=tfplan
#   .\infra\tf.ps1 apply tfplan
#   .\infra\tf.ps1 import <addr> <id>
#   .\infra\tf.ps1 output
#
# 実行ポリシーで弾かれる場合:
#   powershell -ExecutionPolicy Bypass -File .\infra\tf.ps1 <args...>

$ErrorActionPreference = 'Stop'

# 継承された AWS 認証 env を一旦消す。前回の tf.ps1 実行が呼び出し元シェルに残した
# 失効トークンを export-credentials が再利用してしまうのを防ぎ、必ず CLI の login
# セッションから取り直す。
Remove-Item Env:AWS_ACCESS_KEY_ID, Env:AWS_SECRET_ACCESS_KEY, Env:AWS_SESSION_TOKEN -ErrorAction SilentlyContinue

# --- AWS 認証ブリッジ (docs/iac-migration-plan.md Step 0 の運用メモ参照) ---
# export-credentials は失効間際のキャッシュをそのまま返すことがあり、その場合
# terraform 実行中に ExpiredToken で落ちる。先に get-caller-identity を一度呼んで
# CLI 側のセッション自動更新を促してから export する。
try { aws sts get-caller-identity *> $null } catch { }
if ($LASTEXITCODE -ne 0) {
  Write-Warning "AWS CLI のセッションが無効です。再ログインしてから再実行してください。"
}
$cred = aws configure export-credentials --format process | ConvertFrom-Json
$env:AWS_ACCESS_KEY_ID     = $cred.AccessKeyId
$env:AWS_SECRET_ACCESS_KEY = $cred.SecretAccessKey
if ($cred.SessionToken) { $env:AWS_SESSION_TOKEN = $cred.SessionToken }

# --- terraform.exe を解決 (PATH 優先、無ければ winget パッケージ配置) ---
$tf = (Get-Command terraform -ErrorAction SilentlyContinue).Source
if (-not $tf) {
  $tf = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Hashicorp.Terraform_*\terraform.exe" `
        -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $tf) { throw "terraform.exe not found (PATH / winget パッケージ配置のいずれにも無い)" }

# --- envs/prod を作業ディレクトリにして terraform 実行 ---
# 認証 env は terraform 実行中だけ有効にし、終了時に必ず消す (呼び出し元シェルに
# やがて失効する認証情報を残さない)。
$prodDir = Join-Path $PSScriptRoot 'envs\prod'
try {
  & $tf -chdir="$prodDir" @args
  $code = $LASTEXITCODE
} finally {
  Remove-Item Env:AWS_ACCESS_KEY_ID, Env:AWS_SECRET_ACCESS_KEY, Env:AWS_SESSION_TOKEN -ErrorAction SilentlyContinue
}
exit $code
