# disk-insight

WizTree-style fast disk analyzer for Windows NTFS drives.

Reads the Master File Table (MFT) directly to build folder size summaries and
locate large files — without a full filesystem crawl.

**Current status: minimal usable milestone (no delete action).**
The tool is safe to use for disk analysis. Destructive operations are not implemented.

---

## What it can do

- Scan NTFS drives (C:, D:, …) by reading the MFT directly
- Aggregate subtree sizes for all directories
- Show top directories by size
- Show top files by allocated size
- Drive letter auto-detected from logical drives; top-N count configurable
- Tauri desktop UI with:
  - Live scan and sample data view
  - Folder navigation sidebar
  - Selected-folder filtering of top results
  - Open folder in Explorer (selected folder and file parent folder)
  - Select file in Explorer (top-files rows — highlights file in parent folder)
  - Copy path to clipboard

## What it cannot do yet

- File or folder deletion
- Virtual scroll for large TreeView expansions
- Treemap visualization
- Right-click context menu
- `explorer /select` for folders (available for top-files rows only)
- Drive capacity / free space display
- Full accuracy for WinSxS, WOF-compressed files, and hard links

---

## Requirements

- Windows 10 / 11
- NTFS drive (non-NTFS drives are not the current target)
- **Administrator privileges** are required for MFT access
  - Run the terminal, VS Code, or the built `.exe` as Administrator

---

## CLI usage

### Build

```powershell
cargo build --release
```

### Run

```powershell
# Human-readable output (top directories and files)
.\target\release\disk-insight.exe

# JSON output
.\target\release\disk-insight.exe --json

# JSON output, top 100 entries
.\target\release\disk-insight.exe --json --top 100

# Experimental WOF-adjusted allocation policy
.\target\release\disk-insight.exe --json --top 100 --wof-adjusted

# Scan a different drive
.\target\release\disk-insight.exe --drive D --top 50

# Help
.\target\release\disk-insight.exe --help
```

`--wof-adjusted` is experimental. Default output remains unchanged, and the
option does not include hardlink, WinSxS/component-store, or cluster
deduplication.

### Save JSON output

PowerShell `>` may write UTF-16LE depending on your environment, which breaks
JSON parsers. Use `cmd /c` redirection to get UTF-8:

```powershell
cmd /c ".\target\release\disk-insight.exe --json --top 100 > .\work\output.json"
```

Validate the output:

```powershell
python -m json.tool .\work\output.json > $null
```

---

## Tauri desktop UI

### Install dependencies (first time)

```powershell
npm install
```

### Development mode (hot reload)

```powershell
# Must run as Administrator for live MFT scan
npm run tauri dev
```

### Production build

```powershell
npm run tauri build
# Output: src-tauri/target/release/disk-insight-ui.exe
```

Run the built `.exe` as Administrator to enable live scan.
The app works without admin rights but scan will fail with a permission error.

---

## Documentation

| File | Description |
|------|-------------|
| `docs/runbook.md` | Developer verification steps and minimal UI checklist |
| `docs/json-output-schema.md` | JSON output field reference and API boundary notes |
| `docs/ui-plan.md` | UI implementation history and remaining task list |
| `CLAUDE.md` | Project conventions and AI usage guidelines |

---

## Known limitations

| Area | Notes |
|------|-------|
| WinSxS | Hard-linked files may be counted multiple times |
| WOF | Compressed files report allocation size, not compressed size |
| Hard links | Multiple directory entries for the same file clusters |
| Non-NTFS | FAT32, exFAT, ReFS are not the current target |
| Accuracy | Size totals may differ from Windows "Properties" or WizTree |

The goal is to identify large directories and files for manual review —
not to produce byte-exact matches with the OS disk usage report.

---

## Current milestone

**Minimal usable milestone — PASS (2026-05-24).** Tagged as `v0.1.0-minimal`.

- [x] D-13 Milestone sign-off

**Next-phase milestone: Explorer-style TreeView** — in progress (`next-phase` branch).

- [x] E-1〜E-5 Lazy TreeView with flat render and safety guards
- [x] F-1 Select file in Explorer (`explorer /select,file`)
- [x] G-1 Drive auto-detection selector
- [x] Size accuracy CLI/JSON experiments, including `--wof-adjusted`
- [ ] G-2 Drive selector polish
- [ ] H-1 TreeView UX polish
- [ ] H-2 README / runbook update
- [ ] H-3 Next-phase milestone sign-off

`--wof-adjusted` is experimental and does not affect the default UI/Tauri scan.

---

## Deferred

| Feature | Notes |
|---------|-------|
| Virtual scroll | @tanstack/react-virtual — after TreeView polish |
| Treemap visualization | Proportional rectangle view of disk usage |
| Drive NTFS detection | Non-NTFS drives fail at scan time; detection is future work |
| WinSxS / hard link dedup | Avoid double-counting hard-linked files |
| Delete action | Requires safety design (confirmation, recycle bin, undo) — intentionally deferred |
