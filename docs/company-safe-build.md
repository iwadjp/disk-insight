# Company-Safe Build Procedure

> **Historical note (v0.5.18-C):**
> The script/package name still says "company-safe" for continuity, but the
> in-app Company-safe checkbox was removed in v0.5.18-C.
> The packaged app starts in default Normal Mode.
> Advanced Mode remains explicit and session-only; do not enable it on a company PC.

会社PC dogfooding 候補 build を **自宅PC上で再現可能に作成し、
どの commit から作った exe か・hash は何か・debug 設定が混ざっていないかを確認する**手順。

- 前提資料: [`company-pc-dogfooding-checklist.md`](./company-pc-dogfooding-checklist.md)（Go/No-Go・実行手順）
  / [`v0.5.13-company-pc-dogfooding-plan.md`](./v0.5.13-company-pc-dogfooding-plan.md)（リスク・方針）
- **本書は自宅PC側の build 作業のみ。** 会社PCへの持ち込み・実行はこの docs の範囲外（チェックリスト Section 1-3 参照）。
- **未署名 build を持ち込む前に、会社PC環境で未署名ローカルツールの実行が許容されているかを確認すること。** 署名済み build が最も望ましい。

---

## 1. 目的と前提

| 項目 | 値 |
|------|---|
| 対象 artifact | `src-tauri\target\release\disk-insight-ui.exe`（bare exe） |
| bundle.active | `false`（現状は bare exe のみ。installer/MSI は未生成） |
| 安全モデル | Normal Mode（デフォルト） + Advanced Mode（明示 opt-in / 非永続） |
| Company-safe UI | **削除済み**（v0.5.18-C）|
| 署名 | **未署名**（証明書未取得。签名手順は Section 5 の placeholder 参照） |
| GitHub Release | **行わない** |
| タグ | **付けない** |

---

## 2. Build 前チェック

build を始める前に以下を確認する。問題があれば修正してから build する。

### 2-A. Debug flags（`ui/src/main.tsx`）

| 定数 | 期待値 | 理由 |
|------|:------:|------|
| `TREE_FOCUS_DEBUG` | `false` | debug FAB・focus ログを無効化。true のままだと debug UI が出る |
| `PERF_LOG` | `false` | `[perf]` console ログを抑制 |
| `PERF_TREE` | `false` | `[perf-tree]` console ログを抑制 |

`grep` で確認:
```powershell
Select-String -Path "ui\src\main.tsx" -Pattern "^const (PERF_LOG|PERF_TREE|TREE_FOCUS_DEBUG) ="
```

### 2-B. Git 状態

```powershell
git status --short     # clean であること
git log --oneline -3   # 期待するコミットが head にあること
git rev-parse --short HEAD  # hash を記録
```

### 2-C. 安全モデルの確認

以下を確認する:

- Company-safe mode チェックボックスが UI に存在しないこと（v0.5.18-C 以降）
- Advanced Mode チェックボックスが存在し、デフォルト OFF であること
- Advanced Mode OFF の状態で Move to Recycle Bin が表示されないこと

---

## 3. Build 手順

build script（Section 6 参照）を使うか、以下を手動で実行する。
**プロジェクトルート**（`disk-insight/`）で実行すること。

```powershell
# 1. git 状態・commit hash を記録
git status --short
$commitHash = git rev-parse --short HEAD
Write-Host "Commit: $commitHash"

# 2. debug flag を確認
Select-String -Path "ui\src\main.tsx" -Pattern "^const (PERF_LOG|PERF_TREE|TREE_FOCUS_DEBUG) ="

# 3. build
npm run build           # TypeScript --> Vite bundle
npm run tauri build     # Rust + bundle (bundle.active=false --> bare exe)

# 4. 成果物の確認
$exePath = "src-tauri\target\release\disk-insight-ui.exe"
if (Test-Path $exePath) {
    Write-Host "OK: $exePath"
} else {
    Write-Host "ERROR: exe not found"
}

# 5. SHA256 hash を記録
$hash = (Get-FileHash $exePath -Algorithm SHA256).Hash
Write-Host "SHA256: $hash"
Write-Host "Commit: $commitHash"
```

---

## 4. Build Artifact の記録

build が成功したら以下を手元に記録する（会社PCで照合するため）。

