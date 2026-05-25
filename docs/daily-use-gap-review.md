# J-1: Daily-use gap review

**Date**: 2026-05-25  
**Status**: planning document — no source code changes in this phase

---

## Purpose

Compare disk-insight (v0.2.0-treeview-wof) against WizTree as a mental model for
daily disk analysis. Identify the most important gaps before building anything.
The goal of this review is to decide what to build first in v0.3.0-daily-use.

---

## 1. Current disk-insight strengths

| Strength | Notes |
|----------|-------|
| Delete-free | Impossible to accidentally delete while browsing |
| MFT scan speed | Direct MFT read; typical C: drive scans in 5–11 s |
| TreeView navigation | Lazy `get_children` expansion; can drill down to any folder |
| Explorer integration | Open folder, Select file, Copy path |
| WOF adjusted | Experimental `--wof-adjusted` CLI/JSON; UI policy selector |
| Drive selector | Auto-detects logical drives via `GetLogicalDrives` |
| Safety guards | Large folder warning, per-node errors, duplicate request guard |
| Flat render | `visibleRows` flat list is already virtual-scroll-ready |

---

## 2. Current daily-use gaps

### Gap A — Right pane is a filtered global top-N slice, not a folder children view (CRITICAL)

**This is the most important gap.**

When the user selects a folder in the TreeView, the right pane shows:

```
filterByDir(top_directories, selectedDir.path)   ← prefix filter over global top-N
filterByDir(top_files, selectedDir.path)          ← same
```

This means: the right pane only shows entries that were already in the global
top-100 (or top-N) scan and happen to live under the selected folder's path.

**Consequence**: if you select `C:\Users\iwadj\Downloads` and there are 500 MB of
files there, but none of them made the global top-100, the right pane shows nothing.
You can see the folder's total size in the TreeView, but you cannot see what is
inside it from the right pane.

**WizTree comparison**: clicking a folder in WizTree immediately shows all direct
children (subfolders and files) sorted by size. This is the core browsing workflow
and it works at any level of nesting.

**Why it matters**: most disk cleanup decisions happen at the "what's big in
*this specific folder*" level, not the global top-100 level. Without a folder
children view, disk-insight cannot support the basic cleanup workflow.

### Gap B — No file search or name filter (HIGH)

WizTree has a search box that filters the visible tree and file list by name.
disk-insight has no search or filter capability.

For users who remember "I think there was a big .iso somewhere in AppData",
this is a blocker.

### Gap C — No column sort in right pane (MEDIUM)

Top directories and top files are displayed in scan-result order (size descending).
There is no way to sort by name, extension, or file count. WizTree lets users
sort any column interactively.

### Gap D — No session persistence (MEDIUM)

Between launches, disk-insight forgets:
- last selected drive
- last top-N value
- last storage policy

WizTree remembers these. For daily use, having to re-enter drive and top-N on
every launch is friction.

### Gap E — TreeView does not retain expansion state across rescans (MEDIUM)

If you have navigated deep into a folder tree and click "Scan" again to refresh
data, the TreeView resets to root. WizTree preserves the expansion state and
scrolls back to the same folder after a rescan.

### Gap F — No keyboard navigation in TreeView (LOW-MEDIUM)

Arrow keys do not expand/collapse/select nodes. For power users who want
keyboard-driven navigation, this is a gap.

### Gap G — WOF adjusted vs Current difference is not explained in the UI (LOW)

The "WOF adjusted (experimental)" label requires the user to read docs to
understand what it means. For daily use by the author, this is acceptable; it
becomes a gap only if the app is shared.

### Gap H — No Treemap (LOW for daily use)

WizTree's treemap gives a proportional overview of disk usage. It is useful
for a first-glance overview but is not required for the core "drill down and
identify large files" workflow.

### Gap I — Virtual scroll not implemented (LOW for current scale)

With the `visibleRows` flat render, the TreeView is already more efficient than
the recursive version. For typical C: drive usage patterns (expand a few
folders at a time), this is not a blocking concern yet. It becomes important
when expanding `node_modules` or similar fan-out directories.

### Gap J — delete, WinSxS/hardlink correction, drive NTFS detection (explicitly deferred)

These are known gaps, intentionally not implemented.

