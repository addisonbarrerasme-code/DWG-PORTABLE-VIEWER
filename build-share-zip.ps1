$ErrorActionPreference = "Stop"
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktop = [Environment]::GetFolderPath("Desktop")

$releaseDir = Join-Path $projectDir "release"
$unpackedDir = Join-Path $releaseDir "win-unpacked"
$shareDir = Join-Path $desktop "DWG-Viewer-Portable-Folder"
$zipPath = Join-Path $desktop "DWG-Viewer-Portable-Folder.zip"
$testFiles = @(
    "C:\Users\Addison Barreras\Downloads\architectural_-_annotation_scaling_and_multileaders.dwg",
    "C:\Users\Addison Barreras\Downloads\32XXGO Ctrl Box Dom Gas.DWG"
)

if (-not (Test-Path $unpackedDir)) {
    Write-Host "win-unpacked not found. Building portable output first..." -ForegroundColor Yellow
    Set-Location $projectDir
    & npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "TypeScript compile failed." -ForegroundColor Red
        exit 1
    }

    & npm run dist:win
    if ($LASTEXITCODE -ne 0) {
        Write-Host "electron-builder failed." -ForegroundColor Red
        exit 1
    }

    if (-not (Test-Path $unpackedDir)) {
        Write-Host "win-unpacked was not created." -ForegroundColor Red
        exit 1
    }
}

if (Test-Path $shareDir) { Remove-Item $shareDir -Recurse -Force }
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

New-Item -ItemType Directory -Path $shareDir | Out-Null
Copy-Item $unpackedDir -Destination (Join-Path $shareDir "DWG Viewer") -Recurse -Force

$runBat = @"
@echo off
cd /d "%~dp0DWG Viewer"
start "" "DWG Viewer.exe"
"@
Set-Content -Path (Join-Path $shareDir "Run DWG Viewer.bat") -Value $runBat -Encoding ASCII

$readme = @"
DWG Viewer Portable Folder Package

1) Extract this zip anywhere.
2) Run "Run DWG Viewer.bat".

This package is built from win-unpacked (not single-file self-extracting exe),
which avoids temp extraction issues on some PCs.
"@
Set-Content -Path (Join-Path $shareDir "README.txt") -Value $readme -Encoding ASCII

$samplesDir = Join-Path $shareDir "Sample DWGs"
New-Item -ItemType Directory -Path $samplesDir | Out-Null
foreach ($testFile in $testFiles) {
    if (-not (Test-Path $testFile)) {
        Write-Host "Missing test file: $testFile" -ForegroundColor Red
        exit 1
    }

    Copy-Item $testFile -Destination (Join-Path $samplesDir (Split-Path $testFile -Leaf)) -Force
}

Compress-Archive -Path (Join-Path $shareDir "*") -DestinationPath $zipPath -CompressionLevel Optimal

$zip = Get-Item $zipPath
$hash = (Get-FileHash $zipPath -Algorithm SHA256).Hash
Write-Host "Created: $($zip.FullName)"
Write-Host "Size: $($zip.Length) bytes"
Write-Host "SHA256: $hash"
