@echo off
setlocal

call "%~dp0scripts\windows\_desktop_env.bat"
if errorlevel 1 goto :fail
set "OPEN_BROWSER=1"
if /I "%~1"=="--no-browser" set "OPEN_BROWSER=0"

echo [1/4] Starting desktop services in background...
wscript //nologo "%ROOT%\scripts\windows\launch-hidden.vbs" "%ROOT%\scripts\windows\run-voxcpm-svc-desktop.bat"
timeout /t 2 /nobreak >nul
wscript //nologo "%ROOT%\scripts\windows\launch-hidden.vbs" "%ROOT%\scripts\windows\run-whisperx-svc-desktop.bat"
timeout /t 2 /nobreak >nul
wscript //nologo "%ROOT%\scripts\windows\launch-hidden.vbs" "%ROOT%\scripts\windows\run-api-desktop.bat"
timeout /t 2 /nobreak >nul
wscript //nologo "%ROOT%\scripts\windows\launch-hidden.vbs" "%ROOT%\scripts\windows\run-web-prod.bat"

echo [2/4] Waiting for local services...
timeout /t 5 /nobreak >nul

if "%OPEN_BROWSER%"=="1" (
    echo [3/4] Opening browser...
    start "" "http://localhost:%WEB_PORT%"
) else (
    echo [3/4] Browser launch skipped.
)

echo [4/4] Desktop mode is starting.
echo.
echo Web:       http://localhost:%WEB_PORT%
echo API:       http://localhost:%API_PORT%
echo API Docs:  http://localhost:%API_PORT%/docs
echo Logs:      %HARNESS_DESKTOP_ROOT%\logs
echo Data:      %HARNESS_DESKTOP_ROOT%
echo.
echo Tip: first production web build may take a little longer.
echo Tip: use start-desktop-stack-debug.bat if you want visible windows.
exit /b 0

:fail
echo.
echo Desktop startup failed. Fix the error above and run this file again.
pause
exit /b 1
