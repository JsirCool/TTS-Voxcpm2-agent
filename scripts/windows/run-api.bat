@echo off
setlocal

call "%~dp0_env.bat"
if errorlevel 1 exit /b %errorlevel%

title tts-harness API
cd /d "%ROOT%"

set "ALL_PROXY="
set "HTTP_PROXY="
set "HTTPS_PROXY="

echo Starting API on http://127.0.0.1:%API_PORT%
"%VENV_PY%" -m uvicorn server.api.main:app --host 127.0.0.1 --port %API_PORT% --env-file "%ROOT%\.env"
exit /b %errorlevel%
