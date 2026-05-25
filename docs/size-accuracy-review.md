# K-3: Size accuracy review

**Date**: 2026-05-26
**Status**: analysis document — no source code changes in this phase

---

## Purpose

Review what disk-insight size numbers mean, what is known-correct, and what
remains unresolved. The goal is not "produce byte-exact matches with Explorer
or WizTree" but to reach a state where differences are explainable.

> daily-use 判断基準: **「違う理由が分からない」が最悪。「違うが、理由は分かる」に持っていく。**

---

## 1. Current state: two policies

disk-insight has two storage policies selected at scan time:

| Policy | Status | Description |
|--------|--------|-------------|
| `current` | Default | NTFS allocation-based. Simple, conservative, Explorer-aligned. |
| `wof_adjusted` | Experimental | WOF-compressed files use `WofCompressedData` stream allocation instead. |

Both policies share the same MFT read, parse, and tree-aggregation pipeline.
The difference is only in how `final_alloc` is computed per file record.

### Representative C: drive totals (2026-05-25 measurement)

| Policy | C: total | WizTree reference | Delta |
|--------|--------:|------------------:|------:|
| `current` | 186.5 GB | 174.9 GB | +11.6 GB |
| `wof_adjusted` | 170.6 GB | 174.9 GB | −4.3 GB |

Neither policy produces a byte-exact match with WizTree. The reasons are
documented below and are expected, bounded, and explainable.

---

## 2. `current` policy

### What it measures

NTFS allocated size: the number of clusters allocated for the file in NTFS,
multiplied by bytes per cluster. Read directly from each MFT file record.

- For normal user files: matches what Windows "Properties → Size on disk" shows.
- For WOF-compressed files: uses the projected (uncompressed) view of the
  unnamed `$DATA` attribute. This is what NTFS exposes as the allocated size;
  the actual compressed backing data lives in a `WofCompressedData` named stream.

### How it relates to Explorer and WizTree

- **Explorer "Size on disk"**: In most cases `current` agrees per-file. Explorer
  uses NTFS allocation for its "Properties" dialog, same as `current`.
- **WizTree**: Uses a view closer to compressed backing for WOF files. `current`
  reads higher than WizTree for WOF-heavy paths (Edge, Office, Windows system
  components, AppX packages).

### Strengths

- Simple and predictable: reads what NTFS reports as allocated.
- Conservative: never undercounts real disk usage.
- Matches Explorer for normal files and user data.
- `C:\Users` comparison: disk-insight 85.0 GB vs WizTree 85.2 GB — essentially equal.

### Weaknesses

- WOF-compressed areas inflate vs WizTree: C: is ~11.6 GB above WizTree.
- Hard-linked files counted per directory entry — WinSxS is significantly overcounted.

---

## 3. `wof_adjusted` policy

### What it measures

For each file that has a WOF reparse tag (`IO_REPARSE_TAG_WOF = 0x80000017`)
and a parseable `WofCompressedData` named stream with a positive allocated size:

```
final_alloc = WofCompressedData stream allocated size
```

For all other files: identical to `current`. Falls back to `current` when WOF
identity or stream allocation cannot be confirmed.

### Key folder deltas (2026-05-25 `--diag-wof-global`, 104,884 WOF files on C:)

| Folder | current | wof_adjusted | WOF delta | WizTree ref | adj. remaining |
|--------|--------:|-------------:|----------:|------------:|---------------:|
| C: | 186.5 GB | 170.6 GB | −15.9 GB | 174.9 GB | −4.3 GB |
| Program Files | 29.7 GB | 24.8 GB | −4.9 GB | 24.6 GB | +0.2 GB |
| Program Files (x86) | 10.1 GB | 8.3 GB | −1.9 GB | 7.8 GB | +0.5 GB |
| Microsoft Office | 4.25 GB | 3.24 GB | −1.01 GB | 3.2 GB | +0.04 GB |
| Windows | 27.1 GB | 18.4 GB | −8.7 GB | 16.1 GB | +2.3 GB |
| WinSxS | 11.5 GB | 8.7 GB | −2.7 GB | 4.1 GB | +4.6 GB |
| Users | 85.0 GB | 84.8 GB | −0.3 GB | 85.2 GB | −0.4 GB |

### How it relates to WizTree

