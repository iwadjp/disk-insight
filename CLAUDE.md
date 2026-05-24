# disk-insight/CLAUDE.md

## プロジェクト概要

Windows NTFS の MFT を高速に読み、容量分布を可視化する WizTree 風ディスク分析ツール。

- WizTree 完全互換は目標にしない
- 削除判断に使えるファイル単位・フォルダ単位のサイズ表示を優先する

## 配置

- `CLAUDE/maybe_public/disk-insight/`

## 技術スタック

| 用途 | 技術 |
|------|------|
| 言語 | Rust（MSVC toolchain） |
| Win32 API | windows-rs 0.61 |
| UI フレームワーク | Tauri v2 + React + Vite（進行中） |
| シリアライゼーション | serde / serde_json |
| 並列パース | rayon |

## 現在の状態

- **作業ブランチ**: `next-phase`
- **タグ済み**: `v0.1.0-minimal`（削除なし最小実用品、2026-05-24）
- **現在の短期ゴール**: Explorer風TreeView実用品（next-phase milestone）

詳細は `docs/ui-plan.md` の "next-phase milestone" セクションを参照。

## 現在の到達点

### 完了済み（主要フェーズ）

| フェーズ | 内容 |
|----------|------|
| B-4 | final allocated size policy（extension record 対応） |
| B-5 | parent_frn ツリー集計・サイズ後退伝播 |
| C-1〜C-5 | CLI `--json` / `--drive` / `--top` / JSON schema / API 整理 |
| D-1〜D-13 | Tauri UI scaffold → Scan → TreeView前の全 UI → minimal usable **PASS** |
| E-1a | root_children を JSON 出力に追加 |
| E-1b | `get_children` Tauri command（lazy children cache） |
| E-2 | Explorer 風 TreeView（lazy expansion）+ 選択動作確認 |
| E-3 | TreeView performance plan ドキュメント |
| E-4 | `visibleRows` flat list 導入（非再帰 render） |
| E-5 | TreeView safety guards（duplicate guard・per-node error・large folder warning） |
| F-1 | top files に Select file（`explorer /select,file`）+ 成功メッセージ |
| G-1 | Drive 自動検出（`GetLogicalDrives` / `GetDriveTypeW`）、Drive selector 化 |

## 主要 API

### Rust core（disk_insight クレート）

```rust
// src/mft_probe.rs
pub fn build_mft_tree_output(drive: char, top_n: usize) -> Result<JsonTreeOutput>
pub fn print_probe7_human(drive: char, top_n: usize) -> Result<()>
pub fn print_probe7_json_top(drive: char, top_n: usize) -> Result<()>
```

### Tauri commands（src-tauri/src/main.rs）

| コマンド | 説明 |
|----------|------|
| `load_sample_json` | 埋め込みサンプル JSON を返す |
| `scan_drive(drive, top)` | 実 MFT スキャンを実行し JsonTreeOutput を返す |
| `get_children(parent_record_index)` | 指定ディレクトリの直下エントリを返す（lazy TreeView 用） |
| `open_in_explorer(path)` | 指定フォルダを Explorer で開く |
| `select_in_explorer(path)` | 指定ファイルを Explorer で選択表示する |
| `list_drives()` | 論理ドライブ一覧を返す（DriveInfo: letter/root/display/drive_type） |

## CLI 使用例

```powershell
disk-insight.exe
disk-insight.exe --json
disk-insight.exe --json --top 100
disk-insight.exe --drive C --top 50
disk-insight.exe --help
```

## 管理者権限について

- MFT アクセスには管理者権限が必要
- VSCode / Claude Code を管理者権限で起動することがある
- 管理者権限で作業中は **disk-insight プロジェクト外のファイル変更・削除は禁止**
- OS 設定変更・システムファイル削除は禁止
- unsafe ブロックは最小限に留め、理由をコメントで明記する

## 進捗管理ルール

- **disk-insight 直下に PROGRESS.md を作成しない**
- 進捗記録は必ず `D:\iwa\AI\Claude\private_notes\PROGRESS.md` に追記する
- 作業区切りごとに PROGRESS.md を更新してコミットする

## 短期ゴール: Explorer風TreeView実用品

現在の目標は **next-phase milestone** の達成。

- Explorer 風 TreeView で任意フォルダまで展開できる（達成済み）
- top files の Select file で Explorer 選択表示できる（達成済み）
- Drive selector で論理ドライブを自動検出できる（達成済み）
- **削除機能は引き続き入れない**
- virtual scroll・NTFS 判定は next-phase milestone に含めない

詳細は `docs/ui-plan.md` の "next-phase milestone" セクションを参照。

## 残課題 / 次候補

- G-2: Drive selector polish（drive_type 表示・選択済みドライブ補足）
- H-1: TreeView 操作性 polish（選択行視認性・サイズ列揃え）
- H-2: README / runbook 更新（next-phase 対応）
- H-3: next-phase milestone 判定
- （後回し）virtual scroll・delete・Treemap・NTFS 判定・右クリックメニュー

## 設計上の制約

- ツリー構造はアリーナ型（`Vec<FileNode> + usize` インデックス）
- 仮想スクロールは本格実装時に最初から組み込む
- 非 NTFS ドライブは対象外（フォールバックは後フェーズ）

## AI 使い分け方針

| タスク | 担当 |
|--------|------|
| 実装本体・Tauri/Rust 連携・ビルド・コミット | Claude Code (Sonnet 4.6) |
| UI polish・docs 更新・軽微な実装 | Claude Code (Sonnet 4.6) |
| TreeView/Tauri state/大量ノード設計・安全設計・方針判断 | Opus 4.7（節目のみ） |
| 管理者権限・実スキャン設計・セキュリティ判断 | Opus 4.7 または ChatGPT Thinking |
| 指示文作成・進行整理・軽い判断 | ChatGPT Instant |
| 大規模コードベース横断分析・長文仕様解析 | Gemini CLI |
| Claude Code 節約が必要な長時間・大量生成タスク | Codex |

### Sonnet 4.6 で進めてよい場面

- UI polish（CSS・ボタン・レイアウト微調整）
- docs / runbook / README 更新
- 既存パターンに沿った小機能追加（ボタン・helper 関数・CSS class）
- ビルド確認・コミット

### Opus 4.7 を使う場面

- TreeView の設計判断（virtual scroll 導入・state 設計変更）
- 新しい Tauri command の安全設計
- フェーズ節目の方針転換判断
- delete action の設計（将来）
