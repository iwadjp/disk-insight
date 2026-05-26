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

## 10.5. Daily-use PASS 基準の修正（2026-05-26）

J-6 HOLD 後、daily-use milestone の意味を明確に修正した。

### 修正の背景

J-6 HOLD 理由（speed / progress / size accuracy）を見て、
「WizTree より遅いが自分で作ったから我慢して使う」では PASS とすべきでない、という判断に至った。

### 修正後の PASS 基準

disk-insight は WizTree の劣化コピーを目指さない。

PASS には「この用途なら disk-insight を選びたい」と思える固有価値が必要。

**現在の固有価値候補:**

| 価値 | 内容 |
|------|------|
| delete-free 安全性 | 誤削除リスクがない状態で調査・判断できる |
| WOF adjusted 比較 | current / WOF adjusted を切り替えてサイズ差を確認できる |
| Direct children navigation | selected folder の直下を filter / sort / 掘り下げできる |
| Explorer integration | Open folder / Select file / Copy path が自然に使える |
| サイズ差の調査 | WOF / WinSxS / hardlink など差の理由を追える診断 CLI がある |

**現在の未達点（K フェーズで対応中）:**

| 未達点 | 対応 |
|--------|------|
| scan speed gap | K-1 で原因把握済み。cold cache が主因（改善は後フェーズ） |
| progress visibility | K-2/K-2b で phase 表示・fallback timer を実装。K-2c で polish |
| size accuracy / explanation | K-3 で対応予定 |

### K フェーズの位置づけ

K フェーズは「WizTree に追いつくため」ではなく、「disk-insight を選ぶ理由を作るため」の作業。

- K-2c progress strip polish → scan 中の不安を除去する（HOLD 条件の解消）
- K-3 size accuracy review → サイズ表示の信頼性を上げる（HOLD 条件の解消）
- K-4 daily-use retry → 固有価値が HOLD 条件を上回っているか再判定

### 判定

**v0.3.0-daily-use: HOLD 継続**

K-2c / K-3 / K-4 を経て再判定する。

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

- **K-1d**: cold state での `--perf-model` 実測で仮説確定 → 下記 Section 14 参照
- **K-2**: scan progress visibility design（cold state でも何かが見えるようにする）

---

## 14. K-1d: cold cache validation（計測待ち）

### 仮説

Tauri build_model 22.8s = cold read_mft (~15-18s) + その他 (~5s)

daily-use での体感スキャン時間が遅いのは、起動直後または長時間アイドル後に
C: の MFT が OS page cache にない（cold state）ためと推定される。

### 計測手順

```powershell
# 1. Windows 再起動後、他の disk scan を実行しない
# 2. 管理者 PowerShell で実行（間を置かず連続実行）

.\target\release\disk-insight.exe --drive C --top 100 --perf-model   # cold 1回目
.\target\release\disk-insight.exe --drive C --top 100 --perf-model   # warm 2回目
```

### 期待結果

| 計測 | read_mft | children_map | total | 判定 |
|------|----------|--------------|-------|------|
| cold 1回目 | 15–18 s | ~3.1 s | ~20–22 s | cold cache が主因 |
| warm 2回目 | ~4.8 s | ~3.1 s | ~9.5 s | warm = K-1c と一致 |

### 実測値（計測後に記入）

```text
cold 1回目:
  read_mft:      _____ ms
  children_map:  _____ ms
  total:         _____ ms

warm 2回目:
  read_mft:      _____ ms
  children_map:  _____ ms
  total:         _____ ms
```

### daily-use への含意

cold scan が ~20s なら scan speed gap（WizTree 15s vs disk-insight 24s）の主因は
cold I/O であり、アルゴリズム改善より **progress visibility** の体感改善が優先される。
→ K-2 progress visibility design へ

### daily-use との関係

J-6 HOLD の主要不満のひとつが「scan 中に進捗が見えない」。
cold scan で 20 秒以上かかる場合、blank spinner だけでは hang と区別できない。
K-2 progress visibility はこの不満に直接対応する。

---

## 15. K-2: Scan progress visibility design（2026-05-26 設計完了、実装未）

設計文書: `docs/scan-progress-design.md`

### 現状の不満（J-6 HOLD 理由より）

