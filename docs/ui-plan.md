# disk-insight UI plan

## D-1 sample JSON viewer

D-1 adds a minimal Tauri v2 + React/Vite UI scaffold.

The UI loads a small committed sample from `public/sample/probe7.sample.json` and displays:

- summary metrics
- top directories table
- top files table

The viewer does not start a real scan yet. It does not call Rust core APIs from the UI yet.

## D-2 readability improvements

D-2 improves the sample viewer tables without changing the app flow:

- sticky table headers inside scrollable table containers
- improved path readability with wrapping and monospace rendering
- monospace, right-aligned numeric table columns

## D-3a Tauri command wiring

D-3a changes the sample viewer data path from frontend `fetch` to Tauri `invoke`.

- frontend calls the `load_sample_json` Tauri command on startup
- the command returns the committed sample JSON only
- real scan commands are not implemented yet
- `build_mft_tree_output` is not called from the UI yet

## D-3a follow-up browser dev fallback

The sample viewer keeps Tauri `invoke` as the preferred runtime path.

- Tauri runtime uses the `load_sample_json` command
- normal browsers do not expose the Tauri invoke bridge
- browser dev fallback uses `fetch("/sample/probe7.sample.json")`
- real scan commands are still not implemented

## D-3b-1 Scan command wiring

D-3b-1 wires the Tauri `scan_drive` command to the React UI.

### Rust side

- Made `disk-insight` a library crate (`[lib]` in Cargo.toml, `src/lib.rs`).
- `src-tauri` depends on `disk-insight = { path = ".." }`.
- Added `scan_drive(drive: String, top: Option<usize>) -> Result<JsonTreeOutput, String>` Tauri command.
- Internally calls `build_mft_tree_output(drive_char, top_n)` from `disk_insight::mft_probe`.
- Errors are returned as String to the frontend.

### UI side

- Added "Load sample" and "Scan C:" buttons in the app header toolbar.
- "Load sample" calls the existing `load_sample_json` command (or browser fetch fallback).
- "Scan C:" calls `scan_drive("C", 100)` in Tauri runtime. In a normal browser it shows an error.
- Buttons are disabled while loading or scanning.
- Loading message: "Loading sample data..." or "Scanning C: ..."
- On error: displays the error message. For scan errors, adds hint: "Please run the app as administrator."

### Scope guard

- Real scan targets C drive only (no drive selection UI yet).
- Top count is fixed at 100 (no UI control).
- No progress bar, cancel button, TreeView, delete action, or Explorer open.
- Admin rights are required for MFT access; errors surface via the error display.

## D-3b-2 Scan status display

D-3b-2 improves the visual feedback around scan state without changing the MFT scan logic.

### Status bar

- Shown below the toolbar whenever data is present.
- Source badge: "Sample data" (blue pill) or "Live scan: C:" (green pill).
- Last updated timestamp: `YYYY-MM-DD HH:MM:SS` using local time.
- Scan duration: "Scan completed in X ms" — only for live scans.
- While a reload is in progress, appends "(updating…)" in italic.

### Scanning in progress

- Previous data remains visible during a new scan (no blank-page flicker).
- An amber banner with a CSS spinner appears above the data area while scanning.
- The full-page `.loading` placeholder is shown only before the first load.

### Error hints

- `isScanError` flag distinguishes scan errors from sample-load errors.
- In Tauri runtime: "Please run the app as administrator (required for MFT access)."
- In browser: "Run `npm run tauri dev` or use the built app."

## D-3b-3 Scan responsiveness improvement

D-3b-3 moves the blocking MFT scan off the Tauri main thread so the UI remains
responsive during a 6–11 second scan.

### Rust side

- `scan_drive` is now an `async` Tauri command.
- `build_mft_tree_output` is called inside `tauri::async_runtime::spawn_blocking`,
  which delegates the blocking work to a dedicated thread pool managed by Tauri's
  tokio runtime.
- The outer `.await` propagates task panics as `"scan task failed: ..."` errors.
- Return type and error format are unchanged from D-3b-1.

### Scope guard

- No progress events, progress bar, or cancel support.
- MFT scan logic (`build_mft_tree_output`) is unchanged.
- Drive selection and top-count UI are not added.

## D-4 Drive and top-count controls

D-4 adds drive letter input and top-count selector to the toolbar so the user
can configure the scan target without touching the CLI.

### Drive input

- Text input in the toolbar, initial value `C`, max length 2.
- Accepts `C`, `C:`, or `c` — normalized to uppercase before invoking `scan_drive`.
- Empty or non-letter input shows an inline error; no scan is started.
- Auto-enumeration of available drives is not implemented.

### Top-count selector

- `<select>` with fixed options: 10 / 30 / 50 / 100 / 200 / 500.
- Initial value: 100.
- The selected value is passed directly to `scan_drive(drive, top)`.
- Maximum option is 500; values above that are not offered.

### Scan button

- Label tracks the drive input: `Scan C:`, `Scan D:`, etc.
- `handleScan()` validates drive and top before calling `runLoad`.

### Status bar

- After a live scan, shows `Top N` (e.g. `Top 100`) next to the source badge.
- Scanning banner message includes the top count:
  `Scanning C: — reading NTFS metadata. Top 100 entries.`

### Scope guard

- Drive auto-enumeration is not implemented.
- No progress bar, cancel, TreeView, delete action, or Explorer open.
- MFT scan logic is unchanged.

## D-5 Simple folder navigation pane

D-5 adds a two-pane layout with a lightweight folder navigation sidebar built
from the existing `top_directories` list.

### Layout

- `.content-pane` — flex row containing the left and right panes.
- Left pane (`.folder-nav`, 360 px fixed) — scrollable list of top directories.
- Right pane (`.content-right`, flex: 1) — selected-folder card + existing tables.

### FolderNav (left pane)

- Lists every entry in `top_directories`.
- Each row shows the directory path (monospace) and subtree size.
- Active row is highlighted in blue.
- Clicking a row updates `selectedDir` state.

### SelectedFolderCard (right pane top)

- Shows the selected directory's path, subtree size, direct file size, and child count.
- Rendered above the existing DirectoriesTable and FilesTable.

### selectedDir state

- `selectedDir: DirectoryEntry | undefined` in App.
- Initialized / reset to `top_directories[0]` whenever new data is loaded.
- Updated by clicking a folder row.

### Scope guard

- No hierarchy expansion or collapse (not a real TreeView).
- Files table is not filtered by selected folder.
- No virtual scroll, delete action, Explorer open, or right-click menu.

## D-6 Selected folder filtering

