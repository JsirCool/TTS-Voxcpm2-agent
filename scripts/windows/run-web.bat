@echo off
setlocal

call "%~dp0_env.bat"
if errorlevel 1 exit /b %errorlevel%

title tts-harness Web
pushd "%ROOT%\web"

if not exist "node_modules\.bin\tsc.cmd" (
    echo Installing web dependencies with %WEB_PM%...
    %WEB_PM% --dir "%ROOT%\web" install --registry=https://registry.yarnpkg.com --ignore-scripts
    if errorlevel 1 (
        popd
        exit /b %errorlevel%
    )
)

set "NEXT_PUBLIC_API_URL=http://127.0.0.1:%API_PORT%"

echo Starting Web on http://127.0.0.1:%WEB_PORT%
%WEB_PM% --dir "%ROOT%\web" dev
set "ERR=%ERRORLEVEL%"
popd
exit /b %ERR%