- disk-insight scan 中: "Scanning…" spinner のみ
- cold C: scan: ~20–22 s（推定）、warm: ~9.5 s
- cold D: scan: ~60–65 s（推定）
- 何も動かないように見えるため、hang との区別がつかない

### 設計方針

**最初は percentage なし。phase label + elapsed time のみ。**

| phase | 表示ラベル | cold C: 目安 |
|-------|-----------|-------------|
| `open_vol` | Opening volume | 即座 |
| `read_mft` | Reading MFT (I/O) | ~15–18 s |
| `parse` | Parsing records | ~0.5 s |
| `tree_build` | Building directory tree | ~0.5 s |
| `aggregate` | Aggregating sizes | ~0.2 s |
| `children_map` | Preparing UI model | ~3.1 s |
| `done` | Rendering results | 即座 |

「Reading MFT (I/O)  14.2 s」が表示されれば hang ではないと分かる。

### UI: progress strip

toolbar と content の間に slim strip。phase + elapsed + indeterminate bar。
scan 完了で即非表示。既存データは下に残す。

### Tauri event 設計

- `scan_drive` に `app: AppHandle` を追加
- `spawn_blocking` クロージャ内から phase 遷移ごとに `app.emit("scan_progress", ...)`
- 1 scan あたり最大 7 events（per-record emit なし）
- JSON / CLI / `--perf` / `--diag` には影響なし

### 実装候補

| ステップ | 内容 |
|---------|------|
| K-2b | Rust + Tauri: `ScanProgressEvent` 型・emit hook | **DONE 2026-05-26** |
| K-2c | UI: progress strip + Tauri event listener | (K-2b で scanning banner に統合済み) |
| K-2d | `read_mft` percentage（MFT bytes ベース、オプション） |
| K-2e | cold scan 体感確認 |

### やらないこと

- 速度最適化
- scan cancellation
- per-record 進捗
- delete
- WOF / hardlink / WinSxS 補正

### タグ候補

`v0.3.0-daily-use` — **保留**。K-2b/K-2c → K-3 → K-4 で再判定する。

### GitHub public release

引き続き延期。daily-use PASS が安定してから再判断する。

### Delete action

引き続き後回し。削除なしは機能であり、制約ではない。

---

## 16. K-3: Size accuracy review — DONE (2026-05-26)

詳細ドキュメント: `docs/size-accuracy-review.md`

### 方針

「Explorer / WizTree と完全一致させる」ではなく、
「**違う理由が説明できる**」状態を目標とした。

### current / wof_adjusted の役割整理

| Policy | 何を見るか | 主な特性 |
|--------|-----------|---------|
| `current` | NTFS allocated size（projected view） | シンプル・保守的・通常ファイルで Explorer に一致 |
| `wof_adjusted` | WOF ファイルは WofCompressedData stream alloc | WizTree に近い。Program Files はほぼ一致 |

C: ドライブ比較（2026-05-25 実測）:

| Policy | C: total | WizTree | 差 |
|--------|--------:|--------:|---:|
| current | 186.5 GB | 174.9 GB | +11.6 GB |
| wof_adjusted | 170.6 GB | 174.9 GB | −4.3 GB |

差の原因:
- `current` 超過分: WOF 圧縮ファイル（Edge・Office・Windows コンポーネント）
- `wof_adjusted` 不足分: component-store / hardlink 残差

### WinSxS / hardlink は引き続き既知制約

WinSxS は WOF 補正後も 8.7 GB（WizTree 4.1 GB）— 4.6 GB 残差。
WinSxS に `link_count > 1` レコードが 70,912 件存在。
hardlink dedup は未実装のため WinSxS は参考値扱い。

### daily-use 向け信頼性整理

| 用途 | 信頼性 |
|------|--------|
| top-N ランキング | 高 — 相対順序は正確 |
| C:\Users（ユーザーデータ） | 高 — 両 policy で WizTree ±0.4 GB 以内 |
| C:\Program Files（wof_adjusted） | 高 — WizTree ±0.2 GB 以内 |
| C:\Windows\WinSxS | 低 — hardlink 未補正・参考値 |

### 判定

**K-3: DONE。** size accuracy の "unexplained" → "explained" 移行完了。

- `current` / `wof_adjusted` の意味が整理された
- WinSxS は既知制約として文書化された
- 「なぜ違うか」が説明できる状態になった
- WOF / hardlink / WinSxS 本番補正は引き続き後回し