D-6 filters the right-pane tables by the selected folder using the existing
`top_directories` and `top_files` arrays in the current JSON result.

### Filter logic

- `isDriveRoot(path)` — returns true for paths like `C:\` or `C:` (whole drive).
- `filterByDir(items, selectedPath)` — keeps items whose `path` equals `selectedPath`
  or starts with `selectedPath + "\\"`. Drive roots return all items.
- Applied to `top_directories` and `top_files` in the render; no data is re-fetched.

### Section titles

- Drive root selected: "Top directories" / "Top files" (unchanged).
- Subfolder selected: "Top directories under C:\\Users" / "Top files under C:\\Users".

### Empty state

- When filtered `top_files` is empty, a note is shown instead of an empty table:
  "No top files in this filtered result. Current JSON only contains global top entries."

### SelectedFolderCard note

- Added "Filtered within current top results" in small italic below the stats,
  making it clear this is not a full tree query.

### Scope guard

- Filter operates only on entries already present in the JSON result.
- No additional backend call or full-tree traversal.
- No virtual scroll, delete action, Explorer open, or right-click menu.

## D-6 follow-up: Windows path font rendering fix

D-6 follow-up fixes backslash characters in section headings rendering as
the yen sign (¥) on Japanese Windows where Inter/sans-serif maps U+005C to ¥.

### CSS

- Added `.heading-path` class: inherits `font-weight` and `font-size` from
  the heading but overrides `font-family` with Consolas/Cascadia Mono/monospace.

### main.tsx

- `DirectoriesTable` and `FilesTable` `title` prop widened from `string` to
  `React.ReactNode`.
- When a non-root folder is selected, the path segment in the `<h2>` title is
  wrapped in `<span className="heading-path">` so backslashes render as `\`.
- Drive-root titles (`"Top directories"`, `"Top files"`) remain plain strings.

### Scope guard

- No layout changes.
- No changes to MFT scan logic or data model.

## D-7 Explorer open for selected folder

D-7 adds a minimal "Open in Explorer" action for the selected folder.

### Rust side

- Added `open_in_explorer(path: String) -> Result<(), String>` Tauri command.
- Validates that `path` is non-empty and exists on disk (`Path::new(&path).exists()`).
- Launches Explorer via `std::process::Command::new("explorer.exe").arg(&path).spawn()`.
- Shell injection is avoided by passing the path as a single argument, not through a shell.

### UI side

- Added `openInExplorer(path)` async helper that calls the Tauri command.
  In a normal browser it throws "Explorer open is available only in the Tauri desktop app."
- `SelectedFolderCard` gains an `onOpenExplorer` prop and an "Open in Explorer" button.
- The card header is now a flex row: path info on the left, button on the right.
- On error, the existing error display is reused (`setError`); `isScanError` stays false.

### Scope guard

- Folder paths only — no `explorer /select` for files.
- No right-click menu, delete action, cmd open, or path copy.
- No admin privilege escalation.

## D-8 Open location for top files

D-8 adds an "Open location" action to each row of the top files table.

### UI side

- Added `getParentDir(filePath)` helper that extracts the parent directory
  from a Windows path.
  - `C:\Users\user\file.exe` → `C:\Users\user`
  - Root-level files (`C:\$MFT`, `i <= 2`) → `C:\`
- `FilesTable` gains an `onOpenLocation` prop (required).
- A new "Actions" column is added to the right of the files table.
- Each row has a small "Open location" button (`btn btn-sm`) that calls
  `onOpenLocation(getParentDir(row.path))`.
- In App, `onOpenLocation` is wired to `handleOpenExplorer`, which reuses
  the existing `openInExplorer` Tauri command.
- Browser runtime: same error as D-7 ("Explorer open is available only in
  the Tauri desktop app.").

### Scope guard

- Opens the parent folder — no `explorer /select` file highlighting.
- No file deletion, direct open, right-click menu, or path copy.
- No new Tauri command — reuses `open_in_explorer` from D-7.

## D-9 Copy path actions

D-9 adds clipboard copy buttons for the selected folder and each top-files row.

### UI side

- Added `CopyButton` component with local `copied` state.
  - Calls `navigator.clipboard.writeText(text)` (works in Tauri and modern browsers).
  - On success: shows "Copied!" for 2 seconds, then reverts to "Copy path".
  - On failure: calls `onError` with a message; rendered in the existing error display.
- `SelectedFolderCard` gains an `onCopyError` prop and a "Copy path" button next to
  "Open in Explorer". Both buttons sit in a `.selected-folder-actions` flex group.
- `FilesTable` gains an `onCopyError` prop. Each Actions cell wraps "Open location"
  and "Copy path" (via `CopyButton`) in an `.actions-cell` flex row.
- `.actions-col` widened from 120 px to 210 px to fit two buttons.

### Scope guard

- Copies the file path — no `explorer /select`, no file deletion, no cmd open.
- No new Tauri commands; clipboard uses the standard Web API.

## D-10 UI polish

D-10 makes small readability and label improvements without adding new features.

### Button labels

- "Open in Explorer" (SelectedFolderCard) → "Open folder"
- "Open location" (FilesTable row) → "Open folder"
- Both now use consistent language: you open the folder, whether it's the
  selected folder itself or the parent folder of a file.

### Empty state message

- Old: "No top files in this filtered result. Current JSON only contains global top entries."
- New: "No top files under this folder. Top entries shown are global — not scoped to this folder."
- Removes implementation-detail word "JSON"; adds plain English explanation.

### CSS tweaks

- `.actions-col`: 210 px → 190 px (fits shorter "Open folder" label); added
  `vertical-align: middle` so buttons align to row centre.
- `.actions-cell`: added `align-items: center` for consistent vertical alignment.
- `.selected-folder-stats`: added `margin-top: 6px` to separate stats from path.
- `.selected-folder-actions`: added `align-items: flex-start` for button group alignment.

### Scope guard

- No new features, Tauri commands, or layout restructuring.
- MFT scan logic unchanged.

## D-11 Minimal README

D-11 adds `README.md` at the project root as the entry point for the minimal
usable milestone.

### Content

- Project overview: WizTree-style MFT scanner, no delete action
- What it can do (scan, folder nav, Explorer open, copy path)
- What it cannot do yet (delete, TreeView, Treemap, right-click, /select, etc.)
- Requirements: Windows, NTFS, Administrator privileges
- CLI usage with PowerShell examples and UTF-16LE `cmd /c` redirect note
- Tauri UI: `npm run tauri dev` / `npm run tauri build`, admin note
- Documentation table pointing to `docs/json-output-schema.md`, `docs/ui-plan.md`, `CLAUDE.md`
- Known limitations table (WinSxS, WOF, hard links, non-NTFS, accuracy)
- Current milestone checklist (D-7 through D-13)

### Scope guard

- No source code changes.
- No new features.

## D-12 Developer runbook

D-12 adds `docs/runbook.md` as the developer verification reference before
the D-13 milestone sign-off.

### Content

- Prerequisites table (Windows, Rust MSVC, Node, Tauri, admin rights)
- Repository locations (project root, PROGRESS.md path)
- Rust CLI build steps
- CLI human-readable and JSON output verification
- `cmd /c` redirect note for UTF-8 JSON
- Tauri UI: dev and production build steps
- Minimal UI verification checklist (14 items: data loading, scan UX,
  folder nav, actions, safety / no-delete check)
- Known limitations table
- Troubleshooting (drive open failed, JSON encoding, browser invoke, slow scan, UI freeze)

### README update

- Added `docs/runbook.md` to the Documentation table.
- Marked D-12 as complete in the milestone checklist.

### Scope guard

- No source code changes.
- No new features.

---

## E-2 Folder TreeView (lazy expansion)

E-2 replaces the flat folder list with an Explorer-style TreeView backed by
`root_children` and the `get_children` Tauri command. Lazy expansion only
loads children when the user clicks the expand marker; no recursion happens
on initial render.

### Data flow

- Initial tree: `data.root_children` (from `scan_drive` or the embedded sample).
- Expansion: on first expand of a directory, the UI calls `get_children` and
  caches the result in `childrenByParent` keyed by `record_index`.
- Subsequent expand/collapse of the same node uses the cache (no extra calls).
- `scan_drive` and "Load sample" both reset the entire tree state
  (`expandedIds`, `loadingIds`, `childrenByParent`, `treeError`).

### UI components

- `TreeView` — left pane. Renders `root_children` as the top level rows and
  shows a `Root children: N` footer (or an error footer when something failed).
- `TreeNodeRow` — recursive row. Renders:
  - depth-based left padding (`8 + depth * 16` px),
  - an expand toggle (`▶` / `▼`, `…` while loading, hidden for files),
  - a label button with the entry name and `subtree_size`,
  - on click of the toggle: `onToggleExpand(node)`,
  - on click of the label (directories only): `onSelect(node)`.
- Files are shown but not interactive (no expand, no select). They use a
  muted color so the user can still see file siblings at a glance.

### State

In `App`:

- `expandedIds: Set<number>` — record indexes that are expanded.
- `loadingIds: Set<number>` — record indexes currently fetching children.
- `childrenByParent: Record<number, TreeNode[]>` — cached results.
- `treeError: string | null` — single shared error slot (last failure).

All `Set` updates use the functional form (`setX((prev) => new Set(prev))`)
to avoid stale-closure races when multiple expansions overlap.

### Right pane integration

Selecting a directory in the tree calls `setSelectedDir(treeNodeToDirEntry(node))`
so the existing `SelectedFolderCard`, `DirectoriesTable`, and `FilesTable`
prefix filtering continue to work unchanged. File selection is a no-op.

### Sample data

Sample data now ships with `root_children` (see "Sample data" below). On
sample, the tree shows the root level, but expansion fails with
`"Live scan required to load children. Run a scan in the Tauri app."`
because `get_children` is only populated after a live scan.

### Removed in E-2

The "Load children" button and inline preview added to `SelectedFolderCard`
in E-1b are removed. Their functionality is now integrated into the
TreeView's expand affordance, which is the natural place for it. The
`get_children` Tauri command itself is unchanged; only the UI surface moved.

### Sample data refresh

`public/sample/probe7.sample.json` was regenerated with the post-E-1a build
so it includes `root_children`. Without that field the TreeView would show
"No root entries available" on sample load, which would be a regression from
the E-1a folder nav. `top_directories` / `top_files` counts stay at 10.

### Scope guard

- No virtual scroll. Deep expansion is in-DOM and constrained by user clicks.
- No automatic expansion. The tree starts collapsed.
- No drag-and-drop, right-click menu, delete, or `explorer /select` for files.
- File rows are display-only — no selection-driven right-pane update.
- Tree state is per-session; not persisted across reloads.

---

## E-1b Lazy children command

E-1b adds the `get_children(parent_record_index)` Tauri command, backed by an
in-memory cache populated by `scan_drive`. This is the API foundation for
Explorer-style TreeView expansion; the full expand/collapse UI is not added
yet.

### Rust side

- Added `MftTreeModel { output, children_map }` in `mft_probe.rs`.
  - `output` is the existing `JsonTreeOutput`.
  - `children_map: HashMap<u64, Vec<JsonTreeNode>>` is keyed by directory FRN,
    with each value sorted by `subtree_size` desc, `name` asc.
- Renamed `build_mft_tree_output` to `build_mft_tree_model` (returns model).
- Added `build_mft_tree_output` as a thin wrapper returning only `output` for
  CLI use; existing CLI behavior is unchanged.
- `JsonTreeNode` now derives `Clone` so the cache can serve copies to callers.

### Tauri side

- Added `AppState { children_map: Mutex<Option<HashMap<u64, Vec<JsonTreeNode>>>> }`
  registered via `.manage()`.
- `scan_drive` now populates the state on success and returns `model.output`.
- Added `get_children(state, parent_record_index) -> Vec<JsonTreeNode>`:
  - Returns the cached children list for the given FRN.
  - Returns an error `"No live scan data is loaded. Run Scan first."` if no
    live scan has run in this session.
  - Returns `[]` if the FRN exists but has no entry in the map (e.g. a file).

### UI side

- Added `getChildren(parentRecordIndex)` helper invoking the Tauri command.
- `SelectedFolderCard` gained a "Load children" button next to "Open folder" /
  "Copy path".
- On click: calls `get_children` with the selected directory's `record_index`
  and shows a small preview:
  - `Children loaded: N` header.
  - First 5 entries with a `DIR`/`FILE` badge, path, and `subtree_size`.
  - `+ K more` footer when N > 5.
- Sample data or browser runtime show a clear message: "Children API is
  available after a live scan in the Tauri app."
- `childrenPreview` and `childrenError` are reset when the selected folder
  changes, a new scan starts, or sample data is reloaded.

### Scope guard

- No expand/collapse UI, no recursive expansion, no virtual scroll.
- Children list is returned in full (no top-N truncation per directory).
- `top_directories`, `top_files`, and `root_children` are preserved.
- CLI JSON output is unchanged.

---

## E-1a Root children data model

E-1a adds `root_children` to the JSON/API output as the first step toward an
Explorer-style TreeView. The existing folder navigation sidebar is not replaced.

### Rust side

- Added `JsonTreeNode` struct (`name`, `path`, `record_index`, `parent_record_index`,
  `is_directory`, `subtree_size`, `direct_file_size`, `child_count`).
- Added `root_children: Vec<JsonTreeNode>` to `JsonTreeOutput`.
- In `build_mft_tree_output`: after tree aggregation, extracts direct children of
  FRN 5 (NTFS root), sorts by `subtree_size` desc, limits to 200 entries.
- Human CLI output is unchanged.

### UI side

- Added `TreeNode` TypeScript type.
- Added `root_children?: TreeNode[]` to `DiskInsightOutput` (optional for
  compatibility with existing sample JSON).
- `FolderNav` footer shows `Root children: N` as a confirmation display.

### Scope guard

- `root_children` contains FRN-5 direct children only — no recursive expansion.
- No `get_children` Tauri command, no expand/collapse, no full TreeView, no virtual scroll.
- Existing folder nav (top_directories) is unchanged.
- Full lazy TreeView is planned for E-1b and later phases.

## G-1 Drive auto detection and selector

G-1 replaces the drive letter text input with a `<select>` populated by
the logical drives detected on the system at startup.

### Rust side

- Added `DriveInfo` struct (`letter`, `root`, `display`, `drive_type`) with `serde::Serialize`.
- Added `list_drives() -> Vec<DriveInfo>` Tauri command.
  - Calls `GetLogicalDrives()` to get the 26-bit drive mask.
  - For each set bit, computes the drive letter and calls `GetDriveTypeW` to classify:
    `fixed` / `removable` / `remote` / `cdrom` / `ramdisk` / `unknown`.
  - Returns all detected logical drives in alphabetical order.
- Added `windows = { version = "0.61", features = ["Win32_Storage_FileSystem"] }`
  and `serde = { version = "1", features = ["derive"] }` to `src-tauri/Cargo.toml`.

### UI side

- Added `DriveInfo` TypeScript type.
- Added `drives: DriveInfo[]` state in `App`, initialized to `[C: fallback]`.
- On mount (`useEffect`), calls `invoke("list_drives")` in Tauri runtime:
  - On success: updates `drives` state; sets `driveInput` to C if present,
    otherwise to the first detected drive.
  - On failure (or browser): silently keeps the C fallback.
- Replaced `<input className="drive-input">` with `<select className="top-select">`,
  rendering one `<option>` per drive (value = letter, display = `C:`).
- `handleScan` and the Scan button label continue to use `driveInput` unchanged.
- `parseDriveLetter(driveInput)` still validates before scan.

### Scope guard

- NTFS detection is not implemented. Non-NTFS drives fail at scan time with the
  existing MFT open error.
- Free/used space display, drive capacity, and a "refresh drives" button
  are not implemented.
- Normal browser runtime shows C: fallback and works correctly.
- No delete, right-click menu, Treemap, virtual scroll, or drive auto-refresh.

---

## F-1 follow-up: Select file status message

F-1 follow-up adds a short success message when "Select file" is invoked, so
users can tell the command was received even when Explorer opens in the background.

### Background

F-1 real-device testing showed the feature worked correctly, but Explorer sometimes
opened behind other windows without becoming the active application. The result
looked like no response.

### Changes

- Added `statusMessage: string | null` state in `App`.
  - Initialized to `null`; cleared on every `runLoad` (scan start / sample load).
- Added `getFileName(filePath)` helper that extracts the filename from a Windows path.
- `handleSelectFile` updated: on success, sets
  `statusMessage = "Explorer selection requested: <filename>"` and schedules
  `setTimeout(() => setStatusMessage(null), 3000)` to clear it after 3 seconds.
  On failure, routes the error to `setError` as before.
- `statusMessage` is rendered immediately below the error block:
  `<div className="status-message status-message--success">`.
- CSS added: `.status-message` (shared padding/border), `.status-message--success`
  (green — `#dcfce7` background, `#166534` text, `#86efac` border).

