# K-5: Scan Speed / Cold Cache Investigation Plan

**Date**: 2026-05-27
**Status**: Planning — no source changes

---

## 1. Problem Statement

N-2e confirmed that reclaimable estimate UI is at practical (○) level.
The remaining blocker for `v0.3.0-daily-use` is **scan speed / cold cache**.

Key facts:

- disk-insight C: scan ≈ 24 s (Tauri UI, cold) vs WizTree ≈ 15 s
- disk-insight D: scan ≈ 81 s vs WizTree ≈ 51 s
- Scan progress strip (K-2) mitigates perceived slowness, but actual elapsed time gap remains
- CLI warm cache (C:) ≈ 9.5 s — Tauri UI adds ~13–15 s overhead under cold conditions

The HOLD condition is: "WizTree is simply faster and clearer without a disk-insight-specific reason to choose it."

The goal is **not** to match WizTree exactly. The goal is:
> "The speed gap is acceptable given disk-insight's unique value (delete-free, reclaimable estimate, confidence-guided navigation)."

---

## 2. Current Known Measurements

From K-1 / K-1b / K-1c phases:

### CLI warm cache (C:)

| Phase | Time |
|-------|------|
| open_vol | ~0 ms |
| read_mft | 4 842 ms (51%) |
| parse | 450 ms (5%) |
| tree_build | 509 ms (5%) |
| aggregate | 170 ms (2%) |
| children_map | 3 145 ms (33%) |
| **total** | **9 441 ms** |

children_map stats: 358,622 dirs, 1,756,339 total children

### Tauri UI (K-1b, assumed cold cache)

- `[perf-tauri] build_model done`: 22 757 ms total
- Phase breakdown not measured separately

### WizTree reference

| Drive | WizTree | disk-insight UI |
|-------|---------|-----------------|
| C: | ~15 s | ~24 s |
| D: | ~51 s | ~81 s |

### K-1c hypothesis (unverified by cold measurement)

CLI `--perf-model` (warm) ≈ 9.5 s.
Tauri 22.8 s ≈ cold read_mft (15–18 s) + other phases (~5 s).

K-1d cold validation was planned but not yet executed after K-1c.

### N-2b / N-2d additions

`wof_size_map` was added to `MftTreeModel` in N-2b Step 2.
Impact on scan time is **unknown** — it has not been re-measured since the addition.

---

## 3. Unknowns

| Unknown | Priority |
|---------|----------|
| Cold CLI `--perf-model` read_mft actual value (K-1d was never run) | High |
| Whether N-2b `wof_size_map` addition degraded scan time | High |
| Tauri build_model vs CLI build_model breakdown after N-2b/N-2d | High |
| Windows Defender / AV realtime scan effect on MFT read | Medium |
| Admin vs non-admin overhead on MFT I/O | Medium |
| D: drive cold read_mft estimate | Medium |
| children_map optimization potential (HashMap vs sorted Vec, lazy build) | Low |
| UI model serialization cost (Tauri IPC JSON size) | Low |

---

## 4. Measurement Plan

All measurements use the existing `--perf-model` flag. No source changes needed.

### A. Warm CLI (run twice back-to-back)

```powershell
# Run as administrator
.\target\release\disk-insight.exe --drive C --top 100 --perf-model
.\target\release\disk-insight.exe --drive C --top 100 --perf-model
```

Expected: both ≈ 9.5 s total (read_mft ≈ 4.8 s, children_map ≈ 3.1 s).
Purpose: confirm N-2b/N-2d did not degrade warm path.

### B. Cold CLI (first run after reboot — K-1d execution)

```powershell
# Windows reboot → no other disk scan → administrator PowerShell immediately:
.\target\release\disk-insight.exe --drive C --top 100 --perf-model   # cold
.\target\release\disk-insight.exe --drive C --top 100 --perf-model   # warm
```

Expected cold: read_mft ≈ 15–18 s, total ≈ 20–22 s (K-1c hypothesis).
If cold total ≈ Tauri 22.8 s → cold cache is confirmed as the primary cause.
If cold total << 22.8 s → Tauri-specific overhead (spawn_blocking priority, IPC etc.) is significant.

### C. Tauri UI timing

```powershell
npm run tauri dev
```

Open DevTools → Console. Scan C: with the UI.

