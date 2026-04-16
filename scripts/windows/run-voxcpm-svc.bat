@echo off
setlocal

call "%~dp0_env.bat"
if errorlevel 1 exit /b %errorlevel%

title tts-harness VoxCPM
cd /d "%ROOT%"

echo Starting VoxCPM service on http://127.0.0.1:8877
echo Model path: %VOXCPM_MODEL_PATH%
if not exist "%VOXCPM_MODEL_PATH%" (
    echo WARNING: VOXCPM_MODEL_PATH does not exist yet.
    echo Edit scripts\windows\_env.bat or .env before running again.
)

"%VENV_PY%" -m uvicorn server:app --app-dir "%ROOT%\voxcpm-svc" --host 127.0.0.1 --port 8877
exit /b %errorlevel%
