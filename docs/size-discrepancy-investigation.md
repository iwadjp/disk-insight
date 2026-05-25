# K-3b: Size discrepancy investigation

**Date**: 2026-05-26
**Status**: ongoing investigation — no source code changes in this phase

---

## Purpose

Investigate cases where Explorer and WizTree show similar values but disk-insight
differs. The goal is to identify the specific cause, not just describe it generally.

> **Core question**: for the same path, why does disk-insight report a different
> size than both Explorer and WizTree?

---

## 1. Size metric definitions

A prerequisite for any comparison: all three tools expose multiple "size" concepts.
Mixing them is the most common source of false discrepancies.

### Windows Explorer (folder Properties)

| Metric | What it is |
|--------|-----------|
| **Size** | Sum of logical file sizes (what the file contains, uncompressed). |
| **Size on disk** | Sum of actual disk allocation. For WOF-compressed files, this is the compressed backing size. For normal files, this is NTFS clusters × bytes/cluster. |

**Important**: Explorer "Size" ≠ Explorer "Size on disk". For WOF-heavy paths like
`C:\Program Files (x86)`, the gap between these two can be several GB.

### WizTree

| Column | What it is |
|--------|-----------|
| **Size** | Logical file size (same as Explorer "Size"). |
| **Allocated** | Disk allocation, WOF-aware. For WOF files, WizTree uses the compressed backing size. |

### disk-insight

| Field | What it is |
|-------|-----------|
| `subtree_size` | Sum of `final_alloc` for all files in the subtree (recursive). Displayed as the folder size in the UI and top-directories list. |
| `direct_file_size` | Sum of `final_alloc` for direct file children only (not recursive). Shown in the selected-folder card. |
| `final_alloc` (current) | NTFS $DATA allocated size from MFT base record (`e.alloc_size`), or extension unnamed alloc for files without base alloc. See §4 for WOF behavior. |
| `final_alloc` (wof_adjusted) | WofCompressedData stream allocation for WOF files; otherwise same as current. |

**Key**: disk-insight always shows **allocated** size, never logical size.
The only relevant comparison is Explorer "Size on disk" and WizTree "Allocated".

---

## 2. Comparison table

All values in GB (binary, 1 GB = 1,073,741,824 bytes). TBD = needs measurement.

| Path | Explorer Size | Explorer Size on disk | WizTree Size | WizTree Allocated | disk-insight current | disk-insight wof_adjusted | Notes |
|------|-------------:|---------------------:|-------------:|------------------:|---------------------:|--------------------------:|-------|
| C:\ | TBD | TBD | TBD | ~174.9 | 186.5 | 170.6 | WizTree Allocated from K-1 measurement |
| Program Files (x86) | 15.2 | 11.0 | ~15.2 | ~7.8 | ~10.1 | ~8.251 | Case 3 + residual deltas; metric mix-up confirmed |
| Program Files (x86)\Microsoft Office | TBD | TBD | TBD | 3.2 | 4.25 | 3.24 | wof_adjusted ≈ WizTree |
| Program Files | 19.6 | 19.5 | 30.6 | 24.6 | 29.7 | ~24.8 | Explorer divergence; WizTree aligns with disk-insight |
| Windows | TBD | TBD | TBD | 16.1 | 27.1 | 18.4 | WinSxS hardlink residual after WOF |
| Windows\WinSxS | TBD | TBD | TBD | 4.1 | 11.5 | 8.7 | 4.6 GB residual = hardlink (see §5) |
| Users | TBD | TBD | TBD | 85.2 | 85.0 | 84.8 | All tools agree — no WOF / hardlink issue |

**M-1 update**: Explorer measurements are now recorded for
`C:\Program Files (x86)` and `C:\Program Files`.

PFx86 and Program Files are different cases:
- PFx86: Explorer Size and WizTree Size align around 15.2 GB; the main issue was
  mixing Size with allocated-style values.