**次: K-4 daily-use 再判定。**

---

## 17. K-4: Daily-use retry checklist — DONE (2026-05-26)

詳細: `docs/daily-use-retry-checklist.md`

### 方針

実判定はユーザー実機評価で行う。今回は判定そのものではなく、
「感覚ではなくチェックリストに沿って評価できる状態」を整えた。

### 評価の軸

| 軸 | 確認内容 |
|----|---------|
| scan speed / progress | WizTree との速度差・progress strip の効果 |
| navigation | Direct children drill-down / filter / sort / actions |
| size meaning | current / wof_adjusted の意味・WinSxS 制約の納得感 |
| 固有価値 | delete-free / WOF 比較 / Explorer 連携 など |

### PASS / HOLD 基準（再掲）

**PASS**（すべて満たす）:
- disk-insight を選びたいと思える用途が少なくとも1つある
- scan 中の不安が許容範囲（progress strip が機能している）
- サイズ表示の意味が理解できる
- 目的フォルダに自然に辿れる（3〜5クリック以内）
- delete なしが制約ではなく価値として成立している

**HOLD**（いずれか1つでも当てはまる）:
- WizTree がすべての面で単純に優れており disk-insight を選ぶ理由がない
- scan が遅すぎて調査ワークフローが成立しない
- サイズ表示が依然として混乱する
- 目的フォルダへの操作が重い

### 判定待ち

実機評価は未実施。次回評価時に `docs/daily-use-retry-checklist.md` を使用する。

評価結果はこのセクション（またはセクション 18 として）に追記する。

**v0.3.0-daily-use: 引き続き HOLD（実機再評価待ち）**

---

## 18. K-3b: Size discrepancy investigation — DONE (2026-05-26)

詳細: `docs/size-discrepancy-investigation.md`

### K-3b の位置づけ

K-4 の実機評価を経て、v0.3.0-daily-use HOLD の**主因がサイズ信頼性**であることが明確になった。

> Explorer と WizTree が同じ値を示すのに、disk-insight だけ違う。
> この理由が説明できないため、disk-insight の数値を信頼しにくい。

K-3b はこの具体的差分の原因調査。

### 判明した根本原因

**Case A WOF behavior**: `current` policy は WOF 圧縮ファイルの
NTFS $DATA projected allocation（非圧縮サイズ）を使う。
Explorer / WizTree は WOF-aware API 経由で圧縮後サイズを返す。

これが「disk-insight current > Explorer "Size on disk" ≈ WizTree Allocated」の主因。

### 比較表（既存実測値 + 仮説）

| パス | WizTree Allocated | disk-insight current | disk-insight wof_adjusted |
|------|------------------:|--------------------:|-------------------------:|
| C:\ | 174.9 GB | 186.5 GB | 170.6 GB |
| Program Files (x86) | 7.8 GB | 10.1 GB | 8.3 GB |
| Program Files | 24.6 GB | 29.7 GB | 24.8 GB |
| Windows | 16.1 GB | 27.1 GB | 18.4 GB |
| WinSxS | 4.1 GB | 11.5 GB | 8.7 GB |
| Users | 85.2 GB | 85.0 GB | 84.8 GB |

C:\Users: 全ツール一致 → WOF / hardlink の問題でないことを確認（対照群）

### 信頼性の現状

| 用途 | 信頼性 | 理由 |
|------|--------|------|
| top-N ランキング | 高 | 相対サイズは正確 |
| C:\Users | 高 | 全ツール一致 |
| Program Files (wof_adjusted) | 高 | WizTree ±0.2 GB |
| Program Files (current) | 低〜中 | WOF Case A で大きめ |
| WinSxS | 低 | WOF + hardlink 両方 |

### 未解決（M-1）

「Explorer 11.0 GB」（PFx86）は Explorer **"Size"**（論理サイズ）の疑いあり。
Explorer "Size on disk" の明示的計測なしには「Explorer = WizTree ≠ disk-insight」
という主張が未検証。

### HOLD 理由との対応

| HOLD 理由 | K-3b での扱い |
|-----------|-------------|
| サイズ差の理由が説明できない | 主因（Case A WOF）を特定・文書化 |
| Explorer = WizTree の確認 | 未達（M-1 実測が必要） |
| 集計バグの可能性 | 低確度だが排除できていない（C:\Users 一致で低減） |

