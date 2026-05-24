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
