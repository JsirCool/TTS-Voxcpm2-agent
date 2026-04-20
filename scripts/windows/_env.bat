@echo off

for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"

if not exist "%ROOT%\.env" (
    if exist "%ROOT%\.env.dev" (
        copy /y "%ROOT%\.env.dev" "%ROOT%\.env" >nul
    ) else (
        echo Missing %ROOT%\.env and %ROOT%\.env.dev
        exit /b 1
    )
)

for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ROOT%\.env") do (
    if not "%%~A"=="" set "%%~A=%%~B"
)

set "PYTHONPATH=%ROOT%"

if not defined VENV_PY (
    if exist "%ROOT%\runtime\python\python.exe" (
        set "VENV_PY=%ROOT%\runtime\python\python.exe"
    ) else (
        set "VENV_PY=E:\VC\venv312\Scripts\python.exe"
    )
)
if not exist "%VENV_PY%" (
    echo Missing Python runtime: %VENV_PY%
    echo Edit scripts\windows\_env.bat and set VENV_PY to your local python.exe.
    exit /b 1
)

if not defined API_PORT set "API_PORT=8100"
if not defined WEB_PORT set "WEB_PORT=3010"
if not defined MINIO_CONSOLE_PORT set "MINIO_CONSOLE_PORT=59001"
if not defined WEB_PM set "WEB_PM=pnpm"
if not defined NODE_EXE (
    if exist "%ROOT%\runtime\node\node.exe" (
        set "NODE_EXE=%ROOT%\runtime\node\node.exe"
    ) else (
        set "NODE_EXE=node"
    )
)

if not defined VOXCPM_MODEL_PATH set "VOXCPM_MODEL_PATH=E:\VC\pretrained_models\VoxCPM2"
if not defined VOXCPM_DEVICE set "VOXCPM_DEVICE=cuda:0"
if not defined VOXCPM_OPTIMIZE set "VOXCPM_OPTIMIZE=1"
if not defined VOXCPM_ENABLE_DENOISER set "VOXCPM_ENABLE_DENOISER=0"

if not defined HF_HOME set "HF_HOME=E:\VC\hf-cache"
if not defined HUGGINGFACE_HUB_CACHE set "HUGGINGFACE_HUB_CACHE=%HF_HOME%\hub"
if not defined TRANSFORMERS_CACHE set "TRANSFORMERS_CACHE=%HF_HOME%\hub"
if not defined MODEL_CACHE_DIR set "MODEL_CACHE_DIR=%HF_HOME%\hub"
if not defined WHISPER_MODEL set "WHISPER_MODEL=large-v3"
if not defined WHISPER_DEVICE set "WHISPER_DEVICE=cpu"
if not defined WHISPER_COMPUTE_TYPE set "WHISPER_COMPUTE_TYPE=int8"
if exist "%ROOT%\runtime\ffmpeg\bin" set "PATH=%ROOT%\runtime\ffmpeg\bin;%PATH%"

if not defined NO_PROXY set "NO_PROXY=localhost,127.0.0.1"
set "no_proxy=%NO_PROXY%"

if /I not "%HARNESS_SKIP_DOCKER_CHECK%"=="1" (
    where docker >nul 2>nul
    if errorlevel 1 (
        echo docker was not found in PATH.
        exit /b 1
    )
)

where %WEB_PM% >nul 2>nul
if errorlevel 1 (
    if not exist "%ROOT%\web\.next\standalone\server.js" (
        echo %WEB_PM% was not found in PATH.
        exit /b 1
    )
)

exit /b 0
