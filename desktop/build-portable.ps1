param(
    [string]$PythonRuntime = "",
    [string]$NodeRuntime = "",
    [string]$FfmpegBinDir = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root "desktop\portable"

if (Test-Path $outDir) {
    Remove-Item -Recurse -Force $outDir
}

New-Item -ItemType Directory -Path $outDir | Out-Null
New-Item -ItemType Directory -Path (Join-Path $outDir "runtime") | Out-Null

$copyItems = @(
    "README.md",
    "WINDOWS-START.md",
    ".env.dev",
    "start-desktop-stack.bat",
    "start-desktop-stack-debug.bat",
    "stop-desktop-stack.bat",
    "scripts\windows",
    "server",
    "voxcpm-svc",
    "whisperx-svc",
    "desktop\launcher.py",
    "desktop\build-launcher.ps1",
    "desktop\dist\TTSHarnessLauncher.exe"
)

foreach ($item in $copyItems) {
    $source = Join-Path $root $item
    if (Test-Path $source) {
        Copy-Item $source -Destination $outDir -Recurse -Force
    }
}

$webStandalone = Join-Path $root "web\.next\standalone"
$webStatic = Join-Path $root "web\.next\static"
$webPublic = Join-Path $root "web\public"

if (Test-Path $webStandalone) {
    New-Item -ItemType Directory -Path (Join-Path $outDir "web\.next") -Force | Out-Null
    Copy-Item $webStandalone -Destination (Join-Path $outDir "web\.next") -Recurse -Force
}
if (Test-Path $webStatic) {
    New-Item -ItemType Directory -Path (Join-Path $outDir "web\.next") -Force | Out-Null
    Copy-Item $webStatic -Destination (Join-Path $outDir "web\.next") -Recurse -Force
}
if (Test-Path $webPublic) {
    Copy-Item $webPublic -Destination (Join-Path $outDir "web") -Recurse -Force
}

if ($PythonRuntime -and (Test-Path $PythonRuntime)) {
    Copy-Item $PythonRuntime -Destination (Join-Path $outDir "runtime\python") -Recurse -Force
}
if ($NodeRuntime -and (Test-Path $NodeRuntime)) {
    Copy-Item $NodeRuntime -Destination (Join-Path $outDir "runtime\node") -Recurse -Force
}
if ($FfmpegBinDir -and (Test-Path $FfmpegBinDir)) {
    Copy-Item $FfmpegBinDir -Destination (Join-Path $outDir "runtime\ffmpeg") -Recurse -Force
}

Write-Host ""
Write-Host "Portable bundle prepared at: $outDir"
Write-Host "Tip: pass -PythonRuntime / -NodeRuntime / -FfmpegBinDir to embed sidecar runtimes."
