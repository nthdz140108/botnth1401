@echo off
setlocal EnableExtensions

echo ===================================================
echo   [LOCK-DATA] KHOA FILE DU LIEU RUNTIME TRANH GHI DE
echo ===================================================

git update-index --skip-worktree assets/data/group_settings.json 2>nul
git update-index --skip-worktree assets/json-data/command.json 2>nul
git update-index --skip-worktree assets/json-data/server-config.json 2>nul
git update-index --skip-worktree mybot/configs/vip-feature-flags.json 2>nul

echo [THANH CONG] Da khoa cac file du lieu runtime tren may nay!
echo.
echo LUU Y:
echo - mybot/defaultCommand.json KHONG con bi khoa: day la file SOURCE,
echo   ban cap nhat (update.bat) luon lay phien ban moi tu remote.
echo - lock-data.bat chi bao ve du lieu runtime. Cap nhat source PHAI di
echo   qua update.bat, KHONG dung git pull / git reset thu cong.
echo - update.bat tu he thong flag cu (skip-worktree) truoc khi reset va
echo   merge lai command.json voi phien ban remote, nen khong mat data.
echo.
pause
