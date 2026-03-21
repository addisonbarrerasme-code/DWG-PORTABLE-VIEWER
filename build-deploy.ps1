$ErrorActionPreference = "Stop"
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktop    = [Environment]::GetFolderPath("Desktop")
$appFolder  = Join-Path $desktop "DWG Viewer"
$batchLauncher = Join-Path $desktop "Launch DWG Viewer.bat"

# ── 1. Kill any running instance so we can replace the files ────────────────
Write-Host ">> Stopping any running DWG Viewer instances..." -ForegroundColor Cyan
Get-Process -Name "DWG Viewer" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800   # brief wait for handles to release

# ── 2. Remove previous deployment from Desktop ──────────────────────────────
Write-Host ">> Removing previous deployment from Desktop..." -ForegroundColor Cyan
if (Test-Path $appFolder)    { Remove-Item $appFolder -Recurse -Force }
if (Test-Path $batchLauncher){ Remove-Item $batchLauncher -Force }
# Also clean any legacy folders left from earlier iterations
$legacyFolders = @("dwg-viewer-portable", "dwl-viewer-app")
foreach ($f in $legacyFolders) {
    $legacyPath = Join-Path $desktop $f
    if (Test-Path $legacyPath) { Remove-Item $legacyPath -Recurse -Force; Write-Host "   Removed legacy: $f" }
}

# ── 2. Compile TypeScript ────────────────────────────────────────────────────
Write-Host ">> Compiling TypeScript..." -ForegroundColor Cyan
Set-Location $projectDir
& npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "TypeScript compile failed." -ForegroundColor Red; exit 1 }

# ── 3. Build app with electron-builder (dir target, no NSIS required) ────────
Write-Host ">> Packaging with electron-builder..." -ForegroundColor Cyan
& npm run dist:win
if ($LASTEXITCODE -ne 0) { Write-Host "electron-builder failed." -ForegroundColor Red; exit 1 }

# ── 4. Locate the win unpacked directory ────────────────────────────────────
$unpackedDir = Get-ChildItem -Path "$projectDir\release" -Directory -Filter "win-unpacked" -ErrorAction SilentlyContinue |
               Select-Object -First 1

if (-not $unpackedDir) {
    # Fallback: look anywhere under release/
    $unpackedDir = Get-ChildItem -Path "$projectDir\release" -Recurse -Directory |
                   Where-Object { Test-Path (Join-Path $_.FullName "DWG Viewer.exe") } |
                   Select-Object -First 1
}

if (-not $unpackedDir) {
    Write-Host "ERROR: Could not find the built app folder. Check electron-builder output above." -ForegroundColor Red
    exit 1
}

# ── 5. Copy app folder to Desktop ───────────────────────────────────────────
Write-Host ">> Copying app to Desktop as 'DWG Viewer'..." -ForegroundColor Cyan
Copy-Item $unpackedDir.FullName -Destination $appFolder -Recurse -Force

# ── 6. Create a .bat launcher on the Desktop ────────────────────────────────
$batContent = "@echo off`r`nstart `"`" `"%~dp0DWG Viewer\DWG Viewer.exe`""
Set-Content -Path $batchLauncher -Value $batContent -Encoding ASCII

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host " Done! Double-click to launch:" -ForegroundColor Green
Write-Host "   $batchLauncher" -ForegroundColor White
Write-Host "================================================================" -ForegroundColor Green
