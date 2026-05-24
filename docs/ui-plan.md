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

## Next candidates

- Add a Tauri command that calls `build_mft_tree_output`.
- Add a scan button.
- Add a TreeView for directory navigation.
- Add Explorer open support.
- Keep delete actions for a later phase.
