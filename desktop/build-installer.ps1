param(
    [string]$PythonExe = "E:\VC\venv312\Scripts\python.exe",
    [string]$ISCCPath = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$assetsScript = Join-Path $root "desktop\assets\generate_brand_assets.py"
$launcherScript = Join-Path $root "desktop\build-launcher.ps1"
$portableScript = Join-Path $root "desktop\build-portable.ps1"
$issFile = Join-Path $root "desktop\installer\TTSHarnessLauncher.iss"
$outputDir = Join-Path $root "desktop\installer\dist"
$stageRoot = "C:\TTSHarnessInstallerStage"
$stagePortable = Join-Path $stageRoot "portable"
$stageAssets = Join-Path $stageRoot "assets"
$stageLicense = Join-Path $stageRoot "LICENSE"

if (-not $ISCCPath) {
    $candidates = @(
        "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
        "C:\Program Files\Inno Setup 6\ISCC.exe"
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            $ISCCPath = $candidate
            break
        }
    }
}

if (-not $ISCCPath -or -not (Test-Path $ISCCPath)) {
    throw "ISCC.exe was not found. Install Inno Setup 6 first, or pass -ISCCPath."
}

Push-Location $root
try {
    & $PythonExe $assetsScript | Out-Host
    & powershell -ExecutionPolicy Bypass -File $launcherScript -PythonExe $PythonExe | Out-Host
    & powershell -ExecutionPolicy Bypass -File $portableScript | Out-Host

    if (Test-Path $stageRoot) {
        Remove-Item -Recurse -Force $stageRoot
    }
    New-Item -ItemType Directory -Force -Path $stagePortable, $stageAssets, $outputDir | Out-Null
    Copy-Item (Join-Path $root "desktop\portable\*") -Destination $stagePortable -Recurse -Force
    Copy-Item (Join-Path $root "desktop\assets\*") -Destination $stageAssets -Recurse -Force
    Copy-Item (Join-Path $root "LICENSE") -Destination $stageLicense -Force

    & $ISCCPath `
        "/DPortableDir=$stagePortable" `
        "/DAssetsDir=$stageAssets" `
        "/DLicensePath=$stageLicense" `
        "/DInstallerOutputDir=$outputDir" `
        $issFile | Out-Host
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host ("Installer built under: {0}" -f $outputDir)
