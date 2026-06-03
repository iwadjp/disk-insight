# Company PC Dogfooding Checklist (v0.5.13-C)

会社PC（厳格なセキュリティ環境）で disk-insight を **実際に dogfooding するかどうか** を判断し、
許可される場合に **何をどの順で行うか** を明確化した実行チェックリスト。

- 前提資料: [`v0.5.13-company-pc-dogfooding-plan.md`](./v0.5.13-company-pc-dogfooding-plan.md)（方針・リスク表）
  / [`context-menu-release-decisions.md`](./context-menu-release-decisions.md)（メニュー仕様）
- 本書は **判断と手順のみ**。コード変更・署名・配布・GitHub Release は含まない。
- **大原則:** セキュリティ製品（Defender / EDR / AppLocker / SmartScreen）の無効化・回避・検知回避は一切行わない。
  社内ルールに従い、許可される範囲でのみ実行する。**許可が取れない／警告が出るなら会社PCでは使わない。**

> **このセッション時点の状態（確認済み）**
> - Company-safe mode 実装済み（v0.5.13-B, commit `84a33ac`）。
> - `TREE_FOCUS_DEBUG = false`（debug FAB は出ない）。
> - ネットワーク通信なし / 自動更新なし（`tauri.conf.json` に updater 設定なし、`bundle.active = false`）。
> - 書き込み先は `%LOCALAPPDATA%\disk-insight\`（cache + bookmarks.json）のみ。
> - 署名: **未署名**（現状）。

---

## 1. Go / No-Go 判断

**すべての Go 条件を満たし、No-Go 条件にひとつも当たらない場合のみ実行する。** 迷ったら No-Go。

### ✅ Go（この全部を満たす）

| # | 条件 |
|---|------|
| G1 | 社内ルール上、個人作成ツールの実行が許可されている（または明示的に確認が取れた） |
| G2 | ローカルディスク容量分析ツールの利用が許可されている |
| G3 | 管理者権限の利用可否が**明確**（admin 不可でも read-only 範囲で使うなら可、を含む） |
| G4 | 未署名 exe の実行が許可されている、**または**署名済み build を用意できる |
| G5 | **Company-safe mode を ON にして使う**（最低条件） |
| G6 | セキュリティ製品が警告したら即停止し、無理に回避しない、と決めている |

### ⛔ No-Go（ひとつでも当たれば実行しない）

| # | 条件 |
|---|------|
| N1 | 社内ルール上、個人ツール実行が**不明または禁止** |
| N2 | AppLocker / EDR / Defender が exe をブロックする |
| N3 | admin 権限が必要だが許可されていない（かつ read-only でも目的を満たせない） |
| N4 | 未署名 exe の実行が禁止されている（かつ署名 build を用意できない） |
| N5 | セキュリティ警告を**無視しないと**使えない |
| N6 | PowerShell 起動・昇格など、Company-safe で封じた挙動を要求する運用になる |

> N1 が「不明」の場合は **No-Go 扱い**。確認が取れてから G1 を満たす。

---

## 2. 事前確認チェックリスト（自宅PC側でやる）

会社PCに持ち込む **前に**、自宅PC（開発機）で確認する。

```
[ コード状態 ]
  [ ] git status が clean（未コミット変更なし）
  [ ] TREE_FOCUS_DEBUG = false（main.tsx）→ debug FAB が出ない
  [ ] （任意）PERF_LOG / PERF_TREE を false にした静かな build にするか判断
       ※ console.log のみで通信・ファイル書き込みはないため security 上は非ブロッカー

[ Company-safe mode 動作 ]
  [ ] Company-safe チェックボックスが toolbar に表示される
  [ ] Company-safe ON で「Open terminal here」が context menu に出ない
  [ ] Company-safe ON で「Move to Recycle Bin」が出ない
  [ ] Company-safe ON で Advanced Mode が disabled / OFF になる
  [ ] Company-safe ON で「Relaunch as administrator」ボタンが出ない
  [ ] Company-safe ON で青い説明バナーが出る

[ 説明可能性 ]
  [ ] ネットワーク通信がないことを説明できる（reqwest/updater なし）
  [ ] 自動更新がないことを説明できる
  [ ] 書き込み先が %LOCALAPPDATA%\disk-insight\ のみだと説明できる
  [ ] 削除操作は Company-safe では無効だと説明できる

