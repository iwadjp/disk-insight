# WOF final allocation policy design

Status: design only. No normal CLI, JSON, UI, or `final_alloc` behavior has
changed.

## 1. Background

disk-insight currently computes `final_alloc` from the existing MFT size policy.
For WOF-compressed files this means the subtree total can still be driven by the
unnamed `$DATA` logical or allocated-side value, even when the real backing data
is stored in the named `WofCompressedData` stream.

WizTree appears to treat WOF files closer to their compressed backing stream or
actual cluster usage. That explains why disk-insight is higher than WizTree in
Program Files (x86), especially under Microsoft Edge and Microsoft Office.

PFx86-DIAG-2 added a diagnostic-only WOF adjusted estimate to `--diag-pfx86`.
That estimate replaced each WOF file's current `final_alloc` with the allocated
size of its `WofCompressedData` stream, without changing normal output. The
result moved the measured folders much closer to known WizTree allocated values.

## 2. Observed evidence

PFx86-DIAG-2 results:

| Target | Current | WOF-adjusted | Delta | WizTree allocated | Remaining delta |
|--------|--------:|-------------:|------:|------------------:|----------------:|
| Program Files (x86) | 10.139 GB | 8.251 GB | -1.888 GB | 7.8 GB | +0.451 GB |
| Microsoft | 2.644 GB | 1.793 GB | -0.851 GB | 1.3 GB | +0.493 GB |
| Microsoft Office | 4.250 GB | 3.235 GB | -1.014 GB | 3.2 GB | +0.035 GB |
| EdgeCore | 1.870 GB | 1.197 GB | -0.674 GB | unavailable | unavailable |
| Office16 | 2.377 GB | 1.710 GB | -0.667 GB | unavailable | unavailable |
| VFS | 1.635 GB | 1.383 GB | -0.252 GB | unavailable | unavailable |

Interpretation:

- Program Files (x86) improves from 10.139 GB to 8.251 GB, leaving about
  0.451 GB against WizTree's 7.8 GB.
- Microsoft Office improves from 4.250 GB to 3.235 GB, which is effectively
  aligned with WizTree's 3.2 GB at this precision.
- Microsoft improves materially, but still has about 0.493 GB remaining. This is
  consistent with EdgeCore also having hardlink or cluster-overlap effects.
- EdgeCore, Office16, and VFS all move downward by meaningful amounts, confirming
  that WOF is not just an EdgeCore issue.

## 3. Proposed WOF final_alloc policy

Candidate production rule:

```text
if file has WOF reparse identity
   and WofCompressedData stream allocated size > 0:
    final_alloc = WofCompressedData stream allocated size
else:
    final_alloc = existing final_alloc policy
```

Details and open policy points:

- Do not ignore unnamed `$DATA` blindly for every reparse point. Only WOF files
  with a positive `WofCompressedData` allocation should be eligible.
- For eligible WOF files, ignoring unnamed `$DATA` is reasonable because the
  unnamed stream appears to describe the projected file contents rather than the
  compressed on-disk backing allocation.
- `WofCompressedData` may be resident or non-resident. The policy should use the
  parsed allocated size consistently:
  - resident stream: resident content length is the best available allocation
    proxy in current parsing
  - non-resident stream: non-resident allocated size should be used
- If stream allocation is `0` or cannot be parsed, keep the existing policy.
- If the WOF reparse tag exists but `WofCompressedData` is missing, keep the
  existing policy and report it in diagnostics.
- WOF must be distinguished from other reparse points. The relevant tag is
  `0x80000017` (`IO_REPARSE_TAG_WOF`), or an equivalent WOF identity confirmed
  by the named stream.
- Sparse, compressed, and WOF can overlap in attribute flags. WOF should be a
  more specific policy branch than generic sparse/compressed handling, but only
  after the WOF identity and stream allocation are confirmed.
