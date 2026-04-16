@echo off
setlocal

call "%~dp0scripts\windows\_env.bat"
if errorlevel 1 exit /b %errorlevel%

echo Stopping local app processes on ports 3010 / 7860 / 8100 / 8877...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ports = 3010,7860,8100,8877; " ^
  "foreach ($port in $ports) { " ^
  "  $pids = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; " ^
  "  foreach ($pid in $pids) { " ^
  "    try { Stop-Process -Id $pid -Force -ErrorAction Stop; Write-Host ('Stopped PID {0} on port {1}' -f $pid, $port) } catch {} " ^
  "  } " ^
  "}"

echo Stopping Docker infrastructure...
docker compose --env-file "%ROOT%\.env" -f "%ROOT%\docker\docker-compose.dev.yml" -p tts-harness down

echo.
echo Stopped.
pause
exit /b 0
