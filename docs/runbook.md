# disk-insight developer runbook

Step-by-step verification procedures for developers.
Use this before D-13 milestone sign-off and when confirming a build from scratch.

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Windows 10 / 11 | NTFS drives only |
| Rust MSVC toolchain | `rustup default stable-msvc` |
| Node.js + npm | For Tauri UI |
| Tauri build prerequisites | See [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) |
| **Administrator privileges** | Required for MFT access — run PowerShell or VS Code as Administrator |

MFT access requires reading `\\.\C:` as a raw device handle.
Without admin rights, scans will fail with a drive-open error.

---

## Repository locations

| Resource | Path |
|----------|------|
| Project root | `D:\iwa\AI\Claude\maybe_public\disk-insight` |
| Progress log | `D:\iwa\AI\Claude\private_notes\PROGRESS.md` |

> Do NOT create `PROGRESS.md` inside the project root.

---

## Current command quick reference

```powershell
# Normal current-policy scan
.\target\release\disk-insight.exe --drive C --top 30

# JSON output
cmd /c ".\target\release\disk-insight.exe --json --top 30 > .\work\probe7.json"

# Experimental WOF-adjusted CLI / JSON output
.\target\release\disk-insight.exe --drive C --top 30 --wof-adjusted
cmd /c ".\target\release\disk-insight.exe --json --top 30 --wof-adjusted > .\work\probe7-wof.json"

# Scan performance timing (K-1) - CLI output path, phase breakdown to stderr
.\target\release\disk-insight.exe --perf
.\target\release\disk-insight.exe --json --perf
.\target\release\disk-insight.exe --drive D --json --perf

# K-1c: CLI model path timing - same code path as Tauri scan_drive (K-1c)
# Compare [perf-cli-model] output with [perf-tauri] build_model done
.\target\release\disk-insight.exe --drive C --top 100 --perf-model
.\target\release\disk-insight.exe --drive C --top 100 --wof-adjusted --perf-model
.\target\release\disk-insight.exe --drive D --top 100 --perf-model
# Output format:
#   [perf-cli-model] build_model done  XXXX ms  root_children=NN top_dirs=100 top_files=100
#                    children_map_keys=NNNNNN children_map_total_children=NNNNNNN
#   [perf] drive=C:  policy=current  total=XXXX ms
#   [perf]   open_vol:      N ms
#   [perf]   read_mft:   NNNN ms
#   [perf]   parse:       NNN ms
#   [perf]   tree_build:  NNN ms
#   [perf]   aggregate:   NNN ms
#   [perf]   children_map:NNN ms
#   [perf]   total:      NNNN ms

# Comparison guide:
#   --perf        = CLI output path (build_mft_tree_output_with_policy)
#   --perf-model  = Tauri model path (build_mft_tree_model_with_policy)
#   [perf-tauri]  = Tauri UI, measured from scan_drive in src-tauri/src/main.rs
# If CLI --perf-model ≈ Tauri build_model: model path is the bottleneck
# If CLI --perf-model << Tauri: Tauri-specific factor (e.g. cold cache, thread scheduling)

# K-1d: cold vs warm cache measurement
# Purpose: confirm that Tauri 22.8s vs CLI 9.5s is explained by cold OS page cache
#
# Procedure:
#   1. Reboot Windows
#   2. Open an admin PowerShell (do NOT run any other disk scan first)
#   3. Run the first (cold) measurement:
.\target\release\disk-insight.exe --drive C --top 100 --perf-model
#   4. Immediately run the second (warm) measurement:
.\target\release\disk-insight.exe --drive C --top 100 --perf-model
#   5. If D: timing is also of interest:
.\target\release\disk-insight.exe --drive D --top 100 --perf-model
#
# What to look for:
#   read_mft cold 1st run  — expected much larger than warm (15–18 s vs 4.8 s)
#   read_mft warm 2nd run  — expected close to K-1c warm measurement (~4.8 s)
#   children_map           — expected stable between runs (~3.1 s)
#   total / build_model    — if cold ~22 s: confirms cold cache as primary cause
#
# Expected cold breakdown (estimate):
#   read_mft:     ~15–18 s   (MFT not in OS page cache)
#   parse:        ~0.5 s
#   tree_build:   ~0.5 s
#   aggregate:    ~0.2 s
#   children_map: ~3.1 s
#   total:        ~20–22 s   (matches Tauri K-1b 22.8 s)

# K-1b: Tauri UI end-to-end timing
# Run as admin, open DevTools (F12) > Console, scan C:
# [perf-tauri] lines appear in the terminal where tauri dev was launched
# [perf-ui] lines appear in the browser DevTools console
npm run tauri dev
# Then in DevTools console, look for:
#   [perf-ui] scan click
#   [perf-ui] invoke start
#   [perf-ui] invoke resolved  invoke_ms=XXXX
#   [perf-ui] setData called
#   [perf-ui] data rendered (rAF)
#   [perf-ui] direct children ready
# And in the terminal, look for:
#   [perf-tauri] scan_drive start
#   [perf-tauri] build_model done  XXXX ms
#   [perf-tauri] state_lock  X ms
#   [perf-tauri] scan_drive return  total=XXXX ms

# Size accuracy diagnostics
.\target\release\disk-insight.exe --diag-pfx86
.\target\release\disk-insight.exe --diag-wof-global
.\target\release\disk-insight.exe --diag-winsxs

# Tauri UI
npm run tauri dev
npm run tauri build
```

