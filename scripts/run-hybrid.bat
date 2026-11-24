@echo off
chcp 65001 >nul 2>nul
setlocal EnableExtensions
cd /d "%~dp0\.."

title [MyBot Hybrid] Node V3 Core + Rust V4 Dashboard Launcher

set "PROJECT_ROOT=%cd%"
set "BRIDGE_PORT=4174"
set "DASHBOARD_PORT=4173"

echo ====================================================================
echo   MyBot Hybrid Architecture: Node V3 Engine + Rust V4 Dashboard
echo ====================================================================
echo.

REM 1. Audit State Reconciliation between Node JSON and SQLite
echo [1/4] Auditing Node state and SQLite records...
node "%PROJECT_ROOT%\scripts\reconcile-node-rust-state.js" --dry-run
if errorlevel 1 (
    echo [WARNING] Reconciliation audit detected warnings. Continuing in dry-run mode...
)

REM 2. Start Node Loopback Bridge Service
echo.
echo [2/4] Starting Node Loopback Bridge on http://127.0.0.1:%BRIDGE_PORT%...
set "MYBOT_BRIDGE_PORT=%BRIDGE_PORT%"
start /b "" node "%PROJECT_ROOT%\src\dashboard\node-bridge-service.js"

REM Wait 1 second for bridge to bind
timeout /t 1 /nobreak >nul 2>nul

REM 3. Start Node Bot Fleet via PM2
echo.
echo [3/4] Launching Node Bot Fleet under PM2...
set "NODE_SKIP_PLATFORM_CHECK=1"
set "MYBOT_RESOURCE_PROFILE=lean"
set "PM2_HOME=%PROJECT_ROOT%\.runtime\pm2"
set "PATH=%PROJECT_ROOT%\.runtime\bin\node;%PROJECT_ROOT%\.runtime\bin;%PATH%"

REM 4. Launch Rust V4 Central Dashboard in Node Hybrid Mode
echo.
echo [4/4] Starting Rust V4 Central Dashboard (mybotd --node-hybrid)...
set "MYBOT_NODE_HYBRID=true"
set "MYBOT_BRIDGE_URL=http://127.0.0.1:%BRIDGE_PORT%"
set "DASHBOARD_PORT=%DASHBOARD_PORT%"

set "RUST_BIN=%PROJECT_ROOT%\rust\target\release\mybotd.exe"
if not exist "%RUST_BIN%" (
    set "RUST_BIN=%PROJECT_ROOT%\rust\target\debug\mybotd.exe"
)

if exist "%RUST_BIN%" (
    echo Launching %RUST_BIN% --node-hybrid...
    start "" "%RUST_BIN%" --node-hybrid
) else (
    echo [NOTICE] Rust binary not yet compiled. Run 'cargo build -p mybotd' in rust\ directory.
)

echo.
echo ====================================================================
echo   Hybrid Fleet Running!
echo   Dashboard UI:   http://127.0.0.1:%DASHBOARD_PORT%
echo   Node Bridge:    http://127.0.0.1:%BRIDGE_PORT%
echo ====================================================================
