# disk-insight JSON output schema

This document describes the JSON output produced by disk-insight for the MFT tree analysis mode.

## Target commands

```powershell
disk-insight.exe --json
disk-insight.exe --json --top 100
disk-insight.exe --drive C --json --top 100
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

The number of entries in `top_directories` and `top_files` can be changed with `--top`.

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

## Value units

All size values are integer byte counts.

All time values are integer millisecond counts.

All `path` values are Windows path strings.

## API boundary notes

`build_mft_tree_output(drive, top_n)` is the core API for generating the structured MFT tree output.

The CLI should only call this function through thin CLI-layer wrappers. `print_probe7_human` and `print_probe7_json` are CLI-layer functions and are allowed to write formatted output to stdout.

Future Tauri commands are expected to call `build_mft_tree_output` directly and return the structured data without going through CLI stdout formatting.

The JSON schema in this document is treated as the UI contract.

Stdout/stderr separation policy:

| Stream | Content |
| --- | --- |
| stdout | JSON output only in `--json` mode. |
| stderr | Progress, diagnostics, and errors. |
