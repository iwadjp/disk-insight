import React, { useEffect, useState } from "react";
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

type ChildrenPreview = {
  parentIndex: number;
  parentPath: string;
  items: TreeNode[];
};

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

function FolderNav({
  dirs,
  selectedDir,
  onSelect,
  rootChildrenCount,
}: {
  dirs: DirectoryEntry[];
  selectedDir: DirectoryEntry | undefined;
  onSelect: (dir: DirectoryEntry) => void;
  rootChildrenCount: number;
}) {
  return (
    <aside className="folder-nav">
      <div className="folder-nav-header">Folders</div>
      <div className="folder-nav-list">
        {dirs.map((dir) => (
          <button
            key={dir.record_index}
            className={`folder-row${
              selectedDir?.record_index === dir.record_index ? " folder-row--active" : ""
            }`}
            onClick={() => onSelect(dir)}
          >
            <span className="folder-row-path">{dir.path}</span>
            <span className="folder-row-size">{formatBytes(dir.subtree_size)}</span>
          </button>
        ))}
      </div>
      <div className="folder-nav-footer">Root children: {rootChildrenCount}</div>
    </aside>
  );
}

function SelectedFolderCard({
  dir,
  onOpenExplorer,
  onCopyError,
  onLoadChildren,
  childrenPreview,
  childrenError,
}: {
  dir: DirectoryEntry;
  onOpenExplorer: (path: string) => void;
  onCopyError: (msg: string) => void;
  onLoadChildren: () => void;
  childrenPreview: ChildrenPreview | null;
  childrenError: string | null;
}) {
  const matchesSelection =
    childrenPreview !== null && childrenPreview.parentIndex === dir.record_index;
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
          <button className="btn" onClick={onLoadChildren}>
            Load children
          </button>
        </div>
      </div>
      <div className="selected-folder-stats">
        <span>Subtree: <strong>{formatBytes(dir.subtree_size)}</strong></span>
        <span>Direct files: <strong>{formatBytes(dir.direct_file_size)}</strong></span>
        <span>Children: <strong>{formatNumber(dir.child_count)}</strong></span>
      </div>
      <div className="selected-folder-note">Filtered within current top results</div>
      {childrenError && (
        <div className="children-preview children-preview--error">{childrenError}</div>
      )}
      {matchesSelection && (
        <div className="children-preview">
          <div className="children-preview-header">
            Children loaded: {formatNumber(childrenPreview!.items.length)}
          </div>
          {childrenPreview!.items.length === 0 ? (
            <div className="children-preview-empty">No children returned for this folder.</div>
          ) : (
            <>
              {childrenPreview!.items.slice(0, 5).map((c) => (
                <div key={c.record_index} className="children-preview-item">
                  <span
                    className={
                      c.is_directory
                        ? "children-preview-kind children-preview-kind--dir"
                        : "children-preview-kind children-preview-kind--file"
                    }
                  >
                    {c.is_directory ? "DIR" : "FILE"}
                  </span>
                  <span className="children-preview-path">{c.path}</span>
                  <span className="children-preview-size">{formatBytes(c.subtree_size)}</span>
                </div>
              ))}
              {childrenPreview!.items.length > 5 && (
                <div className="children-preview-more">
                  + {formatNumber(childrenPreview!.items.length - 5)} more
                </div>
              )}
            </>
          )}
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
  const [childrenPreview, setChildrenPreview] = useState<ChildrenPreview | null>(null);
  const [childrenError, setChildrenError] = useState<string | null>(null);

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
    setChildrenPreview(null);
    setChildrenError(null);
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

  function handleSelectDir(dir: DirectoryEntry) {
    setSelectedDir(dir);
    setChildrenPreview(null);
    setChildrenError(null);
  }

  function handleLoadChildren() {
    if (!selectedDir) return;
    setChildrenError(null);
    if (sourceKind !== "live") {
      setChildrenPreview(null);
      setChildrenError("Children API is available after a live scan in the Tauri app.");
      return;
    }
    const targetIndex = selectedDir.record_index;
    const targetPath  = selectedDir.path;
    getChildren(targetIndex)
      .then((items) => {
        setChildrenPreview({ parentIndex: targetIndex, parentPath: targetPath, items });
      })
      .catch((err: unknown) => {
        setChildrenPreview(null);
        setChildrenError(err instanceof Error ? err.message : String(err));
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
            <FolderNav
              dirs={data.top_directories}
              selectedDir={selectedDir}
              onSelect={handleSelectDir}
              rootChildrenCount={data.root_children?.length ?? 0}
            />
            <div className="content-right">
              {selectedDir && (
                <SelectedFolderCard
                  dir={selectedDir}
                  onOpenExplorer={handleOpenExplorer}
                  onCopyError={handleCopyError}
                  onLoadChildren={handleLoadChildren}
                  childrenPreview={childrenPreview}
                  childrenError={childrenError}
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
