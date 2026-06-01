# disk-insight v0.5.1 Advanced Mode MVP: Move to Recycle Bin 設計計画

> Status: **設計確定（実装前）** — このドキュメントは v0.5.1 実装の基準とする。
> このドキュメント時点でソースコード（UI / Rust / TypeScript）の変更は一切行っていない。
> 今後 Claude Code / Codex / 他 AI に実装を依頼する際は、本ドキュメントをスコープと
> 安全方針の真実の源（source of truth）とする。

---

## 0. 前提（既存実装の調査結果）

設計に直結する、現行コードベースの確認済み事実：

- **右クリックメニューは `SafeContextMenu`（`ui/src/main.tsx`）に集約済み。**
  TreeView / DirectChildren / DirectoriesTable / FilesTable / SubtreeSearchPanel が
  すべてこの共有コンポーネントを使う。→ メニュー項目を 1 箇所追加すれば全サーフェスに
  反映される。
- **COM STA の前例がある。** `show_properties`（`src-tauri/src/main.rs`）が
  `CoInitializeEx(COINIT_APARTMENTTHREADED)` + `ShellExecuteExW` を使用済み。
  IFileOperation も同じ COM 流儀で書ける。
- **Cargo features は充足。** `src-tauri/Cargo.toml` に `Win32_UI_Shell` /
  `Win32_System_Com` / `Win32_UI_WindowsAndMessaging` / `Win32_Storage_FileSystem` が
  有効。IFileOperation / IShellItem / SHCreateItemFromParsingName はほぼ追加 feature
  なしで届く見込み（実装時に `Win32_UI_Shell_Common` など個別追加の可能性のみ）。
- **`Refresh after cleanup` ボタン + `get_drive_capacity_now`（軽量な
  `GetDiskFreeSpaceEx` 相当）+ `CleanupRefreshDelta` 表示が既にある。**
- **モーダルダイアログ基盤はまだ無い。** エラーは inline banner、メニューは
  `createPortal`。確認モーダル / 警告モーダルは新規に作る必要がある。
- disk-insight は v0.5.0 まで「削除なし（safe viewer）」を明示的な安全方針として
  貫いてきた。v0.5.1 は初めてこの方針に破壊的操作に近い機能を加える節目となる。

---

## 1. 目的

- disk-insight を単なる disk viewer から、**TreeView-first cleanup assistant** に
  一歩近づける。
- **Safe Mode を既定として維持**しつつ、ユーザーが明示的に ON にした
  **Advanced Mode のときだけ** Recycle Bin 操作を許可する。
- **完全削除ではなく、Windows Recycle Bin への移動のみ**を対象とする。
- 以下は今回の対象外：
  - 完全削除（DeleteFile / RemoveDirectory）
  - Rename
  - Move
  - Cut / Paste
  - 本物の IContextMenu（シェル拡張メニュー）本実装

### WizTree 常用理由との対応

ユーザーが WizTree を常用する理由と、v0.5.1 での到達度：

| WizTree の強み | disk-insight 現状 | v0.5.1 で前進するか |
|----------------|------------------|---------------------|
| 1. 圧倒的に速い | MFT スキャンで対応済み | 据え置き |
| 2. 大容量フォルダ/ファイルを見つけやすい | TreeView / Top dirs / Top files で対応済み | 据え置き |
| 3. TreeView から不要物を削除できる | **未対応（中核 gap）** | **Move to Recycle Bin で前進** |
| 4. 削除後に容量がすぐ更新される | Refresh after cleanup（手動）あり | recycle の特性上、§8 の方針で扱う |

---

## 2. 採用方針（B 案）

設計調査の結果、**B 案**（Advanced toggle + Move to Recycle Bin + 確認モーダル +
成功 banner で Refresh 誘導）を採用する。

### 採用するもの

- **B 案**
- Advanced Mode toggle
- Move to Recycle Bin
- `createPortal` による確認モーダル（新規）
- **Rust 側 blocklist を真実の源（source of truth）にする**
- **IFileOperation** を使う
- `FOF_ALLOWUNDO` / `FOFX_RECYCLEONDELETE` を使う
- 成功 banner で `Refresh after cleanup` を促す

### 採用しないもの

- 自動 full rescan
- recycle 成功時の drive free-space delta 表示
- 完全削除（DeleteFile / RemoveDirectory）
- Rename
- Move
- Cut / Paste
- 本物の IContextMenu 本実装
- Empty Recycle Bin
- 複数選択
- 楽観的行除去（optimistic row removal）

---

## 3. Recycle Bin 実装方式

### 方式比較

