# disk-insight TreeView performance plan

This document is the design map for scaling the left-pane folder TreeView to
large NTFS volumes. It is created in **E-3** and intentionally contains no
code changes — its job is to keep later phases (E-4 onward) from painting
themselves into a corner.

The TreeView introduced in E-2 (root_children + lazy `get_children` +
`childrenByParent` cache) already handles a typical C: drive comfortably, but
it has no explicit upper bound. This plan documents where the current design
holds, where it will break, and how to extend it safely.

---

## 1. Current TreeView architecture

The post-E-2 left-pane TreeView is built from a small set of pieces:

### Data sources

- **`root_children: JsonTreeNode[]`** — initial top-level rows. Direct children
  of NTFS FRN 5, sorted by `subtree_size` desc, capped at 200 entries.
  Populated by both `scan_drive` and the embedded sample.
- **`get_children(parent_record_index) -> JsonTreeNode[]`** — Tauri command
  backed by an in-memory `HashMap<u64, Vec<JsonTreeNode>>` built once per
  `scan_drive`. Returns the full list of direct children for a directory FRN,
  sorted by `subtree_size` desc / `name` asc. Returns `[]` for unknown FRNs
  and an error when no live scan is loaded.

### Rendering

- `TreeView` (left pane) → `TreeNodeRow` (recursive). Each row renders one
  `JsonTreeNode` with depth-based padding, an expand toggle, and a label.
- Only **expanded** subtrees are rendered. Initial render = root_children only.
- Each `TreeNodeRow` recursively renders its cached children when its
  `record_index` is in `expandedIds` and `childrenByParent` has a hit.

### Frontend state

- `expandedIds: Set<number>` — record indexes currently expanded.
- `loadingIds: Set<number>` — record indexes with an in-flight `get_children`.
- `childrenByParent: Record<number, JsonTreeNode[]>` — per-parent children
  cache, persists for the lifetime of the current scan.
- `treeError: string | null` — last expansion error (shared slot).
- `selectedDir: DirectoryEntry | undefined` — drives the SelectedFolderCard
  and the right-pane prefix filter. Updated by folder label click;
  unaffected by toggle click. Tree state is reset on every `runLoad`.

### Right-pane integration

- `selectedDir` filters the existing `top_directories` and `top_files` lists
  via `filterByDir(items, selectedDir.path)`. **The right pane uses
  `top_directories` / `top_files`, not `childrenByParent` — they are
  independent data paths.**
- The TreeView never feeds rows directly into the right-pane tables.

### What is not implemented

- No virtual scroll (every expanded row is in the DOM).
- No automatic expansion (no "expand all", no path-based auto-open).
- No flattened visible-row list — recursion happens during render.
- No per-parent pagination, no streaming, no cancellation.
- No keyboard navigation, no selection memory across scans.

---

## 2. Scale assumptions

Numbers below are order-of-magnitude estimates from the development C: drive
(see `private_notes/PROGRESS.md`, 2026-05-24 entries). Treat them as planning
budgets, not exact measurements.

| Metric | Value | Source |
|--------|-------|--------|
| Total MFT records | ~1.98M | C: probe6 result |
| In-use entries | ~1.68M | C: probe6 result |
| Files | ~1.33M | C: probe6 result |
| Directories | ~347k | C: probe6 result |
| Orphans | 0 | C: probe6 result |
| `root_children` (FRN 5) | 53 | post-E-1a probe |
| Allocated total | ~182 GB | C: probe6 result |
| Scan time (release build) | ~5–11 s | probe5/6 + spawn_blocking runs |
| `C:\Users` direct children | 6 | E-1b verification |

### Children-count distribution (qualitative)

The MFT does not let us cheaply pre-compute per-directory children counts
for the UI without traversing each parent, but the orders of magnitude
we expect in practice:

- **Most directories**: < 50 children — opens instantly.
- **Common moderate cases (10²–10³)**: `C:\Windows`, `C:\Windows\System32`,
  user profile roots, `Program Files`.
- **Pathological hot spots (10³–10⁴+)**: `node_modules`, build caches,
  `AppData\Local\Packages`, package manager caches, log archives, mail
  spool directories. These are the directories most likely to break a
  naive non-virtualized tree.

### Memory footprint of the children cache

`childrenByParent` is a frontend mirror of the Rust `children_map`, populated
**lazily** (only the parents the user expands). Each `JsonTreeNode` is small —
a name string, a path string, six numeric fields, a boolean. In practice:

- Expanding a few hundred typical directories is negligible (low MB).
- The Rust-side `children_map` already holds entries for all 347k
  directories. It is the dominant memory cost and is independent of UI
  behavior. The frontend cache adds, at worst, a per-node JS object on top.

### Sample-data path

The embedded sample also carries `root_children` (53 entries) but does NOT
populate `children_map`. Calling `get_children` on the sample returns the
"Live scan required" error — by design. The TreeView shows root rows but
expansion fails clearly. Any future change must preserve this behavior, or
the sample mode breaks silently.

