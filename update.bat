@echo off
chcp 437 >nul 2>nul
setlocal EnableExtensions
cd /d "%~dp0"
title [HHH_MYBOT] One-Click Safe Update

set "REPO_ROOT=%~dp0"
if "%REPO_ROOT:~-1%"=="\" set "REPO_ROOT=%REPO_ROOT:~0,-1%"

set "NODE_SKIP_PLATFORM_CHECK=1"
set "PROJECT_ROOT=%REPO_ROOT%"
set "PM2_HOME=%REPO_ROOT%\.runtime\pm2"
set "TEMP=%REPO_ROOT%\.runtime\temp"
set "TMP=%REPO_ROOT%\.runtime\temp"
set "PATH=%REPO_ROOT%\.runtime\bin\node;%REPO_ROOT%\.runtime\bin;%PATH%"

if not exist "%TEMP%" mkdir "%TEMP%" >nul 2>nul
if not exist "%PM2_HOME%" mkdir "%PM2_HOME%" >nul 2>nul

echo ================================================================
echo              HHH_MYBOT ONE-CLICK SAFE UPDATE
echo ================================================================
echo Repository: %REPO_ROOT%
echo.
echo Chon che do cap nhat:
echo  [1] Day ban cap nhat V4 len VPS Ubuntu (1-Click Auto Update VPS) [Mac dinh]
echo  [2] Cap nhat ban Node.js chay cuc bo tren may nay
echo.
set "CHOICE="
set /p "CHOICE=Nhap lua chon (1 hoac 2) [1]: "
if "%CHOICE%"=="2" goto :run_local_update

if exist "%REPO_ROOT%\DAY_LEN_VPS.bat" (
  call "%REPO_ROOT%\DAY_LEN_VPS.bat"
  exit /b %ERRORLEVEL%
)

:run_local_update
where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Khong tim thay Git trong PATH.
  goto :failed
)

set "NODE_EXE="
if exist "%REPO_ROOT%\.runtime\bin\node\node.exe" set "NODE_EXE=%REPO_ROOT%\.runtime\bin\node\node.exe"
if not defined NODE_EXE (
  for /f "delims=" %%N in ('where node 2^>nul') do (
    set "NODE_EXE=%%N"
    goto :node_ok
  )
)
:node_ok
if not defined NODE_EXE (
  echo [ERROR] Khong tim thay Node.js. Vui long chay install.bat truoc.
  goto :failed
)

if not exist ".git" (
  echo [ERROR] Thu muc nay khong phai la Git repository.
  goto :failed
)

echo [BOOTSTRAP] Dang tai ban cap nhat moi nhat tu origin/master...
call git fetch origin master
if errorlevel 1 (
  echo [ERROR] Khong the fetch tu origin/master. Kiem tra ket noi mang hoac Git remote.
  goto :failed
)

if not exist "scripts\update-bootstrap.js" (
  echo [ERROR] scripts\update-bootstrap.js not found ^(Khong tim thay scripts\update-bootstrap.js^).
  goto :failed
)

"%NODE_EXE%" "scripts\update-bootstrap.js" --root "%REPO_ROOT%" --skip-restart
set "UPDATE_EXIT=%errorlevel%"
if not "%UPDATE_EXIT%"=="0" goto :failed

echo.
echo ================================================================
echo [UPDATE COMPLETE] CAP NHAT HOAN TAT 100%%! DU LIEU BOT DUOC BAO TOAN AN TOAN.
echo Hay bam run.bat 1 lan nua de chay lai toan bo he thong!
echo ================================================================
pause
exit /b 0

:failed
echo.
echo ================================================================
echo [UPDATE FAILED] CAP NHAT THAT BAI. XEM CHI TIET LOI O TREN. HE THONG DA AN TOAN.
echo ================================================================
pause
exit /b 1
