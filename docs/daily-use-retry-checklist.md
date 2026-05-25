# K-4: Daily-use retry checklist

**Date**: 2026-05-26
**Status**: evaluation checklist — no source code changes in this phase

---

## 1. Purpose

This checklist is for re-evaluating whether disk-insight reaches the
`v0.3.0-daily-use` milestone.

**Evaluation question**: does disk-insight have at least one use case where the
author would genuinely choose it over WizTree — not out of obligation, but
because it is the better tool for that task?

**Not the goal**: match WizTree feature-for-feature, or reach byte-exact size
accuracy. disk-insight is not a WizTree clone.

**PASS condition**: at least one area where disk-insight is the better choice,
and the three J-6 HOLD reasons (speed, progress, size meaning) are in an
acceptable state.

**HOLD condition**: disk-insight offers no genuine advantage; "it's mine" is
the only reason to use it.

---

## 2. Prerequisites

Before starting:

- [ ] WizTree is installed and can scan drives (no admin required)
- [ ] disk-insight is built: `npm run tauri build`
  - Binary: `src-tauri\target\release\disk-insight-ui.exe`
- [ ] Run `disk-insight-ui.exe` as **Administrator** (required for MFT access)
- [ ] Both C: and D: are NTFS drives

**Cold cache note**: if testing cold scan speed, reboot Windows first and do
NOT run any other disk scan before the first disk-insight scan. For a warm-cache
comparison, just run the scan normally.

---

## 3. Scan speed and progress check

Run both tools and record times.

### WizTree

- [ ] Scan C: — record start-to-done time: _______ s
- [ ] Scan D: — record start-to-done time: _______ s
- [ ] Note whether WizTree shows a progress indicator during scan: yes / no

### disk-insight

- [ ] Scan C: (Current policy) — record time from click to results: _______ s
- [ ] Scan D: (Current policy) — record time from click to results: _______ s

### Progress strip (K-2b/K-2c)

During a disk-insight scan, observe the scanning strip:

- [ ] Spinner appears immediately when scan starts
- [ ] Phase label updates: "Opening volume" → "Reading MFT (I/O)" → "Parsing records" → …
- [ ] Elapsed time counter ticks upward
- [ ] Shimmer bar animates smoothly
- [ ] Phase text is readable and not confusing

Qualitative assessment:

- [ ] "Reading MFT (I/O) · 14.2s" reduces the "is it hung?" anxiety vs a blank spinner
- [ ] Phase transitions feel informative, not noisy
- [ ] Strip disappears cleanly when scan completes

**Judgment** — scan speed / progress:

```
PASS  — speed gap and progress strip are acceptable for daily use
HOLD  — still too slow or progress strip is not helping

Notes:
```

---

## 4. Navigation check

Select the folders below in disk-insight and record observations.

### Folder drill-down

- [ ] Select `C:\Users` in the TreeView or Direct children panel
  - Direct children panel shows user profile folders with sizes
- [ ] Click into `C:\Users\<your-name>` from the Direct children panel
  - AppData, Desktop, Downloads, etc. appear with sizes
- [ ] Click `AppData` — local / roaming / temp children appear
- [ ] Click the `.. Parent` row — returns to `C:\Users\<your-name>`
- [ ] Click `.. Parent` again — returns to `C:\Users`
- [ ] Click `.. Parent` again — returns to `C:\` (if implemented) or stops at root

Root behavior:

- [ ] At `C:\` or drive root, the `.. Parent` row is absent

### Filter

Type in the filter box with `C:\Users\<your-name>` selected:

- [ ] `app` — AppData appears, unrelated folders disappear
- [ ] `down` — Downloads appears
- [ ] `vscode` or similar — relevant folder appears if it exists
- [ ] Clearing the filter restores all children
- [ ] Filter resets automatically when navigating to a new folder

### Sort

- [ ] Sort by Size ↓ — directories first, largest first
- [ ] Sort by Size ↑ — smallest first
- [ ] Sort by Name — alphabetical
- [ ] Sort by Type — directories grouped, then files

### Action buttons

- [ ] "Open folder" on a directory — Explorer opens that folder
- [ ] "Select file" on a top-files row — Explorer opens with file highlighted
- [ ] "Copy path" — path copied to clipboard, "Copied!" flashes briefly
- [ ] No delete button exists anywhere

**WizTree comparison**:

- [ ] Both tools can navigate to a specific large folder in under 3 clicks
- [ ] Note any task where disk-insight found the answer faster: ____________
- [ ] Note any task where WizTree was clearly faster: ____________

**Judgment** — navigation:

```
PASS  — can reach the target folder and see its contents naturally
HOLD  — navigation is too awkward for daily use

