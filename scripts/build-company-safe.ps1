# build-company-safe.ps1
# Company-safe build helper for disk-insight.
#
# Runs from the project root (disk-insight/).
# What it does:
#   - git status / commit hash check
#   - debug flag check (TREE_FOCUS_DEBUG, PERF_LOG, PERF_TREE)
#   - Company-safe mode presence check
#   - npm run build + npm run tauri build
#   - SHA256 hash of release exe
#   - Assemble dist-company-safe\ package folder
#
# What it does NOT do:
#   - Sign the exe
#   - Upload or push anything
#   - Copy files to a company PC or network share
#   - Modify the app source code
#
# Usage (from project root, on your local development PC):
#   .\scripts\build-company-safe.ps1
#
# Note on ExecutionPolicy:
#   If you need to allow this script on your own PC, use:
#     powershell -ExecutionPolicy RemoteSigned -File scripts\build-company-safe.ps1
#   Do NOT use ExecutionPolicy Bypass on a company PC to work around restrictions.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
Set-Location $projectRoot

Write-Host ""
Write-Host "=== disk-insight company-safe build ===" -ForegroundColor Cyan
Write-Host ""

# ── 1. Git state ──────────────────────────────────────────────────────────────
Write-Host "--- Git state ---" -ForegroundColor Yellow
$gitStatus = git status --short
if ($gitStatus) {
    Write-Host "WARNING: working tree is not clean:" -ForegroundColor Red
    Write-Host $gitStatus
    Write-Host "Consider committing or stashing before building." -ForegroundColor Red
} else {
    Write-Host "OK: working tree is clean" -ForegroundColor Green
}

$commitHash  = git rev-parse HEAD
$commitShort = git rev-parse --short HEAD
$branch      = git rev-parse --abbrev-ref HEAD
Write-Host "Commit : $commitHash"
Write-Host "Short  : $commitShort"
Write-Host "Branch : $branch"
Write-Host ""

# ── 2. Debug flag check (ui/src/main.tsx) ─────────────────────────────────────
Write-Host "--- Debug flags (ui\src\main.tsx) ---" -ForegroundColor Yellow
$mainTsx = Join-Path $projectRoot "ui\src\main.tsx"

function Check-Flag($name) {
    $line = Select-String -Path $mainTsx -Pattern "^const $name = " | Select-Object -First 1
    if ($null -eq $line) {
        Write-Host "  $name : NOT FOUND" -ForegroundColor Red
        return "MISSING"
    }
    $val = ($line.Line -split "=")[1].Trim().TrimEnd(";")
    if ($val -eq "false") {
        Write-Host "  $name = false  OK" -ForegroundColor Green
        return "false"
    } else {
        Write-Host "  $name = $val  WARNING: should be false for release" -ForegroundColor Yellow
        return $val
    }
}

$flagTreeFocus = Check-Flag "TREE_FOCUS_DEBUG"
$flagPerfLog   = Check-Flag "PERF_LOG"
$flagPerfTree  = Check-Flag "PERF_TREE"
Write-Host ""

# ── 3. Company-safe mode check ────────────────────────────────────────────────
Write-Host "--- Company-safe mode ---" -ForegroundColor Yellow
$csHit = Select-String -Path $mainTsx -Pattern "companySafeMode" -List
if ($csHit) {
    Write-Host "  OK: companySafeMode found in source" -ForegroundColor Green
    $companySafeStatus = "implemented"
} else {
    Write-Host "  WARNING: companySafeMode not found — check implementation" -ForegroundColor Red
    $companySafeStatus = "NOT FOUND"
}
Write-Host ""

# ── 4. Build ──────────────────────────────────────────────────────────────────
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

# ── 5. Artifact check + hash ──────────────────────────────────────────────────
Write-Host "--- Artifact ---" -ForegroundColor Yellow
$exePath = Join-Path $projectRoot "src-tauri\target\release\disk-insight-ui.exe"
if (-not (Test-Path $exePath)) {
    Write-Host "ERROR: release exe not found at $exePath" -ForegroundColor Red
    exit 1
}

$hash       = (Get-FileHash $exePath -Algorithm SHA256).Hash
$fileSize   = (Get-Item $exePath).Length
$fileSizeKb = [math]::Round($fileSize / 1024)

Write-Host "  Path   : $exePath"
Write-Host "  Size   : $fileSizeKb KB"
Write-Host "  SHA256 : $hash"
Write-Host "  Commit : $commitShort  ($branch)"
Write-Host "  Signed : NO (unsigned build)" -ForegroundColor Yellow
Write-Host ""

# ── 6. Assemble dist-company-safe\ ────────────────────────────────────────────
Write-Host "--- Assembling dist-company-safe\ ---" -ForegroundColor Yellow
$distDir = Join-Path $projectRoot "dist-company-safe"

if (Test-Path $distDir) {
    Remove-Item -Recurse -Force $distDir
}
New-Item -ItemType Directory -Path $distDir | Out-Null

# 6a. Copy exe
$destExe = Join-Path $distDir "disk-insight-ui.exe"
Copy-Item $exePath $destExe
Write-Host "  Copied exe -> $destExe" -ForegroundColor Green

# 6b. Copy security overview
$srcOverview  = Join-Path $projectRoot "docs\security-overview.md"
$destOverview = Join-Path $distDir "SECURITY-OVERVIEW.md"
if (Test-Path $srcOverview) {
    Copy-Item $srcOverview $destOverview
    Write-Host "  Copied security overview -> $destOverview" -ForegroundColor Green
} else {
    Write-Host "  WARNING: docs\security-overview.md not found — skipping" -ForegroundColor Yellow
}

