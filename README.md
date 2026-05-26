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
| `docs/reclaimable-size-model.md` | Design notes for future estimated reclaimable size diagnostics |
| `CLAUDE.md` | Project conventions and AI usage guidelines |

---

## Size policy

disk-insight offers two storage policies:

| Policy | Description |
|--------|-------------|
| `current` (default) | NTFS allocation-oriented estimate. Usually close to Explorer "Size on disk" for normal files. WOF-compressed areas (Edge, Office, Windows components) can show higher than WizTree. |
| `wof_adjusted` (experimental) | WOF-compressed files use the compressed backing stream size. Often closer to WizTree "Allocated" for Program Files. Does not apply hardlink or WinSxS dedup. |

These values are estimates. `current` is allocation-oriented, and
`wof_adjusted` is experimental. Compare against Explorer "Size on disk" or
WizTree "Allocated" where appropriate, not Explorer "Size".
The UI labels these values as estimates; the size metric selector does not
change JSON field names or CLI output labels.

Neither policy produces byte-exact matches with Explorer or WizTree — differences are expected and explainable.
See `docs/size-accuracy-review.md` for a full breakdown.

Size differences are path-specific. The diagnostic CLI can explain a selected
path:

```powershell
.\target\release\disk-insight.exe --diag-path "C:\Program Files"
```

`--diag-path` reports current vs WOF-adjusted estimates plus WOF, hardlink,
multi-name, reparse-point, sparse/compressed, and child-directory evidence. It
is an explanation aid, not a normal-output correction.

`--diag-path` also reports a diagnostic `Reclaimable estimate`: a primary
estimate, reference range, confidence, basis, and caution for how much free
space might increase if a subtree is removed or moved. This is not a delete
feature, and exact reclaimed bytes are not guaranteed.

## Known limitations

| Area | Notes |
|------|-------|
| WinSxS | Hard-linked files are counted per directory entry; hardlink dedup is not implemented. WinSxS total is a reference value, not an exact figure. |
| WOF | `current` policy: compressed files report projected (uncompressed) allocation — higher than WizTree. `wof_adjusted`: uses compressed size instead. |
| Hard links | Files with `link_count > 1` may contribute to multiple parent paths. WinSxS and Windows servicing are most affected. |
| Non-NTFS | FAT32, exFAT, ReFS are not the current target. |
| Accuracy | Size totals differ from WizTree/Explorer — differences are bounded and documented, not unknown. |

The goal is to identify large directories and files for manual review —
not to produce byte-exact matches with any other tool.

---

## Current milestone

**Minimal usable milestone — PASS (2026-05-24).** Tagged as `v0.1.0-minimal`.

- [x] D-13 Milestone sign-off

**Next-phase milestone: Explorer-style TreeView** — **PASS (2026-05-25)**. Tag candidate: `v0.2.0-treeview-wof`.

- [x] E-1〜E-5 Lazy TreeView with flat render and safety guards
- [x] F-1 Select file in Explorer (`explorer /select,file`)
- [x] G-1 Drive auto-detection selector
- [x] Size accuracy CLI/JSON experiments, including `--wof-adjusted`
- [x] UI-StoragePolicy-1 Storage policy selector (Current / WOF adjusted experimental) in Tauri UI
- [x] H-3 Next-phase milestone sign-off (PASS 2026-05-25; tag candidate: v0.2.0-treeview-wof)
- [ ] G-2 Drive selector polish
- [ ] H-1 TreeView UX polish
- [ ] H-2 README / runbook update

`--wof-adjusted` is experimental and does not affect the default UI/Tauri scan.

---

## Publication status

Public release is deferred until the app reaches the author's own daily-use threshold.
Current state is experimental and usable for personal disk analysis.
The next milestone (`v0.3.0-daily-use`) focuses on closing that gap before any public release decision.

---

## Deferred

| Feature | Notes |
|---------|-------|
| Virtual scroll | @tanstack/react-virtual — after TreeView polish |
| Treemap visualization | Proportional rectangle view of disk usage |
| Drive NTFS detection | Non-NTFS drives fail at scan time; detection is future work |
| WinSxS / hard link dedup | Avoid double-counting hard-linked files |
| Delete action | Requires safety design (confirmation, recycle bin, undo) — intentionally deferred |
