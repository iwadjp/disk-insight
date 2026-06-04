# Company PC Dogfooding Checklist

会社PC（厳格なセキュリティ環境）で disk-insight を **実際に dogfooding するかどうか** を判断し、
許可される場合に **何をどの順で行うか** を明確化した実行チェックリスト。

- 前提資料: [`v0.5.13-company-pc-dogfooding-plan.md`](./v0.5.13-company-pc-dogfooding-plan.md)（方針・リスク表）
  / [`context-menu-release-decisions.md`](./context-menu-release-decisions.md)（メニュー仕様）
- **Build 手順・hash 記録:** [`company-safe-build.md`](./company-safe-build.md) / script: [`scripts/build-company-safe.ps1`](../scripts/build-company-safe.ps1)
- 本書は **判断と手順のみ**。コード変更・署名・配布・GitHub Release は含まない。
- **大原則:** セキュリティ製品（Defender / EDR / AppLocker / SmartScreen）の無効化・回避・検知回避は一切行わない。
  社内ルールに従い、許可される範囲でのみ実行する。**許可が取れない／警告が出るなら会社PCでは使わない。**

> **安全モデル (v0.5.18-C 以降)**
> - Company-safe mode チェックボックスは削除された。
> - アプリはデフォルトで Normal Mode（安全な閲覧モード）で起動する。
> - Normal Mode では破壊的ファイル操作は表示されない。
> - Advanced Mode は明示 ON / 非永続 / Move to Recycle Bin のゲート。
> - **会社PC では Advanced Mode を有効化しないこと。**

---

## 1. Go / No-Go 判断

**すべての Go 条件を満たし、No-Go 条件にひとつも当たらない場合のみ実行する。** 迷ったら No-Go。

### Go（この全部を満たす）

| # | 条件 |
|---|------|
| G1 | 社内ルール上、個人作成ツールの実行が許可されている（または明示的に確認が取れた） |
| G2 | ローカルディスク容量分析ツールの利用が許可されている |
| G3 | 管理者権限の利用可否が**明確**（admin 不可でも read-only 範囲で使うなら可、を含む） |
| G4 | 未署名アプリの実行が会社PC環境で通常許容されている（他の未署名ツールの実績がある等）、**または**署名済み build / 社内の明示許可がある |
| G5 | **デフォルト Normal Mode で使う**（Advanced Mode は有効化しない） |
| G6 | セキュリティ製品が警告したら即停止し、無理に回避しない、と決めている |

### No-Go（ひとつでも当たれば実行しない）

| # | 条件 |
|---|------|
| N1 | 社内ルール上、個人ツール実行が**不明または禁止** |
| N2 | AppLocker / EDR / Defender が exe をブロックする |
| N3 | admin 権限が必要だが許可されていない（かつ read-only でも目的を満たせない） |
| N4 | 未署名アプリの実行が禁止されている（G4 の条件をひとつも満たせない） |
| N5 | セキュリティ警告を**無視しないと**使えない |
| N6 | Move to Recycle Bin / Advanced Mode の使用が必要な用途になっている |

> N1 が「不明」の場合は **No-Go 扱い**。確認が取れてから G1 を満たす。

---

## 2. 事前確認チェックリスト（自宅PC側でやる）

会社PCに持ち込む **前に**、自宅PC（開発機）で確認する。

```
[ コード状態 ]
  [ ] git status が clean（未コミット変更なし）
  [ ] TREE_FOCUS_DEBUG = false（main.tsx）--> debug FAB が出ない
  [ ] （任意）PERF_LOG / PERF_TREE を false にした静かな build にするか判断
       (console.log のみで通信・ファイル書き込みはないため security 上は非ブロッカー)

[ Normal Mode / Advanced Mode 動作 ]
  [ ] 起動直後に Company-safe チェックボックスが存在しないことを確認（v0.5.18-C で削除済み）
  [ ] 起動直後に Advanced Mode が OFF であることを確認
  [ ] Advanced Mode OFF の状態で Move to Recycle Bin が表示されないことを確認
  [ ] Advanced Mode を明示 ON にしない限り破壊的操作が出ないことを確認

[ 説明可能性 ]
  [ ] ネットワーク通信がないことを説明できる（reqwest/updater なし）
  [ ] 自動更新がないことを説明できる
  [ ] 書き込み先が %LOCALAPPDATA%\disk-insight\ のみだと説明できる
  [ ] Normal Mode では破壊的操作が表示されないと説明できる

[ 配布物 ]
  [ ] 署名状態を確認した（署名済み / 未署名のどちらか把握）
  [ ] build artifact の SHA256 hash を記録した（Section 6）
  [ ] version / commit hash を記録した
```