**v0.3.0-daily-use: HOLD** — M-1 実測が次ステップ。実測後に信頼度を再評価する。

---

## 19. M-1: Explorer Size on disk manual measurement — PARTIAL RECORDED (2026-05-26)

詳細: `docs/size-discrepancy-investigation.md` §M-1

### 目的

v0.3.0-daily-use HOLD の主因「サイズ信頼性」を解消するため、
Explorer / WizTree / disk-insight の値を明示的に取り直し、比較する。

特に「Explorer Size」と「Explorer Size on disk」の混同を排除する。

### 混同を避けるためのメトリクス対応表

| 正しい比較ペア | ×NG な比較 |
|---------------|-----------|
| Explorer **Size on disk** ↔ WizTree **Allocated** ↔ di subtree_size | Explorer Size ↔ WizTree Allocated |
| Explorer **Size** ↔ WizTree **Size** | Explorer Size on disk ↔ WizTree Size |

### 現時点の既知値（参照用）

| パス | WizTree Alloc | di current | di wof_adj | Explorer SoD |
|------|-------------:|-----------:|-----------:|------------:|
| C:\Program Files (x86) | 7.8 GB | 10.1 GB | 8.251 GB | 11.0 GB |
| C:\Program Files | 24.6 GB | 29.7 GB | 24.8 GB | 19.5 GB |
| C:\Windows | 15.5 GB | 26.7 GB | 18.4 GB (prior diag) | 17.7 GB |
| C:\Users | 85.6 GB | 85.4 GB | TBD | 86.6 GB |

**PFx86 Explorer SoD = 11.0 GB**。PFx86 は Case 3 + residual deltas。
**Program Files Explorer SoD = 19.5 GB**。Program Files は Explorer divergence case。
**Users Explorer SoD = 86.6 GB**。Users は Alignment case。
**Windows Explorer SoD = 17.7 GB**。Windows は Windows special accounting case。

### 判定後の含意

| M-1 結果 | サイズ信頼性への影響 |
|---------|-------------------|
| Case 1 確認（WOF Case A） | wof_adjusted が Explorer/WizTree に近い根拠が確定。信頼度向上 |
| Case 3 確認（メトリクス混同） | 「Explorer ≈ WizTree 不一致」の誤認が解消。現状理解が改善 |
| Case 2（WOF 以外の原因） | 追加調査が必要。HOLD 継続 |

### 測定手順の概要

1. Explorer: 対象フォルダ右クリック → プロパティ → 計算完了後に **Size と Size on disk の両方** を記録
2. WizTree: **Allocated 列**を記録（Size と間違えない）
3. disk-insight: current と wof_adjusted それぞれで Scan → 選択フォルダカードの subtree_size を記録

詳細手順: `docs/size-discrepancy-investigation.md` §M-1c

**v0.3.0-daily-use: HOLD** — 主要4パスは Section 20-23 に結果を追記済み。

---

## 20. M-1 PFx86 Explorer measurement result — RECORDED (2026-05-26)

Details: `docs/size-discrepancy-investigation.md` §M-1

### Measurement

`C:\Program Files (x86)` Explorer Properties:

| Metric | Value |
|--------|------:|
| Explorer Size | 15.2 GB / 16,342,637,554 bytes |
| Explorer Size on disk | 11.0 GB / 11,882,143,744 bytes |
| WizTree Size | ~15.2 GB |
| WizTree Allocated | ~7.8 GB |
| disk-insight current | ~10.1 GB |
| disk-insight wof_adjusted | ~8.251 GB |

### Interpretation

PFx86 is primarily **Case 3 + residual differences remain**.

The size-confidence issue is not only a possible calculation error. A major
part of the confusion is that the UI does not yet make it obvious which size
metric is being compared:

- Explorer Size and WizTree Size align around 15.2 GB.
- disk-insight `current` and `wof_adjusted` are allocated-style metrics and
  should not be directly compared with Explorer Size.
- Explorer Size on disk is 11.0 GB, not 7-8 GB.
- `wof_adjusted` remains closer to WizTree Allocated, but residual deltas still
  need investigation before claiming accuracy.

