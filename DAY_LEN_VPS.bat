@echo off
chcp 65001 >nul
title [MYBOT V4] 1-Click Update VPS Ubuntu
cd /d "%~dp0"

echo ================================================================
echo           MYBOT V4 - 1-CLICK AUTO UPDATE VPS UBUNTU
echo ================================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [LOI] May nay chua cai Node.js hoac chua them Node.js vao PATH.
  echo Vui long cai dat Node.js tai https://nodejs.org/ roi chay lai.
  echo.
  pause
  exit /b 1
)

set "TARGET_DIR=%~dp0"
if exist "%~dp0deploy\push-to-vps.mjs" (
  set "TARGET_DIR=%~dp0"
) else if exist "%~dp0HHH_MYBOT-V3MYBOTQRLOGIN-main\deploy\push-to-vps.mjs" (
  set "TARGET_DIR=%~dp0HHH_MYBOT-V3MYBOTQRLOGIN-main\"
) else (
  echo [LOI] Khong tim thay deploy\push-to-vps.mjs.
  echo Vui long kiem tra lai thu muc du an.
  echo.
  pause
  exit /b 1
)

cd /d "%TARGET_DIR%"
node deploy\push-to-vps.mjs %*
set "DEPLOY_EXIT=%ERRORLEVEL%"

echo.
if "%DEPLOY_EXIT%"=="0" (
  echo ================================================================
  echo [THANH CONG] BOT DA DUOC CAP NHAT VA KHOI DONG LAI TREN VPS!
  echo Web Admin Dashboard: http://180.93.117.140:4173
  echo Tai khoan: admin
  echo Mat khau:  140108
  echo ================================================================
) else (
  echo ================================================================
  echo [THAT BAI] Qua trinh cap nhat VPS gap loi (ma loi: %DEPLOY_EXIT%).
  echo Vui long kiem tra thong bao loi o tren.
  echo ================================================================
)
echo.
pause
exit /b %DEPLOY_EXIT%