Read:
- `[perf-ui] invoke start` → `[perf-ui] scan done` (total including IPC round-trip)
- `[perf-tauri] build_model done` (Rust-side build time)
- `[perf-tauri] scan_drive total` (including IPC)

Compare Tauri `build_model` time against CLI `--perf-model` total to isolate Tauri overhead.

### D. D: drive (optional)

```powershell
.\target\release\disk-insight.exe --drive D --top 100 --perf-model   # warm ×2
# After reboot (optional):
.\target\release\disk-insight.exe --drive D --top 100 --perf-model   # cold
```

Purpose: confirm D: cold behavior and check if WOF map addition affected the large drive.

---

## 5. Daily-Use Speed Target

Provisional pass/fail thresholds:

| Scenario | Pass | Marginal | Fail |
|----------|------|----------|------|
| C: warm CLI | < 12 s | 12–16 s | > 16 s |
| C: cold Tauri UI | < 22 s | 22–28 s | > 28 s |
| D: warm CLI | < 55 s | 55–70 s | > 70 s |
| D: cold Tauri UI | < 80 s | 80–100 s | > 100 s |

Rationale:
- Progress strip is implemented (K-2). Perceived wait is shorter than actual elapsed.
- disk-insight's delete-free + reclaimable estimate justify a moderate speed premium over WizTree.
- WizTree ratio tolerance: up to ~1.5× is acceptable; > 1.5× on the same drive is a HOLD condition.
- Current cold Tauri C: ≈ 24 s vs WizTree 15 s = 1.6× → borderline. Reducing to < 22 s would drop below 1.5×.

---

## 6. Optimization Candidates

Ranked by likely impact vs implementation risk. **None implemented in K-5.**

### High impact / lower risk

| Candidate | Est. saving | Risk |
|-----------|-------------|------|
| Skip `wof_size_map` build when no reclaimable request is pending | 0–1 s (unknown) | Low — lazy build |
| children_map: switch from `HashMap<u64, Vec<>>` to pre-sorted vec for large dirs | 0.5–1 s | Medium |
| Avoid re-computing `wof_adjusted_alloc` for every record (deduplicate with existing WOF pass) | unknown | Medium |

### Medium impact / medium risk

| Candidate | Est. saving | Risk |
|-----------|-------------|------|
| read_mft parallel I/O (read extents concurrently with rayon) | 2–5 s cold | High — unsafe I/O interleave |
| Reduce IPC JSON size (omit fields unused by UI) | 0.5–2 s | Low — schema change |
| children_map lazy build (build only on first `get_children` call) | ~3 s at scan time | Medium — lazy state |

### Low impact / reserved

| Candidate | Notes |
|-----------|-------|
| path reconstruction via arena index instead of string | Requires significant refactor |
| Virtual scroll to reduce initial render cost | UI-only, scan time unchanged |
| OS read-ahead hints (`FILE_FLAG_SEQUENTIAL_SCAN`) | Already used for MFT open |

---

## 7. Risk

| Risk | Mitigation |
|------|-----------|
| Speed optimization silently changes subtree size values | Run `--perf-model` and verify total sizes match pre-optimization baseline |
| `wof_size_map` lazy build breaks reclaimable estimate on first UI select | Add guard: if map not built, return error gracefully (already handled in Tauri command) |
| Parallel I/O corrupts MFT read sequence | Restrict parallelism to extent-level boundaries; keep sequential within extent |
| children_map optimization changes sort order of children | Sort is done in `get_children`, not in map construction — safe |
| WOF / hardlink / WinSxS accounting degraded by refactor | All reclaimable tests: `--diag-path` on 4 standard paths before and after |

---

## 8. Recommended Next Tasks

### K-5b: Re-measurement (no source changes)

Execute measurement plan sections A, B, C above.

Goals:
1. Confirm whether N-2b/N-2d degraded warm scan time
2. Execute K-1d cold cache validation (cold CLI `--perf-model`)
3. Re-measure Tauri UI timing to get current baseline

Deliverable: updated measurement table in this document, PROGRESS.md entry.

### K-5c: Optimization candidate selection (2026-05-27)

**Status: Analysis complete — implementation deferred pending K-5d measurement**

#### K-5b results (updated)

