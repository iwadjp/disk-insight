import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./styles.css";

type Summary = {
  drive: string;
  total_records: number;
  in_use_entries: number;
  files: number;
  directories: number;
  orphans: number;
  root_nodes: number;
  total_final_allocated: number;
  allocated_size?: number;
  storage_policy?: string;
  open_vol_time_ms?: number;
  read_time_ms: number;
  parse_time_ms: number;
  tree_build_time_ms: number;
  aggregation_time_ms: number;
  children_map_time_ms?: number;
  wof_map_time_ms?: number;
  top_build_time_ms?: number;
  total_time_ms: number;
};

type DirectoryEntry = {
  path: string;
  record_index: number;
  subtree_size: number;
  direct_file_size: number;
  child_count: number;
};

type FileEntry = {
  path: string;
  record_index: number;
  parent_frn: number;
  final_allocated_size: number;
};

type TreeNode = {
  name: string;
  path: string;
  record_index: number;
  parent_record_index: number;
  is_directory: boolean;
  subtree_size: number;
  direct_file_size: number;
  child_count: number;
};

type VisibleTreeRow = {
  node: TreeNode;
  depth: number;
  isEmpty?: true;
  nodeError?: string;
  largeWarning?: number;
};

type DriveCapacity = {
  total_bytes: number;
  free_bytes: number;
  available_bytes: number;
  used_bytes: number;
  used_percent: number;
};

type DiskInsightOutput = {
  summary: Summary;
  capacity?: DriveCapacity;
  top_directories: DirectoryEntry[];
  top_files: FileEntry[];
  root_children?: TreeNode[];
};

type CachedScanResponse = {
  output: DiskInsightOutput;
  created_at_unix_ms: number;
  cache_path: string;
  cache_file_size_bytes: number;
  cache_load_ms: number;
};

type DriveInfo = {
  letter: string;
  root: string;
  display: string;
  drive_type: string;
};

type ScanProgress = {
  scan_id:    string;
  drive:      string;
  phase:      string;
  message:    string;
  elapsed_ms: number;
  current?:    number;
  total?:      number;
  unit?:       string;
  segment_current?: number;
  segment_total?:   number;
};

type ReclaimableSummary = {
  current_bytes:      number;
  wof_adjusted_bytes: number;
  range_lower:        number;
  range_upper:        number;
  confidence:         "High" | "Medium" | "Low" | string;
  basis:              string;
  caution:            string;
  not_recommended:    boolean;
};

type TauriWindow = Window & {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
};

type SourceKind = "sample" | "live" | "cached";
type CacheBannerState =
  | {
      kind: "cached_refreshing";
      createdAtUnixMs: number;
      cacheLoadMs: number;
      cacheFileSizeBytes: number;
      cachePath: string;
    }
  | { kind: "live" }
  | { kind: "refresh_failed"; message: string };
type DirectChildrenSortKey = "size" | "name" | "type";
type SortDirection = "asc" | "desc";
type ContextMenuState = { node: TreeNode; x: number; y: number };

const TOP_OPTIONS = [10, 30, 50, 100, 200, 500];
const LARGE_FOLDER_THRESHOLD = 200;
const LARGE_TREE_THRESHOLD = 1000;
const PREF_KEY = "disk-insight.preferences.v1";
const PHASE_COMPLETION_LATCH_MS = 600;
const UPDATED_BANNER_DISMISS_MS = 4000;

type AppPreferences = {
  drive?: string;
  topCount?: number;
  storagePolicy?: string;
  directChildrenSortKey?: DirectChildrenSortKey;
  directChildrenSortDirection?: SortDirection;
};

function loadPreferences(): AppPreferences {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as AppPreferences;
  } catch {
    return {};
  }
}

function savePreferences(prefs: AppPreferences): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage unavailable; ignore
  }
}

const _initialPrefs = loadPreferences();

function parseDriveLetter(input: string): string | null {
  const s = input.trim().replace(/:$/, "");
  if (s.length === 1 && /^[A-Za-z]$/.test(s)) return s.toUpperCase();
  return null;
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "opening_volume":    return "Opening volume";
    case "reading_mft":       return "Reading MFT (I/O)";
    case "parsing_records":   return "Parsing records";
    case "building_tree":     return "Building directory tree";
    case "aggregating_sizes": return "Aggregating sizes";
    case "building_ui_model": return "Preparing UI model";
    case "done":              return "Finalizing";
    default:                  return "Scanning";
  }
}

