param(
  [ValidateSet('bot','dashboard','all')]
  [string]$Mode = 'all'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  $candidate = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path $candidate) { $node = $candidate }
}

if (-not $node) {
  throw 'Node.js not found.'
}

switch ($Mode) {
  'bot' { & $node bot.js; exit $LASTEXITCODE }
  'dashboard' { Start-Process -WindowStyle Hidden -FilePath $node -ArgumentList 'dashboard/server.js'; exit 0 }
  default {
    Start-Process -WindowStyle Hidden -FilePath $node -ArgumentList 'bot.js'
    Start-Process -WindowStyle Hidden -FilePath $node -ArgumentList 'dashboard/server.js'
    exit 0
  }
}
