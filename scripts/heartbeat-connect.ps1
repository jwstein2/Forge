# FORGE staging: one-command heartbeat connection. Nothing to type, nothing printed.
# Run from the FORGE folder:  powershell -ExecutionPolicy Bypass -File scripts\heartbeat-connect.ps1
#
# 1. Generates a new 48-character random HEARTBEAT_SECRET in memory.
# 2. Stores it in the n8n forge_config intake as heartbeat_secret (first, so a refusal changes nothing).
# 3. Only if n8n stored it: pipes it into `wrangler secret put HEARTBEAT_SECRET --env staging`.
# 4. Stores forge_api_base (not a secret) in forge_config.
# The value is never printed, written to disk, or put on the clipboard. Staging only.

$ErrorActionPreference = "Stop"
$Intake  = "https://james1854.app.n8n.cloud/webhook/forge-bootstrap-3e4236de-7bb2-4fad-91f5-40d3b5a9c0eb"
$ApiBase = "https://forge-api-staging.sales-webhook.workers.dev"

function Post-Config([string]$Key, [string]$Value) {
  $body = @{ key = $Key; value = $Value } | ConvertTo-Json -Compress
  try {
    $null = Invoke-RestMethod -Method Post -Uri $Intake -ContentType "application/json" -Body $body
    return "stored"
  } catch {
    $code = 0; if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code -eq 409) { return "refused (already stored, or wrong format)" }
    return "failed (HTTP $code)"
  } finally { $body = $null }
}

if (-not (Test-Path "services\api\wrangler.toml")) { throw "Run this from the FORGE folder (C:\Users\jwste\OneDrive\Desktop\FORGE)." }

$bytes = New-Object byte[] 36
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes); $rng.Dispose()
$hb = [Convert]::ToBase64String($bytes).Replace("+", "-").Replace("/", "_")   # 48 characters
[Array]::Clear($bytes, 0, $bytes.Length)

try {
  $n8n = Post-Config "heartbeat_secret" $hb
  Write-Host "n8n forge_config heartbeat_secret: $n8n"

  if ($n8n -eq "stored") {
    Push-Location services\api
    try {
      $hb | npx wrangler secret put HEARTBEAT_SECRET --env staging 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) { Write-Host "Worker forge-api-staging HEARTBEAT_SECRET: set" }
      else { Write-Host "Worker forge-api-staging HEARTBEAT_SECRET: failed (wrangler exit $LASTEXITCODE) - n8n now holds a value the Worker does not; tell the FORGE thread" }
    } finally { Pop-Location }
  } else {
    Write-Host "Worker forge-api-staging HEARTBEAT_SECRET: not changed (n8n did not store the new value)"
  }
} finally { $hb = $null }

Write-Host "n8n forge_config forge_api_base: $(Post-Config 'forge_api_base' $ApiBase)"
Write-Host "Done. Paste these lines into the FORGE thread."