function formatElapsed(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${m}m ${rem}s`;
}

function hasByteProgress(p: ScanProgress | null): p is ScanProgress & {
  current: number;
  total: number;
  unit: string;
} {
  return p?.current != null && p.total != null && p.total > 0 && p.unit === "bytes";
}

function isDriveRoot(path: string): boolean {
  return /^[A-Za-z]:\\?$/.test(path);
}

function filterByDir<T extends { path: string }>(items: T[], selectedPath: string): T[] {
  if (isDriveRoot(selectedPath)) return items;
  return items.filter(
    (item) => item.path === selectedPath || item.path.startsWith(selectedPath + "\\"),
  );
}

function isTauriRuntime(): boolean {
  const tauriWindow = window as TauriWindow;
  return Boolean(tauriWindow.__TAURI__ || tauriWindow.__TAURI_INTERNALS__);
}

async function loadSampleData(): Promise<DiskInsightOutput> {
  if (isTauriRuntime()) {
    return invoke<DiskInsightOutput>("load_sample_json");
  }
  // Browser dev fallback: normal browsers do not expose the Tauri invoke bridge.
  const response = await fetch("/sample/probe7.sample.json");
  if (!response.ok) {
    throw new Error(`Failed to load sample JSON: ${response.status}`);
  }
  return response.json() as Promise<DiskInsightOutput>;
}

async function scanDrive(drive: string, top: number, storagePolicy: string): Promise<DiskInsightOutput> {
  if (!isTauriRuntime()) {
    throw new Error("Real scan is available only in the Tauri desktop app.");
  }
  return invoke<DiskInsightOutput>("scan_drive", { drive, top, storagePolicy });
}

async function loadScanCache(
  drive: string,
  storagePolicy: string,
): Promise<CachedScanResponse | null> {
  if (!isTauriRuntime()) return null;
  return invoke<CachedScanResponse | null>("load_scan_cache", { drive, storagePolicy });
}

async function openInExplorer(path: string): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("Explorer open is available only in the Tauri desktop app.");
  }
  return invoke<void>("open_in_explorer", { path });
}

async function selectInExplorer(path: string): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("File selection is available only in the Tauri desktop app.");
  }
  return invoke<void>("select_in_explorer", { path });
}

async function getChildren(parentRecordIndex: number): Promise<TreeNode[]> {
  if (!isTauriRuntime()) {
    throw new Error("Children API is available only in the Tauri desktop app.");
  }
  return invoke<TreeNode[]>("get_children", { parentRecordIndex });
}

async function getReclaimableSummary(
  recordIndex: number,
  path: string,
  drive: string,
): Promise<ReclaimableSummary> {
  if (!isTauriRuntime()) {
    throw new Error("Reclaimable summary is available only in the Tauri desktop app.");
  }
  return invoke<ReclaimableSummary>("get_reclaimable_summary", { recordIndex, path, drive });
}

function treeNodeToDirEntry(node: TreeNode): DirectoryEntry {
  return {
    path: node.path,
    record_index: node.record_index,
    subtree_size: node.subtree_size,
    direct_file_size: node.direct_file_size,
    child_count: node.child_count,
  };
}

function findNodeByPath(
  path: string,
  rootChildren: TreeNode[],
  childrenByParent: Record<number, TreeNode[]>,
): TreeNode | undefined {
  for (const n of rootChildren) {
    if (n.path === path) return n;
  }
  for (const children of Object.values(childrenByParent)) {
    for (const n of children) {
      if (n.path === path) return n;
    }
  }
  return undefined;
}

// Returns DirectoryEntry[] for every ancestor of selectedPath, from drive root
// down to (but not including) selectedPath itself. Drive root = synthetic entry.
function buildAncestorEntries(
  selectedPath: string,
  data: DiskInsightOutput,
  childrenByParent: Record<number, TreeNode[]>,
): DirectoryEntry[] {
  if (isDriveRoot(selectedPath)) return [];
  const parts = selectedPath.split("\\").filter(Boolean);
  const drive = parts[0];
  const driveRoot = drive + "\\";
  const rootRecordIndex = data.root_children?.[0]?.parent_record_index ?? 5;

  const paths: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    paths.push(
      i === 0 ? driveRoot : drive + "\\" + parts.slice(1, i + 1).join("\\"),
    );
  }

  return paths
    .map((p): DirectoryEntry | undefined => {
      if (isDriveRoot(p)) {
        return {
          path: p,
          record_index: rootRecordIndex,
          subtree_size: 0,
          direct_file_size: 0,
          child_count: data.root_children?.length ?? 0,
        };
      }
      const node = findNodeByPath(p, data.root_children ?? [], childrenByParent);
      return node ? treeNodeToDirEntry(node) : undefined;
    })
    .filter((e): e is DirectoryEntry => e !== undefined);
}

function breadcrumbLabel(path: string): string {
  if (isDriveRoot(path)) return path;
  return path.slice(path.lastIndexOf("\\") + 1);
}

function buildVisibleRows(
  rootChildren: TreeNode[],
  expandedIds: Set<number>,
  childrenByParent: Record<number, TreeNode[]>,
  childrenErrors: Record<number, string>,
): VisibleTreeRow[] {
  const rows: VisibleTreeRow[] = [];
  function visit(nodes: TreeNode[], depth: number) {
    for (const node of nodes) {
      rows.push({ node, depth });
      if (node.is_directory) {
        const id = node.record_index;
        if (expandedIds.has(id)) {
          const children = childrenByParent[id];
          if (children) {
            if (children.length === 0) {
              rows.push({ node, depth: depth + 1, isEmpty: true });
            } else {
              if (children.length > LARGE_FOLDER_THRESHOLD) {
                rows.push({ node, depth: depth + 1, largeWarning: children.length });
              }
              visit(children, depth + 1);
            }
          }
        } else if (childrenErrors[id]) {
          rows.push({ node, depth: depth + 1, nodeError: childrenErrors[id] });
        }
      }
    }
  }
  visit(rootChildren, 0);
  return rows;
}

function sortDirectChildren(
  children: TreeNode[],
  sortKey: DirectChildrenSortKey,
  sortDir: SortDirection,
): TreeNode[] {
  return [...children].sort((a, b) => {
    switch (sortKey) {
      case "size": {
        // Always DIR before FILE
        if (a.is_directory !== b.is_directory) return a.is_directory ? -1 : 1;
        // desc = big first, asc = small first
        const sizeCmp = b.subtree_size - a.subtree_size;
        const sizeResult = sortDir === "desc" ? sizeCmp : -sizeCmp;
        if (sizeResult !== 0) return sizeResult;
        return a.name.localeCompare(b.name);
      }
      case "name": {
        // Always DIR before FILE
        if (a.is_directory !== b.is_directory) return a.is_directory ? -1 : 1;
        const nameCmp = a.name.localeCompare(b.name);
        const nameResult = sortDir === "asc" ? nameCmp : -nameCmp;
        if (nameResult !== 0) return nameResult;
        return b.subtree_size - a.subtree_size; // tie-breaker: size desc
      }
      case "type": {
        // asc = DIR first, desc = FILE first
        if (a.is_directory !== b.is_directory) {
          const typeResult = a.is_directory ? -1 : 1;
          return sortDir === "asc" ? typeResult : -typeResult;
        }
        return b.subtree_size - a.subtree_size; // within group: size desc
      }
    }
  });
}

function CopyButton({
  text,
  onError,
}: {
  text: string;
  onError: (msg: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  function handleClick() {
    if (!navigator.clipboard) {
      onError("Clipboard is not available.");
      return;
    }
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch((err: unknown) => {
      onError(err instanceof Error ? err.message : "Failed to copy path.");
    });
  }

  return (
    <button className="btn btn-sm" onClick={handleClick}>
      {copied ? "Copied!" : "Copy path"}
    </button>
  );
}

function getParentDir(filePath: string): string {
  const i = filePath.lastIndexOf("\\");
  if (i < 0) return filePath;
  if (i <= 2) return filePath.slice(0, 3); // drive root: "C:\"
  return filePath.slice(0, i);
}

function getFileName(filePath: string): string {
  const i = filePath.lastIndexOf("\\");
  return i >= 0 ? filePath.slice(i + 1) : filePath;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return unitIndex === 0
    ? `${value} ${units[unitIndex]}`
    : `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatRecords(records: number): string {
  if (records < 1000) return records.toLocaleString();
  if (records < 1_000_000) return `${(records / 1000).toFixed(1)}K`;
  if (records < 1_000_000_000) return `${(records / 1_000_000).toFixed(1)}M`;
  return `${(records / 1_000_000_000).toFixed(1)}B`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function storagePolicyDisplayName(policy: string | undefined): string | null {
  if (policy === "wof_adjusted") return "WOF-adjusted estimate (experimental)";
  if (policy === "current") return "Current allocation estimate";
  return policy || null;
}

function StatusBar({
  sourceKind,
  lastUpdated,
  data,
  isLoading,
  scanTopN,
}: {
  sourceKind: SourceKind | null;
  lastUpdated: Date | null;
  data: DiskInsightOutput | null;
  isLoading: boolean;
  scanTopN: number | null;
}) {
  if (!sourceKind || !lastUpdated || !data) return null;

  const sourceLabel =
    sourceKind === "live"
      ? `Live result: ${data.summary.drive}`
      : sourceKind === "cached"
        ? `Last scan result: ${data.summary.drive}`
        : "Sample data";

  const updatedLabel = `Last updated: ${formatDateTime(lastUpdated)}`;

  const durationLabel =
    sourceKind === "live"
      ? `Scan completed in ${formatNumber(data.summary.total_time_ms)} ms`
      : null;

  const policyLabel = data.summary.storage_policy && data.summary.storage_policy !== "current"
    ? storagePolicyDisplayName(data.summary.storage_policy)
    : null;

  return (
    <div className="status-bar">
      <span className={`source-badge source-badge--${sourceKind}`}>{sourceLabel}</span>
      {(sourceKind === "live" || sourceKind === "cached") && scanTopN !== null && (
        <span className="status-meta">Top {scanTopN}</span>
      )}
      {(sourceKind === "live" || sourceKind === "cached") && policyLabel && (
        <span className="source-badge source-badge--experimental">{policyLabel}</span>
      )}
      <span className="status-meta">{updatedLabel}</span>
      {durationLabel && <span className="status-meta">{durationLabel}</span>}
      {isLoading && <span className="status-meta status-updating">(updating…)</span>}
    </div>
  );
}

function LastScanBanner({ banner }: { banner: CacheBannerState | null }) {
  if (!banner) return null;

  if (banner.kind === "cached_refreshing") {
    return (
      <div className="last-scan-banner last-scan-banner--refreshing" role="status">
        Showing last scan result from {formatDateTime(new Date(banner.createdAtUnixMs))} ·
        Refreshing in background...
      </div>
    );
  }

  if (banner.kind === "live") {
    return (
      <div className="last-scan-banner last-scan-banner--updated" role="status">
        Updated just now
      </div>
    );
  }

  return (
    <div className="last-scan-banner last-scan-banner--failed" role="status">
      Last scan result shown; refresh failed. Run Scan again to retry.
    </div>
  );
}

function PerfBreakdown({ summary, invokeMs }: { summary: Summary; invokeMs: number | null }) {
  const s = summary;
  const phases: Array<[string, number | undefined]> = [
    ["open_vol",      s.open_vol_time_ms],
    ["read_mft",      s.read_time_ms],
    ["parse",         s.parse_time_ms],
    ["tree_build",    s.tree_build_time_ms],
    ["aggregate",     s.aggregation_time_ms],
    ["children_map",  s.children_map_time_ms],
    ["wof_map",       s.wof_map_time_ms],
    ["top_build",     s.top_build_time_ms],
  ];
  const knownMs = phases.reduce((acc, [, ms]) => acc + (ms ?? 0), 0);
  const otherMs = Math.max(0, s.total_time_ms - knownMs);
  const overheadMs = invokeMs !== null ? Math.round(invokeMs) - s.total_time_ms : null;

  function pct(ms: number) {
    return s.total_time_ms > 0 ? ((ms / s.total_time_ms) * 100).toFixed(1) + "%" : "—";
  }

  return (
    <details className="perf-breakdown">
      <summary className="perf-breakdown-summary">Scan timing breakdown</summary>
      <table className="perf-table">
        <thead>
          <tr><th>Phase</th><th>Time</th><th>Share</th></tr>
        </thead>
        <tbody>
          {phases.map(([label, ms]) =>
            ms !== undefined ? (
              <tr key={label}>
                <td className="perf-phase">{label}</td>
                <td className="perf-ms">{ms.toLocaleString()} ms</td>
                <td className="perf-pct">{pct(ms)}</td>
              </tr>
            ) : null
          )}
          {otherMs > 0 && (
            <tr>
              <td className="perf-phase perf-other">other</td>
              <td className="perf-ms">{otherMs.toLocaleString()} ms</td>
              <td className="perf-pct">{pct(otherMs)}</td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr className="perf-total-row">
            <td>Rust total</td>
            <td className="perf-ms">{s.total_time_ms.toLocaleString()} ms</td>
            <td className="perf-pct">100%</td>
          </tr>
          {invokeMs !== null && (
            <>
              <tr>
                <td>UI invoke</td>
                <td className="perf-ms">{Math.round(invokeMs).toLocaleString()} ms</td>
                <td className="perf-pct perf-note">incl. Tauri IPC</td>
              </tr>
              {overheadMs !== null && (
                <tr>
                  <td>Tauri overhead</td>
                  <td className="perf-ms">{overheadMs.toLocaleString()} ms</td>
                  <td className="perf-pct perf-note">IPC + lock + ser</td>
                </tr>
              )}
            </>
          )}
        </tfoot>
      </table>
    </details>
  );
}

function SummaryCard({ summary }: { summary: Summary }) {
  const items = [
    ["Drive", summary.drive],
    [
      "Allocated estimate",
      formatBytes(summary.total_final_allocated),
      "Estimated allocated-style size. Compare with Explorer \"Size on disk\" or WizTree \"Allocated\", not Explorer \"Size\".",
    ],
    ["Files", formatNumber(summary.files)],
    ["Directories", formatNumber(summary.directories)],
    ["Total time", `${formatNumber(summary.total_time_ms)} ms`],
  ];
  return (
    <section className="summary" aria-label="Scan summary">
      {items.map(([label, value, title]) => (
        <div className="metric" key={label} title={title}>
          <span className="metric-label">{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </section>
  );
}

function CapacityCard({ capacity }: { capacity: DriveCapacity }) {
  return (
    <div className="capacity-card">
      <span className="metric-label">Drive capacity</span>
      <div className="capacity-card-stats">
        <span title="Total volume capacity reported by the OS">{formatBytes(capacity.total_bytes)}{" "}total</span>
        <span className="capacity-sep">·</span>
        <span title="Used space (total minus free)">{formatBytes(capacity.used_bytes)}{" "}used ({capacity.used_percent.toFixed(1)}%)</span>
        <span className="capacity-sep">·</span>
        <span title="Free space on the volume">{formatBytes(capacity.free_bytes)}{" "}free</span>
      </div>
    </div>
  );
}

type TreeRowProps = {
  node: TreeNode;
  depth: number;
  totalSize: number;
  expandedIds: Set<number>;
  loadingIds: Set<number>;
  selectedRecordIndex: number | undefined;
  onToggleExpand: (node: TreeNode) => void;
  onSelect: (node: TreeNode) => void;
};

function TreeNodeRow({
  node,
  depth,
  totalSize,
  expandedIds,
  loadingIds,
  selectedRecordIndex,
  onToggleExpand,
  onSelect,
}: TreeRowProps) {
  const isDir       = node.is_directory;
  const isExpanded  = expandedIds.has(node.record_index);
  const isLoading   = loadingIds.has(node.record_index);
  const isSelected  = selectedRecordIndex === node.record_index;
  const indent      = 8 + depth * 16;
  const displayName = node.name || node.path;
  const barPct      = totalSize > 0 ? Math.min(100, (node.subtree_size / totalSize) * 100) : 0;

  const rowClass =
    "tree-row"
    + (isSelected ? " tree-row--active" : "")
    + (isDir ? "" : " tree-row--file")
    + (isLoading ? " tree-row--loading" : "");

  return (
    <div className={rowClass} style={{ paddingLeft: indent }}>
      {barPct > 0 && <div className="tree-size-bar" style={{ width: `${barPct}%` }} />}
      {isDir ? (
        <button
          className="tree-toggle"
          onClick={(e) => { e.stopPropagation(); onToggleExpand(node); }}
          disabled={isLoading}
          aria-label={isExpanded ? "Collapse" : "Expand"}
          title={isExpanded ? "Collapse" : "Expand"}
        >
          {isLoading ? "…" : isExpanded ? "▼" : "▶"}
        </button>
      ) : (
        <span className="tree-toggle tree-toggle--leaf" aria-hidden="true">·</span>
      )}
      {isDir ? (
        <button
          className="tree-label"
          onClick={() => onSelect(node)}
          title={node.path}
        >
          <span className="tree-name">{displayName}</span>
          <span className="tree-size">{formatBytes(node.subtree_size)}</span>
        </button>
      ) : (
        <div className="tree-label tree-label--file" title={node.path}>
          <span className="tree-name">{displayName}</span>
          <span className="tree-size">{formatBytes(node.subtree_size)}</span>
        </div>
      )}
    </div>
  );
}

function TreeView({
  rootCount,
  visibleRows,
  totalSize,
  expandedIds,
  loadingIds,
  selectedRecordIndex,
  treeError,
  sourceKind,
  onToggleExpand,
  onSelect,
}: {
  rootCount: number;
  visibleRows: VisibleTreeRow[];
  totalSize: number;
  expandedIds: Set<number>;
  loadingIds: Set<number>;
  selectedRecordIndex: number | undefined;
  treeError: string | null;
  sourceKind: SourceKind | null;
  onToggleExpand: (node: TreeNode) => void;
  onSelect: (node: TreeNode) => void;
}) {
  return (
    <aside className="folder-nav">
      <div className="folder-nav-header">Folders</div>
      <div className="folder-nav-list">
        {visibleRows.length === 0 ? (
          <p className="empty-note">
            No root entries available. Run a live scan to load the folder tree.
          </p>
        ) : (
          visibleRows.map((row) =>
            row.isEmpty ? (
              <div
                key={`empty-${row.node.record_index}`}
                className="tree-empty"
                style={{ paddingLeft: 8 + row.depth * 16 }}
              >
                (empty)
              </div>
            ) : row.nodeError ? (
              <div
                key={`error-${row.node.record_index}`}
                className="tree-node-error"
                style={{ paddingLeft: 8 + row.depth * 16 }}
              >
                Failed to load children: {row.nodeError}
              </div>
            ) : row.largeWarning !== undefined ? (
              <div
                key={`large-${row.node.record_index}`}
                className="tree-large-warning"
                style={{ paddingLeft: 8 + row.depth * 16 }}
              >
                Large folder: {formatNumber(row.largeWarning)} children loaded.
                Virtual scrolling is not enabled yet.
              </div>
            ) : (
              <TreeNodeRow
                key={row.node.record_index}
                node={row.node}
                depth={row.depth}
                totalSize={totalSize}
                expandedIds={expandedIds}
                loadingIds={loadingIds}
                selectedRecordIndex={selectedRecordIndex}
                onToggleExpand={onToggleExpand}
                onSelect={onSelect}
              />
            )
          )
        )}
      </div>
      {treeError && (
        <div className={`folder-nav-footer ${sourceKind === "cached" ? "folder-nav-footer--cached-note" : "folder-nav-footer--error"}`}>{treeError}</div>
      )}
      <div className={visibleRows.length >= LARGE_TREE_THRESHOLD
        ? "folder-nav-footer folder-nav-footer--warn"
        : "folder-nav-footer"}>
        Root children: {rootCount} · Visible rows: {formatNumber(visibleRows.length)}
        {visibleRows.length >= LARGE_TREE_THRESHOLD && " — consider collapsing folders."}
      </div>
    </aside>
  );
}

function SelectedFolderCard({
  dir,
  reclaimable,
  reclaimableLoading,
  reclaimableError,
  sourceKind,
  onOpenExplorer,
  onCopyError,
}: {
  dir: DirectoryEntry;
  reclaimable: ReclaimableSummary | null;
  reclaimableLoading: boolean;
  reclaimableError: string | null;
  sourceKind: SourceKind | null;
  onOpenExplorer: (path: string) => void;
  onCopyError: (msg: string) => void;
}) {
  const confidenceClass = reclaimable
    ? `confidence-badge confidence-badge--${reclaimable.confidence.toLowerCase()}`
    : "confidence-badge";

  return (
    <div className="selected-folder-card">
      <div className="selected-folder-header">
        <div>
          <div className="selected-folder-label">Selected folder</div>
          <div className="selected-folder-path">{dir.path}</div>
        </div>
        <div className="selected-folder-actions">
          <button className="btn" onClick={() => onOpenExplorer(dir.path)}>
            Open folder
          </button>
          <CopyButton text={dir.path} onError={onCopyError} />
        </div>
      </div>
      <div className="selected-folder-stats">
        <span title="Estimated allocated-style total for this folder subtree.">
          Subtree estimate: <strong>{formatBytes(dir.subtree_size)}</strong>
        </span>
        <span title="Estimated allocated-style total for files directly in this folder.">
          Direct files estimate: <strong>{formatBytes(dir.direct_file_size)}</strong>
        </span>
        <span>Children: <strong>{formatNumber(dir.child_count)}</strong></span>
      </div>
      {(reclaimableLoading || reclaimable !== null || reclaimableError !== null || sourceKind === "cached") && (
        <div className="reclaimable-section">
          {reclaimableLoading ? (
            <div className="reclaimable-loading">Estimated reclaimable: loading…</div>
          ) : reclaimableError ? (
            <div className="reclaimable-unavailable">Reclaimable estimate unavailable</div>
          ) : reclaimable ? (
            <>
              <div className="reclaimable-header">
                <span className="reclaimable-title">Estimated reclaimable</span>
                <span className={confidenceClass}>{reclaimable.confidence}</span>
              </div>
              <div className={reclaimable.not_recommended
                ? "reclaimable-estimate reclaimable-estimate--not-recommended"
                : "reclaimable-estimate"}>
                {reclaimable.not_recommended
                  ? "Not recommended as deletion target"
                  : formatBytes(reclaimable.wof_adjusted_bytes)}
              </div>
              {!reclaimable.not_recommended && (
                <div className="reclaimable-range">
                  {reclaimable.confidence === "High" &&
                   (reclaimable.range_upper - reclaimable.range_lower) < reclaimable.range_upper * 0.01
                    ? "Range: tight (within 1%)"
                    : `Range: ${formatBytes(reclaimable.range_lower)} – ${formatBytes(reclaimable.range_upper)}`}
                </div>
              )}
              <div className="reclaimable-basis" title={reclaimable.basis}>{reclaimable.basis}</div>
              <div className="reclaimable-caution" title={reclaimable.caution}>{reclaimable.caution}</div>
            </>
          ) : sourceKind === "cached" ? (
            <div className="reclaimable-cached-note">Reclaimable details are available after refresh completes.</div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function DirectoriesTable({ rows, title }: { rows: DirectoryEntry[]; title: React.ReactNode }) {
  return (
    <section className="table-section">
      <div className="section-header">
        <h2>{title}</h2>
        <span>{rows.length} rows</span>
      </div>
      <div className="table-wrap">
        <table className="directories-table">
          <thead>
            <tr>
              <th>Path</th>
              <th className="numeric" title="Estimated allocated-style size for the subtree.">
                Est. allocated
              </th>
              <th className="numeric" title="Estimated allocated-style size for direct files.">
                Direct file est.
              </th>
              <th className="numeric">Children</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.record_index}>
                <td className="path">{row.path}</td>
                <td className="numeric">{formatBytes(row.subtree_size)}</td>
                <td className="numeric">{formatBytes(row.direct_file_size)}</td>
                <td className="numeric">{formatNumber(row.child_count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FilesTable({
  rows,
  title,
  onOpenLocation,
  onSelectFile,
  onCopyError,
}: {
  rows: FileEntry[];
  title: React.ReactNode;
  onOpenLocation: (path: string) => void;
  onSelectFile: (path: string) => void;
  onCopyError: (msg: string) => void;
}) {
  return (
    <section className="table-section">
      <div className="section-header">
        <h2>{title}</h2>
        <span>{rows.length} rows</span>
      </div>
      <div className="table-wrap">
        {rows.length === 0 ? (
          <p className="empty-note">
            No top files under this folder.{" "}
            Top entries shown are global — not scoped to this folder.
          </p>
        ) : (
          <table className="files-table">
            <thead>
              <tr>
                <th>Path</th>
                <th className="numeric" title="Estimated allocated-style file size.">
                  Est. allocated
                </th>
                <th className="actions-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.record_index}>
                  <td className="path">{row.path}</td>
                  <td className="numeric">{formatBytes(row.final_allocated_size)}</td>
                  <td className="actions-col">
                    <div className="actions-cell">
                      <button
                        className="btn btn-sm"
                        onClick={() => onOpenLocation(getParentDir(row.path))}
                      >
                        Open folder
                      </button>
                      <button
                        className="btn btn-sm"
                        onClick={() => onSelectFile(row.path)}
                      >
                        Select file
                      </button>
                      <CopyButton text={row.path} onError={onCopyError} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function DirectChildrenPanel({
  dir,
  children,
  isLoading,
  error,
  sourceKind,
  sortKey,
  sortDir,
  onSortKeyChange,
  onSortDirChange,
  ancestorDirs,
  onNavigateToDir,
  onNavigate,
  onOpenExplorer,
  onSelectFile,
  onCopyError,
}: {
  dir: DirectoryEntry;
  children: TreeNode[] | undefined;
  isLoading: boolean;
  error: string | null;
  sourceKind: SourceKind | null;
  sortKey: DirectChildrenSortKey;
  sortDir: SortDirection;
  onSortKeyChange: (key: DirectChildrenSortKey) => void;
  onSortDirChange: (dir: SortDirection) => void;
  ancestorDirs: DirectoryEntry[];
  onNavigateToDir: (dir: DirectoryEntry) => void;
  onNavigate: (node: TreeNode) => void;
  onOpenExplorer: (path: string) => void;
  onSelectFile: (path: string) => void;
  onCopyError: (msg: string) => void;
}) {

  const [filterText, setFilterText] = useState("");
  const filterTrimmed = filterText.trim();

  useEffect(() => {
    setFilterText("");
  }, [dir.record_index]);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setContextMenu(null);
  }, [dir.record_index]);

  useEffect(() => {
    if (!contextMenu) return;
    function handleMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    }
    window.addEventListener("mousedown", handleMouseDown);
    return () => window.removeEventListener("mousedown", handleMouseDown);
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setContextMenu(null);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [contextMenu]);

  function handleContextMenu(e: React.MouseEvent<HTMLDivElement>, node: TreeNode) {
    e.preventDefault();
    e.stopPropagation();
    const menuWidth = 160;
    const menuHeight = 68;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 4);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 4);
    setContextMenu({ node, x, y });
  }

  const filtered = useMemo(() => {
    if (!children) return [];
    if (!filterTrimmed) return children;
    const lower = filterTrimmed.toLowerCase();
    return children.filter(
      (n) =>
        n.name.toLowerCase().includes(lower) ||
        n.path.toLowerCase().includes(lower),
    );
  }, [children, filterTrimmed]);

  const sorted = useMemo(
    () => sortDirectChildren(filtered, sortKey, sortDir),
    [filtered, sortKey, sortDir],
  );

  let body: React.ReactNode;
  if (isLoading) {
    body = <p className="direct-children-note">Loading direct children…</p>;
  } else if (error) {
    body = <p className="direct-children-note direct-children-note--error">{error}</p>;
  } else if (sourceKind !== "live") {
    body = (
      <p className="direct-children-note">
        {sourceKind === "cached"
          ? "Last scan result only. Full folder expansion will be available after refresh."
          : "Direct children are available after a live scan in the Tauri app."}
      </p>
    );
  } else if (children === undefined) {
    body = <p className="direct-children-note">Fetching…</p>;
  } else if (children.length === 0) {
    body = <p className="direct-children-note">This folder has no children.</p>;
  } else if (filterTrimmed && sorted.length === 0) {
    body = (
      <p className="direct-children-note">
        No direct children match &ldquo;{filterTrimmed}&rdquo;.
      </p>
    );
  } else {
    body = (
      <div className="direct-children-list">
        {sorted.map((node) => (
          <div
            key={node.record_index}
            className={`direct-child-row${node.is_directory ? " direct-child-row--dir" : ""}${contextMenu?.node.record_index === node.record_index ? " direct-child-row--context" : ""}`}
            onClick={node.is_directory ? () => onNavigate(node) : undefined}
            onContextMenu={(e) => handleContextMenu(e, node)}
            title={node.is_directory ? `Open ${node.path}` : undefined}
          >
            <span
              className={`direct-child-badge direct-child-badge--${node.is_directory ? "dir" : "file"}`}
            >
              {node.is_directory ? "DIR" : "FILE"}
            </span>
            <span className="direct-child-name">
              {node.name || node.path}
            </span>
            <span
              className="direct-child-size"
              title="Estimated allocated-style size."
            >
              {formatBytes(node.subtree_size)}
            </span>
            {/* stopPropagation prevents action clicks from firing row navigation */}
            <div className="direct-child-actions" onClick={(e) => e.stopPropagation()}>
              <button
                className="btn btn-sm"
                onClick={() =>
                  onOpenExplorer(node.is_directory ? node.path : getParentDir(node.path))
                }
              >
                Open folder
              </button>
              {!node.is_directory && (
                <button className="btn btn-sm" onClick={() => onSelectFile(node.path)}>
                  Select file
                </button>
              )}
              <CopyButton text={node.path} onError={onCopyError} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="direct-children-panel">
      <div className="direct-children-header">
        <span className="direct-children-title">
          Direct children of{" "}
          <span className="heading-path">{dir.path}</span>
        </span>
        <div className="direct-children-controls">
          <input
            className="filter-input"
            type="text"
            placeholder="Filter…"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
          />
          {filterText && (
            <button
              className="filter-clear-btn"
              onClick={() => setFilterText("")}
              title="Clear filter"
              aria-label="Clear filter"
            >
              ×
            </button>
          )}
          {children !== undefined && (
            <span className="direct-children-count">
              {filterTrimmed
                ? `${formatNumber(filtered.length)} of ${formatNumber(children.length)}`
                : formatNumber(children.length)}
            </span>
          )}
          <label className="sort-label">
            Sort
            <select
              className="sort-select"
              value={sortKey}
              onChange={(e) => onSortKeyChange(e.target.value as DirectChildrenSortKey)}
            >
              <option value="size">Est. size</option>
              <option value="name">Name</option>
              <option value="type">Type</option>
            </select>
          </label>
          <button
            className="btn btn-sm sort-dir-btn"
            onClick={() => onSortDirChange(sortDir === "desc" ? "asc" : "desc")}
            title={sortDir === "desc" ? "Descending — click for ascending" : "Ascending — click for descending"}
          >
            {sortDir === "desc" ? "↓" : "↑"}
          </button>
        </div>
      </div>
      {sourceKind === "live" && ancestorDirs.length > 0 && (
        <div className="parent-breadcrumb">
          <button
            className="parent-breadcrumb-up"
            onClick={() => onNavigateToDir(ancestorDirs[ancestorDirs.length - 1])}
            title="Go to parent folder"
            aria-label="Go to parent folder"
          >
            Up:
          </button>
          {ancestorDirs.map((ancestor, idx) => (
            <React.Fragment key={ancestor.path}>
              {idx > 0 && <span className="parent-breadcrumb-separator">›</span>}
              <button
                className="parent-breadcrumb-item"
                onClick={() => onNavigateToDir(ancestor)}
                title={ancestor.path}
              >
                {breadcrumbLabel(ancestor.path)}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
      {body}
      {contextMenu && createPortal(
        <div
          ref={menuRef}
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            className="context-menu-item"
            onClick={() => {
              onOpenExplorer(
                contextMenu.node.is_directory
                  ? contextMenu.node.path
                  : getParentDir(contextMenu.node.path),
              );
              setContextMenu(null);
            }}
          >
            {contextMenu.node.is_directory ? "Open folder" : "Open containing folder"}
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              if (navigator.clipboard) {
                navigator.clipboard.writeText(contextMenu.node.path).catch((err: unknown) => {
                  onCopyError(err instanceof Error ? err.message : "Failed to copy path.");
                });
              } else {
                onCopyError("Clipboard is not available.");
              }
              setContextMenu(null);
            }}
          >
            Copy path
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

function App() {
  const scanTimingRef = useRef<{ start: number; invokeStart: number } | null>(null);
  const currentScanIdRef = useRef<string | null>(null);
  const scanStartMsRef = useRef<number | null>(null);
  const lastProgressRef = useRef<ScanProgress | null>(null);
  const pendingProgressTimerRef = useRef<number | null>(null);
  const pendingProgressRef = useRef<ScanProgress | null>(null);
  const updatedBannerTimerRef = useRef<number | null>(null);
  const bannerGenerationRef = useRef(0);
  const [scanInvokeMs, setScanInvokeMs] = useState<number | null>(null);

  const [data, setData] = useState<DiskInsightOutput | null>(null);
  const [isLoading, setIsLoading] = useState(import.meta.env.DEV);
  const [loadingMsg, setLoadingMsg] = useState("Loading sample data...");
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [localElapsedMs, setLocalElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isScanError, setIsScanError] = useState(false);
  const [sourceKind, setSourceKind] = useState<SourceKind | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [cacheBanner, setCacheBanner] = useState<CacheBannerState | null>(null);
  const [drives, setDrives] = useState<DriveInfo[]>([
    { letter: "C", root: "C:\\", display: "C:", drive_type: "unknown" },
  ]);
  const [driveInput, setDriveInput] = useState(
    _initialPrefs.drive ?? "C",
  );
  const [topN, setTopN] = useState(
    TOP_OPTIONS.includes(_initialPrefs.topCount ?? -1)
      ? (_initialPrefs.topCount as number)
      : 100,
  );
  const [scanTopN, setScanTopN] = useState<number | null>(null);
  const [storagePolicy, setStoragePolicy] = useState(
    _initialPrefs.storagePolicy === "wof_adjusted" ? "wof_adjusted" : "current",
  );
  const [directChildrenSortKey, setDirectChildrenSortKey] = useState<DirectChildrenSortKey>(
    (["size", "name", "type"] as DirectChildrenSortKey[]).includes(
      _initialPrefs.directChildrenSortKey as DirectChildrenSortKey,
    )
      ? (_initialPrefs.directChildrenSortKey as DirectChildrenSortKey)
      : "size",
  );
  const [directChildrenSortDir, setDirectChildrenSortDir] = useState<SortDirection>(
    _initialPrefs.directChildrenSortDirection === "asc" ? "asc" : "desc",
  );
  const [selectedDir, setSelectedDir] = useState<DirectoryEntry | undefined>(undefined);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [loadingIds, setLoadingIds] = useState<Set<number>>(new Set());
  const [childrenByParent, setChildrenByParent] = useState<Record<number, TreeNode[]>>({});
  const [childrenErrors, setChildrenErrors] = useState<Record<number, string>>({});
  const [treeError, setTreeError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [selectedChildrenLoading, setSelectedChildrenLoading] = useState(false);
  const [selectedChildrenError, setSelectedChildrenError] = useState<string | null>(null);
  const [reclaimable, setReclaimable] = useState<ReclaimableSummary | null>(null);
  const [reclaimableLoading, setReclaimableLoading] = useState(false);
  const [reclaimableError, setReclaimableError] = useState<string | null>(null);

  const visibleRows = useMemo(
    () => buildVisibleRows(data?.root_children ?? [], expandedIds, childrenByParent, childrenErrors),
    [data?.root_children, expandedIds, childrenByParent, childrenErrors],
  );

  const selectedAncestorDirs = useMemo(
    (): DirectoryEntry[] =>
      selectedDir && data
        ? buildAncestorEntries(selectedDir.path, data, childrenByParent)
        : [],
    [selectedDir, data, childrenByParent],
  );

  function clearUpdatedBannerTimer() {
    bannerGenerationRef.current += 1;
    if (updatedBannerTimerRef.current !== null) {
      window.clearTimeout(updatedBannerTimerRef.current);
      updatedBannerTimerRef.current = null;
    }
  }

  function showUpdatedBanner() {
    clearUpdatedBannerTimer();
    const generation = bannerGenerationRef.current;
    setCacheBanner({ kind: "live" });
    updatedBannerTimerRef.current = window.setTimeout(() => {
      if (generation !== bannerGenerationRef.current) return;
      updatedBannerTimerRef.current = null;
      setCacheBanner((current) => (current?.kind === "live" ? null : current));
    }, UPDATED_BANNER_DISMISS_MS);
  }

  function clearCacheBanner() {
    clearUpdatedBannerTimer();
    setCacheBanner(null);
  }

  function clearPendingProgressLatch() {
    if (pendingProgressTimerRef.current !== null) {
      window.clearTimeout(pendingProgressTimerRef.current);
      pendingProgressTimerRef.current = null;
    }
    pendingProgressRef.current = null;
  }

  function showProgress(p: ScanProgress) {
    lastProgressRef.current = p;
    setScanProgress(p);
  }

  function resetProgressLatch() {
    clearPendingProgressLatch();
    lastProgressRef.current = null;
  }

  function shouldLatchReadingMftCompletion(
    prev: ScanProgress | null,
    next: ScanProgress,
  ): prev is ScanProgress & { current: number; total: number; unit: string } {
    return (
      hasByteProgress(prev) &&
      prev.phase === "reading_mft" &&
      next.phase !== "reading_mft" &&
      next.phase !== "done"
    );
  }

  function startProgressCompletionHold(scanId: string) {
    pendingProgressTimerRef.current = window.setTimeout(() => {
      pendingProgressTimerRef.current = null;
      const pending = pendingProgressRef.current;
      pendingProgressRef.current = null;
      if (!pending || pending.scan_id !== currentScanIdRef.current || scanId !== currentScanIdRef.current) {
        return;
      }
      showProgress(pending);
    }, PHASE_COMPLETION_LATCH_MS);
  }

  function showProgressWithCompletionLatch(p: ScanProgress) {
    if (p.phase === "done") {
      clearPendingProgressLatch();
      showProgress(p);
      return;
    }

    if (pendingProgressTimerRef.current !== null) {
      pendingProgressRef.current = p;
      return;
    }

    if (
      p.phase === "reading_mft" &&
      hasByteProgress(p) &&
      p.current >= p.total
    ) {
      showProgress({ ...p, current: p.total });
      startProgressCompletionHold(p.scan_id);
      return;
    }

    const prev = lastProgressRef.current;
    if (shouldLatchReadingMftCompletion(prev, p)) {
      const completed: ScanProgress = {
        ...prev,
        current: prev.total,
      };
      showProgress(completed);
      pendingProgressRef.current = p;
      startProgressCompletionHold(p.scan_id);
      return;
    }

    showProgress(p);
  }

  useEffect(() => {
    if (!selectedDir || sourceKind !== "live") {
      setSelectedChildrenLoading(false);
      setSelectedChildrenError(null);
      return;
    }
    const id = selectedDir.record_index;
    if (childrenByParent[id] !== undefined) {
      setSelectedChildrenLoading(false);
      setSelectedChildrenError(null);
      return;
    }
    // Drive root: use already-loaded root_children instead of a Tauri call
    if (isDriveRoot(selectedDir.path) && data?.root_children !== undefined) {
      setChildrenByParent((prev) => ({ ...prev, [id]: data.root_children! }));
      setSelectedChildrenLoading(false);
      setSelectedChildrenError(null);
      return;
    }
    let cancelled = false;
    setSelectedChildrenLoading(true);
    setSelectedChildrenError(null);
    getChildren(id)
      .then((kids) => {
        if (cancelled) return;
        setChildrenByParent((prev) => ({ ...prev, [id]: kids }));
        setSelectedChildrenLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSelectedChildrenError(err instanceof Error ? err.message : String(err));
        setSelectedChildrenLoading(false);
      });
    return () => { cancelled = true; };
    // childrenByParent intentionally omitted: cache check at effect start is sufficient
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDir, sourceKind]);

  useEffect(() => {
    if (!selectedDir || !data || sourceKind !== "live") {
      setReclaimable(null);
      setReclaimableError(null);
      setReclaimableLoading(false);
      return;
    }
    let cancelled = false;
    setReclaimableLoading(true);
    setReclaimableError(null);
    getReclaimableSummary(selectedDir.record_index, selectedDir.path, data.summary.drive)
      .then((summary) => {
        if (cancelled) return;
        console.log("[reclaimable-ui] received", summary.confidence, summary.basis);
        setReclaimable(summary);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setReclaimable(null);
        setReclaimableError(String(err));
      })
      .finally(() => {
        if (!cancelled) setReclaimableLoading(false);
      });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDir?.record_index, selectedDir?.path, data?.summary.drive, sourceKind]);

  function runLoad(
    loader: () => Promise<DiskInsightOutput>,
    msg: string,
    isScan: boolean,
    kind: SourceKind,
    usedTopN?: number,
  ) {
    const invokeStart = performance.now();
    if (isScan) {
      const t0 = scanTimingRef.current?.start ?? invokeStart;
      scanTimingRef.current = { start: t0, invokeStart };
      console.log(`[perf-ui] invoke start  t+${(invokeStart - t0).toFixed(0)} ms`);
    }
    if (isScan) {
      resetProgressLatch();
      setScanProgress(null);
    }
    if (!isScan) {
      resetProgressLatch();
      scanStartMsRef.current = null;
    }
    setIsLoading(true);
    setLoadingMsg(msg);
    setError(null);
    setIsScanError(false);
    setStatusMessage(null);
    clearCacheBanner();
    setExpandedIds(new Set());
    setLoadingIds(new Set());
    setChildrenByParent({});
    setChildrenErrors({});
    setTreeError(null);
    setSelectedChildrenLoading(false);
    setSelectedChildrenError(null);
    setReclaimable(null);
    setReclaimableLoading(false);
    setReclaimableError(null);
    loader()
      .then((json) => {
        if (isScan && scanTimingRef.current) {
          const t0 = scanTimingRef.current.start;
          const now = performance.now();
          const invoke_ms = now - scanTimingRef.current.invokeStart;
          setScanInvokeMs(invoke_ms);
          console.log(
            `[perf-ui] invoke resolved  t+${(now - t0).toFixed(0)} ms` +
            `  invoke_ms=${invoke_ms.toFixed(0)}`,
          );
        }
        setData(json);
        setSourceKind(kind);
        setLastUpdated(new Date());
        if (usedTopN !== undefined) setScanTopN(usedTopN);
        setSelectedDir(json.top_directories[0]);
        if (isScan && scanTimingRef.current) {
          const t0 = scanTimingRef.current.start;
          console.log(`[perf-ui] setData called  t+${(performance.now() - t0).toFixed(0)} ms`);
        }
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        clearPendingProgressLatch();
        setError(err instanceof Error ? err.message : String(err));
        setIsScanError(isScan);
        setIsLoading(false);
      });
  }

  async function runScanWithCache(
    drive: string,
    top: number,
    policy: string,
    msg: string,
  ) {
    const flowStart = performance.now();
    const t0 = scanTimingRef.current?.start ?? flowStart;
    scanTimingRef.current = { start: t0, invokeStart: flowStart };

    resetProgressLatch();
    setScanProgress(null);
    setIsLoading(true);
    setLoadingMsg(msg);
    setError(null);
    setIsScanError(false);
    setStatusMessage(null);
    clearCacheBanner();
    setExpandedIds(new Set());
    setLoadingIds(new Set());
    setChildrenByParent({});
    setChildrenErrors({});
    setTreeError(null);
    setSelectedChildrenLoading(false);
    setSelectedChildrenError(null);
    setReclaimable(null);
    setReclaimableLoading(false);
    setReclaimableError(null);

    let showedCachedResult = false;
    try {
      const cacheStart = performance.now();
      const cached = await loadScanCache(drive, policy);
      const cacheApplyStart = performance.now();
      if (cached) {
        setData(cached.output);
        setSourceKind("cached");
        setLastUpdated(new Date(cached.created_at_unix_ms));
        setScanTopN(top);
        setSelectedDir(cached.output.top_directories[0]);
        clearUpdatedBannerTimer();
        setCacheBanner({
          kind: "cached_refreshing",
          createdAtUnixMs: cached.created_at_unix_ms,
          cacheLoadMs: cached.cache_load_ms,
          cacheFileSizeBytes: cached.cache_file_size_bytes,
          cachePath: cached.cache_path,
        });
        showedCachedResult = true;
        const cacheApplyMs = performance.now() - cacheApplyStart;
        console.log(
          `[cache-ui] cache_hit=true cache_load_ms=${cached.cache_load_ms}` +
          ` cache_apply_ms=${cacheApplyMs.toFixed(1)}` +
          ` cache_file_size_bytes=${cached.cache_file_size_bytes}`,
        );
        requestAnimationFrame(() => {
          console.log(`[cache-ui] cache rendered (rAF)  t+${(performance.now() - t0).toFixed(0)} ms`);
        });
      } else {
        clearCacheBanner();
        console.log(
          `[cache-ui] cache_hit=false cache_probe_ms=${(performance.now() - cacheStart).toFixed(1)}`,
        );
      }
    } catch (err: unknown) {
      clearCacheBanner();
      console.warn("[cache-ui] cache load ignored", err);
    }

    try {
      const scanInvokeStart = performance.now();
      scanTimingRef.current = { start: t0, invokeStart: scanInvokeStart };
      console.log(`[perf-ui] invoke start  t+${(scanInvokeStart - t0).toFixed(0)} ms`);
      const json = await scanDrive(drive, top, policy);
      if (scanTimingRef.current) {
        const now = performance.now();
        const invokeMs = now - scanTimingRef.current.invokeStart;
        setScanInvokeMs(invokeMs);
        console.log(
          `[perf-ui] invoke resolved  t+${(now - t0).toFixed(0)} ms` +
          `  invoke_ms=${invokeMs.toFixed(0)}`,
        );
      }
      setData(json);
      setSourceKind("live");
      setLastUpdated(new Date());
      setScanTopN(top);
      setSelectedDir(json.top_directories[0]);
      showUpdatedBanner();
      console.log(`[perf-ui] setData called  t+${(performance.now() - t0).toFixed(0)} ms`);
      setIsLoading(false);
    } catch (err: unknown) {
      clearPendingProgressLatch();
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setIsScanError(true);
      if (showedCachedResult) {
        clearUpdatedBannerTimer();
        setCacheBanner({ kind: "refresh_failed", message });
      } else {
        clearCacheBanner();
      }
      setIsLoading(false);
    }
  }

  function handleSelectTreeNode(node: TreeNode) {
    if (!node.is_directory) return;
    setSelectedDir(treeNodeToDirEntry(node));
    setTreeError(null);
  }

  function handleNavigateToDir(dir: DirectoryEntry) {
    setSelectedDir(dir);
    setTreeError(null);
  }

  function handleToggleExpand(node: TreeNode) {
    if (!node.is_directory) return;
    const id = node.record_index;

    // Collapse if already expanded
    if (expandedIds.has(id)) {
      setExpandedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setTreeError(null);
      return;
    }

    // Expand from cache
    if (childrenByParent[id]) {
      setExpandedIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      setTreeError(null);
      return;
    }

    // Duplicate request guard: do not fire if already loading
    if (loadingIds.has(id)) return;

    // Need to fetch — only available on live scan
    if (sourceKind !== "live") {
      setTreeError(
        sourceKind === "cached"
          ? "Last scan result only. Full folder expansion will be available after refresh."
          : "Live scan required to load children. Run a scan in the Tauri app.",
      );
      return;
    }

    // Clear any previous per-node error before retrying
    if (childrenErrors[id] !== undefined) {
      setChildrenErrors((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
    setTreeError(null);
    setLoadingIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });

    getChildren(id)
      .then((children) => {
        setChildrenByParent((prev) => ({ ...prev, [id]: children }));
        setExpandedIds((prev) => {
          const next = new Set(prev);
          next.add(id);
          return next;
        });
      })
      .catch((err: unknown) => {
        setChildrenErrors((prev) => ({
          ...prev,
          [id]: err instanceof Error ? err.message : String(err),
        }));
      })
      .finally(() => {
        setLoadingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      });
  }

  function handleOpenExplorer(path: string) {
    openInExplorer(path).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
      setIsScanError(false);
    });
  }

  function handleSelectFile(path: string) {
    selectInExplorer(path)
      .then(() => {
        setError(null);
        const fileName = getFileName(path);
        setStatusMessage(`Explorer selection requested: ${fileName}`);
        setTimeout(() => setStatusMessage(null), 3000);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setIsScanError(false);
      });
  }

  function handleCopyError(msg: string) {
    setError(msg);
    setIsScanError(false);
  }

  function handleScan() {
    const t0 = performance.now();
    resetProgressLatch();
    scanTimingRef.current = { start: t0, invokeStart: t0 };
    currentScanIdRef.current = null;
    scanStartMsRef.current = t0;
    setScanInvokeMs(null);
    setLocalElapsedMs(0);
    console.log(`[perf-ui] scan click  drive=${driveInput} policy=${storagePolicy}`);
    const drive = parseDriveLetter(driveInput);
    if (!drive) {
      setError("Drive must be a single letter (A–Z).");
      setIsScanError(false);
      return;
    }
    const policyNote = storagePolicy === "wof_adjusted" ? " [WOF-adjusted estimate]" : "";
    const msg = `Scanning ${drive}: — reading NTFS metadata. Top ${topN} entries.${policyNote}`;
    void runScanWithCache(drive, topN, storagePolicy, msg);
  }

  useEffect(() => {
    savePreferences({
      drive: driveInput,
      topCount: topN,
      storagePolicy,
      directChildrenSortKey,
      directChildrenSortDirection: directChildrenSortDir,
    });
  }, [driveInput, topN, storagePolicy, directChildrenSortKey, directChildrenSortDir]);

  // K-1b: log when scan data is first rendered to DOM
  useEffect(() => {
    if (!data || sourceKind !== "live" || !scanTimingRef.current) return;
    const t0 = scanTimingRef.current.start;
    requestAnimationFrame(() => {
      const ms = (performance.now() - t0).toFixed(0);
      console.log(`[perf-ui] data rendered (rAF)  t+${ms} ms  files=${data.summary.files}`);
      requestAnimationFrame(() => {
        const ms2 = (performance.now() - t0).toFixed(0);
        console.log(`[perf-ui] data rendered (rAF+1)  t+${ms2} ms`);
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // K-1b: log when direct children for the selected folder become available
  useEffect(() => {
    if (!selectedDir || sourceKind !== "live" || !scanTimingRef.current) return;
    const id = selectedDir.record_index;
    const kids = childrenByParent[id];
    if (kids === undefined) return;
    const t0 = scanTimingRef.current.start;
    const ms = (performance.now() - t0).toFixed(0);
    console.log(
      `[perf-ui] direct children ready  t+${ms} ms  path=${selectedDir.path}  count=${kids.length}`,
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDir, childrenByParent]);

  // K-2b: listen for scan progress events from the Rust/Tauri backend
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const unlistenPromise = listen<ScanProgress>("scan_progress", (event) => {
      const p = event.payload;
      // Accept events: if no current scan_id yet, adopt this event's scan_id.
      if (currentScanIdRef.current === null) {
        currentScanIdRef.current = p.scan_id;
      } else if (p.scan_id !== currentScanIdRef.current) {
        return;
      }
      showProgressWithCompletionLatch(p);
    });
    return () => {
      clearPendingProgressLatch();
      unlistenPromise.then((f) => f());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // K-2b: local elapsed timer — ticks every 500 ms during a real scan.
  // Provides elapsed display even if Tauri events don't arrive.
  useEffect(() => {
    return () => {
      clearUpdatedBannerTimer();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isLoading || scanStartMsRef.current === null) return;
    const t0 = scanStartMsRef.current;
    const id = setInterval(() => {
      setLocalElapsedMs(Math.floor(performance.now() - t0));
    }, 500);
    return () => clearInterval(id);
  }, [isLoading]);

  useEffect(() => {
    if (import.meta.env.DEV) {
      runLoad(loadSampleData, "Loading sample data...", false, "sample");
    }
    if (isTauriRuntime()) {
      invoke<DriveInfo[]>("list_drives")
        .then((detected) => {
          if (detected.length > 0) {
            setDrives(detected);
            const savedDrive = _initialPrefs.drive;
            const savedValid =
              savedDrive != null && detected.some((d) => d.letter === savedDrive);
            if (!savedValid) {
              const hasC = detected.some((d) => d.letter === "C");
              setDriveInput(hasC ? "C" : detected[0].letter);
            }
          }
        })
        .catch(() => {
          // Keep C fallback silently
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const driveLabel = parseDriveLetter(driveInput) ?? driveInput.slice(0, 1).toUpperCase();
  const scanPhaseText = scanProgress ? phaseLabel(scanProgress.phase) : "Starting scan";
  const scanElapsedMs = scanProgress ? scanProgress.elapsed_ms : localElapsedMs;
  const scanDriveLabel = scanProgress?.drive ?? `${driveLabel}:`;
  const scanHasProgress =
    scanProgress?.current != null &&
    scanProgress?.total != null &&
    scanProgress.total > 0;
  const scanProgressPercent = scanHasProgress
    ? Math.max(0, Math.min(100, (scanProgress.current! / scanProgress.total!) * 100))
    : null;
  const scanProgressText = scanHasProgress
    ? scanProgress.unit === "bytes"
      ? `${formatBytes(scanProgress.current!)} / ${formatBytes(scanProgress.total!)}`
      : scanProgress.unit === "records"
        ? `${formatRecords(scanProgress.current!)} / ${formatRecords(scanProgress.total!)} records`
        : `${scanProgress.current!.toLocaleString()} / ${scanProgress.total!.toLocaleString()} ${scanProgress.unit ?? ""}`.trim()
    : null;
  const scanSegmentText =
    scanProgress?.phase === "reading_mft" &&
    scanProgress.segment_current != null &&
    scanProgress.segment_total != null &&
    scanProgress.segment_total > 0
      ? `segment ${scanProgress.segment_current.toLocaleString()}/${scanProgress.segment_total.toLocaleString()}`
      : null;

  return (
    <main className="app">
      <header className="app-header">
        <h1>disk-insight</h1>
        <div className="toolbar">
          <label className="toolbar-label">
            Drive
            <select
              className="top-select"
              value={driveInput}
              onChange={(e) => setDriveInput(e.target.value)}
              disabled={isLoading}
            >
              {drives.map((d) => (
                <option key={d.letter} value={d.letter}>{d.display}</option>
              ))}
            </select>
          </label>
          <label className="toolbar-label">
            Top
            <select
              className="top-select"
              value={topN}
              onChange={(e) => setTopN(Number(e.target.value))}
              disabled={isLoading}
            >
              {TOP_OPTIONS.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          <label className="toolbar-label">
            Size metric
            <select
              className="top-select size-metric-select"
              value={storagePolicy}
              onChange={(e) => setStoragePolicy(e.target.value)}
              disabled={isLoading}
              title="Compare estimates with Explorer &quot;Size on disk&quot; or WizTree &quot;Allocated&quot;, not Explorer &quot;Size&quot;."
            >
              <option value="current">Current allocation estimate</option>
              <option value="wof_adjusted">WOF-adjusted estimate (experimental)</option>
            </select>
          </label>
          {storagePolicy === "wof_adjusted" && (
            <span
              className="policy-warning"
              title="Experimental WOF-aware estimate. It may be closer to WizTree &quot;Allocated&quot; for WOF-compressed files."
            >
              Experimental WOF-aware estimate. Hard links and WinSxS are not fully corrected.
            </span>
          )}
          <div className="toolbar-separator" />
          {import.meta.env.DEV && (
            <button
              className="btn"
              onClick={() =>
                runLoad(loadSampleData, "Loading sample data...", false, "sample")
              }
              disabled={isLoading}
            >
              Load sample
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={handleScan}
            disabled={isLoading}
          >
            Scan {driveLabel}:
          </button>
        </div>
      </header>

      {/* Scanning strip: shown when a real scan is in progress (data may still be null on first scan) */}
      {isLoading && scanStartMsRef.current !== null && (
        <div className="scanning-strip" role="status" aria-live="polite">
          <div className="scanning-strip-row">
            <span className="scanning-spinner" aria-hidden="true" />
            <span className="scanning-strip-drive">Scanning {scanDriveLabel}</span>
            {scanStartMsRef.current !== null && (
              <>
                <span className="scanning-strip-sep" aria-hidden="true">—</span>
                <span className="scanning-strip-phase">{scanPhaseText}</span>
                {scanProgressText && (
                  <>
                    <span className="scanning-strip-amount">{scanProgressText}</span>
                    <span className="scanning-strip-sep" aria-hidden="true">·</span>
                    <span className="scanning-strip-percent">{scanProgressPercent!.toFixed(0)}%</span>
                    {scanSegmentText && (
                      <>
                        <span className="scanning-strip-sep" aria-hidden="true">·</span>
                        <span className="scanning-strip-segment">{scanSegmentText}</span>
                      </>
                    )}
                  </>
                )}
                <span className="scanning-strip-sep" aria-hidden="true">·</span>
                <span className="scanning-strip-elapsed">{formatElapsed(scanElapsedMs)}</span>
              </>
            )}
          </div>
          {scanStartMsRef.current !== null && (
            <div
              className={`scanning-strip-bar${scanHasProgress ? " scanning-strip-bar-determinate" : ""}`}
              aria-hidden="true"
            >
              {scanHasProgress && (
                <div
                  className="scanning-strip-bar-fill"
                  style={{ width: `${scanProgressPercent ?? 0}%` }}
                />
              )}
            </div>
          )}
        </div>
      )}

      {/* Full-page placeholder only when there is no data yet and no real scan running */}
      {isLoading && data === null && scanStartMsRef.current === null && (
        <div className="loading">{loadingMsg}</div>
      )}
      {!isLoading && data === null && (
        <div className="empty-state">
          Select a drive and click <strong>Scan</strong> to analyze disk usage.
        </div>
      )}

      {error && (
        <div className="error">
          <div>{error}</div>
          {isScanError && (
            <div className="error-hint">
              {isTauriRuntime()
                ? "Please run the app as administrator (required for MFT access)."
                : "Run `npm run tauri dev` or use the built app."}
            </div>
          )}
        </div>
      )}

      {statusMessage && (
        <div className="status-message status-message--success">{statusMessage}</div>
      )}

      <LastScanBanner banner={cacheBanner} />

      {data && (
        <>
          <StatusBar
            sourceKind={sourceKind}
            lastUpdated={lastUpdated}
            data={data}
            isLoading={isLoading}
            scanTopN={scanTopN}
          />
          <SummaryCard summary={data.summary} />
          {data.capacity && <CapacityCard capacity={data.capacity} />}
          {sourceKind === "live" && (
            <PerfBreakdown summary={data.summary} invokeMs={scanInvokeMs} />
          )}
          <div className="content-pane">
            <TreeView
              rootCount={data.root_children?.length ?? 0}
              visibleRows={visibleRows}
              totalSize={data.summary.total_final_allocated}
              expandedIds={expandedIds}
              loadingIds={loadingIds}
              selectedRecordIndex={selectedDir?.record_index}
              treeError={treeError}
              sourceKind={sourceKind}
              onToggleExpand={handleToggleExpand}
              onSelect={handleSelectTreeNode}
            />
            <div className="content-right">
              {selectedDir && (
                <SelectedFolderCard
                  dir={selectedDir}
                  reclaimable={reclaimable}
                  reclaimableLoading={reclaimableLoading}
                  reclaimableError={reclaimableError}
                  sourceKind={sourceKind}
                  onOpenExplorer={handleOpenExplorer}
                  onCopyError={handleCopyError}
                />
              )}
              {selectedDir && (
                <DirectChildrenPanel
                  dir={selectedDir}
                  children={childrenByParent[selectedDir.record_index]}
                  isLoading={selectedChildrenLoading}
                  error={selectedChildrenError}
                  sourceKind={sourceKind}
                  sortKey={directChildrenSortKey}
                  sortDir={directChildrenSortDir}
                  onSortKeyChange={setDirectChildrenSortKey}
                  onSortDirChange={setDirectChildrenSortDir}
                  ancestorDirs={selectedAncestorDirs}
                  onNavigateToDir={handleNavigateToDir}
                  onNavigate={handleSelectTreeNode}
                  onOpenExplorer={handleOpenExplorer}
                  onSelectFile={handleSelectFile}
                  onCopyError={handleCopyError}
                />
              )}
              <DirectoriesTable
                rows={
                  selectedDir
                    ? filterByDir(data.top_directories, selectedDir.path)
                    : data.top_directories
                }
                title={
                  selectedDir && !isDriveRoot(selectedDir.path)
                    ? <>Top directories (scan results) under <span className="heading-path">{selectedDir.path}</span></>
                    : "Top directories"
                }
              />
              <FilesTable
                rows={
                  selectedDir
                    ? filterByDir(data.top_files, selectedDir.path)
                    : data.top_files
                }
                title={
                  selectedDir && !isDriveRoot(selectedDir.path)
                    ? <>Top files (scan results) under <span className="heading-path">{selectedDir.path}</span></>
                    : "Top files"
                }
                onOpenLocation={handleOpenExplorer}
                onSelectFile={handleSelectFile}
                onCopyError={handleCopyError}
              />
            </div>
          </div>
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