- Hardlink correction should not be mixed into the first WOF policy. Apply WOF
  first at the file record level, then later evaluate hardlink or cluster dedup
  as a separate layer. Link-count apportioning is not sufficient.

## 4. Safety conditions

Production WOF correction should require all of these:

- The file is in use and is not a directory.
- The file is identified as WOF by `IO_REPARSE_TAG_WOF` (`0x80000017`) or by a
  defensible equivalent WOF signal already parsed from MFT metadata.
- A named `$DATA` stream called `WofCompressedData` exists.
- The `WofCompressedData` allocated size is greater than `0`.
- The stream allocation is parsed from the base record and any extension records
  without overflow.
- If both unnamed `$DATA` and WOF stream sizes are available, the WOF stream is
  clearly smaller than the current policy result, or the unnamed `$DATA` is known
  to represent the projected logical contents.
- If any condition cannot be proven, fall back to the existing `final_alloc`.

This keeps the rule conservative and prevents unrelated reparse points from
being undercounted.

## 5. Fallback rules

- WOF identity cannot be determined: use existing `final_alloc`.
- Reparse tag is unknown or not resident and no WOF stream is found: use existing
  `final_alloc`.
- Reparse tag is WOF but `WofCompressedData` is missing: use existing
  `final_alloc`.
- WOF stream allocation cannot be parsed: use existing `final_alloc`.
- WOF stream allocation is `0`: use existing `final_alloc`.
- WOF stream allocation overflows during base + extension aggregation: use
  existing `final_alloc` and report a diagnostic warning.
- Diagnostics mode should count fallback cases separately so that production
  eligibility can be audited before enabling normal output changes.

## 6. Impact estimate

Likely affected areas:

- `C:\Program Files (x86)\Microsoft`
- `C:\Program Files (x86)\Microsoft Office`
- `C:\Program Files (x86)\Microsoft\EdgeCore`
- WindowsApps and Store app payloads
- Edge, Office, and other AppX/AppInstaller-managed components
- Some Windows system components that use WOF projection

Likely less related:

- WinSxS. That remains primarily a hardlink and component-store accounting
  problem, although individual files may still use compression.

Expected improvement from PFx86-DIAG-2:

- Program Files (x86): 10.139 GB -> 8.251 GB
- Difference from WizTree 7.8 GB shrinks to about 0.451 GB.
- Microsoft Office: 4.250 GB -> 3.235 GB, effectively matching WizTree 3.2 GB.
- Microsoft: 2.644 GB -> 1.793 GB, still about 0.493 GB above WizTree 1.3 GB.

This is strong evidence that WOF correction is worth pursuing, but it also shows
that WOF alone is not a complete WizTree matching strategy.

## 7. Risks

- Misreading the WOF stream allocation could undercount real disk usage.
- Named streams could be double-counted or undercounted if base and extension
  records are combined incorrectly.
- False positives on non-WOF reparse points could produce severe underestimates.
- WizTree may use a cluster-level algorithm rather than exactly the
  `WofCompressedData` allocated size, so exact matching is not guaranteed.
- Windows Explorer "size on disk" may remain different because Explorer and
  WizTree expose different accounting models.
- Applying WOF before hardlink correction changes how remaining deltas are
  interpreted, especially in EdgeCore.
- Some special files may have WOF metadata but require unnamed `$DATA` fallback
  to avoid undercounting.
- Current diagnostics are focused on Program Files (x86). Global impact is not
  measured yet.

## 8. Recommended next steps

Recommended order:

1. PFx86-DIAG-4: add a global WOF-adjusted simulation mode.
   - Suggested shape: `--diag-wof-global` or equivalent.
   - It should compute current totals and WOF-adjusted totals side by side.
   - It should not change normal human, JSON, Tauri, or TreeView output.
   - It should summarize top affected directories and fallback counts.
