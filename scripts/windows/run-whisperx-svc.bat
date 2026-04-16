@echo off
setlocal

call "%~dp0_env.bat"
if errorlevel 1 exit /b %errorlevel%

title tts-harness WhisperX
cd /d "%ROOT%"

if not defined HF_HUB_OFFLINE set "HF_HUB_OFFLINE=1"
if not defined TRANSFORMERS_OFFLINE set "TRANSFORMERS_OFFLINE=1"
if not defined HF_DATASETS_OFFLINE set "HF_DATASETS_OFFLINE=1"

echo Starting WhisperX service on http://127.0.0.1:7860
echo Cache dir: %MODEL_CACHE_DIR%
echo Offline mode: HF_HUB_OFFLINE=%HF_HUB_OFFLINE%

"%VENV_PY%" -m uvicorn server:app --app-dir "%ROOT%\whisperx-svc" --host 127.0.0.1 --port 7860
exit /b %errorlevel%