- **Program Files / Program Files (x86)**: within 0.5 GB of WizTree after adjustment.
- **Microsoft Office**: effectively aligned (3.24 GB vs 3.2 GB).
- **C: total**: undershoots WizTree by 4.3 GB — component-store and hardlink residual.
- **Windows / WinSxS**: still significantly above WizTree — hardlink overcount dominates
  the residual; WOF adjustment alone is insufficient.

### Strengths

- Moves C: total from +11.6 GB to −4.3 GB relative to WizTree.
- Program Files and Program Files (x86) effectively match WizTree allocated totals.
- Useful for CLI/JSON side-by-side comparison with WizTree numbers.

### Weaknesses

- Experimental: fallback logic depends on WOF identity parse; coverage not exhaustive.
- WinSxS and Windows component-store residual remains after WOF adjustment.
- C: total slightly undershoots WizTree; cannot be used to claim "more accurate".
- Hardlink dedup not applied; applies only the WOF layer.
- Not yet the default in the Tauri UI.

---

## 4. Hard link and WinSxS problem

### Background: what hard links do

A hard link is a second (or subsequent) directory entry pointing to the same
NTFS file record and its allocated clusters. The clusters are shared; they are
not duplicated on disk. However, each directory entry appears as an independent
file during MFT traversal — complete with its own allocation accounting.

Without deduplication, a file with `link_count = N` may contribute its allocated
size to N different parent paths. The actual disk consumption is 1×, not N×.

### WinSxS is dominated by hard links

From PFx86-DIAG-5 measurement (2026-05-25):

| Folder | link_count > 1 records | multi-$FILE_NAME records | wof_adjusted | WizTree |
|--------|----------------------:|------------------------:|-------------:|--------:|
| Windows | 310,551 | 309,788 | 18.4 GB | 16.1 GB |
| WinSxS | 70,912 | 72,959 | 8.7 GB | 4.1 GB |
| servicing | 223,337 | 224,137 | 2.2 GB | — |
| System32 | 6,576 | 4,465 | 3.8 GB | — |

WinSxS after WOF adjustment is 8.7 GB. WizTree shows 4.1 GB.
**4.6 GB residual** is consistent with hardlink / component-store double-counting.

`$FILE_NAME` parent hints found 19,574 WinSxS file records with a parent outside
WinSxS — 10,676 pointing to System32 and 3,546 to SysWOW64. This confirms the
component-sharing hypothesis: the same clusters are attributed to multiple paths.

### Why different tools give different numbers

| Tool | WinSxS accounting |
|------|------------------|
| Windows Explorer | Per-hard-linked name: shows total including all entries |
| WizTree | Component-aware or cluster-level dedup — shows much lower total |
| DISM `/Cleanup-Image` | Uses component store manifest, not filesystem traversal |
| TreeSize | Has a hardlink dedup option; behavior depends on settings |
| disk-insight (`current`) | Per-file-record allocation, no dedup — highest |
| disk-insight (`wof_adjusted`) | WOF-corrected per-file-record, no hardlink dedup |

There is no universally "correct" number. The relevant question is:
**which clusters are exclusively allocated and cannot be freed without
removing other components?** That requires cluster-level or manifest-level
accounting not yet implemented in disk-insight.

### disk-insight current state

| Aspect | Status |
|--------|--------|
| Hardlink dedup | Not implemented |
| Component store accounting | Not implemented |
| WinSxS result | Reference value only — expect 2×–3× above WizTree |
| Policy | Known, documented limitation — not a silent bug |

---

## 5. Daily-use implications

### "Explained difference" is the achievable goal

For daily disk analysis, size accuracy matters less than size transparency.
If disk-insight shows 186 GB and WizTree shows 175 GB, the useful response is:

> "disk-insight `current` uses NTFS allocation, which counts WOF-compressed
> files at their projected size. That adds ~11 GB for Edge, Office, and Windows
> system components. Switching to `wof_adjusted` reduces C: to ~170 GB, closer
> to WizTree. WinSxS remains high in both because hard-linked files are not
> deduplicated — this is a known limitation."

That answer is possible with the current understanding. The difference is no
longer "unexplained".

### What disk-insight is reliable for

| Use case | Reliability |
|----------|-------------|
| Ranking largest directories / files | High — correct in both policies |
| `C:\Users` total and subtrees | High — within 0.4 GB of WizTree in both policies |
| `C:\Program Files` with `wof_adjusted` | High — within 0.2 GB of WizTree |
| Identifying top-N large files | High — relative sizes correct |
| Explorer integration (open, select, copy) | High — path-based, not size-based |
| Delete-free safety (browsing without risk) | High — no destructive actions |

