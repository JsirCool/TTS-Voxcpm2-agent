@echo off
setlocal

call "%~dp0_desktop_env.bat"
if errorlevel 1 exit /b %errorlevel%

set "LOG_DIR=%HARNESS_DESKTOP_ROOT%\logs"
set "LOG_FILE=%LOG_DIR%\whisperx.log"
set "CONSOLE_MODE=0"
if /I "%~1"=="--console" set "CONSOLE_MODE=1"

title tts-harness WhisperX (desktop)
cd /d "%ROOT%"

if not defined HF_HUB_OFFLINE set "HF_HUB_OFFLINE=1"
if not defined TRANSFORMERS_OFFLINE set "TRANSFORMERS_OFFLINE=1"
if not defined HF_DATASETS_OFFLINE set "HF_DATASETS_OFFLINE=1"

echo Starting desktop WhisperX service on http://127.0.0.1:7860
echo Cache dir: %MODEL_CACHE_DIR%

if "%CONSOLE_MODE%"=="1" (
    "%VENV_PY%" -m uvicorn server:app --app-dir "%ROOT%\whisperx-svc" --host 127.0.0.1 --port 7860
) else (
    "%VENV_PY%" -m uvicorn server:app --app-dir "%ROOT%\whisperx-svc" --host 127.0.0.1 --port 7860 >> "%LOG_FILE%" 2>&1
)
exit /b %errorlevel%