- Program Files: WizTree Allocated (~24.6 GB) and disk-insight wof_adjusted
  (~24.8 GB) align, and WizTree Size (30.6 GB) is relatively close to
  disk-insight current (29.7 GB). Explorer is the outlier at 19.6 / 19.5 GB.

---

## 3. The WOF explanation (current hypothesis)

### Why WOF files cause the gap

WOF (Windows Overlay Filter) compression stores file data in a provider-managed
compressed stream (`WofCompressedData` named stream), while the NTFS $DATA
attribute may retain a "projected" allocation representing the uncompressed file.

When a WOF-compressed file is accessed:
- Applications see the uncompressed file (WOF filter decompresses transparently)
- The NTFS $DATA attribute may have a non-zero allocated size (the projected view)
- The actual disk usage is in the `WofCompressedData` named stream, not in $DATA

### How each tool accounts for WOF files

| Tool | WOF file accounting | Effect |
|------|--------------------|----|
| Explorer "Size on disk" | WOF-aware: returns compressed backing size | Lower — matches actual disk usage |
| WizTree "Allocated" | WOF-aware: returns compressed backing size | Lower — agrees with Explorer |
| disk-insight current | Reads NTFS $DATA alloc from MFT base record | Higher if $DATA has projected allocation |
| disk-insight wof_adjusted | Reads WofCompressedData stream alloc | Lower — closer to Explorer/WizTree |

### Why Explorer "Size on disk" ≈ WizTree "Allocated"

Both Explorer and WizTree query the WOF-aware file system layer. The WOF filter
intercepts size queries and returns the compressed backing allocation, not the
projected $DATA allocation. This is why they agree on WOF-compressed paths.

disk-insight reads the raw MFT, bypassing the WOF filter layer. It sees whatever
allocation is recorded in the $DATA attribute at the MFT level — which may be the
projected uncompressed allocation, not the compressed WofCompressedData allocation.

**This is the leading hypothesis** for the "Explorer/WizTree agree, disk-insight
differs" pattern on WOF-heavy paths (Program Files, Windows components).

---

## 4. Code analysis: how `current_final_alloc` is computed for WOF files

From `src/mft_probe.rs` (lines 2775–2810 in the `build_mft_tree_model_with_policy_progress` function):

```rust
// current_final_alloc for each file:
let current_final_alloc = if e.alloc_size > 0 {
    e.alloc_size                  // ← base record $DATA allocated size
} else if let Some(g) = base_idx_to_group.get(&frn) {
    if g.unnamed_alloc > 0 {
        let wof = g.wof_alloc > 0;
        let cmp = ...; let sps = ...; let rps = ...; let sys = ...; let hid = ...;
        // WOF flag GATES adoption: if wof is true, returns 0 (not g.unnamed_alloc)
        if !cmp && !sps && !rps && !sys && !hid && !wof { g.unnamed_alloc } else { 0 }
    } else { 0 }
} else { 0 };

// wof_adjusted override:
let final_alloc = if storage_policy == WofAdjusted && wof_reparse
    && combined_has_wof_stream && combined_wof_alloc > 0
{
    combined_wof_alloc   // ← WofCompressedData stream alloc
} else {
    current_final_alloc
};
```

### Two cases for WOF files in `current` policy

**Case A: `e.alloc_size > 0`** (base record $DATA has non-zero allocation)

→ `current_final_alloc = e.alloc_size` = the projected NTFS $DATA allocation

For WOF-compressed files in Program Files, this is the uncompressed/projected
allocation, which is LARGER than the actual compressed WofCompressedData size.
This is why disk-insight current > Explorer "Size on disk" ≈ WizTree "Allocated".

**Case B: `e.alloc_size == 0`** (base record $DATA is deallocated/sparse)

→ Code checks extension records, but the `!wof` gate (line 2789) returns 0
when the file is a WOF file (i.e., `g.wof_alloc > 0`).

→ `current_final_alloc = 0` — WOF file is NOT counted at all in `current`

This is a **different behavior**: Case A files are overcounted relative to
WizTree; Case B files are undercounted (zeroed). The net effect depends on
the mix of Case A vs Case B files in a given path.