### What is NOT changed

- Explorer foreground/focus is not attempted — OS-dependent behavior, deferred.
- Open folder success is not shown — avoids UI noise for the common action.
- Rust core, Tauri commands, and JSON schema unchanged.
- No delete, right-click menu, Treemap, virtual scroll, or drive auto-detection.

---

## F-1 Explorer file selection for top files

F-1 adds a "Select file" action to each top-files row, opening the file highlighted
in Windows Explorer using `explorer.exe /select,<path>`.

### Rust side

- Added `select_in_explorer(path: String) -> Result<(), String>` Tauri command.
- Validates `path` is non-empty and exists on disk (`Path::new(&path).exists()`).
- Launches Explorer via `Command::new("explorer.exe").arg(format!("/select,{}", path))`.
- The `/select,<path>` argument is passed as a single `.arg()` value — no shell involved,
  no shell injection risk.
- Distinct from `open_in_explorer`: that command opens the parent folder; this command
  opens Explorer and selects the specific file in the parent folder.

### UI side

- Added `selectInExplorer(path)` async helper invoking the Tauri command.
  In a normal browser it throws "File selection is available only in the Tauri desktop app."
- `FilesTable` gains an `onSelectFile` prop (required).
- Actions column button order: **Open folder → Select file → Copy path**.
- On error, the existing `setError` display is reused; `isScanError` stays false.
- `handleSelectFile` in App calls `selectInExplorer` and routes errors to `setError`.

