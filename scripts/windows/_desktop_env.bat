@echo off
setlocal

set "HARNESS_SKIP_DOCKER_CHECK=1"
call "%~dp0_env.bat"
if errorlevel 1 exit /b %errorlevel%

if not exist "%ROOT%\.desktop" mkdir "%ROOT%\.desktop" >nul 2>nul

if exist "%ROOT%\.desktop\desktop.env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ROOT%\.desktop\desktop.env") do (
        if not "%%~A"=="" set "%%~A=%%~B"
    )
)

set "HARNESS_DESKTOP_MODE=1"
set "TTS_USE_PREFECT=0"
set "STORAGE_MODE=local_fs"

if not defined HARNESS_DESKTOP_ROOT set "HARNESS_DESKTOP_ROOT=%ROOT%\.desktop-runtime"
if not defined HARNESS_LOCAL_STORAGE_DIR set "HARNESS_LOCAL_STORAGE_DIR=%HARNESS_DESKTOP_ROOT%\data\storage"
if not defined HARNESS_STORAGE_MIRROR_DIR set "HARNESS_STORAGE_MIRROR_DIR=%HARNESS_DESKTOP_ROOT%\storage-mirror"
if not defined HARNESS_VOICE_SOURCE_DIR set "HARNESS_VOICE_SOURCE_DIR=%ROOT%\..\voice_sourse"
if not defined HARNESS_AUDIO_PATH_ROOT set "HARNESS_AUDIO_PATH_ROOT=%ROOT%\.."
if not defined CORS_ORIGINS set "CORS_ORIGINS=http://127.0.0.1:%WEB_PORT%,http://localhost:%WEB_PORT%"
if not defined WHISPERX_URL set "WHISPERX_URL=http://127.0.0.1:7860"
if not defined VOXCPM_URL set "VOXCPM_URL=http://127.0.0.1:8877"

if not exist "%HARNESS_DESKTOP_ROOT%" mkdir "%HARNESS_DESKTOP_ROOT%" >nul 2>nul
if not exist "%HARNESS_DESKTOP_ROOT%\logs" mkdir "%HARNESS_DESKTOP_ROOT%\logs" >nul 2>nul
if not exist "%HARNESS_LOCAL_STORAGE_DIR%" mkdir "%HARNESS_LOCAL_STORAGE_DIR%" >nul 2>nul
if not exist "%HARNESS_VOICE_SOURCE_DIR%" mkdir "%HARNESS_VOICE_SOURCE_DIR%" >nul 2>nul

endlocal & (
    set "ROOT=%ROOT%"
    set "PATH=%PATH%"
    set "PYTHONPATH=%PYTHONPATH%"
    set "VENV_PY=%VENV_PY%"
    set "API_PORT=%API_PORT%"
    set "WEB_PORT=%WEB_PORT%"
    set "WEB_PM=%WEB_PM%"
    set "NODE_EXE=%NODE_EXE%"
    set "VOXCPM_MODEL_PATH=%VOXCPM_MODEL_PATH%"
    set "VOXCPM_DEVICE=%VOXCPM_DEVICE%"
    set "VOXCPM_OPTIMIZE=%VOXCPM_OPTIMIZE%"
    set "VOXCPM_ENABLE_DENOISER=%VOXCPM_ENABLE_DENOISER%"
    set "HF_HOME=%HF_HOME%"
    set "HUGGINGFACE_HUB_CACHE=%HUGGINGFACE_HUB_CACHE%"
    set "TRANSFORMERS_CACHE=%TRANSFORMERS_CACHE%"
    set "MODEL_CACHE_DIR=%MODEL_CACHE_DIR%"
    set "WHISPER_MODEL=%WHISPER_MODEL%"
    set "WHISPER_DEVICE=%WHISPER_DEVICE%"
    set "WHISPER_COMPUTE_TYPE=%WHISPER_COMPUTE_TYPE%"
    set "HF_HUB_OFFLINE=%HF_HUB_OFFLINE%"
    set "TRANSFORMERS_OFFLINE=%TRANSFORMERS_OFFLINE%"
    set "HF_DATASETS_OFFLINE=%HF_DATASETS_OFFLINE%"
    set "NO_PROXY=%NO_PROXY%"
    set "no_proxy=%no_proxy%"
    set "HTTP_PROXY=%HTTP_PROXY%"
    set "HTTPS_PROXY=%HTTPS_PROXY%"
    set "ALL_PROXY=%ALL_PROXY%"
    set "DATABASE_URL=%DATABASE_URL%"
    set "MINIO_BUCKET=%MINIO_BUCKET%"
    set "HARNESS_API_TOKEN=%HARNESS_API_TOKEN%"
    set "HARNESS_DESKTOP_MODE=%HARNESS_DESKTOP_MODE%"
    set "TTS_USE_PREFECT=%TTS_USE_PREFECT%"
    set "STORAGE_MODE=%STORAGE_MODE%"
    set "HARNESS_DESKTOP_ROOT=%HARNESS_DESKTOP_ROOT%"
    set "HARNESS_LOCAL_STORAGE_DIR=%HARNESS_LOCAL_STORAGE_DIR%"
    set "HARNESS_STORAGE_MIRROR_DIR=%HARNESS_STORAGE_MIRROR_DIR%"
    set "HARNESS_VOICE_SOURCE_DIR=%HARNESS_VOICE_SOURCE_DIR%"
    set "HARNESS_AUDIO_PATH_ROOT=%HARNESS_AUDIO_PATH_ROOT%"
    set "CORS_ORIGINS=%CORS_ORIGINS%"
    set "WHISPERX_URL=%WHISPERX_URL%"
    set "VOXCPM_URL=%VOXCPM_URL%"
)
exit /b 0