### What this means for diagnosis

- For WOF-heavy paths where disk-insight current > WizTree: Case A dominates.
  WOF files have non-zero base record $DATA alloc (projected/uncompressed size).
- For paths where disk-insight current < WizTree: Case B dominates.
  WOF files have zero base record alloc; they contribute 0 to the current total.
- The exact split between Case A and Case B is not currently measurable without
  a new diagnostic.

---

## 5. Cause classification

| ID | Cause | Applies to | Confidence | Notes |
|----|-------|------------|------------|-------|
| A | Metric mismatch: Explorer "Size" vs "Size on disk" | Any comparison where "Explorer" value is noted without specifying which metric | **High** | "Explorer 11.0 GB" for PFx86 is likely "Size" (logical), not "Size on disk" |
| C | WOF compression: projected $DATA alloc > WofCompressedData alloc | Program Files, Windows, WindowsApps | **High** | Main technical cause. disk-insight Case A: reads projected size. Explorer/WizTree: use compressed size |
| D | Hardlink double-counting | Windows\WinSxS, servicing | **High** | 70,912 link>1 records in WinSxS. 4.6 GB residual after WOF adjustment |
| F | Sparse/compressed file allocation | Potential overlap with WOF | Low | WOF files may also have sparse/compressed flags; gated out by `current` policy |
| H | Directory metadata counted | Possible in any path | Low | disk-insight does not add directory record allocation; subtree_size = files only |
| I | Aggregation bug in disk-insight | Unknown — cannot rule out | Low | Case B (WOF files zeroed) could cause undercount bugs in specific paths. Worth verifying |
| J | Unit difference (GB vs GiB) | Any value | Very low | All tools use binary units (1 GB = 2^30). Labels differ (GB vs GiB) but calculation identical |

Causes B (WizTree Size vs Allocated confusion), E (WinSxS component store), and
G (ADS/alternate data streams) are secondary or already addressed.

---

## 6. The `C:\Users` control case

For `C:\Users`, all three tools agree closely:

| Tool | Value |
|------|------:|
| disk-insight current | 85.0 GB |
| disk-insight wof_adjusted | 84.8 GB |
| WizTree Allocated | 85.2 GB |

This is expected: user data has very few WOF-compressed files and almost no
hard-linked files. The allocation is dominated by normal files where NTFS $DATA
allocation = actual disk usage = WOF-aware query result.

**This confirms**: the size discrepancy is WOF- and hardlink-specific, not a
general aggregation error.

---

## 7. What still needs measurement / verification

### M-1: Explorer "Size on disk" for key paths

**Priority: HIGH.** The existing "Explorer 11.0 GB" for PFx86 is ambiguous —
it may be Explorer "Size" (logical) not "Size on disk". Without this, the
"Explorer = WizTree but disk-insight differs" claim cannot be fully confirmed.

**How to measure**:
1. Right-click `C:\Program Files (x86)` → Properties
2. Record both "Size" and "Size on disk" explicitly
3. Repeat for `C:\Program Files`, `C:\Windows`, `C:\Users`
4. Compare with WizTree "Allocated" column (not "Size")

### M-2: Per-file WOF allocation in a WOF-heavy subfolder

**Priority: HIGH.** To confirm Case A vs Case B behavior, compare for individual
WOF files:
- MFT base record $DATA alloc (`e.alloc_size`)
- MFT WofCompressedData stream alloc
- Explorer "Size on disk" for that specific file (Properties)

**How to implement**: a new `--diag-path <path>` command (see §8).

### M-3: Verify disk-insight subtree_size matches manual summation

**Priority: MEDIUM.** For a small known subfolder (e.g., a specific app):
- Run `disk-insight --json` and find the subfolder's `subtree_size`
- Manually sum up the `final_allocated_size` for all top files under that path
- These should agree (within top-N sampling)
- This rules out Cause I (aggregation bug)

---

## 8. Proposed: `--diag-path <path>` diagnostic command

### Motivation

