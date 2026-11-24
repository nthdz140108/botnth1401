@echo off
chcp 437 >nul 2>nul
setlocal EnableExtensions
cd /d "%~dp0"
title [HHH_MYBOT] One-Click Full Installer (Win Server 2012 R2+)

set "NODE_SKIP_PLATFORM_CHECK=1"
set "YOUTUBE_DL_SKIP_PYTHON_CHECK=1"
set "YOUTUBE_DL_SKIP_DOWNLOAD=1"
set "UNATTENDED_FLAG="
if /i "%~1"=="--unattended" set "UNATTENDED_FLAG=-Unattended"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows-bootstrap-install.ps1" %UNATTENDED_FLAG%
set "INSTALL_EXIT=%errorlevel%"

if not "%INSTALL_EXIT%"=="0" (
  echo.
  echo [ERROR] Cai dat gap loi ^(ma %INSTALL_EXIT%^). Vui long xem thong bao phia tren.
  if not defined UNATTENDED_FLAG pause
  exit /b %INSTALL_EXIT%
)

if not defined UNATTENDED_FLAG pause
exit /b 0
