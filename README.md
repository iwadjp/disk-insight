# disk-insight

A local-first Windows disk usage viewer focused on fast NTFS scanning,
TreeView-first navigation, and cautious manual cleanup assistance.

## Status

Pre-release. Under active development.
Current development target: v0.6.0 public readiness.
No official GitHub Release has been published yet.
Current builds are local dogfooding artifacts only.
Do not treat current builds as stable production releases.

---

## Features

- Fast disk usage scanning via direct NTFS MFT read
- TreeView-first navigation with lazy folder expansion
- Occupancy bar column (relative size at a glance)
- View selector: All / Large review / Reviewable areas / Caution areas
- Bookmarks (persistent across sessions, jump to folder in tree)
- Review list (session-only staging list, batch copy paths)
- Explorer handoff: Show in Explorer, Select file, Show properties
- Insights panel: largest items under selected folder, subtree search
- Drive auto-detection
- Size metric selector: Current allocation / WOF-adjusted (experimental)
- Scan progress indicator with phase labels
- Advanced Mode gated Move to Recycle Bin (see Safety model below)

---

## Safety model

### Normal Mode (default)

The app starts in Normal Mode on every launch.
No destructive file operation is shown in Normal Mode.

### Advanced Mode

Advanced Mode is an explicit opt-in for a single session.
It resets to OFF each time the app is closed — it is non-persistent.

- Requires manual acknowledgement before enabling
- Unlocks: Move to Recycle Bin
- Each Move to Recycle Bin action requires per-item confirmation with path,
  size, and risk warnings shown before proceeding

**Move to Recycle Bin moves items to the Windows Recycle Bin only.**
**It is not permanent deletion.**
**Items in the Recycle Bin still occupy disk space until the bin is emptied.**

### Not implemented

Delete / Rename / Cut / Paste are not implemented.

---

## Privacy and network

- No network communication
- No telemetry or analytics
- No auto-updater
- Local-only operation
- App-managed data is written only to `%LOCALAPPDATA%\disk-insight\`
  (scan cache and bookmarks).
- File changes are not shown in Normal Mode.
- Move to Recycle Bin is available only after explicitly enabling Advanced Mode.

---

## Requirements

- Windows 10 or later
- NTFS volumes are the primary supported target.
  Other file systems are not the current focus and may have limited or
  unsupported behavior.
- Administrator privileges recommended for full MFT scan access
  (non-admin launch is possible but some scan operations may be limited)

---

## Known limitations

- **Pre-release**: not a stable production release
- **Unsigned binary**: may trigger SmartScreen on first run — expected for
  unsigned local tools; do not bypass security controls to run it
- **NTFS-focused**: NTFS is the primary supported target. Other file
  systems are not the current focus and may have limited or unsupported
  behavior.
- **Administrator rights**: full MFT scan requires elevated access
- **Cleanup classification is path-based heuristic**: Large review /
  Reviewable areas / Caution areas are derived from path patterns, not
  content analysis — they are starting points for manual review, not
  recommendations to delete anything
- **Large review uses top scan results**: only shows items present in the
  Top-N scan results, not all files on the drive
- **Reviewable / Caution areas use loaded tree rows**: only items that have
  been expanded in the current session are included
- **No automatic cleanup**: the app does not delete, move, or modify files
  automatically
- **No move-to-folder**: only Move to Recycle Bin (Advanced Mode required)
- **No multi-select file operations**: single-item Recycle Bin move only
- **No full shell context menu**: right-click shows app-defined options,
  not the Windows Explorer shell menu
- **No dark mode**: light theme only in current release
- **Size estimates**: values are allocation-oriented estimates and may differ
  from Explorer "Size" or other tools — differences are expected and bounded

---

## Build

### Prerequisites

- [Rust](https://www.rust-lang.org/) with MSVC toolchain
- [Node.js](https://nodejs.org/)
- [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/)
  (WebView2 runtime, Visual Studio build tools)
- Windows 10 or later

### Desktop UI

```powershell
# Install Node dependencies (first time)
npm install

# Development mode (hot reload, sample data loads on startup)
npm run tauri dev

# Production build
npm run tauri build
# Output: src-tauri\target\release\disk-insight-ui.exe
```

Run the built `.exe` as Administrator for full MFT scan access.
In release mode, the app starts with an empty state — select a drive and
click **Scan** to begin.

### CLI (secondary)

```powershell
cargo build --release
.\target\release\disk-insight.exe --drive C --top 100
.\target\release\disk-insight.exe --help
```

---

## Screenshots

TBD before public release.

---

## Company PC use

For use on a company PC, follow your organization's policy for unsigned
local tools.
Do not bypass Defender, EDR, AppLocker, SmartScreen, or other security
controls.
Use the default Normal Mode. Do not enable Advanced Mode on a company PC.

See `docs/security-overview.md` for the full safety posture description.

---

## Documentation

| File | Description |
|------|-------------|
| `docs/security-overview.md` | Full safety posture (Normal + Advanced model) |
| `docs/company-pc-dogfooding-checklist.md` | Go/No-Go checklist for company PC use |
| `docs/company-safe-build.md` | Company-PC dogfooding package build notes |
| `docs/v0.6.0-public-readiness-plan.md` | Public readiness checklist and phase plan |

---

## License

This project is licensed under the MIT License.

See [LICENSE](LICENSE).

---

## Disclaimer

This is pre-release software provided for local use and evaluation.
It is not a stable production release.
No warranty is provided.
Size estimates are diagnostic aids, not guarantees of exact space recovery.
