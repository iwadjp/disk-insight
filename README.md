# disk-insight

NTFS disk usage viewer for Windows. Reads the Master File Table (MFT) directly
for fast, allocation-oriented size analysis and folder-level cleanup decision support.

**Current status: v0.3.0-daily-use candidate (release build, no delete action).**  
The tool is safe to use for disk analysis. Destructive operations are not implemented.

---

## What it can do

- Scan NTFS drives (C:, D:, …) by reading the MFT directly — no full filesystem crawl
- Show top directories and files by allocated size
- **Direct children panel**: immediate subdirectories and files for the selected folder,
  with filter, sort (size / name / type), and drill-down navigation
- **Breadcrumb / parent row**: navigate up from any subfolder
- **Right-click context menu** on direct children rows:
  - DIR: Open folder / Copy path
  - FILE: Open containing folder / Copy path
- **Reclaimable estimate** in the selected folder card:
  - Estimated reclaimable size, range, confidence (High / Medium / Low)
  - Basis description and caution text
  - "Not recommended as deletion target" flag for system paths
- **Scan progress strip** during scan: phase label, elapsed time, and shimmer bar
- **Folder TreeView** (left pane): lazy expansion into any folder depth
- Size metric selector:
  - `Current allocation estimate` (default)
  - `WOF-adjusted estimate (experimental)`
- Drive auto-detection via `GetLogicalDrives`; top-N count configurable
- Session preferences (drive, top-N, metric, sort) via `localStorage`
- Explorer integration: Open folder, Select file in Explorer, Copy path

## What it cannot do

- **File or folder deletion** — intentionally not implemented
- Move, rename, or cleanup operations
- Virtual scroll for large TreeView expansions (safety warning shown when > 200 children)
- Treemap visualization
- Drive capacity / free space display
- Byte-exact size matches with Explorer or WizTree (differences are expected and documented)

---

## Safety

disk-insight is a **read-only analysis tool**. It does not:

- Delete, move, or modify files or directories
- Claim that any path is "safe to delete"
- Guarantee exact free-space recovery amounts
- Recommend manual deletion of Windows system folders

`Reclaimable estimate` is a diagnostic aid — not a deletion guide. For system paths
(`C:\Windows`, `C:\Program Files`, etc.), confidence is Low or the path is flagged
"Not recommended as deletion target". Use Windows built-in tools (Disk Cleanup,
Settings > Storage) and app uninstallation for actual space recovery — not manual
deletion based on size estimates.

---

## Requirements

- Windows 10 / 11
- NTFS drive (non-NTFS drives are not the current target)
- **Administrator privileges** required for MFT access  
  Run the terminal or built `.exe` as Administrator

---

## Performance

Use the **release build** to evaluate speed. The dev build includes debug instrumentation
and can be noticeably slower.

Observed release-build timing (warm cache, this development system):

| Drive | Files | Approx. scan time | WizTree (same system) |
|-------|-------|-------------------|-----------------------|
| C: (SSD) | ~1.3 M | ~10 s | ~15 s |
| D: (HDD) | ~4.5 M | ~54 s | ~51 s |

Actual times depend on drive type, file count, fragmentation, and OS page-cache state.
Cold-cache scans (first scan after reboot) are slower — C: up to ~20 s, D: up to ~70 s.
The scan progress strip shows phase label and elapsed time throughout.

---

## CLI usage

### Build

```powershell
cargo build --release
```

### Run

```powershell
# Human-readable output
.\target\release\disk-insight.exe --drive C --top 100

# JSON output
.\target\release\disk-insight.exe --json --top 100

# Experimental WOF-adjusted policy
.\target\release\disk-insight.exe --drive C --top 100 --wof-adjusted

# Phase-level timing breakdown
.\target\release\disk-insight.exe --drive C --top 100 --perf-model

# Per-path diagnostic with reclaimable estimate
.\target\release\disk-insight.exe --diag-path "C:\Users"
.\target\release\disk-insight.exe --diag-path "C:\Program Files"

# Help
.\target\release\disk-insight.exe --help
```

`--wof-adjusted` is experimental. Default output remains unchanged. It does not
include hardlink, WinSxS/component-store, or cluster deduplication.

### Save JSON output

PowerShell `>` may write UTF-16LE; use `cmd /c` for reliable UTF-8 output:

```powershell
cmd /c ".\target\release\disk-insight.exe --json --top 100 > .\work\output.json"
```

Validate:

```powershell
python -m json.tool .\work\output.json > $null
```

---

## Tauri desktop UI

### Development mode (hot reload)

```powershell
npm install        # first time only
npm run tauri dev  # run as Administrator for live MFT scan
```

In dev mode, sample data loads on startup and "Load sample" is available in the toolbar.

### Production build

