# disk-insight v1.0.0 release notes

Prepared for the GitHub Release body. Everything below the horizontal rule is
the text to publish. One value must be substituted before publishing — see
"Before publishing" at the end of this file.

---

# disk-insight v1.0.0

First stable release.

disk-insight is a local-only Windows disk usage viewer. It reads NTFS MFT data
for fast scanning and presents a tree-first view for finding large folders and
files and reviewing them manually. It does not perform automatic cleanup.

There are no new features compared to v0.6.0. This release marks the point
where the feature set and the Normal / Advanced safety model are considered
settled for the 1.x line.

## What it does

- Fast disk usage scanning via direct NTFS MFT read
- TreeView-first navigation with lazy folder expansion
- Occupancy bar column for relative size at a glance
- View selector: All / Large review / Reviewable areas / Caution areas
- Bookmarks, persistent across sessions
- Review list — a session-only staging list with batch copy of paths
- Explorer handoff: Show in Explorer, Select file, Show properties
- Insights panel: largest items under the selected folder, subtree search
- Drive auto-detection and a compact drive summary
- Advanced Mode gated Move to Recycle Bin, with per-item confirmation
- Secondary CLI (`disk-insight.exe`) with JSON output — built from source,
  not included in this ZIP

## Safety model

Normal Mode is the default on every launch and shows no destructive file
operation.

Advanced Mode is an explicit, session-only opt-in that resets to OFF when the
app closes. It unlocks Move to Recycle Bin only, and each action still requires
per-item confirmation. Move to Recycle Bin moves items to the Windows Recycle
Bin — it is not permanent deletion, and items there still occupy disk space
until the bin is emptied.

Delete, Rename, Cut, and Paste are not implemented.

## Privacy

- No network communication
- No telemetry or analytics
- No auto-updater
- App-managed data is written only to `%LOCALAPPDATA%\disk-insight\`
  (scan cache and bookmarks)

## Requirements

- Windows 10 or later, x64
- NTFS volumes are the primary supported target. Other file systems are not
  the current focus and may have limited or unsupported behavior.
- Administrator privileges recommended for full MFT scan access.
  Non-administrator launch is possible, but some scan operations may be
  limited.

## Install

This is a portable ZIP. There is no installer.

1. Download `disk-insight-v1.0.0-windows-x64.zip` from the Assets below.
2. Extract it anywhere.
3. Run `disk-insight-ui.exe`, as Administrator for a full MFT scan.

To uninstall, delete the extracted folder. To also remove app data, delete
`%LOCALAPPDATA%\disk-insight\`.

### Upgrading from v0.6.0

Extract this release into a new folder and run it. Bookmarks and scan cache in
`%LOCALAPPDATA%\disk-insight\` are picked up automatically, so no migration
step is needed. The old v0.6.0 folder can be deleted once you are satisfied
with this build.

## Unsigned binary

`disk-insight-ui.exe` is **not code-signed**. Windows SmartScreen or Defender
may warn on first run. This is expected for an unsigned local tool.

Do not bypass Defender, EDR, AppLocker, SmartScreen, or other security controls
to run it. On a company PC, follow your organization's policy for unsigned
local tools and use the default Normal Mode.

Verify the download against the checksum below before running it.

## Known limitations

- Unsigned binary; may trigger SmartScreen on first run
- Windows / NTFS-focused
- Administrator privileges recommended for full MFT scan access
- Cleanup classification (Large review / Reviewable areas / Caution areas) is
  a path-based heuristic, not content analysis — a starting point for manual
  review, not a recommendation to delete anything
- Large review only shows items present in the Top-N scan results
- Reviewable / Caution areas only include tree rows expanded in the current
  session
- No automatic cleanup, no move-to-folder, no multi-select file operations
- No full Explorer shell context menu
- No dark mode
- Size estimates are allocation-oriented and may differ from Explorer "Size"
- Developed and used by a single developer; behavior on other hardware,
  display scaling, locales, and managed/enterprise configurations is not
  systematically tested

The README documents the full list.

## Package

Asset:

```
disk-insight-v1.0.0-windows-x64.zip
```

Contents:

- disk-insight-ui.exe
- README.md
- LICENSE
- SECURITY-OVERVIEW.md
- BUILD-INFO.txt
- SHA256SUMS.txt

ZIP SHA-256:

```
<SUBSTITUTE: zip SHA-256 printed by scripts\build-release-package.ps1>
```

## License

MIT. See LICENSE in the package.

---

## Before publishing

1. Replace the `<SUBSTITUTE: ...>` line above with the ZIP SHA-256 printed by
   `scripts\build-release-package.ps1`. The hash depends on the exact commit
   the package was built from, so it must be taken from the build that
   produced the asset actually being uploaded — do not reuse an earlier value.
2. Set the `## [1.0.0]` date in `CHANGELOG.md` from `Unreleased` to the
   publication date.
3. Publish as a normal release, **not** a pre-release.
4. Do not modify or replace the existing v0.6.0 tag, release, or asset.
