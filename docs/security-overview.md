# disk-insight — Security Overview

会社PC で disk-insight を dogfooding する前に、上長・情報システム部門・セキュリティ担当へ
提示するための説明資料。**事実ベース**で記載し、コードで確認できない点は「不明」と明記する。

> **本資料の前提**
> - 会社PC での利用は **Company-safe mode を ON** にして行うことを前提とする。
> - 現在の build は **未署名（unsigned）**。
> - 社内ルール上許可されない場合、またはセキュリティ製品が警告した場合は **使用しない**。

---

## 1. Summary（要約）

- disk-insight は **Windows ローカルディスクの容量使用状況を可視化する、個人開発中のデスクトップツール**。
- 会社PC dogfooding では **Company-safe mode ON** を前提とする。
- **ネットワーク通信なし** / **自動更新なし** / **telemetry・データ送信なし**（実コードで確認済み）。
- Company-safe mode では、**ターミナル起動・管理者権限での再起動・ごみ箱への移動操作**を UI から非表示にする。
- **会社ルール上許可されない場合は使用しない。** セキュリティ警告が出たら中止する。

---

## 2. ツールの目的

- ローカルディスクの容量使用状況を高速に確認する。
- 大きなフォルダ／ファイルを TreeView で確認する。
- bookmarks で再確認したい対象を保存する。
- WizTree の代替を目指しているが、**社内利用前の dogfooding 段階**であり、製品版ではない。

---

## 3. 実行環境・配布状態

| 項目 | 内容 |
|------|------|
| 形態 | Windows デスクトップアプリ |
| 技術 | Rust + Tauri v2 + WebView2 + React |
| バンドル | `bundle.active = false` のため **bare exe**（installer/MSI は未生成） |
| build | `scripts/build-company-safe.ps1` で再現可能。build 時に SHA256 hash と commit を記録 |
| 署名 | **現時点では未署名（unsigned）** |
| 持ち込み方針 | **署名済み build または社内の明示的許可なしに会社PCで実行しない** |

---

## 4. ネットワーク挙動

実コード確認に基づく:

- **ネットワーク通信なし。** HTTP/socket クライアントのコードは存在しない。
- `reqwest` / `hyper` / updater plugin などの**ネットワーク依存ライブラリを使用していない**（`Cargo.toml` で確認）。
- `tauri.conf.json` の `devUrl: http://127.0.0.1:1420` は **開発時の Vite サーバ専用**で、release build には含まれない。
- **自動更新（updater）なし。**
- **telemetry / analytics / クラウドアップロードなし。**

---

## 5. ファイルシステムアクセス

