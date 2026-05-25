# disk-insight JSON output schema

This document describes the JSON output produced by disk-insight for the MFT tree analysis mode.

## Target commands

```powershell
disk-insight.exe --json
disk-insight.exe --json --top 100
disk-insight.exe --drive C --json --top 100
disk-insight.exe --json --top 100 --wof-adjusted
```

## PowerShell redirection note

PowerShell `>` may write redirected output as UTF-16LE depending on the environment. For JSON validation, prefer `cmd /c` redirection:

```powershell
cmd /c ".\target\release\disk-insight.exe --json --top 100 > .\work\probe7.sample.json"
```

## Top-level structure

The JSON output is an object with these top-level fields:

| Field | Type | Description |
| --- | --- | --- |
| `summary` | object | Scan summary and timing information. |
| `top_directories` | array | Largest directories ordered by `subtree_size` descending. |
| `top_files` | array | Largest files ordered by `final_allocated_size` descending. |
| `root_children` | array | Direct children of the NTFS root directory (FRN 5). Initial data for Explorer-style TreeView. |

The number of entries in `top_directories` and `top_files` can be changed with `--top`.

`root_children` always returns all direct children of the drive root (up to 200). It is not affected by `--top`.

## `summary`

| Field | Type | Description |
| --- | --- | --- |
| `drive` | string | Target drive, such as `C:`. |
| `total_records` | integer | Total MFT record count read from the MFT size and record size. |
| `in_use_entries` | integer | Number of in-use MFT entries included in the tree. |
| `files` | integer | Number of file entries included in the tree. |
| `directories` | integer | Number of directory entries included in the tree. |
| `orphans` | integer | Number of entries whose parent record was not found in the in-use tree. |
| `root_nodes` | integer | Number of root-level nodes used for tree traversal. |
| `total_final_allocated` | integer | Total final allocated file size. |
| `allocated_size` | integer | Alias for `total_final_allocated`, intended for quick policy comparisons. |
| `storage_policy` | string | Allocation policy used for this output: `current` or `wof_adjusted`. |
| `read_time_ms` | integer | Time spent reading MFT extents, in milliseconds. |
| `parse_time_ms` | integer | Time spent parsing MFT records, in milliseconds. |
| `tree_build_time_ms` | integer | Time spent building parent-child links, in milliseconds. |
| `aggregation_time_ms` | integer | Time spent aggregating subtree sizes, in milliseconds. |
| `total_time_ms` | integer | Total elapsed time for JSON tree output generation, in milliseconds. |

## `top_directories`

Each entry has these fields:

| Field | Type | Description |
| --- | --- | --- |
| `path` | string | Windows path string for the directory. |
| `record_index` | integer | MFT record index for the directory. |
| `subtree_size` | integer | Total final allocated size of files under the directory subtree. |
| `direct_file_size` | integer | Total final allocated size of direct child files only. |
| `child_count` | integer | Number of direct child nodes. |

## `top_files`

Each entry has these fields:

| Field | Type | Description |
| --- | --- | --- |
| `path` | string | Windows path string for the file. |
| `record_index` | integer | MFT record index for the file. |
| `parent_frn` | integer | Parent file reference number, masked to the record number portion. |
| `final_allocated_size` | integer | Final allocated size used by disk-insight. |

## `root_children`

Initial data for an Explorer-style TreeView. Contains direct children of the NTFS root directory (FRN 5), sorted by `subtree_size` descending. This is phase E-1a data; full lazy tree expansion is implemented in later phases.

Each entry has these fields:

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | File or directory name only (no path). |
| `path` | string | Full Windows path string. |
| `record_index` | integer | MFT record index for this entry. |
| `parent_record_index` | integer | MFT record index of the parent directory (5 for drive root). |
| `is_directory` | boolean | `true` for directories, `false` for files. |
| `subtree_size` | integer | Total final allocated size of files under the subtree (directories only; 0 for files). |
| `direct_file_size` | integer | Total final allocated size of direct child files (directories only; 0 for files). |
| `child_count` | integer | Number of direct child nodes. |

## Value units

All size values are integer byte counts.

All time values are integer millisecond counts.

All `path` values are Windows path strings.

## Storage policy

`summary.storage_policy` identifies how `final_allocated_size`,
`subtree_size`, `direct_file_size`, `total_final_allocated`, and
`allocated_size` were computed.

| Value | Meaning |
| --- | --- |
| `current` | Existing disk-insight allocation policy. This is the default for CLI, JSON, UI, and Tauri scans. |
| `wof_adjusted` | Experimental policy enabled by `--wof-adjusted`. WOF-compressed files use the `WofCompressedData` stream allocation when safely detected. |

`wof_adjusted` does not apply hardlink deduplication, component-store
deduplication, cluster deduplication, or WinSxS-specific accounting.

## API boundary notes

`build_mft_tree_output(drive, top_n)` is the core API for generating the structured MFT tree output.

`build_mft_tree_model(drive, top_n)` returns a richer `MftTreeModel` containing the same `JsonTreeOutput` plus a `children_map: HashMap<u64, Vec<JsonTreeNode>>` keyed by directory record index. The Tauri layer uses this map to back the `get_children` command without re-scanning the MFT.

The CLI should only call `build_mft_tree_output` through thin CLI-layer wrappers. `print_probe7_human` and `print_probe7_json` are CLI-layer functions and are allowed to write formatted output to stdout.

Tauri commands call `build_mft_tree_model` directly to populate the in-memory children cache, and return the embedded `output` to the UI.

The JSON schema in this document is treated as the UI contract.

Stdout/stderr separation policy:

| Stream | Content |
| --- | --- |
| stdout | JSON output only in `--json` mode. |
| stderr | Progress, diagnostics, and errors. |

## Tauri commands (UI ↔ Rust boundary)

These are not part of the JSON file output but share the schema for shared types.

| Command | Arguments | Returns | Notes |
| --- | --- | --- | --- |
| `load_sample_json` | none | embedded sample JSON | Same shape as `--json` output. |
| `scan_drive` | `drive: string`, `top?: usize`, `storagePolicy?: string` | `JsonTreeOutput` | Populates the in-memory `children_map` for `get_children`. `storagePolicy` accepts `"current"` (default) or `"wof_adjusted"` (experimental). |
| `get_children` | `parentRecordIndex: u64` | `Vec<JsonTreeNode>` | Direct children of the given directory record index, sorted by `subtree_size` desc, `name` asc. Returns an error string if no live scan data is loaded yet. Returns `[]` when the parent index is unknown. |
| `open_in_explorer` | `path: string` | `void` | Opens the given path in Explorer. |

`get_children` is the lazy children API that backs Explorer-style TreeView expansion. It is populated after each successful `scan_drive` and replaced on every subsequent scan. The embedded sample data is not backed by `children_map`, so `get_children` returns an error until a live scan has been run.
