@echo off
setlocal

call "%~dp0_desktop_env.bat"
if errorlevel 1 exit /b %errorlevel%

set "LOG_DIR=%HARNESS_DESKTOP_ROOT%\logs"
set "LOG_FILE=%LOG_DIR%\api.log"
set "CONSOLE_MODE=0"
if /I "%~1"=="--console" set "CONSOLE_MODE=1"

title tts-harness API (desktop)
cd /d "%ROOT%"

set "ALL_PROXY="
set "HTTP_PROXY="
set "HTTPS_PROXY="

echo Starting desktop API on http://127.0.0.1:%API_PORT%
if "%CONSOLE_MODE%"=="1" (
    "%VENV_PY%" -m uvicorn server.api.main:app --host 127.0.0.1 --port %API_PORT%
) else (
    "%VENV_PY%" -m uvicorn server.api.main:app --host 127.0.0.1 --port %API_PORT% >> "%LOG_FILE%" 2>&1
)
exit /b %errorlevel%
