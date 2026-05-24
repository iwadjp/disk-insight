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

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return unitIndex === 0 ? `${value} ${units[unitIndex]}` : `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function SummaryCard({ summary }: { summary: Summary }) {
  const items = [
    ["Drive", summary.drive],
    ["Allocated", formatBytes(summary.total_final_allocated)],
    ["Files", formatNumber(summary.files)],
    ["Directories", formatNumber(summary.directories)],
    ["Total time", `${formatNumber(summary.total_time_ms)} ms`]
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;

    invoke<DiskInsightOutput>("load_sample_json")
      .then((json) => {
        if (!ignore) {
          setData(json);
        }
      })
      .catch((err: unknown) => {
        if (!ignore) {
          setError(`Failed to load sample data: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

    return () => {
      ignore = true;
    };
  }, []);

  return (
    <main className="app">
      <header className="app-header">
        <div>
          <h1>disk-insight</h1>
          <p>Sample JSON viewer</p>
        </div>
        <span className="source">Tauri command: load_sample_json</span>
      </header>

      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="loading">Loading sample JSON...</div>}

      {data && (
        <>
          <SummaryCard summary={data.summary} />
          <DirectoriesTable rows={data.top_directories} />
          <FilesTable rows={data.top_files} />
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
