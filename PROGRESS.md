# disk-insight/PROGRESS.md

## 2026-05-23 B-4 $ATTRIBUTE_LIST 観測結果

### 実行結果

* records with $ATTR_LIST all: 41,436
* records with $ATTR_LIST in-use: 26,240
* records with $ATTR_LIST deleted: 15,196
* $ATTR_LIST + fn_size fallback in-use: 24,161
* $ATTR_LIST + size==0 in-use: 7,821

### 分析

* fn_size fallback in-use は 369,679 件
* そのうち $ATTRIBUTE_LIST 由来は 24,161 件
* 割合は約6.5%
* よって、fn_size fallback 大量発生の主因は $ATTRIBUTE_LIST 未対応ではない
* $ATTRIBUTE_LIST 対応は将来課題だが、現時点で最優先ではない

### 判断

* B-4 のMFT再構成・fixup・属性走査・サイズ取得は成立
* 次は Windows / WizTree のCドライブ使用量と disk-insight の in-use 146GB を比較する
* 差が小さければ B-4 完了扱い
* 差が大きければ、無名 $DATA 判定、圧縮/スパース、ハードリンク、多重 $FILE_NAME を次に調査する
