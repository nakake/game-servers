# launcher/images/<game_id>/ を tar.gz 化して S3 にアップロードする。
#
# EC2 起動時の user-data (Worker `/start` が生成) が aws s3 cp で取得する。
# Phase 4 で AMI に焼き込み or GitHub Actions に移行する想定の繋ぎスクリプト.
#
# 使い方:
#   .\scripts\sync-launcher-to-s3.ps1 -GameId atm11
#   .\scripts\sync-launcher-to-s3.ps1 -GameId atm11 -AwsProfile gs-admin

[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)] [string]$GameId,
  [string]$BucketName = 'gs-game-configs',
  [string]$Region = 'ap-northeast-1',
  [string]$AwsProfile
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path $PSScriptRoot -Parent
$sourceDir = Join-Path $repoRoot "launcher/images/$GameId"
if (-not (Test-Path $sourceDir)) {
  throw "Launcher source not found: $sourceDir"
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$tarball = Join-Path $env:TEMP "gs-launcher-$GameId-$timestamp.tar.gz"
Write-Host "Creating tarball: $tarball" -ForegroundColor Cyan

Push-Location $sourceDir
try {
  # .env / .dev.vars / 検証用秘密鍵は誤アップロード防止のため明示除外
  tar --exclude='.env' `
      --exclude='.env.*' `
      --exclude='.dev.vars' `
      --exclude='.dev.vars.*' `
      --exclude='.discord-test-keypair.json' `
      --exclude='node_modules' `
      -czf $tarball .
} finally {
  Pop-Location
}

$size = (Get-Item $tarball).Length
Write-Host "Tarball size: $([math]::Round($size / 1KB, 1)) KB" -ForegroundColor Gray

$awsArgs = @(
  's3', 'cp', $tarball,
  "s3://$BucketName/launcher/$GameId.tar.gz",
  '--region', $Region
)
if ($AwsProfile) { $awsArgs += @('--profile', $AwsProfile) }

Write-Host "Uploading: aws $($awsArgs -join ' ')" -ForegroundColor Cyan
& aws @awsArgs
if ($LASTEXITCODE -ne 0) {
  throw "aws s3 cp failed with exit code $LASTEXITCODE"
}

Remove-Item $tarball
Write-Host "Done: s3://$BucketName/launcher/$GameId.tar.gz" -ForegroundColor Green
