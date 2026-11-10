# FORGE staging: turn on the connections James approved on 2026-11-10 ("i approve of the connections").
# Run from the FORGE folder:  powershell -ExecutionPolicy Bypass -File scripts\staging-connect.ps1
#
# Staging only. Every secret is typed or generated on this PC, sent straight to `wrangler secret put
# --env staging`, and never printed. Nothing here touches production, the Sales Worker or n8n.
#
#   1. MAILERLITE_API_KEY   read-only use today (ops.lifecycle_watch makes GET requests only)
#   2. HEARTBEAT_SECRET     new random 48-character value; you save it in 1Password for the n8n setup
#   3. Access service token lets n8n through Cloudflare Access to /api/v1/ingest/heartbeat only
#                           (owner routes still require an OWNER_EMAILS login, so the token cannot read anything)

$ErrorActionPreference = "Stop"
$Base = "https://forge-api-staging.sales-webhook.workers.dev"
$Wrangler = @("wrangler", "secret", "put")

function Read-Secret([string]$Prompt) {
  $s = Read-Host -Prompt $Prompt -AsSecureString
  return [System.Net.NetworkCredential]::new("", $s).Password.Trim()
}

function Put-Secret([string]$Name, [string]$Value) {
  $Value | npx @Wrangler $Name --env staging | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "wrangler secret put $Name failed" }
  Write-Host "  $Name set on forge-api-staging" -ForegroundColor Green
}

function Ask([string]$Q) { return (Read-Host "$Q [y/N]") -match '^(y|yes)$' }

if (-not (Test-Path "services\api\wrangler.toml")) { throw "Run this from the FORGE folder (C:\Users\jwste\OneDrive\Desktop\FORGE)." }
Push-Location services\api
try {
  # ---------------------------------------------------------------- 1. MailerLite
  Write-Host "`n1/3  MailerLite API key" -ForegroundColor Cyan
  Write-Host "  In MailerLite: Integrations -> API -> Generate new token, name it FORGE staging."
  Write-Host "  Save it in 1Password, then paste it here (input is hidden)."
  Start-Process "https://dashboard.mailerlite.com/integrations/api"
  $ml = Read-Secret "  MailerLite token"
  if ($ml.Length -lt 20) { throw "That token looks too short." }
  # Read-only check before storing: list one group.
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "https://connect.mailerlite.com/api/groups?limit=1" -Headers @{ Authorization = "Bearer $ml"; Accept = "application/json" }
    Write-Host "  MailerLite accepted the token (HTTP $($r.StatusCode))."
  } catch { throw "MailerLite rejected the token: $($_.Exception.Message)" }
  Put-Secret "MAILERLITE_API_KEY" $ml
  $ml = $null

  # ---------------------------------------------------------------- 2. Heartbeat secret
  Write-Host "`n2/3  Heartbeat secret (new random value)" -ForegroundColor Cyan
  $bytes = New-Object byte[] 36
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $hb = [Convert]::ToBase64String($bytes).Replace("+", "-").Replace("/", "_")   # 48 characters
  Put-Secret "HEARTBEAT_SECRET" $hb
  Set-Clipboard -Value $hb
  $hb = $null
  Write-Host "  The new value is on your clipboard. In 1Password create a Password item named"
  Write-Host "  'FORGE staging heartbeat secret' and paste it as the password."
  Read-Host "  Press Enter when it is saved (the clipboard is then cleared)" | Out-Null
  Set-Clipboard -Value " "

  # ---------------------------------------------------------------- 3. Access service token
  Write-Host "`n3/3  Cloudflare Access service token for n8n" -ForegroundColor Cyan
  Write-Host "  The Zero Trust page opens. Do these two things:"
  Write-Host "   a) Access -> Service credentials -> Create Service Token"
  Write-Host "      Name: forge-n8n-heartbeat   Duration: 1 year"
  Write-Host "      Save the Client ID and Client Secret in 1Password as 'FORGE n8n Access service token'."
  Write-Host "   b) Access -> Applications -> forge-api-staging -> Policies -> Add a policy"
  Write-Host "      Name: n8n heartbeat   Action: Service Auth   Include: Service Token = forge-n8n-heartbeat -> Save"
  Start-Process "https://one.dash.cloudflare.com/"
  Read-Host "  Press Enter when both are saved" | Out-Null

  if (Ask "  Test the token now? (paste Client ID and Secret, hidden; nothing is stored)") {
    $cid = Read-Secret "  Client ID"
    $csec = Read-Secret "  Client Secret"
    # An unsigned heartbeat: Access should let it through and the Worker should refuse it (401 bad signature).
    $code = 0; $body = ""
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$Base/api/v1/ingest/heartbeat" -MaximumRedirection 0 `
        -Headers @{ "CF-Access-Client-Id" = $cid; "CF-Access-Client-Secret" = $csec; "Content-Type" = "application/json" } -Body '{"probe":true}'
      $code = [int]$r.StatusCode; $body = $r.Content
    } catch {
      if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode
        try { $body = (New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() } catch {} }
    }
    $cid = $null; $csec = $null
    if ($code -eq 401 -and $body -match "bad signature") { Write-Host "  PASS: Access let the token through and FORGE checked the signature." -ForegroundColor Green }
    elseif ($code -in 301, 302, 303) { Write-Host "  FAIL: Access still redirects to login. Check the Service Auth policy on forge-api-staging." -ForegroundColor Red }
    else { Write-Host "  Unexpected answer: HTTP $code. Paste this line in the FORGE thread." -ForegroundColor Yellow }
  }

  Write-Host "`nDone. Secrets set (names only):" -ForegroundColor Cyan
  npx wrangler secret list --env staging
} finally { Pop-Location }