2. PFx86-WOF-1: after global simulation, add the WOF policy behind an explicit
   feature flag or diagnostic flag.
   - Keep the existing policy as the default until the global impact is reviewed.
   - Add tests or deterministic sample coverage for WOF stream parsing paths if
     practical.
3. PFx86-HL-1: investigate hardlink or cluster-overlap diagnostics for the
   EdgeCore residual.
   - Do not implement link-count apportioning as a production correction.
   - Prefer cluster/data-run evidence if hardlink correction becomes necessary.

This sequence matches the safer path: simulate globally first, then decide
whether normal aggregation should change, and defer hardlink correction to the
specific residual where WOF does not explain the gap.

## 9. Decision

Decision:
WOF correction is a strong candidate for a future `final_alloc` policy, but it
should not be enabled in normal output yet. The next safe step is a global
WOF-adjusted simulation mode to estimate impact beyond Program Files (x86).

Normal CLI, JSON, UI, Tauri TreeView, and `final_alloc` behavior remain
unchanged until that broader simulation is reviewed.

## 10. PFx86-DIAG-4 global simulation result

PFx86-DIAG-4 added `--diag-wof-global`, a diagnostic-only simulation that keeps
the existing `final_alloc` policy intact and computes a second WOF-adjusted
subtree total after MFT tree aggregation.

Major folder results from 2026-05-25:

| Target | Current | WOF-adjusted | Delta | WOF files | WizTree allocated | Adjusted remaining |
|--------|--------:|-------------:|------:|----------:|------------------:|-------------------:|
| C: | 186.528 GB | 170.609 GB | -15.919 GB | 104884 | 174.9 GB | +4.291 GB |
| Program Files (x86) | 10.139 GB | 8.251 GB | -1.888 GB | 6924 | 7.8 GB | -0.451 GB |
| Program Files | 29.693 GB | 24.788 GB | -4.906 GB | 14115 | 24.6 GB | -0.188 GB |
| Windows | 27.134 GB | 18.401 GB | -8.733 GB | 82421 | 16.1 GB | -2.301 GB |
| Users | 85.035 GB | 84.777 GB | -0.258 GB | 941 | 85.2 GB | +0.423 GB |
| ProgramData | 5.965 GB | 5.831 GB | -0.134 GB | 483 | unavailable | unavailable |
| Program Files\\WindowsApps | 10.797 GB | 6.019 GB | -4.778 GB | 13823 | unavailable | unavailable |
| Windows\\WinSxS | 11.467 GB | 8.729 GB | -2.738 GB | 19645 | unavailable | unavailable |
| Windows\\System32 | 4.402 GB | 3.780 GB | -0.622 GB | 3886 | unavailable | unavailable |
| Program Files (x86)\\Microsoft | 2.644 GB | 1.793 GB | -0.851 GB | 760 | 1.3 GB | -0.493 GB |
| Program Files (x86)\\Microsoft Office | 4.250 GB | 3.235 GB | -1.014 GB | 6045 | 3.2 GB | -0.035 GB |
| Program Files (x86)\\Windows Kits | 2.120 GB | 2.120 GB | +0.000 GB | 0 | 2.1 GB | -0.020 GB |

Largest observed WOF deltas:

- `C:`: -15.919 GB
- `C:\Windows`: -8.733 GB
- `C:\Program Files`: -4.906 GB
- `C:\Program Files\WindowsApps`: -4.778 GB
- `C:\Windows\servicing`: -3.072 GB
- `C:\Windows\WinSxS`: -2.738 GB
- `C:\Program Files (x86)`: -1.888 GB

Interpretation:

- WOF adjustment globally moves disk-insight C: from 186.528 GB to 170.609 GB.
  Compared with the approximate WizTree C: allocated value of 174.9 GB, the
  simulation overshoots by about 4.291 GB. This is still much closer than the
  unadjusted 11.628 GB gap, but it means a production policy needs conservative
  eligibility and more review around Windows system components.
- `C:\Program Files` becomes very close to the known WizTree reference
  (24.788 GB vs 24.6 GB).