Notes:

- Default output is `current`.
- `--wof-adjusted` is experimental and applies only to CLI / JSON output.
- UI / Tauri live scan remains `current`.
- Delete is not implemented.
- Hardlink, WinSxS/component-store, and cluster deduplication are not
  implemented.

---

## 1. Rust CLI build

```powershell
cd D:\iwa\AI\Claude\maybe_public\disk-insight
cargo build --release
```

Expected: no errors, `target\release\disk-insight.exe` produced.

---

## 2. CLI — human-readable output

```powershell
.\target\release\disk-insight.exe
.\target\release\disk-insight.exe --drive C --top 50
```

Expected (as Administrator):

- MFT scan runs (may take 5–15 seconds)
- Top directories sorted by subtree size
- Top files sorted by allocated size

Expected (without admin rights):

- Error message containing "drive open failed" or similar
- No crash or hang

---

## 3. CLI — JSON output

```powershell
.\target\release\disk-insight.exe --json --top 100
```

Expected: valid JSON printed to stdout.

Experimental WOF-adjusted policy for CLI / JSON comparison:

```powershell
.\target\release\disk-insight.exe --drive C --top 100 --wof-adjusted
.\target\release\disk-insight.exe --json --top 100 --wof-adjusted
```

Default output remains `current`. `--wof-adjusted` uses `WofCompressedData`
stream allocation for safely detected WOF-compressed files, but does not apply
hardlink, WinSxS/component-store, or cluster deduplication.

### Save to file

PowerShell 5.1 `>` may produce UTF-16LE output, which breaks JSON parsers.
Use `cmd /c` for reliable UTF-8 output:

```powershell
mkdir work -ErrorAction SilentlyContinue
cmd /c ".\target\release\disk-insight.exe --json --top 100 > .\work\probe7.json"
```

### Validate JSON

```powershell
python -m json.tool .\work\probe7.json > $null
echo $LASTEXITCODE
```

Expected: exit code `0`. Non-zero means the file is not valid UTF-8 JSON
(likely a PowerShell encoding issue — use `cmd /c` instead).

---

## 4. Tauri UI — install dependencies

Run once after cloning or after `package.json` changes:

```powershell
npm install
```

---

## 5. Tauri UI — development mode

```powershell
npm run tauri dev
```

Expected:

- App window opens with sample data loaded
- Status bar shows "Sample data"
- Scan C: button starts a live scan
- Scanning banner and spinner appear during scan
- Window remains movable and scrollable during scan
- After scan: status bar shows "Live scan: C:" with timestamp and duration

---

## 6. Tauri UI — production build

```powershell
npm run build          # TypeScript + Vite (fast check)
npm run tauri build    # Full Rust + UI build
```

Expected output: `src-tauri\target\release\disk-insight-ui.exe`

Run as Administrator to enable live scan.

---

## 7. Minimal UI verification checklist

Work through these in order after building. Run as Administrator.

### Data loading

- [ ] Load sample — sample data appears, status shows "Sample data"
- [ ] Scan C: — scan runs and completes, status shows "Live scan: C:"
- [ ] Drive selector shows detected drives (C: and any others present)
- [ ] C: is pre-selected on startup
- [ ] Scan button label updates when a different drive is selected
- [ ] Top selector changes top-N on next scan

### Scan UX

- [ ] Scanning banner and spinner appear while scan runs
- [ ] Scanning banner shows phase label and elapsed time (e.g. "Reading MFT (I/O) · 4.2s") — K-2b
- [ ] Window is movable and scrollable during scan (not "not responding")
- [ ] Previous data remains visible during re-scan (no blank page flicker)

### Folder navigation