| 方式 | Win10 安定性 | ファイル/フォルダ | エラー処理 | 判定 |
|------|-------------|------------------|-----------|------|
| **IFileOperation**（COM, Vista+） | ◎ Explorer 自身の機構 | ◎ 両対応（IShellItem） | ◎ HRESULT + `GetAnyOperationsAborted` | **採用** |
| SHFileOperation + `FOF_ALLOWUNDO`（legacy） | ○ 動くが MS 非推奨 | ○ 両対応 | △ DE_* 旧エラーコード、相対パスで完全削除の罠 | 不採用 |
| PowerShell handoff | △ | ○ | × プロセス起動・引用符注入・エラー解析困難 | 不採用 |
| DeleteFile / RemoveDirectory | — | — | — | **禁止（完全削除）** |

### 結論

- **IFileOperation を採用する。**
  - Microsoft が Vista+ で推奨する公式方式であり、Explorer 自身が使うシェル機構。
  - シェル変更通知が飛ぶため、開いている Explorer / ごみ箱表示も自動更新される。
  - `IShellItem` 経由でファイル・フォルダの両方を統一的に扱える。
  - 既存 `show_properties` と同じ COM STA パターンで書けるため、コードベースと一貫。
- **SHFileOperation は legacy のため避ける。** 相対パス指定で完全削除になる罠、
  double-null-terminated 文字列、旧 DE_* エラーコードなど扱いづらい。
- **PowerShell handoff は避ける。** プロセス起動コスト、引用符 / インジェクションリスク、
  エラーハンドリング困難。
- **DeleteFile / RemoveDirectory は禁止。** 完全削除であり、本 MVP のスコープ外。

### 実装方針（疑似コード）

```text
CoInitializeEx(None, COINIT_APARTMENTTHREADED)   // STA
  → CoCreateInstance(FileOperation CLSID) → IFileOperation
  → SetOperationFlags(FOF_ALLOWUNDO | FOFX_RECYCLEONDELETE | FOFX_EARLYFAILURE)
  → SHCreateItemFromParsingName(path) → IShellItem
  → op.DeleteItem(item, None)        // sink は None（単一項目 MVP のため省略可）
  → op.PerformOperations()
  → aborted = op.GetAnyOperationsAborted()
CoUninitialize()
```

- **`FOF_ALLOWUNDO`** が「ごみ箱へ送る」本体。完全削除には決してならない。
- **`FOFX_RECYCLEONDELETE`**（Win8+）で「通常はバイパスされる項目も強制的にごみ箱へ」。
- **`FOFX_EARLYFAILURE`** でシェル独自のリトライ UI を抑制し、HRESULT で早期に失敗を返す。
- 進捗 sink（`IFileOperationProgressSink`）は単一項目 MVP では **None で省略**。
- COM の初期化結果（`S_FALSE` = STA 既に有効、`RPC_E_CHANGED_MODE` = MTA 有効）は
  `show_properties` と同じく「init 成功扱い」で処理する。

### COM STA の前例

`src-tauri/src/main.rs` の `show_properties` が既に
`CoInitializeEx(COINIT_APARTMENTTHREADED)` → `ShellExecuteExW`（`SEE_MASK_INVOKEIDLIST`）
→ `CoUninitialize` のパターンを実装済み。recycle コマンドも同じ初期化・後始末の
作法に従う。

### エラーハンドリング

- Rust コマンドは `Result<RecycleResult, String>` を返す。
- `classify_scan_error` と同様、ローカライズされた OS エラー文字列を整形する
  ヘルパを用意し、`access is denied` / `file in use (locked)` 等を
  ユーザー可読メッセージに変換する。
- locked file（使用中）は HRESULT で失敗を返すので UI でメッセージ表示。

---

## 4. Advanced Mode 仕様

| 項目 | 確定仕様 |
|------|----------|
| デフォルト | **OFF** |
| 起動時 | **アプリ起動ごとに必ず OFF** |
| 永続化 | **localStorage / preferences に保存しない**（`PREF_KEY` に追加しない） |
| ON 操作 | 警告モーダルを表示し、明示同意で ON |
| ON の要件 | **"I understand" チェックボックス必須** |
| ON 中表示 | 画面上部または toolbar / status area に **赤系の Advanced Mode badge / banner を常時表示** |
| Safe Mode 時 | Move to Recycle Bin を**メニューに出さない（非表示）** |
| 非表示の方式 | **disabled 表示ではなく非表示**にする |

### 非永続の理由

破壊的能力は**セッション毎オプトイン**が安全。`localStorage`
（`PREF_KEY = disk-insight.preferences.v1`）には drive / top / policy / sort を
保存しているが、**`advancedMode` はここに入れない**。次回起動が「いつのまにか
削除可能」になる事故を防ぎ、これまでの保守的方針とも一致する。state 初期値 false の
ままにするだけなので実装コストもほぼゼロ。

### 文言例

**Advanced Mode warning modal:**

