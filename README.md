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
- Drive letter and top-N count are configurable
- Tauri desktop UI with:
  - Live scan and sample data view
  - Folder navigation sidebar
  - Selected-folder filtering of top results
  - Open folder in Explorer (selected folder and file parent folder)
  - Copy path to clipboard

## What it cannot do yet

- File or folder deletion
- Full TreeView with expand/collapse
- Treemap visualization
- Right-click context menu
- `explorer /select` file highlighting
- Automatic enumeration of available drives
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

# Scan a different drive
.\target\release\disk-insight.exe --drive D --top 50

# Help
.\target\release\disk-insight.exe --help
```

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

**Minimal usable milestone — no delete action.**

Remaining tasks before milestone sign-off:

- [x] D-7 Open selected folder in Explorer
- [x] D-8 Open file parent folder in Explorer
- [x] D-9 Copy path to clipboard
- [x] D-10 UI polish
- [x] D-11 README
- [ ] D-12 Build and run procedure notes
- [ ] D-13 Milestone checklist sign-off
