@echo off
chcp 437 >nul 2>nul
setlocal EnableExtensions
cd /d "%~dp0"
title [HHH_MYBOT] Zero-Conflict Safe SSD Cleanup

set "REPO_ROOT=%~dp0"
if "%REPO_ROOT:~-1%"=="\" set "REPO_ROOT=%REPO_ROOT:~0,-1%"

set "NODE_SKIP_PLATFORM_CHECK=1"
set "PROJECT_ROOT=%REPO_ROOT%"
set "PM2_HOME=%REPO_ROOT%\.runtime\pm2"
set "TEMP=%REPO_ROOT%\.runtime\temp"
set "TMP=%REPO_ROOT%\.runtime\temp"
set "PATH=%REPO_ROOT%\.runtime\bin\node;%REPO_ROOT%\.runtime\bin;%PATH%"

set "NODE_EXE="
if exist "%REPO_ROOT%\.runtime\bin\node\node.exe" set "NODE_EXE=%REPO_ROOT%\.runtime\bin\node\node.exe"
if not defined NODE_EXE (
  for /f "delims=" %%N in ('where node 2^>nul') do (
    set "NODE_EXE=%%N"
    goto :run_clean
  )
)

:run_clean
if not defined NODE_EXE (
  echo [ERROR] Khong tim thay Node.js. Vui long chay install.bat truoc.
  pause
  exit /b 1
)

echo ================================================================
echo       DON DEP BO NHO SSD AN TOAN (KHONG XUNG DOT DU LIEU)
echo ================================================================
"%NODE_EXE%" "%REPO_ROOT%\scripts\deep-clean-ssd.js" %*
echo.
if /i not "%~1"=="--no-pause" pause
exit /b 0