---

## 3. Root cause of Gap A: architecture review

From `docs/treeview-performance-plan.md`, Section 1:

> **Right-pane integration**: `selectedDir` filters the existing `top_directories`
> and `top_files` lists via `filterByDir(items, selectedDir.path)`.
> **The right pane uses `top_directories` / `top_files`, not `childrenByParent`
> — they are independent data paths.**

This confirms the structural cause. The data needed for a proper folder children
view is already in memory — `childrenByParent` (built by `get_children` as the
user expands the TreeView) contains all children for expanded folders. But the
right pane does not use it.

Additionally, the Tauri `children_map` (populated once per scan and stored in
`AppState`) already holds the complete `HashMap<u64, Vec<JsonTreeNode>>` for all
directories. A `get_folder_detail(record_index)` command to fetch direct children
for the selected folder would be trivial to add.

**The right pane needs to show direct children of the selected folder, sorted by
size, rather than a global-top-N prefix filter.**

---

## 4. Recommended v0.3.0 task order

Priority is based on impact on "can replace WizTree for basic disk analysis".

### J-2 (highest priority): Selected folder detail panel

Replace the current global-top-N prefix filter with a direct children view for
the selected folder.

**What to show when a folder is selected**:
- Direct subdirectory children, sorted by subtree size desc
- Direct file children, sorted by allocated size desc
- Count of children (folders / files)
- Total size of direct children

**Data source**: `childrenByParent[selectedDir.record_index]` is already available
for expanded folders. For unexpanded folders, a new Tauri command
`get_folder_detail(record_index)` can return direct children from `children_map`
without requiring the user to expand the TreeView first.

**Scope guard**: do not implement pagination in this phase; show all direct children
(the same approach as `get_children` today).

### J-3: Column sorting in the detail panel

Sort the children view by size (default), name, or file count.
This is a frontend-only change once J-2 is implemented.

### J-4: Session preferences

Persist last drive, top-N, and storage policy using `localStorage` (Tauri
exposes `window.localStorage` on WebView2).

On startup, restore the last drive if it is still available in the `list_drives()`
result.

### J-5: Search / path filter (scoped)

Add a text input that filters the top-files list by filename substring.
Scope to the currently loaded scan result (no re-scan).

Full tree search is a larger feature; the top-files filter is the minimum
useful version.

### J-6: Daily-use verification

After J-2 through J-5 are implemented:
- Use disk-insight exclusively for disk analysis for one week
- Record any remaining friction points
- Decide whether v0.3.0 milestone is PASS or needs more work

---

## 5. Must not do yet

| Item | Reason |
|------|--------|
| Delete action | Safety design and confirmation UI required — intentionally deferred |
| GitHub public release | Deferred until daily-use PASS |
| Hardlink / component-store correction | Separate research track |
| WinSxS correction | Separate research track |
| Virtual scroll full implementation | Not yet the bottleneck; J-2 first |
| Treemap | Low priority for core workflow |
| WOF adjusted as default | Policy decision deferred |

---

## 6. User checklist (real-device comparison)

Perform the following with both WizTree and disk-insight side by side.

### Setup

- [ ] Open WizTree, scan C:, let it complete
- [ ] Open disk-insight (as Administrator), scan C: with Current policy, let it complete

### Core workflow: find large files in a specific folder

- [ ] Navigate to `C:\Users\<your-name>\Downloads` in WizTree — note how many items are shown and their sizes
- [ ] Navigate to `C:\Users\<your-name>\Downloads` in disk-insight — note what the right pane shows
- [ ] Assess: does disk-insight show you what is taking space in Downloads?

- [ ] Navigate to `C:\Users\<your-name>\AppData` in WizTree — drill down to find the largest child folder
- [ ] Navigate to `C:\Users\<your-name>\AppData` in disk-insight — attempt the same
- [ ] Note: how many clicks does each tool require to reach the answer?

### Large folders

- [ ] In WizTree, find the top 5 folders under `C:\Program Files` by size
- [ ] In disk-insight, select `C:\Program Files` in the TreeView — does the right pane show the top 5 child folders?
- [ ] Note any discrepancies

### Search

