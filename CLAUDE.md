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

## 現在の到達点

### 完了済み

| フェーズ | 内容 |
|----------|------|
| B-4 | final allocated size policy（extension record 対応） |
| B-5 | parent_frn ツリー集計・サイズ後退伝播 |
| C-1 | `--json` 出力（JsonTreeOutput 型） |
| C-2 | CLI/API entry point 整理（build_mft_tree_output 公開） |
| C-3 | CLI オプション: `--json` / `--drive` / `--top` / `--help` |
| C-4 | JSON schema ドキュメント（docs/json-output-schema.md） |
| C-5 | CLI/API boundary 整理・コメント整備 |
| D-1 | Tauri v2 + React/Vite scaffold / sample JSON viewer |
| D-2 | UI 表示改善（sticky header・path wrapping・数値右寄せ） |
| D-3a | sample JSON を Tauri invoke 経由に切り替え |
| D-3a FU | 通常ブラウザ向け fetch fallback 追加 |
| D-3b-1 | UI から `scan_drive` で実スキャン起動・結果表示 |
| その他 | `_byte_offset` warning 解消 |

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

## 残課題 / 次候補

- Scan 結果の UI 改善（完了時刻・Sample vs Live 表示）
- drive selector UI
- progress 表示 / cancel
- TreeView 本格化（折りたたみ・仮想スクロール）
- Explorer open
- delete action
- WinSxS / WOF / hardlink 差分診断
- Treemap

## 設計上の制約

- ツリー構造はアリーナ型（`Vec<FileNode> + usize` インデックス）
- 仮想スクロールは本格実装時に最初から組み込む
- 非 NTFS ドライブは対象外（フォールバックは後フェーズ）

## AI 使い分け方針

| タスク | 担当 |
|--------|------|
| 実装本体・Tauri/Rust 連携・ビルド・コミット | Claude Code |
| 管理者権限・実スキャン設計・セキュリティ・方針判断 | ChatGPT Thinking |
| 指示文作成・進行整理・軽い判断 | ChatGPT Instant |
| 軽いレビュー・文書化・セカンドオピニオン | Gemini CLI |
| クレジット余裕がある時の定型実装・小修正 | Codex |
