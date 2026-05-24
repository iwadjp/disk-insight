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
- [ ] Drive input accepts `C`, `C:`, `c` (normalized to uppercase)
- [ ] Top selector changes top-N on next scan

### Scan UX

- [ ] Scanning banner and spinner appear while scan runs
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
- [ ] Top files table: "Copy path" copies the file path to clipboard

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
| `explorer /select` | Not implemented (Open folder opens parent, not file selection) |
| Drive detection | No automatic enumeration; enter drive letter manually |

---

## 9. Troubleshooting

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

### UI "not responding" during scan

`spawn_blocking` should prevent this. If it recurs:

1. Note the drive size and scan duration.
2. Check Task Manager for CPU/IO during scan.
3. Record steps to reproduce and file an issue.
