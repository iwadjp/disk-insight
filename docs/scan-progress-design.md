# Scan Progress Visibility Design (K-2)

Design document for adding scan progress feedback to disk-insight.

No implementation changes in this document — see K-2b/K-2c for implementation.

---

## 1. Current state

| Area | Current behavior |
|------|-----------------|
| UI during scan | "Scanning C:..." banner + spinner |
| Phase visibility | None — single monolithic wait |
| Elapsed time | Not shown during scan |
| Progress bar | Indeterminate spinner only |
| Scan duration (cold C:) | ~20–22 s (estimated from K-1d) |
| Scan duration (warm C:) | ~9.5 s (K-1c measured) |
| Scan duration (D: warm) | ~60–65 s |

WizTree shows a live progress bar during scan. disk-insight currently shows nothing,
so a 20-second wait feels like a hang.

Cold-cache scans (first scan after boot or long idle) are the worst case and the
most common daily-use scenario.

---

## 2. Existing scan phases

From K-1 measurement (`--perf`, `--perf-model`):

| Phase key | Description | C: warm | Share |
|-----------|-------------|---------|-------|
| `open_vol` | Open volume handle + read MFT runlist | ~0 ms | 0% |
| `read_mft` | Read $MFT extents from disk (I/O bound) | ~4 850 ms | 51% |
| `parse` | Rayon parallel record parse | ~460 ms | 5% |
| `tree_build` | Build arena + parent-child links | ~510 ms | 5% |
| `aggregate` | Subtree size rollup (Kahn) | ~170 ms | 2% |
| `children_map` | Build per-directory child lists + path reconstruction | ~3 150 ms | 33% |
| *(implicit)* | Top-N sort + path reconstruction for top dirs/files | ~300 ms | 3% |
| **total** | | **~9 500 ms** | 100% |

Cold-cache estimate (K-1d target):

| Phase | cold | warm |
|-------|------|------|
| `read_mft` | ~15 000–18 000 ms | ~4 850 ms |
| all others | ~5 000 ms | ~5 000 ms |
| **total** | **~20 000–23 000 ms** | **~9 500 ms** |

`read_mft` dominates cold scans (~75%). Showing that it is in progress dramatically
reduces perceived hang time.

---

## 3. Phase labels for the UI

Map internal phase keys to user-visible labels:

| Phase key | User-visible label |
|-----------|-------------------|
| `open_vol` | Opening volume |
| `read_mft` | Reading MFT (I/O) |
| `parse` | Parsing records |
| `tree_build` | Building directory tree |
| `aggregate` | Aggregating sizes |
| `children_map` | Preparing UI model |
| `done` | Rendering results |

The `read_mft` label is intentionally descriptive because it is the long phase.
Showing "Reading MFT (I/O)" for 15+ seconds confirms the scan is running, not hung.

---

## 4. Minimum viable display (K-2b / K-2c)

First implementation targets phase + elapsed only. No percentage.

```
Scanning C:...
Phase: Reading MFT (I/O)       Elapsed: 14.2 s
```

Or as a compact status strip above the summary card:

```
[ ▓▓▓░░░░░░░ ]  Reading MFT (I/O)  14.2 s
```

Requirements:
- Phase label updates at each phase transition
- Elapsed counter ticks every second (or updates on each phase event)
- After scan completes, strip disappears and normal status bar takes over
- No flicker — previous data remains visible during re-scan (already done)
- No percentage shown in first implementation

---

## 5. Percentage feasibility

| Phase | Percentage feasible? | Notes |
|-------|----------------------|-------|
| `open_vol` | No | Instant |
| `read_mft` | **Yes — high value** | MFT total bytes known upfront; bytes-read count possible per extent |
| `parse` | Possible | Record count known; atomic counter per rayon chunk |
| `tree_build` | Hard | Single-threaded, non-uniform |
| `aggregate` | Hard | Kahn traversal |
| `children_map` | Possible | Dir count known; counter per processed dir |
| `done` | No | Near-instant |

`read_mft` is the most valuable because it is the longest phase and total bytes are
known from `get_mft_info` before the loop starts. An extent-level progress counter
(bytes_read / mft_total_bytes) is feasible without major restructuring.

Initial implementation: no percentage. Design hook for later.

---

## 6. Tauri event approach

### Problem

`scan_drive` runs `build_mft_tree_model_with_policy` inside `spawn_blocking`.
That blocking thread cannot directly call `app.emit(...)` unless the app handle
is passed into the closure.

### Recommended approach

Pass `tauri::AppHandle` into `scan_drive` and forward it into a progress callback.

```rust
// src-tauri/src/main.rs

#[tauri::command]
async fn scan_drive(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    drive: String,
    top: Option<usize>,
    storage_policy: Option<String>,
) -> Result<JsonTreeOutput, String> {
    // ...
    let model = tauri::async_runtime::spawn_blocking(move || {
        let progress = |event: ScanProgressEvent| {
            let _ = app.emit("scan_progress", &event);
        };
        build_mft_tree_model_with_policy_progress(drive_char, top_n, policy, progress)
            .map_err(|e| format!("{e:#}"))
    }).await??;
    // ...
}
```

### Alternative: channel-based

The blocking thread sends progress to a `std::sync::mpsc::Sender`; an async task
reads from the receiver and emits Tauri events. More complex, not needed for
initial phase-only events.

### Design constraints

- Emit at most one event per phase transition (7 events per scan)
- Never emit per-record events — that would be millions of emissions
- If percentage is added for `read_mft`, emit per-extent (≤ 30 events for C:)
- Event payload must be `serde::Serialize` + `Clone`
- JSON output (`--json`) and CLI are not affected

