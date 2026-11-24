@echo off
setlocal enabledelayedexpansion

REM Shared Windows Terminal Launcher for MyBot
REM Arguments: %1 = botKey, %2 = botUid (optional if botUid is %1 or set in env)

if not "%~2"=="" (
    set "BOT_KEY=%~1"
    set "BOT_UID=%~2"
) else if not "%~1"=="" (
    set "BOT_KEY=%~1"
    if not defined BOT_UID (
        set "BOT_UID=%~1"
    )
) else (
    if not defined BOT_UID (
        echo Error: botKey / botUid argument is required.
        exit /b 1
    )
)

if not defined BOT_NAME (
    if defined BOT_KEY (
        set "BOT_NAME=%BOT_KEY%"
    ) else (
        set "BOT_NAME=%BOT_UID%"
    )
)

if not defined MYBOT_INSTANCE_KIND (
    if "%BOT_UID%"=="admin" (
        set "MYBOT_INSTANCE_KIND=main"
    ) else (
        set "MYBOT_INSTANCE_KIND=child"
    )
)

if defined BOT_WINDOW_TITLE (
    title %BOT_WINDOW_TITLE%
) else (
    title MYBOT - %BOT_NAME% [%BOT_UID%]
)

if defined PROJECT_ROOT (
    cd /d "%PROJECT_ROOT%"
)

if defined NODE_EXEC_PATH (
    set "NODE_CMD=%NODE_EXEC_PATH%"
) else (
    set "NODE_CMD=node"
)

:RUN_LOOP
"%NODE_CMD%" src\bootstrap.js "%BOT_UID%"
set "EXIT_CODE=%ERRORLEVEL%"

if "%EXIT_CODE%"=="10" (
    "%NODE_CMD%" scripts\consume-restart-request.js "%BOT_UID%"
    if not errorlevel 1 goto DO_RESTART
)

goto END

:DO_RESTART
echo [LAUNCHER] Valid restart request detected for %BOT_UID%. Relaunching in current terminal...
goto RUN_LOOP

:END
endlocal
exit /b %EXIT_CODE%