```text
Advanced Mode enables moving files and folders to the Recycle Bin.
This operation is not permanent deletion, but it can still disrupt your system if used on important folders.
Protected system locations are blocked.
Use this mode carefully.
```

**Checkbox:**

```text
I understand and want to enable Advanced Mode for this session.
```

---

## 5. Move to Recycle Bin UI

`SafeContextMenu` に項目を追加する形で設計する。

### Safe Mode（既定）

- Move to Recycle Bin は**非表示**。

### Advanced Mode ON

- Move to Recycle Bin を**表示**。
- 既存の非破壊操作（Open / Select in Explorer / Show properties / Copy path /
  Copy as path）とは **separator（区切り線）で分離**。
- **赤系 / destructive style**。
- 文言は **"Move to Recycle Bin"**（"Delete" は使わない）。
- TreeView / DirectChildren / TopDirs / TopFiles / Search results の**全サーフェスで共通**。

### 共有コンポーネントの利点

`SafeContextMenu` は上記 5 サーフェスすべてが使う共有コンポーネントであるため、
**1 箇所にメニュー項目を追加するだけで全サーフェスに反映される**。
`advancedMode: boolean`（または `onMoveToRecycleBin?: (target) => void`）を prop で
渡し、ON のときだけ項目をレンダリングする。blocklist 該当パス（§7）の場合は
項目を disable + 理由 tooltip（"Protected system location"）にする。

---

## 6. 確認モーダル仕様

Move to Recycle Bin 実行前に**必ず**確認モーダルを表示する。
モーダル基盤が無いため `createPortal` で新規作成（`SafeContextMenu` と同パターン）。

### 表示内容

