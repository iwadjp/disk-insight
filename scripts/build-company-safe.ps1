# build-company-safe.ps1
# Company-safe build helper for disk-insight.
#
# Runs from the project root (disk-insight/).
# What it does:  git status, debug flag check, npm build, tauri build, SHA256 hash.
# What it does NOT do: sign, upload, copy to company PC, or touch any network.
#
# Usage:
#   cd disk-insight
#   .\scripts\build-company-safe.ps1

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

$commitHash = git rev-parse HEAD
$commitShort = git rev-parse --short HEAD
$branch = git rev-parse --abbrev-ref HEAD
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
        return
    }
    $val = ($line.Line -split "=")[1].Trim().TrimEnd(";")
    if ($val -eq "false") {
        Write-Host "  $name = false  OK" -ForegroundColor Green
    } else {
        Write-Host "  $name = $val  WARNING: should be false for release" -ForegroundColor Yellow
    }
}

Check-Flag "TREE_FOCUS_DEBUG"
Check-Flag "PERF_LOG"
Check-Flag "PERF_TREE"
Write-Host ""

# ── 3. Company-safe mode check ────────────────────────────────────────────────
Write-Host "--- Company-safe mode ---" -ForegroundColor Yellow
$csHit = Select-String -Path $mainTsx -Pattern "companySafeMode" -List
if ($csHit) {
    Write-Host "  OK: companySafeMode found in source" -ForegroundColor Green
} else {
    Write-Host "  WARNING: companySafeMode not found — check implementation" -ForegroundColor Red
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

$hash = (Get-FileHash $exePath -Algorithm SHA256).Hash
$fileSize = (Get-Item $exePath).Length
$fileSizeKb = [math]::Round($fileSize / 1024)

Write-Host "  Path   : $exePath"
Write-Host "  Size   : $fileSizeKb KB"
Write-Host "  SHA256 : $hash"
Write-Host "  Commit : $commitShort  ($branch)"
Write-Host "  Signed : NO (unsigned build)" -ForegroundColor Yellow
Write-Host ""

# ── 6. Summary ────────────────────────────────────────────────────────────────
Write-Host "=== Build complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Record for company-PC transfer:" -ForegroundColor White
Write-Host "  disk-insight-ui.exe"
Write-Host "    Commit  : $commitShort"
Write-Host "    SHA256  : $hash"
Write-Host "    Signed  : unsigned"
Write-Host "    TREE_FOCUS_DEBUG / PERF_LOG / PERF_TREE = false"
Write-Host "    Company-safe mode: implemented"
Write-Host ""
Write-Host "IMPORTANT:" -ForegroundColor Yellow
Write-Host "  This is an UNSIGNED build." -ForegroundColor Yellow
Write-Host "  Do NOT bring to a company PC without code signing" -ForegroundColor Yellow
Write-Host "  or explicit IT/security approval." -ForegroundColor Yellow
Write-Host "  See: docs\company-pc-dogfooding-checklist.md" -ForegroundColor Yellow
Write-Host ""
