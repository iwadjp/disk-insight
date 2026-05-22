# disk-insight/CLAUDE.md

## プロジェクト概要
WizTree風高速ディスク分析ツール（Windowsデスクトップ）

## 配置
- CLAUDE/maybe_public/disk-insight/

## 技術スタック
- 言語: Rust（msvc toolchain）
- Win32 API: windows = "0.61.3"
- UI: 未確定（Phase 4 で WPF vs Tauri を比較決定）

## 設計上の制約
- 速度目標は「WizTree風の高速ツール」。同等を約束しない
- ツリー構造はアリーナ型（Vec<FileEntry> + usize インデックス）
- 仮想スクロールは UI 導入時に最初から組み込む
- UI フレームワーク確定は Phase 4 まで持ち越し

## AI 使い分け方針
| タスク                          | 担当        |
|---------------------------------|-------------|
| MFT パース・借用チェッカー対応  | Claude Code |
| 定型コード・テスト生成          | Codex       |
| 調査・UIフレームワーク比較      | Gemini CLI  |

## フェーズ
1. MFT 列挙 CLI（ファイル数・総サイズ・上位100件） ← 現在
2. 親子関係復元（FileReferenceNumber → パス復元）
3. サイズ集計（ディレクトリサイズ算出）
4. WPF vs Tauri 比較・UI 確定
5. Tauri UI（TreeView・削除・Explorer 起動）

## 注意事項
- 実行時に管理者権限が必要（MFT アクセスのため）
- 非 NTFS ドライブは Phase 1 対象外（フォールバックは後フェーズ）
- unsafe ブロックは最小限に留め、コメントで理由を明記する