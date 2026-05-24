import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
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
  read_time_ms: number;
  parse_time_ms: number;
  tree_build_time_ms: number;
  aggregation_time_ms: number;
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

type DiskInsightOutput = {
  summary: Summary;
  top_directories: DirectoryEntry[];
  top_files: FileEntry[];
  root_children?: TreeNode[];
};

type TauriWindow = Window & {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
};

type SourceKind = "sample" | "live";

const TOP_OPTIONS = [10, 30, 50, 100, 200, 500];
const LARGE_FOLDER_THRESHOLD = 200;
const LARGE_TREE_THRESHOLD = 1000;

function parseDriveLetter(input: string): string | null {
  const s = input.trim().replace(/:$/, "");
  if (s.length === 1 && /^[A-Za-z]$/.test(s)) return s.toUpperCase();
  return null;
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

async function scanDrive(drive: string, top: number): Promise<DiskInsightOutput> {
  if (!isTauriRuntime()) {
    throw new Error("Real scan is available only in the Tauri desktop app.");
  }
  return invoke<DiskInsightOutput>("scan_drive", { drive, top });
}

async function openInExplorer(path: string): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("Explorer open is available only in the Tauri desktop app.");
  }
  return invoke<void>("open_in_explorer", { path });
}

async function getChildren(parentRecordIndex: number): Promise<TreeNode[]> {
  if (!isTauriRuntime()) {
    throw new Error("Children API is available only in the Tauri desktop app.");
  }
  return invoke<TreeNode[]>("get_children", { parentRecordIndex });
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
    sourceKind === "live" ? `Live scan: ${data.summary.drive}` : "Sample data";

  const updatedLabel = `Last updated: ${formatDateTime(lastUpdated)}`;

  const durationLabel =
    sourceKind === "live"
      ? `Scan completed in ${formatNumber(data.summary.total_time_ms)} ms`
      : null;

  return (
    <div className="status-bar">
      <span className={`source-badge source-badge--${sourceKind}`}>{sourceLabel}</span>
      {sourceKind === "live" && scanTopN !== null && (
        <span className="status-meta">Top {scanTopN}</span>
      )}
      <span className="status-meta">{updatedLabel}</span>
      {durationLabel && <span className="status-meta">{durationLabel}</span>}
      {isLoading && <span className="status-meta status-updating">(updating…)</span>}
    </div>
  );
}