### CSS

- `.actions-col` widened from 190 px to 260 px to accommodate three buttons.

### Scope guard

- Files only — `select_in_explorer` is not exposed on folders or the selected-folder card.
- No file deletion, file open, right-click menu, cmd open, Treemap, or virtual scroll.
- Rust core, JSON schema, and TreeView code unchanged.

---

## E-5 TreeView safety guards

E-5 adds minimum safety guards to the lazy TreeView without adding virtual
scroll or changing the user-visible layout significantly.

### Duplicate request guard

- `handleToggleExpand` checks `loadingIds.has(id)` before firing `get_children`.
  If the node is already loading, the handler returns immediately. This prevents
  duplicate Tauri command calls on rapid toggle clicks.
- The existing `disabled` prop on the toggle button provides UI-level protection;
  this guard is the code-level backstop.

### Per-node error display

- Added `childrenErrors: Record<number, string>` state in `App`.
- On `get_children` failure, the error is stored per node in `childrenErrors`
  instead of (only) the shared `treeError` slot.
- `buildVisibleRows` emits a `nodeError` placeholder row at `depth + 1` for
  directories whose load failed.
- A retry (clicking the toggle again) clears the per-node error, re-enters the
  loading path, and fires a new `get_children` call.
- `childrenErrors` is reset alongside other tree state on every `runLoad`.

