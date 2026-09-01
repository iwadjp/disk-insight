# AI-USAGE.md — disk-insight

> この文書は disk-insight における **AI 利用の補助運用ガイド**（クレジット節約・AI ツール
> 使い分け・引き継ぎ運用）です。
>
> - プロジェクト固有の設計・実装・安全ルールは `CLAUDE.md` が正。
> - この文書と `CLAUDE.md` が矛盾する場合は **`CLAUDE.md` を優先**する（特に Sonnet /
>   Opus の使い分けなど project 固有判断は `CLAUDE.md` の「AI 使い分け方針」に従う）。
> - ワークスペース共通ルールは `D:\iwa\AI\Claude\CLAUDE.md` を参照。

## クレジット消費の優先度

Claude Pro（Claude.ai）のクレジット消費が最大のボトルネック。
特にOpus 4.7は高コストのため節約必須。

## 役割分担

### 設計・判断（高コスト・限定使用）
| AI | 使用場面 |
|----|---------|
| Claude Opus 4.7 | クレジットに余裕がある時の重い設計・安全設計向け。アーキテクチャ判断、行き詰まり打開、方針転換の是非。フェーズ節目のみ |
| gpt-5.5 High / Extra high | 複雑な診断や設計判断に使う。NTFS等の複雑仕様調査、複数APIの正確な組み合わせ |

### 調査・検証（中コスト）
| AI | 使用場面 |
|----|---------|
| GPT-5.5 Instant | 設計が固まった後の実装方針確認、軽めの仕様調査 |
| Gemini Pro 拡張思考 | 大規模コードベース横断分析、長文仕様の一括解析 |
| Gemini Flash | 定型調査、ドキュメント参照 |

### 実装（低コスト・主力）
| AI | 使用場面 |
|----|---------|
| Claude Code (Sonnet 4.6) | 引き続き主実装。コンテキスト保持済みのため引き継ぎ不要 |
| Codex (GPT-5.5) | Claude Codeのクレジット節約が必要な場面。長時間・大量コード生成 |
| Antigravity CLI | 調査・軽作業・ドキュメント整理に使う |

### 無償活用
| AI | 使用場面 |
|----|---------|
| Grok (無償) | 軽い調査、情報収集 |
| Gemini Flash-Lite | 定型文書生成、軽いタスク |

## 運用フロー（クレジット節約版）

```
[設計節目・行き詰まり]
  → Opus 4.7 または GPT-5.5 Thinking で方針確定
      ↓
[仕様調査]
  → GPT-5.5 Thinking または Gemini Pro 拡張で仕様取得
      ↓
[指示文作成]
  → ChatGPT (GPT-5.5 Instant) が Claude Code 用指示文を作成
  ※ Claude.ai (Sonnet) の代替として使用可能
      ↓
[実装]
  → Claude Code (Sonnet 4.6) が実装・ビルド・計測
  ※ クレジット逼迫時は Codex に切り替え
      ↓
[判断]
  → 計測結果を見てフェーズ継続/中止を Opus 4.7 で判断
```

## ChatGPTへの引き継ぎ時の注意事項
- PROGRESS.md の内容を必ず渡す
- 現在の src/mft_probe.rs の内容を渡す
- 「Claude Code (Sonnet 4.6) への指示文形式」で出力を依頼する
- ビルドエラーは Claude Code に自律修正させる
- 設計判断が必要な場面は Opus 4.7 に差し戻す

## Codex使用時の注意事項
- /codex:rescue はClaude・Codex両方のトークンを消費する
- 単純なファイル編集はClaude Codeに直接依頼する方が速い
- /codex:rescue の節約効果は長時間・大量コード生成タスクで出る
- /codex:review は読み取り専用で比較的軽量
