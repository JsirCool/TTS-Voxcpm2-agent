@echo off
setlocal

call "%~dp0_desktop_env.bat"
if errorlevel 1 exit /b %errorlevel%

set "LOG_DIR=%HARNESS_DESKTOP_ROOT%\logs"
set "LOG_FILE=%LOG_DIR%\voxcpm.log"
set "CONSOLE_MODE=0"
if /I "%~1"=="--console" set "CONSOLE_MODE=1"

title tts-harness VoxCPM (desktop)
cd /d "%ROOT%"

echo Starting desktop VoxCPM service on http://127.0.0.1:8877
echo Model path: %VOXCPM_MODEL_PATH%
if not exist "%VOXCPM_MODEL_PATH%" (
    echo WARNING: VOXCPM_MODEL_PATH does not exist yet.
)

if "%CONSOLE_MODE%"=="1" (
    "%VENV_PY%" -m uvicorn server:app --app-dir "%ROOT%\voxcpm-svc" --host 127.0.0.1 --port 8877
) else (
    "%VENV_PY%" -m uvicorn server:app --app-dir "%ROOT%\voxcpm-svc" --host 127.0.0.1 --port 8877 >> "%LOG_FILE%" 2>&1
)
exit /b %errorlevel%
