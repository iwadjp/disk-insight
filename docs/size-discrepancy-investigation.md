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
| Program Files (x86) | ~11.0 ¹ | **TBD** | TBD | 7.8 | 10.1 | 8.3 | ¹ may be logical "Size", not "Size on disk" |
| Program Files (x86)\Microsoft Office | TBD | TBD | TBD | 3.2 | 4.25 | 3.24 | wof_adjusted ≈ WizTree |
| Program Files | TBD | TBD | TBD | 24.6 | 29.7 | 24.8 | wof_adjusted ≈ WizTree |
| Windows | TBD | TBD | TBD | 16.1 | 27.1 | 18.4 | WinSxS hardlink residual after WOF |
| Windows\WinSxS | TBD | TBD | TBD | 4.1 | 11.5 | 8.7 | 4.6 GB residual = hardlink (see §5) |
| Users | TBD | TBD | TBD | 85.2 | 85.0 | 84.8 | All tools agree — no WOF / hardlink issue |

**Critical unknown**: Explorer "Size on disk" for `C:\Program Files (x86)`.

The "Explorer 11.0 GB" value in prior notes likely refers to Explorer **"Size"**
(logical), not "Size on disk". These are different metrics.

**Hypothesis**: Explorer "Size on disk" ≈ WizTree Allocated ≈ 7–8 GB for PFx86,
because both use WOF-compressed sizes. disk-insight current uses projected NTFS
allocation → 10.1 GB. This hypothesis needs explicit measurement to confirm.

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

Fill in after real-device measurements.

### Explorer Properties — "Size on disk"

| Path | Explorer "Size" | Explorer "Size on disk" | Measured |
|------|---------------:|------------------------:|---------|
| C:\Program Files (x86) | | | |
| C:\Program Files | | | |
| C:\Windows | | | |
| C:\Windows\WinSxS | | | |
| C:\Users | | | |

### WizTree — "Allocated" column

| Path | WizTree "Size" | WizTree "Allocated" | Measured |
|------|---------------:|--------------------:|---------|
| C:\Program Files (x86) | | 7.8 GB | 2026-05-25 |
| C:\Program Files | | 24.6 GB | 2026-05-25 |
| C:\Windows | | 16.1 GB | 2026-05-25 |
| C:\Windows\WinSxS | | 4.1 GB | 2026-05-25 |
| C:\Users | | 85.2 GB | 2026-05-25 |
