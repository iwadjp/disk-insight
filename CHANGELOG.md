# Changelog

All notable user-facing changes to disk-insight are documented here.

This project follows [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-09-04

First stable release. No new features compared to v0.6.0 — this release marks
the point where the feature set and the safety model are considered settled
for the 1.x line.

### What disk-insight is

A local-only Windows disk usage viewer. It reads NTFS MFT data for fast
scanning and presents a tree-first view for finding large folders and files
and reviewing them manually. It performs no automatic cleanup.

### Capabilities

- Fast disk usage scanning via direct NTFS MFT read
- TreeView-first navigation with lazy folder expansion
- Occupancy bar column for relative size at a glance
- View selector: All / Large review / Reviewable areas / Caution areas
- Bookmarks, persistent across sessions
- Review list — a session-only staging list with batch copy of paths
- Explorer handoff: Show in Explorer, Select file, Show properties
- Insights panel: largest items under the selected folder, subtree search
- Drive auto-detection and a compact drive summary
- Size metric selector: current allocation or WOF-adjusted (experimental)
- Advanced Mode gated Move to Recycle Bin, with per-item confirmation
- Secondary CLI (`disk-insight.exe`) with JSON output — built from source,
  not included in the release ZIP

### Safety model

- Normal Mode is the default on every launch and shows no destructive
  file operation.
- Advanced Mode is an explicit, session-only opt-in that resets to OFF when
  the app closes. It unlocks Move to Recycle Bin only.
- Move to Recycle Bin moves items to the Windows Recycle Bin. It is not
  permanent deletion, and each action requires per-item confirmation.
- Delete, Rename, Cut, and Paste are not implemented.

### Privacy

No network communication, no telemetry, no auto-updater. App-managed data is
written only to `%LOCALAPPDATA%\disk-insight\`.

### Important limitations

- Unsigned binary; may trigger SmartScreen on first run
- Windows 10 or later, NTFS-focused; other file systems may be limited
- Administrator privileges recommended for full MFT scan access
- Cleanup classification is a path-based heuristic, not content analysis
- No automatic cleanup, no move-to-folder, no multi-select file operations
- No dark mode
- Size estimates are allocation-oriented and may differ from Explorer
- Verification is concentrated on a single developer's environment

See the README for the complete list.

## [0.6.0] - 2026-06-06

Public pre-release for Windows x64 evaluation, published as a GitHub
pre-release. Introduced the TreeView-first layout, the review/caution view
selector, bookmarks, the Review list, the Normal + Advanced safety model, and
the consolidated Settings dialog.

## [0.1.0] - [0.5.x] - 2026

Pre-public development. The project moved from a minimal MFT scanner through
a TreeView with WOF-adjusted sizes, a safe viewer, Explorer-like context menu
actions, and the Advanced Mode Recycle Bin workflow. These versions were tagged
in the repository but never published as releases.

[1.0.0]: https://github.com/iwadjp/disk-insight/releases/tag/v1.0.0
[0.6.0]: https://github.com/iwadjp/disk-insight/releases/tag/v0.6.0
