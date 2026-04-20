@echo off
setlocal

call "%~dp0scripts\windows\_desktop_env.bat"
if errorlevel 1 exit /b %errorlevel%
set "PAUSE_AT_END=1"
if /I "%~1"=="--no-pause" set "PAUSE_AT_END=0"

echo Stopping desktop app processes on ports 3010 / 7860 / 8100 / 8877...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ports = %WEB_PORT%,7860,%API_PORT%,8877; " ^
  "foreach ($port in $ports) { " ^
  "  $pids = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; " ^
  "  foreach ($procId in $pids) { " ^
  "    try { Stop-Process -Id $procId -Force -ErrorAction Stop; Write-Host ('Stopped PID {0} on port {1}' -f $procId, $port) } catch {} " ^
  "  } " ^
  "}"

echo.
echo Desktop services stopped.
echo Logs remain in %HARNESS_DESKTOP_ROOT%\logs
if "%PAUSE_AT_END%"=="1" pause
exit /b 0