- ローカルドライブの容量情報を読み取る。
- NTFS の MFT（Master File Table）を **読み取り専用**で参照し、フォルダ／ファイルのサイズを可視化する。
- **書き込み先は `%LOCALAPPDATA%\disk-insight\` 配下のみ:**
  - `cache\` — スキャン結果のキャッシュ
  - `bookmarks.json` — ユーザーが保存した bookmark
- スキャン対象のファイル自体は変更しない。
- **Delete / Rename / Cut / Paste は実装していない。**
- Company-safe mode では削除／ごみ箱操作を UI から非表示にする（§8・§10）。

---

## 6. 外部プロセス起動

通常機能（ユーザーの明示操作時のみ起動）:

| 操作 | 起動するもの |
|------|------------|
| Show in Explorer | `explorer.exe` |
| Show properties | Windows shell の "properties" verb |
| Open terminal here | `powershell.exe` |
| Relaunch as administrator | `ShellExecuteExW` の "runas"（自分自身を昇格再起動） |

**Company-safe mode ON では以下を抑制する:**

- Open terminal here（`powershell.exe` 起動）→ **非表示**
- Relaunch as administrator → **非表示**
- Advanced Mode → **disabled**
- Move to Recycle Bin → **表示されない**

Show in Explorer / Show properties は Company-safe mode でも残るが、**会社ルール次第で使用を控えることも可能**。

---

## 7. 管理者権限

- disk-insight は MFT の読み取りのため、**管理者権限での実行を推奨する場合がある**。
- ただし会社PC dogfooding では Company-safe mode を使い、**admin relaunch ボタンは非表示**にする。
- 管理者権限の利用は **社内ポリシーに従う**。
- 許可されない場合は、非管理者で使う（スキャン機能は制限される）か、会社PC dogfooding を行わない。

---

## 8. 破壊的操作・安全モデル

- **完全削除（permanent delete）は実装していない。**
- **Delete / Cut / Rename / Paste は実装していない。**
- Move to Recycle Bin は **Advanced Mode 限定**（ごみ箱への移動のみ。完全削除ではない）。
- Company-safe mode ON では Advanced Mode が disabled になり、**ごみ箱操作は表示されない**。
- 右クリックメニューは **curated な safe menu** であり、本物の Explorer context menu は埋め込んでいない。
- 7-Zip / Open with / FC delete などは **Release 前で未実装**（追加予定もない）。

---

## 9. ローカルに保存するデータ

| 保存先 | 内容 |
|--------|------|
| `%LOCALAPPDATA%\disk-insight\cache\` | スキャンキャッシュ（ローカル容量情報） |
| `%LOCALAPPDATA%\disk-insight\bookmarks.json` | ユーザーが保存した bookmark |
| 上記以外 | 恒久保存なし |

- ログは **console-only の debug flag** に紐づくのみ。
- v0.5.13-D で `TREE_FOCUS_DEBUG` / `PERF_LOG` / `PERF_TREE` は **すべて `false`**（debug UI・console ログは出ない）。

---

## 10. Company-safe mode

会社PC dogfooding では **必ず ON** にする。

**目的:** EDR/DLP に不審に見えやすい操作を UI から封じ、read-only viewer 寄りの説明しやすい状態にする。

| ON 時に隠す操作 | ON 時に残る操作 |
|------|------|
| Open terminal here（PowerShell 起動） | Scan |
| Relaunch as administrator | TreeView |
| Advanced Mode（disabled） | Bookmarks |
| Move to Recycle Bin | Insights |
| | Copy path / Copy quoted path |
| | Add / Remove bookmark |
| | Show in Explorer / Show properties |

---

## 11. 既知の制約・残るリスク

- 現在の build は **未署名**。
- 未署名のため、**SmartScreen / AppLocker / EDR に停止される可能性**がある。
- 会社PC利用には **署名済み build または社内の明示的許可が必要**。
- **NTFS / MFT の読み取りが社内ポリシー上許可されるか**は要確認（DLP 等が情報収集と誤認する可能性は否定できない）。
- Company-safe mode は**安全説明をしやすくするためのもの**であり、**社内許可の代替にはならない**。

---

## 12. 運用方針

- **セキュリティ警告が出たら実行を中止する。**
- **Defender / EDR / AppLocker を無効化しない。**
- **警告を無視して続行しない。**
- 許可が取れない場合は会社PCで使わない。
- 会社PC dogfooding は **短時間・Company-safe mode ON・許可範囲内**で行う。

---

## 13. 利用許可の依頼テンプレート

> ローカルディスク容量可視化ツール disk-insight を、Company-safe mode ON で短時間 dogfooding したいです。
> ネットワーク通信、自動更新、telemetry はなく、書き込みは `%LOCALAPPDATA%\disk-insight\` 配下のみです。
> Company-safe mode では PowerShell 起動、管理者再起動、Recycle 操作は UI から非表示になります。
> 未署名 build のため、実行可否をご確認ください。許可されない場合は使用しません。

---

## 14. 検証チェックリスト（build / 持ち込み前）

```
[ ] commit hash を記録した
[ ] SHA256 hash を記録した
[ ] TREE_FOCUS_DEBUG = false
[ ] PERF_LOG          = false
[ ] PERF_TREE         = false
[ ] Company-safe mode を ON にして使う
[ ] 署名状態（unsigned / signed）を把握している
[ ] セキュリティ警告時は中止する方針を確認した
```

> 上記の build 確認は `scripts/build-company-safe.ps1` が自動で表示する。

---

## 15. 関連ドキュメント

- [`v0.5.13-company-pc-dogfooding-plan.md`](./v0.5.13-company-pc-dogfooding-plan.md) — 方針・リスク表
- [`company-pc-dogfooding-checklist.md`](./company-pc-dogfooding-checklist.md) — Go/No-Go・実行手順
- [`company-safe-build.md`](./company-safe-build.md) — build 手順・hash 記録
- [`context-menu-release-decisions.md`](./context-menu-release-decisions.md) — メニュー仕様の決定
