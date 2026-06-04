# disk-insight -- Security Overview

Windows ローカルディスクの容量可視化ツール disk-insight を dogfooding する前に、
上長・情報システム部門・セキュリティ担当へ提示するための説明資料。
**事実ベース**で記載し、コードで確認できない点は「不明」と明記する。

> **本資料の前提**
> - 会社PC での利用は **デフォルトの Normal Mode** で行う。
>   Company-safe UI チェックボックスは v0.5.18-C で削除済み。
> - Advanced Mode（Move to Recycle Bin のゲート）は明示 ON / 非永続のため、
>   **会社PC では有効化しないこと**。
> - 現在の build は **未署名（unsigned）**。
> - 社内ルール上許可されない場合、またはセキュリティ製品が警告した場合は **使用しない**。

---

## 1. Summary

- disk-insight は **Windows ローカルディスクの容量使用状況を可視化する、個人開発中のデスクトップツール**。
- **ネットワーク通信なし** / **自動更新なし** / **telemetry・データ送信なし**（実コードで確認済み）。
- デフォルトの Normal Mode では**破壊的ファイル操作は表示されない**。
- Move to Recycle Bin は Advanced Mode を明示 ON にした場合のみ表示される。
  Advanced Mode は非永続（起動のたびに OFF に戻る）。
- **会社ルール上許可されない場合は使用しない。** セキュリティ警告が出たら中止する。

---

## 2. ツールの目的

- ローカルディスクの容量使用状況を高速に確認する。
- 大きなフォルダ／ファイルを TreeView で確認する。
- Bookmarks / Review list で確認対象を管理する。
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
| 持ち込み方針 | 署名済み build が最も望ましい。会社PC環境で未署名ローカルツールの実行が許容されており警告なしに実行できる場合は dogfooding 候補 |

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
  - `cache\` -- スキャン結果のキャッシュ
  - `bookmarks.json` -- ユーザーが保存した bookmark
- スキャン対象のファイル自体は変更しない。
- **Delete / Rename / Cut / Paste は実装していない。**

---

## 6. 外部プロセス起動

ユーザーが明示的に操作した場合のみ起動する:

| 操作 | 起動するもの |
|------|------------|
| Show in Explorer | `explorer.exe` |
| Show properties | Windows shell の "properties" verb |
| Open terminal here | `powershell.exe` |
| Relaunch as administrator | `ShellExecuteExW` の "runas"（自分自身を昇格再起動） |

これらはいずれも **ユーザーが明示的にメニュー項目を選択した場合のみ** 起動する。
自動起動・バックグラウンド起動はない。

**会社PC dogfooding の方針:**

- Open terminal here / Relaunch as administrator は UI に表示されるが、
  **会社PC では使用しない**（社内ルール・ポリシーに従う）。
- Show in Explorer / Show properties は使用するかどうか会社ルール次第。

> Note: v0.5.18-C 以前は "Company-safe mode" UI toggle でこれらを非表示にしていたが、
> 同モードは削除された。会社PC 向けの説明は本ドキュメントと README で担保する。

---

## 7. 管理者権限

- disk-insight は MFT の読み取りのため、**管理者権限での実行を推奨する場合がある**。
- 管理者権限の利用は **社内ポリシーに従う**。
- 非管理者権限でも起動・スキャンは可能だが、一部の MFT 操作が制限される。
- Relaunch as administrator ボタンは、非昇格時に admin warning banner として表示される。
  **会社PC では使用しないこと。**
- 許可されない場合は、非管理者で使う（スキャン機能は制限される）か、会社PC dogfooding を行わない。

---

## 8. 安全モデル

### Normal Mode（デフォルト）

disk-insight は起動直後から Normal Mode で動作する。

- Scan / TreeView / Visualization
- Explorer handoff（Show in Explorer / Show properties）
- Copy path / Copy quoted path
- Bookmarks / Review list / batch copy paths
- **破壊的ファイル操作は表示されない**
- Move to Recycle Bin は **表示されない**
- ネットワーク通信なし / 自動更新なし / telemetry なし

### Advanced Mode（明示 opt-in / 非永続）

- ユーザーが toolbar の "Advanced Mode" チェックボックスを ON にした場合のみ有効になる。
- 警告・承認の表示を経てから有効化される。
- **非永続: 起動のたびに OFF に戻る。**
- Move to Recycle Bin（ごみ箱への移動）が表示される。
- ごみ箱への移動は **完全削除ではなく** Windows ごみ箱への移動のみ。
- 各操作前に確認 modal が表示され、パス・サイズ・リスク警告が示される。
- **会社PC では Advanced Mode を有効化しないこと。**

---

## 9. ローカルに保存するデータ

| 保存先 | 内容 |
|--------|------|
| `%LOCALAPPDATA%\disk-insight\cache\` | スキャンキャッシュ（ローカル容量情報） |
| `%LOCALAPPDATA%\disk-insight\bookmarks.json` | ユーザーが保存した bookmark |
| 上記以外 | 恒久保存なし |

- ログは **console-only の debug flag** に紐づくのみ。
- `TREE_FOCUS_DEBUG` / `PERF_LOG` / `PERF_TREE` は release build では **すべて `false`**（debug UI・console ログは出ない）。

---

## 10. 既知の制約・残るリスク

- 現在の build は **未署名**。
- 未署名のため、**SmartScreen / AppLocker / EDR に停止される可能性**がある。
- 会社PC環境で未署名ローカルツールの実行が許容されており、セキュリティ警告なしに実行できる場合は dogfooding の候補とできる。許容されていない場合は実行しない。
- **NTFS / MFT の読み取りが社内ポリシー上許可されるか**は要確認（DLP 等が情報収集と誤認する可能性は否定できない）。

---

## 11. 運用方針

- **セキュリティ警告が出たら実行を中止する。**
- **Defender / EDR / AppLocker を無効化しない。**
- **警告を無視して続行しない。**
- 許可が取れない場合は会社PCで使わない。
- 会社PC dogfooding は **短時間・Normal Mode・許可範囲内**で行う。
- **Advanced Mode は会社PC では有効化しない。**

---

## 12. 利用許可の依頼テンプレート

```
disk-insight（ローカルディスク容量可視化ツール）社内試験利用のご確認

