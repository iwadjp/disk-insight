# Company-Safe Build Procedure (v0.5.13-D)

会社PC dogfooding 候補 build を **自宅PC上で再現可能に作成し、
どの commit から作った exe か・hash は何か・debug 設定が混ざっていないかを確認する**手順。

- 前提資料: [`company-pc-dogfooding-checklist.md`](./company-pc-dogfooding-checklist.md)（Go/No-Go・実行手順）
  / [`v0.5.13-company-pc-dogfooding-plan.md`](./v0.5.13-company-pc-dogfooding-plan.md)（リスク・方針）
- **本書は自宅PC側の build 作業のみ。** 会社PCへの持ち込み・実行はこの docs の範囲外（チェックリスト §1〜§3 参照）。
- **署名なしの build を会社PCに持ち込まない。** 署名済み build または社内の明示的許可が前提。

---

## 1. 目的と前提

| 項目 | 値 |
|------|---|
| 対象 artifact | `src-tauri\target\release\disk-insight-ui.exe`（bare exe） |
| bundle.active | `false`（現状は bare exe のみ。installer/MSI は未生成） |
| Company-safe mode | **実装済み**（commit `84a33ac`）。ON で terminal/recycle/admin 起動を封印 |
| 署名 | **未署名**（証明書未取得。签名手順は §5 の placeholder 参照） |
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

> v0.5.13-D 時点: 全フラグ `false` を確認済み。

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

### 2-C. Company-safe mode が実装されているか

commit `84a33ac`（Add company-safe mode）以降のブランチであることを確認:
```powershell
git log --oneline | Select-String "company-safe"
```

---

## 3. Build 手順

build script（§6 参照）を使うか、以下を手動で実行する。
**プロジェクトルート**（`disk-insight/`）で実行すること。

```powershell
# 1. git 状態・commit hash を記録
git status --short
$commitHash = git rev-parse --short HEAD
Write-Host "Commit: $commitHash"

# 2. debug flag を確認
Select-String -Path "ui\src\main.tsx" -Pattern "^const (PERF_LOG|PERF_TREE|TREE_FOCUS_DEBUG) ="

# 3. build
npm run build           # TypeScript → Vite bundle
npm run tauri build     # Rust + bundle (bundle.active=false → bare exe のみ)

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
  Signing: unsigned (未署名)
  Bundle : bare exe (bundle.active=false)
  Company-safe mode: implemented (commit 84a33ac)
```

---

## 5. 署名（Placeholder — 証明書取得後に実施）

> **証明書がない現在は署名を実施しない。** 以下は将来の reference。

```powershell
# 証明書が準備できた場合のみ実行 (placeholder)
# signtool sign /fd SHA256 /tr <timestamp-url> /td SHA256 /a `
#   src-tauri\target\release\disk-insight-ui.exe

# 署名後に再 hash を取得
# Get-FileHash src-tauri\target\release\disk-insight-ui.exe -Algorithm SHA256
```

**未署名の場合:**
- SmartScreen / AppLocker で警告・ブロックされやすい
- **社内の明示的許可が取れていない場合は会社PCに持ち込まない**
- 許可が取れるまでは自宅PC dogfooding に留める

---

## 6. Build Script

[`scripts/build-company-safe.ps1`](../scripts/build-company-safe.ps1) を使うと上記手順を自動化できる。

```powershell
# プロジェクトルートから実行
.\scripts\build-company-safe.ps1
```

script の内容: git 状態確認 → debug flag 確認 → build → hash 出力。署名・アップロード・コピーは行わない。

---

## 7. zip 化する場合の注意

bare exe を zip に入れて会社PCに渡す場合:
- zip を展開すると **Mark-of-the-Web** が exe に付く → SmartScreen 警告が出やすくなる
- zip 経由より IT が許可する受け渡し手段を優先
- 渡した後は hash を照合する（§4 の記録と一致することを確認）

---

## 8. 会社PCでの実行

会社PCでの実行手順・Go/No-Go 判断は **[`company-pc-dogfooding-checklist.md`](./company-pc-dogfooding-checklist.md)** を参照。

本書（`company-safe-build.md`）の範囲は自宅PC上の build 作業まで。

---

## 9. 次フェーズ（v0.5.13-E 以降）

- コード署名証明書の選定・取得（OV または EV Authenticode）
- `bundle.active` を有効化して installer/MSI 生成（Release 時）
- `tauri.conf.json` の `version` 更新とアプリ内 version 表示
- `docs/security-overview.md` の整備（IT 提出用永久版）
- Company-safe mode の永続化（localStorage、必要性を判断してから）
- GitHub Release は上記が整ってから（このフェーズでは行わない）
