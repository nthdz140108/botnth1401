<#
.SYNOPSIS
    MyBot Hybrid Runner (Node V3 Engine + Rust V4 Dashboard)
.DESCRIPTION
    Launches MyBot in Hybrid Mode:
    - Node.js V3 runtime manages all 218 canonical commands & 181 aliases (399 keys), Zalo sessions, socket listeners, and PM2 bots.
    - Node Bridge Service runs on 127.0.0.1:4174 (loopback HMAC).
    - Rust V4 mybotd runs as the Central Dashboard on port 4173 with --node-hybrid flag.
#>

param(
    [switch]$NoReconcile,
    [switch]$SkipRust,
    [int]$DashboardPort = 4173,
    [int]$BridgePort = 4174
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  MyBot Hybrid Architecture: Node V3 Engine + Rust V4 UI  " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. State Reconciliation Audit
if (-not $NoReconcile) {
    Write-Host "`n[1/4] Running Node <-> SQLite state reconciliation audit..." -ForegroundColor Yellow
    & node "scripts/reconcile-node-rust-state.js" --dry-run
}

# 2. Start Node Bridge Daemon (Loopback HMAC)
Write-Host "`n[2/4] Starting Node Loopback Bridge on port $BridgePort..." -ForegroundColor Yellow
$env:MYBOT_BRIDGE_PORT = $BridgePort.ToString()
$bridgeProcess = Start-Process -FilePath "node" -ArgumentList "src/dashboard/node-bridge-service.js" -PassThru -WindowStyle Hidden
Write-Host "  Node Bridge PID: $($bridgeProcess.Id) on http://127.0.0.1:$BridgePort" -ForegroundColor Green

# 3. Start Node Bot Fleet via PM2
Write-Host "`n[3/4] Reconciling and starting Node bot fleet under PM2..." -ForegroundColor Yellow
$env:NODE_SKIP_PLATFORM_CHECK = "1"
$env:MYBOT_RESOURCE_PROFILE = "lean"
$env:PM2_HOME = Join-Path $projectRoot ".runtime\pm2"
$env:PATH = "$(Join-Path $projectRoot '.runtime\bin\node');$(Join-Path $projectRoot '.runtime\bin');$env:PATH"

# 4. Start Rust V4 Central Dashboard in Hybrid Mode
if (-not $SkipRust) {
    Write-Host "`n[4/4] Starting Rust V4 Central Dashboard in Hybrid Mode..." -ForegroundColor Yellow
    $env:MYBOT_NODE_HYBRID = "true"
    $env:MYBOT_BRIDGE_URL = "http://127.0.0.1:$BridgePort"
    $env:DASHBOARD_PORT = $DashboardPort.ToString()

    $rustBin = Join-Path $projectRoot "rust\target\release\mybotd.exe"
    if (-not (Test-Path $rustBin)) {
        $rustBin = Join-Path $projectRoot "rust\target\debug\mybotd.exe"
    }

    if (Test-Path $rustBin) {
        Write-Host "  Launching $rustBin --node-hybrid..." -ForegroundColor Green
        Start-Process -FilePath $rustBin -ArgumentList "--node-hybrid" -WindowStyle Normal
    } else {
        Write-Host "  Rust binary not pre-compiled. Run 'cargo build -p mybotd' in rust/ directory to compile." -ForegroundColor DarkYellow
    }
}

Write-Host "`nHybrid System Online! Dashboard URL: http://127.0.0.1:$DashboardPort" -ForegroundColor Cyan
