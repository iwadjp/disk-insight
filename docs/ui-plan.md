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

## Next candidates

- Add a Tauri command that calls `build_mft_tree_output`.
- Add a scan button.
- Add a TreeView for directory navigation.
- Add Explorer open support.
- Keep delete actions for a later phase.
