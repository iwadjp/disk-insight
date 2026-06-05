# build-release-package.ps1
# Public release package builder for disk-insight.
#
# Runs from the project root (disk-insight/).
# What it does:
#   - Validates required source files exist
#   - Errors if working tree is dirty
#   - Reads version from src-tauri/tauri.conf.json
#   - Checks debug flags and windows_subsystem setting
#   - Runs npm run build and npm run tauri build
#   - Assembles dist-release\disk-insight-v{version}-windows-x64\
#   - Generates BUILD-INFO.txt and SHA256SUMS.txt
#   - Creates zip archive with root folder inside
#   - Displays zip SHA256
#
# What it does NOT do:
#   - Sign the exe
#   - Push or tag anything
#   - Create a GitHub Release
#   - Commit dist-release\ or the zip
#
# Usage (from project root):
#   powershell -ExecutionPolicy Bypass -File scripts\build-release-package.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
Set-Location $projectRoot

Write-Host ""
Write-Host "=== disk-insight release package build ===" -ForegroundColor Cyan
Write-Host ""

# -- 1. Validate repo root -------------------------------------------------------
Write-Host "--- Validating repo root ---" -ForegroundColor Yellow
$required = @(
    "package.json",
    "README.md",
    "LICENSE",
    "src-tauri\tauri.conf.json",
    "docs\security-overview.md"
)
foreach ($rel in $required) {
    if (-not (Test-Path (Join-Path $projectRoot $rel))) {
        Write-Host "ERROR: required file not found: $rel" -ForegroundColor Red
        exit 1
    }
    Write-Host "  OK: $rel" -ForegroundColor Green
}
Write-Host ""

# -- 2. Git clean check ----------------------------------------------------------
Write-Host "--- Git state ---" -ForegroundColor Yellow
$gitStatus = git status --short
if ($gitStatus) {
    Write-Host "ERROR: working tree is not clean. Commit or stash before building." -ForegroundColor Red
    Write-Host $gitStatus
    exit 1
}
Write-Host "OK: working tree is clean" -ForegroundColor Green

$commitHash  = git rev-parse HEAD
$commitShort = git rev-parse --short HEAD
$branch      = git rev-parse --abbrev-ref HEAD
Write-Host "Commit : $commitHash"
Write-Host "Short  : $commitShort"
Write-Host "Branch : $branch"
Write-Host ""