ローカルディスクの容量使用状況を可視化するツール disk-insight を、
短時間 dogfooding させていただきたいです。

- ネットワーク通信・自動更新・telemetry はありません。
- 書き込みは %LOCALAPPDATA%\disk-insight\ 配下のみです
  （スキャン対象ファイルは変更しません）。
- デフォルト状態（Normal Mode）では、削除・移動・名前変更などの
  破壊的ファイル操作は表示されません。
- Move to Recycle Bin は Advanced Mode を明示 ON にした場合のみ表示されます。
  会社PC では Advanced Mode を有効化しません。
- terminal / admin relaunch は UI に存在しますが、会社PC では使用しません。
- 未署名 build のため、実行可否をご確認ください。
  許可されない場合は使用しません。
```

---

## 13. 検証チェックリスト（build / 持ち込み前）

```
[ ] commit hash を記録した
[ ] SHA256 hash を記録した
[ ] TREE_FOCUS_DEBUG = false
[ ] PERF_LOG          = false
[ ] PERF_TREE         = false
[ ] 署名状態（unsigned / signed）を把握している
[ ] セキュリティ警告時は中止する方針を確認した
[ ] 会社PC では Advanced Mode を有効化しない方針を確認した
```

> 上記の build 確認は `scripts/build-company-safe.ps1` が自動で表示する。

---

## 14. 関連ドキュメント

- [`v0.5.13-company-pc-dogfooding-plan.md`](./v0.5.13-company-pc-dogfooding-plan.md) -- 初期リスク方針表
- [`company-pc-dogfooding-checklist.md`](./company-pc-dogfooding-checklist.md) -- Go/No-Go・実行手順
- [`company-safe-build.md`](./company-safe-build.md) -- build 手順・hash 記録
- [`v0.5.18-company-safe-mode-rethink.md`](./v0.5.18-company-safe-mode-rethink.md) -- Company-safe mode 廃止の設計記録
- [`context-menu-release-decisions.md`](./context-menu-release-decisions.md) -- メニュー仕様の決定
