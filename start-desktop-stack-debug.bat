@echo off
setlocal

call "%~dp0scripts\windows\_desktop_env.bat"
if errorlevel 1 goto :fail

echo Starting desktop services with visible consoles...
start "tts-harness VoxCPM" cmd /k ""%ROOT%\scripts\windows\run-voxcpm-svc-desktop.bat" --console"
timeout /t 2 /nobreak >nul
start "tts-harness WhisperX" cmd /k ""%ROOT%\scripts\windows\run-whisperx-svc-desktop.bat" --console"
timeout /t 2 /nobreak >nul
start "tts-harness API" cmd /k ""%ROOT%\scripts\windows\run-api-desktop.bat" --console"
timeout /t 2 /nobreak >nul
start "tts-harness Web" cmd /k ""%ROOT%\scripts\windows\run-web-prod.bat" --console"

timeout /t 5 /nobreak >nul
start "" "http://localhost:%WEB_PORT%"
echo.
echo Desktop services started in visible console windows.
exit /b 0

:fail
echo.
echo Desktop debug startup failed.
pause
exit /b 1
