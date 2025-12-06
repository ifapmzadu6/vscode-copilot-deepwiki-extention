# DeepWiki Generator - アーキテクチャ再設計書 (v2: Markdown-Centric)

## 原則

1. **中間ファイルをどんどん生成** - 各フェーズの結果を保存し、再利用可能に
2. **Text for Intelligence** - 思考・分析フェーズではJSONではなくMarkdownを使用
3. **LLM Loop** - 生成→レビュー→改善のループを回す

---

## 新アーキテクチャ概要

### パイプライン構造（7レベル）

| 階層 | 名前 | 役割 | 主な入出力形式 |
|------|------|------|----------------|
| L1 | **DISCOVERY** | ファイル・環境発見 | 🟠 JSON |
| L2 | **CODE_EXTRACTION** | コード構造抽出 | 🟢 **Text (Grep)** |
| L3 | **DEEP_ANALYSIS** | 詳細分析・洞察 | 🟢 **Markdown** (思考の記述) |
| L4 | **RELATIONSHIP** | 依存関係グラフ構築 | 🟠 JSON (グラフデータ) |
| L5 | **DOCUMENTATION** | ドキュメント執筆 | 🟢 **Markdown** |
| L6 | **QUALITY_REVIEW** | 品質レビュー | 🟢 **Markdown** (レビューレポート) |
| L7 | **OUTPUT** | 最終出力調整 | 🟢 **Markdown** |

---

## Level 1: DISCOVERY（発見フェーズ）
*変更なし* - 機械的なスキャンのためJSONが最適。
- `discovery/files.json`
- `discovery/frameworks.json`

---

## Level 2: CODE_EXTRACTION（コード抽出フェーズ） 🔄 **Modified**
後続のグラフ構築のために厳密な構造化データが必要だが、LLM出力段階では **Grep-Friendly Text** を採用する。

### 出力ファイル
- `extraction/all_entities_dump.txt` (人間の確認用)
- `extraction/extraction-summary.json` (後続エージェントの処理用、内部パース後に生成)

### Grep-Friendly Format
```text
TYPE: Class | NAME: PipelineOrchestrator | LINE: 1-100 | VISIBILITY: public
TYPE: Method | NAME: execute | LINE: 20-50 | VISIBILITY: public | ARGS: context, mode
```

この形式を採用することで、JSONの構文エラー（カンマ忘れなど）によるデータロスを完全に防ぐ。内部でこれをパースして `ExtractionResult` オブジェクトに変換する。

---

## Level 3: DEEP_ANALYSIS（深層分析フェーズ） 🔄 **Modified**

### 目的
LLMを使って各コードエンティティの実装詳細を分析する。
**JSONではなく構造化Markdownを出力する**ことで、LLMの表現力を最大化する。

### 出力ファイルの変更
- 旧: `analysis/classes/MyClass.json`
- 新: `analysis/classes/MyClass.md`

### プロンプトと出力イメージ

**プロンプト**:
```text
Analyze the class `PipelineOrchestrator`.
Output format: Markdown with standardized headers.

Requirements:
- Explain the purpose clearly
- List design patterns with reasoning
- Analyze key methods complexity
```

**出力ファイル (`analysis/classes/PipelineOrchestrator.md`)**:
```markdown
# Analysis: PipelineOrchestrator

## 🎯 Purpose
Orchestrates the multi-level documentation generation pipeline via parallel execution...

## 🧩 Design Patterns
- **Pipeline Pattern**: Used to separate processing stages...
- **Strategy Pattern**: Subagents act as pluggable strategies...

## 🔑 Key Methods

### `execute()`
- **Complexity**: O(N) where N is levels
- **Logic**: Iterates through defined level order...

### `executeLevel()`
- **Complexity**: O(M) where M is subagents
- **Logic**: Uses `ParallelExecutor`...
```

**メリット**:
- JSONのエスケープ地獄から解放される
- コードスニペットを自然に含められる
- 人間が読んで理解しやすい

---

## Level 4: RELATIONSHIP（関係構築フェーズ）
*変更なし* - グラフ理論に基づくデータ構造のためJSONが最適。
- `relationships/dependency-graph.json`

---

## Level 5: DOCUMENTATION（ドキュメント生成フェーズ）

### 変更点
入力として、JSONではなく **Level 3 で生成された Markdown ファイル** を読み込む。

**処理フロー**:
1. `DeepWikiPageGenerator` が `analysis/classes/*.md` を読み込む（テキストとして）
2. これらを **"Source Knowledge"** としてプロンプトに埋め込む
3. 最終的なドキュメントページ (`docs/pages/4.1-pipeline.md`) を生成する

プロンプト例:
```text
Write the documentation for the Pipeline module.

Reference Materials:
[Content of analysis/classes/PipelineOrchestrator.md]
[Content of relationships/dependency-graph.json (summary)]

Task:
Synthesize this information into a user-friendly documentation page.
```

---

## Level 6: QUALITY_REVIEW（品質レビューフェーズ） 🔄 **Modified**

### 目的
生成されたドキュメントをレビューする。
レビュー結果も **Markdownレポート** として出力する。

### 出力ファイル
- `review/pages/4.1-pipeline.review.md`

### 内容例
```markdown
# Review Report: Pipeline Module

## ✅ Score: 85/100

## 🔴 Critical Issues
- None

## 🟡 Suggestions
1. **Add Example**: The `execute` method usage is unclear. Add a code snippet.
2. **Clarify Diagram**: The mermaid diagram is missing the error handling flow.

## 🟢 Good Points
- Clear architecture explanation.
- Accurate API references.
```

これにより、次の改善ループで「このレポートを読んで修正せよ」という指示が容易になる。

---

## Level 7: OUTPUT（出力フェーズ）
中間生成されたMarkdownを整理し、目次 (`_meta.json`) を生成して最終出力とする。

---

## 中間ファイル構造 (v2)

```
.deepwiki/
├── intermediate/
│   ├── discovery/              # [JSON]
│   │   └── files.json
│   ├── extraction/             # [TEXT + JSON] 🟢 Changed
│   │   ├── all_entities_dump.txt
│   │   └── extraction-summary.json
│   ├── analysis/               # [MARKDOWN] 🟢 Changed
│   │   ├── classes/
│   │   │   └── PipelineOrchestrator.md
│   │   └── modules/
│   │       └── pipeline.md
│   ├── relationships/          # [JSON]
│   │   └── dependency-graph.json
│   ├── docs/                   # [MARKDOWN]
│   │   └── pages/
│   │       └── 4.1-pipeline.draft.md
│   └── review/                 # [MARKDOWN] 🟢 Changed
│       └── pages/
│           └── 4.1-pipeline.review.md
├── pages/                      # [MARKDOWN] (Final)
└── deepwiki.json
```
