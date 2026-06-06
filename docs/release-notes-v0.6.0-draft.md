# disk-insight v0.6.0 draft release notes

## Status

Pre-release / public readiness candidate.

This is not a stable production release.
No official GitHub Release has been published yet unless this draft is later used for one.

## Highlights

- TreeView-first disk usage navigation
- Occupancy bar column for quick size comparison
- View selector: All / Large review / Reviewable areas / Caution areas
- Persistent bookmarks
- Session-only Review list
- Batch copy paths from Review list
- Explorer handoff actions
- Public-safe demo data for screenshots and evaluation
- Normal + Advanced safety model
- Advanced Mode gated Move to Recycle Bin
- Settings dialog consolidates less-frequently used controls: Font size, Content width, Top N, Size metric, Load demo
- Toolbar simplified to everyday actions: Drive, Advanced Mode, Settings, Scan
- Refresh scan restores the focused/selected tree location by path, with parent folder fallback if the target was removed
- Review list item sizes and status are refreshed after rescan
- Compact drive summary highlights Drive label, Used, Free, and Used percentage

## Safety model

Normal Mode is the default.
No destructive file operation is shown in Normal Mode.

Advanced Mode is explicit, session-only, and required for Move to Recycle Bin.
Move to Recycle Bin still requires per-item confirmation.

The app has:
- No network communication
- No telemetry or analytics
- No auto-updater

## Package

Package name:

```
disk-insight-v0.6.0-windows-x64.zip
```

Contents:

- disk-insight-ui.exe
- README.md
- LICENSE
- SECURITY-OVERVIEW.md
- BUILD-INFO.txt
- SHA256SUMS.txt

ZIP SHA256:

```
1e76fcb0e7986e9646e9fb5d4bdd34883a200a5a1f83d9a5316743096d902d4f
```

Build:

- Version: 0.6.0
- Commit: e4852a785799cc082d14336d1b28d04dbca1b298
- Signed: NO
- GitHub Release: NO at package build time

## Known limitations

- Pre-release / dogfooding candidate
- Unsigned binary
- Windows / NTFS-focused
- Administrator privileges recommended for full MFT scan access
- Cleanup classification is path-based heuristic
- Large review uses top scan results
- Reviewable / Caution areas use loaded tree rows
- No automatic cleanup
- No real move-to-folder
- No multi-select file operations
- No full Explorer shell context menu
- No dark mode
- Size estimates are allocation-oriented and may differ from Explorer

## Screenshots

Screenshots are included in README.md and use public-safe demo data.

## Notes for company PC use

Follow your organization's policy for unsigned local tools.
Do not bypass Defender, EDR, AppLocker, SmartScreen, or other security controls.
Use default Normal Mode unless you have explicit permission to enable Advanced Mode.

## Release gate

Before publishing, confirm:

- README is accurate
- LICENSE exists
- SECURITY-OVERVIEW is current
- Screenshots are public-safe
- Package hash is recorded
- Release notes are reviewed
- User explicitly approves GitHub push / tag / release