**v0.3.0-daily-use: HOLD continues.** The next trust improvement should be
clearer size labels / help text, or continued M-1 measurement for Windows.

---

## 21. M-1 Program Files measurement result — RECORDED (2026-05-26)

Details: `docs/size-discrepancy-investigation.md` §M-1

### Measurement

`C:\Program Files`:

| Metric | Value |
|--------|------:|
| Explorer Size | 19.6 GB / 21,124,549,940 bytes |
| Explorer Size on disk | 19.5 GB / 20,973,977,600 bytes |
| Explorer files / folders | 49,652 / 6,394 |
| WizTree Size | 30.6 GB |
| WizTree Allocated | 24.6 GB |
| WizTree files / folders | 86,577 / 12,250 |
| disk-insight current | ~29.7 GB |
| disk-insight wof_adjusted | ~24.8 GB |

### Interpretation

Program Files is not the same pattern as PFx86.

- PFx86 primarily exposed a Size vs allocated-style metric mix-up.
- Program Files shows WizTree Allocated ≈ disk-insight `wof_adjusted`.
- Program Files also shows WizTree Size relatively close to disk-insight
  `current`.
- Explorer Properties is the outlier: both Size and Size on disk are much
  smaller.

Classification: **Explorer divergence case**.

Possible causes include Explorer excluding some special items from folder
Properties, permission boundaries, app package handling, reparse points,
WindowsApps, or other special Program Files behavior. This is not enough
evidence for a disk-insight aggregation bug.

**v0.3.0-daily-use: HOLD continues.** The size-trust problem now has at least
two patterns: PFx86 metric-mix-up and Program Files Explorer divergence.

---

## 22. M-1 Users measurement result — RECORDED (2026-05-26)

Details: `docs/size-discrepancy-investigation.md` §M-1

### Measurement

`C:\Users`:

| Metric | Value |
|--------|------:|
| Explorer Size | 85.5 GB / 91,876,082,105 bytes |
| Explorer Size on disk | 86.6 GB / 93,070,688,256 bytes |
| Explorer files / folders | 844,896 / 151,681 |
| WizTree Size | 85.5 GB |
| WizTree Allocated | 85.6 GB |
| WizTree items / files / folders | 995,577 / 844,093 / 151,671 |
| disk-insight current | 85.4 GB |
| disk-insight wof_adjusted | TBD / not measured |

### Interpretation

Users is an **Alignment case**.

- Explorer Size, WizTree Size, and disk-insight `current` are all around
  85.4-85.5 GB.
- Explorer Size on disk and WizTree Allocated are also close.
- This does not show the PFx86 metric-mix-up pattern.
- This does not show the Program Files Explorer divergence pattern.

Size trust is therefore not uniformly bad. The remaining concerns are
path-specific behavior in PFx86, Program Files, Windows, and component-store
areas.

**v0.3.0-daily-use: HOLD continues.** Users is a positive alignment case, but
the UI still needs clearer size wording and Windows special accounting remains
a caveat area.

---

## 23. M-1 Windows measurement result — RECORDED (2026-05-26)

Details: `docs/size-discrepancy-investigation.md` §M-1

### Measurement

`C:\Windows`:

| Metric | Value |
|--------|------:|
| Explorer Size | 27.2 GB / 29,288,242,753 bytes |
| Explorer Size on disk | 17.7 GB / 19,076,632,576 bytes |
| Explorer files / folders | 377,473 / 174,670 |
| WizTree Size | 28.9 GB |
| WizTree Allocated | 15.5 GB |
| WizTree items / files / folders | 556,667 / 380,399 / 176,268 |
| disk-insight current | 26.7 GB |
| disk-insight wof_adjusted | ~18.4 GB (prior global WOF diagnostic) |

### Interpretation

Windows is a **Windows special accounting case**.

- Explorer Size, WizTree Size, and disk-insight `current` are broadly comparable.
- Explorer Size on disk, WizTree Allocated, and disk-insight `wof_adjusted` are
  also broadly comparable, but still divergent.
- WinSxS, hardlinks, component-store accounting, WOF, protected folders, and
  tool-specific accounting boundaries all matter here.

This does not show a simple disk-insight-only failure. It also does not provide
a clean alignment proof. Size trust improves because the case is now classified,
but Windows remains difficult to explain simply.

