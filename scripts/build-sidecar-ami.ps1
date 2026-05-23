# Phase 3 Step 7: sidecar image を build → docker save → Packer で AMI に焼く orchestrator。
#
# 流れ:
#   1. launcher/sidecar の TS build (`npm run build`)
#   2. docker build --platform linux/amd64 (AMI が x86_64)
#   3. docker save → .build/sidecar-image.tar
#   4. packer init + packer build
#
# 完了後、AMI ID が Packer の output に表示される。次工程は SSM Parameter 書き換え:
#   aws ssm put-parameter --name /gs/ami/game-server-latest --value <new-ami-id> --overwrite
# (docs/runbook-phase3-sidecar.md Step 7 参照)。

[CmdletBinding()]
param(
  [string]$AmiVersion = "phase3-1",
  [string]$AwsRegion = "ap-northeast-1",
  [switch]$SkipNpmBuild
)
$ErrorActionPreference = "Stop"

$Root = (Resolve-Path "$PSScriptRoot\..").Path
$SidecarDir = Join-Path $Root "launcher\sidecar"
$AmiDir = Join-Path $Root "ami"
$BuildDir = Join-Path $Root ".build"
$TarPath = Join-Path $BuildDir "sidecar-image.tar"

function Write-Step([string]$msg) {
  Write-Host "==> $msg" -ForegroundColor Cyan
}

# Sanity check
foreach ($cmd in @("npm", "docker", "packer")) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "$cmd not found on PATH"
  }
}

# 1. sidecar TS build
if ($SkipNpmBuild) {
  Write-Step "Skipping npm build (--SkipNpmBuild)"
} else {
  Write-Step "Building sidecar (TypeScript)"
  Push-Location $SidecarDir
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
}

# 2. docker build (linux/amd64 固定)
Write-Step "docker build gs-sidecar:latest (linux/amd64)"
docker build --platform linux/amd64 -t gs-sidecar:latest $SidecarDir
if ($LASTEXITCODE -ne 0) { throw "docker build failed (exit $LASTEXITCODE)" }

# 3. docker save
Write-Step "docker save -> $TarPath"
New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null
if (Test-Path $TarPath) { Remove-Item $TarPath -Force }
docker save -o $TarPath gs-sidecar:latest
if ($LASTEXITCODE -ne 0) { throw "docker save failed (exit $LASTEXITCODE)" }
$tarSize = [math]::Round((Get-Item $TarPath).Length / 1MB, 1)
Write-Host "    tar size: $tarSize MB"

# 4. packer
# AWS 認証ブリッジ: Packer の AWS SDK は env からしか認証情報を読まない。CLI の login
# セッションを env に展開する (infra/tf.ps1 と同じ流儀)。
Write-Step "Bridging AWS credentials from CLI session to env"
Remove-Item Env:AWS_ACCESS_KEY_ID, Env:AWS_SECRET_ACCESS_KEY, Env:AWS_SESSION_TOKEN -ErrorAction SilentlyContinue
try { aws sts get-caller-identity *> $null } catch { }
if ($LASTEXITCODE -ne 0) {
  throw "AWS CLI のセッションが無効です。`aws sso login` 等で再認証してから再実行してください。"
}
$cred = aws configure export-credentials --format process | ConvertFrom-Json
$env:AWS_ACCESS_KEY_ID     = $cred.AccessKeyId
$env:AWS_SECRET_ACCESS_KEY = $cred.SecretAccessKey
if ($cred.SessionToken) { $env:AWS_SESSION_TOKEN = $cred.SessionToken }

Write-Step "packer init"
Push-Location $AmiDir
try {
  packer init game-server.pkr.hcl
  if ($LASTEXITCODE -ne 0) { throw "packer init failed (exit $LASTEXITCODE)" }

  Write-Step "packer build (AMI build, ~5-10 min)"
  packer build `
    -var "sidecar_tar_path=$TarPath" `
    -var "ami_version=$AmiVersion" `
    -var "aws_region=$AwsRegion" `
    game-server.pkr.hcl
  if ($LASTEXITCODE -ne 0) { throw "packer build failed (exit $LASTEXITCODE)" }
} finally {
  Pop-Location
  # 終了時に env から認証情報を消す (やがて失効するトークンを呼び出し元シェルに残さない)。
  Remove-Item Env:AWS_ACCESS_KEY_ID, Env:AWS_SECRET_ACCESS_KEY, Env:AWS_SESSION_TOKEN -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "AMI build complete." -ForegroundColor Green
Write-Host "Next steps (see docs/runbook-phase3-sidecar.md Step 7):" -ForegroundColor Yellow
Write-Host "  1. Copy the new AMI ID from the 'Builds finished' line above."
Write-Host "  2. Put it into the SSM Parameter that the Launch Template resolves:"
Write-Host "     aws ssm put-parameter --name /gs/ami/game-server-latest --value <ami-id> --type String --overwrite --region $AwsRegion"
Write-Host "  3. Verify the next /start uses the new AMI (Step 8: live verification)."