# 6c. Generate README-company-safe.txt
$buildTime = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
$readmeContent = @"
disk-insight — Company-safe dogfooding build
=============================================

** READ BEFORE RUNNING **

1. This is a PRE-RELEASE, UNSIGNED build for local dogfooding only.
   It is NOT an official release.

2. UNSIGNED BUILD:
   - This exe is not code-signed.
   - Use only if unsigned local tools are permitted in your company
     environment (e.g., other unsigned tools run without issue).
   - If you are unsure, ask IT before running.

3. MANDATORY: Enable Company-safe mode in the toolbar before scanning.
   In Company-safe mode, the following actions are HIDDEN:
     - Open terminal here  (PowerShell launch)
     - Relaunch as administrator
     - Advanced Mode
     - Move to Recycle Bin

4. NETWORK: No network connections. No telemetry. No auto-update.

5. WRITES: Only to %LOCALAPPDATA%\disk-insight\  (cache + bookmarks).
   Scanned files are never modified.

6. DESTRUCTIVE ACTIONS:
   - Delete / Cut / Rename / Paste: NOT IMPLEMENTED.
   - Move to Recycle Bin: HIDDEN in Company-safe mode.

7. SECURITY WARNING POLICY:
   If SmartScreen, EDR, AppLocker, or any other security product
   warns or blocks this exe: STOP immediately. Do not bypass.
   Do not disable or work around security controls.

8. Follow your organization's policy. If running unsigned tools is
   not permitted, do not use this tool on your company PC.

See SECURITY-OVERVIEW.md for the full explanation.

Build info: $commitShort  ($branch)  SHA256: $hash
"@

$readmePath = Join-Path $distDir "README-company-safe.txt"
$readmeContent | Out-File -FilePath $readmePath -Encoding utf8
Write-Host "  Generated README-company-safe.txt" -ForegroundColor Green

# 6d. Generate BUILD-INFO.txt
$buildInfoContent = @"
disk-insight — Build Information
=================================
App name      : disk-insight
Product name  : disk-insight-ui.exe
Build time    : $buildTime
Commit (full) : $commitHash
Commit (short): $commitShort
Branch        : $branch

Artifact
--------
File          : disk-insight-ui.exe
Size          : $fileSizeKb KB
SHA256        : $hash
Signed        : NO (unsigned build)

Note: Verify this hash matches the exe before running on another PC.

Debug flags (all must be false for release)
-------------------------------------------
TREE_FOCUS_DEBUG : $flagTreeFocus
PERF_LOG         : $flagPerfLog
PERF_TREE        : $flagPerfTree

Company-safe mode : $companySafeStatus
Bundle type       : bare exe (bundle.active=false, no installer/MSI)
GitHub Release    : NO — this is a local dogfooding build only

Security notes
--------------
- No network connections, no telemetry, no auto-update.
- Writes only to %LOCALAPPDATA%\disk-insight\  (cache + bookmarks.json).
- Company-safe mode hides: terminal launch, admin relaunch, Advanced
  Mode, Move to Recycle Bin.
- Delete / Rename / Cut / Paste are NOT implemented.
- UNSIGNED: may trigger SmartScreen / AppLocker / EDR warnings.
  If warned or blocked — STOP. Do not bypass security products.
"@

$buildInfoPath = Join-Path $distDir "BUILD-INFO.txt"
$buildInfoContent | Out-File -FilePath $buildInfoPath -Encoding utf8
Write-Host "  Generated BUILD-INFO.txt" -ForegroundColor Green
Write-Host ""

# ── 7. Verify dist folder ─────────────────────────────────────────────────────
Write-Host "--- dist-company-safe\ contents ---" -ForegroundColor Yellow
Get-ChildItem $distDir | ForEach-Object {
    $sz = [math]::Round($_.Length / 1024)
    Write-Host ("  {0,-35} {1,7} KB" -f $_.Name, $sz)
}
Write-Host ""

# Verify hash of copied exe matches source
$copiedHash = (Get-FileHash $destExe -Algorithm SHA256).Hash
if ($copiedHash -eq $hash) {
    Write-Host "  Hash verified: copy matches source exe" -ForegroundColor Green
} else {
    Write-Host "  ERROR: hash mismatch! Copied exe is different." -ForegroundColor Red
    exit 1
}
Write-Host ""

# ── 8. Summary ────────────────────────────────────────────────────────────────
Write-Host "=== Build and package complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Output folder: $distDir"
Write-Host ""
Write-Host "Record for company-PC transfer:" -ForegroundColor White
Write-Host "  disk-insight-ui.exe"
Write-Host "    Commit  : $commitShort"
Write-Host "    SHA256  : $hash"
Write-Host "    Signed  : unsigned"
Write-Host "    TREE_FOCUS_DEBUG / PERF_LOG / PERF_TREE = false"
Write-Host "    Company-safe mode: $companySafeStatus"
Write-Host ""
Write-Host "IMPORTANT:" -ForegroundColor Yellow
Write-Host "  This is an UNSIGNED build." -ForegroundColor Yellow
Write-Host "  If security products warn or block — STOP. Do not bypass." -ForegroundColor Yellow
Write-Host "  Enable Company-safe mode before scanning." -ForegroundColor Yellow
Write-Host "  See: docs\company-pc-dogfooding-checklist.md" -ForegroundColor Yellow
Write-Host "       dist-company-safe\README-company-safe.txt" -ForegroundColor Yellow
Write-Host ""