No existing diagnostic compares current vs wof_adjusted per-file for a specific
path, or shows the individual base record vs stream allocations for a file.

### Proposed output (per file in the specified path)

```text
--diag-path "C:\Program Files (x86)\Microsoft\EdgeCore"

Path: C:\Program Files (x86)\Microsoft\EdgeCore
  total children:  1,234 files
  current total:   1.870 GB
  wof total:       1.197 GB
  delta:           -0.673 GB   (35.9% reduction via WOF)
  wof files:         456 (37%)
  case-A WOF (e.alloc_size > 0):   380 files   1.24 GB base alloc   → 0.71 GB wof alloc
  case-B WOF (e.alloc_size == 0):   76 files   0 GB current         → 0.06 GB wof alloc

  Top 10 files by alloc gap (current - wof):
  [path]  current=X MB  wof=Y MB  delta=-Z MB
  ...
```

### What this proves

- Case A count and magnitude: how much of the overcount is projected $DATA alloc
- Case B count: how many WOF files are zeroed in current (potential undercount)
- Net effect: is the overcount or undercount dominant in this specific path?
- WOF eligibility rate: how many files are actually WOF-compressed

### Decision: implement or defer?

This diagnostic would definitively close the "is this a WOF accounting difference
or something else?" question. It is not implemented in K-3b but is the recommended
next diagnostic step.

---

## 9. K-3b verdict

### Classification: **B + D**

**B — origin mostly explained, but additional measurement needed**:
- Cause A (metric mismatch) and Cause C (WOF) are highly confident explanations
- Cause D (hardlink/WinSxS) is confirmed and quantified
- These three causes together account for all observed gaps

**D — comparison values are ambiguous; re-measurement needed**:
- "Explorer 11.0 GB" for PFx86 is unconfirmed as "Size on disk" vs "Size"
- Without explicit Explorer "Size on disk" measurements, the "Explorer = WizTree
  but disk-insight differs" claim cannot be verified
- Cause I (aggregation bug) is low probability but not yet ruled out for Case B paths

### What this means for daily-use trust

The size gap from disk-insight vs Explorer/WizTree has **highly plausible causes**:
WOF projected allocation (Cause C) and hardlink double-counting (Cause D). However:

- We cannot yet confirm "Explorer = WizTree" with specific measured values
- We cannot yet rule out Case B undercount for some paths
- Trust improvement requires: M-1 (Explorer "Size on disk" measurement) and
  M-2 (per-file comparison)

### Recommended next steps (in order)

1. **M-1**: Manually measure Explorer "Size on disk" for the 4 key paths
   (PFx86, Program Files, Windows, Users) and record here
2. **M-2 / diagnostic**: Implement `--diag-path <path>` for per-file WOF breakdown
3. After M-1 confirms/denies the hypothesis: update `docs/size-accuracy-review.md`
4. If Cause I cannot be ruled out after M-2: investigate specific Case B paths

### v0.3.0-daily-use status

**HOLD** — size accuracy remains a trust issue. The hypothesis is credible but
unconfirmed. The user's observation that "Explorer and WizTree agree but
disk-insight differs" may be:
- ✓ Confirmed by M-1 → WOF accounting difference is proven; trust improves
- ✗ Not confirmed by M-1 → Explorer ≠ WizTree too → different root cause TBD

---

## Appendix: measurement log

Superseded by §M-1 below, which has the full measurement table and procedure.
Quick reference: WizTree "Allocated" values from 2026-05-25 are pre-filled in §M-1.

---

## M-1: Explorer Size on disk manual measurement

**Status**: PFx86 and Program Files measured; Windows / Users still TBD.

**Purpose**: confirm or deny the K-3b WOF Case A hypothesis by recording
Explorer "Size on disk" (not "Size") explicitly for each key path, then
comparing it against WizTree "Allocated" and disk-insight policies.

> **Rule**: always record both "Size" and "Size on disk" from Explorer Properties,
> and both "Size" and "Allocated" from WizTree. Never compare Explorer "Size"
> against WizTree "Allocated" — they are different metrics.