---

## 3. 会社PCでの初回起動手順

**各ステップで問題が出たら、その場で中止する。** 先へ進めない。

1. **実行可否を確認する** -- Section 1 の Go/No-Go を会社PC環境で再判定。No-Go なら終了。
2. **必要なら事前説明する** -- 上長 / 情シス / セキュリティ担当へ Section 4 のテンプレートで概要を伝え、許可を得る。
3. **exe を配置する** -- IT が許可する場所に置く（持ち込み手段も社内ルールに従う）。hash を Section 2 の記録と照合。
4. **Normal Mode のまま使う** -- 起動後、Advanced Mode は ON にしない。スキャン前に確認する。
5. **まず非管理者で起動する** -- いきなり昇格しない。read-only で挙動を見る。
6. **セキュリティ警告が出たら停止** -- SmartScreen / EDR / AppLocker が何か言ったら、そこで中止（Section 8）。回避しない。
7. **C: を読み取り確認する** -- scan が通るか。admin が要るエラーなら、G3 の許可範囲内でのみ昇格を検討（Relaunch as administrator ボタンは会社PC では使用しない）。
8. **Advanced Mode が OFF のままであることを確認** -- Move to Recycle Bin が表示されていないことを確認。
9. **問題なければ短時間 dogfooding** -- TreeView / Bookmarks / Review list / Insights を中心に。
10. **問題が出たら中止して記録** -- 何が・どの製品で・どう止まったかをメモ（Section 8）。

---

## 4. 情シス向け説明テンプレート

```
disk-insight -- 概要（社内利用前の確認用）

- 目的: ローカルディスクの使用量を可視化する、社内利用前の個人開発ツール
        （NTFS の MFT を読み取り、フォルダ/ファイル単位の容量を表示）

- ネットワーク: 通信なし（外部送信なし・テレメトリなし・自動更新なし）
- データ送信: なし
- 低レベルアクセス: ローカルボリュームの MFT を「読み取り専用」で参照

- デフォルト状態（Normal Mode）では、削除・移動・名前変更などの
  破壊的ファイル操作は表示されません。
- Move to Recycle Bin は Advanced Mode を明示 ON にした場合のみ表示されます。
  会社PC では Advanced Mode を有効化しません。
- terminal （Open terminal here）/ 管理者権限再起動（Relaunch as administrator）
  は UI に存在しますが、会社PC では使用しません。

- 書き込み: %LOCALAPPDATA%\disk-insight\ の cache と bookmarks.json のみ
           （ユーザー領域のみ。スキャン対象ファイルは変更しない）
- 削除操作: Advanced Mode OFF の通常状態では表示なし。
            Delete / Cut / Rename / Paste は実装していない。

- 署名: [署名済み <発行者> / 現在は未署名 -- 確認中]

- 実行を許可いただけない場合は、会社PCでは使用しません。
```

---

## 5. 署名・配布の選択肢

| 選択肢 | SmartScreen | AppLocker | EDR | 説明しやすさ | 運用コスト | 会社PC適性 |
|--------|:----------:|:---------:|:---:|:----------:|:--------:|:--------:|
| 未署名 release exe | 警告（環境次第） | 環境次第 | 環境次第 | 中 | 低 | 未署名ローカルツール実行が許容される環境のみ |
| 未署名 portable zip | 警告（MotW あり） | 環境次第 | 環境次第 | 中 | 低 | zip 展開は MotW 注意 |
| 署名済み exe | 緩和（評価蓄積で改善） | 署名ルールで許可可 | 緩和 | 高 | 中（証明書必要） | 推奨 |
| 署名済み installer/MSI | 緩和 | 許可可・配置追跡可 | 緩和 | 最高 | 中〜高 | Release 向け |
| 社内許可済み internal build | IT 例外で回避可 | IT 許可で可 | IT 許可で可 | 高（IT 合意済み） | 中（社内調整） | 許可が取れるなら最良 |

