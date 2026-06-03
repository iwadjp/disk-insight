# Context Menu Release Decisions (v0.5.12-F)

> Status: **判断確定（コード変更なし・docs のみ）**
> Created: 2026-06-04 / Reviewer: Opus 4.8
> 関連: [v0.5.7-context-menu-plan.md](v0.5.7-context-menu-plan.md) ·
> [context-menu-gap-log.md](context-menu-gap-log.md) ·
> [v0.5.11-bookmarks-plan.md](v0.5.11-bookmarks-plan.md)

---

## 0. このドキュメントの目的と結論

GitHub Release を前に、右クリックメニューで使う可能性がある操作
（Delete / Cut / FC delete / 7-Zip / Open with）について、
**実装する / しない / 後回し / Explorer handoff で十分** を確定する。

### 0.1 一言結論

> **Release 前に追加実装する右クリック項目は「なし」。現状の 7 項目のまま Release する。**
> 候補 5 件はいずれも「非採用」または「Release 後・dogfooding 次第」。
> 安全モデル（全破壊操作が `validate_recycle_target` を通り Recycle のみ／第三者コード非実行）を
> 1 ミリも崩さない、という v0.5.7 の二層構成（C 主軸 + B 逃げ道）をそのまま維持する。

### 0.2 候補のサマリ（詳細は §2 以降）

| 候補 | 判定 | 一言 |
|------|------|------|
| Delete（完全削除） | **非採用（恒久）** | 安全モデルと正面衝突。"Delete" という曖昧名も採らない。Recycle で足りる。 |
| Cut | **非採用（恒久寄り）** | move の起点。安全境界が崩れる。Explorer handoff で十分。 |
| FC delete | **保留（gap log 待ち）** | 仕様・用途が不明。環境依存コマンドの疑い。記録してから判断。 |
| 7-Zip | **Release 後 / dogfooding 次第** | 環境依存。Explorer handoff で十分。頻度が出たら 7z.exe の限定 verb を検討。 |
| Open with / 既定プログラム | **Release 後 / dogfooding 次第** | 単一ファイルの "Open" は価値あり。だが任意プログラム起動。慎重に。 |

---

## 1. 現在の確定メニュー（Release 候補そのまま）

v0.5.12-E 完了時点の `SafeContextMenu`（`ui/src/main.tsx`）の実物。
すべて既存の安全モデルに適合済みで、**この 7 項目は Release OK**。

| 項目 | 区分 | backend | 目的 | status | Release |
|------|------|---------|------|--------|---------|
| Show in Explorer | Safe | `open_in_explorer` / `select_in_explorer` | フォルダ=開く / ファイル=選択表示。危険操作の逃げ道（案B） | 実装済 | ✅ OK |
| Open terminal here | Safe | `open_terminal_at` | 対象（or 親）フォルダで PowerShell。非破壊・高利便 | 実装済 | ✅ OK |
| Show properties | Safe | `show_properties`（`SEE_MASK_INVOKEIDLIST`） | Windows プロパティダイアログ。単一 verb invoke の先例 | 実装済 | ✅ OK |
| Copy path | Safe | フロント `navigator.clipboard` | `C:\foo\bar.txt` をコピー | 実装済 | ✅ OK |
| Copy quoted path | Safe | フロント `navigator.clipboard` | `"C:\foo\bar.txt"` をコピー（v0.5.12-E で改名） | 実装済 | ✅ OK |
| Add / Remove bookmark | Safe | `add_bookmark` / `remove_bookmark` | 永続 bookmark のトグル（v0.5.11） | 実装済 | ✅ OK |
| Move to Recycle Bin | **Advanced** | `move_to_recycle_bin` + `validate_recycle_target` | Recycle Bin へ移動（取り消し可・ガード付き） | 実装済 | ✅ OK |

**この構成の良さ（Release してよい根拠）:**