# -- 3. Version ------------------------------------------------------------------
Write-Host "--- Version ---" -ForegroundColor Yellow
$tauriConf  = Get-Content (Join-Path $projectRoot "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
$appVersion = $tauriConf.version
Write-Host "  $appVersion  (from src-tauri\tauri.conf.json)"
Write-Host ""

# -- 4. Debug flag check ---------------------------------------------------------
Write-Host "--- Debug flags (ui\src\main.tsx) ---" -ForegroundColor Yellow
$mainTsx = Join-Path $projectRoot "ui\src\main.tsx"
$flagOk  = $true
foreach ($flagName in @("TREE_FOCUS_DEBUG", "PERF_LOG", "PERF_TREE")) {
    $hit = Select-String -Path $mainTsx -Pattern "^const $flagName = " | Select-Object -First 1
    if ($null -eq $hit) {
        Write-Host "  ERROR: $flagName not found in main.tsx" -ForegroundColor Red
        $flagOk = $false
    } else {
        $val = ($hit.Line -split "=")[1].Trim().TrimEnd(";")
        if ($val -eq "false") {
            Write-Host "  $flagName = false  OK" -ForegroundColor Green
        } else {
            Write-Host "  ERROR: $flagName = $val (must be false for release)" -ForegroundColor Red
            $flagOk = $false
        }
    }
}
if (-not $flagOk) {
    Write-Host "ERROR: debug flags must all be false before building a release." -ForegroundColor Red
    exit 1
}
Write-Host ""

# -- 5. windows_subsystem check --------------------------------------------------
Write-Host "--- windows_subsystem check (src-tauri\src\main.rs) ---" -ForegroundColor Yellow
$mainRs = Join-Path $projectRoot "src-tauri\src\main.rs"
if (Select-String -Path $mainRs -Pattern 'windows_subsystem\s*=\s*"windows"' -List) {
    Write-Host "  OK: windows_subsystem = windows present" -ForegroundColor Green
} else {
    Write-Host "  ERROR: windows_subsystem not found -- release exe will open a console window" -ForegroundColor Red
    exit 1
}
Write-Host ""

# -- 6. Build --------------------------------------------------------------------
Write-Host "--- npm run build (TypeScript + Vite) ---" -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: npm run build failed (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
}
Write-Host ""

Write-Host "--- npm run tauri build (Rust + bundle) ---" -ForegroundColor Yellow
npm run tauri build
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: tauri build failed (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
}
Write-Host ""

# -- 7. Artifact check -----------------------------------------------------------
Write-Host "--- Release artifact ---" -ForegroundColor Yellow
$exeSrc = Join-Path $projectRoot "src-tauri\target\release\disk-insight-ui.exe"
if (-not (Test-Path $exeSrc)) {
    Write-Host "ERROR: release exe not found: $exeSrc" -ForegroundColor Red
    exit 1
}
$exeHash   = (Get-FileHash $exeSrc -Algorithm SHA256).Hash.ToLower()
$exeSizeKb = [math]::Round((Get-Item $exeSrc).Length / 1024)
Write-Host "  disk-insight-ui.exe  $exeSizeKb KB"
Write-Host "  SHA256: $exeHash"
Write-Host ""

# -- 8. Assemble package folder --------------------------------------------------
Write-Host "--- Assembling package folder ---" -ForegroundColor Yellow
$pkgName    = "disk-insight-v$appVersion-windows-x64"
$distRelDir = Join-Path $projectRoot "dist-release"
$pkgDir     = Join-Path $distRelDir $pkgName

if (Test-Path $pkgDir) { Remove-Item -Recurse -Force $pkgDir }
if (-not (Test-Path $distRelDir)) { New-Item -ItemType Directory -Path $distRelDir | Out-Null }
New-Item -ItemType Directory -Path $pkgDir | Out-Null

Copy-Item $exeSrc                                              (Join-Path $pkgDir "disk-insight-ui.exe")
Copy-Item (Join-Path $projectRoot "README.md")                 (Join-Path $pkgDir "README.md")
Copy-Item (Join-Path $projectRoot "LICENSE")                   (Join-Path $pkgDir "LICENSE")
Copy-Item (Join-Path $projectRoot "docs\security-overview.md") (Join-Path $pkgDir "SECURITY-OVERVIEW.md")

Write-Host "  disk-insight-ui.exe" -ForegroundColor Green
Write-Host "  README.md" -ForegroundColor Green
Write-Host "  LICENSE" -ForegroundColor Green
Write-Host "  SECURITY-OVERVIEW.md  (from docs\security-overview.md)" -ForegroundColor Green
Write-Host ""

# -- 9. Generate BUILD-INFO.txt --------------------------------------------------
Write-Host "--- Generating BUILD-INFO.txt ---" -ForegroundColor Yellow
$buildTime     = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
$buildInfoPath = Join-Path $pkgDir "BUILD-INFO.txt"
@(
    "Project           : disk-insight",
    "Version           : $appVersion",
    "Commit            : $commitHash",
    "Commit short      : $commitShort",
    "Branch            : $branch",
    "Build time        : $buildTime",
    "Signed            : NO",
    "GitHub Release    : NO",
    "Safety model      : Normal + Advanced",
    "Company-safe UI   : removed in v0.5.18-C",
    "Network           : none",
    "Telemetry         : none",
    "Updater           : none",
    "TREE_FOCUS_DEBUG  : false",
    "PERF_LOG          : false",
    "PERF_TREE         : false"
) | Out-File -FilePath $buildInfoPath -Encoding ascii
Write-Host "  Generated BUILD-INFO.txt" -ForegroundColor Green
Write-Host ""

# -- 10. Generate SHA256SUMS.txt -------------------------------------------------
Write-Host "--- Generating SHA256SUMS.txt ---" -ForegroundColor Yellow
$sumPath  = Join-Path $pkgDir "SHA256SUMS.txt"
$sumLines = @("disk-insight-ui.exe", "README.md", "LICENSE", "SECURITY-OVERVIEW.md", "BUILD-INFO.txt") | ForEach-Object {
    $h = (Get-FileHash (Join-Path $pkgDir $_) -Algorithm SHA256).Hash.ToLower()
    "$h  $_"
}
$sumLines | Out-File -FilePath $sumPath -Encoding ascii
$sumLines | ForEach-Object { Write-Host "  $_" }
Write-Host ""

# -- 11. Create zip --------------------------------------------------------------
Write-Host "--- Creating zip archive ---" -ForegroundColor Yellow
$zipPath = Join-Path $distRelDir "$pkgName.zip"
if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
Compress-Archive -Path $pkgDir -DestinationPath $zipPath
$zipHash   = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLower()
$zipSizeKb = [math]::Round((Get-Item $zipPath).Length / 1024)
Write-Host "  $pkgName.zip  $zipSizeKb KB" -ForegroundColor Green
Write-Host ""

# -- 12. Summary -----------------------------------------------------------------
Write-Host "=== Package complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Folder  : dist-release\$pkgName\"
Write-Host "Archive : dist-release\$pkgName.zip"
Write-Host ""
Write-Host "Archive SHA256 : $zipHash" -ForegroundColor White
Write-Host ""
Write-Host "Record this SHA256 externally before publishing." -ForegroundColor Yellow
Write-Host "dist-release\ is gitignored -- do not commit it." -ForegroundColor Yellow
Write-Host ""
Write-Host "Pre-publish checklist: docs\v0.6.0-release-candidate-package-plan.md" -ForegroundColor White
Write-Host ""