---

## 3. Risks

The current implementation has no explicit upper bound on:

### React / DOM cost

- **Total expanded rows**: every row in every expanded subtree is in the
  DOM. A user who expands a deep chain through a large `node_modules` or
  `WinSxS` can produce 10k+ rows. React still re-renders all of them on
  any state change.
- **Recursive render cost**: `TreeNodeRow` recurses through `cached.map()`
  per expanded directory. With deep expansion this becomes a fan-out
  bigger than React's reconciliation likes for interactive frame budgets.

### Frontend state size

- `expandedIds` grows monotonically until the user collapses or rescans. A
  user who expands many directories accumulates set membership without
  any cleanup signal.
- `childrenByParent` grows similarly — once fetched, a parent's children
  stay cached until the next scan. This is intentional (avoids re-fetch
  thrash) but unbounded.

### Tauri command storm

- `get_children` is invoked per-expansion. Today there is no de-dup guard:
  if a render path re-fires the toggle handler while a request is in
  flight, two requests can be queued. `loadingIds` reduces but does not
  fully prevent this (the check is read-then-act, not atomic).
- A "click ten folders quickly" pattern triggers ten serial-ish invokes.
  Each is cheap (in-memory HashMap lookup, no MFT re-read), but they
  serialize on the Mutex inside `AppState`.

### User-driven worst cases

- **AppData / node_modules / package caches**: large fan-out per directory.
  Expanding one of these can drop a few thousand rows into the DOM in one
  click.
- **Recursive expansion habit**: a user clicking down through 6–10 levels
  of nested folders without collapsing intermediates produces an
  accumulating row count that the current renderer treats as flat.
- **Sample mode confusion**: expanding in sample mode produces a
  "Live scan required" error, which is correct but easy to miss because
  the toggle still appears clickable.

### UI freeze / memory growth

- A 10k-row expanded tree on a low-end laptop can introduce visible
  scroll lag and noticeably slow keystrokes in the toolbar (drive input,
  top selector).
- Long-running sessions with many scans accumulate state from previous
  scans only between `runLoad` calls — but the Rust `children_map`
  itself stays resident as long as the app is open.

### What we are NOT at risk of right now

- Out-of-memory in normal use. The Rust `children_map` is the dominant
  cost and is comfortable in modern memory budgets for C: drives.
- Scan-time regressions. E-3+ touches only render/state — not MFT logic.
- Data correctness. `get_children` is deterministic and snapshot-based.

---

## 4. Rules before virtual scroll

These are the invariants the codebase should preserve **until** virtual
scroll is introduced. They are the cheapest form of safety: convention
plus a few small guards.

1. **Initial render is bounded**: only `root_children` (≤ 200) is rendered
   on first paint. No phase may introduce an "open by default" or
   "auto-expand the selected path" behavior without explicit cost analysis.
2. **Expansion is user-driven only**: no recursive `get_children` chains.
   One click = one parent's children. Selecting a node in the right-pane
   tables must NOT auto-expand its ancestors in the tree.
3. **Per-parent cache, not per-node**: `childrenByParent` is keyed by
   parent record index. Each fetch populates exactly one entry. Future
   code must not multi-key or duplicate state.
4. **Duplicate-request guard**: every `get_children` invocation must
   check `loadingIds` before firing. Already true in E-2; new entry
   points (keyboard expand, programmatic expand) must respect it.
5. **Sample mode is read-only**: expansion in sample mode must continue to
   surface a clear, recoverable error. No silent fallback to empty rows.
6. **Tree state resets on `runLoad`**: every scan and every "Load sample"
   clears `expandedIds`, `loadingIds`, `childrenByParent`, `treeError`.
   This is the only cleanup signal the tree has; it must not be removed.
7. **Child-count display first, fanout limits later**: when a parent has a
   very large child list (e.g. > 1000), the UI should show the count
   before the user commits to the expansion. Truncation / paging is a
   later decision.
8. **Don't add `tree-row` ancestor click handlers**: keep toggle / label
   click responsibilities separated. Adding a row-level handler invites
   event-propagation bugs the E-2 follow-up just resolved.
9. **No DOM-size hidden costs**: any new per-row affordance (icons,
   tooltips, action buttons) multiplies by every visible row. New
   features must be evaluated against a 10k-row expanded tree, not the
   root level.

---

## 5. Virtual scroll options

Three realistic candidates for when we eventually need windowing:

### Option A: `@tanstack/react-virtual`

- Maintained, framework-agnostic core with React bindings, ~3 kB gzipped.
- Headless: we keep our own row components and CSS; the library only
  computes which indexes are visible.
- Works well with a **flattened visible-row list** (see E-4 below).
- Variable row height supported but we should avoid it.
- Single new dependency, no peer-dep churn with React 19 / Vite 7.