[ 配布物 ]
  [ ] 署名状態を確認した（署名済み / 未署名のどちらか把握）
  [ ] build artifact の SHA256 hash を記録した（§6）
  [ ] version / commit hash を記録した
```

---

## 3. 会社PCでの初回起動手順

**各ステップで問題が出たら、その場で中止する。** 先へ進めない。

1. **実行可否を確認する** — §1 の Go/No-Go を会社PC環境で再判定。No-Go なら終了。
2. **必要なら事前説明する** — 上長 / 情シス / セキュリティ担当へ §4 のテンプレートで概要を伝え、許可を得る。
3. **exe を配置する** — IT が許可する場所に置く（持ち込み手段も社内ルールに従う）。hash を §2 の記録と照合。
4. **Company-safe mode を ON にする** — 起動後すぐ。スキャン前に ON にしておく。
5. **まず非管理者で起動する** — いきなり昇格しない。read-only で挙動を見る。
6. **セキュリティ警告が出たら停止** — SmartScreen / EDR / AppLocker が何か言ったら、そこで中止（§8）。回避しない。
7. **C: を読み取り確認する** — scan が通るか。admin が要るエラーなら、G3 の許可範囲内でのみ昇格を検討（Company-safe では relaunch ボタンは出ないので、起動方法は社内ルールに従う）。
8. **封じた操作が出ないことを確認** — Open terminal here / Move to Recycle Bin / Relaunch as administrator / Advanced Mode が UI に出ない。
9. **問題なければ短時間 dogfooding** — TreeView / Bookmarks / Insights を中心に。
10. **問題が出たら中止して記録** — 何が・どの製品で・どう止まったかをメモ（§8）。

---

## 4. 情シス向け説明テンプレート

> 必要に応じてそのまま提示できる短い説明。詳細版は将来 `docs/security-overview.md`（v0.5.13-D 候補）に整備予定。

```
disk-insight — 概要（社内利用前の確認用）

・目的: ローカルディスクの使用量を可視化する、社内利用前の個人開発ツール
        （NTFS の MFT を読み取り、フォルダ/ファイル単位の容量を表示）

・ネットワーク: 通信なし（外部送信なし・テレメトリなし・自動更新なし）
・データ送信: なし
・低レベルアクセス: ローカルボリュームの MFT を「読み取り専用」で参照

・Company-safe mode（ON で使用）では以下を非表示/無効化:
    - PowerShell 起動（Open terminal here）
    - 管理者権限での再起動（Relaunch as administrator）
    - ごみ箱への移動（Move to Recycle Bin）/ Advanced Mode

・書き込み: %LOCALAPPDATA%\disk-insight\ の cache と bookmarks.json のみ
           （ユーザー領域のみ。スキャン対象ファイルは変更しない）
・削除操作: Company-safe mode では無効。通常時も「ごみ箱への移動」のみで完全削除はしない

・署名: [署名済み <発行者> / 現在は未署名 — 確認中]

・実行を許可いただけない場合は、会社PCでは使用しません。
```

---

## 5. 署名・配布の選択肢

| 選択肢 | SmartScreen | AppLocker | EDR | 説明しやすさ | 運用コスト | 会社PC適性 |
|--------|:----------:|:---------:|:---:|:----------:|:--------:|:--------:|
| 未署名 release exe | 警告 | 既定で不可になりやすい | 不審扱いされやすい | 低 | 低 | ✕ 高リスク |
| 未署名 portable zip | 警告（MotW） | 同上 | 同上 | 低 | 低 | ✕ 高リスク |
| 署名済み exe | 緩和（評価蓄積で改善） | 署名ルールで許可可 | 緩和 | 高 | 中（証明書必要） | ○ 現実解 |
| 署名済み installer/MSI | 緩和 | 許可可・配置追跡可 | 緩和 | 最高 | 中〜高 | ◎ Release 向け |
| 社内許可済み internal build | IT 例外で回避可 | IT 許可で可 | IT 許可で可 | 高（IT 合意済み） | 中（社内調整） | ◎ 許可が取れるなら最良 |

### 結論
- **未署名 exe / zip は会社PC dogfooding のリスクが高い。** 既定でブロック・警告されやすい。
- **望ましいのは「署名済み build」または「社内の明示的許可（internal build 扱い）」。**
- どちらも無いなら、**会社PCでは無理に使わない**（自宅PC dogfooding に留める）。

---

## 6. build 手順（会社PC dogfooding 用）

```
[ クリーンな release build ]
  [ ] git status が clean
  [ ] TREE_FOCUS_DEBUG = false を確認（ui/src/main.tsx）
  [ ] Company-safe mode 実装が入っていることを確認（commit 84a33ac 以降）
  [ ] （任意）PERF_LOG / PERF_TREE = false にするか判断（console ログを止めたい場合）