- `C:\Program Files (x86)` and Microsoft Office keep the PFx86-DIAG-2 result:
  Program Files (x86) remaining gap is about 0.451 GB, while Microsoft Office is
  nearly aligned.
- `C:\Windows` still remains about 2.301 GB above the reference after WOF
  adjustment. `WinSxS`, servicing LCU packages, hardlinks, and component-store
  accounting remain likely residual factors.
- `C:\Users` changes only slightly and remains close to the WizTree reference,
  which suggests WOF adjustment is not broadly disruptive for user data on this
  machine.

Decision update:
WOF correction remains a strong production candidate, but should still not be
enabled in normal output immediately. The safer next step is a feature-flagged
or diagnostic-flagged normal aggregation experiment with conservative fallback
conditions, plus targeted review of Windows / WindowsApps / WinSxS behavior.
Hardlink and cluster-overlap correction should remain separate work.

## 11. PFx86-DIAG-5 WinSxS / component store result

PFx86-DIAG-5 added `--diag-winsxs` to separate WOF-correctable size differences
from WinSxS and Windows component-store accounting effects. It is still
diagnostic only; normal output and `final_alloc` behavior are unchanged.

Major results from 2026-05-25:

| Target | Current | WOF-adjusted | WOF delta | link>1 records | multi-name records | hardlink suspect adjusted |
|--------|--------:|-------------:|----------:|---------------:|-------------------:|--------------------------:|
| Windows | 27.134 GB | 18.401 GB | -8.733 GB | 310551 | 309788 | 11.429 GB |
| WinSxS | 11.467 GB | 8.729 GB | -2.738 GB | 70912 | 72959 | 5.810 GB |
| System32 | 4.402 GB | 3.779 GB | -0.622 GB | 6576 | 4465 | 1.291 GB |
| servicing | 5.309 GB | 2.237 GB | -3.072 GB | 223337 | 224137 | 1.619 GB |
| Installer | 0.105 GB | 0.105 GB | +0.000 GB | 232 | 232 | 0.020 GB |
| assembly | 3.423 GB | 1.689 GB | -1.734 GB | 2355 | 2290 | 1.680 GB |
| Microsoft.NET | 0.445 GB | 0.221 GB | -0.224 GB | 1824 | 1400 | 0.186 GB |
| SysWOW64 | 0.712 GB | 0.505 GB | -0.207 GB | 1695 | 1167 | 0.335 GB |

WinSxS-specific observations:

- WinSxS WOF-adjusted size is 8.729 GB versus the WizTree reference of 4.1 GB,
  leaving about 4.629 GB after WOF.
- WinSxS has 70,912 `link_count > 1` records and 72,959 records with multiple
  `$FILE_NAME` attributes.
- The WOF-adjusted total for WinSxS hardlink or multi-name suspects is 5.810 GB,
  which is large enough to plausibly explain the remaining delta.
- WinSxS WOF + hardlink overlap is also significant: 17,501 records, 4.973 GB
  current, and 2.689 GB WOF-adjusted.
- `$FILE_NAME` parent hints found 19,574 WinSxS suspect records with a parent
  outside the WinSxS subtree, including 10,676 System32 hints and 3,546 SysWOW64
  hints. This supports the component-sharing hypothesis, but it is not cluster
  deduplication.

Interpretation:

- WOF alone is not sufficient for WinSxS. It reduces WinSxS by 2.738 GB, but
  the residual against WizTree remains about 4.629 GB.
- WinSxS and Windows servicing are dominated by hardlink / multi-name /
  component-store signals. They should be treated as a separate accounting
  problem from the Program Files / WindowsApps WOF behavior.
- WOF production policy should be conservative around Windows component-store
  paths until hardlink or cluster-sharing diagnostics are better understood.
- The next investigation should be a cluster/data-run or component-sharing
  diagnostic mode, not a production hardlink correction.