---

### M-1a: Primary measurement table (required paths)

All values in GB (binary, 1 GiB = 2³⁰ bytes). Pre-filled values are from
2026-05-25 measurements. TBD = not yet measured.

**Tool measurements:**

| Path | Explorer Size | Explorer Size on disk | WizTree Size | WizTree Alloc | di current | di wof_adj | Measured |
|------|--------------:|---------------------:|-------------:|--------------:|-----------:|-----------:|---------|
| C:\Program Files (x86) | 15.2 GB / 16,342,637,554 bytes | 11.0 GB / 11,882,143,744 bytes | ~15.2 GB | ~7.8 GB | ~10.1 GB | ~8.251 GB | Exp: 2026-05-26 |
| C:\Program Files | 19.6 GB / 21,124,549,940 bytes | 19.5 GB / 20,973,977,600 bytes | 30.6 GB | 24.6 GB | 29.7 GB | ~24.8 GB | Exp: 2026-05-26 |
| C:\Windows | TBD | TBD | TBD | 16.1 GB | 27.1 GB | 18.4 GB | Exp: — |
| C:\Users | TBD | TBD | TBD | 85.2 GB | 85.0 GB | 84.8 GB | Exp: — |

**Computed diffs (fill after measuring):**

| Path | current − Exp SoD | wof_adj − Exp SoD | current − WizTree Alloc | wof_adj − WizTree Alloc | Candidate cause | Confidence | Notes |
|------|------------------:|------------------:|------------------------:|------------------------:|-----------------|------------|-------|
| C:\Program Files (x86) | ~-0.9 GB | ~-2.75 GB | ~+2.3 GB | ~+0.45 GB | Case 3: Size vs allocated-style metric comparison mix-up; residual WOF / Explorer Size-on-disk delta remains | Medium-high for metric mix-up; medium/unknown for residual deltas | Explorer Size and WizTree Size align around 15.2 GB; Explorer Size on disk is 11.0 GB, not 7-8 GB; disk-insight current is closer to Explorer Size on disk than Explorer Size; wof_adjusted is closer to WizTree Allocated; remaining deltas require further investigation before claiming accuracy |
| C:\Program Files | ~+10.2 GB | ~+5.3 GB | ~+5.1 GB | ~+0.2 GB | Explorer divergence / special folder accounting difference; possible permission / app package / reparse point / WindowsApps handling | Medium for Explorer divergence; low/unknown for exact cause | WizTree Allocated and disk-insight wof_adjusted are very close; WizTree Size and disk-insight current are also relatively close; Explorer Size / Size on disk are much smaller; not enough evidence for disk-insight aggregation bug |
| C:\Windows | TBD | TBD | +11.0 GB | +2.3 GB | WOF + hardlink | High | WinSxS residual after WOF |
| C:\Users | TBD | TBD | −0.2 GB | −0.4 GB | None (control) | High | All tools agree |

`di current` = disk-insight current policy `subtree_size`
`di wof_adj` = disk-insight wof_adjusted policy `subtree_size`
`Exp SoD` = Explorer "Size on disk"

**PFx86 interim judgment (2026-05-26)**:
- Primary classification: **Case 3 + residual differences remain**.
- The main issue is that Explorer/WizTree "Size" and allocated-style values were mixed in prior comparisons.
- WOF Case A is still relevant, but it is not the primary whole-tree classification for `C:\Program Files (x86)`.
- disk-insight `current` and `wof_adjusted` should be treated as allocation-oriented / WOF-adjusted values, not Explorer "Size".
- Remaining deltas (`Explorer Size on disk` 11.0 GB vs `current` ~10.1 GB, and `WizTree Allocated` ~7.8 GB vs `wof_adjusted` ~8.251 GB) are unresolved and do not yet prove a disk-insight aggregation bug.

