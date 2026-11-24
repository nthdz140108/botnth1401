@echo off
chcp 65001 >nul
title [MYBOT V4] Incremental VPS Update
cd /d "%~dp0"

echo ================================================================
echo           MYBOT V4 - CAP NHAT VPS THEO COMMIT
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
if exist "%~dp0deploy\incremental-vps.mjs" (
  set "TARGET_DIR=%~dp0"
) else if exist "%~dp0HHH_MYBOT-V3MYBOTQRLOGIN-main\deploy\incremental-vps.mjs" (
  set "TARGET_DIR=%~dp0HHH_MYBOT-V3MYBOTQRLOGIN-main\"
) else (
  echo [LOI] Khong tim thay deploy\incremental-vps.mjs.
  echo Vui long kiem tra lai thu muc du an.
  echo.
  pause
  exit /b 1
)

cd /d "%TARGET_DIR%"
call node deploy\incremental-vps.mjs %*
set "DEPLOY_EXIT=%ERRORLEVEL%"

echo.
if "%DEPLOY_EXIT%"=="0" (
  echo ================================================================
  echo [OK] Lenh da hoan tat. Xem ket qua chi tiet o tren.
  echo ================================================================
) else (
  echo ================================================================
  echo [THAT BAI] Qua trinh cap nhat VPS gap loi, ma loi: %DEPLOY_EXIT%.
  echo Vui long kiem tra thong bao loi o tren.
  echo ================================================================
)
echo.
if "%~1"=="" pause
exit /b %DEPLOY_EXIT%