### Option B: `react-window`

- Older, smaller, but more opinionated (requires children render-prop API).
- Variable-size lists are a separate component (`VariableSizeList`).
- Stable but less actively developed than `react-virtual`. Integrates
  fine, but the React 19 story is less clean.

### Option C: Hand-rolled virtual list

- ~150–250 lines: a flat-rows array, a measured container height, fixed
  row height, top spacer + bottom spacer.
- Zero dependencies, full control, no upgrade exposure.
- Loses: tested edge cases (scroll restoration, dynamic resize, RTL,
  observers), and any momentum to share with future tables.

### Comparison

| Concern | tanstack/react-virtual | react-window | hand-rolled |
|---------|------------------------|--------------|-------------|
| Bundle delta | ~3 KB | ~5 KB | 0 |
| Flatten required | yes | yes | yes |
| Variable row height | optional (avoid) | separate component | manual |
| React 19 / Vite 7 fit | clean | OK | n/a |
| Maintenance burden | low | low | ours |
| Reusability for tables later | high | medium | low |
| Risk of subtle scroll bugs | low | low | medium |

### Recommendation

**Defer the choice to E-6.** Adopt `@tanstack/react-virtual` if/when
virtualization is needed. Reasons:

- Today the tree handles real C: drives fine — the cost of carrying a
  windowing library now is non-zero, the benefit is zero until users hit
  the pathological cases.
- Flattening (E-4) is the prerequisite for any windowing solution and
  doesn't require choosing a library yet.
- The hand-rolled option remains attractive only if we expect zero other
  virtualized surfaces in the app. Top-directories / top-files tables
  are likely future candidates, so a reusable library wins long-term.

---

## 6. Proposed next steps

Each phase below is incremental, independently shippable, and reversible.

### E-4: Flattened visible-tree list

**Goal**: change the render input from "recursive component tree" to
"flat array of visible rows". This unlocks virtual scroll without
committing to it, and makes the render path easier to reason about.

- Introduce `visibleRows: Array<{ node, depth, isLast?, ... }>` derived
  from `root_children` + `expandedIds` + `childrenByParent` via a
  `useMemo`.
- Render `visibleRows.map(...)` flat at the top of the list container.
- `TreeNodeRow` becomes a depth-aware non-recursive cell.
- Behavior is unchanged from the user's perspective.
- **Out of scope**: virtual scroll, expand-all, keyboard nav.

### E-5: Expand safety limits

**Goal**: protect users (and ourselves) from the pathological cases.

- Surface child counts on the parent row before expansion (already
  available in `JsonTreeNode.child_count`).
- When `child_count > threshold` (e.g. 500), show a chip / hint on the
  toggle and require an extra click or show a "showing first N of M"
  banner under the parent.
- De-dup `get_children` calls atomically against `loadingIds`.
- Optional: warn when `expandedIds.size > ~50` and offer "Collapse all".
- **Out of scope**: backend pagination of `get_children`.

### E-6: Virtual scroll PoC

**Goal**: window the flat visible-rows list when it grows past a few
hundred rows.

- Adopt `@tanstack/react-virtual` (see §5).
- Fix row height (no path-wrap inside tree rows — switch to truncate +
  tooltip if needed).
- Verify scroll restoration on expand/collapse.
- Measure DOM cost before/after on a worst-case expansion.
- **Out of scope**: keyboard navigation, sticky parents.

### E-7: UI polish on top of virtual scroll

**Goal**: catch up on UX niceties that depend on a stable virtualized list.

- Column alignment (name vs size) once row width is fixed.
- Keyboard navigation (`ArrowUp`/`ArrowDown`/`Right`/`Left`/`Enter`).
- "Scroll selected into view" when `selectedDir` changes from outside the
  tree (e.g. right-pane row click in a future phase).
- Sticky selected row, hover affordances.

---

## 7. Recommendation

**Do not implement virtual scroll yet.** The current tree is safe enough
for the target user (the developer scanning their own C: drive) and the
sample data path. Premature virtualization would lock in API choices we
don't need.

**Do, next, what unblocks everything else: E-4 flattened visible-tree
list.** It's small, low-risk, observable in `npm run build`, and the
prerequisite for E-5 limits and E-6 virtualization. After E-4 we should
re-measure the worst-case expansion on a real C: drive and decide
whether E-5 or E-6 is more urgent.

**Sequence priority**: TreeView stabilization (E-4 → E-5 → E-6 → E-7)
should be completed **before** adding a delete action. A delete action
on top of a tree that can drop 10k rows on a single click is a UX
liability we don't want to ship.

**Do NOT in this phase**:

- introduce a new dependency,
- change Rust core, Tauri commands, or the JSON schema,
- add file deletion, `explorer /select`, right-click menu, or Treemap,
- auto-expand any subtree.

### Status

E-3 is **planning only** — no source code changes. Implementation begins
at E-4.
