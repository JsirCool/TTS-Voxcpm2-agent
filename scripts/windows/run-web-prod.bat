@echo off
setlocal

call "%~dp0_desktop_env.bat"
if errorlevel 1 exit /b %errorlevel%

set "LOG_DIR=%HARNESS_DESKTOP_ROOT%\logs"
set "LOG_FILE=%LOG_DIR%\web.log"
set "CONSOLE_MODE=0"
if /I "%~1"=="--console" set "CONSOLE_MODE=1"

title tts-harness Web (desktop)
pushd "%ROOT%\web"

set "NEXT_PUBLIC_API_URL=http://127.0.0.1:%API_PORT%"
set "HOSTNAME=127.0.0.1"
set "PORT=%WEB_PORT%"

if not exist ".next\standalone\server.js" (
    echo Building production web bundle...
    if "%CONSOLE_MODE%"=="1" (
        %WEB_PM% --dir "%ROOT%\web" build
    ) else (
        %WEB_PM% --dir "%ROOT%\web" build >> "%LOG_FILE%" 2>&1
    )
    if errorlevel 1 (
        popd
        exit /b %errorlevel%
    )
)

if "%CONSOLE_MODE%"=="1" (
    "%NODE_EXE%" ".next\standalone\server.js"
) else (
    "%NODE_EXE%" ".next\standalone\server.js" >> "%LOG_FILE%" 2>&1
)
set "ERR=%ERRORLEVEL%"
popd
exit /b %ERR%