### What disk-insight is not reliable for (yet)

| Use case | Status |
|----------|--------|
| `C:\Windows\WinSxS` exact total | Overcounted — hardlink dedup not implemented |
| Byte-exact match with WizTree or Explorer | Not the goal; difference is explainable |
| "True freed space" if you deleted WinSxS | Requires component-store analysis; out of scope |

---

## 6. Recommended display policy

### Existing policy — keep as-is

| Aspect | Recommendation |
|--------|----------------|
| Default policy | Keep `current` — simple, safe, conservative |
| `wof_adjusted` | Keep `experimental` badge — useful for comparison, not production default |
| WinSxS UI note | None yet — document in known limitations only |
| Accuracy claim | Never claim "byte-exact"; say "NTFS allocation-based" |
| "Why sizes differ?" help text | Deferred — groundwork is now in this doc |

### Future candidates (not in K-3 scope)

- A "Why does this differ from Explorer?" tooltip or help link in the UI
- A WinSxS note in the folder card when `Windows\WinSxS` is selected
- Hardlink dedup behind a diagnostic flag (requires cluster-level design)
- `wof_adjusted` as the UI default (after broader measurement review)

### What to document publicly

The README already documents the core limitations accurately:

```
WinSxS: Hard-linked files may be counted multiple times
WOF: Compressed files report allocation size, not compressed size
Hard links: Multiple directory entries for the same file clusters
```

K-3 adds clarity to these entries in the README (see README.md update).
No change to the public-facing accuracy claim is needed beyond that.

---

## 7. K-3 verdict

### Summary

| Question | Answer |
|----------|--------|
| Is current policy byte-exact with Explorer? | No — WOF files differ |
| Is wof_adjusted byte-exact with WizTree? | No — hardlink / component-store residual |
| Is the difference explainable? | **Yes** — reasons are bounded and documented |
| Is WinSxS reliable? | No — known overcount; reference value only |
| Is top-N ranking reliable? | Yes — relative sizes are correct |
| Is `C:\Users` reliable? | Yes — within 0.4 GB of WizTree |
| Is `C:\Program Files` (wof_adjusted) reliable? | Yes — within 0.2 GB of WizTree |

### Assessment for daily use

- **"Violated accuracy"** → **"Documented, bounded, explainable difference"**
- Differences from WizTree are no longer a black box
- daily-use trust is improved: size numbers have a known meaning
- WinSxS remains a known exception — treat as reference value

### Status

**K-3: DONE.**

- Size policy meaning is documented.
- The `current` / `wof_adjusted` distinction is clear.
- WinSxS / hardlink overcount is quantified and acknowledged.
- The "why is the number different" question has a documented answer.

**Next: K-4 daily-use verification retry.**

---

## 8. K-3b reference: concrete size discrepancy investigation

**See**: `docs/size-discrepancy-investigation.md`

K-3 established that size differences are "explained". K-3b goes further:
investigating the specific cases where Explorer and WizTree agree but
disk-insight differs — the "Explorer = WizTree, disk-insight differs" pattern
that makes the numbers hard to trust.

### What K-3b found

The root cause is **Case A WOF behavior** in `current` policy:

- When `e.alloc_size > 0` for a WOF-compressed file, `current_final_alloc` uses
  the projected NTFS $DATA allocation (uncompressed size), not the compressed
  `WofCompressedData` stream allocation.
- Explorer "Size on disk" and WizTree "Allocated" both use the WOF-aware API
  layer, which returns the compressed backing size.
- Result: disk-insight `current` > Explorer "Size on disk" ≈ WizTree "Allocated"
  for WOF-heavy paths (Program Files, Windows components).

A secondary issue: **Case B WOF** (`e.alloc_size == 0`, WOF gate active) returns
0 for `current` — these files are not counted, which could cause undercount in
some paths.

### M-1 measurement update

Explorer measurements are now recorded for `C:\Program Files (x86)` and
`C:\Program Files`.

PFx86 did not match the simple "Explorer = WizTree Allocated = 7.8 GB" pattern:
Explorer Size is ~15.2 GB and Explorer Size on disk is 11.0 GB. This makes the
primary PFx86 issue a Size vs allocated-style metric mix-up, with residual
deltas still unresolved.