- Safe 項目はすべて「閲覧・ナビ・クリップボード・検査・bookmark」＝**追跡不能な mutation を起こさない**。
- 唯一の破壊的項目（Recycle）は Advanced 限定 + Rust 検証 + 取り消し可 + recycled-badge で stale を可視化。
- 起動する外部プロセスは Explorer / PowerShell / プロパティダイアログという**OS 標準のみ**。
  任意の関連付けプログラムは起動しない。

---

## 2. 候補メニューごとの判断表

評価軸（各候補で共通）:

- **User value**: dogfooding でどれだけ価値があるか
- **Safety risk**: disk-insight の安全モデルへの脅威度
- **Impl difficulty**: 実装難度（unsafe/COM/環境検出の量）
- **Explorer handoff sufficiency**: Show in Explorer 経由で代替できるか
- **WizTree comparison**: WizTree が持つか／差別化要因か
- **Release judgment**: Release 前 / 後 / 非採用

| 候補 | User value | Safety risk | Impl difficulty | Explorer handoff で足りるか | WizTree 比較 | Release 判定 | Recommended decision |
|------|-----------|-------------|-----------------|------------------------------|--------------|--------------|----------------------|
| **Delete** | 中（掃除導線） | **致命的** | 低（API は簡単）だが危険 | ✅ 十分（Explorer で削除可） | WizTree は持つが完全削除寄り | **非採用** | 恒久的に非採用。Recycle で代替。"Delete" 名も使わない |
| **Cut** | 低〜中 | **高** | 中（CF_HDROP/clipboard 連携） | ✅ 十分（Explorer で cut→paste） | WizTree も限定的 | **非採用** | 恒久寄り非採用。move の起点は安全境界外 |
| **FC delete** | 不明 | 不明 | 不明 | 不明（用途未確認） | 該当なし | **保留** | gap log に用途・頻度を記録してから判断 |
| **7-Zip** | 中（圧縮/展開） | 中（外部 exe・引数組立） | 中〜高（パス検出・複数選択・verb） | ✅ ほぼ十分 | WizTree は持たない | **Release 後** | 非採用で Release。gap log で頻度確認 |
| **Open with / 既定プログラム** | 中〜高（ファイルを開く） | 中（任意プログラム起動） | 低〜中（ShellExecute "open"） | △（Explorer で開けるが 1 クッション） | WizTree は限定的 | **Release 後** | 非採用で Release。安全な単一 verb として将来検討余地 |

---

## 3. Delete の扱い

### 判定: **非採用（恒久的）**

**理由（安全モデルとの衝突）:**

- disk-insight の安全保証は「破壊的操作はすべて `validate_recycle_target` を通り、
  結果として **Recycle Bin 移動しか起こさない**」という一点に集約されている
  （v0.5.7-plan §0）。完全削除（`DeleteFile` / `RemoveDirectory`）は**実装が存在しない（意図的）**。
- "Delete" を追加すると、この保証を破る。Windows 的に "Delete" は曖昧で、以下が混在する:
  - 通常 Delete → 既定では Recycle（= 既存 Move to Recycle Bin と重複）
  - Shift+Delete / レジストリ `NoRecycleFiles` / ドライブ別「ごみ箱に入れない」 → **永久削除**
  - ごみ箱容量超過の大物 → **永久削除**
  - リムーバブル等 → そもそもごみ箱なし
- つまり "Delete" という名前を出すこと自体が、ユーザーに「完全削除できる」誤期待を与える。

### 名前についての判断

> **Release 前に "Delete" を追加するなら名前は "Move to Recycle Bin" に寄せるべきか？
> → そもそも追加しない。既存の "Move to Recycle Bin"（Advanced only）で十分。**

- "Move to Recycle Bin" という現行ラベルは「何が起きるか」を正確に表す誠実な名前。
- ここに "Delete" という別名・別項目を足すのは、混乱を増やすだけで価値がない。
- **結論: 既存 Advanced Mode の Recycle で十分。"Delete" は恒久的に非採用。**