- [ ] In WizTree, search for "*.iso" or a large file you know exists
- [ ] In disk-insight, attempt the same — note the result

### Sorting

- [ ] In WizTree, sort the file list by name, then by size
- [ ] In disk-insight, attempt the same

### WOF adjusted (disk-insight only)

- [ ] Scan C: with WOF adjusted policy
- [ ] Compare the C: total with WizTree's allocated total
- [ ] Note the delta and whether the WOF explanation makes sense

### Open / select actions

- [ ] In both tools, open a folder in Explorer from the result list
- [ ] In both tools, select a specific file in Explorer
- [ ] Note which is faster or more convenient

### Summary questions to answer

- [ ] What was disk-insight better at than WizTree?
- [ ] What did WizTree do that disk-insight couldn't?
- [ ] What was the single most frustrating moment with disk-insight?
- [ ] Did disk-insight's right pane ever show you what you needed when you clicked a folder?

---

## 8. J-2 implementation result (2026-05-25)

J-2 Selected folder direct children panel is implemented and built.

`DirectChildrenPanel` was added to the right pane. When a folder is selected in
the TreeView, the panel fetches its direct children via the existing `get_children`
Tauri command (backed by the in-memory `children_map`). The result is displayed as
a sorted list (directories first, then size descending) with DIR/FILE badges and
Open folder / Select file / Copy path actions per row.

The `childrenByParent` cache is shared between the TreeView and the panel, so
expanding a folder in the TreeView and then selecting it (or vice versa) avoids a
redundant fetch.

Gap A is addressed: selecting `C:\Users\iwadj` now shows AppData, Desktop,
Downloads, and other direct children with their sizes, without needing any of them
to be in the global top-N scan results.

The existing top directories / top files tables are retained with their titles
updated to "Top directories (scan results) under …" and "Top files (scan results)
under …" to clarify the distinction.

J-3 (2026-05-25) adds sort controls to the direct children panel. Children can
now be sorted by Size, Name, or Type with ascending/descending toggle. Initial
state is Size ↓ (directory-first, size descending), preserving the existing
default view. The sort preference is kept locally in the panel so it persists
as the user navigates between folders.

J-2b (2026-05-25) adds DIR row click navigation to the direct children panel.
Clicking a directory row in the panel now sets it as the selected folder and
refreshes the panel with that folder's children. Combined with J-2, the user
can drill down through the hierarchy from the right pane, matching the core
WizTree browsing workflow without needing to use the TreeView for every step.

J-4 (2026-05-25) adds session preferences via `localStorage`. On next launch,
disk-insight restores the last selected drive (validated against detected drives),
top-N count, storage policy, and direct-children sort key/direction. The sort
state was lifted from `DirectChildrenPanel` local state to `App` to enable
cross-session persistence.

J-5b (2026-05-25) adds a Parent navigation row to the top of the Direct children
panel. When a non-root folder is selected, a `.. Parent: C:\Users` row appears above
the children list. Clicking it sets the parent as the selected folder, mirroring
the J-2b downward navigation. Parent lookup searches `rootChildren` and
`childrenByParent` cache; if the parent node is not found, the row is omitted.
Direct children panel から親へ戻れるようになり、右ペインの探索導線が改善した。

J-5 (2026-05-25) adds a name/path filter to the Direct children panel. Typing in
the filter box performs case-insensitive partial match against `node.name` and
`node.path`, narrowing a large folder's children list instantly (e.g. `app` →
AppData, `.gradle` → .gradle). Filter is applied before sort, resets on folder
navigation, and is not persisted across sessions. Direct children が多いフォルダで
目的項目を探しやすくなった。v0.3.0 daily-use に向けた軽量検索の第一歩。

---

## 9. Decision (current assessment)

### v0.3.0 primary focus

**Selected folder detail / right pane usability (J-2) is the highest priority.**

The current right pane is fundamentally limited for daily use because it shows
filtered slices of global top-N results rather than the folder's actual contents.
This is the most likely reason disk-insight does not feel usable as a WizTree
replacement.

The fix is well-defined and the data is already in memory — `children_map` on
the Rust side and `childrenByParent` on the frontend. J-2 is primarily a UI
and Tauri command addition, not a new data collection.

### GitHub public release