### Large folder warning

- `LARGE_FOLDER_THRESHOLD = 200` children.
- When an expanded directory has more than 200 children, `buildVisibleRows`
  emits a `largeWarning` row before the children rows.
- Display: `"Large folder: N children loaded. Virtual scrolling is not enabled yet."`
- Children are still fully shown — this is a warning only. Virtual scroll is E-6.

### Visible-rows count warning

- `LARGE_TREE_THRESHOLD = 1000` visible rows.
- Footer shows `Visible rows: N — consider collapsing folders.` in amber when
  `visibleRows.length >= 1000`.
- Below threshold: `Root children: N · Visible rows: N` (unchanged).

### VisibleTreeRow additions

- `nodeError?: string` — error message for a failed `get_children` load.
- `largeWarning?: number` — child count when a parent exceeds the threshold.

### What is NOT in E-5

- Virtual scroll is still not implemented (E-6).
- `expand all` is not implemented and must not be added.
- User-driven expansion only — no programmatic or automatic expansion.
- Rust core, Tauri commands, JSON schema unchanged.
- No delete, `explorer /select`, right-click menu, or Treemap.

---

## E-4 Flattened visible-tree list

E-4 replaces the recursive `TreeNodeRow` render with a flat `visibleRows`
array, preparing the structure for virtual scroll (E-6) without introducing
it yet. Behavior and appearance are unchanged from the user's perspective.

### Changes

- Added `VisibleTreeRow` type: `{ node: TreeNode; depth: number; isEmpty?: true }`.
- Added `buildVisibleRows(rootChildren, expandedIds, childrenByParent)`
  module-level function. Walks the expanded tree and emits flat rows, including
  `isEmpty` placeholder rows for expanded directories with no children.
- `useMemo` in `App` computes `visibleRows` from `[data?.root_children,
  expandedIds, childrenByParent]`. Recomputes only when those references change.
- `TreeNodeRow` is now a non-recursive single-row component. Removed:
  `childrenByParent` prop, the `cached` variable, the `<>` fragment wrapper,
  and all recursive child rendering. Returns a plain `<div>`.
- `TreeView` receives `rootCount` and `visibleRows` instead of `rootNodes` +
  `childrenByParent`. Renders `visibleRows.map(...)` flat. Shows
  `(empty)` divs inline for `row.isEmpty` entries.
- Footer updated: `Root children: N · Visible rows: M`.

### Scope guard

- No virtual scroll.
- No safety limits / large-node warnings (E-5).
- No new dependencies.
- Rust core, Tauri commands, and JSON schema unchanged.
- No delete, `explorer /select`, right-click menu, or Treemap.

---

## E-3 TreeView performance plan

E-3 is **planning only**. No source code changes. It produces
`docs/treeview-performance-plan.md`, the design map for scaling the TreeView
to large NTFS volumes without painting later phases into a corner.

### Scope

- Document the post-E-2 architecture (root_children + lazy `get_children` +
  `childrenByParent` cache + frontend state).
- Capture order-of-magnitude scale from the development C: drive
  (~1.33M files, ~347k directories, 53 root children, ~5–11 s scan).
- Enumerate large-tree risks (DOM blow-up, recursive render cost, expand
  storm, AppData/node_modules hot spots, sample-mode confusion).
- Define rules to follow **until** virtual scroll lands (initial render
  bounded, expansion user-driven only, sample mode read-only, etc.).
- Compare windowing options: `@tanstack/react-virtual` vs `react-window`
  vs hand-rolled.
- Propose E-4 → E-7 incremental tasks (flatten, safety limits, virtual
  scroll PoC, polish).

### Recommended next step

**E-4: Flattened visible-tree list.** Replace recursive `TreeNodeRow`
rendering with a `visibleRows` flat array derived from `root_children`,
`expandedIds`, and `childrenByParent`. Behavior unchanged from the user's
perspective; unlocks E-5 / E-6 cleanly.

### Out of scope

- Virtual scroll is deferred to E-6 at the earliest.
- No new dependencies in E-3.
- No changes to Rust core, Tauri commands, or JSON schema.
- File deletion, `explorer /select`, right-click menu, Treemap, and
  auto-expansion remain explicitly out of scope.

---

## PFx86-DIAG-3 WOF final_alloc policy design

PFx86-DIAG-3 adds `docs/wof-final-alloc-policy.md` as a design-only document
for possible future WOF size correction. This is a size-accuracy line of work,
separate from UI functionality. Normal display, JSON output, TreeView data, and
Tauri behavior are unchanged.

PFx86-DIAG-4 adds `--diag-wof-global` for global WOF-adjusted simulation. It is
still size-accuracy diagnostics only; normal UI sizes are unchanged.

PFx86-DIAG-5 adds `--diag-winsxs` for WinSxS / component-store residual
diagnostics. This remains separate from UI work and does not change displayed
sizes.

WOF-1 adds `--wof-adjusted` as an experimental CLI / JSON option. The UI and
Tauri live scan still use the default `current` storage policy.

---

## E-2 follow-up: Tree selection behavior

E-2 follow-up confirms and clarifies click behavior in the TreeView.

### Behavior

- **Toggle click (▶ / ▼)**: expands or collapses the directory. Does not change
  the selected folder. `e.stopPropagation()` is added to the toggle button so it
  cannot interfere with any ancestor click handler.
- **Folder label click**: updates `selectedDir` to the clicked directory.
  `SelectedFolderCard` and the prefix filter in the right pane follow immediately.
- **File row**: not interactive (no selection, no expansion). Displayed with
  muted color for context only.

### Active highlight

`selectedDir?.record_index` drives the `tree-row--active` class. After a label
click, the clicked row is highlighted and the card shows the correct full path.

### Scope guard

- No change to Rust core, Tauri commands, or JSON schema.
- No virtual scroll, delete, right-click menu, or `explorer /select`.

---

## I-1 TreeView polish (post-v0.2.0)

I-1 improves the visual quality and usability of the left-pane TreeView without
adding new features or changing data flow.

### Changes

- **Active row accent**: added `box-shadow: inset 3px 0 0 #1a56db` to
  `.tree-row--active` so the selected row has a visible left-edge blue bar.
  Uses `box-shadow` (not `border-left`) to avoid disrupting the depth-based
  inline `padding-left`.