---

## 4. Cut の扱い

### 判定: **非採用（恒久寄り）**

**理由:**

- Cut は本質的に **move 操作の起点**。CF_HDROP + `DROPEFFECT_MOVE` で clipboard に載せ、
  Explorer 側の paste で移動が完了する。
- 移動先は disk-insight が制御できない。system file や保護フォルダの中身が
  paste 先次第で動かされ得る → `validate_recycle_target` の depth/protected ガードを**素通り**する。
- stale view も追跡不能（移動が Explorer 側で完了するため）。
- disk-insight の安全モデル（破壊操作 = Recycle のみ・追跡可能）と**相性が悪い**。

### Explorer handoff で十分か

- ✅ **十分。** ファイル移動が必要なら "Show in Explorer" で Explorer を開き、
  Explorer の cut/paste を使えばよい。ユーザーは「アプリを出た」と明確に認識できる。
- **結論: Release 前は非採用。将来も安全モデルを変えない限り採らない。**

---

## 5. FC delete の扱い

### 判定: **保留（gap log 待ち）**

**前提整理:**

- "FC delete" はユーザー環境固有のコマンド／シェル拡張の可能性が高い。
  （`fc` = Windows の file compare コマンドだが、"FC delete" の正体は現時点で不明。
  特定のファイラ・拡張・ユーザー独自スクリプトの可能性がある。）
- **仕様・安全性・用途が不明なものは実装しない。** これは安全方針の基本。

### アクション

- [context-menu-gap-log.md](context-menu-gap-log.md) の dogfooding entries に
  「いつ・どんな対象で・なぜ FC delete が欲しかったか・頻度・代替可否」を記録する。
- 用途と頻度が判明し、かつ「安全に実装できる」「Explorer handoff では不十分」の
  3 条件（§9）を満たしたときに初めて curated 追加を検討する。
- **結論: Release 前は非採用（保留）。正体が分かるまで触らない。**

---

## 6. 7-Zip の扱い

### 判定: **Release 後 / dogfooding 次第**

**理由:**

- 7-Zip の右クリック項目は **shell extension（環境依存）**。
  disk-insight の curated menu では原理的に再現できない（案A 却下と同じ理由）。
- 自前で `7z.exe` を呼ぶ場合に必要なもの:
  - 7-Zip のインストールパス検出（レジストリ / 既定パス / PATH）
  - verb の選択（Extract here / Add to archive / Test ...）
  - 複数選択への対応（disk-insight は現状単一ターゲット選択）
  - 圧縮 vs 展開の引数仕様
  → MVP に対して**実装コストが高く、価値が頻度依存**。

### Explorer handoff で十分か

- ✅ **ほぼ十分。** "Show in Explorer" → Explorer の 7-Zip メニューを使う、で代替できる。
- **結論: Release 前は非採用。** gap log で「weekly 以上の頻度」が確認できたら、
  `7z.exe` の**限定 verb のみ**（例: extract here）を `open_terminal_at` と同じ流儀
  （パス検証 + プロセス spawn + unsafe 増やさない）で個別実装を検討する。

---

## 7. Open with / 既定プログラムの扱い

### 判定: **Release 後 / dogfooding 次第**

**検討:**

- 候補となる挙動:
  - `ShellExecute "open"`（既定プログラムで開く）
  - `ShellExecute "openas"`（"Open with" ダイアログを出す）
- **User value は候補中で最も高い**。「大容量ファイルを見つけた → その場で開いて中身確認 →
  消すか判断」という dogfooding 動線に直結する。WizTree にはない便利さになり得る。

**しかし慎重を要する理由:**

- "open" は**任意の関連付けプログラムを起動する**。これは現行の安全説明
  「disk-insight が起動するのは Explorer / Windows Terminal / PowerShell という
  OS 標準プロセスのみ」（v0.5.7-plan §11）を**広げる**ことを意味する。
