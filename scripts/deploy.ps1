# Deploys this checkout into the OpenCode plugin folders and reloads the proxy in
# place, with no service restart.
#
#   powershell -File scripts\deploy.ps1
#
# 1. refuses to copy anything if index.js or the panel does not parse
# 2. copies the proxy and the panel next to the other plugins
# 3. asks the running proxy to swap in the new code (POST /admin/reload)
# 4. waits until a different copy answers /status, and reports it
#
# A proxy older than the hot-reload endpoint has to be restarted once with
# `opencode service restart`; after that this script is all that is needed.
param(
  [string]$PluginDir = "$env:USERPROFILE\.config\opencode\plugins",
  [string]$Url = "http://127.0.0.1:17331"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

foreach ($file in @("$repo\index.js", "$repo\desktop-usage-panel\gui-experimental.cjs")) {
  node --check $file
  if ($LASTEXITCODE -ne 0) { throw "$file does not parse; nothing was deployed" }
}

$proxyDir = Join-Path $PluginDir "fasfas-proxy"
$panelDir = Join-Path $PluginDir "fasfas-usage"
New-Item -ItemType Directory -Force -Path $proxyDir, $panelDir | Out-Null
Copy-Item "$repo\index.js" (Join-Path $proxyDir "index.js") -Force
Copy-Item "$repo\desktop-usage-panel\*" $panelDir -Force
Write-Host "copied proxy and panel"

try {
  $before = (Invoke-RestMethod -Uri "$Url/status" -TimeoutSec 5).instance
} catch {
  Write-Host "proxy is not answering at $Url; files are in place and will load on the next start"
  exit 0
}
if (-not $before) {
  Write-Host "the running proxy predates hot reload. Run 'opencode service restart' once; later deploys need no restart."
  exit 0
}

try {
  Invoke-RestMethod -Method Post -Uri "$Url/admin/reload" -Headers @{ "x-fasfas-admin" = "1" } -TimeoutSec 5 | Out-Null
} catch {
  Write-Host "reload request failed: $($_.Exception.Message)"
  exit 1
}

$after = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  try { $after = (Invoke-RestMethod -Uri "$Url/status" -TimeoutSec 3).instance } catch { $after = $null }
  if ($after -and $after -ne $before) { break }
}

if ($after -and $after -ne $before) {
  Write-Host "reloaded: $before -> $after"
} else {
  Write-Host "no new copy answered within 10s; the old code is still serving (check .fasfas-proxy.log for 'hot reload aborted')"
  exit 1
}