---

## 7. Progress event schema

### Rust side

```rust
#[derive(serde::Serialize, Clone)]
pub struct ScanProgressEvent {
    pub drive:      String,
    pub phase:      ScanPhase,
    pub message:    String,
    pub elapsed_ms: u64,
    pub current:    Option<u64>,   // bytes read / records processed
    pub total:      Option<u64>,   // total bytes / total records
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ScanPhase {
    OpeningVolume,
    ReadingMft,
    ParsingRecords,
    BuildingTree,
    AggregatingSizes,
    BuildingUiModel,
    Done,
}
```

### TypeScript side

```ts
type ScanPhase =
  | "opening_volume"
  | "reading_mft"
  | "parsing_records"
  | "building_tree"
  | "aggregating_sizes"
  | "building_ui_model"
  | "done";

type ScanProgressEvent = {
  drive:      string;
  phase:      ScanPhase;
  message:    string;
  elapsed_ms: number;
  current?:   number;
  total?:     number;
};
```

### Tauri listener in UI

```ts
import { listen } from "@tauri-apps/api/event";

// inside App(), alongside the scan:
useEffect(() => {
  const unlisten = listen<ScanProgressEvent>("scan_progress", (event) => {
    setScanProgress(event.payload);
  });
  return () => { unlisten.then(f => f()); };
}, []);
```

---

## 8. UI placement

### Option A: Scan progress strip (recommended)

A slim strip between the toolbar and the main content area.
Visible only while a scan is in progress. Replaces or augments the existing
scanning banner.

```
┌─────────────────────────────────────────────────────┐
│  [toolbar: Scan C: | Top 100 | Load sample]         │
├─────────────────────────────────────────────────────┤
│  ▓▓▓▓▓▓▓░░░░  Reading MFT (I/O)  14.2 s           │  ← progress strip
├─────────────────────────────────────────────────────┤
│  [previous scan data still visible]                 │
│  ...                                                │
```

- Indeterminate animated bar for phases where no percentage is available
- Determinate bar for `read_mft` once percentage is implemented
- Disappears instantly on scan complete (no fade, no "done" linger)
- Does not displace existing content

### Option B: Status bar phase indicator

Add current phase to the existing status bar at the bottom.
Minimal change, but the status bar is below the fold on short windows.

### Option C: Scan button area

Show elapsed time next to the Scan button while scanning. Compact but limited.

**Recommendation: Option A.** Gives the most feedback without covering data.

---

## 9. Implementation roadmap

### K-2b: Minimal phase progress events (Rust + Tauri side)

- Add `ScanProgressEvent` / `ScanPhase` types to `mft_probe.rs`
- Add `build_mft_tree_model_with_policy_progress` variant taking a `FnMut(ScanProgressEvent)`
- Emit at each phase boundary: `opening_volume`, `reading_mft`, `parsing_records`,
  `building_tree`, `aggregating_sizes`, `building_ui_model`, `done`
- Wire `scan_drive` in `src-tauri/src/main.rs` to pass `app.emit` as the callback
- No percentage yet — `current` / `total` are `None`
- Existing `--perf` / `--perf-model` / `--json` / `--diag` paths unchanged

Estimated code impact: ~60 lines in `mft_probe.rs`, ~20 lines in `src-tauri/src/main.rs`.

### K-2c: UI progress strip

- Add `scanProgress` state to `App`
- Register Tauri `scan_progress` event listener
- Render progress strip between toolbar and content area
- Show: phase label + elapsed time (from `elapsed_ms`) + indeterminate bar
- Hide when `scanProgress?.phase === "done"` or `!isLoading`

Estimated code impact: ~60 lines in `main.tsx`, ~20 lines in `styles.css`.

### K-2d: read_mft percentage (optional, later)

If `get_mft_info` already returns total MFT bytes and the read loop can emit
per-extent progress, add `current` / `total` to `reading_mft` events.
Determinate bar for the long phase only.

Not in K-2b/K-2c scope.

### K-2e: daily-use verification

After K-2b + K-2c:
- Cold scan test: does "Reading MFT (I/O) 14s" feel better than blank spinner?
- Warm scan test: does the fast phase flash feel natural or distracting?
- Adjust phase label wording if needed

---

## 10. What is NOT in scope

| Area | Status |
|------|--------|
| Speed optimization | Not in K-2 |
| Parallelization | Not in K-2 |
| Scan cancellation | Not in K-2 |
| Pause / resume | Not in K-2 |
| Detailed per-record UI updates | Never — too expensive |
| Full percentage for all phases | K-2d at earliest |
| Delete action | Permanently deferred |
| WOF normalization | Not in K-2 |
| Hardlink correction | Not in K-2 |
| WinSxS correction | Not in K-2 |

---

## 11. Recommendation

**Start with K-2b + K-2c (phase label + elapsed time, no percentage).**

Rationale:
- Cold-cache scans take 20+ seconds; any visible activity reduces perceived hang
- Phase transitions (7 events) are trivial overhead — no per-record cost
- elapsed_ms from the event is enough to show "14.2 s — Reading MFT (I/O)"
- Percentage for `read_mft` is feasible but adds complexity; defer to K-2d
- K-2e verification can happen without percentage and will tell us if it helps

If K-1d confirms cold cache is the primary cause of the WizTree gap, K-2b/K-2c
directly addresses the second main HOLD reason ("scan 中に進捗が見えない").