| Measurement | Value | Notes |
|-------------|-------|-------|
| CLI warm C: (run 1) | 9 885 ms total / build_model 10 201 ms | |
| CLI warm C: (run 2) | 9 684 ms total / build_model 9 994 ms | |
| CLI warm D: (run 1) | 63 470 ms total | read_mft=51 341 ms |
| CLI warm D: (run 2) | 59 139 ms total | read_mft=53 377 ms |
| Tauri UI C: | **23 320 ms** | almost certainly cold — see analysis below |

#### Critical finding: K-5b Tauri measurement was cold cache

CLI warm C: build_model ≈ 10 000 ms.
Tauri UI C: ≈ 23 320 ms.
Gap ≈ 13 300 ms.

Cold read_mft hypothesis (K-1c, never verified): warm=4 800 ms, cold≈15 000–18 000 ms → delta ≈10 000–13 000 ms.

The 13 300 ms gap matches cold read_mft exactly.
The K-5b Tauri scan was run after two D: CLI scans (which loaded 5 564 MB MFT into
page cache twice), likely evicting C: MFT from RAM. This makes a cold C: MFT scan plausible.

**Warm Tauri UI estimate:**
warm build_model (~10 000 ms) + state_lock (~10 ms) + IPC serialization (~200–500 ms)
≈ **10 200–10 500 ms**

If this estimate holds, warm disk-insight UI ≈ 10–11 s vs WizTree ≈ 15 s.
**disk-insight would be faster than WizTree when cache is warm.**

The HOLD condition "1.55× WizTree" may be entirely a cold-cache phenomenon,
not a structural speed deficit.

#### Candidate comparison

| Candidate | Est. saving (cold) | Est. saving (warm) | Risk | Verdict |
|-----------|-------------------|-------------------|------|---------|
| A: children_map lazy build | ~3.3 s (cold: 23→20 s) | ~3.3 s (warm: 10→7 s) | Medium | Viable, but only worth doing if warm Tauri is also slow |
| B: wof_size_map lazy build | ~0.3 s | ~0.3 s | Low | Negligible gain (~300 ms per build_model) |
| C: read_mft parallel I/O | ~10–13 s cold | ~0 s warm | High | High risk, correct target only if cold is primary cause |
| D: warm Tauri measurement (K-5d) | — | — | None | **Needed before any implementation** |
| E: progress percentage | 0 | 0 | Low | UX only; actual speed unchanged |

#### Recommendation: K-5d before implementation

**Do not implement any optimization yet.**

The key unknown is: **what is warm Tauri UI scan time?**

How to measure (K-5d):
1. Run CLI warm C: scan: `.\target\release\disk-insight.exe --drive C --top 100 --perf-model`
2. Immediately (within 30 s, while C: MFT is in page cache): `npm run tauri dev`, scan C:
3. Record `[perf-ui] invoke_ms` or total perceived scan time

Decision tree:
- **Warm Tauri ≈ 10–12 s**: cold read_mft is the only real problem.
  - Option 1: Accept cold + progress strip (already done). No further optimization.
  - Option 2: children_map lazy build (saves 3 s cold: 23→20 s, still 1.33× WizTree).
- **Warm Tauri ≈ 15–18 s**: Tauri-specific overhead exists.
  - Investigate: IPC JSON size, state_lock, React render time.
- **Warm Tauri > 20 s**: Something unexpected. Full breakdown needed.

#### Why not children_map lazy build immediately?

children_map lazy build saves ~3.3 s at scan time.
But `root_children` (the top-level folder list) is built from `children_map.get(&5)`
at line 3110 of `mft_probe.rs` and included in `JsonTreeOutput`.
The root FRN 5 entry must be available immediately.

A lazy build would require either:
- Keep the full arena in AppState (memory: ~500 MB for C:) and build on-demand
- Background thread build after returning scan result (first `get_children` call may race)
- Build root only (FRN 5) during scan, defer the rest

This complexity is only justified if K-5d confirms warm Tauri is slow.
If warm Tauri is already 10–11 s, lazy children_map would make warm even faster
(~7 s), which is nice but not a HOLD-breaking change.

---

## Constraints

- delete is not implemented and must not be added
- WOF production default, hardlink dedup, WinSxS correction remain unchanged
- reclaimable estimate logic (`compute_reclaimable_summary`) must not be degraded
- unsafe blocks must be minimized and justified