```powershell
npm run tauri build
# Output: src-tauri\target\release\disk-insight-ui.exe
```

Run the built `.exe` as Administrator to enable live scan.

In release mode, the app starts with an empty state. Select a drive and click **Scan** to begin.

---

## Documentation

| File | Description |
|------|-------------|
| `docs/runbook.md` | Developer verification steps and v0.3.0 pre-tag checklist |
| `docs/json-output-schema.md` | JSON output field reference and API boundary notes |
| `docs/ui-plan.md` | UI implementation history and remaining task list |
| `docs/reclaimable-size-model.md` | Reclaimable estimate design and confidence model |
| `docs/size-accuracy-review.md` | Explorer / WizTree / disk-insight size comparison |
| `docs/scan-speed-cold-cache-plan.md` | Scan performance investigation notes |
| `CLAUDE.md` | Project conventions and AI usage guidelines |

---

## Size policy

disk-insight offers two storage policies selectable in the toolbar:

| Policy | Description |
|--------|-------------|
| `Current allocation estimate` (default) | NTFS allocation-oriented estimate. Close to Explorer "Size on disk" for normal files. WOF-compressed areas (Edge, Office, Windows) can show higher than WizTree Allocated. |
| `WOF-adjusted estimate (experimental)` | WOF-compressed files use the compressed backing stream size. Often closer to WizTree "Allocated" for Program Files. Does not apply hardlink or WinSxS dedup. |

Size values are **estimates**. Neither policy produces byte-exact matches with Explorer
or WizTree — differences are expected, bounded, and documented by path type.
See `docs/size-accuracy-review.md`.

The diagnostic CLI can explain a specific path:

```powershell
.\target\release\disk-insight.exe --diag-path "C:\Program Files"
```

`--diag-path` reports current vs WOF-adjusted estimates, WOF/hardlink/reparse evidence,
top child directories, and a `Reclaimable estimate` with confidence and caution text.
It is an explanation aid, not a normal-output correction.

---

## Known limitations

| Area | Notes |
|------|-------|
| WinSxS | Hard-linked files counted per directory entry; hardlink dedup not implemented. Total is a reference value, not exact. |
| WOF | `current` policy: compressed files report projected (uncompressed) allocation — higher than WizTree. `wof_adjusted` uses compressed size. |
| Hard links | Files with `link_count > 1` may count in multiple parent paths. |
| Non-NTFS | FAT32, exFAT, ReFS are not the current target. |
| Accuracy | Size totals differ from WizTree/Explorer. Differences are bounded and documented, not unknown. |
| Virtual scroll | Not implemented. Safety warning shown when a folder has > 200 children. |
| Cold-cache speed | First scan after boot is slower (MFT not in OS page cache). Progress strip shows elapsed time. |

The goal is to identify large directories and files for manual review — not to produce
byte-exact matches with any other tool.

---

## Current milestone

**Minimal usable milestone — PASS (2026-05-24).** Tagged as `v0.1.0-minimal`.

**Next-phase milestone: Explorer-style TreeView — PASS (2026-05-25).** Tag candidate: `v0.2.0-treeview-wof`.

**v0.3.0-daily-use candidate — in preparation.**

- [x] K-2b/K-2c Scan progress strip (phase label, elapsed time, shimmer bar)
- [x] N-2b–N-2e Reclaimable estimate UI in selected folder card
- [x] J-2/J-2b/J-3/J-5/J-5b Direct children panel (filter, sort, drill-down, breadcrumb)
- [x] J-4 Session preferences (localStorage)
- [x] P-0 Right-click context menu on direct children rows
- [x] P-1a/P-1b/P-1c UI polish (hover actions, reclaimable clamp, compact header)
- [x] P-2/P-2b/P-2c Release UI: no sample demo, empty state startup, progress strip regression fix
- [x] G-2 Toolbar polish (size metric select width)
- [x] H-3 Milestone judgment: proceed to tag prep (conditions: H-2 + real-device verification)
- [x] H-2 README / runbook update ← current
- [ ] Real-device verification (release build, all flows)
- [ ] V-2 Tag preparation

---

## Publication status

Public release is deferred until the app reaches the author's own daily-use threshold.
Current state is usable for personal disk analysis. No delete action is implemented.

---

## Deferred

| Feature | Notes |
|---------|-------|
| Virtual scroll | @tanstack/react-virtual — after TreeView polish |
| Treemap visualization | Proportional rectangle view of disk usage |
| Drive NTFS detection | Non-NTFS drives fail at scan time; detection is future work |
| WinSxS / hard link dedup | Avoid double-counting hard-linked files |
| Delete action | Requires safety design (confirmation, recycle bin, undo) — intentionally deferred |
| Global file search | Full-text or name-search across all scanned files |
