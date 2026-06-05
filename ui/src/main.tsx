import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { classifyCleanupSafety } from "./cleanupSafety";
import "./styles.css";

type Summary = {
  drive: string;
  volume_serial?: string | null;
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
  treeTruncated?: { shown: number; total: number };
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
  | { kind: "refresh_failed"; message: string }
  | { kind: "refresh_cancelled" };
type CleanupRefreshDelta = {
  drive: string;
  beforeFreeBytes: number;
  afterFreeBytes: number;
  deltaBytes: number;
  recycleContext?: boolean;
};
type UnsupportedDriveCapacity = {
  drive: string;
  capacity: DriveCapacity;
  note: string;
};
type DirectChildrenSortKey = "size" | "name" | "type";
type SortDirection = "asc" | "desc";
type TreeReviewView = 'all' | 'large-review' | 'reviewable' | 'caution';
type ReviewCandidate = {
  path: string;
  record_index: number;
  isDirectory: boolean;
  sizeBytes: number;
  categoryLabel: string;
};
interface ReviewListItem {
  path: string;
  name: string;
  parentPath: string;
  isDirectory: boolean;
  sizeBytes: number;
  recordIndex?: number;
  category?: string;
  source: 'tree' | 'large-review' | 'reviewable' | 'caution' | 'bookmark';
  addedAt: number;
}
type ContextMenuTarget = {
  path: string;
  isDirectory: boolean;
  recordIndex: number;
  x: number;
  y: number;
  displayName?: string;
  sizeBytes?: number | null;
};
type RecycleConfirmTarget = {
  path: string;
  isDirectory: boolean;
  recordIndex?: number;
  displayName?: string;
  sizeBytes?: number | null;
  warnings?: string[];
  requireAcknowledgement?: boolean;
};
type RecycledItem = {
  recordIndex: number | null;
  path: string;
  name: string;
  isDirectory: boolean;
};
type RecycleTargetInfo = {
  canonical_path: string;
  display_name: string;
  is_directory: boolean;
  size_bytes?: number | null;
  warnings: string[];
  blocked_reason?: string | null;
};
type RecycleResult = {
  target: RecycleTargetInfo;
  moved_to_recycle_bin: boolean;
};
type RecycleSuccess = {
  displayName: string;
  itemCount: number;
};

type LargestItemsResponse = {
  folders: TreeNode[];
  files: TreeNode[];
  elapsed_ms: number;
  limit: number;
};

type ChildrenLimitedResult = {
  nodes: TreeNode[];
  total_count: number;
};

type ResolvePathResult = {
  status: "found" | "missing" | "unavailable";
  chain: number[];            // FRNs root→target (inclusive); empty for drive root
  target: TreeNode | null;
  message: string | null;
};

type BookmarkJumpState = {
  status: "jumping" | "found" | "missing" | "unavailable" | "outside300" | "other_drive";
  message?: string;
  sizeBytes?: number;
};

type Bookmark = {
  id: string;
  kind: "directory" | "file";
  drive_letter: string;
  volume_serial: string;
  path: string;
  path_key: string;
  display_name: string;
  note: string | null | undefined;
  created_at_unix_ms: number;
  last_seen_at_unix_ms: number | null | undefined;
  last_known_subtree_size: number | null | undefined;
  last_known_exists: boolean | null | undefined;
};

const TOP_OPTIONS = [10, 30, 50, 100, 200, 500];
const TREE_REVIEW_CATS  = new Set(['temp-candidate', 'cache-candidate', 'dev-dependency', 'recycle-bin']);
const TREE_CAUTION_CATS = new Set(['protected-system', 'app-managed']);
const LARGE_FOLDER_THRESHOLD = 200;
const LARGE_TREE_THRESHOLD = 1000;
const DIRECT_CHILDREN_DISPLAY_LIMIT = 300;
const TREE_EXPAND_LIMIT = 300;
const PREF_KEY = "disk-insight.preferences.v1";

// Performance instrumentation — set to true to enable, false for normal use
const PERF_LOG = false;
function perfLog(...args: unknown[]): void {
  if (PERF_LOG) console.log("[perf]", ...args);
}
// Tree-specific performance instrumentation
const PERF_TREE = false;
function treeLog(...args: unknown[]): void {
  if (PERF_TREE) console.log("[perf-tree]", ...args);
}

// Tree focus diagnostics — set true to capture event history and enable
// window.__diskInsightDebugTreeFocus() snapshot. Default: false (zero overhead).
const TREE_FOCUS_DEBUG = false;
const FOCUS_BUF_MAX = 50;
type FocusBufEntry = {
  ts: number;
  kind: string;
  key?: string;
  targetTag?: string;
  targetCls?: string;
  focusedRI: number | null;
  activeDomTag?: string;
  activeDomCls?: string;
  hasKeyNav?: boolean;
  visibleCount?: number;
  note?: string;
};
function focusDbg(...args: unknown[]): void {
  if (TREE_FOCUS_DEBUG) console.log("[tree-focus]", ...args);
}

const PHASE_COMPLETION_LATCH_MS = 600;
const UPDATED_BANNER_DISMISS_MS = 4000;
const NEAR_ZERO_FREE_DELTA_BYTES = 1024 * 1024;

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

// Returns true when the scan error likely requires administrator rights and no other
// guidance is already present in the error message itself.
function isAdminRequiredError(error: string | null): boolean {
  if (!error) return true;
  const lower = error.toLowerCase();
  if (lower.includes("network drive")) return false;
  if (lower.includes("not ready")) return false;
  if (lower.includes("not ntfs") || lower.includes("not an ntfs")) return false;
  // classify_scan_error already embeds admin guidance in the message
  if (lower.includes("administrator")) return false;
  return true; // Unknown error: show hint as fallback
}

function formatRelativePath(path: string, basePath?: string | null): string {
  if (!basePath || isDriveRoot(basePath)) return path;
  const base = basePath.endsWith("\\") ? basePath : basePath + "\\";
  if (path.startsWith(base)) return path.slice(base.length);
  return path;
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

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
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

async function getDriveCapacityNow(drive: string): Promise<DriveCapacity> {
  if (!isTauriRuntime()) {
    throw new Error("Drive capacity refresh is available only in the Tauri desktop app.");
  }
  return invoke<DriveCapacity>("get_drive_capacity_now", { drive });
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

async function openTerminalAt(path: string, isDir: boolean): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("Terminal is available only in the Tauri desktop app.");
  }
  return invoke<void>("open_terminal_at", { path, isDir });
}

async function showProperties(path: string): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("Show properties is available only in the Tauri desktop app.");
  }
  return invoke<void>("show_properties", { path });
}

async function moveToRecycleBin(path: string): Promise<RecycleResult> {
  if (!isTauriRuntime()) {
    throw new Error("Recycle Bin operations are available only in the Tauri desktop app.");
  }
  return invoke<RecycleResult>("move_to_recycle_bin", { path });
}

async function cancelScan(): Promise<void> {
  if (!isTauriRuntime()) return;
  return invoke<void>("cancel_scan");
}

async function getChildren(parentRecordIndex: number): Promise<TreeNode[]> {
  if (!isTauriRuntime()) {
    throw new Error("Children API is available only in the Tauri desktop app.");
  }
  return invoke<TreeNode[]>("get_children", { parentRecordIndex });
}

