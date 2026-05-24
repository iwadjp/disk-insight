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

type DiskInsightOutput = {
  summary: Summary;
  top_directories: DirectoryEntry[];
  top_files: FileEntry[];
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
}: {
  dirs: DirectoryEntry[];
  selectedDir: DirectoryEntry | undefined;
  onSelect: (dir: DirectoryEntry) => void;
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
    </aside>
  );
}

function SelectedFolderCard({ dir }: { dir: DirectoryEntry }) {
  return (
    <div className="selected-folder-card">
      <div className="selected-folder-label">Selected folder</div>
      <div className="selected-folder-path">{dir.path}</div>
      <div className="selected-folder-stats">
        <span>Subtree: <strong>{formatBytes(dir.subtree_size)}</strong></span>
        <span>Direct files: <strong>{formatBytes(dir.direct_file_size)}</strong></span>
        <span>Children: <strong>{formatNumber(dir.child_count)}</strong></span>
      </div>
    </div>
  );
}

function DirectoriesTable({ rows }: { rows: DirectoryEntry[] }) {
  return (
    <section className="table-section">
      <div className="section-header">
        <h2>Top directories</h2>
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

function FilesTable({ rows }: { rows: FileEntry[] }) {
  return (
    <section className="table-section">
      <div className="section-header">
        <h2>Top files</h2>
        <span>{rows.length} rows</span>
      </div>
      <div className="table-wrap">
        <table className="files-table">
          <thead>
            <tr>
              <th>Path</th>
              <th className="numeric">Allocated size</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.record_index}>
                <td className="path">{row.path}</td>
                <td className="numeric">{formatBytes(row.final_allocated_size)}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
              onSelect={setSelectedDir}
            />
            <div className="content-right">
              {selectedDir && <SelectedFolderCard dir={selectedDir} />}
              <DirectoriesTable rows={data.top_directories} />
              <FilesTable rows={data.top_files} />
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