**Program Files interim judgment (2026-05-26)**:
- Primary classification: **Explorer divergence case**.
- Explorer Properties reported Size 19.6 GB / 21,124,549,940 bytes and Size on disk 19.5 GB / 20,973,977,600 bytes, with 49,652 files and 6,394 folders.
- WizTree reported Size 30.6 GB, Allocated 24.6 GB, 86,577 files, and 12,250 folders.
- disk-insight `current` (~29.7 GB) is relatively close to WizTree Size, and `wof_adjusted` (~24.8 GB) is very close to WizTree Allocated.
- Explorer is much smaller than both WizTree and disk-insight. Possible causes include Explorer folder Properties excluding special items, permissions, app package handling, reparse points, or WindowsApps-related accounting.
- This improves confidence in `wof_adjusted` for Program Files, but the Explorer-vs-MFT/WizTree gap remains unexplained.

---

### M-1b: Additional candidates (optional)

| Path | Explorer Size | Explorer Size on disk | WizTree Size | WizTree Alloc | di current | di wof_adj | Measured |
|------|--------------:|---------------------:|-------------:|--------------:|-----------:|-----------:|---------|
| C:\Windows\WinSxS | TBD | TBD | TBD | 4.1 GB | 11.5 GB | 8.7 GB | Exp: — |
| C:\Users\iwadj | TBD | TBD | TBD | TBD | TBD | TBD | — |
| C:\Program Files (x86)\Microsoft | TBD | TBD | TBD | TBD | TBD | TBD | — |
| C:\Program Files (x86)\Microsoft Office | TBD | TBD | TBD | 3.2 GB | 4.25 GB | 3.24 GB | Exp: — |

---

### M-1c: Measurement procedure

#### Explorer "Size" and "Size on disk"

1. Right-click the target folder (e.g., `C:\Program Files (x86)`) in Explorer.
2. Select **Properties** / プロパティ.
3. Wait for the calculation to complete — do not record intermediate values.
4. Record both:
   - **Size** / サイズ (e.g., `10.9 GB (11,738,040,000 bytes)`)
   - **Size on disk** / ディスク上のサイズ (e.g., `7.82 GB (8,401,920,000 bytes)`)
5. Record the byte value for precision. The GB display may be truncated.
6. Fill in the "Explorer Size" and "Explorer Size on disk" columns in §M-1a.

**Cautions:**
- Properties calculation for large folders (`C:\Windows`) may take 30–90 seconds.
- The two values ("Size" and "Size on disk") can differ by several GB on WOF-heavy paths.
- Windows displays GB; disk-insight and WizTree use GiB. For comparison, convert
  to bytes and divide by 2³⁰ (1,073,741,824).

#### WizTree "Size" and "Allocated"

1. Open WizTree, scan `C:\`.
2. In the tree or folder list, locate the target path.
3. Record both:
   - **Size** column (logical file size total)
   - **Allocated** column (disk allocation, WOF-aware)
4. Fill in "WizTree Size" and "WizTree Alloc" columns in §M-1a.

**Cautions:**
- Use "Allocated" (not "Size") when comparing against Explorer "Size on disk".
- Use "Size" when comparing against Explorer "Size" (logical).
- Never mix Size and Allocated across tools.

#### disk-insight (Tauri UI)

1. Launch disk-insight as Administrator (`npm run tauri dev` or the built `.exe`).
2. Select **Current (default)** policy. Scan `C:`.
3. Click the target folder in the TreeView or top-directories list.
4. Record the **subtree_size** shown in the selected folder card.
5. Switch to **WOF adjusted (experimental)** policy. Scan `C:` again.
6. Record the same folder's subtree_size.

**Alternative (CLI/JSON):**

```powershell
# current policy
cmd /c ".\target\release\disk-insight.exe --json --top 30 > .\work\m1_current.json"

