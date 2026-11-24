@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title [HHH_MYBOT] Chan Doan He Thong (Win Server 2012 R2+)

set "REPO_ROOT=%~dp0"
if "%REPO_ROOT:~-1%"=="\" set "REPO_ROOT=%REPO_ROOT:~0,-1%"

set "NODE_SKIP_PLATFORM_CHECK=1"
set "PATH=%REPO_ROOT%\.runtime\bin\node;%REPO_ROOT%\.runtime\bin;%PATH%"

set "NODE_EXE="
if exist "%REPO_ROOT%\.runtime\bin\node\node.exe" set "NODE_EXE=%REPO_ROOT%\.runtime\bin\node\node.exe"
if not defined NODE_EXE (
  for /f "delims=" %%N in ('where node 2^>nul') do (
    set "NODE_EXE=%%N"
    goto :run_diag
  )
)
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"

:run_diag
if not defined NODE_EXE (
  echo [THONG BAO] Chua tim thay Node.js tren VPS hoac tai .runtime\bin\node.
  echo Dang tu dong chay install.bat de cai dat Node.js va moi truong...
  echo.
  call "%REPO_ROOT%\install.bat"
  if exist "%REPO_ROOT%\.runtime\bin\node\node.exe" set "NODE_EXE=%REPO_ROOT%\.runtime\bin\node\node.exe"
)

if defined NODE_EXE (
  "%NODE_EXE%" "%REPO_ROOT%\scripts\diagnose-vps.js"
) else (
  echo.
  echo [ERROR] Khong tim thay Node.js de chay chan doan. Vui long chay install.bat truoc!
)

echo.
pause