- **Hover**: darkened from `#f0f4f8` to `#edf2f7` for slightly more contrast.
- **Name truncation**: `.tree-name` changed from `word-break: break-all /
  overflow-wrap: anywhere` (wrapping) to `overflow: hidden; text-overflow:
  ellipsis; white-space: nowrap` (single-line with ellipsis). Also added
  `flex: 1; min-width: 0` so the flex layout honours the truncation. The full
  path remains visible via the existing `title` tooltip on the label button.
- **Toggle hit area**: `.tree-toggle` increased from 22×22 px to 24×24 px;
  font-size increased from 11 px to 12 px.
- **Loading indicator**: added `tree-row--loading` class to `TreeNodeRow` when
  `isLoading` is true. CSS rule `.tree-row--loading > .tree-toggle` colours the
  toggle `#1a56db` (blue) while the `…` spinner is showing.
- **Large folder warning**: added `background: #fffbeb; border-bottom-color:
  #fde68a` to `.tree-large-warning` so the amber warning row is clearly
  distinct from normal tree rows.

### Scope guard

- Virtual scroll is not implemented.
- No new features or Tauri commands.
- Rust core, MFT scan, final_alloc policy unchanged.
- Delete action not added.

---

## UI-StoragePolicy-1 Storage policy selector

UI-StoragePolicy-1 exposes the `--wof-adjusted` storage policy in the Tauri UI
as an optional, clearly experimental alternative. The default `current` policy
is unchanged; all existing behavior is preserved.

### Rust side

- `scan_drive` Tauri command gains `storage_policy: Option<String>` parameter.
- `Some("wof_adjusted")` maps to `StoragePolicy::WofAdjusted`.
- Any other value (including `None`) maps to `StoragePolicy::Current`.
- Calls `build_mft_tree_model_with_policy(drive_char, top_n, policy)`.
- Import changed from `build_mft_tree_model` to `build_mft_tree_model_with_policy`
  and `StoragePolicy`.

### UI side

- Added `storagePolicy: string` state in `App`, initialized to `"current"`.
- Added `<select className="top-select">` labeled "Size policy" in the toolbar,
  with options:
  - `current` — "Current (default)"
  - `wof_adjusted` — "WOF adjusted (experimental)"
- Inline `<span className="policy-warning">` appears next to the selector when
  `wof_adjusted` is selected. Text: "Experimental — no hardlink/WinSxS dedup"
- `scanDrive(drive, top, storagePolicy)` passes `storagePolicy` to Tauri as
  `storagePolicy` (Tauri snake_case conversion maps to `storage_policy`).
- `handleScan` reads `storagePolicy` state and passes it to `runLoad`.
- Scanning banner message appends `" [WOF adjusted]"` when the policy is
  `wof_adjusted`.
- `Summary` TypeScript type gains optional `allocated_size?: number` and
  `storage_policy?: string` fields.
- `StatusBar` shows a `source-badge--experimental` badge labeled `wof_adjusted`
  for live scans when `data.summary.storage_policy` is not `current`.

### CSS

- Added `.source-badge--experimental` (yellow tones: `#fef9c3` bg / `#854d0e` text).
- Added `.policy-warning` (amber inline warning: `#fffbeb` bg / `#92400e` text,
  `#fde68a` border, `border-radius: 4px`).

### Scope guard

- Default scan policy remains `current`. WOF adjusted is only active when the
  user explicitly selects it.
- Hardlink, component-store, WinSxS, and cluster deduplication are not applied.
- `final_alloc` policy for `current` is unchanged.
- Load sample always uses the embedded JSON (no policy selector applied).
- No delete action, right-click menu, virtual scroll, or Treemap.

---

## Completed phases summary

| Phase | Description |
|-------|-------------|
| B-4 | サイズ取得・補正方針（final allocated size policy） |
| B-5 | ツリー集計（parent_frn subtree aggregation） |
| C-1 | JSON 出力（`--json` / `JsonTreeOutput`） |
| C-2 | API/CLI 境界整理（`build_mft_tree_output` 公開） |
| C-3 | CLI 引数整備（`--drive` / `--top` / `--help`） |
| C-4 | JSON schema docs |
| C-5 | API 境界メモ整理 |
| D-1 | Tauri v2 + React/Vite scaffold / sample JSON viewer |
| D-2 | UI readability（sticky header・path wrapping・数値右寄せ） |
| D-3a | Tauri invoke で sample JSON ロード |
| D-3a FU | 通常ブラウザ向け fetch fallback 追加 |
| D-3b-1 | UI から `scan_drive` で実スキャン |
| D-3b-2 | Scan 状態表示改善（status bar・scanning banner） |
| D-3b-3 | `spawn_blocking` による UI 応答性改善 |
| D-4 | Drive / Top 件数 UI 指定 |
| D-5 | 簡易フォルダナビ（左ペイン） |
| D-6 | 選択フォルダ配下の簡易フィルタ |
| D-6 FU | backslash / yen sign 表示対策（`.heading-path`） |
| D-7 | 選択フォルダを Explorer で開く |
| D-8 | top files 各行の Open location（親フォルダを Explorer で開く） |
| D-9 | selected folder / top files の Copy path（クリップボード） |
| D-10 | UI polish（ボタン文言・empty message・CSS 微調整） |
| D-11 | README.md 作成（概要・CLI/UI使用例・既知制限） |
| D-12 | docs/runbook.md 作成（開発者向け実行確認手順・UI チェックリスト） |
| D-13 | Minimal usable milestone 判定: **PASS** (2026-05-24) |
| E-1a | root_children を JSON に追加、Explorer風TreeView の第一歩 |
| E-1b | Tauri state に children map を保持、get_children command 追加 |
| E-2  | 左ペインを Explorer風TreeView に置き換え、lazy expansion + children cache |
| E-2 FU | TreeView 選択動作の確認・整理（stopPropagation、label click で selected folder 更新） |
| E-3 | TreeView performance plan 作成（docs/treeview-performance-plan.md、実装なし） |
| E-4 | visibleRows flat list 導入（非再帰 render、virtual scroll 前提構造） |
| E-5 | TreeView safety guards（duplicate guard、per-node error、large folder warning） |
| F-1 | top files に Select file 追加（Explorer `/select,file` でファイル選択表示） |
| F-1 FU | Select file 成功時ステータスメッセージ表示（Explorer 背面表示の無反応感を軽減） |
| G-1 | Drive 自動検出（GetLogicalDrives / GetDriveTypeW）、Drive selector 化 |
| UI-StoragePolicy-1 | Size policy selector（Current / WOF adjusted experimental）、status bar policy badge |
| I-1 | TreeView polish（active accent bar、hover、ellipsis truncation、toggle hit area、loading color、large-warning bg） |
| J-1 | Daily-use gap review（docs/daily-use-gap-review.md 作成、最重要ブロッカーを特定） |
| J-2 | Selected folder direct children panel（get_children 再利用、dir-first / size-desc、actions 付き） |

