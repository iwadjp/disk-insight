# Reclaimable Size Model

Status: N-1 design, not implemented

## 1. Problem Statement

disk-insight is most useful when it helps decide where to look while freeing
disk space.

The practical question is not "what is Explorer Size?" The practical question is
"if this folder is removed or moved elsewhere, how much free space is likely to
increase?"

The M-1 through M-3 work improved size discrepancy explanation. That is useful,
but it is not the final user-facing goal. A cleanup tool needs an estimate that
helps the user decide which subtree is worth investigating, while also making
clear when the estimate is uncertain.

This document designs an `Estimated reclaimable size` model. It is a safe
diagnostic concept only. It does not add a delete feature, does not perform
deletion, and does not claim that any path should be deleted manually.

## 2. What Is Reclaimable Size?

Reclaimable size is an estimate of the free space that may be gained if a target
subtree is deleted or moved to another drive.

It is not Explorer "Size". It may be closer to Explorer "Size on disk", WizTree
"Allocated", or disk-insight `wof_adjusted`, depending on the path and NTFS
features involved.

Important caveats:

- Hard links can make per-directory totals larger than the space that would be
  reclaimed by removing one name.
- WinSxS and Windows component-store accounting can make direct deletion
  estimates misleading.
- WOF-compressed files often make logical/current allocation views larger than
  the compressed backing allocation.
- Reparse points can cause tools to count different surfaces.
- Sparse or compressed files can make logical size diverge from physical
  allocation.

## 3. Candidate Metrics

| Metric | Meaning | Reclaimable estimate suitability |
|--------|---------|----------------------------------|
| Explorer Size | Logical size | Low |
| Explorer Size on disk | Allocated-ish | Medium/High |
| WizTree Size | Logical-ish | Low/Medium |
| WizTree Allocated | Allocated-ish | Medium/High |
| disk-insight current | Allocation-oriented estimate | Medium |
| disk-insight wof_adjusted | WOF-aware estimate | Medium/High for WOF-heavy paths |
| Actual free-space delta after deletion | Ground truth | Highest, but destructive / not used |

## 4. Initial Model Proposal

Initial diagnostic model:

```text
Estimated reclaimable:
  primary estimate = wof_adjusted

Range:
  lower/primary = wof_adjusted
  upper/reference = current
```

Rationale:

- `current` can overstate WOF-compressed content because it follows the existing
  allocation-oriented policy.
- `wof_adjusted` can better approximate actual disk allocation for WOF-heavy
  paths.
- The range communicates uncertainty without pretending to know the exact
  post-removal free-space delta.

The model must be path-sensitive. The same primary estimate can be high
confidence for ordinary user data and low confidence for Windows component-store
paths.

## 5. Confidence Model

### High Confidence

Use high confidence when:

- WOF delta is small.
- Hardlink suspect ratio is low.
- The path is not under Windows, WinSxS, servicing, assembly, or another
  component-store-heavy area.
- The path is ordinary user data.

Example: `C:\Users`.

### Medium Confidence

Use medium confidence when:

- WOF delta is significant, but the main contributors are clear.
- The path is an application area such as `C:\Program Files` or
  `C:\Program Files (x86)`.
- Hardlink suspects may exist, but the dominant source of the delta is visible.

Examples: `C:\Program Files`, `C:\Program Files (x86)`.

### Low Confidence

Use low confidence when:

- The path is under `C:\Windows`, `C:\Windows\WinSxS`,
  `C:\Windows\servicing`, `C:\Windows\assembly`, or similar system areas.
- Hardlink or component-store accounting is heavy.
- Reparse points and protected system folders are likely to affect accounting.
- Actual deletion may not reclaim the estimated bytes, and manual deletion may
  be unsafe.

Example: `C:\Windows`.

## 6. Path-Specific Interpretation From Current Data

### `C:\Users`

```text
current:       85.664 GB
wof_adjusted: 85.406 GB
delta:         0.258 GB
```

