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

## Next candidates

- Add a TreeView for directory navigation.
- Add Explorer open support.
- Keep delete actions for a later phase.
