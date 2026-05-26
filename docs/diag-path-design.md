# Per-Path Size Discrepancy Diagnostic Design

Status: design only. No CLI option, Rust implementation, UI implementation,
storage policy change, WOF production change, hardlink deduplication, WinSxS
correction, delete action, tag, release artifact, or public publishing is
included in this phase.

## 1. Problem Statement

disk-insight is useful when the user wants to make free disk space. In that
workflow, the user needs to trust where the tool points them.

For size values, trust requires one of two outcomes:

1. disk-insight is close to Explorer or WizTree for the relevant metric.
2. If it is not close, disk-insight can explain the likely reason.

M-2b improved labels such as `ALLOCATED ESTIMATE` and `Size metric`, but labels
alone are not enough. A user can still ask: why does this folder show 24.8 GB in
disk-insight, 24.6 GB in WizTree, and 19.5 GB in Explorer Properties?

The next diagnostic should answer that question per path by reporting evidence
for WOF, hardlinks, multiple `$FILE_NAME` attributes, reparse points, sparse or
compressed files, and Windows component-store accounting.

## 2. Target Command

Proposed command:

```powershell
disk-insight.exe --diag-path "C:\Program Files"
```

Drive handling:

- `--diag-path <path>` should be enough for absolute Windows paths. The drive is
  inferred from the path prefix.
- `--drive C --diag-path "C:\Program Files"` may also be accepted for consistency
  with existing CLI modes.
- If `--drive` conflicts with the path drive, return an error such as:
  `--drive D conflicts with --diag-path C:\Program Files`.
- Relative paths should be rejected in the first implementation. The diagnostic
  is intended to identify a concrete MFT subtree.
- Non-NTFS drives should fail the same way existing scan modes fail.

Initial scope:

- Human-readable diagnostic output only.
- No JSON or CSV output in M-3b.
- No normal CLI, JSON, or UI value changes.

## 3. Output Goals

Minimum output for a target path:

```text
=== Path size discrepancy diagnostics ===
Path: C:\Program Files
Drive: C:
Found: yes
Record index: ...

Classification:
  Explorer divergence candidate
  WOF-dominated candidate

disk-insight current: ...
disk-insight wof_adjusted: ...
delta current -> wof_adjusted: ...

WOF files: ...
WOF stream allocation: ...
current alloc of WOF files: ...

hardlink suspect records: ...
multi-name records: ...
hardlink suspect current alloc: ...
hardlink suspect wof_adjusted alloc: ...

reparse point records: ...
sparse records: ...
compressed records: ...

Recommended comparison:
  Compare current with: Explorer "Size" only for logical-size-like cases; otherwise use with caution.
  Compare wof_adjusted with: WizTree "Allocated" for WOF-heavy paths.
  Do not compare with: Explorer "Size" when WOF compression is significant.

notes:
  - Diagnostic only.
  - Normal output is unchanged.
  - Hardlink/component-store dedup is not applied.
```

Top lists:

```text
--- top child directories by current ---
current    wof_adjusted    delta    wof_files    hl_suspects    path

--- top child directories by WOF delta ---
delta      current         wof_adjusted    wof_files    path

--- top files by WOF delta ---
delta      current         wof_stream      link  fn  rec  path

--- top hardlink / multi-name suspects ---
current    wof_adjusted    link  fn  rec  flags  path
```

The first implementation should prefer useful, scannable output over exhaustive
per-file dumps. Top 30 child directories and top 50 WOF-impact files are enough.

## 4. Classification Candidates

Classifications should be candidates, not verdicts. The diagnostic can identify
strong evidence, but it should not claim exact Explorer or WizTree parity.

| Candidate | Meaning | Known example |
|---|---|---|
| Alignment case | Explorer, WizTree, and disk-insight are likely close for ordinary data. | `C:\Users` |
| Metric mix-up candidate | Logical size and allocated-style values may have been compared. | `C:\Program Files (x86)` |
| Explorer divergence candidate | WizTree and disk-insight are close, while Explorer Properties is smaller or different. | `C:\Program Files` |
| Windows special accounting candidate | WinSxS, component store, WOF, hardlinks, protected folders, or tool-specific accounting surfaces are mixed. | `C:\Windows` |
| WOF-dominated candidate | `current` and `wof_adjusted` differ substantially. | Program Files, WindowsApps |
| Hardlink/component-store candidate | `link_count > 1`, multiple `$FILE_NAME` attributes, or external parent hints are common. | WinSxS, servicing |
| Unknown / needs manual comparison | Local signals do not strongly explain the difference. | Any path without clear WOF or hardlink evidence |

The output may show multiple candidates. For example, `C:\Windows` can be both
`Windows special accounting candidate` and `WOF-dominated candidate`.

## 5. Existing Data Sources

The existing code already gathers most of the required evidence.

### Normal tree model

`build_mft_tree_model_with_policy` already supports:

- `StoragePolicy::Current`
- `StoragePolicy::WofAdjusted`
- `JsonTreeOutput`
- `children_map`
- top directories and files
- `storage_policy` in the summary

This model is good for normal output, but M-3b should not use it alone because
the diagnostic needs raw per-record flags, WOF stream totals, link counts, and
`$FILE_NAME` counts.

### Diagnostic tree helper

`print_diag_with_wof_tree(drive, mode)` already builds a richer in-memory
diagnostic arena for:

- `--diag-pfx86`
- `--diag-wof-global`
- `--diag-winsxs`

The diagnostic arena currently tracks:

- `subtree_size`
- `direct_file_size`
- diagnostic-only `wof_adjusted_subtree_size`
- `wof_file_count`
- `wof_current_alloc_total`
- `wof_stream_alloc_total`
- `final_alloc`
- `hard_link_count`
- `file_name_attr_count`
- `$FILE_NAME` parent FRN hints
- `reparse_tag`
- `has_wof_stream`
- `wof_stream_alloc`
- `file_attrs`
- unnamed `$DATA` flags
- child relationships and reconstructed paths

This is the right starting point for M-3b.

### Existing diagnostic logic to reuse

`--diag-pfx86` has reusable logic for:

- finding a target subtree by path segments
- collecting descendants
- WOF / reparse summary
- WOF adjusted estimate
- compressed / sparse summary
- hardlink / multi-name summary
- top WOF suspects
- top hardlink suspects

`--diag-wof-global` has reusable logic for:

- current vs WOF-adjusted subtree aggregation
- top directories by WOF delta
- top files by WOF delta
- WizTree comparison notes

`--diag-winsxs` has reusable logic for:

- hardlink / multi-name distributions
- WOF + hardlink overlap
- top hardlink suspects
- top files in subtree
- top child directories
- cross-tree parent hints

### Refactor boundary for M-3b

The current diagnostic helper is mode-specific and prints directly. M-3b can
stay small by adding a new `DiagTreeMode::Path { ... }` only if that can be done
cleanly. If the enum shape becomes awkward, add a separate
`print_diag_path(drive, path)` that reuses the same parse/build blocks with
minimal extraction.

Avoid a broad rewrite of normal scan model code.

## 6. Minimal M-3b Implementation Plan

M-3b should implement the smallest useful command:

1. Add CLI parsing for `--diag-path <absolute-path>`.
2. Infer the drive from the path; validate `--drive` if also provided.
3. Build the existing diagnostic arena from MFT records.
4. Resolve the target path to a directory node:
   - normalize separators
   - strip the drive root
   - split into case-insensitive path segments
   - find through existing child relationships
5. Print not-found output and exit successfully if the path is not found.
6. For found paths, print:
   - current subtree allocation
   - WOF-adjusted subtree allocation
   - delta and ratio
   - descendant directory/file counts
   - WOF count and WOF stream allocation
   - current allocation of WOF files
   - hardlink and multi-name counts
   - reparse, compressed, and sparse counts
   - top child directories by current
   - top child directories by WOF delta
   - top files by WOF delta
   - top hardlink / multi-name suspects
   - rule-based classification candidates
7. Keep all normal CLI, JSON, Tauri, UI, and diagnostic modes unchanged.

Suggested function boundary:

```rust
pub fn print_diag_path(drive: char, path: &str) -> Result<()>
```

Potential internal helpers:

```rust
fn parse_absolute_windows_path(path: &str) -> Result<(char, Vec<String>)>
fn find_by_segments_case_insensitive(arena: &[DNode], root: usize, segments: &[String]) -> Option<usize>
fn collect_descendants(arena: &[DNode], start_idx: usize) -> Vec<usize>
fn classify_path_diag(summary: &PathDiagSummary) -> Vec<&'static str>
```

M-3c or later:

- `--diag-path-json`
- CSV output for external comparison
- optional manual Explorer/WizTree values:
  `--explorer-size-on-disk`, `--wiztree-allocated`
- UI "Explain size" button for selected folder
- WinSxS-specific component-store diagnostics
- cluster/data-run diagnostics

## 7. Rule Ideas

Rules should produce candidate labels and notes. They should not assert exact
causes.

Example thresholds:

```text
wof_delta_ratio = abs(current - wof_adjusted) / current
wof_file_ratio = wof_files / descendant_files
hardlink_ratio = hardlink_suspect_records / descendant_files
multi_name_ratio = multi_name_records / descendant_files
```

Candidate rules:

```text
if path contains "\Windows":
  Windows special accounting candidate

if path contains "\Windows\WinSxS" or hardlink_ratio > 20%:
  Hardlink/component-store candidate

if wof_delta_ratio > 20% or wof_stream_alloc_total > 1 GB:
  WOF-dominated candidate

if wof_delta_ratio < 5% and hardlink_ratio < 2% and reparse count is low:
  Alignment candidate

if path contains "Program Files (x86)" and WOF signal exists:
  Metric mix-up candidate; compare logical vs allocated-style metrics carefully

if path == "C:\Program Files" or path starts with "C:\Program Files\":
  Explorer divergence candidate may apply if manual Explorer Properties is much smaller
```

