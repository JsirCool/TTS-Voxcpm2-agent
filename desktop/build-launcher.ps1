param(
    [string]$PythonExe = "E:\VC\venv312\Scripts\python.exe"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$distDir = Join-Path $root "desktop\dist"

Push-Location $root
try {
    & $PythonExe -m pip install pyinstaller | Out-Host
    & $PythonExe -m PyInstaller `
        --noconfirm `
        --clean `
        --name "TTSHarnessLauncher" `
        --onefile `
        --windowed `
        --distpath $distDir `
        "$root\desktop\launcher.py"
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "Launcher built at: $distDir\TTSHarnessLauncher.exe"