Deferred until the author can confirm the v0.3.0-daily-use milestone passes.
The app is functional but not yet at a level of polish that would be useful to
others without context.

### Delete action

Remains out of scope. Daily-use verification must happen before introducing any
destructive operation, and even then a full safety design (confirmation dialog,
recycle bin routing, undo) is required.

### Accuracy work

WOF adjusted experimental mode is available. Further accuracy work (WinSxS,
hardlink dedup, cluster-level accounting) is deferred — it is a separate track
from usability and is not on the v0.3.0 critical path.

---

## 10. J-6: Daily-use milestone judgment (2026-05-25)

### Verdict: HOLD（当初 PASS → ユーザー評価で修正）

UI 導線は J-2〜J-5b で大きく改善した。しかし、WizTree 代替として daily-use PASS とするには
速度・進捗表示・サイズ精度に不満が残る。

### What improved vs. the J-1 baseline

| Gap (J-1) | Status |
|-----------|--------|
| Gap A — right pane showed global top-N only | **Resolved** (J-2 + J-2b + J-5b) |
| Gap C — no sort in right pane | **Resolved** (J-3) |
| Gap D — no session persistence | **Resolved** (J-4) |
| Gap B — no name filter | **Partially resolved** (J-5: direct children filter) |

### HOLD 理由（新規）

#### 1. Scan speed gap

実測値（2026-05-25）:

| ツール | C: | D: |
|--------|-----|-----|
| WizTree | 約 15s | 約 51s |
| disk-insight | 約 24s | 約 81s |

disk-insight は WizTree より体感で明確に遅い。

#### 2. Scan progress visibility

WizTree は scan 中に進捗が見える。disk-insight は何も表示されず、待ち時間の不安につながる。
遅さがさらに目立つ。

#### 3. Size accuracy

WOF adjusted は改善したが、Explorer / WizTree との差をまだ完全に説明しきれていない。
WinSxS / hardlink / component-store accounting は未解決の既知制約。

### Remaining gaps vs. WizTree（更新）

| Gap | Severity |
|-----|----------|
| Scan speed: disk-insight C: 24s vs WizTree C: 15s | **High** — 日常利用の選択に影響 |
| No scan progress display | **High** — 遅さの体感増幅 |
| Size accuracy / Explorer alignment | **Medium** |
| TreeView does not auto-follow right-pane navigation | Low |
| No keyboard navigation | Low |
| Global full search | Medium |
| Virtual scroll | Low — not yet a bottleneck |

---

## 11. K-1: Scan performance baseline（2026-05-25）

`--perf` フラグを追加し、フェーズ別タイミングを stderr に出力するよう実装した。

### K-1 計測結果（warm cache, `--json --perf`）

| drive | policy | open_vol | read_mft | parse | tree_build | agg | total |
|-------|--------|----------|----------|-------|------------|-----|-------|
| C: | current | 0 ms | 4854 ms | 451 ms | 496 ms | 166 ms | 9444 ms |
| C: | wof_adjusted | 0 ms | 4815 ms | 457 ms | 493 ms | 162 ms | 9405 ms |
| D: | current | 0 ms | 47833 ms | 6619 ms | 503 ms | 99 ms | 65210 ms |
| D: | wof_adjusted | 0 ms | 52620 ms | 3893 ms | 549 ms | 102 ms | 59920 ms |

`total` と phase 合計の差 = path reconstruction + children_map:
- C: ≈3477ms (37%)
- D: ≈10156ms (15%)

### ボトルネック分析

| フェーズ | C: 割合 | D: 割合 | 備考 |
|----------|---------|---------|------|
| read_mft (I/O) | 51% | 73% | ドライブ規模に比例。cold では支配的 |
| path reconstruction + children_map | 37% | 15% | 固定コスト的。O(n nodes) の path walk |
| parse (rayon) | 5% | 10% | 並列化済み |
| tree_build | 5% | <1% | 小さい |
| aggregate | 2% | <1% | 小さい |

### J-6 実測 (24s/81s) との差異

J-6 の 24s は Tauri UI での cold cache 計測、K-1 の 9.4s は CLI での warm cache 計測と推定。
cold cache では read_mft (I/O) が大幅に増加する。K-1b でギャップの詳細を計測する。