async function searchSubtree(
  parentRecordIndex: number,
  query: string,
  maxResults: number,
): Promise<TreeNode[]> {
  if (!isTauriRuntime()) {
    throw new Error("Subtree search is available only in the Tauri desktop app.");
  }
  return invoke<TreeNode[]>("search_subtree", { parentRecordIndex, query, maxResults });
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

async function getLargestItemsUnder(
  recordIndex: number,
  limit: number,
): Promise<LargestItemsResponse> {
  if (!isTauriRuntime()) {
    throw new Error("Largest items is available only in the Tauri desktop app.");
  }
  return invoke<LargestItemsResponse>("get_largest_items_under", { recordIndex, limit });
}

async function getChildrenLimited(
  parentRecordIndex: number,
  limit: number,
): Promise<ChildrenLimitedResult> {
  if (!isTauriRuntime()) {
    throw new Error("Children API is available only in the Tauri desktop app.");
  }
  return invoke<ChildrenLimitedResult>("get_children_limited", { parentRecordIndex, limit });
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

// For files from LargestItemsResult: subtree_size = final_alloc (set during arena build)
function treeNodeToFileEntry(node: TreeNode): FileEntry {
  return {
    path: node.path,
    record_index: node.record_index,
    parent_frn: node.parent_record_index,
    final_allocated_size: node.subtree_size,
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
  treeExpandedTotalCount: Record<number, number>,
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
              visit(children, depth + 1);
              const total = treeExpandedTotalCount[id];
              if (total !== undefined && total > children.length) {
                rows.push({ node, depth: depth + 1, treeTruncated: { shown: children.length, total } });
              }
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

function AdvancedModeWarningModal({
  onCancel,
  onEnable,
}: {
  onCancel: () => void;
  onEnable: () => void;
}) {
  const [understood, setUnderstood] = useState(false);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return createPortal(
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal-card advanced-mode-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="advanced-mode-modal-title"
        onContextMenu={(e) => e.preventDefault()}
      >
        <h2 id="advanced-mode-modal-title">Enable Advanced Mode?</h2>
        <div className="modal-body">
          <p>Advanced Mode enables moving files and folders to the Recycle Bin.</p>
          <p>
            This operation is not permanent deletion, but it can still disrupt
            your system if used on important folders.
          </p>
          <p>Protected system locations are blocked.</p>
          <p>Use this mode carefully.</p>
        </div>
        <label className="modal-checkbox">
          <input
            type="checkbox"
            checked={understood}
            onChange={(e) => setUnderstood(e.target.checked)}
          />
          <span>I understand and want to enable Advanced Mode for this session.</span>
        </label>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-danger"
            onClick={onEnable}
            disabled={!understood}
          >
            Enable
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function getRecycleDisplayName(target: RecycleConfirmTarget): string {
  if (target.displayName) return target.displayName;
  const trimmed = target.path.replace(/[\\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed || target.path;
}

function RecycleConfirmModal({
  target,
  isRecycling,
  confirmDisabled,
  confirmDisabledReason,
  error,
  onCancel,
  onConfirm,
}: {
  target: RecycleConfirmTarget;
  isRecycling: boolean;
  confirmDisabled?: boolean;
  confirmDisabledReason?: string;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [understood, setUnderstood] = useState(false);
  const requiresAcknowledgement = target.requireAcknowledgement === true;
  const moveDisabled = confirmDisabled === true || isRecycling || (requiresAcknowledgement && !understood);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !isRecycling) onCancel();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isRecycling, onCancel]);

  return createPortal(
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal-card recycle-confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recycle-confirm-modal-title"
        onContextMenu={(e) => e.preventDefault()}
      >
        <h2 id="recycle-confirm-modal-title">Move to Recycle Bin?</h2>
        <div className="modal-body recycle-confirm-body">
          <dl className="recycle-target-details">
            <div>
              <dt>Type</dt>
              <dd>{target.isDirectory ? "Folder" : "File"}</dd>
            </div>
            <div>
              <dt>Name</dt>
              <dd>{getRecycleDisplayName(target)}</dd>
            </div>
            <div>
              <dt>Path</dt>
              <dd className="recycle-target-path">{target.path}</dd>
            </div>
            {target.sizeBytes != null && (
              <div>
                <dt>Size</dt>
                <dd>{formatBytes(target.sizeBytes)}</dd>
              </div>
            )}
          </dl>
          <div className="recycle-confirm-copy">
            <p>This will move the item to the Recycle Bin.</p>
            <p>
              It will not be permanently deleted and can be restored from the Recycle Bin.
            </p>
            <p>
              Items in the Recycle Bin still occupy disk space until the bin is emptied.
            </p>
          </div>
          {target.warnings && target.warnings.length > 0 && (
            <div className="recycle-warning-list" role="alert">
              <strong>Warnings</strong>
              <ul>
                {target.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
          {error && (
            <div className="recycle-modal-error" role="alert">
              {error}
            </div>
          )}
        </div>
        {requiresAcknowledgement && (
          <label className="modal-checkbox">
            <input
              type="checkbox"
              checked={understood}
              disabled={isRecycling}
              onChange={(e) => setUnderstood(e.target.checked)}
            />
            <span>I understand this target may be high risk.</span>
          </label>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={isRecycling}>
            Cancel
          </button>
          <button
            className="btn btn-danger"
            onClick={onConfirm}
            disabled={moveDisabled}
            title={confirmDisabled && confirmDisabledReason ? confirmDisabledReason : undefined}
          >
            {isRecycling ? "Moving..." : "Move to Recycle Bin"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SafeContextMenu({
  target,
  onClose,
  onOpenExplorer,
  onSelectFile,
  onShowProperties,
  advancedMode,
  onRequestRecycle,
  isAlreadyRecycled,
  onCopyError,
  onExternalHandoff,
  isBookmarked: targetIsBookmarked,
  onToggleBookmark,
  isInReviewList: targetIsInReviewList,
  onToggleReviewList,
}: {
  target: ContextMenuTarget;
  onClose: () => void;
  onOpenExplorer: (path: string) => void;
  onSelectFile?: (path: string) => void;
  onShowProperties?: (path: string) => void;
  advancedMode?: boolean;
  onRequestRecycle?: (target: ContextMenuTarget) => void;
  isAlreadyRecycled?: boolean;
  onCopyError: (msg: string) => void;
  onExternalHandoff?: () => void;
  isBookmarked?: boolean;
  onToggleBookmark?: () => void;
  isInReviewList?: boolean;
  onToggleReviewList?: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuWidth = 250;
  const showRecycleItem      = advancedMode === true && onRequestRecycle !== undefined;
  const showBookmarkItem     = onToggleBookmark !== undefined;
  const showReviewListItem   = onToggleReviewList !== undefined;
  // Base: 5 safe items (~30px each) + 8px base padding: 5 × 30 + 8 = 158.
  // Bookmark section: separator(9) + item(30) = 39px.
  // Review list section: separator(9) + item(30) = 39px.
  // Advanced section: separator(9) + label(20) + item(30) = 59px.
  const baseMenuHeight = 158;
  const menuHeight = baseMenuHeight
    + (showBookmarkItem   ? 39 : 0)
    + (showReviewListItem ? 39 : 0)
    + (showRecycleItem    ? 59 : 0);
  const x = Math.min(target.x, window.innerWidth - menuWidth - 4);
  const y = Math.min(target.y, window.innerHeight - menuHeight - 4);

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    window.addEventListener("mousedown", handleMouseDown);
    return () => window.removeEventListener("mousedown", handleMouseDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function copyPath() {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(target.path).catch((err: unknown) => {
        onCopyError(err instanceof Error ? err.message : "Failed to copy path.");
      });
    } else {
      onCopyError("Clipboard is not available.");
    }
    onClose();
  }

  function copyAsPath() {
    const quoted = `"${target.path}"`;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(quoted).catch((err: unknown) => {
        onCopyError(err instanceof Error ? err.message : "Failed to copy path.");
      });
    } else {
      onCopyError("Clipboard is not available.");
    }
    onClose();
  }

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Explorer handoff: dirs = open, files = reveal/select */}
      <button
        className="context-menu-item"
        onClick={() => {
          if (target.isDirectory) {
            onOpenExplorer(target.path);
          } else if (onSelectFile) {
            onSelectFile(target.path);
          } else {
            onOpenExplorer(getParentDir(target.path));
          }
          onClose();
        }}
      >
        {target.isDirectory ? "Show in Explorer" : "Show file in Explorer"}
      </button>
      <button
        className="context-menu-item"
        onClick={() => {
          onExternalHandoff?.();
          openTerminalAt(target.path, target.isDirectory).catch((err: unknown) => {
            onCopyError(err instanceof Error ? err.message : String(err));
          });
          onClose();
        }}
      >
        Open terminal here
      </button>
      {onShowProperties && (
        <button
          className="context-menu-item"
          onClick={() => { onShowProperties(target.path); onClose(); }}
        >
          Show properties
        </button>
      )}
      <button
        className="context-menu-item"
        onClick={copyPath}
        title={target.path}
      >
        Copy path
      </button>
      <button
        className="context-menu-item"
        onClick={copyAsPath}
        title={`"${target.path}"`}
      >
        Copy quoted path
      </button>
      {showBookmarkItem && (
        <>
          <div className="context-menu-separator" role="separator" />
          <button
            className="context-menu-item"
            onClick={() => { onToggleBookmark!(); onClose(); }}
          >
            {targetIsBookmarked ? "Remove bookmark" : "Add bookmark"}
          </button>
        </>
      )}
      {showReviewListItem && (
        <>
          <div className="context-menu-separator" role="separator" />
          <button
            className="context-menu-item"
            onClick={() => { onToggleReviewList!(); onClose(); }}
          >
            {targetIsInReviewList ? "Remove from review list" : "Add to review list"}
          </button>
        </>
      )}
      {showRecycleItem && (
        <>
          <div className="context-menu-separator" role="separator" />
          <div className="context-menu-section-label">Advanced</div>
          <button
            className={`context-menu-item context-menu-item--danger${isAlreadyRecycled ? " context-menu-item--disabled" : ""}`}
            disabled={isAlreadyRecycled}
            onClick={isAlreadyRecycled ? undefined : () => {
              onRequestRecycle(target);
              onClose();
            }}
            title={isAlreadyRecycled ? "Already moved to Recycle Bin" : undefined}
          >
            {isAlreadyRecycled ? "Already in Recycle Bin" : "Move to Recycle Bin"}
          </button>
        </>
      )}
    </div>,
    document.body,
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

function reviewCategoryLabel(cat: string): string {
  switch (cat) {
    case 'temp-candidate':  return 'Temp candidate';
    case 'cache-candidate': return 'Cache candidate';
    case 'dev-dependency':  return 'Dev dependency';
    case 'recycle-bin':     return 'Recycle Bin';
    default:                return '';
  }
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

function isItemRecycled(
  recordIndex: number,
  path: string,
  recycledItems: RecycledItem[],
): boolean {
  const lp = path.toLowerCase();
  return recycledItems.some(
    (item) =>
      (item.recordIndex !== null && item.recordIndex === recordIndex) ||
      item.path.toLowerCase() === lp,
  );
}

function formatDriveFreeDelta(deltaBytes: number, recycleContext = false): string {
  if (Math.abs(deltaBytes) < NEAR_ZERO_FREE_DELTA_BYTES) {
    return recycleContext
      ? "Drive free space unchanged."
      : "Drive free space unchanged since cleanup refresh";
  }
  const sign = deltaBytes > 0 ? "+" : "-";
  return `Drive free space changed: ${sign}${formatBytes(Math.abs(deltaBytes))} since cleanup refresh`;
}

function unsupportedCapacityNote(scanError: string): string {
  const lower = scanError.toLowerCase();
  if (lower.includes("not ntfs") || lower.includes("not an ntfs")) {
    return "Drive capacity is available, but file breakdown requires NTFS.";
  }
  return "Capacity is shown using Windows drive information. File breakdown scanning is unavailable until the scan issue is resolved.";
}

function formatPercent(bytes: number, total: number): string {
  if (total <= 0 || bytes <= 0) return "—";
  const pct = (bytes / total) * 100;
  if (pct < 0.1) return "<0.1%";
  return `${pct.toFixed(1)}%`;
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

  const policyLabel = data.summary.storage_policy && data.summary.storage_policy !== "current"
    ? storagePolicyDisplayName(data.summary.storage_policy)
    : null;

  const scanTimeLabel =
    sourceKind === "live"
      ? `Scanned in ${formatElapsed(data.summary.total_time_ms)}`
      : sourceKind === "cached"
        ? `Last scan ${formatElapsed(data.summary.total_time_ms)}`
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
      {scanTimeLabel && <span className="status-meta">{scanTimeLabel}</span>}
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

  if (banner.kind === "refresh_cancelled") {
    return (
      <div className="last-scan-banner last-scan-banner--cancelled" role="status">
        Refresh cancelled. Showing last scan result.
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
      <summary className="perf-breakdown-summary">Scan timing details</summary>
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

function CompactSummary({
  summary,
  capacity,
}: {
  summary: Summary;
  capacity?: DriveCapacity | null;
}) {
  return (
    <div className="compact-summary" aria-label="Scan summary">
      <span className="compact-summary-drive">{summary.drive}</span>
      {capacity && (
        <>
          <span className="compact-summary-sep" aria-hidden="true">·</span>
          <span title="Total volume capacity reported by the OS">{formatBytes(capacity.total_bytes)}</span>
          <span className="compact-summary-sep" aria-hidden="true">·</span>
          <span title="Used space (total minus free)">Used {formatBytes(capacity.used_bytes)} ({capacity.used_percent.toFixed(1)}%)</span>
          <span className="compact-summary-sep" aria-hidden="true">·</span>
          <span title="Free space on the volume">Free {formatBytes(capacity.free_bytes)}</span>
          <span className="compact-summary-sep" aria-hidden="true">·</span>
        </>
      )}
      <span title="Estimated allocated-style size. Compare with Explorer 'Size on disk' or WizTree 'Allocated', not Explorer 'Size'.">
        Alloc {formatBytes(summary.total_final_allocated)}
      </span>
      <span className="compact-summary-sep" aria-hidden="true">·</span>
      <span>Files {formatRecords(summary.files)}</span>
      <span className="compact-summary-sep" aria-hidden="true">·</span>
      <span>Dirs {formatRecords(summary.directories)}</span>
    </div>
  );
}

function UnsupportedDriveCapacityCard({ drive, capacity, note }: UnsupportedDriveCapacity) {
  return (
    <div className="compact-summary compact-summary--unsupported">
      <span className="compact-summary-drive">{drive}</span>
      <span className="compact-summary-sep" aria-hidden="true">·</span>
      <span title="Total volume capacity reported by Windows">{formatBytes(capacity.total_bytes)}</span>
      <span className="compact-summary-sep" aria-hidden="true">·</span>
      <span title="Used space (total minus free)">Used {formatBytes(capacity.used_bytes)} ({capacity.used_percent.toFixed(1)}%)</span>
      <span className="compact-summary-sep" aria-hidden="true">·</span>
      <span title="Free space on the volume">Free {formatBytes(capacity.free_bytes)}</span>
      <span className="compact-summary-sep" aria-hidden="true">·</span>
      <span className="compact-summary-note">{note}</span>
    </div>
  );
}

type TreeRowProps = {
  node: TreeNode;
  depth: number;
  totalSize: number;
  // Pre-computed booleans — parent computes these so React.memo can skip unchanged rows
  isExpanded: boolean;
  isLoading: boolean;
  isSelected: boolean;
  isFocused: boolean;
  isRecycled: boolean;
  onToggleExpand: (node: TreeNode) => void;
  onSelect: (node: TreeNode) => void;
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>, node: TreeNode) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
};

// React.memo: only re-renders when its own props change.
// With pre-computed boolean props, arrow-key navigation re-renders only 2 rows
// (old active → false, new active → true) instead of all visible rows.
const TreeNodeRow = React.memo(function TreeNodeRow({
  node,
  depth,
  totalSize,
  isExpanded,
  isLoading,
  isSelected,
  isFocused,
  isRecycled,
  onToggleExpand,
  onSelect,
  onContextMenu,
  onKeyDown,
}: TreeRowProps) {
  const renderCount = useRef(0);
  renderCount.current += 1;
  if (PERF_TREE && renderCount.current > 1 && renderCount.current % 20 === 0) {
    treeLog(`row ri=${node.record_index} name=${node.name} rendered ${renderCount.current}× (frequent re-render detected)`);
  }
  const isDir       = node.is_directory;
  const indent      = 8 + depth * 16;
  const displayName = node.name || node.path;
  const barPct      = totalSize > 0 ? Math.min(100, (node.subtree_size / totalSize) * 100) : 0;

  const rowClass =
    "tree-row"
    + (isSelected ? " tree-row--active" : "")
    + (isFocused ? " tree-row--keyboard-focused" : "")
    + (isDir ? "" : " tree-row--file")
    + (isLoading ? " tree-row--loading" : "")
    + (isRecycled ? " tree-row--recycled" : "");

  return (
    <div
      className={rowClass}
      style={{ paddingLeft: indent }}
      data-record-index={node.record_index}
      role="treeitem"
      tabIndex={isFocused ? 0 : -1}
      aria-expanded={isDir ? isExpanded : undefined}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => onContextMenu(e, node)}
    >
      {isDir ? (
        <button
          className="tree-toggle"
          tabIndex={-1}
          onKeyDown={onKeyDown}
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand(node);
            // Move DOM focus to the row div after clicking so subsequent key events
            // reach onKeyDown directly, even if tabIndex={-1} caused focus to escape
            // to an ancestor (WebView2-specific behaviour).
            e.currentTarget.closest<HTMLElement>('[role="treeitem"]')?.focus({ preventScroll: true });
          }}
          disabled={isLoading}
          aria-label={isExpanded ? "Collapse" : "Expand"}
          title={isExpanded ? "Collapse" : "Expand"}
        >
          {isLoading ? "…" : (
            <span className={isExpanded ? "tree-chevron tree-chevron--expanded" : "tree-chevron"}>▶</span>
          )}
        </button>
      ) : (
        <span className="tree-toggle tree-toggle--leaf" aria-hidden="true">·</span>
      )}
      <span
        className={isDir
          ? (isExpanded ? "tree-node-icon tree-node-icon--folder-open" : "tree-node-icon tree-node-icon--folder")
          : "tree-node-icon tree-node-icon--file"}
        aria-hidden="true"
      />
      {isDir ? (
        <button
          className="tree-label"
          tabIndex={-1}
          onKeyDown={onKeyDown}
          onClick={() => onSelect(node)}
          title={node.path}
        >
          <span className="tree-name">{displayName}</span>
          {isRecycled && <span className="recycled-badge">Recycled</span>}
        </button>
      ) : (
        <div className="tree-label tree-label--file" title={node.path}>
          <span className="tree-name">{displayName}</span>
          {isRecycled && <span className="recycled-badge">Recycled</span>}
        </div>
      )}
      {/* Right columns are outside tree-label so all rows share the same
          horizontal positions regardless of indentation depth. */}
      <span
        className="tree-occ-bar"
        title="Occupancy — % of drive total allocated size"
        aria-hidden="true"
      >
        {barPct > 0 && <span className="tree-occ-bar__fill" style={{ width: `${barPct}%` }} />}
      </span>
      <span className="tree-pct" aria-hidden="true">
        {totalSize > 0 ? formatPercent(node.subtree_size, totalSize) : ""}
      </span>
      <span className="tree-size">{formatBytes(node.subtree_size)}</span>
    </div>
  );
}); // React.memo — see TreeRowProps for why booleans are pre-computed by parent

// ── Bookmarks panel (right-pane inspector card) ──────────────────────────

function BookmarksBar({
  bookmarks,
  jumpStates,
  onJump,
  onRemove,
  currentVolumeSerial,
  totalSize,
  onOpenExplorer,
  onSelectFile,
  onCopyError,
  isInReviewList,
  onToggleReviewList,
}: {
  bookmarks: Bookmark[];
  jumpStates: Record<string, BookmarkJumpState>;
  onJump: (b: Bookmark) => void;
  onRemove: (id: string) => void;
  currentVolumeSerial?: string | null;
  totalSize?: number;
  onOpenExplorer?: (path: string) => void;
  onSelectFile?: (path: string) => void;
  onCopyError?: (msg: string) => void;
  isInReviewList?: (path: string) => boolean;
  onToggleReviewList?: (path: string, isDirectory: boolean, sizeBytes: number, source: ReviewListItem['source']) => void;
}) {
  const [open, setOpen] = useState(true);
  const [ctxMenu, setCtxMenu] = useState<{ target: ContextMenuTarget; bookmarkId: string } | null>(null);

  // Sort: current-drive bookmarks first, other-drive bookmarks last.
  const sortedBookmarks = useMemo(() => {
    if (!currentVolumeSerial) return bookmarks;
    const cur = currentVolumeSerial.toUpperCase();
    return [...bookmarks].sort((a, b) => {
      const aOther = a.volume_serial?.toUpperCase() !== cur ? 1 : 0;
      const bOther = b.volume_serial?.toUpperCase() !== cur ? 1 : 0;
      return aOther - bOther;
    });
  }, [bookmarks, currentVolumeSerial]);

  if (bookmarks.length === 0) return null;

  return (
    <div className="bookmarks-panel">
      <button
        className={`bookmarks-panel-header${open ? " bookmarks-panel-header--open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={open ? "Collapse bookmarks" : "Expand bookmarks"}
        aria-expanded={open}
      >
        <span className="bookmarks-panel-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
        Bookmarks ({bookmarks.length})
      </button>
      {open && (
        <div className="bookmarks-panel-list">
          {sortedBookmarks.map((b) => {
            const js = jumpStates[b.id];
            const isMissing     = js?.status === "missing";
            const isUnavailable = js?.status === "unavailable";
            const isJumping     = js?.status === "jumping";
            const isOutside     = js?.status === "outside300";
            const isOtherDrive  = js?.status === "other_drive";
            const hasBadge = isMissing || isUnavailable || isOtherDrive || isOutside || isJumping;
            const sizeBytes = js?.sizeBytes;
            const showSize = !hasBadge && sizeBytes !== undefined && sizeBytes > 0;
            const sizeLabel = showSize
              ? (totalSize && totalSize > 0
                  ? `${formatBytes(sizeBytes!)} · ${formatPercent(sizeBytes!, totalSize)}`
                  : formatBytes(sizeBytes!))
              : null;
            const rowClass = [
              "bookmark-row",
              (isMissing || isUnavailable || isOtherDrive) ? "bookmark-row--dim" : "",
            ].join(" ").trim();
            return (
              <div
                key={b.id}
                className={rowClass}
                title={b.path}
                onContextMenu={(e) => {
                  if (!onOpenExplorer) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setCtxMenu({
                    target: {
                      path: b.path,
                      isDirectory: b.kind === "directory",
                      recordIndex: -1,
                      x: e.clientX,
                      y: e.clientY,
                      displayName: b.display_name,
                      sizeBytes: js?.sizeBytes ?? b.last_known_subtree_size ?? null,
                    },
                    bookmarkId: b.id,
                  });
                }}
              >
                <button
                  className="bookmark-row-main"
                  onClick={() => onJump(b)}
                  title={b.path}
                  disabled={isJumping}
                >
                  <span
                    className={b.kind === "directory" ? "tree-node-icon tree-node-icon--folder" : "tree-node-icon tree-node-icon--file"}
                    aria-hidden="true"
                  />
                  <span className="bookmark-name">{b.display_name}</span>
                  {sizeLabel && <span className="bookmark-size-hint">{sizeLabel}</span>}
                  {isJumping && <span className="bookmark-badge bookmark-badge--jumping" aria-label="Jumping">…</span>}
                  {isMissing && <span className="bookmark-badge bookmark-badge--missing" title={js?.message ?? "Not found in current scan"}>missing</span>}
                  {isUnavailable && <span className="bookmark-badge bookmark-badge--unavailable" title={js?.message ?? ""}>no scan</span>}
                  {isOtherDrive && <span className="bookmark-badge bookmark-badge--other-drive" title={js?.message ?? ""}>scan {b.drive_letter}:</span>}
                  {isOutside && <span className="bookmark-badge bookmark-badge--outside" title={js?.message ?? ""}>↑300</span>}
                </button>
                <button
                  className="bookmark-remove"
                  onClick={(e) => { e.stopPropagation(); onRemove(b.id); }}
                  title="Remove bookmark"
                  aria-label={`Remove bookmark ${b.display_name}`}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
      {ctxMenu && onOpenExplorer && onCopyError && (
        <SafeContextMenu
          target={ctxMenu.target}
          onClose={() => setCtxMenu(null)}
          onOpenExplorer={onOpenExplorer}
          onSelectFile={onSelectFile}
          onCopyError={onCopyError}
          isBookmarked={true}
          onToggleBookmark={() => { onRemove(ctxMenu.bookmarkId); setCtxMenu(null); }}
          isInReviewList={isInReviewList ? isInReviewList(ctxMenu.target.path) : undefined}
          onToggleReviewList={onToggleReviewList
            ? () => onToggleReviewList(
                ctxMenu.target.path,
                ctxMenu.target.isDirectory,
                ctxMenu.target.sizeBytes ?? 0,
                'bookmark',
              )
            : undefined}
        />
      )}
    </div>
  );
}

// ── Review list panel (right-pane inspector card) ─────────────────────────

function ReviewListPanel({
  items,
  onRemove,
  onClear,
  onJump,
  onOpenExplorer,
  onSelectFile,
  onCopyError,
  isBookmarked,
  onToggleBookmark,
}: {
  items: ReviewListItem[];
  onRemove: (path: string) => void;
  onClear: () => void;
  onJump?: (item: ReviewListItem) => void;
  onOpenExplorer: (path: string) => void;
  onSelectFile: (path: string) => void;
  onCopyError: (msg: string) => void;
  isBookmarked?: (path: string) => boolean;
  onToggleBookmark?: (path: string, isDirectory: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuTarget | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  function copyPaths() {
    if (items.length === 0) return;
    const text = items.map((item) => item.path).join("\n");
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        setCopyStatus(`Copied ${items.length} path${items.length !== 1 ? "s" : ""}.`);
        setTimeout(() => setCopyStatus(null), 2000);
      }).catch((err: unknown) => {
        onCopyError(err instanceof Error ? err.message : "Failed to copy paths.");
      });
    } else {
      onCopyError("Clipboard is not available.");
    }
  }

  function copyQuoted() {
    if (items.length === 0) return;
    const text = items.map((item) => `"${item.path}"`).join("\n");
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        setCopyStatus(`Copied ${items.length} quoted path${items.length !== 1 ? "s" : ""}.`);
        setTimeout(() => setCopyStatus(null), 2000);
      }).catch((err: unknown) => {
        onCopyError(err instanceof Error ? err.message : "Failed to copy paths.");
      });
    } else {
      onCopyError("Clipboard is not available.");
    }
  }

  return (
    <div className="review-list-panel">
      <div className="review-list-header">
        <button
          className={`review-list-header-toggle${open ? " review-list-header-toggle--open" : ""}`}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={open ? "Collapse review list" : "Expand review list"}
        >
          <span className="review-list-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
          Review list{items.length > 0 ? ` (${items.length})` : ""}
        </button>
        {open && (
          <>
            <button
              className="review-list-copy-btn"
              onClick={copyPaths}
              disabled={items.length === 0}
              title="Copy all review list paths to clipboard (one per line)"
            >
              Copy paths
            </button>
            <button
              className="review-list-copy-btn"
              onClick={copyQuoted}
              disabled={items.length === 0}
              title="Copy all review list paths as quoted strings to clipboard"
            >
              Copy quoted
            </button>
            {items.length > 0 && (
              <button className="review-list-clear" onClick={onClear} title="Clear all items from review list">
                Clear
              </button>
            )}
          </>
        )}
      </div>
      {open && (
        <div className="review-list-body">
          <p className="review-list-note">
            {copyStatus ?? "Session-only list for manual review. No file operations."}
          </p>
          {items.length === 0 ? (
            <p className="review-list-empty">
              Add items from TreeView or Large review to collect candidates for manual review.
            </p>
          ) : (
            <div className="review-list-items">
              {items.map((item) => (
                <div
                  key={item.path}
                  className="review-list-item"
                  title={item.path}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setCtxMenu({
                      path: item.path,
                      isDirectory: item.isDirectory,
                      recordIndex: item.recordIndex ?? -1,
                      x: e.clientX,
                      y: e.clientY,
                      sizeBytes: item.sizeBytes,
                    });
                  }}
                >
                  <span
                    className={item.isDirectory ? "tree-node-icon tree-node-icon--folder" : "tree-node-icon tree-node-icon--file"}
                    aria-hidden="true"
                  />
                  <button
                    className="review-list-item-btn"
                    onClick={() => onJump?.(item)}
                    title={item.path}
                    disabled={onJump === undefined}
                  >
                    <div className="review-list-item-main">
                      <span className="review-list-item-name">{item.name}</span>
                      <span className="review-list-item-meta">
                        {formatBytes(item.sizeBytes)}
                        {item.category ? ` · ${item.category}` : ""}
                      </span>
                      <span className="review-list-item-path">{item.parentPath}</span>
                    </div>
                  </button>
                  <button
                    className="review-list-remove"
                    onClick={() => onRemove(item.path)}
                    title="Remove from review list"
                    aria-label={`Remove ${item.name} from review list`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {ctxMenu && (
        <SafeContextMenu
          target={ctxMenu}
          onClose={() => setCtxMenu(null)}
          onOpenExplorer={onOpenExplorer}
          onSelectFile={onSelectFile}
          onCopyError={onCopyError}
          isBookmarked={isBookmarked ? isBookmarked(ctxMenu.path) : undefined}
          onToggleBookmark={onToggleBookmark ? () => onToggleBookmark(ctxMenu.path, ctxMenu.isDirectory) : undefined}
          isInReviewList={true}
          onToggleReviewList={() => { onRemove(ctxMenu.path); setCtxMenu(null); }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────

function TreeView({
  rootCount,
  visibleRows,
  totalRowsCount,
  totalSize,
  expandedIds,
  loadingIds,
  selectedRecordIndex,
  focusedRecordIndex,
  treeError,
  sourceKind,
  recycledItems,
  reviewView,
  onChangeReviewView,
  largeReviewCandidates,
  isReviewBookmarked,
  onToggleReviewBookmark,
  isInReviewList,
  onToggleReviewList,
  onToggleExpand,
  onSelect,
  onContextMenu,
  onKeyDown,
  onNavMouseMove,
  navRef,
  jumpScrollRef,
  jumpScrollTick,
}: {
  rootCount: number;
  visibleRows: VisibleTreeRow[];
  totalRowsCount: number;
  totalSize: number;
  expandedIds: Set<number>;
  loadingIds: Set<number>;
  selectedRecordIndex: number | undefined;
  focusedRecordIndex: number | null;
  treeError: string | null;
  sourceKind: SourceKind | null;
  recycledItems?: RecycledItem[];
  reviewView: TreeReviewView;
  onChangeReviewView: (v: TreeReviewView) => void;
  largeReviewCandidates: ReviewCandidate[];
  isReviewBookmarked?: (path: string) => boolean;
  onToggleReviewBookmark?: (path: string, isDirectory: boolean) => void;
  isInReviewList?: (path: string) => boolean;
  onToggleReviewList?: (path: string, isDirectory: boolean, sizeBytes: number, recordIndex?: number) => void;
  onToggleExpand: (node: TreeNode) => void;
  onSelect: (node: TreeNode) => void;
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>, node: TreeNode) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onNavMouseMove?: () => void;
  navRef?: React.RefObject<HTMLElement | null>;
  /** Ref holding the FRN to center-scroll to after a bookmark jump. */
  jumpScrollRef?: React.MutableRefObject<number | null>;
  /** Incrementing counter that signals a new bookmark jump. */
  jumpScrollTick?: number;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const treeViewRenderCount = useRef(0);
  treeViewRenderCount.current += 1;
  if (PERF_TREE) treeLog(`TreeView render #${treeViewRenderCount.current}  visibleRows=${visibleRows.length}  focused=${focusedRecordIndex}`);
  const [reviewCtxMenu, setReviewCtxMenu] = useState<ContextMenuTarget | null>(null);

  useEffect(() => {
    if (focusedRecordIndex === null) return;
    const t0 = performance.now();
    const container = listRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(`[data-record-index="${focusedRecordIndex}"]`);
    if (!el) return;
    // Scroll only within folder-nav-list, not any ancestor scroll container.
    // element.scrollIntoView() would also scroll <main>, causing page-level jumps.
    const cr = container.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    if (er.top < cr.top) {
      container.scrollTop += er.top - cr.top;
      treeLog(`scroll UP  ri=${focusedRecordIndex}  querySelector+scroll=${(performance.now()-t0).toFixed(1)}ms`);
    } else if (er.bottom > cr.bottom) {
      container.scrollTop += er.bottom - cr.bottom;
      treeLog(`scroll DOWN  ri=${focusedRecordIndex}  querySelector+scroll=${(performance.now()-t0).toFixed(1)}ms`);
    } else {
      treeLog(`scroll NOOP  ri=${focusedRecordIndex}  querySelector=${(performance.now()-t0).toFixed(1)}ms`);
    }
  }, [focusedRecordIndex]);

  // Center-scroll for bookmark jumps: place target at ~33% from container top.
  // Runs AFTER the nearest-scroll effect (declared later → executes later in same commit).
  // jumpScrollRef.current is consumed (set to null) so the next arrow-key move
  // uses normal nearest scroll.
  useEffect(() => {
    if (!jumpScrollRef) return;
    const frn = jumpScrollRef.current;
    if (frn === null) return;
    jumpScrollRef.current = null; // consume — subsequent arrow moves use nearest scroll
    const container = listRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(`[data-record-index="${frn}"]`);
    if (!el) return;
    // Position target at 33% from container top (center-ish without going too high)
    const cr = container.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const elTopRelative = er.top - cr.top + container.scrollTop;
    const targetScrollTop = elTopRelative - container.clientHeight * 0.33 + er.height / 2;
    container.scrollTop = Math.max(0, targetScrollTop);
    treeLog(`scroll JUMP-CENTER  ri=${frn}  scrollTop=${container.scrollTop.toFixed(0)}`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpScrollTick]);

  const footerText = reviewView === 'large-review'
    ? `Large review: ${formatNumber(largeReviewCandidates.length)} candidate${largeReviewCandidates.length !== 1 ? 's' : ''}`
    : reviewView === 'caution'
      ? `Caution areas: ${formatNumber(visibleRows.length)} of ${formatNumber(totalRowsCount)} loaded rows`
      : reviewView === 'reviewable'
        ? `Reviewable areas: ${formatNumber(visibleRows.length)} of ${formatNumber(totalRowsCount)} loaded rows`
        : `Root children: ${rootCount} · Visible rows: ${formatNumber(visibleRows.length)}${visibleRows.length >= LARGE_TREE_THRESHOLD ? " — consider collapsing folders." : ""}`;

  return (
    <aside ref={navRef} className="folder-nav" tabIndex={0} onKeyDown={reviewView !== 'large-review' ? onKeyDown : undefined} onMouseMove={onNavMouseMove}>
      <div className="folder-nav-header">
        <div className="folder-nav-header__title">
          <span>Folder tree</span>
          <select
            className="tree-review-select"
            value={reviewView}
            onChange={(e) => onChangeReviewView(e.target.value as TreeReviewView)}
            title="Switch tree view. Large review: Temp/Cache/Dev/Recycle candidates ≥ 1 GiB from top scan results. Reviewable areas: large loaded rows not classified as system/app-managed. Caution areas: system/app-managed loaded rows."
          >
            <option value="all" title="Show the normal loaded tree.">All</option>
            <option value="large-review" title="Show large Temp / Cache / Dev dependency / Recycle Bin candidates from top scan results.">Large review</option>
            <option value="reviewable" title="Show large loaded rows that are not classified as system/app-managed caution areas.">Reviewable areas</option>
            <option value="caution" title="Show loaded rows classified as system or app-managed caution areas.">Caution areas</option>
          </select>
        </div>
        <span className="folder-nav-header__occ" title="Occupancy (% of drive total)">Occ.</span>
        <span className="folder-nav-header__pct" />
        <span className="folder-nav-header__size">Size</span>
      </div>

      {reviewView === 'large-review' ? (
        <div className="folder-nav-list" ref={listRef}>
          <div className="tree-review-header">
            <div>Large Review Candidates</div>
            <div className="tree-review-header-sub">From top scan results · Size ≥ 1 GiB</div>
            <div className="tree-review-header-sub">Criteria: Temp / Cache / Dev dependency / Recycle Bin · Excludes user data and app/system areas</div>
          </div>
          {largeReviewCandidates.length === 0 ? (
            <p className="tree-filter-empty">No large review candidates found in top results.</p>
          ) : (
            largeReviewCandidates.map((item) => {
              const barPct = totalSize > 0 ? Math.min(100, (item.sizeBytes / totalSize) * 100) : 0;
              return (
                <div
                  key={item.record_index}
                  className="tree-review-row"
                  title={item.path}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setReviewCtxMenu({
                      path: item.path,
                      isDirectory: item.isDirectory,
                      recordIndex: item.record_index,
                      x: e.clientX,
                      y: e.clientY,
                      sizeBytes: item.sizeBytes,
                    });
                  }}
                >
                  <span
                    className={item.isDirectory ? "tree-node-icon tree-node-icon--folder" : "tree-node-icon tree-node-icon--file"}
                    aria-hidden="true"
                  />
                  <div className="tree-review-main">
                    <span className="tree-review-name">{getFileName(item.path)}</span>
                    <span className="tree-review-path">{getParentDir(item.path)}</span>
                    <span className="tree-review-category">{item.categoryLabel}</span>
                  </div>
                  <span className="tree-occ-bar" aria-hidden="true">
                    {barPct > 0 && <span className="tree-occ-bar__fill" style={{ width: `${barPct}%` }} />}
                  </span>
                  <span className="tree-pct" aria-hidden="true">
                    {totalSize > 0 ? formatPercent(item.sizeBytes, totalSize) : ""}
                  </span>
                  <span className="tree-size">{formatBytes(item.sizeBytes)}</span>
                </div>
              );
            })
          )}
          {reviewCtxMenu && (
            <SafeContextMenu
              target={reviewCtxMenu}
              onClose={() => setReviewCtxMenu(null)}
              onOpenExplorer={(path) => openInExplorer(path).catch(console.warn)}
              onSelectFile={(path) => selectInExplorer(path).catch(console.warn)}
              advancedMode={false}
              onCopyError={console.warn}
              isBookmarked={isReviewBookmarked ? isReviewBookmarked(reviewCtxMenu.path) : undefined}
              onToggleBookmark={onToggleReviewBookmark ? () => onToggleReviewBookmark(reviewCtxMenu.path, reviewCtxMenu.isDirectory) : undefined}
              isInReviewList={isInReviewList ? isInReviewList(reviewCtxMenu.path) : undefined}
              onToggleReviewList={onToggleReviewList ? () => onToggleReviewList(reviewCtxMenu.path, reviewCtxMenu.isDirectory, reviewCtxMenu.sizeBytes ?? 0, reviewCtxMenu.recordIndex) : undefined}
            />
          )}
        </div>
      ) : (
        <div className="folder-nav-list" ref={listRef} role="tree">
          {reviewView === 'reviewable' && (
            <div className="tree-review-header">
              <div>Reviewable Areas</div>
              <div className="tree-review-header-sub">Loaded tree rows · Size ≥ 1 GiB</div>
              <div className="tree-review-header-sub">Criteria: Not system/app-managed · Unknown and user-visible areas</div>
            </div>
          )}
          {reviewView === 'caution' && (
            <div className="tree-review-header">
              <div>Caution Areas</div>
              <div className="tree-review-header-sub">Loaded tree rows · System/app-managed</div>
            </div>
          )}
          {visibleRows.length === 0 ? (
            reviewView === 'caution' && totalRowsCount > 0 ? (
              <p className="tree-filter-empty">No caution areas in currently loaded rows.</p>
            ) : reviewView === 'reviewable' && totalRowsCount > 0 ? (
              <p className="tree-filter-empty">No reviewable areas ≥ 1 GiB in currently loaded rows.</p>
            ) : (
              <p className="empty-note">
                No root entries available. Run a live scan to load the folder tree.
              </p>
            )
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
              ) : row.treeTruncated !== undefined ? (
                <div
                  key={`trunc-${row.node.record_index}`}
                  className="tree-truncated-note"
                  style={{ paddingLeft: 8 + row.depth * 16 }}
                >
                  Showing top {formatNumber(row.treeTruncated.shown)} of {formatNumber(row.treeTruncated.total)}.{" "}
                  Use <em>Insights › Search inside</em> for more.
                </div>
              ) : (
                <TreeNodeRow
                  key={row.node.record_index}
                  node={row.node}
                  depth={row.depth}
                  totalSize={totalSize}
                  isExpanded={expandedIds.has(row.node.record_index)}
                  isLoading={loadingIds.has(row.node.record_index)}
                  isSelected={
                    focusedRecordIndex !== null
                      ? focusedRecordIndex === row.node.record_index
                      : selectedRecordIndex === row.node.record_index
                  }
                  isFocused={focusedRecordIndex === row.node.record_index}
                  isRecycled={recycledItems ? isItemRecycled(row.node.record_index, row.node.path, recycledItems) : false}
                  onToggleExpand={onToggleExpand}
                  onSelect={onSelect}
                  onContextMenu={onContextMenu}
                  onKeyDown={onKeyDown}
                />
              )
            )
          )}
        </div>
      )}

      {treeError && (
        <div className={`folder-nav-footer ${sourceKind === "cached" ? "folder-nav-footer--cached-note" : "folder-nav-footer--error"}`}>{treeError}</div>
      )}
      <div className={reviewView === 'all' && visibleRows.length >= LARGE_TREE_THRESHOLD
        ? "folder-nav-footer folder-nav-footer--warn"
        : "folder-nav-footer"}>
        {footerText}
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
  cleanupRefreshDelta,
  isBookmarked: folderIsBookmarked,
  onToggleBookmark,
}: {
  dir: DirectoryEntry;
  reclaimable: ReclaimableSummary | null;
  reclaimableLoading: boolean;
  reclaimableError: string | null;
  sourceKind: SourceKind | null;
  cleanupRefreshDelta: CleanupRefreshDelta | null;
  isBookmarked?: boolean;
  onToggleBookmark?: () => void;
}) {
  const confidenceClass = reclaimable
    ? `confidence-badge confidence-badge--${reclaimable.confidence.toLowerCase()}`
    : "confidence-badge";

  return (
    <div className="selected-folder-card">
      <div className="selected-folder-header">
        <span className="selected-folder-label">Selected folder</span>
        {onToggleBookmark && (
          <button
            className={`btn btn--bookmark${folderIsBookmarked ? " btn--bookmark--active" : ""}`}
            onClick={onToggleBookmark}
            title={folderIsBookmarked ? "Remove bookmark" : "Add bookmark"}
            aria-label={folderIsBookmarked ? "Remove bookmark" : "Add bookmark"}
          >
            {folderIsBookmarked ? "★" : "☆"}
          </button>
        )}
      </div>
      <div className="selected-folder-path" title={dir.path}>
        {isDriveRoot(dir.path) ? (
          <span className="selected-folder-basename">{dir.path}</span>
        ) : (
          <>
            <div className="selected-folder-basename">
              {dir.path.slice(dir.path.lastIndexOf("\\") + 1) || dir.path}
            </div>
            <div className="selected-folder-parentpath">
              {dir.path.slice(0, dir.path.lastIndexOf("\\") + 1)}
            </div>
          </>
        )}
      </div>
      {cleanupRefreshDelta && (
        <div className="selected-folder-note selected-folder-note--cleanup-delta">
          {formatDriveFreeDelta(
            cleanupRefreshDelta.deltaBytes,
            cleanupRefreshDelta.recycleContext === true,
          )}
          <span>May include changes from other apps.</span>
          {cleanupRefreshDelta.recycleContext === true &&
            Math.abs(cleanupRefreshDelta.deltaBytes) < NEAR_ZERO_FREE_DELTA_BYTES && (
              <span>Recycled items still occupy disk space until the Recycle Bin is emptied.</span>
            )}
        </div>
      )}
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
        <details className="reclaimable-details" open>
          <summary className="reclaimable-summary">
            {reclaimableLoading && "Estimated reclaimable: loading…"}
            {reclaimableError && "Reclaimable estimate unavailable"}
            {reclaimable && reclaimable.not_recommended && "Estimated reclaimable: not recommended as target"}
            {reclaimable && !reclaimable.not_recommended && (
              <>
                {"Estimated reclaimable: "}
                <strong>{formatBytes(reclaimable.wof_adjusted_bytes)}</strong>
                {" "}
                <span className={confidenceClass}>{reclaimable.confidence}</span>
              </>
            )}
            {!reclaimableLoading && !reclaimableError && !reclaimable && sourceKind === "cached" && (
              "Reclaimable: available after refresh"
            )}
          </summary>
          {reclaimable && !reclaimable.not_recommended && (
            <div className="reclaimable-section">
              <div className="reclaimable-range">
                {reclaimable.confidence === "High" &&
                 (reclaimable.range_upper - reclaimable.range_lower) < reclaimable.range_upper * 0.01
                  ? "Range: tight (within 1%)"
                  : `Range: ${formatBytes(reclaimable.range_lower)} – ${formatBytes(reclaimable.range_upper)}`}
              </div>
              <div className="reclaimable-basis" title={reclaimable.basis}>{reclaimable.basis}</div>
              <div className="reclaimable-caution" title={reclaimable.caution}>{reclaimable.caution}</div>
            </div>
          )}
        </details>
      )}
    </div>
  );
}

function DirectoriesTable({
  rows,
  title,
  totalSize,
  basePath,
  advancedMode,
  onOpenExplorer,
  onShowProperties,
  onRequestRecycle,
  recycledItems,
  onCopyError,
  onExternalHandoff,
  isBookmarked,
  onToggleBookmark,
}: {
  rows: DirectoryEntry[];
  title: React.ReactNode;
  totalSize: number;
  basePath?: string | null;
  advancedMode: boolean;
  onOpenExplorer: (path: string) => void;
  onShowProperties: (path: string) => void;
  onRequestRecycle: (target: ContextMenuTarget) => void;
  recycledItems?: RecycledItem[];
  onCopyError: (msg: string) => void;
  onExternalHandoff?: () => void;
  isBookmarked?: (path: string) => boolean;
  onToggleBookmark?: (path: string, isDirectory: boolean) => void;
}) {
  const [ctxMenu, setCtxMenu] = useState<ContextMenuTarget | null>(null);

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
            {rows.map((row) => {
              const rowIsRecycled = recycledItems
                ? isItemRecycled(row.record_index, row.path, recycledItems)
                : false;
              return (
                <tr
                  key={row.record_index}
                  className={rowIsRecycled ? "table-row--recycled" : undefined}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setCtxMenu({
                      path: row.path,
                      isDirectory: true,
                      recordIndex: row.record_index,
                      x: e.clientX,
                      y: e.clientY,
                      sizeBytes: row.subtree_size,
                    });
                  }}
                >
                  <td className="path" title={row.path}>
                    {formatRelativePath(row.path, basePath)}
                    {rowIsRecycled && <span className="recycled-badge recycled-badge--table">Recycled</span>}
                  </td>
                  <td className="numeric">
                    {formatBytes(row.subtree_size)}
                    {totalSize > 0 && <span className="size-pct"> · {formatPercent(row.subtree_size, totalSize)}</span>}
                  </td>
                  <td className="numeric">
                    {formatBytes(row.direct_file_size)}
                    {totalSize > 0 && row.direct_file_size > 0 && <span className="size-pct"> · {formatPercent(row.direct_file_size, totalSize)}</span>}
                  </td>
                  <td className="numeric">{formatNumber(row.child_count)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {ctxMenu && (
        <SafeContextMenu
          target={ctxMenu}
          onClose={() => setCtxMenu(null)}
          onOpenExplorer={onOpenExplorer}
          onShowProperties={onShowProperties}
          advancedMode={advancedMode}
          onRequestRecycle={onRequestRecycle}
          isAlreadyRecycled={recycledItems
            ? isItemRecycled(ctxMenu.recordIndex, ctxMenu.path, recycledItems)
            : false}
          onCopyError={onCopyError}
          onExternalHandoff={onExternalHandoff}
          isBookmarked={isBookmarked ? isBookmarked(ctxMenu.path) : undefined}
          onToggleBookmark={onToggleBookmark ? () => onToggleBookmark(ctxMenu.path, true) : undefined}
        />
      )}
    </section>
  );
}

function FilesTable({
  rows,
  title,
  totalSize,
  basePath,
  advancedMode,
  onOpenLocation,
  onSelectFile,
  onShowProperties,
  onRequestRecycle,
  recycledItems,
  onCopyError,
  onExternalHandoff,
  isBookmarked,
  onToggleBookmark,
}: {
  rows: FileEntry[];
  title: React.ReactNode;
  totalSize: number;
  basePath?: string | null;
  advancedMode: boolean;
  onOpenLocation: (path: string) => void;
  onSelectFile: (path: string) => void;
  onShowProperties: (path: string) => void;
  onRequestRecycle: (target: ContextMenuTarget) => void;
  recycledItems?: RecycledItem[];
  onCopyError: (msg: string) => void;
  onExternalHandoff?: () => void;
  isBookmarked?: (path: string) => boolean;
  onToggleBookmark?: (path: string, isDirectory: boolean) => void;
}) {
  const [ctxMenu, setCtxMenu] = useState<ContextMenuTarget | null>(null);

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
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const rowIsRecycled = recycledItems
                  ? isItemRecycled(row.record_index, row.path, recycledItems)
                  : false;
                return (
                  <tr
                    key={row.record_index}
                    className={rowIsRecycled ? "table-row--recycled" : undefined}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setCtxMenu({
                        path: row.path,
                        isDirectory: false,
                        recordIndex: row.record_index,
                        x: e.clientX,
                        y: e.clientY,
                        displayName: getFileName(row.path),
                        sizeBytes: row.final_allocated_size,
                      });
                    }}
                  >
                    <td className="path" title={row.path}>
                      {formatRelativePath(row.path, basePath)}
                      {rowIsRecycled && <span className="recycled-badge recycled-badge--table">Recycled</span>}
                    </td>
                    <td className="numeric">
                      {formatBytes(row.final_allocated_size)}
                      {totalSize > 0 && <span className="size-pct"> · {formatPercent(row.final_allocated_size, totalSize)}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {ctxMenu && (
        <SafeContextMenu
          target={ctxMenu}
          onClose={() => setCtxMenu(null)}
          onOpenExplorer={onOpenLocation}
          onSelectFile={onSelectFile}
          onShowProperties={onShowProperties}
          advancedMode={advancedMode}
          onRequestRecycle={onRequestRecycle}
          isAlreadyRecycled={recycledItems
            ? isItemRecycled(ctxMenu.recordIndex, ctxMenu.path, recycledItems)
            : false}
          onCopyError={onCopyError}
          onExternalHandoff={onExternalHandoff}
          isBookmarked={isBookmarked ? isBookmarked(ctxMenu.path) : undefined}
          onToggleBookmark={onToggleBookmark ? () => onToggleBookmark(ctxMenu.path, false) : undefined}
        />
      )}
    </section>
  );
}

function SubtreeSearchPanel({
  selectedDir,
  sourceKind,
  totalSize,
  advancedMode,
  onOpenExplorer,
  onSelectFile,
  onShowProperties,
  onRequestRecycle,
  recycledItems,
  onCopyError,
  onExternalHandoff,
  isBookmarked,
  onToggleBookmark,
}: {
  selectedDir: DirectoryEntry;
  sourceKind: SourceKind | null;
  totalSize: number;
  advancedMode: boolean;
  onOpenExplorer: (path: string) => void;
  onSelectFile: (path: string) => void;
  onShowProperties: (path: string) => void;
  onRequestRecycle: (target: ContextMenuTarget) => void;
  recycledItems?: RecycledItem[];
  onCopyError: (msg: string) => void;
  onExternalHandoff?: () => void;
  isBookmarked?: (path: string) => boolean;
  onToggleBookmark?: (path: string, isDirectory: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TreeNode[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuTarget | null>(null);
  const debounceRef = useRef<number | null>(null);
  const searchGenRef = useRef(0);

  const isLive = sourceKind === "live";
  const isRoot = isDriveRoot(selectedDir.path);
  const isDisabled = !isLive || isRoot;

  useEffect(() => {
    searchGenRef.current += 1;
    setQuery("");
    setResults(null);
    setError(null);
    setIsLoading(false);
    setCtxMenu(null);
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, [selectedDir.record_index]);

  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, []);

  // Clear search state when live scan ends (e.g. rescan starts, cached result shown).
  useEffect(() => {
    if (!isLive) {
      searchGenRef.current += 1;
      setQuery("");
      setResults(null);
      setError(null);
      setIsLoading(false);
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    }
  }, [isLive]);

  function runSearch(trimmed: string) {
    searchGenRef.current += 1;
    const gen = searchGenRef.current;
    setIsLoading(true);
    setError(null);
    setResults(null);
    searchSubtree(selectedDir.record_index, trimmed, 200)
      .then((nodes) => {
        if (gen !== searchGenRef.current) return;
        setResults(nodes);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (gen !== searchGenRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setResults(null);
        setIsLoading(false);
      });
  }

  function handleQueryChange(value: string) {
    setQuery(value);
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (isDisabled) {
      setResults(null);
      setError(null);
      return;
    }
    const trimmed = value.trim();
    if (trimmed.length < 2) {
      setResults(null);
      setError(null);
      setIsLoading(false);
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      runSearch(trimmed);
    }, 250);
  }

  const placeholder = !isLive
    ? "Search requires a live scan."
    : isRoot
      ? "Select a folder below the drive root to search."
      : "Search in selected folder...";

  let body: React.ReactNode = null;
  if (!isLive) {
    body = <p className="subtree-search-note">Search requires a live scan.</p>;
  } else if (isRoot) {
    body = <p className="subtree-search-note">Select a folder below the drive root to search.</p>;
  } else if (query.trim().length > 0 && query.trim().length < 2) {
    body = <p className="subtree-search-note">Enter at least 2 characters.</p>;
  } else if (isLoading) {
    body = <p className="subtree-search-note">Searching…</p>;
  } else if (error) {
    body = <p className="subtree-search-note subtree-search-note--error">{error}</p>;
  } else if (results !== null && results.length === 0) {
    body = <p className="subtree-search-note">No matches in selected folder.</p>;
  }

  const folderName = !isDriveRoot(selectedDir.path) ? breadcrumbLabel(selectedDir.path) : null;
  const resultSuffix = results !== null && results.length > 0
    ? ` · ${formatNumber(results.length)}${results.length >= 200 ? "+" : ""} result${results.length !== 1 ? "s" : ""}`
    : null;
  const summaryLabel = folderName ? `Search inside ${folderName}` : "Search inside selected folder";

  return (
    <details className="subtree-search-panel">
      <summary className="subtree-search-summary">
        {summaryLabel}{resultSuffix}
      </summary>
      <div className="subtree-search-input-row">
        <input
          className="filter-input"
          type="text"
          placeholder={placeholder}
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          disabled={isDisabled}
          aria-label="Search in selected folder"
        />
        {query && !isDisabled && (
          <button
            className="filter-clear-btn"
            onClick={() => handleQueryChange("")}
            title="Clear search"
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>
      {body}
      {!isLoading && results !== null && results.length > 0 && (
        <>
          <div className={results.length >= 200
            ? "subtree-search-count subtree-search-count--capped"
            : "subtree-search-count"}>
            {results.length >= 200
              ? "Showing first 200 matches. Refine your query."
              : `${formatNumber(results.length)} match${results.length !== 1 ? "es" : ""} in selected folder`}
          </div>
          <div className="subtree-search-list">
            {results.map((node) => {
              const nodeIsRecycled = recycledItems
                ? isItemRecycled(node.record_index, node.path, recycledItems)
                : false;
              return (
                <div
                  key={node.record_index}
                  className={`subtree-result-row${ctxMenu?.recordIndex === node.record_index ? " subtree-result-row--context" : ""}${nodeIsRecycled ? " subtree-result-row--recycled" : ""}`}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setCtxMenu({
                      path: node.path,
                      isDirectory: node.is_directory,
                      recordIndex: node.record_index,
                      x: e.clientX,
                      y: e.clientY,
                      displayName: node.name,
                      sizeBytes: node.subtree_size,
                    });
                  }}
                >
                  <span className={`direct-child-badge direct-child-badge--${node.is_directory ? "dir" : "file"}`}>
                    {node.is_directory ? "DIR" : "FILE"}
                  </span>
                  <span className="subtree-result-path" title={node.path}>
                    {formatRelativePath(node.path, selectedDir.path)}
                  </span>
                  {nodeIsRecycled && <span className="recycled-badge">Recycled</span>}
                  <span className="direct-child-size">
                    {formatBytes(node.subtree_size)}
                    {totalSize > 0 && <span className="size-pct"> · {formatPercent(node.subtree_size, totalSize)}</span>}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
      {ctxMenu && (
        <SafeContextMenu
          target={ctxMenu}
          onClose={() => setCtxMenu(null)}
          onOpenExplorer={onOpenExplorer}
          onSelectFile={onSelectFile}
          onShowProperties={onShowProperties}
          advancedMode={advancedMode}
          onRequestRecycle={onRequestRecycle}
          isAlreadyRecycled={recycledItems
            ? isItemRecycled(ctxMenu.recordIndex, ctxMenu.path, recycledItems)
            : false}
          onCopyError={onCopyError}
          onExternalHandoff={onExternalHandoff}
          isBookmarked={isBookmarked ? isBookmarked(ctxMenu.path) : undefined}
          onToggleBookmark={onToggleBookmark ? () => onToggleBookmark(ctxMenu.path, ctxMenu.isDirectory) : undefined}
        />
      )}
    </details>
  );
}

function DirectChildrenPanel({
  dir,
  children,
  totalCount,
  isLoading,
  error,
  sourceKind,
  currentFilterQuery,
  totalSize,
  sortKey,
  sortDir,
  onSortKeyChange,
  onSortDirChange,
  ancestorDirs,
  onNavigateToDir,
  onNavigate,
  onOpenExplorer,
  onSelectFile,
  onShowProperties,
  advancedMode,
  onRequestRecycle,
  recycledItems,
  onCopyError,
  onExternalHandoff,
}: {
  dir: DirectoryEntry;
  children: TreeNode[] | undefined;
  totalCount?: number;
  isLoading: boolean;
  error: string | null;
  sourceKind: SourceKind | null;
  currentFilterQuery: string;
  totalSize: number;
  sortKey: DirectChildrenSortKey;
  sortDir: SortDirection;
  onSortKeyChange: (key: DirectChildrenSortKey) => void;
  onSortDirChange: (dir: SortDirection) => void;
  ancestorDirs: DirectoryEntry[];
  onNavigateToDir: (dir: DirectoryEntry) => void;
  onNavigate: (node: TreeNode) => void;
  onOpenExplorer: (path: string) => void;
  onSelectFile: (path: string) => void;
  onShowProperties: (path: string) => void;
  advancedMode: boolean;
  onRequestRecycle: (target: ContextMenuTarget) => void;
  recycledItems?: RecycledItem[];
  onCopyError: (msg: string) => void;
  onExternalHandoff?: () => void;
}) {

  const [contextMenu, setContextMenu] = useState<ContextMenuTarget | null>(null);

  useEffect(() => {
    setContextMenu(null);
  }, [dir.record_index]);

  useEffect(() => {
    if (children !== undefined) {
      perfLog(`DirectChildrenPanel update  path=${dir.path}  nodes=${children.length}  totalCount=${totalCount ?? "?"}  isLoading=${isLoading}`);
    }
  }, [children, totalCount, isLoading, dir.path]);

  function handleContextMenu(e: React.MouseEvent<HTMLDivElement>, node: TreeNode) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      path: node.path,
      isDirectory: node.is_directory,
      recordIndex: node.record_index,
      x: e.clientX,
      y: e.clientY,
      displayName: node.name,
      sizeBytes: node.subtree_size,
    });
  }

  const filtered = useMemo(() => {
    if (!children) return [];
    const cq = currentFilterQuery.trim().toLowerCase();
    if (!cq) return children;
    return children.filter(
      (n) =>
        n.name.toLowerCase().includes(cq) ||
        n.path.toLowerCase().includes(cq),
    );
  }, [children, currentFilterQuery]);

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
  } else if (currentFilterQuery.trim() && sorted.length === 0) {
    body = (
      <p className="direct-children-note">
        No direct children match &ldquo;{currentFilterQuery.trim()}&rdquo;.
      </p>
    );
  } else {
    const displayEntries = sorted.length > DIRECT_CHILDREN_DISPLAY_LIMIT
      ? sorted.slice(0, DIRECT_CHILDREN_DISPLAY_LIMIT)
      : sorted;
    body = (
      <div className="direct-children-list">
        {displayEntries.map((node) => {
          const nodeIsRecycled = recycledItems
            ? isItemRecycled(node.record_index, node.path, recycledItems)
            : false;
          return (
            <div
              key={node.record_index}
              className={`direct-child-row${node.is_directory ? " direct-child-row--dir" : ""}${contextMenu?.recordIndex === node.record_index ? " direct-child-row--context" : ""}${nodeIsRecycled ? " direct-child-row--recycled" : ""}`}
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
              {nodeIsRecycled && <span className="recycled-badge">Recycled</span>}
              <span
                className="direct-child-size"
                title="Estimated allocated-style size."
              >
                {formatBytes(node.subtree_size)}
                {totalSize > 0 && <span className="size-pct"> · {formatPercent(node.subtree_size, totalSize)}</span>}
              </span>
            </div>
          );
        })}
        {totalCount !== undefined && totalCount > displayEntries.length && (
          <div className="direct-children-truncation-note">
            Showing top {formatNumber(displayEntries.length)} of {formatNumber(totalCount)} entries
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="direct-children-panel">
      <div className="direct-children-header">
        <span className="direct-children-title">Selected folder contents</span>
        <div className="direct-children-controls">
          {children !== undefined && (
            <span className="direct-children-count">
              {currentFilterQuery.trim()
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
      {contextMenu && (
        <SafeContextMenu
          target={contextMenu}
          onClose={() => setContextMenu(null)}
          onOpenExplorer={onOpenExplorer}
          onSelectFile={onSelectFile}
          onShowProperties={onShowProperties}
          advancedMode={advancedMode}
          onRequestRecycle={onRequestRecycle}
          isAlreadyRecycled={recycledItems
            ? isItemRecycled(contextMenu.recordIndex, contextMenu.path, recycledItems)
            : false}
          onCopyError={onCopyError}
          onExternalHandoff={onExternalHandoff}
        />
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
  const bookmarkUndoTimerRef = useRef<number | null>(null);
  const bookmarkAutoResolveKey = useRef<string | null>(null);
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
  const [cleanupRefreshDelta, setCleanupRefreshDelta] = useState<CleanupRefreshDelta | null>(null);
  const [unsupportedDriveCapacity, setUnsupportedDriveCapacity] =
    useState<UnsupportedDriveCapacity | null>(null);
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
  const [treeExpandedTotalCount, setTreeExpandedTotalCount] = useState<Record<number, number>>({});
  const [treeError, setTreeError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [selectedDirLimited, setSelectedDirLimited] = useState<ChildrenLimitedResult | null>(null);
  const [selectedDirLimitedLoading, setSelectedDirLimitedLoading] = useState(false);
  const [selectedDirLimitedError, setSelectedDirLimitedError] = useState<string | null>(null);
  const [reclaimable, setReclaimable] = useState<ReclaimableSummary | null>(null);
  const [reclaimableLoading, setReclaimableLoading] = useState(false);
  const [reclaimableError, setReclaimableError] = useState<string | null>(null);
  const [focusedRecordIndex, setFocusedRecordIndex] = useState<number | null>(null);
  const [treeContextMenu, setTreeContextMenu] = useState<ContextMenuTarget | null>(null);
  const [currentFilterQuery, setCurrentFilterQuery] = useState("");
  const [cancelMessage, setCancelMessage] = useState<string | null>(null);
  const [advancedMode, setAdvancedMode] = useState(false);
  const [advancedModeWarningOpen, setAdvancedModeWarningOpen] = useState(false);
  const [recycleConfirmTarget, setRecycleConfirmTarget] = useState<RecycleConfirmTarget | null>(null);
  const [isRecycling, setIsRecycling] = useState(false);
  const [recycleError, setRecycleError] = useState<string | null>(null);
  const [recycleSuccess, setRecycleSuccess] = useState<RecycleSuccess | null>(null);
  const [recycledItems, setRecycledItems] = useState<RecycledItem[]>([]);
  const [selectedLargestItems, setSelectedLargestItems] = useState<LargestItemsResponse | null>(null);
  const [largestItemsLoading, setLargestItemsLoading] = useState(false);
  const [largestItemsError, setLargestItemsError] = useState<string | null>(null);
  const [handoffNotice, setHandoffNotice] = useState(false);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [bookmarkJumpStates, setBookmarkJumpStates] = useState<Record<string, BookmarkJumpState>>({});
  const [bookmarkUndoNotice, setBookmarkUndoNotice] = useState<{ displayName: string; bookmark: Bookmark } | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [adminWarningDismissed, setAdminWarningDismissed] = useState(false);
  const [treeReviewView, setTreeReviewView] = useState<TreeReviewView>('all');
  const [reviewListItems, setReviewListItems] = useState<ReviewListItem[]>([]);

  // ── Tree focus diagnostics (TREE_FOCUS_DEBUG) ────────────────────────────
  // Always created (cheap). All recording code is behind if(TREE_FOCUS_DEBUG)
  // guards so there is zero runtime overhead when the flag is false.
  const focusEventBuf    = useRef<FocusBufEntry[]>([]);
  const dbgFocusedRIRef  = useRef<number | null>(null);
  const dbgSelectedDirRef = useRef<{ record_index: number; path: string } | null>(null);
  const dbgVisibleCountRef = useRef<number>(0);

  // When set to a record_index, the focus recovery useEffect will move DOM focus
  // to that row (or folder-nav as fallback) after the next expandedIds / childrenByParent update.
  const pendingTreeFocusRef = useRef<number | null>(null);

  function recordFocusEvent(partial: Omit<FocusBufEntry, "ts">) {
    if (!TREE_FOCUS_DEBUG) return;
    const ae = document.activeElement;
    const buf = focusEventBuf.current;
    buf.push({
      ts: Math.round(performance.now()),
      activeDomTag: ae?.tagName,
      activeDomCls: ae instanceof HTMLElement ? ae.className.slice(0, 60) || undefined : undefined,
      hasKeyNav: treeNavRef.current?.hasAttribute("data-keynav"),
      visibleCount: dbgVisibleCountRef.current,
      ...partial,
    });
    if (buf.length > FOCUS_BUF_MAX) buf.shift();
  }

  // buildTreeFocusSnapshot: builds the diagnostic snapshot object from current refs + DOM.
  // Does NOT copy to clipboard — callers do that so they can provide user feedback.
  // Reads from refs so it is always current regardless of when it is called.
  function buildTreeFocusSnapshot(): { snap: Record<string, unknown>; json: string } {
    const ae  = document.activeElement;
    const nav = treeNavRef.current;
    const activeRows  = document.querySelectorAll(".tree-row--active");
    const focusedRows = document.querySelectorAll(".tree-row--keyboard-focused");
    const snap: Record<string, unknown> = {
      ts:                 new Date().toISOString(),
      focusedRecordIndex: dbgFocusedRIRef.current,
      selectedDir:        dbgSelectedDirRef.current,
      visibleRowCount:    dbgVisibleCountRef.current,
      activeElement: ae ? {
        tag:            ae.tagName,
        cls:            ae instanceof HTMLElement ? ae.className.slice(0, 100) : undefined,
        insideFolderNav: nav?.contains(ae) ?? false,
        dataRI: ae instanceof HTMLElement
          ? (ae.dataset.recordIndex
              ?? ae.closest<HTMLElement>("[data-record-index]")?.dataset.recordIndex)
          : undefined,
      } : null,
      folderNavKeyNav:    nav?.hasAttribute("data-keynav") ?? false,
      folderNavHasFocus:  document.activeElement === nav,
      domActiveRowCount:  activeRows.length,
      domFocusedRowCount: focusedRows.length,
      anomalies:          [] as string[],
      recentEvents:       focusEventBuf.current.slice(),
    };
    const anomalies = snap.anomalies as string[];
    const focusedRI = dbgFocusedRIRef.current;
    if (focusedRI !== null && activeRows.length === 0)
      anomalies.push(`focusedRI=${focusedRI} but no .tree-row--active in DOM`);
    if (focusedRI !== null && focusedRows.length === 0)
      anomalies.push(`focusedRI=${focusedRI} but no .tree-row--keyboard-focused in DOM`);
    if (activeRows.length > 1)
      anomalies.push(`${activeRows.length} .tree-row--active elements (expected ≤1)`);
    if (focusedRI === null && ae instanceof HTMLElement && nav?.contains(ae))
      anomalies.push("activeElement is inside folder-nav but focusedRecordIndex is null");
    const json = JSON.stringify(snap, null, 2);
    console.log("[disk-insight tree-focus snapshot]", json);
    return { snap, json };
  }
  // jumpScrollFrnRef: FRN to center-scroll to after a bookmark jump.
  // jumpScrollTick: incrementing counter that triggers TreeView's center-scroll effect.
  const jumpScrollFrnRef = useRef<number | null>(null);
  const [jumpScrollTick, setJumpScrollTick] = useState(0);
  const scanRestoreRef = useRef<{ path: string; drive: string } | null>(null);
  const scanGenerationRef = useRef(0);
  const cancelMessageTimerRef = useRef<number | null>(null);
  const recycleRefreshPendingRef = useRef(false);
  const treeNavRef = useRef<HTMLElement | null>(null);

  // Stable handler refs — useRef so React.memo on TreeNodeRow can skip unchanged rows.
  // Each ref is updated every render, so the stable callback always calls the latest fn.
  const _toggleExpandFnRef = useRef<(node: TreeNode) => void>(() => {});
  const _selectNodeFnRef   = useRef<(node: TreeNode) => void>(() => {});
  const _contextMenuFnRef  = useRef<(e: React.MouseEvent<HTMLDivElement>, node: TreeNode) => void>(() => {});
  const _keyDownFnRef      = useRef<(e: React.KeyboardEvent) => void>(() => {});
  const stableToggleExpand  = useCallback((node: TreeNode) => _toggleExpandFnRef.current(node), []);
  const stableSelectNode    = useCallback((node: TreeNode) => _selectNodeFnRef.current(node), []);
  const stableContextMenu   = useCallback((e: React.MouseEvent<HTMLDivElement>, node: TreeNode) => _contextMenuFnRef.current(e, node), []);
  const stableKeyDown       = useCallback((e: React.KeyboardEvent) => _keyDownFnRef.current(e), []);
  // Clears keyboard-nav mode when the mouse moves inside the tree so hover resumes.
  const stableNavMouseMove  = useCallback(() => {
    treeNavRef.current?.removeAttribute('data-keynav');
  }, []);

  const visibleRows = useMemo(() => {
    const t0 = performance.now();
    const rows = buildVisibleRows(data?.root_children ?? [], expandedIds, childrenByParent, childrenErrors, treeExpandedTotalCount);
    perfLog(`visible-rows  count=${rows.length}  t=${(performance.now() - t0).toFixed(1)}ms`);
    return rows;
  }, [data?.root_children, expandedIds, childrenByParent, childrenErrors, treeExpandedTotalCount]);

  const GiB = 1024 ** 3;

  const filteredVisibleRows = useMemo(() => {
    if (treeReviewView === 'all') return visibleRows;
    // large-review uses a separate flat list from top scan results; tree is hidden
    if (treeReviewView === 'large-review') return [];
    // caution: filter loaded tree rows by protected-system / app-managed
    if (treeReviewView === 'caution') {
      return visibleRows.filter((row) => {
        if (row.isEmpty || row.nodeError || row.treeTruncated !== undefined) return false;
        return TREE_CAUTION_CATS.has(classifyCleanupSafety(row.node.path).category);
      });
    }
    // reviewable: non-caution loaded rows, size >= 1 GiB
    // (Large review uses global top results; this reflects the current tree context)
    return visibleRows.filter((row) => {
      if (row.isEmpty || row.nodeError || row.treeTruncated !== undefined) return false;
      if (TREE_CAUTION_CATS.has(classifyCleanupSafety(row.node.path).category)) return false;
      return row.node.subtree_size >= GiB;
    });
  }, [visibleRows, treeReviewView]);

  const largeReviewCandidates = useMemo((): ReviewCandidate[] => {
    if (!data) return [];
    const seen = new Set<string>();
    const items: ReviewCandidate[] = [];
    for (const d of data.top_directories) {
      const cat = classifyCleanupSafety(d.path).category;
      if (!TREE_REVIEW_CATS.has(cat) || d.subtree_size < GiB || seen.has(d.path)) continue;
      seen.add(d.path);
      items.push({ path: d.path, record_index: d.record_index, isDirectory: true, sizeBytes: d.subtree_size, categoryLabel: reviewCategoryLabel(cat) });
    }
    for (const f of data.top_files) {
      const cat = classifyCleanupSafety(f.path).category;
      if (!TREE_REVIEW_CATS.has(cat) || f.final_allocated_size < GiB || seen.has(f.path)) continue;
      seen.add(f.path);
      items.push({ path: f.path, record_index: f.record_index, isDirectory: false, sizeBytes: f.final_allocated_size, categoryLabel: reviewCategoryLabel(cat) });
    }
    items.sort((a, b) => b.sizeBytes - a.sizeBytes);
    return items;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.top_directories, data?.top_files]);

  const selectedAncestorDirs = useMemo(
    (): DirectoryEntry[] =>
      selectedDir && data
        ? buildAncestorEntries(selectedDir.path, data, childrenByParent)
        : [],
    [selectedDir, data, childrenByParent],
  );

  const topDirsBase = useMemo(
    () =>
      data
        ? selectedDir
          ? filterByDir(data.top_directories, selectedDir.path)
          : data.top_directories
        : [],
    [data, selectedDir],
  );

  const topFilesBase = useMemo(
    () =>
      data
        ? selectedDir
          ? filterByDir(data.top_files, selectedDir.path)
          : data.top_files
        : [],
    [data, selectedDir],
  );

  const filteredTopDirs = useMemo(() => {
    const q = currentFilterQuery.trim().toLowerCase();
    if (!q) return topDirsBase;
    return topDirsBase.filter((item) => item.path.toLowerCase().includes(q));
  }, [topDirsBase, currentFilterQuery]);

  const filteredTopFiles = useMemo(() => {
    const q = currentFilterQuery.trim().toLowerCase();
    if (!q) return topFilesBase;
    return topFilesBase.filter((item) => item.path.toLowerCase().includes(q));
  }, [topFilesBase, currentFilterQuery]);

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
      setSelectedDirLimited(null);
      setSelectedDirLimitedLoading(false);
      setSelectedDirLimitedError(null);
      return;
    }
    // DirectChildrenPanel lives inside the Insights lower panel (insightsOpen).
    // Skip IPC when Insights is closed — fetch will run when user opens Insights.
    if (!insightsOpen) {
      treeLog(`direct-children SKIP (insightsOpen=false)  path=${selectedDir.path}`);
      return;
    }
    // Drive root: use already-loaded root_children directly (no IPC needed)
    if (isDriveRoot(selectedDir.path) && data?.root_children !== undefined) {
      const rc = data.root_children;
      perfLog(`direct-children root  from root_children  count=${rc.length}`);
      setSelectedDirLimited({
        nodes: rc.slice(0, DIRECT_CHILDREN_DISPLAY_LIMIT),
        total_count: rc.length,
      });
      setSelectedDirLimitedLoading(false);
      setSelectedDirLimitedError(null);
      return;
    }
    const dcT0 = performance.now();
    perfLog(`direct-children START  path=${selectedDir.path}  record_index=${selectedDir.record_index}`);
    let cancelled = false;
    setSelectedDirLimitedLoading(true);
    setSelectedDirLimitedError(null);
    getChildrenLimited(selectedDir.record_index, DIRECT_CHILDREN_DISPLAY_LIMIT)
      .then((result) => {
        if (cancelled) return;
        perfLog(`direct-children DONE  path=${selectedDir.path}  t=${(performance.now() - dcT0).toFixed(0)}ms  nodes=${result.nodes.length}  total_count=${result.total_count}`);
        setSelectedDirLimited(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        perfLog(`direct-children ERROR  path=${selectedDir.path}  t=${(performance.now() - dcT0).toFixed(0)}ms`);
        setSelectedDirLimitedError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setSelectedDirLimitedLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDir, sourceKind, insightsOpen]);

  useEffect(() => {
    if (!selectedDir || !data || sourceKind !== "live") {
      setReclaimable(null);
      setReclaimableError(null);
      setReclaimableLoading(false);
      return;
    }
    // 150ms debounce: rapid arrow-key movement cancels previous requests so only
    // the folder the user stops on triggers get_reclaimable_summary IPC.
    let cancelled = false;
    let debounceId: number | null = null;
    debounceId = window.setTimeout(() => {
      debounceId = null;
      if (cancelled) return;
      const recT0 = performance.now();
      perfLog(`reclaimable START  path=${selectedDir.path}`);
      treeLog(`reclaimable IPC FIRED (after 150ms debounce)  path=${selectedDir.path}`);
      setReclaimableLoading(true);
      setReclaimableError(null);
      getReclaimableSummary(selectedDir.record_index, selectedDir.path, data.summary.drive)
        .then((summary) => {
          if (cancelled) return;
          perfLog(`reclaimable DONE  path=${selectedDir.path}  t=${(performance.now() - recT0).toFixed(0)}ms  confidence=${summary.confidence}`);
          setReclaimable(summary);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          perfLog(`reclaimable ERROR  path=${selectedDir.path}  t=${(performance.now() - recT0).toFixed(0)}ms`);
          setReclaimable(null);
          setReclaimableError(String(err));
        })
        .finally(() => {
          if (!cancelled) setReclaimableLoading(false);
        });
    }, 150);
    return () => {
      cancelled = true;
      if (debounceId !== null) {
        window.clearTimeout(debounceId);
        debounceId = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDir?.record_index, selectedDir?.path, data?.summary.drive, sourceKind]);

  useEffect(() => {
    if (!selectedDir || sourceKind !== "live") {
      setSelectedLargestItems(null);
      setLargestItemsError(null);
      setLargestItemsLoading(false);
      return;
    }
    // Largest items display is inside the Insights lower panel (insightsOpen).
    // Skip IPC when Insights is closed — fetch will run when user opens Insights.
    if (!insightsOpen) {
      treeLog(`largest-items SKIP (insightsOpen=false)  path=${selectedDir.path}`);
      setLargestItemsLoading(false);
      return;
    }
    let cancelled = false;
    let debounceId: number | null = null;
    setLargestItemsLoading(true);
    setLargestItemsError(null);
    debounceId = window.setTimeout(() => {
      debounceId = null;
      const liT0 = performance.now();
      perfLog(`largest-items START  path=${selectedDir.path}  record_index=${selectedDir.record_index}`);
      getLargestItemsUnder(selectedDir.record_index, 50)
        .then((result) => {
          if (cancelled) return;
          perfLog(`largest-items DONE  path=${selectedDir.path}  round-trip=${(performance.now() - liT0).toFixed(0)}ms  rust=${result.elapsed_ms.toFixed(0)}ms  folders=${result.folders.length}  files=${result.files.length}`);
          setSelectedLargestItems(result);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          perfLog(`largest-items ERROR  path=${selectedDir.path}  t=${(performance.now() - liT0).toFixed(0)}ms`);
          setSelectedLargestItems(null);
          setLargestItemsError(String(err));
        })
        .finally(() => {
          if (!cancelled) setLargestItemsLoading(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      if (debounceId !== null) {
        window.clearTimeout(debounceId);
        setLargestItemsLoading(false);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDir?.record_index, sourceKind, insightsOpen]);

  // When data loads (new scan) or bookmarks change, proactively mark cross-drive
  // bookmarks as "other_drive" so the badge shows without requiring a click.
  useEffect(() => {
    const currentSerial = data?.summary?.volume_serial?.toUpperCase();
    if (!currentSerial) return;
    setBookmarkJumpStates((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const b of bookmarks) {
        const bSerial = b.volume_serial?.toUpperCase();
        if (!bSerial || bSerial === "UNKNOWN") continue;
        const isOther = bSerial !== currentSerial;
        const prevStatus = prev[b.id]?.status;
        if (isOther && prevStatus !== "other_drive") {
          next[b.id] = { status: "other_drive", message: `Scan ${b.drive_letter}: to use this bookmark` };
          changed = true;
        } else if (!isOther && prevStatus === "other_drive") {
          // Drive changed to match — clear stale other_drive state
          delete next[b.id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.summary?.volume_serial, bookmarks]);

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
    setRecycleSuccess(null);
    recycleRefreshPendingRef.current = false;
    setCleanupRefreshDelta(null);
    setUnsupportedDriveCapacity(null);
    clearCacheBanner();
    setHandoffNotice(false);
    setInsightsOpen(false);
    setTreeReviewView('all');
    setReviewListItems([]);
    setExpandedIds(new Set());
    setLoadingIds(new Set());
    setChildrenByParent({});
    setChildrenErrors({});
    setTreeExpandedTotalCount({});
    setTreeError(null);
    setSelectedDirLimited(null);
    setSelectedDirLimitedLoading(false);
    setSelectedDirLimitedError(null);
    setReclaimable(null);
    setReclaimableLoading(false);
    setReclaimableError(null);
    setSelectedLargestItems(null);
    setLargestItemsLoading(false);
    setLargestItemsError(null);
    setFocusedRecordIndex(null);
    setRecycledItems([]);
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
        setUnsupportedDriveCapacity(null);
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
  ): Promise<boolean> {
    scanGenerationRef.current += 1;
    const generation = scanGenerationRef.current;
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
    setCancelMessage(null);
    setRecycleSuccess(null);
    setHandoffNotice(false);
    setInsightsOpen(false);
    recycleRefreshPendingRef.current = false;
    setCleanupRefreshDelta(null);
    setUnsupportedDriveCapacity(null);
    clearCacheBanner();
    setRecycledItems([]);
    scanRestoreRef.current =
      selectedDir && data
        ? { path: selectedDir.path, drive: data.summary.drive }
        : null;
    setExpandedIds(new Set());
    setLoadingIds(new Set());
    setChildrenByParent({});
    setChildrenErrors({});
    setTreeExpandedTotalCount({});
    setTreeError(null);
    setSelectedDirLimited(null);
    setSelectedDirLimitedLoading(false);
    setSelectedDirLimitedError(null);
    setReclaimable(null);
    setReclaimableLoading(false);
    setReclaimableError(null);
    setSelectedLargestItems(null);
    setLargestItemsLoading(false);
    setLargestItemsError(null);
    setFocusedRecordIndex(null);

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
        const cacheRestore = scanRestoreRef.current;
        // Do NOT clear scanRestoreRef here — fresh result restore still needs it.
        let cachedRestoredDir: DirectoryEntry | undefined;
        if (cacheRestore && cacheRestore.drive === `${drive}:`) {
          const node = (cached.output.root_children ?? []).find(
            (n: TreeNode) => n.is_directory && n.path === cacheRestore.path,
          );
          if (node) {
            cachedRestoredDir = treeNodeToDirEntry(node);
            setFocusedRecordIndex(node.record_index);
          }
        }
        setSelectedDir(cachedRestoredDir ?? cached.output.top_directories[0]);
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
      if (scanGenerationRef.current !== generation) return false;
      const json = await scanDrive(drive, top, policy);
      if (scanGenerationRef.current !== generation) return false;
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
      setUnsupportedDriveCapacity(null);
      setLastUpdated(new Date());
      setScanTopN(top);
      const restore = scanRestoreRef.current;
      scanRestoreRef.current = null;
      let restoredDir: DirectoryEntry | undefined;
      if (restore && restore.drive === `${drive}:`) {
        const node = (json.root_children ?? []).find(
          (n) => n.is_directory && n.path === restore.path,
        );
        if (node) {
          restoredDir = treeNodeToDirEntry(node);
          setFocusedRecordIndex(node.record_index);
        }
      }
      setSelectedDir(restoredDir ?? json.top_directories[0]);
      showUpdatedBanner();
      console.log(`[perf-ui] setData called  t+${(performance.now() - t0).toFixed(0)} ms`);
      setIsLoading(false);
      return true;
    } catch (err: unknown) {
      clearPendingProgressLatch();
      if (scanGenerationRef.current !== generation) return false;
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
      try {
        const capacity = await getDriveCapacityNow(drive);
        if (scanGenerationRef.current === generation) {
          setUnsupportedDriveCapacity({
            drive: `${drive}:`,
            capacity,
            note: unsupportedCapacityNote(message),
          });
        }
      } catch (capacityErr: unknown) {
        console.warn("[capacity-ui] unsupported drive capacity unavailable", capacityErr);
      }
      return false;
    }
  }

  function handleTreeKeyDown(e: React.KeyboardEvent) {
    const navKeys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Enter"];
    if (!navKeys.includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation(); // prevent double-fire when called from both row div and folder-nav

    if (TREE_FOCUS_DEBUG) {
      recordFocusEvent({
        kind:      "keydown",
        key:       e.key,
        targetTag: (e.target as Element)?.tagName,
        targetCls: (e.target as HTMLElement)?.className?.slice(0, 60),
        focusedRI: focusedRecordIndex,
        note: `target=${e.target === treeNavRef.current ? "folder-nav" : "row/button"}`,
      });
    }

    // Enter keyboard-nav mode: CSS .folder-nav[data-keynav] suppresses hover on
    // non-active rows so the old mouse-hover position does not leave a stale highlight.
    // Cleared on first mousemove inside folder-nav (see stableNavMouseMove / onNavMouseMove).
    treeNavRef.current?.setAttribute('data-keynav', '1');

    const t0 = performance.now();

    const filterT0 = performance.now();
    const allRows = filteredVisibleRows.filter(
      (r) => !r.isEmpty && !r.nodeError && r.treeTruncated === undefined,
    );
    const filterMs = (performance.now() - filterT0).toFixed(1);
    treeLog(`key=${e.key} START  visible=${filteredVisibleRows.length}  navigable=${allRows.length}  filter=${filterMs}ms`);
    if (allRows.length === 0) return;

    const currentIdx =
      focusedRecordIndex !== null
        ? allRows.findIndex((r) => r.node.record_index === focusedRecordIndex)
        : -1;
    const currentRow = currentIdx >= 0 ? allRows[currentIdx] : null;

    if (TREE_FOCUS_DEBUG && focusedRecordIndex !== null && currentRow === null) {
      focusDbg(`ANOMALY: currentRow=null but focusedRI=${focusedRecordIndex}  allRows=${allRows.length}  key=${e.key}`);
      recordFocusEvent({ kind: "anomaly-no-current-row", focusedRI: focusedRecordIndex, note: `key=${e.key} allRows=${allRows.length}` });
    }

    function moveToRow(idx: number) {
      const row = allRows[Math.max(0, Math.min(allRows.length - 1, idx))];
      treeLog(`moveToRow  from_ri=${currentRow?.node.record_index ?? "none"}  to_ri=${row.node.record_index}  to_name=${row.node.name}  is_dir=${row.node.is_directory}  → setFocused + ${row.node.is_directory ? "handleSelectTreeNode(triggers reclaimable/DC/LI IPC)" : "no IPC"}`);
      if (TREE_FOCUS_DEBUG) {
        recordFocusEvent({ kind: "moveToRow", focusedRI: focusedRecordIndex, note: `from=${currentRow?.node.record_index ?? "none"} to=${row.node.record_index} name=${row.node.name}` });
      }
      setFocusedRecordIndex(row.node.record_index);
      if (row.node.is_directory) handleSelectTreeNode(row.node);
    }

    switch (e.key) {
      case "ArrowDown":
        moveToRow(currentIdx < 0 ? 0 : Math.min(allRows.length - 1, currentIdx + 1));
        break;
      case "ArrowUp":
        moveToRow(currentIdx < 0 ? 0 : Math.max(0, currentIdx - 1));
        break;
      case "Home":
        moveToRow(0);
        break;
      case "End":
        moveToRow(allRows.length - 1);
        break;
      case "Enter":
        if (currentRow && currentRow.node.is_directory) handleSelectTreeNode(currentRow.node);
        break;
      case "ArrowRight": {
        if (!currentRow) { moveToRow(0); break; }
        if (!currentRow.node.is_directory) break; // files don't expand
        const curId = currentRow.node.record_index;
        if (!expandedIds.has(curId)) {
          treeLog(`ArrowRight EXPAND  ri=${curId}  name=${currentRow.node.name}  → getChildrenLimited IPC`);
          handleToggleExpand(currentRow.node); // uses getChildrenLimited — WinSxS-safe
        } else {
          // Move to first child row (any type)
          for (let i = currentIdx + 1; i < allRows.length; i++) {
            if (allRows[i].depth <= currentRow.depth) break; // exited subtree
            moveToRow(i);
            break;
          }
        }
        break;
      }
      case "ArrowLeft": {
        if (!currentRow) break;
        const curId = currentRow.node.record_index;
        if (currentRow.node.is_directory && expandedIds.has(curId)) {
          treeLog(`ArrowLeft COLLAPSE  ri=${curId}  name=${currentRow.node.name}`);
          handleToggleExpand(currentRow.node); // collapse
        } else {
          // Move to parent folder
          const parentIdx = allRows.findIndex(
            (r) => r.node.record_index === currentRow.node.parent_record_index,
          );
          if (parentIdx >= 0) moveToRow(parentIdx);
        }
        break;
      }
    }

    treeLog(`key=${e.key} DONE  sync_elapsed=${(performance.now()-t0).toFixed(1)}ms  (async: React re-render + IPC not included)`);
  }

  function handleSelectTreeNode(node: TreeNode) {
    if (!node.is_directory) return;
    perfLog(`select-node  path=${node.path}  record_index=${node.record_index}`);
    treeLog(`handleSelectTreeNode  ri=${node.record_index}  path=${node.path}  insightsOpen=${insightsOpen}  → reclaimable=WILL_FIRE  DC=${insightsOpen ? "WILL_FIRE" : "skipped"}  LI=${insightsOpen ? "WILL_FIRE(200ms)" : "skipped"}`);
    if (TREE_FOCUS_DEBUG) {
      recordFocusEvent({ kind: "selectTreeNode", focusedRI: focusedRecordIndex, note: `ri=${node.record_index} path=${node.path}` });
    }
    // During a refresh, keep scanRestoreRef current with the latest user
    // selection so fresh result restore uses it instead of the pre-scan snapshot.
    if (isLoading && data) {
      const isRootChild = (data.root_children ?? []).some(
        (n) => n.record_index === node.record_index,
      );
      if (isRootChild) {
        scanRestoreRef.current = { path: node.path, drive: data.summary.drive };
      }
    }
    setFocusedRecordIndex(node.record_index);
    setSelectedDir(treeNodeToDirEntry(node));
    setTreeError(null);
  }

  function handleTreeContextMenu(e: React.MouseEvent<HTMLDivElement>, node: TreeNode) {
    e.preventDefault();
    e.stopPropagation();
    setTreeContextMenu({
      path: node.path,
      isDirectory: node.is_directory,
      recordIndex: node.record_index,
      x: e.clientX,
      y: e.clientY,
      displayName: node.name,
      sizeBytes: node.subtree_size,
    });
  }

  function handleRequestRecycle(target: ContextMenuTarget) {
    setRecycleError(null);
    setRecycleSuccess(null);
    setRecycleConfirmTarget({
      path: target.path,
      isDirectory: target.isDirectory,
      recordIndex: target.recordIndex,
      displayName: target.displayName,
      sizeBytes: target.sizeBytes,
    });
  }

  function handleNavigateToDir(dir: DirectoryEntry) {
    setSelectedDir(dir);
    setTreeError(null);
  }

  function handleToggleExpand(node: TreeNode) {
    if (!node.is_directory) return;
    const id = node.record_index;

    if (TREE_FOCUS_DEBUG) {
      recordFocusEvent({ kind: "toggleExpand", focusedRI: focusedRecordIndex, note: `ri=${id} name=${node.name} was_expanded=${expandedIds.has(id)}` });
    }

    // Track the clicked row so keyboard navigation knows which row is "current".
    // handleSelectTreeNode handles this for label clicks; toggle clicks need it too.
    // When called from handleTreeKeyDown, focusedRecordIndex is already correct,
    // so this is a no-op (same value, React bails out of the state update).
    setFocusedRecordIndex(id);

    // Request focus recovery: after the DOM updates (rows added/removed), move focus
    // back to this row. Handles the WebView2 behaviour where removing child DOM nodes
    // causes folder-nav to lose focus (nav-focusout to=none), breaking keyboard navigation.
    pendingTreeFocusRef.current = id;

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

    const expandT0 = performance.now();
    perfLog(`tree-expand START  path=${node.path}  record_index=${id}`);
    getChildrenLimited(id, TREE_EXPAND_LIMIT)
      .then((result) => {
        perfLog(`tree-expand DONE  path=${node.path}  t=${(performance.now() - expandT0).toFixed(0)}ms  count=${result.nodes.length}  total_count=${result.total_count}`);
        setChildrenByParent((prev) => ({ ...prev, [id]: result.nodes }));
        if (result.total_count > result.nodes.length) {
          setTreeExpandedTotalCount((prev) => ({ ...prev, [id]: result.total_count }));
        }
        setExpandedIds((prev) => {
          const next = new Set(prev);
          next.add(id);
          return next;
        });
      })
      .catch((err: unknown) => {
        perfLog(`tree-expand ERROR  path=${node.path}  t=${(performance.now() - expandT0).toFixed(0)}ms`);
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

  // Sync stable refs every render so stableToggleExpand/stableSelectNode/etc.
  // always invoke the latest closure. Function declarations are hoisted so all
  // handlers are available here regardless of textual order.
  _toggleExpandFnRef.current = handleToggleExpand;
  _selectNodeFnRef.current   = handleSelectTreeNode;
  _contextMenuFnRef.current  = handleTreeContextMenu;
  _keyDownFnRef.current      = handleTreeKeyDown;

  // Keep diagnostic snapshot refs current (zero cost when TREE_FOCUS_DEBUG=false)
  if (TREE_FOCUS_DEBUG) {
    dbgFocusedRIRef.current    = focusedRecordIndex;
    dbgSelectedDirRef.current  = selectedDir
      ? { record_index: selectedDir.record_index, path: selectedDir.path }
      : null;
    dbgVisibleCountRef.current = visibleRows.length;
  }

  // ── Bookmark helpers ────────────────────────────────────────────────────

  /** Normalize a path to a bookmark match key (lowercase, no trailing \, no \\?\). */
  function bookmarkPathKey(path: string): string {
    let s = path.replace(/\//g, "\\");
    if (s.startsWith("\\\\?\\")) s = s.slice(4);
    else if (s.startsWith("\\??\\")) s = s.slice(4);
    while (s.length > 3 && s.endsWith("\\")) s = s.slice(0, -1);
    return s.toLowerCase();
  }

  function isBookmarked(path: string): boolean {
    const key = bookmarkPathKey(path);
    return bookmarks.some((b) => b.path_key === key);
  }

  function handleAddBookmark(path: string, isDirectory: boolean) {
    if (!isTauriRuntime()) return;
    const addedKey = bookmarkPathKey(path);
    invoke<Bookmark[]>("add_bookmark", { path, isDirectory })
      .then((updated) => {
        setBookmarks(updated);
        setBookmarkUndoNotice((prev) => {
          if (prev && prev.bookmark.path_key === addedKey) {
            if (bookmarkUndoTimerRef.current !== null) {
              window.clearTimeout(bookmarkUndoTimerRef.current);
              bookmarkUndoTimerRef.current = null;
            }
            return null;
          }
          return prev;
        });
      })
      .catch((err: unknown) => console.warn("[bookmarks] add failed:", err instanceof Error ? err.message : String(err)));
  }

  function clearBookmarkUndoNotice() {
    if (bookmarkUndoTimerRef.current !== null) {
      window.clearTimeout(bookmarkUndoTimerRef.current);
      bookmarkUndoTimerRef.current = null;
    }
    setBookmarkUndoNotice(null);
  }

  function showBookmarkUndoNotice(bookmark: Bookmark) {
    clearBookmarkUndoNotice();
    setBookmarkUndoNotice({ displayName: bookmark.display_name, bookmark });
    bookmarkUndoTimerRef.current = window.setTimeout(() => {
      bookmarkUndoTimerRef.current = null;
      setBookmarkUndoNotice(null);
    }, 10000);
  }

  function handleUndoBookmarkRemoval() {
    if (!bookmarkUndoNotice || !isTauriRuntime()) return;
    const { bookmark } = bookmarkUndoNotice;
    const alreadyExists = bookmarks.some(
      (b) => b.path_key === bookmark.path_key && b.volume_serial.toUpperCase() === bookmark.volume_serial.toUpperCase()
    );
    clearBookmarkUndoNotice();
    if (alreadyExists) {
      setStatusMessage("Bookmark already restored");
      setTimeout(() => setStatusMessage(null), 3000);
      return;
    }
    invoke<Bookmark[]>("restore_bookmark", { bookmark })
      .then(setBookmarks)
      .catch((err: unknown) => console.warn("[bookmarks] restore failed:", err instanceof Error ? err.message : String(err)));
  }

  function handleRemoveBookmarkById(id: string) {
    if (!isTauriRuntime()) return;
    const toRemove = bookmarks.find((b) => b.id === id);
    invoke<Bookmark[]>("remove_bookmark", { id })
      .then((updated) => {
        setBookmarks(updated);
        setBookmarkJumpStates((prev) => { const next = { ...prev }; delete next[id]; return next; });
        if (toRemove) showBookmarkUndoNotice(toRemove);
      })
      .catch((err: unknown) => console.warn("[bookmarks] remove failed:", err instanceof Error ? err.message : String(err)));
  }

  function handleRemoveBookmarkByPath(path: string) {
    const key = bookmarkPathKey(path);
    const bookmark = bookmarks.find((b) => b.path_key === key);
    if (bookmark) handleRemoveBookmarkById(bookmark.id);
  }

  function handleToggleBookmark(path: string, isDirectory: boolean) {
    if (isBookmarked(path)) {
      handleRemoveBookmarkByPath(path);
    } else {
      handleAddBookmark(path, isDirectory);
    }
  }

  // ── Review list helpers ──────────────────────────────────────────────────

  function isInReviewList(path: string): boolean {
    const key = path.toLowerCase();
    return reviewListItems.some((item) => item.path.toLowerCase() === key);
  }

  function handleToggleReviewList(
    path: string,
    isDirectory: boolean,
    sizeBytes: number,
    source: ReviewListItem['source'],
    recordIndex?: number,
  ) {
    const key = path.toLowerCase();
    setReviewListItems((prev) => {
      if (prev.some((item) => item.path.toLowerCase() === key)) {
        return prev.filter((item) => item.path.toLowerCase() !== key);
      }
      const cat = classifyCleanupSafety(path);
      return [
        ...prev,
        {
          path,
          name: getFileName(path),
          parentPath: getParentDir(path),
          isDirectory,
          sizeBytes,
          recordIndex,
          category: cat.category !== 'unknown' ? cat.labelEn : undefined,
          source,
          addedAt: Date.now(),
        },
      ];
    });
  }

  function handleRemoveFromReviewList(path: string) {
    const key = path.toLowerCase();
    setReviewListItems((prev) => prev.filter((item) => item.path.toLowerCase() !== key));
  }

  function handleClearReviewList() {
    setReviewListItems([]);
  }

  async function handleJumpToBookmark(bookmark: Bookmark) {
    if (!isTauriRuntime()) return;
    if (TREE_FOCUS_DEBUG) {
      recordFocusEvent({ kind: "bookmarkJump", focusedRI: focusedRecordIndex, note: `id=${bookmark.id} path=${bookmark.path}` });
    }

    // Cross-drive check: if bookmark is on a different volume than current scan,
    // show a clear message instead of silently failing.
    const currentSerial = data?.summary?.volume_serial?.toUpperCase();
    const bSerial = bookmark.volume_serial?.toUpperCase();
    if (currentSerial && bSerial && bSerial !== "UNKNOWN" && bSerial !== currentSerial) {
      const msg = `This bookmark is on ${bookmark.drive_letter}:. Scan ${bookmark.drive_letter}: to jump to it.`;
      setBookmarkJumpStates((prev) => ({
        ...prev,
        [bookmark.id]: { status: "other_drive", message: `Scan ${bookmark.drive_letter}: to use this bookmark` },
      }));
      setStatusMessage(msg);
      setTimeout(() => setStatusMessage(null), 4000);
      return;
    }

    setBookmarkJumpStates((prev) => ({ ...prev, [bookmark.id]: { status: "jumping" } }));

    let result: ResolvePathResult;
    try {
      result = await invoke<ResolvePathResult>("resolve_path_chain", {
        path: bookmark.path,
        volumeSerial: bookmark.volume_serial,
      });
    } catch (err: unknown) {
      setBookmarkJumpStates((prev) => ({
        ...prev,
        [bookmark.id]: { status: "unavailable", message: err instanceof Error ? err.message : String(err) },
      }));
      return;
    }

    if (result.status !== "found") {
      setBookmarkJumpStates((prev) => ({
        ...prev,
        [bookmark.id]: { status: result.status as "missing" | "unavailable", message: result.message ?? undefined },
      }));
      return;
    }

    // Drive root bookmark: no specific node to jump to
    if (result.chain.length === 0 || !result.target) {
      setBookmarkJumpStates((prev) => ({ ...prev, [bookmark.id]: { status: "found" } }));
      return;
    }

    const chain = result.chain;                // FRNs: [ancestor1, ..., target]
    const target = result.target;
    const ancestorFrns = chain.slice(0, -1);   // FRNs that need to be expanded

    // Fetch children for ancestors not yet in childrenByParent
    const newCBP: Record<number, TreeNode[]> = {};
    const newTEC: Record<number, number>     = {};
    for (const frn of ancestorFrns) {
      if (childrenByParent[frn]) continue;
      try {
        const r = await invoke<ChildrenLimitedResult>("get_children_limited", {
          parentRecordIndex: frn,
          limit: TREE_EXPAND_LIMIT,
        });
        newCBP[frn] = r.nodes;
        if (r.total_count > r.nodes.length) newTEC[frn] = r.total_count;
      } catch {
        // skip — this level won't show children
      }
    }

    // Apply state in one batch
    if (Object.keys(newCBP).length > 0) {
      setChildrenByParent((prev) => ({ ...prev, ...newCBP }));
      if (Object.keys(newTEC).length > 0) setTreeExpandedTotalCount((prev) => ({ ...prev, ...newTEC }));
    }
    setExpandedIds((prev) => {
      const next = new Set(prev);
      for (const frn of ancestorFrns) next.add(frn);
      return next;
    });

    // Focus target
    setFocusedRecordIndex(target.record_index);
    if (target.is_directory) {
      setSelectedDir(treeNodeToDirEntry(target));
      setTreeError(null);
    }

    // Request center-scroll: set FRN in ref, then bump tick to trigger TreeView effect
    jumpScrollFrnRef.current = target.record_index;
    setJumpScrollTick((n) => n + 1);

    // Check if target is visible after expansion (might be outside top-300 of parent)
    const parentFrn = chain.length >= 2 ? chain[chain.length - 2] : null;
    const parentChildren = parentFrn !== null
      ? (newCBP[parentFrn] ?? childrenByParent[parentFrn] ?? null)
      : (data?.root_children ?? null);
    const targetVisible = parentChildren
      ? parentChildren.some((n) => n.record_index === target.record_index)
      : true; // root_children check — assume visible if we can't tell

    const jumpSizeBytes = target.is_directory ? target.subtree_size : target.direct_file_size;
    if (!targetVisible) {
      setBookmarkJumpStates((prev) => ({
        ...prev,
        [bookmark.id]: { status: "outside300", message: "Parent folder expanded; target is outside the top 300 displayed entries.", sizeBytes: jumpSizeBytes },
      }));
    } else {
      setBookmarkJumpStates((prev) => ({ ...prev, [bookmark.id]: { status: "found", sizeBytes: jumpSizeBytes } }));
    }
  }

  // ── Review list jump ────────────────────────────────────────────────────

  async function handleJumpToReviewItem(item: ReviewListItem) {
    if (!isTauriRuntime() || !data) return;
    const volumeSerial = data.summary?.volume_serial ?? undefined;

    let result: ResolvePathResult;
    try {
      result = await invoke<ResolvePathResult>("resolve_path_chain", {
        path: item.path,
        volumeSerial,
      });
    } catch {
      return;
    }

    if (result.status !== "found" || !result.target) return;

    const chain = result.chain;
    const target = result.target;
    const ancestorFrns = chain.slice(0, -1);

    const newCBP: Record<number, TreeNode[]> = {};
    const newTEC: Record<number, number> = {};
    for (const frn of ancestorFrns) {
      if (childrenByParent[frn]) continue;
      try {
        const r = await invoke<ChildrenLimitedResult>("get_children_limited", {
          parentRecordIndex: frn,
          limit: TREE_EXPAND_LIMIT,
        });
        newCBP[frn] = r.nodes;
        if (r.total_count > r.nodes.length) newTEC[frn] = r.total_count;
      } catch { /* skip */ }
    }

    if (Object.keys(newCBP).length > 0) {
      setChildrenByParent((prev) => ({ ...prev, ...newCBP }));
      if (Object.keys(newTEC).length > 0) setTreeExpandedTotalCount((prev) => ({ ...prev, ...newTEC }));
    }
    setExpandedIds((prev) => {
      const next = new Set(prev);
      for (const frn of ancestorFrns) next.add(frn);
      return next;
    });

    setFocusedRecordIndex(target.record_index);
    if (target.is_directory) {
      setSelectedDir(treeNodeToDirEntry(target));
      setTreeError(null);
    }

    jumpScrollFrnRef.current = target.record_index;
    setJumpScrollTick((n) => n + 1);
  }

  // ────────────────────────────────────────────────────────────────────────

  function handleCopyTreeDebug() {
    if (!TREE_FOCUS_DEBUG) return;
    const { json } = buildTreeFocusSnapshot();
    const done = (ok: boolean) => {
      setStatusMessage(ok ? "Tree debug snapshot copied to clipboard" : "Snapshot logged to console (clipboard unavailable)");
      setTimeout(() => setStatusMessage(null), 3500);
    };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(json).then(() => done(true)).catch(() => done(false));
    } else {
      done(false);
    }
  }

  function handleRelaunchAsAdmin() {
    if (!isTauriRuntime()) return;
    // On success the Rust side calls std::process::exit(0) — the invoke promise
    // never resolves. The catch handles UAC cancellation (Rust returns an Err).
    invoke<void>("relaunch_as_admin").catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage(msg);
      setTimeout(() => setStatusMessage(null), 5000);
    });
  }

  function handleOpenExplorer(path: string) {
    setHandoffNotice(true);
    openInExplorer(path).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
      setIsScanError(false);
    });
  }

  function handleSelectFile(path: string) {
    setHandoffNotice(true);
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

  function handleShowProperties(path: string) {
    showProperties(path).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
      setIsScanError(false);
    });
  }

  function showCancelMessage(msg: string) {
    if (cancelMessageTimerRef.current !== null) {
      window.clearTimeout(cancelMessageTimerRef.current);
    }
    setCancelMessage(msg);
    cancelMessageTimerRef.current = window.setTimeout(() => {
      cancelMessageTimerRef.current = null;
      setCancelMessage(null);
    }, 5000);
  }

  function handleCancelScan() {
    if (!isLoading || scanStartMsRef.current === null) return;
    scanGenerationRef.current += 1;
    void cancelScan();
    resetProgressLatch();
    currentScanIdRef.current = null;
    scanStartMsRef.current = null;
    setIsLoading(false);
    setScanProgress(null);
    setLocalElapsedMs(0);
    if (data !== null) {
      clearUpdatedBannerTimer();
      setCacheBanner({ kind: "refresh_cancelled" });
    } else {
      clearCacheBanner();
      showCancelMessage("Scan cancelled.");
    }
  }

  function beginScanForDrive(drive: string): Promise<boolean> {
    const t0 = performance.now();
    resetProgressLatch();
    scanTimingRef.current = { start: t0, invokeStart: t0 };
    currentScanIdRef.current = null;
    scanStartMsRef.current = t0;
    setScanInvokeMs(null);
    setLocalElapsedMs(0);
    console.log(`[perf-ui] scan click  drive=${driveInput} policy=${storagePolicy}`);
    const policyNote = storagePolicy === "wof_adjusted" ? " [WOF-adjusted estimate]" : "";
    const msg = `Scanning ${drive}: — reading NTFS metadata. Top ${topN} entries.${policyNote}`;
    return runScanWithCache(drive, topN, storagePolicy, msg);
  }

  function handleScan() {
    const drive = parseDriveLetter(driveInput);
    if (!drive) {
      setError("Drive must be a single letter (A–Z).");
      setIsScanError(false);
      return;
    }
    void beginScanForDrive(drive);
  }

  function handleRefreshAfterCleanup() {
    if (isLoading) return;
    const drive = parseDriveLetter(driveInput);
    if (!drive) {
      handleScan();
      return;
    }
    const refreshWasAfterRecycle = recycleSuccess !== null || recycleRefreshPendingRef.current;
    setRecycleSuccess(null);
    void (async () => {
      let beforeFreeBytes: number | null = null;
      try {
        beforeFreeBytes = (await getDriveCapacityNow(drive)).free_bytes;
      } catch (err: unknown) {
        console.warn("[cleanup-refresh] before capacity unavailable", err);
      }

      const scanSucceeded = await beginScanForDrive(drive);
      if (!scanSucceeded || beforeFreeBytes === null) {
        recycleRefreshPendingRef.current = false;
        return;
      }

      try {
        const after = await getDriveCapacityNow(drive);
        setCleanupRefreshDelta({
          drive: `${drive}:`,
          beforeFreeBytes,
          afterFreeBytes: after.free_bytes,
          deltaBytes: after.free_bytes - beforeFreeBytes,
          recycleContext: refreshWasAfterRecycle,
        });
        recycleRefreshPendingRef.current = false;
      } catch (err: unknown) {
        recycleRefreshPendingRef.current = false;
        console.warn("[cleanup-refresh] after capacity unavailable", err);
      }
    })();
  }

  function handleAdvancedModeToggle(e: React.ChangeEvent<HTMLInputElement>) {
    if (isRecycling) return;
    if (e.target.checked) {
      setAdvancedModeWarningOpen(true);
    } else {
      setAdvancedMode(false);
      setAdvancedModeWarningOpen(false);
    }
  }

  function handleCancelAdvancedModeWarning() {
    setAdvancedModeWarningOpen(false);
  }

  function handleEnableAdvancedMode() {
    setAdvancedMode(true);
    setAdvancedModeWarningOpen(false);
  }

  function handleCancelRecycleConfirm() {
    if (isRecycling) return;
    setRecycleConfirmTarget(null);
    setRecycleError(null);
    setIsRecycling(false);
  }

  async function handleConfirmRecycle() {
    if (!recycleConfirmTarget || isRecycling) return;
    if (!advancedMode) {
      const msg = "Advanced Mode is no longer enabled.";
      setRecycleError(msg);
      setError(msg);
      setIsScanError(false);
      return;
    }

    setIsRecycling(true);
    setRecycleError(null);
    setError(null);
    setIsScanError(false);

    try {
      const result = await moveToRecycleBin(recycleConfirmTarget.path);
      if (!result.moved_to_recycle_bin) {
        throw new Error("The operation did not complete.");
      }
      setRecycleConfirmTarget(null);
      setRecycleSuccess({
        displayName: result.target.display_name || getRecycleDisplayName(recycleConfirmTarget),
        itemCount: 1,
      });
      setRecycledItems((prev) => [
        ...prev,
        {
          recordIndex: recycleConfirmTarget.recordIndex ?? null,
          path: result.target.canonical_path || recycleConfirmTarget.path,
          name: result.target.display_name || getRecycleDisplayName(recycleConfirmTarget),
          isDirectory: recycleConfirmTarget.isDirectory,
        },
      ]);
      recycleRefreshPendingRef.current = true;
      setStatusMessage(null);
    } catch (err: unknown) {
      const msg = errorMessage(err);
      setRecycleError(msg);
      setError(msg);
      setIsScanError(false);
    } finally {
      setIsRecycling(false);
    }
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

  useEffect(() => {
    setCleanupRefreshDelta(null);
    setRecycleSuccess(null);
    recycleRefreshPendingRef.current = false;
    setUnsupportedDriveCapacity(null);
    setRecycledItems([]);
  }, [driveInput]);

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
      if (cancelMessageTimerRef.current !== null) {
        window.clearTimeout(cancelMessageTimerRef.current);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Suppress WebView2 default context menu to prevent accidental page reload.
  // DirectChildrenPanel rows call stopPropagation() so their custom menu is unaffected.
  useEffect(() => {
    const handler = (e: MouseEvent) => { e.preventDefault(); };
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, []);

  // Auto-focus the tree when scan data loads so arrow keys work immediately.
  // Skip if the user is actively typing in an input or select.
  useEffect(() => {
    if (!data || !treeNavRef.current) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && (active.tagName === "INPUT" || active.tagName === "SELECT")) return;
    treeNavRef.current.focus({ preventScroll: true });
  }, [data]);

  // Load persisted bookmarks once on mount (Tauri runtime only).
  useEffect(() => {
    if (!isTauriRuntime()) return;
    invoke<Bookmark[]>("list_bookmarks")
      .then(setBookmarks)
      .catch((err: unknown) => console.warn("[bookmarks] load failed:", err instanceof Error ? err.message : String(err)));
  }, []);

  // Check administrator status once on mount — determines whether to show the warning.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    invoke<boolean>("is_running_as_admin")
      .then(setIsAdmin)
      .catch(() => setIsAdmin(null));
  }, []);

  // ── Tree focus diagnostics: window function registration ─────────────────
  // Registers window.__diskInsightDebugTreeFocus() once on mount.
  // The function reads from refs (always current values) so it never goes stale.
  useEffect(() => {
    if (!TREE_FOCUS_DEBUG) return;
    focusDbg("diagnostic mode active — call window.__diskInsightDebugTreeFocus() to snapshot, or use the 'Copy tree debug' button");
    function snapshotFn() {
      const { snap, json } = buildTreeFocusSnapshot();
      if (navigator.clipboard) {
        navigator.clipboard.writeText(json)
          .then(() => console.log("[disk-insight] snapshot copied to clipboard"))
          .catch(() => {});
      }
      return snap;
    }
    (window as unknown as Record<string, unknown>).__diskInsightDebugTreeFocus = snapshotFn;
    return () => { delete (window as unknown as Record<string, unknown>).__diskInsightDebugTreeFocus; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Tree focus diagnostics: native nav event listeners ───────────────────
  // Attaches focusin / focusout / mousedown listeners to the folder-nav element.
  // Only runs when TREE_FOCUS_DEBUG=true AND TreeView is mounted (data !== null).
  useEffect(() => {
    if (!TREE_FOCUS_DEBUG) return;
    const nav = treeNavRef.current;
    if (!nav) return;
    const onFocusIn  = (e: Event) => {
      const fe = e as FocusEvent;
      recordFocusEvent({ kind: "nav-focusin", focusedRI: dbgFocusedRIRef.current, note: `from=${(fe.relatedTarget as Element)?.tagName ?? "none"}` });
    };
    const onFocusOut = (e: Event) => {
      const fe = e as FocusEvent;
      recordFocusEvent({ kind: "nav-focusout", focusedRI: dbgFocusedRIRef.current, note: `to=${(fe.relatedTarget as Element)?.tagName ?? "none"}` });
    };
    const onMouseDown = (e: Event) => {
      const me = e as MouseEvent;
      recordFocusEvent({ kind: "nav-mousedown", targetTag: (me.target as Element)?.tagName, targetCls: (me.target as HTMLElement)?.className?.slice(0, 40), focusedRI: dbgFocusedRIRef.current });
    };
    nav.addEventListener("focusin",   onFocusIn);
    nav.addEventListener("focusout",  onFocusOut);
    nav.addEventListener("mousedown", onMouseDown);
    return () => {
      nav.removeEventListener("focusin",   onFocusIn);
      nav.removeEventListener("focusout",  onFocusOut);
      nav.removeEventListener("mousedown", onMouseDown);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!data]);

  // ── Focus recovery after expand / collapse ──────────────────────────────
  // handleToggleExpand sets pendingTreeFocusRef to the record_index of the toggled row.
  // This effect fires after expandedIds or childrenByParent change (i.e., after the DOM
  // has been committed with the new row set), then uses requestAnimationFrame to move DOM
  // focus back to the toggled row — or to folder-nav as a fallback if the row is not
  // visible. This fixes the WebView2 behaviour where removing child DOM nodes causes
  // folder-nav to lose focus (nav-focusout to=none), breaking subsequent keyboard input.
  useEffect(() => {
    const id = pendingTreeFocusRef.current;
    if (id === null) return;
    pendingTreeFocusRef.current = null;

    // Don't steal focus from inputs, selects, or context menus
    const ae = document.activeElement;
    if (ae instanceof HTMLElement) {
      if (ae.tagName === "INPUT" || ae.tagName === "SELECT") return;
      if (ae.closest(".context-menu")) return;
    }

    if (TREE_FOCUS_DEBUG) {
      recordFocusEvent({ kind: "focusRecovery-scheduled", focusedRI: id, note: `ri=${id}` });
    }

    const frameId = requestAnimationFrame(() => {
      const el = treeNavRef.current?.querySelector<HTMLElement>(`[data-record-index="${id}"]`);
      if (el) {
        el.focus({ preventScroll: true });
        if (TREE_FOCUS_DEBUG) recordFocusEvent({ kind: "focusRecovery-row", focusedRI: id, note: `ri=${id} focused` });
      } else {
        treeNavRef.current?.focus({ preventScroll: true });
        if (TREE_FOCUS_DEBUG) recordFocusEvent({ kind: "focusRecovery-nav-fallback", focusedRI: id, note: `ri=${id} not in DOM` });
      }
    });

    return () => cancelAnimationFrame(frameId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedIds, childrenByParent]);

  // Reset bookmark jump states when scan data changes (new scan = stale states).
  useEffect(() => {
    setBookmarkJumpStates({});
  }, [data]);

  useEffect(() => {
    if (treeReviewView === 'large-review') setInsightsOpen(false);
  }, [treeReviewView]);

  // Auto-resolve bookmark sizes for current-drive bookmarks after scan or bookmark list change.
  useEffect(() => {
    if (!data || !isTauriRuntime()) return;
    const serial = data.summary.volume_serial?.toUpperCase();
    if (!serial) return;
    const sameDrive = bookmarks.filter((b) => b.volume_serial?.toUpperCase() === serial);
    if (sameDrive.length === 0) return;
    const key = serial + "|" + (data.summary.total_time_ms ?? 0) + "|" + sameDrive.map((b) => b.id).sort().join(",");
    if (bookmarkAutoResolveKey.current === key) return;
    bookmarkAutoResolveKey.current = key;
    for (const bm of sameDrive) {
      invoke<ResolvePathResult>("resolve_path_chain", {
        path: bm.path,
        volumeSerial: bm.volume_serial,
      })
        .then((result) => {
          if (result.status === "found" && result.target) {
            const tgt = result.target;
            const sizeBytes = tgt.is_directory ? tgt.subtree_size : tgt.direct_file_size;
            setBookmarkJumpStates((prev) => {
              const existing = prev[bm.id];
              if (existing?.status === "jumping") return prev;
              return {
                ...prev,
                [bm.id]: {
                  status: existing?.status === "outside300" ? "outside300" : "found",
                  message: existing?.message,
                  sizeBytes,
                },
              };
            });
          } else if (result.status !== "found") {
            setBookmarkJumpStates((prev) => ({
              ...prev,
              [bm.id]: {
                status: result.status as "missing" | "unavailable",
                message: result.message ?? undefined,
              },
            }));
          }
        })
        .catch(() => {
          // silently skip — errors surfaced on explicit jump
        });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, bookmarks]);

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
  const scanDisabled = isLoading || parseDriveLetter(driveInput) === null;
  const currentFilterQ = currentFilterQuery.trim().toLowerCase();
  const filteredChildrenCount = useMemo(() => {
    if (!currentFilterQ || !selectedDirLimited) return null;
    return selectedDirLimited.nodes.filter(
      (n) => n.name.toLowerCase().includes(currentFilterQ) || n.path.toLowerCase().includes(currentFilterQ)
    ).length;
  }, [selectedDirLimited, currentFilterQ]);
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
        <div className="toolbar-group">
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
                <option value="current">Current allocation</option>
                <option value="wof_adjusted">WOF-adjusted</option>
              </select>
            </label>
            <label
              className={`advanced-mode-toggle${advancedMode ? " advanced-mode-toggle--active" : ""}`}
              title="Session-only. Unlocks Move to Recycle Bin. Resets on close."
            >
              <input
                type="checkbox"
                checked={advancedMode}
                disabled={isRecycling}
                onChange={handleAdvancedModeToggle}
              />
              <span>Advanced Mode</span>
            </label>
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
            {isLoading && scanStartMsRef.current !== null ? (
              <button className="btn" onClick={handleCancelScan}>
                Cancel scan
              </button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={handleScan}
                disabled={scanDisabled}
              >
                Scan {driveLabel}:
              </button>
            )}
          </div>
          {storagePolicy === "wof_adjusted" && (
            <div
              className="policy-warning"
              title="Experimental WOF-aware estimate. It may be closer to WizTree &quot;Allocated&quot; for WOF-compressed files."
            >
              Experimental WOF estimate; hard links / WinSxS not fully corrected.
            </div>
          )}
        </div>
      </header>

      {isAdmin === false && !adminWarningDismissed && (
        <div className="admin-warning-banner" role="alert">
          <span className="admin-warning-icon" aria-hidden="true">⚠</span>
          <span className="admin-warning-text">
            Running without administrator privileges. Some NTFS scan operations may be limited.
          </span>
          <button className="btn btn-sm" onClick={handleRelaunchAsAdmin}>
            Relaunch as administrator
          </button>
          <button
            className="admin-warning-dismiss"
            onClick={() => setAdminWarningDismissed(true)}
            title="Dismiss"
            aria-label="Dismiss administrator warning"
          >
            ×
          </button>
        </div>
      )}

      {advancedMode && (
        <div className="advanced-mode-banner" role="status">
          Advanced Mode enabled — session only
        </div>
      )}

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
          {isScanError && data && (
            <div className="error-note">
              Showing previous result for {data.summary.drive}.
            </div>
          )}
          {isScanError && isTauriRuntime() && isAdminRequiredError(error) && (
            <div className="error-hint">
              Please run disk-insight as administrator (required for MFT access).
            </div>
          )}
          {isScanError && !isTauriRuntime() && (
            <div className="error-hint">
              Run `npm run tauri dev` or use the built app.
            </div>
          )}
        </div>
      )}

      {unsupportedDriveCapacity && (
        <UnsupportedDriveCapacityCard
          drive={unsupportedDriveCapacity.drive}
          capacity={unsupportedDriveCapacity.capacity}
          note={unsupportedDriveCapacity.note}
        />
      )}

      {statusMessage && (
        <div className="status-message status-message--success">{statusMessage}</div>
      )}

      {bookmarkUndoNotice && (
        <div className="bookmark-undo-notice" role="status">
          <div className="bookmark-undo-notice__body">
            <span className="bookmark-undo-notice__text">
              Bookmark removed: <strong>{bookmarkUndoNotice.displayName}</strong>
            </span>
            <span className="bookmark-undo-notice__hint">
              Only the latest removal can be undone. Closing this notice clears it.
            </span>
          </div>
          <div className="bookmark-undo-notice__actions">
            <button className="btn btn-sm btn--undo" onClick={handleUndoBookmarkRemoval}>
              Undo
            </button>
            <button className="btn btn-sm" onClick={clearBookmarkUndoNotice} aria-label="Dismiss">
              ×
            </button>
          </div>
        </div>
      )}

      {handoffNotice && !recycleSuccess && (
        <div className="status-message status-message--info handoff-notice" role="status">
          <span>External tool opened. Refresh scan after making changes.</span>
          <div className="handoff-notice-actions">
            <button
              className="btn btn-primary btn-sm"
              onClick={handleScan}
              disabled={scanDisabled}
            >
              Refresh scan
            </button>
            <button
              className="btn btn-sm"
              onClick={() => setHandoffNotice(false)}
              disabled={isLoading}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {recycleSuccess && (
        <div className="status-message status-message--success recycle-success-message" role="status">
          <strong>
            {recycleSuccess.itemCount > 1
              ? `Moved ${recycleSuccess.itemCount} items to Recycle Bin`
              : `Moved to Recycle Bin: ${recycleSuccess.displayName}`}
          </strong>
          <div>Items in the Recycle Bin still occupy disk space until the bin is emptied.</div>
          <div>Moved items are marked in visible lists until you refresh.</div>
          <div>Use Refresh after cleanup when you are ready to update disk-insight.</div>
          <div className="recycle-success-actions">
            <button
              className="btn btn-primary btn-sm"
              onClick={handleRefreshAfterCleanup}
              disabled={scanDisabled}
            >
              Refresh after cleanup
            </button>
            <button
              className="btn btn-sm"
              onClick={() => setRecycleSuccess(null)}
              disabled={isLoading}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {cancelMessage && (
        <div className="status-message status-message--info">{cancelMessage}</div>
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
          <CompactSummary summary={data.summary} capacity={data.capacity} />
          <div className="content-pane">
            <TreeView
              rootCount={data.root_children?.length ?? 0}
              visibleRows={filteredVisibleRows}
              totalRowsCount={visibleRows.length}
              totalSize={data.summary.total_final_allocated}
              expandedIds={expandedIds}
              loadingIds={loadingIds}
              selectedRecordIndex={selectedDir?.record_index}
              focusedRecordIndex={focusedRecordIndex}
              treeError={treeError}
              sourceKind={sourceKind}
              recycledItems={recycledItems}
              reviewView={treeReviewView}
              onChangeReviewView={setTreeReviewView}
              largeReviewCandidates={largeReviewCandidates}
              isReviewBookmarked={isBookmarked}
              onToggleReviewBookmark={handleToggleBookmark}
              isInReviewList={isInReviewList}
              onToggleReviewList={(path, isDir, sizeBytes, recordIndex) => handleToggleReviewList(path, isDir, sizeBytes, 'large-review', recordIndex)}
              onToggleExpand={stableToggleExpand}
              onSelect={stableSelectNode}
              onContextMenu={stableContextMenu}
              onKeyDown={stableKeyDown}
              onNavMouseMove={stableNavMouseMove}
              navRef={treeNavRef}
              jumpScrollRef={jumpScrollFrnRef}
              jumpScrollTick={jumpScrollTick}
            />
            {treeContextMenu && (
              <SafeContextMenu
                target={treeContextMenu}
                onClose={() => setTreeContextMenu(null)}
                onOpenExplorer={handleOpenExplorer}
                onSelectFile={handleSelectFile}
                onShowProperties={handleShowProperties}
                advancedMode={advancedMode}
                onRequestRecycle={handleRequestRecycle}
                isAlreadyRecycled={isItemRecycled(treeContextMenu.recordIndex, treeContextMenu.path, recycledItems)}
                onCopyError={handleCopyError}
                onExternalHandoff={() => setHandoffNotice(true)}
                isBookmarked={isBookmarked(treeContextMenu.path)}
                onToggleBookmark={() => handleToggleBookmark(treeContextMenu.path, treeContextMenu.isDirectory)}
                isInReviewList={isInReviewList(treeContextMenu.path)}
                onToggleReviewList={() => handleToggleReviewList(
                  treeContextMenu.path,
                  treeContextMenu.isDirectory,
                  treeContextMenu.sizeBytes ?? 0,
                  treeReviewView === 'reviewable' ? 'reviewable' : treeReviewView === 'caution' ? 'caution' : 'tree',
                  treeContextMenu.recordIndex,
                )}
              />
            )}
            <div className="content-right">
              {selectedDir && (
                <SelectedFolderCard
                  dir={selectedDir}
                  reclaimable={reclaimable}
                  reclaimableLoading={reclaimableLoading}
                  reclaimableError={reclaimableError}
                  sourceKind={sourceKind}
                  cleanupRefreshDelta={cleanupRefreshDelta}
                  isBookmarked={isBookmarked(selectedDir.path)}
                  onToggleBookmark={() => handleToggleBookmark(selectedDir.path, true)}
                />
              )}
              {/* v0.5.9-A/C: Filter input hidden. State (currentFilterQuery) preserved. */}
              {/* v0.5.9-A/C: DirectChildrenPanel not in default display. State preserved. */}
              {bookmarks.length > 0 && (
                <BookmarksBar
                  bookmarks={bookmarks}
                  jumpStates={bookmarkJumpStates}
                  onJump={handleJumpToBookmark}
                  onRemove={handleRemoveBookmarkById}
                  currentVolumeSerial={data?.summary?.volume_serial ?? null}
                  totalSize={data?.summary?.total_final_allocated ?? 0}
                  onOpenExplorer={handleOpenExplorer}
                  onSelectFile={handleSelectFile}
                  onCopyError={handleCopyError}
                  isInReviewList={isInReviewList}
                  onToggleReviewList={handleToggleReviewList}
                />
              )}
              <ReviewListPanel
                items={reviewListItems}
                onRemove={handleRemoveFromReviewList}
                onClear={handleClearReviewList}
                onJump={handleJumpToReviewItem}
                onOpenExplorer={handleOpenExplorer}
                onSelectFile={handleSelectFile}
                onCopyError={handleCopyError}
                isBookmarked={isBookmarked}
                onToggleBookmark={handleToggleBookmark}
              />
              {selectedDir && (
                <button
                  className={`insights-open-btn${insightsOpen ? " insights-open-btn--open" : ""}`}
                  onClick={() => setInsightsOpen((v) => !v)}
                >
                  Insights for this folder
                </button>
              )}
            </div>
          </div>
          {selectedDir && insightsOpen && (
            <div className="insights-lower-panel">
              <div className="insights-lower-header">
                <span className="insights-lower-title" title={selectedDir.path}>
                  Insights: {selectedDir.path}
                </span>
                <button className="btn btn-sm" onClick={() => setInsightsOpen(false)}>
                  Close
                </button>
              </div>
              <div className="insights-lower-content">
                <div className="true-largest-section">
                  <div className="true-largest-header">
                    {isDriveRoot(selectedDir.path)
                      ? <>Largest items on <span className="heading-path">{selectedDir.path}</span></>
                      : <>Largest items in <span className="heading-path">{selectedDir.path}</span></>}
                    {selectedLargestItems?.elapsed_ms !== undefined && !largestItemsLoading && (
                      <span className="true-largest-timing">Computed in {selectedLargestItems.elapsed_ms.toFixed(0)} ms</span>
                    )}
                  </div>
                  {sourceKind !== "live" ? (
                    <div className="true-largest-note">Largest items require a live scan.</div>
                  ) : largestItemsLoading ? (
                    <div className="true-largest-loading">Loading largest items…</div>
                  ) : largestItemsError ? (
                    <div className="true-largest-error">{largestItemsError}</div>
                  ) : selectedLargestItems ? (
                    <>
                      <DirectoriesTable
                        rows={selectedLargestItems.folders.map(treeNodeToDirEntry)}
                        title="Largest folders in this folder"
                        totalSize={data.summary.total_final_allocated}
                        basePath={selectedDir.path}
                        advancedMode={advancedMode}
                        onOpenExplorer={handleOpenExplorer}
                        onShowProperties={handleShowProperties}
                        onRequestRecycle={handleRequestRecycle}
                        recycledItems={recycledItems}
                        onCopyError={handleCopyError}
                        onExternalHandoff={() => setHandoffNotice(true)}
                        isBookmarked={isBookmarked}
                        onToggleBookmark={handleToggleBookmark}
                      />
                      <FilesTable
                        rows={selectedLargestItems.files.map(treeNodeToFileEntry)}
                        title="Largest files in this folder"
                        totalSize={data.summary.total_final_allocated}
                        basePath={selectedDir.path}
                        advancedMode={advancedMode}
                        onOpenLocation={handleOpenExplorer}
                        onSelectFile={handleSelectFile}
                        onShowProperties={handleShowProperties}
                        onRequestRecycle={handleRequestRecycle}
                        recycledItems={recycledItems}
                        onCopyError={handleCopyError}
                        onExternalHandoff={() => setHandoffNotice(true)}
                        isBookmarked={isBookmarked}
                        onToggleBookmark={handleToggleBookmark}
                      />
                    </>
                  ) : null}
                </div>
                <SubtreeSearchPanel
                  selectedDir={selectedDir}
                  sourceKind={sourceKind}
                  totalSize={data.summary.total_final_allocated}
                  onOpenExplorer={handleOpenExplorer}
                  onSelectFile={handleSelectFile}
                  onShowProperties={handleShowProperties}
                  advancedMode={advancedMode}
                  onRequestRecycle={handleRequestRecycle}
                  recycledItems={recycledItems}
                  onCopyError={handleCopyError}
                  onExternalHandoff={() => setHandoffNotice(true)}
                  isBookmarked={isBookmarked}
                  onToggleBookmark={handleToggleBookmark}
                />
                <details className="largest-items-section">
                  <summary className="largest-items-summary">
                    <span className="largest-items-summary-label">
                      {!isDriveRoot(selectedDir.path)
                        ? <>Top scan results under <span className="heading-path">{selectedDir.path}</span></>
                        : "Top scan results"}
                    </span>
                    <span className="largest-items-note">
                      Filtered from the global Top N scan results.
                    </span>
                  </summary>
                  <DirectoriesTable
                    rows={filteredTopDirs}
                    totalSize={data.summary.total_final_allocated}
                    basePath={selectedDir?.path}
                    advancedMode={advancedMode}
                    onOpenExplorer={handleOpenExplorer}
                    onShowProperties={handleShowProperties}
                    onRequestRecycle={handleRequestRecycle}
                    recycledItems={recycledItems}
                    onCopyError={handleCopyError}
                    title="Top folders from scan results"
                    onExternalHandoff={() => setHandoffNotice(true)}
                    isBookmarked={isBookmarked}
                    onToggleBookmark={handleToggleBookmark}
                  />
                  <FilesTable
                    rows={filteredTopFiles}
                    totalSize={data.summary.total_final_allocated}
                    basePath={selectedDir?.path}
                    advancedMode={advancedMode}
                    title="Top files from scan results"
                    onOpenLocation={handleOpenExplorer}
                    onSelectFile={handleSelectFile}
                    onShowProperties={handleShowProperties}
                    onRequestRecycle={handleRequestRecycle}
                    recycledItems={recycledItems}
                    onCopyError={handleCopyError}
                    onExternalHandoff={() => setHandoffNotice(true)}
                    isBookmarked={isBookmarked}
                    onToggleBookmark={handleToggleBookmark}
                  />
                </details>
              </div>
            </div>
          )}
          {sourceKind === "live" && (
            <PerfBreakdown summary={data.summary} invokeMs={scanInvokeMs} />
          )}
        </>
      )}
      {advancedModeWarningOpen && (
        <AdvancedModeWarningModal
          onCancel={handleCancelAdvancedModeWarning}
          onEnable={handleEnableAdvancedMode}
        />
      )}
      {recycleConfirmTarget && (
        <RecycleConfirmModal
          target={recycleConfirmTarget}
          isRecycling={isRecycling}
          error={recycleError}
          onCancel={handleCancelRecycleConfirm}
          onConfirm={handleConfirmRecycle}
        />
      )}
      {TREE_FOCUS_DEBUG && (
        <button
          className="tree-debug-fab"
          onClick={handleCopyTreeDebug}
          title="Copy tree focus debug snapshot to clipboard (TREE_FOCUS_DEBUG=true)"
        >
          Copy tree debug
        </button>
      )}
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
