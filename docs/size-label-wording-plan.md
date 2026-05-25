# Size Label Wording Plan

Status: design only. No UI, Rust, Tauri, TypeScript, storage-policy, WOF,
hardlink, WinSxS, or delete behavior changes are included here.

## 1. Problem statement

The current UI does not make the meaning of size values clear enough. Labels
such as "ALLOCATED", "Subtree", and "Size policy" are technically close to the
implementation, but they do not fully tell the user what the value should be
compared with.

The main risk is metric confusion:

- Explorer "Size" and Explorer "Size on disk" are different values.
- WizTree "Size" and WizTree "Allocated" are different values.
- disk-insight mainly displays allocated-style or policy-adjusted estimates.
- disk-insight `current` and `wof_adjusted` should not be directly compared
  with Explorer "Size" as if they were logical size values.

The UI therefore needs to explain what kind of size is being shown and what it
should be compared with.

## 2. Size concepts

| Concept | Tools / labels | Meaning | disk-insight relevance |
|---|---|---|---|
| Logical size | Explorer "Size"; WizTree "Size" | Close to the logical file content size. Compression and allocation details are not the main point. | Not the primary disk-insight display target. |
| Size on disk / allocated size | Explorer "Size on disk"; WizTree "Allocated" | Disk allocation-oriented value. Affected by compression, sparse files, cluster allocation, and tool-specific accounting. | Closest comparison target for disk-insight estimates. |
| disk-insight current | Current policy | Allocation-oriented estimate from NTFS/MFT-derived data. | Do not compare directly with Explorer "Size". |
| disk-insight wof_adjusted | WOF-adjusted policy | Experimental WOF-aware adjusted estimate. Uses WOF stream allocation when safely detected. | Can be closer to WizTree "Allocated" for WOF-heavy paths, but hardlink / WinSxS accounting is not fully corrected. |

## 3. Proposed UI wording

| Current UI text | Problem | Proposed wording | Notes |
|---|---|---|---|
| ALLOCATED | Can be read as exact Explorer-compatible size. | ALLOCATED ESTIMATE | Summary card. Short and explicit. |
| Subtree | Does not say what kind of total this is. | Subtree estimate | Selected folder card. |
| Direct files | Does not say this is policy-dependent. | Direct files estimate | Selected folder card. |
| Size policy | "Policy" is implementation language. | Size metric | Toolbar label. |
| Current (default) | "Current" does not explain the metric. | Current allocation estimate | Selector option. |
| WOF adjusted | Experimental status is easy to miss. | WOF-adjusted estimate (experimental) | Selector option / badge text. |
| SUBTREE SIZE | Looks like logical size. | EST. ALLOCATED | Table header. |
| DIRECT FILE SIZE | Looks like logical file size. | DIRECT FILE EST. | Table header. |
| Top directories / Subtree size | "Size" can be confused with Explorer "Size". | Estimated allocated size | Table help / tooltip wording, not necessarily full header text. |

The proposed labels intentionally use "estimate". This avoids overclaiming exact
disk usage or exact parity with Explorer / WizTree.

## 4. Recommended final labels

Recommended minimal UI wording for M-2b:

- Summary card:
  - `ALLOCATED` -> `ALLOCATED ESTIMATE`
- Selected folder:
  - `Subtree:` -> `Subtree estimate:`
  - `Direct files:` -> `Direct files estimate:`
- Toolbar:
  - `Size policy` -> `Size metric`
  - `Current (default)` -> `Current allocation estimate`
  - `WOF adjusted (experimental)` -> `WOF-adjusted estimate (experimental)`
- Tables:
  - `SUBTREE SIZE` -> `EST. ALLOCATED`
  - `DIRECT FILE SIZE` -> `DIRECT FILE EST.`
- Help text:
  - `Compare with Explorer "Size on disk" or WizTree "Allocated", not Explorer "Size".`

These labels are short enough for the current UI and make the metric boundary
clearer without adding a large explanatory panel.

## 5. Tooltip / help text plan

Current metric tooltip:

```text
Current allocation estimate. This is closer to Explorer "Size on disk" or WizTree "Allocated" than to Explorer "Size".
```

WOF-adjusted metric tooltip:

```text
Experimental WOF-aware estimate. This may be closer to WizTree "Allocated" for WOF-compressed files, but hard links and WinSxS accounting are not fully corrected.
```

Windows / WinSxS caveat tooltip:

```text
Windows and WinSxS may differ across tools because of hard links, WOF, and component-store accounting.
```

General comparison help:

```text
disk-insight shows an estimated allocation metric. Compare with Explorer "Size on disk" or WizTree "Allocated" where appropriate.
```

## 6. Visual treatment

Potential UI treatment for a later implementation:

- Add a small `?` tooltip next to `ALLOCATED ESTIMATE`.
- Keep the experimental badge when WOF-adjusted is selected.
- Include "estimate" in selected folder card labels.
- Keep table headers short; move longer explanations into tooltips.
- Consider a later "Why different?" link that opens a concise help section.

This document does not implement any of these UI changes.

## 7. What not to claim

The UI and documentation should not claim:

- "exact disk usage"
- "matches Explorer"
- "matches WizTree"
- "WinSxS fully corrected"
- "hardlink dedup implemented"

The correct stance is: disk-insight shows policy-dependent estimates that can be
useful for comparison, with known caveats.

## 8. M-1 findings mapping

| M-1 pattern | What wording can improve | What wording cannot solve |
|---|---|---|
| PFx86 metric mix-up | Reduces confusion between Explorer "Size" and allocated-style values. | Residual deltas still need investigation. |
| Program Files Explorer divergence | Makes clear that Explorer "Size" is not always the comparison target. | Does not explain why Explorer Properties counts less than WizTree / MFT-style tools. |
| Users alignment case | Makes `current` feel natural as an ordinary user-data estimate. | Does not prove all paths align. |
| Windows special accounting case | Keeps a visible caveat for Windows / WinSxS. | Does not solve hardlink / component-store accounting. |

## 9. Recommendation

Proceed with M-2b as a minimal UI label implementation:

- Rename the most misleading labels first.
- Add short tooltips / help text for metric comparison.
- Keep `wof_adjusted` experimental.
- Do not move directly into correction implementation.

Daily-use size trust depends first on making the user understand what size is
being shown. Correction work should remain in K-3c / M-3 or later.