function SummaryCard({ summary }: { summary: Summary }) {
  const items = [
    ["Drive", summary.drive],
    ["Allocated", formatBytes(summary.total_final_allocated)],
    ["Files", formatNumber(summary.files)],
    ["Directories", formatNumber(summary.directories)],
    ["Total time", `${formatNumber(summary.total_time_ms)} ms`],
  ];
  return (
    <section className="summary" aria-label="Scan summary">
      {items.map(([label, value]) => (
        <div className="metric" key={label}>
          <span className="metric-label">{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </section>
  );
}

type TreeRowProps = {
  node: TreeNode;
  depth: number;
  expandedIds: Set<number>;
  loadingIds: Set<number>;
  selectedRecordIndex: number | undefined;
  onToggleExpand: (node: TreeNode) => void;
  onSelect: (node: TreeNode) => void;
};

function TreeNodeRow({
  node,
  depth,
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

  const rowClass =
    "tree-row"
    + (isSelected ? " tree-row--active" : "")
    + (isDir ? "" : " tree-row--file");

  return (
    <div className={rowClass} style={{ paddingLeft: indent }}>
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
  expandedIds,
  loadingIds,
  selectedRecordIndex,
  treeError,
  onToggleExpand,
  onSelect,
}: {
  rootCount: number;
  visibleRows: VisibleTreeRow[];
  expandedIds: Set<number>;
  loadingIds: Set<number>;
  selectedRecordIndex: number | undefined;
  treeError: string | null;
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
        <div className="folder-nav-footer folder-nav-footer--error">{treeError}</div>
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
  onOpenExplorer,
  onCopyError,
}: {
  dir: DirectoryEntry;
  onOpenExplorer: (path: string) => void;
  onCopyError: (msg: string) => void;
}) {
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
        <span>Subtree: <strong>{formatBytes(dir.subtree_size)}</strong></span>
        <span>Direct files: <strong>{formatBytes(dir.direct_file_size)}</strong></span>
        <span>Children: <strong>{formatNumber(dir.child_count)}</strong></span>
      </div>
      <div className="selected-folder-note">Filtered within current top results</div>
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
              <th className="numeric">Subtree size</th>
              <th className="numeric">Direct file size</th>
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
  onCopyError,
}: {
  rows: FileEntry[];
  title: React.ReactNode;
  onOpenLocation: (path: string) => void;
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
                <th className="numeric">Allocated size</th>
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

function App() {
  const [data, setData] = useState<DiskInsightOutput | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingMsg, setLoadingMsg] = useState("Loading sample data...");
  const [error, setError] = useState<string | null>(null);
  const [isScanError, setIsScanError] = useState(false);
  const [sourceKind, setSourceKind] = useState<SourceKind | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [driveInput, setDriveInput] = useState("C");
  const [topN, setTopN] = useState(100);
  const [scanTopN, setScanTopN] = useState<number | null>(null);
  const [selectedDir, setSelectedDir] = useState<DirectoryEntry | undefined>(undefined);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [loadingIds, setLoadingIds] = useState<Set<number>>(new Set());
  const [childrenByParent, setChildrenByParent] = useState<Record<number, TreeNode[]>>({});
  const [childrenErrors, setChildrenErrors] = useState<Record<number, string>>({});
  const [treeError, setTreeError] = useState<string | null>(null);

  const visibleRows = useMemo(
    () => buildVisibleRows(data?.root_children ?? [], expandedIds, childrenByParent, childrenErrors),
    [data?.root_children, expandedIds, childrenByParent, childrenErrors],
  );

  function runLoad(
    loader: () => Promise<DiskInsightOutput>,
    msg: string,
    isScan: boolean,
    kind: SourceKind,
    usedTopN?: number,
  ) {
    setIsLoading(true);
    setLoadingMsg(msg);
    setError(null);
    setIsScanError(false);
    setExpandedIds(new Set());
    setLoadingIds(new Set());
    setChildrenByParent({});
    setChildrenErrors({});
    setTreeError(null);
    loader()
      .then((json) => {
        setData(json);
        setSourceKind(kind);
        setLastUpdated(new Date());
        if (usedTopN !== undefined) setScanTopN(usedTopN);
        setSelectedDir(json.top_directories[0]);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setIsScanError(isScan);
        setIsLoading(false);
      });
  }

  function handleSelectTreeNode(node: TreeNode) {
    if (!node.is_directory) return;
    setSelectedDir(treeNodeToDirEntry(node));
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
      setTreeError("Live scan required to load children. Run a scan in the Tauri app.");
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

  function handleCopyError(msg: string) {
    setError(msg);
    setIsScanError(false);
  }

  function handleScan() {
    const drive = parseDriveLetter(driveInput);
    if (!drive) {
      setError("Drive must be a single letter (A–Z).");
      setIsScanError(false);
      return;
    }
    const msg = `Scanning ${drive}: — reading NTFS metadata. Top ${topN} entries.`;
    runLoad(() => scanDrive(drive, topN), msg, true, "live", topN);
  }

  useEffect(() => {
    runLoad(loadSampleData, "Loading sample data...", false, "sample");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const driveLabel = parseDriveLetter(driveInput) ?? driveInput.slice(0, 1).toUpperCase();

  return (
    <main className="app">
      <header className="app-header">
        <h1>disk-insight</h1>
        <div className="toolbar">
          <label className="toolbar-label">
            Drive
            <input
              className="drive-input"
              value={driveInput}
              onChange={(e) => setDriveInput(e.target.value)}
              disabled={isLoading}
              maxLength={2}
            />
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
          <div className="toolbar-separator" />
          <button
            className="btn"
            onClick={() =>
              runLoad(loadSampleData, "Loading sample data...", false, "sample")
            }
            disabled={isLoading}
          >
            Load sample
          </button>
          <button
            className="btn btn-primary"
            onClick={handleScan}
            disabled={isLoading}
          >
            Scan {driveLabel}:
          </button>
        </div>
      </header>

      {/* Scanning banner: shown on top of existing data while a new scan is running */}
      {isLoading && data !== null && (
        <div className="scanning-banner">
          <span className="scanning-spinner" aria-hidden="true" />
          <span>{loadingMsg}</span>
        </div>
      )}

      {/* Full-page placeholder only when there is no data yet */}
      {isLoading && data === null && (
        <div className="loading">{loadingMsg}</div>
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
          <div className="content-pane">
            <TreeView
              rootCount={data.root_children?.length ?? 0}
              visibleRows={visibleRows}
              expandedIds={expandedIds}
              loadingIds={loadingIds}
              selectedRecordIndex={selectedDir?.record_index}
              treeError={treeError}
              onToggleExpand={handleToggleExpand}
              onSelect={handleSelectTreeNode}
            />
            <div className="content-right">
              {selectedDir && (
                <SelectedFolderCard
                  dir={selectedDir}
                  onOpenExplorer={handleOpenExplorer}
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
                    ? <>Top directories under <span className="heading-path">{selectedDir.path}</span></>
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
                    ? <>Top files under <span className="heading-path">{selectedDir.path}</span></>
                    : "Top files"
                }
                onOpenLocation={handleOpenExplorer}
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
