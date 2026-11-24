@echo off
chcp 437 >nul 2>nul
setlocal EnableExtensions
cd /d "%~dp0"
title [HHH_MYBOT] PM2 Fleet Launcher ^& Live Monitor

set "REPO_ROOT=%~dp0"
if "%REPO_ROOT:~-1%"=="\" set "REPO_ROOT=%REPO_ROOT:~0,-1%"

REM Windows Server 2012 R2 compatibility + Sandboxed Runtime Paths (Zero External Disk Leaks)
set "NODE_SKIP_PLATFORM_CHECK=1"
set "YOUTUBE_DL_SKIP_PYTHON_CHECK=1"
set "YOUTUBE_DL_SKIP_DOWNLOAD=1"
set "MYBOT_INTERACTIVE_CONSOLE=1"
if not defined MYBOT_RESOURCE_PROFILE set "MYBOT_RESOURCE_PROFILE=lean"
set "PROJECT_ROOT=%REPO_ROOT%"
set "PM2_HOME=%REPO_ROOT%\.runtime\pm2"
set "TEMP=%REPO_ROOT%\.runtime\temp"
set "TMP=%REPO_ROOT%\.runtime\temp"
set "PATH=%REPO_ROOT%\.runtime\bin\node;%REPO_ROOT%\.runtime\bin;%PATH%"

if not exist "%TEMP%" mkdir "%TEMP%" >nul 2>nul
if not exist "%PM2_HOME%" mkdir "%PM2_HOME%" >nul 2>nul

REM Auto-bootstrap if portable/system Node or node_modules/pm2 is missing
set "NODE_EXE="
if exist "%REPO_ROOT%\.runtime\bin\node\node.exe" set "NODE_EXE=%REPO_ROOT%\.runtime\bin\node\node.exe"
if not defined NODE_EXE (
  for /f "delims=" %%N in ('where node 2^>nul') do (
    set "NODE_EXE=%%N"
    goto :check_deps
  )
)
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"

:check_deps
if not defined NODE_EXE (
  echo [run.bat] Chua tim thay Node.js. Tu dong chay install.bat...
  call "%REPO_ROOT%\install.bat" --unattended
  if errorlevel 1 exit /b 1
  if exist "%REPO_ROOT%\.runtime\bin\node\node.exe" set "NODE_EXE=%REPO_ROOT%\.runtime\bin\node\node.exe"
)

if not exist "%REPO_ROOT%\node_modules\pm2\bin\pm2" (
  echo [run.bat] Chua cai dat day du node_modules. Tu dong chay install.bat...
  call "%REPO_ROOT%\install.bat" --unattended
  if errorlevel 1 exit /b 1
)

if not exist "%REPO_ROOT%\.env.local" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%REPO_ROOT%\scripts\windows-bootstrap-install.ps1" -Unattended -SkipDoctor
)

if /i "%~1"=="monitor" (
  "%NODE_EXE%" "%REPO_ROOT%\src\runtime\reconcile-and-monitor.js" --monitor-only
  exit /b %errorlevel%
)

if /i "%~1"=="stop" (
  "%NODE_EXE%" -e "import('./src/runtime/fleet-stop.js').then(m => m.stopMyBotFleetViaPM2({ projectRoot: process.cwd() })).then(r => console.log('Stopped:', r.stopped))"
  exit /b %errorlevel%
)

"%NODE_EXE%" "%REPO_ROOT%\src\runtime\reconcile-and-monitor.js"
set "RUN_EXIT=%errorlevel%"
if not "%RUN_EXIT%"=="0" (
  echo.
  echo [ERROR] Khoi dong he thong dung voi ma %RUN_EXIT%. Vui long xem thong bao phia tren va chay lai run.bat.
  pause
)
exit /b %RUN_EXIT%
