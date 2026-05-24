# Cloudflare Worker の TLS cert chain から SHA-1 fingerprint を取得して
# Terraform の thumbprint_list 形式 (colon なし lowercase hex 40 桁) で出力する。
#
# 詳細: docs/phase5-plan.md Step 2、infra/modules/aws-oidc-cloudflare/README.md
#
# 使い方:
#   .\scripts\get-cf-thumbprint.ps1 -TargetHost discord-handler.<your-account>.workers.dev
#
# AWS は cert chain 内の任意の SHA-1 を受け付けるため、intermediate (Cloudflare Inc ECC CA-3 等) を
# 使うと leaf 証明書のローテーションで毎回 thumbprint 更新する必要がなくなる。

param(
  [Parameter(Mandatory = $true)]
  [string]$TargetHost
)

$ErrorActionPreference = 'Stop'

# TcpClient + SslStream で TLS handshake を実行し、サーバ証明書 chain を取得する。
$tcp = New-Object System.Net.Sockets.TcpClient($TargetHost, 443)
try {
  $sslStream = New-Object System.Net.Security.SslStream(
    $tcp.GetStream(), $false,
    { param($sender, $cert, $chain, $errors) return $true }
  )
  $sslStream.AuthenticateAsClient($TargetHost)

  # AuthenticateAsClient 後に X509Chain を再構築して chain 全 cert を取得する。
  $leafCert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($sslStream.RemoteCertificate)
  $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
  $chain.ChainPolicy.RevocationMode = 'NoCheck'
  $built = $chain.Build($leafCert)
  if (-not $built) {
    Write-Warning "Chain build had warnings, but proceeding (chain elements still usable for thumbprint extraction)"
  }

  $index = 0
  foreach ($element in $chain.ChainElements) {
    $cert = $element.Certificate
    $fp = $cert.GetCertHashString('SHA1').ToLower()  # colon なし、lowercase hex 40 桁
    switch ($index) {
      0 { $label = 'leaf        ' }
      1 { $label = 'intermediate' }
      default { $label = "cert #$index     " }
    }
    Write-Output "${label}: $fp ($($cert.Subject))"
    $index++
  }

  Write-Host ""
  Write-Host "Terraform 投入: 上記いずれかの fingerprint を thumbprints = [`"...`"] に貼る" -ForegroundColor Cyan
  Write-Host "推奨: 安定性の観点で intermediate (cert #1) を採用 (leaf は短期 rotation あり)" -ForegroundColor Cyan
}
finally {
  $tcp.Close()
}