---

## 12. K-1b: Tauri UI end-to-end timing（2026-05-25 実装済み）

### 目的

CLI warm cache 9.4s と Tauri UI 約25s のギャップ (~15s) の内訳を把握する。

### 実装

`[perf-tauri]` ログを `scan_drive` コマンドに追加:
- `scan_drive start`, `build_model done`, `state_lock`, `scan_drive return`

`[perf-ui]` ログを `main.tsx` に追加:
- `scan click`, `invoke start`, `invoke resolved (invoke_ms)`, `setData called`
- `data rendered (rAF)`, `data rendered (rAF+1)`, `direct children ready`

### 実測値（K-1b, C: current）

```text
[perf-tauri] build_model done  22,757 ms
[perf-tauri] scan_drive return  total=22,758 ms

[perf-ui] invoke resolved  t+22,767 ms  invoke_ms=22,767
[perf-ui] data rendered (rAF)  t+23,103 ms
[perf-ui] direct children ready  t+23,115 ms
```

### 判明したこと

- **React描画 ≈ 300ms（主因ではない）**
- **build_model が全体の 22.8s / 22.8s — ここが主因**
- cold cache vs warm cache の差の可能性あり（K-1c で検証）

---

## 13. K-1c: CLI model path vs Tauri model path comparison（2026-05-25 実装済み・実測完了）

### 目的

「Tauri が毎回 22.8s かかる」のが、CLI output path vs model path の差なのか、
それとも I/O キャッシュ状態の差なのかを切り分ける。

### 疑い

- CLI `--perf` は `build_mft_tree_output_with_policy` 経由
- Tauri は `build_mft_tree_model_with_policy` 経由（children_map 全件構築を含む）
- CLI 9.4s に children_map が含まれていない可能性 → `--perf-model` で確認

### 実装

- `JsonSummary` に `children_map_time_ms` フィールド追加
- `build_mft_tree_model_with_policy` 内で children_map 構築時間を計測
- `pub fn print_perf_model_with_policy` 追加（`--perf-model` フラグ経由）

### 実測結果（C: warm cache）

| 計測 | build_model | read_mft | parse | tree_build | agg | children_map | total |
|------|-------------|----------|-------|------------|-----|--------------|-------|
| CLI `--perf` (C: current) | — | 4842 ms | 450 ms | 509 ms | 170 ms | 3145 ms | 9441 ms |
| CLI `--perf-model` (C: current) | 9827 ms | 4871 ms | 462 ms | 511 ms | 173 ms | 3169 ms | 9519 ms |
| CLI `--perf-model` (C: wof_adjusted) | 9772 ms | 4835 ms | 469 ms | 498 ms | 167 ms | 3150 ms | 9460 ms |
| Tauri `[perf-tauri]` (K-1b) | 22,757 ms | — | — | — | — | — | — |

children_map stats: keys=358,622 dirs、total_children=1,756,339

### 判定

**B: CLI `--perf-model` ≈ CLI `--perf` ≈ 9.5s。Tauri 22.8s との差 (~13s) は Tauri 固有要因（cold cache）。**

- CLI output path と model path はほぼ同じ（children_map は既に両方に含まれていた）
- children_map 3.1s は total の 33%（ボトルネックではある）
- **主因: Tauri K-1b 測定時は C: MFT が OS page cache にない（cold state）**
- cold read_mft 推定: warm 4.8s × 3〜4 ≈ 15〜18s
- 22.8s ≈ cold read_mft (15-18s) + その他フェーズ (5s) と整合

### 検証方法

再起動直後の cold state で以下を実行し、read_mft が 15-18s になれば確定:

```powershell
.\target\release\disk-insight.exe --drive C --top 100 --perf-model
```

### 次のアクション

- **K-1d（オプション）**: cold state での `--perf-model` 実測で仮説確定
- **K-2**: scan progress visibility design（cold state でも何かが見えるようにする）

### タグ候補

`v0.3.0-daily-use` — **保留**。K-2 → K-3 → K-4 で再判定する。

### GitHub public release

引き続き延期。daily-use PASS が安定してから再判断する。

### Delete action

引き続き後回し。削除なしは機能であり、制約ではない。