```
disk-insight-ui.exe
  Commit: <git rev-parse --short HEAD>
  Branch: next-phase
  Date  : <build 日時>
  SHA256: <Get-FileHash -Algorithm SHA256 の出力>
  Debug flags:
    TREE_FOCUS_DEBUG = false
    PERF_LOG         = false
    PERF_TREE        = false
  Signing: unsigned
  Bundle : bare exe (bundle.active=false)
  Safety model: Normal + Advanced (Company-safe UI removed in v0.5.18-C)
```

---

## 5. 署名（Placeholder -- 証明書取得後に実施）

> **証明書がない現在は署名を実施しない。** 以下は将来の reference。

```powershell
# 証明書が準備できた場合のみ実行 (placeholder)
# signtool sign /fd SHA256 /tr <timestamp-url> /td SHA256 /a `
#   src-tauri\target\release\disk-insight-ui.exe

# 署名後に再 hash を取得
# Get-FileHash src-tauri\target\release\disk-insight-ui.exe -Algorithm SHA256
```

**未署名の場合:**
- SmartScreen / AppLocker で警告が出ることがある
- **会社PC環境で未署名ローカルツールの実行が許容されており、セキュリティ警告なしに実行できる場合は dogfooding の候補にできる**
- 警告・ブロックが出たら中止する。セキュリティ製品を無効化・回避しない

---

## 6. Build Script と出力フォルダ

[`scripts/build-company-safe.ps1`](../scripts/build-company-safe.ps1) を使うと上記手順を自動化できる。

```powershell
# プロジェクトルートから実行（自宅PC のみ）
.\scripts\build-company-safe.ps1
```

script の内容: git 状態確認 → debug flag 確認 → build → hash 出力 → `dist-company-safe\` パッケージ生成。
署名・アップロード・会社PCへのコピーは行わない。

### 出力フォルダ: `dist-company-safe\`

script 実行後に以下のフォルダが生成される（**`.gitignore` 対象 -- git には入らない**）:

```
dist-company-safe\
  disk-insight-ui.exe     <- release exe（コピー）
  README-company-safe.txt <- 持ち込み前に読む短い説明
  BUILD-INFO.txt          <- SHA256 / commit / debug flags / unsigned 明記
  SECURITY-OVERVIEW.md    <- docs/security-overview.md のコピー
```

### 会社PCに持っていく前の確認

```
[ ] dist-company-safe\BUILD-INFO.txt の SHA256 と source exe の hash が一致している
[ ] BUILD-INFO.txt に TREE_FOCUS_DEBUG / PERF_LOG / PERF_TREE = false が記録されている
[ ] README-company-safe.txt を読んで方針を確認している
[ ] unsigned build である（SECURITY-OVERVIEW.md 参照）
[ ] 会社ルール上の実行可否を確認している（company-pc-dogfooding-checklist.md Section 1）
[ ] セキュリティ警告が出たら中止する方針を確認している
[ ] 会社PC では Advanced Mode を有効化しない方針を確認している
```

> **ExecutionPolicy について:**
> 自宅PCで script を実行する場合は `powershell -ExecutionPolicy RemoteSigned -File scripts\build-company-safe.ps1` を使う。
> `-ExecutionPolicy Bypass` は会社PCでの制限を回避するために使用しない。

---

## 7. zip 化する場合の注意

bare exe を zip に入れて会社PCに渡す場合:
- zip を展開すると **Mark-of-the-Web** が exe に付く → SmartScreen 警告が出やすくなる
- zip 経由より IT が許可する受け渡し手段を優先
- 渡した後は hash を照合する（Section 4 の記録と一致することを確認）

---

## 8. 会社PCでの実行

会社PCでの実行手順・Go/No-Go 判断は **[`company-pc-dogfooding-checklist.md`](./company-pc-dogfooding-checklist.md)** を参照。

本書（`company-safe-build.md`）の範囲は自宅PC上の build 作業まで。

---

## 9. 次フェーズ候補

- コード署名証明書の選定・取得（OV または EV Authenticode）
- `bundle.active` を有効化して installer/MSI 生成（Release 時）
- `tauri.conf.json` の `version` 更新とアプリ内 version 表示
- `docs/security-overview.md` の継続整備（IT 提出用永久版として更新）
- GitHub Release は上記が整ってから（このフェーズでは行わない）