Program Files is a separate Explorer divergence case: WizTree aligns closely
with disk-insight, while Explorer Properties is much smaller.

**M-1 measurement still needed**: explicitly record Explorer "Size on disk" for
Windows and Users.

### K-3b verdict

**B + D**:
- Cause A (metric mismatch) and Cause C (WOF) are highly confident explanations
- Cause D (hardlink/WinSxS) is confirmed and quantified
- Explorer "Size on disk" for Windows and Users is still unmeasured

**v0.3.0-daily-use: HOLD** — size accuracy remains a trust issue pending M-1.

---

## 9. M-1: Explorer Size on disk measurement plan

**See**: `docs/size-discrepancy-investigation.md` §M-1

The next concrete step to improve size trust: explicitly record Explorer
"Size on disk" (not "Size") for the four key paths, then compare against
WizTree "Allocated" and both disk-insight policies.

### Metric alignment reminder

| Explorer label | WizTree label | disk-insight field | What it measures |
|---------------|---------------|-------------------|-----------------|
| Size | Size | — | Logical file size (uncompressed) |
| **Size on disk** | **Allocated** | **subtree_size** | Disk allocation (WOF-aware or NTFS) |

**Critical**: always compare "Size on disk" with "Allocated", never "Size" with "Allocated".
The "Explorer 11.0 GB" value from prior notes may be logical "Size" — this is what M-1 resolves.

### M-1 classification rules

| M-1 outcome | Conclusion |
|-------------|------------|
| Explorer SoD ≈ WizTree Alloc ≈ wof_adjusted, current is the outlier | WOF Case A confirmed — `wof_adjusted` is the accurate policy for WOF paths |
| Explorer SoD ≈ WizTree Alloc, but wof_adjusted also differs | WOF is not the full explanation — investigate hardlink or other causes |
| Explorer Size ≈ 11 GB (not Size on disk) | Cause A (metric mismatch) confirmed — prior comparison was invalid |
| WizTree Alloc ≈ wof_adjusted and WizTree Size ≈ current, but Explorer is much smaller | Explorer divergence / special folder accounting case |

### Status

**M-1 PFx86 measurement recorded (2026-05-26).**

`C:\Program Files (x86)` Explorer Properties reported:
- Size: 15.2 GB / 16,342,637,554 bytes
- Size on disk: 11.0 GB / 11,882,143,744 bytes

This changes the PFx86 interpretation. Explorer **Size** and WizTree **Size**
align around 15.2 GB, while disk-insight `current` (~10.1 GB) and
`wof_adjusted` (~8.251 GB) are allocation-oriented values. The prior comparison
mixed logical-size and allocated-style metrics.

Current classification: **Case 3 + residual differences remain**.
- disk-insight is not showing Explorer "Size"; it is showing allocation-oriented values.
- UI labels and explanations should make `current` / `wof_adjusted` meaning clearer.
- Residual deltas remain: Explorer Size on disk 11.0 GB vs current ~10.1 GB,
  and WizTree Allocated ~7.8 GB vs wof_adjusted ~8.251 GB.
- This is not a full accuracy resolution and does not prove an aggregation bug.

**v0.3.0-daily-use: HOLD continues** until the metric wording and residual
comparison story are clearer.

### Program Files measurement result

`C:\Program Files` Explorer Properties reported:
- Size: 19.6 GB / 21,124,549,940 bytes
- Size on disk: 19.5 GB / 20,973,977,600 bytes
- Files: 49,652
- Folders: 6,394

WizTree reported Size 30.6 GB, Allocated 24.6 GB, 86,577 files, and 12,250
folders. disk-insight reported `current` ~29.7 GB and `wof_adjusted` ~24.8 GB.

This is a different pattern from PFx86:
- WizTree Allocated and disk-insight `wof_adjusted` are very close.
- WizTree Size and disk-insight `current` are also relatively close.
- Explorer Size / Size on disk are much smaller than both.

Current classification: **Explorer divergence case**.

Candidate causes are Explorer Properties using a different accounting boundary
for special folders, permissions, app packages, reparse points, WindowsApps, or
related Program Files handling. There is not enough evidence to call this a
disk-insight aggregation bug. The result increases confidence in
`wof_adjusted` for Program Files while leaving the Explorer-vs-WizTree/MFT gap
unresolved.