Notes:
```

---

## 5. Size meaning check

Run disk-insight with both policies and compare to WizTree.

### Setup

- [ ] Scan C: with Current policy; note C: total: _______ GB
- [ ] Scan C: with WOF adjusted (experimental); note C: total: _______ GB
- [ ] WizTree C: total (from earlier): _______ GB

### Folder-level comparison

Check these specific paths (select in disk-insight Direct children panel or TreeView):

| Folder | disk-insight current | disk-insight wof_adjusted | WizTree | Notes |
|--------|--------------------:|-------------------------:|--------:|-------|
| C:\ | | | | |
| C:\Program Files | | | | |
| C:\Program Files (x86) | | | | |
| C:\Windows | | | | |
| C:\Windows\WinSxS | | | | |
| C:\Users | | | | |

### Understanding check

After reviewing the numbers:

- [ ] `current` being higher than WizTree for `C:\Windows` and `C:\Program Files (x86)` makes sense
  (WOF-compressed files counted at projected size)
- [ ] `wof_adjusted` moving Program Files closer to WizTree makes sense
- [ ] WinSxS remaining high in both policies is understandable (hardlink overcount — known limitation)
- [ ] `C:\Users` being close in both policies makes sense (little WOF or hardlink impact)
- [ ] The phrase "NTFS allocation-based" is a sufficient explanation for the differences

**Judgment** — size meaning:

```
PASS  — "why it differs" is now explainable; size numbers make sense for the intended use
HOLD  — still confused about why numbers differ; size trust too low for daily use

Notes:
```

---

## 6. Unique value check

For each candidate, mark whether it applies for you:

| Use case | disk-insight better? | Notes |
|----------|---------------------|-------|
| **Delete-free safety**: browse and analyze without any risk of accidental deletion | [ ] Yes [ ] No | |
| **WOF comparison**: switch between current / wof_adjusted to understand compressed-file accounting | [ ] Yes [ ] No | |
| **Direct children drill-down**: navigate any folder's direct children with filter and sort | [ ] Yes [ ] No | |
| **Explorer integration**: Open folder, Select file, Copy path from scan results | [ ] Yes [ ] No | |
| **Size discrepancy investigation**: use `--diag-wof-global` / `--diag-winsxs` to understand WizTree gap | [ ] Yes [ ] No | |
| **Personal dev/research tool**: customizable CLI flags, JSON output, diagnostic modes | [ ] Yes [ ] No | |

**Assessment**: how many "Yes" answers?

- 3 or more → strong unique value, proceed to PASS consideration
- 1–2 → weak value, depends on how strong those areas are
- 0 → HOLD

---

## 7. Overall PASS / HOLD judgment

Review all four sections and make the final call.

### PASS criteria (all must hold)

- [ ] At least one use case where disk-insight is genuinely preferred over WizTree
- [ ] Scan speed gap is tolerable (not so slow it breaks the analysis workflow)
- [ ] Progress strip reduces "is it hung?" anxiety sufficiently
- [ ] Size differences from WizTree/Explorer are explainable, not mysterious
- [ ] Target folder can be reached naturally (3–5 clicks or fewer)
- [ ] No delete button is a feature, not a limitation, for the intended use

### HOLD criteria (any one triggers HOLD)

- [ ] WizTree is strictly better in every area — disk-insight offers no advantage
- [ ] "It's mine" is the only reason to choose disk-insight over WizTree
- [ ] Scan is so slow it feels broken even with the progress strip
- [ ] Size numbers remain confusing after trying both policies
- [ ] Navigation is too cumbersome to reach the target folder for typical tasks

### Final verdict

```
Verdict:   PASS / HOLD

Primary reason:

Secondary notes:

Date of evaluation:
```

---

## 8. Next actions

### If PASS

- Tag candidate: `v0.3.0-daily-use`
  - Run: `git tag v0.3.0-daily-use`
  - Or defer tag until GitHub public release decision is also confirmed
- GitHub public release: **separate decision** — not automatic on PASS
  - Current status: deferred until PASS is stable and README is polished
- Record result in `docs/daily-use-gap-review.md` Section 17

### If HOLD

Record the primary blocker and assign to the matching next task:

| Blocker | Next task |
|---------|-----------|
| Scan speed still too slow | K-5: read_mft cold scan investigation / optimization planning |
| Progress strip not helping | K-2d: progress UI refinement (percentage, smoother phase transitions) |
| Size numbers still confusing | K-3b: size explanation UI (help text, tooltip, WinSxS note) |
| Navigation too cumbersome | J-7: breadcrumb / back-forward navigation history |
| Search missing | J-8: global path search across scan results |
| Other | Record in HOLD notes above |

- Record result in `docs/daily-use-gap-review.md` Section 17
- Update `docs/ui-plan.md` with next task priority
