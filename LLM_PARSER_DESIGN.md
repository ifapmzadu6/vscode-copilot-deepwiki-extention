# LLMベースのユニバーサルパーサー設計書

## 💡 コンセプト

**「構造抽出はJSONで厳密に、意味理解はMarkdownで豊かに」**

Level 2 (CODE_EXTRACTION) では、後段のグラフ構築プロセスのために**計算可能な構造化データ**が必要です。そのため、このフェーズでは引き続き **JSON** を採用します。ただし、JSON生成の堅牢性を高めるための対策を導入します。

---

## 🏗️ アーキテクチャ

### Level 2: CODE_EXTRACTION (JSON)

このフェーズの役割は「コードをデータに変換すること」です。

- **入力**: ソースコード
- **処理**: LLMによる構造解析
- **出力**: `extraction/classes.json` 等
- **形式**: **Line-Based Text (Grep-Format)**

**Text (Grep-Format)が必要な理由**:
1. JSONはカンマ1つのミスで全体が破損するが、行指向テキストは破損範囲が限定的
2. LLMにとって「1行1エンティティ」の生成は最も自然でミスが少ない
3. `src/subagents/llmCodeExtractor.ts` がテキストを行ごとにパースしてオブジェクト化する

**内部データ連携**:
パース後はメモリ上で `ExtractionResult` オブジェクトに変換され、必要に応じて `extraction-summary.json` として一時保存されるため、後続のエージェント（依存グラフ構築など）はこれまで通りJSONデータを利用できる。

### Level 3: DEEP_ANALYSIS (Markdown) 🟢 NEW

抽出されたデータに基づく「洞察・分析」は、Markdownベースに移行します。

- **入力**: `extraction/classes.json` (データ)
- **処理**: 「このクラスの設計意図は？」「複雑なポイントは？」といった思考
- **出力**: `analysis/classes/{ClassName}.md`
- **形式**: **Structured Markdown**

---

## 🔧 Level 2 実装詳細 (Line-Based Textの堅牢化)

LLMにLine-Based Textを出力させる際の「脆さ」を克服するための実装戦略。

### 1. Line-Based Parsing (New Standard)

LLMに出力を「1行1エンティティ」にするよう指示し、 TypeScript側で行ごとにパースします。

```typescript
// Output Example
// TYPE: Class | NAME: User | LINE: 10-50

// Parsing Logic
for (const line of lines) {
  if (line.startsWith('TYPE:')) {
     const parts = line.split('|').map(s => s.trim());
     // Parse parts...
  }
}
```

このアプローチにより、Markdownや余計な解説文が混入しても、単に無視（スキップ）するだけで済むため、極めて堅牢です。

### 2. Schema Validation (推奨)

JSONがパースできても、構造が間違っている可能性があります（例: `classes` が配列でない）。
`zod` などのライブラリ、または単純な型ガード関数を使って構造を検証します。

```typescript
function isValidExtraction(data: any): data is ExtractionResult {
  return Array.isArray(data.classes) && Array.isArray(data.functions);
}
```

### 3. Progressive Parsing (予備戦略)

巨大なファイルでJSONが壊れるのを防ぐため、エンティティごと（クラスごと、関数ごと）に個別に抽出し、ホスト側（TypeScript）で配列に結合する戦略も有効です。

---

## 🎯 LLMプロンプト設計 (Level 2)

Line-Based Text出力を安定させるためのプロンプトテクニック。

```text
Extract code entities. Format each entity on a single line.

... source code ...

RESPONSE FORMAT:
TYPE: <Type> | NAME: <Name> | LINE: <Start>-<End> | [EXTENDS: <name>] | [VISIBILITY: <public|private>] | ...

Example:
TYPE: Class | NAME: User | LINE: 10-50 | EXTENDS: BaseModel | VISIBILITY: public
```

## 🎯 LLMプロンプト設計 (Level 3 - Analysis)

Markdown出力を活用するプロンプト。

```text
Analyze the following class structure.

... class data (JSON) ...

RESPONSE FORMAT:
Respond with a Markdown document.

# [Class Name] Analysis

## Purpose
...

## Complexity Analysis
...
```

この分離により、**「機械処理のためのデータ」** と **「人間のための洞察」** を最適な形式で扱うことができます。
