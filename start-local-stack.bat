@echo off
setlocal

call "%~dp0scripts\windows\_env.bat"
if errorlevel 1 goto :fail

echo [1/5] Starting Docker infrastructure...
docker compose --env-file "%ROOT%\.env" -f "%ROOT%\docker\docker-compose.dev.yml" -p tts-harness up -d postgres minio minio-init
if errorlevel 1 goto :fail

echo [2/5] Running database migrations...
pushd "%ROOT%\server"
"%VENV_PY%" -m alembic upgrade head
if errorlevel 1 (
    popd
    goto :fail
)
popd

echo [3/5] Checking web dependencies...
if not exist "%ROOT%\web\node_modules\.bin\tsc.cmd" (
    echo Installing web dependencies with %WEB_PM%...
    pushd "%ROOT%\web"
    %WEB_PM% --dir "%ROOT%\web" install --registry=https://registry.yarnpkg.com --ignore-scripts
    if errorlevel 1 (
        popd
        goto :fail
    )
    popd
)

echo [4/5] Opening service windows...
start "tts-harness VoxCPM" cmd /k call "%ROOT%\scripts\windows\run-voxcpm-svc.bat"
timeout /t 2 /nobreak >nul
start "tts-harness WhisperX" cmd /k call "%ROOT%\scripts\windows\run-whisperx-svc.bat"
timeout /t 2 /nobreak >nul
start "tts-harness API" cmd /k call "%ROOT%\scripts\windows\run-api.bat"
timeout /t 2 /nobreak >nul
start "tts-harness Web" cmd /k call "%ROOT%\scripts\windows\run-web.bat"

echo [5/5] Opening browser...
timeout /t 5 /nobreak >nul
start "" "http://localhost:%WEB_PORT%"

echo.
echo Started successfully.
echo.
echo Web:       http://localhost:%WEB_PORT%
echo API:       http://localhost:%API_PORT%
echo API Docs:  http://localhost:%API_PORT%/docs
echo VoxCPM:    http://127.0.0.1:8877/healthz
echo WhisperX:  http://127.0.0.1:7860/healthz
echo MinIO:     http://localhost:%MINIO_CONSOLE_PORT%
echo.
echo Tip: WhisperX may need 10-60 seconds on first load.
echo To stop everything, double-click stop-local-stack.bat.
exit /b 0

:fail
echo.
echo Startup failed. Fix the error above and run this file again.
pause
exit /b 1