---

## Minimal usable milestone: 削除なし最小実用品

**STATUS: PASS — 2026-05-24**

短期ゴール。以下がすべて揃った状態を一区切りとする。

- [x] C ドライブを高速スキャンできる
- [x] フォルダ容量が見える
- [x] 大きいファイルが見える
- [x] フォルダを選択できる
- [x] 選択フォルダ配下の候補が見える
- [x] Explorer で場所を開ける
- [x] 削除機能はまだ入れない
- [x] 危険操作なしで容量調査に使える状態

### 次候補（milestone 以降）

- `explorer /select` によるファイル選択表示
- ドライブ自動列挙
- 本格 TreeView（折りたたみ・仮想スクロール）
- WinSxS / hardlink 精度改善
- delete action（安全設計・確認ダイアログ付きで後フェーズ）

---

## Remaining tasks before minimal usable milestone

### D-8 Top files の場所を Explorer で開く ✓

- top files の各行に "Open location" ボタンを追加
- 親フォルダを `open_in_explorer` で開く（`explorer /select` は後回し）
- Tauri 環境のみ有効

### D-9 パスコピー機能 ✓

- selected folder の path copy
- top files の path copy
- クリップボードコピーのみ
- 削除はしない

### D-10 UI 小整理 ✓

- ボタン配置の見直し
- 表示名の整理
- selected folder card の整理
- top 件数の説明
- empty message の文言整理

### D-11 README 最小版作成 ✓

- 目的
- 管理者権限が必要な旨
- 起動方法（CLI / Tauri UI）
- CLI 使用例
- 現時点で削除機能なし
- 既知差分（WinSxS / WOF / hardlink など）

### D-12 実行手順整理 ✓

- `cargo build --release`
- `npm run tauri dev`
- `npm run tauri build`
- JSON 出力確認手順
- PowerShell `>` の UTF-16LE 問題（`cmd /c` リダイレクト推奨）

### D-13 Minimal usable milestone 判定 ✓ PASS — 2026-05-24

チェックリスト:

- [x] Scan C: が動作する
- [x] Top folders / top files が表示される
- [x] Folder selection が動作する
- [x] Explorer open が動作する（selected folder / top files 両方）
- [x] Path copy が動作する（selected folder / top files 両方）
- [x] README がある
- [x] Clean build（TypeScript エラーなし・Rust 警告なし）
- [x] disk-insight / private_notes 両リポジトリ clean
- [x] 削除機能なし最小実用品として一区切り

---

## Deferred tasks

以下は next-phase milestone 以降に検討する。

- ファイル削除（安全設計・確認ダイアログ必須）
- 右クリックメニュー
- 本格 virtual scroll（@tanstack/react-virtual、E-6）
- Treemap
- WinSxS / hardlink / WOF 精度追求
- drive NTFS 判定・容量/空き領域表示
- コマンドプロンプトで開く
- size discrepancy diagnostics の拡張（PFx86-DIAG-1 が CLI 診断のみで実装済み、
  他の主要サブツリー（WinSxS / WindowsApps / AppData/Local/Docker など）への展開）

完了済み（以前 deferred だったもの）:
- `explorer /select` によるファイル選択表示 → F-1 で実装
- ドライブ自動列挙 → G-1 で実装
- TreeView 折りたたみ（仮想スクロールなし） → E-2〜E-5 で実装

---

## next-phase milestone: Explorer風TreeView実用品

**STATUS: PASS — 2026-05-25** (H-3 verification complete; tag candidate: v0.2.0-treeview-wof)

minimal usable milestone（D-13 PASS）の次の一区切り。
Explorer 風の TreeView を中心に据えた実用品として、以下がすべて揃った状態を目標とする。

### Current status snapshot

- `v0.1.0-minimal` is tagged as the no-delete minimal usable milestone.
- `next-phase` targets an Explorer-style TreeView usable as the primary folder
  navigation surface.
- Lazy TreeView, `visibleRows` flat rendering, and TreeView safety guards are
  implemented.
- Explorer "Select file", the select-file success message, and Drive selector
  are implemented.
- Size accuracy work is a separate line from UI functionality.
- `--wof-adjusted` is available as an experimental CLI / JSON option.
- The UI now exposes a "Size policy" selector (UI-StoragePolicy-1):
  - Default: `Current (default)`.
  - Optional: `WOF adjusted (experimental)` with inline warning.
  - Status bar shows a `wof_adjusted` badge when a WOF-adjusted scan is live.
  - Hardlink, WinSxS, and component-store correction are not applied.
- Delete, virtual scroll, hardlink correction, and WinSxS/component-store
  correction are not implemented.

### 達成済み（next-phase で完了）

| フェーズ | 内容 |
|----------|------|
| E-1a | root_children をスキャン結果に追加 |
| E-1b | `get_children` Tauri command（lazy children cache） |
| E-2 | 左ペインを Explorer 風 TreeView に置き換え（lazy expansion） |
| E-2 FU | TreeView 選択動作の確認・整理（toggle / label 分離） |
| E-3 | TreeView performance plan ドキュメント作成 |
| E-4 | `visibleRows` flat list 導入（非再帰 render、virtual scroll 前提） |
| E-5 | TreeView safety guards（duplicate guard・per-node error・large folder warning） |
| F-1 | top files に Select file ボタン追加（`explorer /select,file`） |
| F-1 FU | Select file 成功時ステータスメッセージ表示 |
| G-1 | Drive 自動検出（`GetLogicalDrives` / `GetDriveTypeW`）、Drive selector 化 |
| UI-StoragePolicy-1 | Size policy selector（Current / WOF adjusted experimental）、status bar policy badge |

### 残タスク候補

#### G-2: Drive selector polish（小）

- `drive_type` 表示（fixed / removable など）を option text や tooltip で見せる
- 選択中ドライブの補足（例: 現在スキャン済みの drive を badge 表示）
- NTFS 判定はまだ後回し

#### H-1: TreeView 操作性 polish（中）

- 選択行の視認性向上
- 展開中 / エラー行の見え方改善
- サイズ列の揃え
- root / folder / file の見た目整理