- [ ] Left pane lists folders from top_directories
- [ ] Clicking a folder row selects it (highlighted blue)
- [ ] Selected folder card updates with path, subtree size, direct file size, children count
- [ ] Right pane tables filter to the selected folder's subtree
- [ ] Selecting a drive root (e.g. `C:\`) shows all entries

### Actions

- [ ] Selected folder card: "Open folder" opens the folder in Explorer
- [ ] Selected folder card: "Copy path" copies the path to clipboard, button shows "Copied!" briefly
- [ ] Top files table: "Open folder" opens the file's parent folder in Explorer
- [ ] Top files table: "Select file" opens Explorer with the file highlighted (F-1)
- [ ] Top files table: "Copy path" copies the file path to clipboard

### Storage policy selector (UI-StoragePolicy-1)

- [ ] "Size policy" selector shows "Current (default)" by default
- [ ] Changing to "WOF adjusted (experimental)" shows amber warning inline
- [ ] Scanning with WOF adjusted: banner message appends `[WOF adjusted]`
- [ ] After WOF adjusted scan: status bar shows `wof_adjusted` badge (yellow)
- [ ] Switching back to "Current (default)" and scanning: badge disappears
- [ ] Allocated totals differ between current and WOF adjusted scans

### Safety

- [ ] No delete button exists anywhere in the UI
- [ ] No destructive action is reachable from the UI

---

## 8. Known limitations

| Area | Notes |
|------|-------|
| Size accuracy | Totals may differ from Windows Explorer "Properties" or WizTree |
| WinSxS | Hard-linked system files may be counted in multiple directories |
| WOF | Compressed files report allocated size, not compressed on-disk size |
| Hard links | Same clusters counted once per directory entry |
| Non-NTFS | FAT32 / exFAT / ReFS are not the current target |
| TreeView | No expand/collapse; sidebar shows flat top-N list |
| Virtual scroll | Not implemented |
| Delete | Not implemented |
| `explorer /select` | Implemented for top files (F-1). Not available for folders. |
| Drive detection | Automatic via GetLogicalDrives; C fallback in browser |

---

## 9. Diagnostic CLI

### `--diag-pfx86` — Program Files (x86) size discrepancy probe

```powershell
.\target\release\disk-insight.exe --diag-pfx86
```

Reports WOF / reparse / compressed / sparse / hardlink / multi-name signals for
three known-suspect subtrees:

- `C:\Program Files (x86)\Microsoft\EdgeCore`
- `C:\Program Files (x86)\Microsoft Office\root\Office16`
- `C:\Program Files (x86)\Microsoft Office\root\VFS`

Per-subtree output:
- record_index / parent / subtree_size / descendant counts
- top 30 files with attribute flags (cmp/sps/rps/sys/hid/wof) + hard link count
- WOF / reparse summary (counts and totals)
- WOF adjusted estimate (PFx86-DIAG-2): diagnostic-only replacement of WOF
  files with `WofCompressedData` stream allocation
- compressed / sparse summary
- hardlink / multi-name suspects (top 10)
- diagnostic notes (likely WOF / hardlink / needs deeper check)

**Purpose**: observation only. PFx86-DIAG-2 estimates whether WOF stream
allocation would move Program Files (x86) results closer to WizTree allocated
sizes, but normal CLI / JSON / UI size values are unchanged. Hardlink suspects
are reported only as remaining discrepancy candidates; no hardlink correction is
applied.

PFx86-DIAG-3 documents the proposed future WOF `final_alloc` policy in
`docs/wof-final-alloc-policy.md`. This is still diagnostic/design work; WOF
correction is not reflected in normal output.

PFx86-DIAG-4 adds `--diag-wof-global`, a global WOF-adjusted simulation for
estimating the impact before any normal-output size policy change. It reports
current vs WOF-adjusted totals, top WOF-impact directories, and top WOF-impact
files. Normal CLI / JSON / UI output is unchanged, and hardlink correction is
not applied.

```powershell
.\target\release\disk-insight.exe --diag-wof-global
```

PFx86-DIAG-5 adds `--diag-winsxs` for WinSxS / Windows component store residual
diagnostics. It reports current and WOF-adjusted totals, hardlink and
multi-name summaries, top hardlink suspects, WOF + hardlink overlap, top files,
top child directories, and `$FILE_NAME` parent cross-tree hints for Windows
component-store paths. Normal output is unchanged, and hardlink correction is
not applied.

```powershell
.\target\release\disk-insight.exe --diag-winsxs
```

> Redirect with `cmd /c` for UTF-8 output:
> `cmd /c ".\target\release\disk-insight.exe --diag-pfx86 > .\work\pfx86_diag.txt"`

## 10. Daily-use evaluation

To evaluate whether disk-insight meets the `v0.3.0-daily-use` milestone, use
the checklist at `docs/daily-use-retry-checklist.md`.

The checklist covers:
- Scan speed and progress strip effectiveness
- Folder navigation (drill-down, filter, sort, parent row)
- Size policy comparison (current vs wof_adjusted vs WizTree)
- Unique value assessment (delete-free, WOF comparison, Explorer integration)
- PASS / HOLD criteria and next-action guidance

Run the checklist with both WizTree and disk-insight open side by side.
Record results in `docs/daily-use-gap-review.md` Section 18.

---

## 11. Troubleshooting

### Drive open failed / access denied

Cause: insufficient privileges.
Fix: run the terminal, VS Code, or `.exe` as **Administrator**.

### JSON validation fails (python -m json.tool exits non-zero)

Cause: PowerShell `>` wrote UTF-16LE instead of UTF-8.
Fix: use `cmd /c "... > file.json"` for redirection.

### Tauri invoke unavailable (browser error)

Cause: running in a regular browser instead of the Tauri desktop app.
Fix: use `npm run tauri dev` or the built `.exe`.

### Scan takes 10+ seconds

Expected for large drives. MFT read time depends on drive speed and fragmentation.
`spawn_blocking` is used so the UI remains responsive throughout.

Cold-cache scans (first scan after boot or long idle) are slower — C: can reach
20–22 s, D: 60–80 s. This is normal.

The scanning strip (K-2b/K-2c) shows phase label, elapsed time, and an
indeterminate shimmer bar during scan: "Reading MFT (I/O) · 14.2s". This is
expected behavior. See `docs/scan-progress-design.md` for implementation details.

### UI "not responding" during scan

`spawn_blocking` should prevent this. If it recurs:

1. Note the drive size and scan duration.
2. Check Task Manager for CPU/IO during scan.
3. Record steps to reproduce and file an issue.
