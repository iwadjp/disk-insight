# Context Menu Gap Log

> Created: 2026-06-03
> 関連: [v0.5.7-context-menu-plan.md](v0.5.7-context-menu-plan.md)

---

## Purpose

disk-insight の curated context menu で不足した操作を dogfooding 中に記録する。
記録を積み上げることで、以下を判断するための材料にする：

- curated menu に追加すべき頻出項目はあるか
- Explorer handoff（Show in Explorer）で代替できるか
- 不足項目が多く curated menu で追いつかない場合、Shell context menu（案A）の再検討が必要か

**現状認識（2026-06-03 時点）**

v0.5.7-A/B で "safe curated menu improvement" は達成した。しかし "Explorer-equivalent context
menu completion" は達成していない。Explorer / WizTree が出せる環境固有のシェル拡張項目は
disk-insight には出ない。これが問題になるかどうかは dogfooding で判断する。

---

## Current disk-insight menu（v0.5.7-B 時点）

| 項目 | 動作 | 表示条件 |
|------|------|----------|
| Show in Explorer | フォルダ=開く、ファイル=選択して表示 | 常時 |
| Open terminal here | そのフォルダ（or 親フォルダ）でPowerShellを開く | 常時 |
| Show properties | Windows プロパティダイアログ | 常時 |
| Copy path | クリップボードにパスをコピー | 常時 |
| Copy as path | クリップボードに "パス" をコピー | 常時 |
| — ADVANCED — | セクション区切り | Advanced ON 時 |
| Move to Recycle Bin | Recycle Bin に移動（Rust 検証付き） | Advanced ON 時のみ |

---

## Known Explorer menu examples（ユーザー環境で確認済みの項目）

Explorer の右クリックメニューには、インストール済みアプリが項目を注入する。
以下はユーザー環境で実際に存在が確認された・または一般的に存在する項目例：

**OS 標準**
- Open
- Open in new window
- Pin to Quick Access
- Send to（メール、デスクトップ、ドライブ等）
- Cut / Copy / Paste / Paste shortcut
- Delete / Rename
- Properties

**開発ツール**
- Open with Antigravity（Antigravity CLI）
- Open with Visual Studio
- Open with Cursor
- Open Git GUI here
- Open Git Bash here
- Open project in Codex
- Open with Code（VS Code）
- TortoiseGit（Commit / Push / Pull / Log / Diff 等の submenu）
- CVS（バージョン管理）

**ユーティリティ**
- 7-Zip（Extract here / Add to archive / Test 等の submenu）
- Microsoft Defender でスキャン
- PowerRename（Windows PowerToys）
- Shared Folder Synchronization（OneDrive 等）
- クラウド同期サービスのコンテキスト項目

---

## Dogfooding entries

disk-insight を実際に使っていて、右クリックメニューに欲しかったが無かった項目を記録する。

| Date | 操作対象 | 欲しかった項目 | 使用頻度 | 代替手段 | 候補アクション |
|------|---------|--------------|---------|---------|--------------|
| *(まだなし)* | | | | | |

**記入ガイドライン:**
- `Date`: YYYY-MM-DD
- `操作対象`: どんな種類のファイル/フォルダで（例: プロジェクトフォルダ、大容量ログファイル等）
- `欲しかった項目`: Explorer にある具体的な項目名
- `使用頻度`: daily / weekly / occasional / rare
- `代替手段`: Show in Explorer で代替可能か / 手動で開いた等
- `候補アクション`: curated 追加候補 / Explorer handoff で十分 / 要検討

---

## Decision rules

gap log の蓄積に基づいて以下のルールで判断する：

### curated menu への追加を検討する条件
- **頻度 weekly 以上** かつ
- **安全に実装できる**（OS 標準プロセスを spawn する、または Rust 側で検証できる）かつ
- **Explorer handoff では不十分**（Explorer を開いてから操作するのが明確に非効率）

### Explorer handoff（Show in Explorer）で十分と判断する条件
- 操作が Explorer 上で 1-2 クリックで完了する
- 環境固有のシェル拡張（7-Zip 等）であり、disk-insight での再実装は現実的でない
- 頻度が weekly 未満

### 案A（Shell context menu 全体）の再検討トリガー
以下がすべて揃った場合に限り、§3 の却下判断を見直す：
1. gap log に頻出（weekly 以上）の不足項目が**複数**記録された
2. それらが curated menu では安全に実装できないと判断された
3. IContextMenu の安全リスク（永久削除・第三者コード・unsafe）に対する技術的緩和策がある

**現状（2026-06-03）**: 上記条件は揃っていない。

---

## Roadmap

### 短期（現在）
- curated menu で dogfooding を続ける
- gap log に不足項目を記録する
- 追加 curated verb を実装する前に、必ず gap log に記録があることを確認する

### 中期（gap log に頻出項目が記録されたら）
頻出かつ安全に実装できるものだけを curated menu に個別追加する。
各項目ごとに安全性を個別評価する（v0.5.7-B の `open_terminal_at` と同じ流儀）。

候補例（実装する/しないの判断は gap log の結果次第）：
- Open with VS Code（`code.exe <path>` を spawn、非破壊、安全性低い）
- Open Git Bash here（`git-bash.exe --cd=<path>` を spawn、非破壊）
- 7-Zip handoff（Explorer に委譲 or 7z.exe の extract only、慎重に評価）
- Microsoft Defender スキャン（`MpCmdRun.exe` 起動、安全）

### 長期（curated menu で追いつかないと判断されたら）
Shell context menu（IContextMenu）の実装を再検討する。
ただし §3 の安全上の問題が解決・緩和されていることが前提。
