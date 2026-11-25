@echo off
chcp 65001 >nul
cd /d "%~dp0"
title MYBOT Cloud - Thiet lap portal
node deploy\portal-setup.mjs %*
set "PORTAL_EXIT=%ERRORLEVEL%"
pause
exit /b %PORTAL_EXIT%