- **種別**: File / Folder
- **名前**
- **フルパス**（monospace、`.heading-path` で `\` 表示対策）
- **サイズ**
- フォルダの場合は、可能なら **child count / subtree size**
- **本文**:

  ```text
  This will move the item to the Recycle Bin.
  It will not be permanently deleted and can be restored from the Recycle Bin.
  Items in the Recycle Bin still occupy disk space until the bin is emptied.
  ```

### ボタン

- **Move to Recycle Bin**（destructive style）
- **Cancel**

### 大きいフォルダの場合

- **"I understand" チェックボックスを必須にする案**を記載しておく。
  - 例: `subtree_size` が閾値超、または `child_count` が大きい場合に有効化要件にする。
- ただし **MVP では必須化するかどうかは実装時判断でもよい**。最低限、subtree size と
  child count を明示し、強めの警告文言を表示する。

---

## 7. Safety blocklist

**Rust 側を真実の源（source of truth）にする。フロント側チェックは UX 用の補助にすぎない。**
実際に破壊的操作を行うのは Rust コマンドなので、Rust 側で必ず再検証して拒否する
（多層防御）。

### ブロック対象（recycle 拒否）

- drive root（`C:\` 等、`path.len() <= 3`）
- `C:\Windows`（配下含む）
- `C:\Program Files`（配下含む）
- `C:\Program Files (x86)`（配下含む）
- `C:\ProgramData`（配下含む）
- `C:\$Recycle.Bin`（配下含む）
- `C:\System Volume Information`（配下含む）
- `C:\Users` 直下
- current user profile root（`%USERPROFILE%` のルート）
- other user profile root（他ユーザープロファイルのルート）
- SYSTEM 属性ファイル / フォルダ（`FILE_ATTRIBUTE_SYSTEM`）
- depth < 2 の、ルートに近すぎるパス

### hidden / readonly

- **ブロックではなく強警告扱い**にする（操作自体は許可するが、確認モーダルで
  強めの注意を表示）。

### 実装上の注意

- path は**絶対化・正規化**する。
- **大文字小文字を無視**して比較する。
- **末尾区切りを正規化**する（`C:\Windows` と `C:\Windows\` を同一視）。
- well-known パスは**文字列ハードコードせず**、可能な限り `SHGetKnownFolderPath` /
  環境変数（`%SystemRoot%` / `%ProgramFiles%` / `%ProgramFiles(x86)%` /
  `%ProgramData%` / `%SystemDrive%` / `%USERPROFILE%`）で解決し、非 C: インストールにも
  堅牢にする。
- **Rust 側で必ず再検証する**（フロントのチェックは信頼しない）。

### 管理者権限時の注意

disk-insight は MFT スキャンのため通常昇格起動される。昇格中は権限による自然な
ガードが消え、`C:\Windows` 配下なども操作可能になってしまう。**だからこそ
アプリ側 blocklist が必須**であり、blocklist が破られると事故が即実行になる。

---

## 8. ごみ箱と free-space delta の扱い

### ⚠ 重要

**Move to Recycle Bin しても、ドライブ空き容量は基本的にすぐ増えない。**
ファイルは `$Recycle.Bin` に移動するだけで、**Recycle Bin を空にするまで disk space を
占有し続ける**。これは完全削除との決定的な違いであり、free-space delta を成功指標に
すると誤解を招く（recycle 直後の delta はほぼ 0）。

### したがって

- recycle 成功時に **drive free-space delta を成功指標として表示しない**。
- **"Freed X GB" のような表現は禁止。**
- 成功時は **"Moved to Recycle Bin"** と表示する。
- 空き容量の回復は **Recycle Bin を空にした後**であることを明記する。

### 成功バナー文言例

```text
Moved to Recycle Bin: 2.3 GB.
Disk space will be reclaimed after you empty the Recycle Bin.
Refresh after cleanup when you are ready to update disk-insight.
```

### Empty Recycle Bin

- **今回スコープ外。**
- OS / Explorer 側に委ねる（ユーザーが自分でごみ箱を空にする）。

---

## 9. 削除後 refresh 方針

### 採用

- **成功 banner で `Refresh after cleanup` を促す。**
- **自動 full rescan はしない。**
- **recycle 直後の free-space delta は出さない。**

### 不採用

- 自動 full rescan
- 楽観的行除去（optimistic row removal）
- ArenaCache partial refresh

### 理由

- recycle 直後は free-space が増えないため、delta は誤解を招く（§8）。
- 自動 full rescan は重い（MFT スキャンは 5〜11 秒）。1 件ごとに走らせると、
  WizTree 的な「複数消してからまとめて更新」ワークフローを壊す。
- 楽観的行除去は TreeView / TopFiles / DirectChildren / Search results 間の
  UI state 不整合を起こす可能性がある（同一項目が複数サーフェスに出る）。
- partial refresh（ArenaCache の部分更新）は v0.5.1 MVP には重すぎる。

---

## 10. MVP スコープ

### v0.5.1 で入れるもの

- Advanced Mode toggle
- Advanced Mode warning modal
- Move to Recycle Bin menu item
- Move confirmation modal
- IFileOperation based recycle command（Rust）
- Rust blocklist
- success banner
- Refresh after cleanup guidance

### v0.5.1 で入れないもの

- 完全削除
- Rename
- Move
- Cut / Paste
- IContextMenu（本物のシェル拡張メニュー）
- Empty Recycle Bin
- 複数選択
- optimistic row removal
- auto rescan
- recycle 後の free-space delta

---

## 11. 実装分割案

実装は一括で行わず、次の段階に分ける。各段階で破壊的操作を入れる前に
安全側から積み上げる。

| 段階 | 内容 |
|------|------|
| **A** | docs 作成のみ（＝本ドキュメント） |
| **B** | Advanced Mode toggle + warning banner / modal |
| **C** | Rust blocklist + recycle command skeleton |
| **D** | Move to Recycle Bin confirmation modal |
| **E** | SafeContextMenu wiring（メニュー項目の配線） |
| **F** | success banner + Refresh after cleanup guidance |

### 各段階での検証

```powershell
npm run build
cargo check --manifest-path src-tauri\Cargo.toml -q
npm run tauri build
# release exe を実機確認
```

- 特に C / E / F は破壊的操作に関わるため、実機での recycle 動作・blocklist 拒否・
  確認モーダルのキャンセル動作を必ず確認する。

---

## 12. Release 前に決めるべきこと（未決事項）

以下は v0.5.1 release 前に方針を確定する：

- Advanced Mode を今後も**非永続**にするか（現方針は非永続）。
- Delete（完全削除）/ Rename / Move を将来入れるか。
- 本物の IContextMenu 本実装を入れるか。
- Empty Recycle Bin を入れるか。
- 複数選択を入れるか。
- optimistic row removal を入れるか。
- blocklist の最終範囲（特に user profile root の扱い、depth 閾値、
  hidden / readonly の警告レベル）。

---

## 13. 参考: 関連する既存実装ファイル

実装時に参照する主なファイル：

- `src-tauri/src/main.rs`
  - `show_properties`（COM STA の前例）
  - `get_drive_capacity_now` / `read_drive_capacity_now`（free-space 取得）
  - `classify_scan_error`（OS エラー整形の前例）
  - `invoke_handler!` への新コマンド登録箇所
- `src-tauri/Cargo.toml`（windows features）
- `ui/src/main.tsx`
  - `SafeContextMenu`（共有右クリックメニュー）
  - `ContextMenuTarget` 型
  - `handleRefreshAfterCleanup` / `CleanupRefreshDelta`（refresh / delta の前例）
  - `PREF_KEY` / `loadPreferences` / `savePreferences`（永続化しない判断の対象）
- `docs/ui-plan.md`（フェーズ履歴・スコープ guard の記法）