- 起動するプログラムの挙動は disk-insight の制御外。マルウェア混入ファイル等の
  リスクをユーザーに押し付ける形になり得る。

### Explorer handoff で十分か

- △ **やや不十分。** ファイルを開くだけなら Explorer で select → ダブルクリック、だが 1 クッション増える。
  単一ファイルの "Open" は in-app で完結する価値がある。

### 将来の安全な実装方針（採るなら）

- `ShellExecute "open"` の**単一 verb invoke**（`show_properties` の先例と同じ作法）。
  メニュー全体を `QueryContextMenu` で晒す案A はやらない。
- ファイル限定（フォルダは既存 "Show in Explorer" で開く）。
- 「外部プログラムを起動する」ことが分かる文言にする。
- **結論: Release 前は非採用。** dogfooding で価値が確認できたら、
  ファイル限定の単一 "open" verb として優先的に再検討する（候補中の筆頭）。

---

## 8. Release 前の推奨結論（確定）

### 8.1 Release 前に追加実装する

- **なし。**

### 8.2 既存のまま Release 候補（= 現状の 7 項目）

- Show in Explorer
- Open terminal here
- Show properties
- Copy path
- Copy quoted path
- Add / Remove bookmark
- Move to Recycle Bin（Advanced Mode only）

### 8.3 Release 後 / dogfooding 次第

- **Open with / 既定プログラム**（候補中の筆頭。ファイル限定の単一 "open" verb として）
- **7-Zip**（limited verb、頻度が出たら）
- **FC delete**（正体・用途が判明したら）

### 8.4 非推奨（採らない）

- **Cut**（move の起点。安全境界外。Explorer handoff で十分）
- **Delete という曖昧名での追加**（完全削除は恒久非採用。Recycle で足りる）

---

## 9. context-menu-gap-log との関係

- 追加候補（Open with / 7-Zip / FC delete）は、
  [context-menu-gap-log.md](context-menu-gap-log.md) の dogfooding entries に
  **頻度・用途・代替可否**を記録する。
- curated 追加を検討する 3 条件（gap log の Decision rules を踏襲）:
  1. **頻度 weekly 以上**
  2. **安全に実装できる**（OS 標準プロセス spawn、または Rust 側で検証可能）
  3. **Explorer handoff では不十分**（Explorer 経由が明確に非効率）
- 上記を満たさないものは **Explorer handoff（Show in Explorer）に任せる**。
- 案A（本物の IContextMenu）の再検討トリガーは未充足のまま（gap log §Decision rules 参照）。

---

## 10. 次アクション

1. **本 docs を commit する**（コミットメッセージ: `Document context menu release decisions`）。
2. **実装はしない**（今回の v0.5.12-F はドキュメント判断のみ）。
3. 次に進むなら:
   - **v0.5.12-G**（別の Release 前 polish 項目があれば）、または
   - **dogfooding フェーズ**（実使用で gap log を埋め、Open with / 7-Zip / FC delete の
     頻度・用途を蓄積する）。
4. 右クリックメニュー候補は **gap log で継続判断**。Release 後の追加は
   §9 の 3 条件を満たしたものだけを、`open_terminal_at` と同じ個別検証の流儀で実装する。

---

## 11. 安全モデルとの整合チェック（self-review）

- [x] Delete / Cut / FC delete / 7-Zip / Open with の判断を明記した（§2〜§7）。
- [x] Release 前に追加実装すべきか = **なし** と明確化した（§8.1）。
- [x] 既存安全モデル（破壊操作 = Recycle のみ・第三者コード非実行・追跡可能）と矛盾しない。
  - 非採用（Delete/Cut）は安全モデルを守る判断。
  - 保留・後回し（FC delete/7-Zip/Open with）は安全に実装できると確認できるまで出さない。
- [x] コード変更なし（docs のみ）。
