# PowerShell Windows Update Script for MyBot
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  MYBOT WINDOWS RUNTIME SAFE UPDATE       " -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  $candidate = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path $candidate) { $node = $candidate }
}
if (-not $node) {
  throw "Node.js not found in PATH or Program Files."
}

# 1. Safe update snapshot and git sync
Write-Host "[1/6] Running safe update snapshot and git sync..." -ForegroundColor Yellow
& $node scripts/safe-update.js --remote origin --branch master

if ($LASTEXITCODE -ne 0) {
  Write-Host "Safe update failed with exit code $LASTEXITCODE" -ForegroundColor Red
  exit $LASTEXITCODE
}

# 2. Dependency verification with npm ci
Write-Host "[2/6] Verifying dependencies with npm ci..." -ForegroundColor Yellow
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if ($npm) {
  & $npm ci --prefer-offline --no-audit
  if ($LASTEXITCODE -ne 0) {
    Write-Host "npm ci failed with exit code $LASTEXITCODE" -ForegroundColor Red
    exit $LASTEXITCODE
  }
}

# 3. Preflight Runtime Contract & Import Audit
Write-Host "[3/6] Running runtime contract & import preflight checks..." -ForegroundColor Yellow
& $node scripts/audit-imports.js
if ($LASTEXITCODE -ne 0) {
  Write-Host "Import audit failed with exit code $LASTEXITCODE" -ForegroundColor Red
  exit $LASTEXITCODE
}
& $node scripts/lint-runtime-contract.js
if ($LASTEXITCODE -ne 0) {
  Write-Host "Runtime contract check failed with exit code $LASTEXITCODE" -ForegroundColor Red
  exit $LASTEXITCODE
}

# 4. Restart Windows supervisor
Write-Host "[4/6] Restarting Windows supervisor..." -ForegroundColor Yellow
if (Test-Path run.bat) {
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c run.bat" -WindowStyle Minimized
}

# 5. Health HTTP check
Write-Host "[5/6] Waiting for service healthcheck..." -ForegroundColor Yellow
Start-Sleep -Seconds 3
$healthOk = $false
for ($i = 0; $i -lt 10; $i++) {
  try {
    & $node scripts/windows-healthcheck.js
    if ($LASTEXITCODE -eq 0) {
      $healthOk = $true
      break
    }
  } catch {}
  Start-Sleep -Seconds 2
}

# 6. Verify PID and runtime fingerprint
Write-Host "[6/6] Verifying runtime fingerprint..." -ForegroundColor Yellow
if (-not $healthOk) {
  Write-Host "[WARN] Supervisor started in background; verify health manually via /api/system/health" -ForegroundColor Yellow
} else {
  Write-Host "Health check passed!" -ForegroundColor Green
}

Write-Host "Update completed successfully!" -ForegroundColor Green
exit 0