# wof_adjusted policy
cmd /c ".\target\release\disk-insight.exe --json --top 30 --wof-adjusted > .\work\m1_wof.json"
```

Search `top_directories` in the JSON for the target path and read `subtree_size`.
Note: `subtree_size` is in bytes. Divide by 1,073,741,824 for GiB.

For paths not in the top-30 list, use the Tauri UI (folder card) instead.

---

### M-1d: Judgment logic

After filling in the table, apply the following rules to each path.

#### Case 1 — WOF Case A confirmed

```
Explorer Size on disk ≈ WizTree Allocated ≈ disk-insight wof_adjusted
disk-insight current is significantly larger
```

**Interpretation:**
- WOF Case A is the dominant cause.
- Explorer and WizTree return the WOF-aware compressed size.
- `current` returns the projected NTFS $DATA allocation (uncompressed size).
- `wof_adjusted` is the correct policy for matching Explorer/WizTree on this path.

**Example expected result**: Program Files (x86) — Exp SoD ≈ 7.8 GB ≈ WizTree ≈ wof_adj 8.3 GB; current 10.1 GB is the outlier.

#### Case 2 — WOF explanation insufficient

```
Explorer Size on disk ≈ WizTree Allocated
disk-insight current AND wof_adjusted both differ (not just current)
```

**Interpretation:**
- WOF adjustment does not close the gap — another cause is active.
- Candidates: hardlink double-counting, sparse file accounting, ADS not
  captured, or an aggregation bug (Cause I).
- Investigate with `--diag-winsxs` or `--diag-pfx86` for that specific path.

#### Case 3 — Metric confusion detected

```
Explorer Size and Explorer Size on disk differ significantly (several GB)
WizTree Size and Allocated also differ significantly
```

**Interpretation:**
- The path has a large WOF-compressed footprint — Size ≫ Size on disk.
- All prior comparisons using "Explorer Size" as the baseline were invalid.
- Re-evaluate using only "Size on disk" and "Allocated" columns.
- This is Cause A (metric mismatch) confirmed.

#### Case 4 — Hardlink / component-store dominates (WinSxS)

```
C:\Windows\WinSxS: all three tools (Explorer, WizTree, disk-insight) disagree
wof_adjusted is still significantly higher than WizTree
```

**Interpretation:**
- WOF adjustment alone is insufficient (as expected — see §5 Cause D).
- 70,912 link_count > 1 records cause multi-attribution of the same clusters.
- 4.6 GB residual gap after WOF adjustment is consistent with hardlink overcount.
- WinSxS is a reference value only; do not use it to judge overall tool accuracy.

#### Case 5 — All tools agree (control)

```
Explorer Size on disk ≈ WizTree Allocated ≈ disk-insight current ≈ disk-insight wof_adjusted
```

**Interpretation:**
- No WOF or hardlink issue. Normal files dominate.
- Expected for `C:\Users` — confirms the tool is correct for user data paths.

#### Case 6 — Explorer divergence / special folder accounting

```
WizTree Allocated ≈ disk-insight wof_adjusted
WizTree Size ≈ disk-insight current
Explorer Size and Explorer Size on disk are much smaller
```

**Interpretation:**
- disk-insight and WizTree are likely counting a similar MFT-visible set.
- Explorer Properties appears to use a different folder accounting boundary.
- Candidates: permissions, app package handling, reparse points, WindowsApps or
  other special folder behavior.
- Do not classify this as a disk-insight aggregation bug without more evidence.

---

### M-1e: Expected outcomes

Based on K-3b analysis, the expected result for each primary path:

| Path | Expected case | Reasoning |
|------|--------------|-----------|
| C:\Program Files (x86) | Case 3 observed + residual deltas | Explorer Size ≈ WizTree Size (~15.2 GB); Explorer Size on disk is 11.0 GB |
| C:\Program Files | Case 6 observed | WizTree Allocated ≈ wof_adj, WizTree Size ≈ current, Explorer is much smaller |
| C:\Windows | Case 2 or mixed | WOF + hardlink; wof_adj 18.4 GB > WizTree 16.1 GB |
| C:\Users | Case 5 | No WOF/hardlink; all tools agree (control) |

PFx86 resolved the original ambiguity as a metric-mix-up first, with residual
deltas still requiring investigation. Program Files added a separate Explorer
divergence pattern where WizTree and disk-insight align more closely with each
other than with Explorer Properties.