Interpretation:

- WOF delta is small.
- This is an alignment case from M-1.
- Reclaimable estimate confidence is likely higher than for system/application
  paths.
- Actual removable candidates are usually user files, downloads, caches, or app
  data. The tool should still avoid suggesting blind deletion of a full user
  profile.

### `C:\Program Files`

```text
current:       29.693 GB
wof_adjusted: 24.788 GB
delta:          4.906 GB
main WOF delta source: WindowsApps 4.778 GB
```

Interpretation:

- WOF impact is large and concentrated.
- `wof_adjusted` is likely a better reclaimable estimate than `current`.
- Confidence is medium.
- Cleanup should generally use app uninstall, Windows Settings, Store app
  management, or vendor uninstallers, not manual folder deletion.

### `C:\Program Files (x86)`

```text
current:       10.138 GB
wof_adjusted:  8.250 GB
delta:          1.888 GB
main WOF delta sources: Microsoft Office / Microsoft
```

Interpretation:

- WOF impact is significant.
- `wof_adjusted` is likely a better reclaimable estimate than `current`.
- Confidence is medium.
- Cleanup should generally use app uninstall, not manual folder deletion.

### `C:\Windows`

```text
current:       26.715 GB
wof_adjusted: 17.982 GB
delta:          8.733 GB
```

Interpretation:

- This is a Windows special accounting case.
- WinSxS, hardlinks, component-store behavior, WOF, and protected system folders
  all affect the estimate.
- Reclaimable estimate confidence is low.
- The path should not be presented as a manual deletion target. Cleanup should
  use Windows cleanup tools, DISM, app maintenance, or supported OS mechanisms.

## 7. `--diag-path` Integration Proposal

Future `--diag-path` output should include a `Reclaimable estimate` section.

For `C:\Program Files`:

```text
Reclaimable estimate:
  estimated reclaimable: 24.788 GB
  range: 24.788 GB - 29.693 GB
  confidence: Medium
  basis: WOF-adjusted estimate; WOF delta mainly from WindowsApps
  caution: use app uninstall / Windows settings, not manual delete
```

For `C:\Users`:

```text
Reclaimable estimate:
  estimated reclaimable: 85.406 GB
  range: 85.406 GB - 85.664 GB
  confidence: High
  basis: current and wof_adjusted are close
```

For `C:\Windows`:

```text
Reclaimable estimate:
  estimated reclaimable: not recommended as a deletion target
  confidence: Low
  basis: Windows special accounting / hardlinks / component store
  caution: use Windows cleanup tools
```

The section should remain diagnostic. It should not imply that deletion is
implemented or recommended.

## 8. UI Integration Proposal

Future UI work could add:

- `Estimated reclaimable` in the selected folder card.
- A confidence badge: `High`, `Medium`, or `Low`.
- Context warnings:
  - `Use app uninstall`
  - `Windows system folder; use cleanup tools`
  - `Hardlinks may reduce actual reclaimed space`
- An `Explain` action that shows `--diag-path`-equivalent evidence for the
  selected path.

This is not implemented in N-1.

## 9. What Not To Claim

Do not claim:

- Deleting or moving the folder will always free exactly the estimate.
- The estimate is the exact free-space delta.
- Hardlinks, WinSxS, or component-store accounting are fully corrected.
- Windows folders are recommended deletion targets.
- disk-insight provides a delete feature.

## 10. Next Steps

### N-1b

Add a diagnostic-only `Reclaimable estimate` section to `--diag-path`.
Confidence can be rule-based. Normal output, JSON, UI values, correction
policy, hardlink accounting, WinSxS accounting, and delete behavior must remain
unchanged.

### N-1c

Design a UI presentation for `Estimated reclaimable`, confidence badges, and
warnings.

### N-1d

Run a real-device evaluation against the practical question: "Can this help
decide where to inspect when freeing disk space?"