Manual comparison values are not available in M-3b, so the classification should
be phrased as "candidate" and include "needs manual Explorer/WizTree comparison"
when appropriate.

## 8. What Not To Claim

The diagnostic must not claim:

- exact disk usage
- exact Explorer match
- exact WizTree match
- WinSxS fully corrected
- hardlink dedup implemented
- component-store accounting implemented
- WOF production policy enabled by default
- that a folder is safe to delete

It should say:

- diagnostic only
- normal output unchanged
- WOF-adjusted values are estimates
- hardlink/component-store dedup is not applied
- manual Explorer/WizTree values may still be needed

## 9. Daily-Use Relevance

This diagnostic is directly tied to daily-use PASS.

When the user wants to free disk space, the key question is not "does this
number look polished?" It is "can I trust this folder ranking enough to decide
where to inspect next?"

If disk-insight differs from Explorer or WizTree but can explain the likely
reason, the user can still proceed:

- WOF-heavy: compare WOF-adjusted estimate with WizTree Allocated.
- Hardlink-heavy: treat the subtree as shared-accounting caveat.
- Explorer divergence: avoid assuming Explorer Properties is the only baseline.
- Alignment: ordinary user data can be trusted more directly.

If the difference remains unexplained, the tool still feels unreliable even with
better labels. M-3b is therefore the next practical step after M-2b.

## 10. Recommended Decision

Proceed to M-3b with a diagnostic-only `--diag-path <path>` implementation.

Do not implement correction logic yet. The immediate goal is explanation:
identify the likely path-specific cause of a size difference and show the
evidence in one command.

---

## 11. M-3b Implementation Result

M-3b added a diagnostic-only CLI mode:

```powershell
.\target\release\disk-insight.exe --diag-path "C:\Program Files"
```

`--diag-path` infers the drive from the absolute local path. It also accepts
`--drive` when the drive matches the path. A mismatch, such as `--drive D` with
`C:\Windows`, is an error. UNC paths are intentionally unsupported in M-3b.

The minimal implementation reports:

- normalized path and MFT record index
- subtree `current` estimate
- subtree `wof_adjusted` estimate
- current-to-WOF delta and ratio
- descendant record / file / directory counts
- WOF file count, current WOF alloc total, and WOF stream alloc total
- hardlink suspect and multi-name counts with current/adjusted totals
- reparse point count
- sparse/compressed record count
- top 10 child directories by current estimate
- top 10 child directories by WOF delta
- top 10 files by WOF delta
- rule-based classification candidates
- comparison notes and diagnostic-only caveats

M-3b does not read Explorer or WizTree values. It therefore cannot decide exact
agreement or disagreement with those tools by itself. The classification output
is deliberately phrased as candidates.

Not available in M-3b:

- JSON or CSV output for `--diag-path`
- UI "Explain size" integration
- manual Explorer/WizTree value input
- hardlink deduplication
- component-store accounting correction
- WinSxS special correction
- production WOF policy change

The normal CLI, JSON output, UI values, and existing diagnostic modes remain on
their existing code paths.

---

## 12. M-3c Output Refinement

M-3c refines the human-readable `--diag-path` output without changing any
normal size policy.

The command now starts with a `Summary` section before the detailed counts:

- total current-to-WOF delta and delta ratio
- main child directory contributing to the WOF delta
- that child directory's percent of the total WOF delta
- top WOF delta contributors and combined percent
- one-line classification summary
- path-specific recommended comparison guidance

Classification candidates now include short reasons. Example:

```text
Classification candidates:
  - WOF-dominated candidate - current vs wof_adjusted delta is 16.52%
  - Explorer divergence candidate - Program Files and WindowsApps often differ by tool accounting surface
```

This remains an explanation aid, not a correction. `--diag-path` still does not
read Explorer or WizTree values automatically, and it does not implement
hardlink deduplication, WinSxS/component-store correction, or WOF production
policy changes.

---

## 13. N-1 Reclaimable Size Model

N-1 adds a design layer above the M-3c explanation summary. The practical
cleanup question is not only why a path differs from Explorer or WizTree. It is
which number should guide a decision about how much free space might be gained
by removing or moving that subtree.

See `docs/reclaimable-size-model.md`.

Planned direction for a future `--diag-path` refinement:

- add a `Reclaimable estimate` section
- use `wof_adjusted` as the primary estimate
- show `current` as an upper/reference bound
- include a confidence value: High, Medium, or Low
- include path-specific cautions, such as app uninstall for Program Files and
  Windows cleanup tools for Windows system folders

This is not implemented in N-1. M-3c Summary remains the evidence layer; the
reclaimable estimate would be a higher-level interpretation of that evidence.
