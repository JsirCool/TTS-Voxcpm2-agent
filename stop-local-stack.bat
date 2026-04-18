@echo off
setlocal

call "%~dp0scripts\windows\_env.bat"
if errorlevel 1 exit /b %errorlevel%

echo Stopping local app processes on ports 3010 / 7860 / 8100 / 8877...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ports = 3010,7860,8100,8877; " ^
  "foreach ($port in $ports) { " ^
  "  $pids = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; " ^
  "  foreach ($procId in $pids) { " ^
  "    try { Stop-Process -Id $procId -Force -ErrorAction Stop; Write-Host ('Stopped PID {0} on port {1}' -f $procId, $port) } catch {} " ^
  "  } " ^
  "}"

echo Stopping Docker infrastructure (containers will be kept for faster restart)...
docker compose --env-file "%ROOT%\.env" -f "%ROOT%\docker\docker-compose.dev.yml" -p tts-harness stop

echo.
echo Stopped.
echo Docker containers were stopped but not removed.
echo If you ever need a full cleanup, run:
echo docker compose --env-file "%ROOT%\.env" -f "%ROOT%\docker\docker-compose.dev.yml" -p tts-harness down
pause
exit /b 0