#### H-2: README / runbook 更新（小）

- next-phase で追加された機能（TreeView / Select file / Drive selector）を反映
- TreeView の使い方・展開方法を追記
- runbook のチェックリストを next-phase 対応に更新

#### H-3: next-phase milestone 判定

**STATUS: PASS — 2026-05-25**

milestone candidate: **v0.2.0-treeview-wof**

チェックリスト:
  - [x] TreeView で任意フォルダまで展開できる
  - [x] 選択フォルダが right pane に反映される
  - [x] top files の Select file が動作する
  - [x] Drive selector に検出ドライブが表示される
  - [x] Scan / Load sample が動作する
  - [x] Open folder / Copy path が動作する
  - [x] delete 機能が追加されていない
  - [x] virtual scroll は未実装のままで問題ない
  - [x] drive NTFS 判定は未実装のままで問題ない

追加確認:
  - [x] `cargo build --release` / `npm run build` / `npm run tauri build` 全て成功（警告なし）
  - [x] `--wof-adjusted` CLI/JSON 動作確認（current 186 GB / wof_adjusted 170 GB）
  - [x] `--diag-pfx86` / `--diag-wof-global` / `--diag-winsxs` 全て動作
  - [x] Size policy selector UI（Current default / WOF adjusted experimental）動作確認
  - [x] status bar policy badge 表示確認
  - [x] 両リポジトリ clean

含まれる成果物:
  - Drive selector（G-1）
  - lazy TreeView + visibleRows flat render + safety guards（E-1a〜E-5）
  - Open folder / Select file / Copy path
  - Select file 成功メッセージ
  - Current / WOF adjusted policy の UI 切替（UI-StoragePolicy-1）
  - `--wof-adjusted` 実験的 CLI/JSON オプション
  - `--diag-pfx86` / `--diag-wof-global` / `--diag-winsxs` 診断 CLI
  - WOF final allocation policy docs / WinSxS 残差ドキュメント

含まれない（後回し）:
  - delete action
  - virtual scroll
  - hardlink / component-store dedup
  - WinSxS correction
  - WOF adjusted をデフォルトに昇格
  - NTFS 判定・ドライブ容量表示

### 後回し（next-phase milestone より後）

- delete action（安全設計・確認ダイアログ必須）
- virtual scroll 本実装（E-6: @tanstack/react-virtual）
- drive NTFS 判定・容量 / 空き領域表示
- Treemap
- 右クリックメニュー
- cmd open
- WinSxS / hardlink / WOF 精度改善

---

## v0.3.0-daily-use milestone (candidate)

**STATUS: in progress — 2026-05-25**

次ゴール: 著者が自分の用途で毎日使えるレベルに達すること。
公開判断はその後（daily-use PASS 後に改めて判断する）。

### 背景

v0.2.0-treeview-wof は機能的に動作しているが、
WizTree の代替として日常使いするには不満点がある。
v0.3.0 では実際に使ってみて見つかったギャップを埋めることを優先する。
実装よりも「使って確かめる」を重視する段階。

### J-1: Daily-use gap review（観察・記録のみ）

**STATUS: COMPLETE — 2026-05-25** (docs/daily-use-gap-review.md 参照)

WizTree と並べて使い、不満点・不足点を洗い出す。
実装はしない。観察・記録のみ。

- どのフォルダに行くか、どういう操作をするか
- WizTree で自然にできて disk-insight でできないこと
- UI の不満点（操作手数・見にくさ・速度感）
- 結果: 次に実装する候補の優先順位を決める

主要な発見:
- 右ペインが global top-N の prefix filter であることが最大のブロッカー
- selected folder の direct children を表示できないため、フォルダを掘っても中身が見えない
- J-2 Selected folder detail panel を最優先で実施する

### J-2: Selected folder direct children panel

**STATUS: COMPLETE — 2026-05-25**

Gap A（右ペインが global top-N prefix filter）を解消する最重要実装。

#### 変更内容

- `DirectChildrenPanel` コンポーネントを追加（ui/src/main.tsx）
  - selected folder の direct children を取得・表示
  - 既存 `childrenByParent` キャッシュを再利用（TreeView と共有）
  - キャッシュにない場合は `get_children(selectedDir.record_index)` を自動発行
  - dir-first / size-desc / name-asc でソート
  - 各行: DIR/FILE バッジ・名前（ellipsis）・サイズ・アクション
    - folder: Open folder, Copy path
    - file: Open folder, Select file, Copy path
  - Loading / error / sample / empty のそれぞれの状態表示
- `useEffect` を追加（App 内）
  - `selectedDir` または `sourceKind` が変わったら children を取得
  - cancelled flag でステール更新を防止
- `selectedChildrenLoading` / `selectedChildrenError` state を追加
- `runLoad` でリセット
- `SelectedFolderCard` の "Filtered within current top results" ノートを削除
- 既存 DirectoriesTable / FilesTable のタイトルを更新
  - "Top directories under {path}" → "Top directories (scan results) under {path}"
  - "Top files under {path}" → "Top files (scan results) under {path}"
- `sortDirectChildren` ヘルパー追加
- CSS: `.direct-children-panel` / `.direct-child-row` / `.direct-child-badge` / etc. を追加

#### 制約確認

- Rust core / MFT scan / final_alloc / WOF policy 変更なし
- Tauri command 変更なし（既存 `get_children` を再利用）
- virtual scroll 未実装のまま
- delete 未追加
- J-3 で sort polish 予定

### J-3: TreeView quick navigation（中）

- キーボード操作（矢印キーで展開 / 選択）
- Expand all / Collapse all（指定深さまで）
- 展開状態の保持（rescan 後に同じ場所を開いた状態を復元）

### J-4: Search or filter（小〜大）

- パス・名前でのフィルタ
- 最小実装: 上位リストの絞り込み（フォルダ名 prefix filter）
- 本格実装: TreeView 内でのハイライト（後フェーズ候補）

### J-5: Sorting polish（小）

- カラムヘッダクリックでソート切替
- サイズ降順 / 昇順 / 名前順
- 現在のソートキーの視覚表示

### J-6: Daily-use milestone verification

- 実際に1週間以上の自己使用
- WizTree 不使用で快適に操作できること
- 主要不満点が解消されていること

### 後回し（v0.3.0 より後）

- delete action（安全設計・確認ダイアログ必須）
- virtual scroll 本実装（大規模ディレクトリ向け）
- Treemap
- 右クリックメニュー
- NTFS 判定・容量 / 空き領域表示
- WinSxS / hardlink / WOF 精度改善