**v0.3.0-daily-use: HOLD continues.** The next natural step is M-2 UI label /
size metric wording review; WinSxS-specific accounting can remain a later
investigation.

---

## 24. M-2: UI label / size metric wording review — PLANNED (2026-05-26)

Details: `docs/size-label-wording-plan.md`

M-1 improved the explanation of size discrepancies, but daily-use trust still
depends on the UI making the metric obvious. A user should not have to remember
from docs whether a disk-insight number should be compared with Explorer
"Size", Explorer "Size on disk", WizTree "Size", or WizTree "Allocated".

The size-confidence issue is therefore partly label ambiguity:

- "ALLOCATED" can sound exact.
- "Subtree" does not say what kind of total it is.
- "Size policy" is implementation wording.
- `current` / `wof_adjusted` need short comparison guidance.

Daily-use PASS should require that the user can tell what size is being shown.
M-2b should make minimal UI label / tooltip changes before further correction
implementation. v0.3.0-daily-use remains **HOLD**.

---

## 25. M-2b: UI label minimal implementation — COMPLETE (2026-05-26)

M-2b updated UI labels so disk-insight values are less likely to be confused
with Explorer "Size":

- `ALLOCATED` became `ALLOCATED ESTIMATE`.
- `Size policy` became `Size metric`.
- Selected folder totals now use estimate wording.
- Table size headers now use estimate-oriented labels.
- WOF-adjusted mode remains marked experimental and still warns that hard links
  and WinSxS are not fully corrected.

This improves the "what size is this?" part of daily-use trust. It does not
resolve residual deltas, does not implement correction logic, and does not make
exact Explorer / WizTree parity claims.

**v0.3.0-daily-use: HOLD continues.**

## 26. M-3: Per-path size discrepancy diagnostic design — PLANNED (2026-05-26)

M-2b improves the labels, but the user's latest daily-use framing is stricter:
disk-insight should help decide where to inspect when freeing disk space.

For that purpose, size trust is not just label clarity. If disk-insight differs
from Explorer or WizTree, the tool needs to explain the likely reason. A path may
be WOF-heavy, hardlink-heavy, affected by WinSxS/component-store accounting, or
show Explorer Properties divergence.

M-3 designs a diagnostic-only `--diag-path <path>` mode that maps the M-1
patterns into path-level evidence and candidate classifications. The planned
M-3b implementation should be minimal and must not change normal output,
correction policy, JSON, UI values, hardlink accounting, WinSxS accounting, or
delete behavior.

**v0.3.0-daily-use: HOLD continues.** The next trust improvement is
explainability for specific paths, not another wording-only change.

---

## 27. M-3b: `--diag-path` minimal implementation - COMPLETE (2026-05-26)

M-3b adds a diagnostic-only CLI mode for a specified path:

```powershell
.\target\release\disk-insight.exe --diag-path "C:\Program Files"
```

This moves the size-trust work toward the core requirement: when disk-insight
differs from Explorer or WizTree, it should provide evidence for why. The mode
reports current vs WOF-adjusted estimates, WOF impact, hardlink and multi-name
signals, reparse/sparse/compressed counts, top child directories, top WOF-impact
files, and candidate classifications.

This is still not a correction feature. It does not implement hardlink dedup,
WinSxS/component-store correction, WOF production policy changes, delete, or UI
integration.

**v0.3.0-daily-use: HOLD continues.** The direction is now explanation-first:
show why a path is suspicious before changing normal output.

---

## 28. M-3c: diag-path output refinement - COMPLETE (2026-05-26)

M-3c makes `--diag-path` easier to read as an explanation rather than a raw
developer dump. The new Summary section shows the total WOF delta, main child
directory contributing to that delta, top contributor percent, classification
summary, and recommended comparison guidance.

This improves the central size-trust requirement: when a number differs, the
tool can point to the likely reason and the subtree that explains most of the
difference. It remains diagnostic-only. It does not read Explorer/WizTree
values automatically, does not correct hardlinks or WinSxS, and does not change
normal output.

**v0.3.0-daily-use: HOLD continues**, but this is a major input for improving
size confidence.

---

## 29. N-1: Reclaimable size model design - COMPLETE (2026-05-26)

The daily-use goal is not exact agreement with Explorer or WizTree for its own
sake. The practical goal is deciding where to inspect when trying to free disk
space.