```

PowerShell でのビルドと検証:

```powershell
# 1. ビルド（ui の前段 build → tauri release build）
npm run tauri build

# 2. 成果物の場所
#    src-tauri\target\release\disk-insight-ui.exe

# 3. version / commit を記録
git rev-parse --short HEAD          # コミット hash
# tauri.conf.json の "version"（現状 0.1.0）も控える

# 4. SHA256 hash を取得して記録（配置先での照合用）
Get-FileHash .\src-tauri\target\release\disk-insight-ui.exe -Algorithm SHA256
```

zip 化する場合の注意:
- zip 経由で会社PCに渡すと **Mark-of-the-Web** が付き、展開後の exe で SmartScreen 警告が出やすい。
- zip 配布より、IT が許可する受け渡し手段を優先。配布後は hash を照合する。

署名する場合（証明書がある場合のみ。**ない場合はこの工程は飛ばし、§5 の結論に従う**）:

```powershell
# placeholder（証明書が用意できたら実施。証明書がない間は実行しない）
# signtool sign /fd SHA256 /tr <timestamp-url> /td SHA256 /a `
#   .\src-tauri\target\release\disk-insight-ui.exe
```

---

## 7. 会社PCで使ってよい機能 / 使わない機能

### Company-safe ON で使う
- Scan（C: などの読み取り）
- TreeView（展開・キーボード操作・focus）
- Bookmarks（追加・削除・jump・cross-drive 表示）
- Insights（フォルダ別の下部パネル）
- Show in Explorer / Show properties — **使うかは会社ルール次第**（explorer 起動・shell verb。低リスクだが外部プロセス起動ではある）
- Copy path / Copy quoted path / Add・Remove bookmark

### Company-safe ON で使わない（UI に出ない）
- Open terminal here（PowerShell 起動）
- Relaunch as administrator（昇格）
- Move to Recycle Bin / Advanced Mode
- Delete / Cut / Rename / Paste — **そもそも未実装**（追加もしない）

---

## 8. セキュリティ警告が出た場合の対応

- **警告を無視して続行しない。**
- **Defender / EDR / AppLocker / SmartScreen を無効化・例外強要しない。**
- ブロックされたら **会社PC dogfooding を中止する。**
- 必要なら §4 の説明（将来は Security Overview）を提出し、**IT の許可を待つ。**
- **許可が出るまで使わない。** 何が・どの製品で・どう止まったかを記録し、次の判断材料にする。

---

## 9. 次アクション（v0.5.13-D 以降）

- signing / packaging の具体化（証明書の選定・取得、bundle 設定の有効化検討）
- アプリ内 version 表示（dogfooding 時の版特定を容易に）
- `docs/security-overview.md` の整備（§4 テンプレートの実体化・恒久ドキュメント化）
- Company-safe mode 永続化の要否判断（現状はセッション内 state。会社PCで常時 ON にしたいなら localStorage 化を検討）
- 会社PC dogfooding build の作成（署名 or 社内許可が前提）
- **GitHub Release とは分けて考える**（Release は別スコープ。今回も行わない）

---

## 10. 結論

- **今すぐ会社PCに未署名 exe を持ち込むべきではない。** 未署名は SmartScreen / AppLocker / EDR で止まりやすく、リスクが高い。
- **会社PCで使う最低条件:**
  1. 社内ルール上の実行許可（G1〜G4）が取れていること
  2. **Company-safe mode を ON にして使うこと**
  3. **署名済み build または社内の明示的許可**があること
- **使わない判断基準:** No-Go 条件（N1〜N6）にひとつでも当たる、またはセキュリティ警告が出たら**中止**。
- **次にやるべき作業:** signing / packaging の具体化（v0.5.13-D）。それが整うまでは自宅PC dogfooding に留める。