### 結論
- **署名済み build が最も望ましい。**
- **未署名 build でも、会社PC環境で未署名ローカルツールの実行実績があれば持ち込み候補にできる。**
- ブロック・警告が出たら中止する。セキュリティ製品を無効化・回避しない。

---

## 6. build 手順（会社PC dogfooding 用）

```
[ クリーンな release build ]
  [ ] git status が clean
  [ ] TREE_FOCUS_DEBUG = false を確認（ui/src/main.tsx）
  [ ] （任意）PERF_LOG / PERF_TREE = false にするか判断（console ログを止めたい場合）
```

PowerShell でのビルドと検証:

```powershell
# 1. ビルド
npm run tauri build

# 2. 成果物
#    src-tauri\target\release\disk-insight-ui.exe

# 3. version / commit を記録
git rev-parse --short HEAD

# 4. SHA256 hash を取得して記録
Get-FileHash .\src-tauri\target\release\disk-insight-ui.exe -Algorithm SHA256
```

または `scripts/build-company-safe.ps1` を使うと上記を自動化できる。

zip 化する場合の注意:
- zip 経由で会社PCに渡すと **Mark-of-the-Web** が付き、展開後の exe で SmartScreen 警告が出やすい。
- zip 配布より、IT が許可する受け渡し手段を優先。配布後は hash を照合する。

---

## 7. 会社PCで使ってよい機能 / 使わない機能

### Normal Mode で使う

- Scan（C: などの読み取り）
- TreeView（展開・キーボード操作・focus）
- Bookmarks（追加・削除・jump・cross-drive 表示）
- Review list（batch copy paths）
- Insights（フォルダ別の下部パネル）
- Show in Explorer / Show properties -- **使うかは会社ルール次第**（explorer 起動・shell verb。低リスクだが外部プロセス起動ではある）
- Copy path / Copy quoted path / Add / Remove bookmark

### 会社PC では使用しない（UI には存在するが使わない）

- Open terminal here（PowerShell 起動）
- Relaunch as administrator（昇格）
- Advanced Mode の有効化
- Move to Recycle Bin（Advanced Mode を ON にしないので表示されない）

### そもそも未実装（追加もしない）

- Delete / Cut / Rename / Paste

---

## 8. セキュリティ警告が出た場合の対応

- **警告を無視して続行しない。**
- **Defender / EDR / AppLocker / SmartScreen を無効化・例外強要しない。**
- ブロックされたら **会社PC dogfooding を中止する。**
- 必要なら Section 4 の説明（または security-overview.md）を提出し、**IT の許可を待つ。**
- **許可が出るまで使わない。** 何が・どの製品で・どう止まったかを記録し、次の判断材料にする。

---

## 9. 次アクション候補

- signing / packaging の具体化（証明書の選定・取得、bundle 設定の有効化検討）
- アプリ内 version 表示（dogfooding 時の版特定を容易に）
- `docs/security-overview.md` の継続整備（IT 提出用永久版として更新）
- 会社PC dogfooding build の作成（署名済み、または未署名ツール実行が会社PC環境で許容されていることが前提）
- **GitHub Release とは分けて考える**（Release は別スコープ。今回も行わない）

---

## 10. 結論

- **署名済み build が最も望ましい。** ただし、会社PC環境で未署名ローカルツールの実行実績がある場合は持ち込み候補にできる。
- **会社PCで使う最低条件:**
  1. 社内ルール上の実行許可（G1-G4）が取れていること
  2. **デフォルト Normal Mode で使うこと**（Advanced Mode は有効化しない, G5）
  3. G4 を満たすこと -- 未署名ツールの実行が会社PC環境で許容されている、または署名済み build / 社内の明示許可がある
- **使わない判断基準:** No-Go 条件（N1-N6）にひとつでも当たる、またはセキュリティ警告が出たら**中止**。
