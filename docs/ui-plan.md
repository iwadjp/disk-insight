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

---

## Minimal usable milestone: 削除なし最小実用品

短期ゴール。以下がすべて揃った状態を一区切りとする。

- C ドライブを高速スキャンできる
- フォルダ容量が見える
- 大きいファイルが見える
- フォルダを選択できる
- 選択フォルダ配下の候補が見える
- Explorer で場所を開ける
- 削除機能はまだ入れない
- 危険操作なしで容量調査に使える状態

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

### D-13 Minimal usable milestone 判定

チェックリスト:

- [ ] Scan C: が動作する
- [ ] Top folders / top files が表示される
- [ ] Folder selection が動作する
- [ ] Explorer open が動作する
- [ ] Path copy が動作する
- [ ] README がある
- [ ] Clean build（TypeScript エラーなし・Rust 警告なし）
- [ ] disk-insight / private_notes 両リポジトリ clean
- [ ] 削除機能なし最小実用品として一区切り

---

## Deferred tasks

以下は minimal usable milestone 以降に検討する。

- ファイル削除
- 右クリックメニュー
- 本格 TreeView（折りたたみ・仮想スクロール）
- Treemap
- 複数ドライブ自動列挙
- WinSxS / hardlink / WOF 精度追求
- `explorer /select` によるファイル選択表示
- コマンドプロンプトで開く