N-1 therefore reframes the size-trust problem around `Estimated reclaimable`:
how much free space might increase if a selected folder is removed or moved.
The design proposes `wof_adjusted` as the primary estimate, `current` as an
upper/reference bound, and a confidence level based on WOF impact, hardlink and
component-store signals, and path type.

This does not add deletion, correction logic, or UI behavior. It is a design
step toward making disk-insight explain which number is useful for cleanup
decisions, not just why tools disagree.

**v0.3.0-daily-use: HOLD continues.** The next practical step is N-1b: add a
diagnostic-only reclaimable estimate section to `--diag-path`.

---

## 30. N-1b: Reclaimable estimate in diag-path - COMPLETE (2026-05-26)

N-1b adds the cleanup-oriented estimate to the CLI diagnostic path:

```powershell
.\target\release\disk-insight.exe --diag-path "C:\Program Files"
```

The new `Reclaimable estimate` section reports a primary estimate, reference
range, confidence, basis, and caution. This is a more direct daily-use signal
than raw size discrepancy explanation because it addresses the question: which
number should guide a decision about where to inspect for reclaimable space?

It remains diagnostic-only. It does not delete, move, clean, guarantee exact
free-space delta, or implement hardlink / WinSxS / WOF production correction.

**v0.3.0-daily-use: HOLD continues**, but this is a core improvement toward
making size output actionable without pretending it is exact.

---

## 31. N-2: UI reclaimable estimate design - COMPLETE (2026-05-26)

N-2 adds a comprehensive UI design plan (`docs/ui-reclaimable-estimate-plan.md`) to integrate estimated reclaimable size, confidence ratings, and warnings into the Tauri desktop UI.

Key Design Decisions:
- **Selected Folder Card Integration**: Display estimated reclaimable size, range, confidence badge, basis, and caution text strictly inside the folder detail card on the right.
- **Tauri command integration**: Propose a new Rust-centric backend command: `get_reclaimable_summary(path) -> ReclaimableSummary` to keep layouts thin and ensure identical CLI/UI rules.
- **Daily-use status**: **v0.3.0-daily-use remains HOLD**. The UI has not been modified yet. This design serves as the crucial bridge from CLI-only diagnostics to everyday usability.

It remains design-only. No deletion, WOF production changes, or hardlink/WinSxS correction is included.

---

## 32. N-2b–N-2e: Reclaimable estimate UI — COMPLETE (2026-05-27)

N-2b–N-2e implemented and evaluated the reclaimable estimate feature in the Tauri UI.

### Implementation (N-2b)

- `compute_reclaimable_summary` extracted as reusable Rust function
- `wof_size_map: HashMap<u64, (u64, u64)>` added to `MftTreeModel`
- `get_reclaimable_summary` Tauri command added
- `SelectedFolderCard` extended: Estimated reclaimable, Range, Confidence badge, Basis, Caution

### Evaluation and polish (N-2c → N-2e)

N-2c found three △ issues. N-2d resolved all three:

| Issue | Fix |
|-------|-----|
| Range shown when not_recommended=true | Range row hidden for not_recommended paths |
| High confidence range redundant (C:\Users spread < 1%) | "Range: tight (within 1%)" label |
| "Not recommended" text weak (13 px/600) | Upgraded to 15 px/700 |

N-2e re-evaluation: **○ (practical daily-use level)**.

Paths and verdicts:
- C:\Users: High / 85 GB / tight range → reliable cleanup candidate
- C:\Program Files: Medium / 24 GB / WindowsApps cited → uninstall-guided decision
- C:\Program Files (x86): Medium / 8 GB / Office cited → specific and actionable
- C:\Windows: Low / Not recommended (bold) / Range hidden → "do not touch" is clear

**Size trustworthiness is no longer a v0.3.0-daily-use HOLD condition.**

### Updated HOLD status

**v0.3.0-daily-use: HOLD continues**, but the main cause has shifted:

| Factor | Previous | Now |
|--------|----------|-----|
| Size trustworthiness | HOLD cause | ○ resolved |
| Scan speed / cold cache | Secondary | **Primary HOLD cause** |

Next: K-5 scan speed / cold cache investigation. See `docs/scan-speed-cold-cache-plan.md`.

