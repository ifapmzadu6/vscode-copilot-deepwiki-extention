# Agentic反復プロンプト設計 (v2: Markdown-Centric)

## 💡 基本方針

**「JSONによる拘束を解き、Markdownによる自由な思考へ」**

従来の「JSONスキーマに従わせる」アプローチは、LLMの思考能力を制限し、構文エラーのリスクを高めていました。
新しいアプローチでは、**Analysis (Level 3)** 以降のフェーズで **Markdown** を出力形式として採用します。

---

## 🚀 プロンプト戦略: Markdown-Based Analysis

### 1. 思考の構造化 (Input)

LLMに対して「JSONを埋めろ」ではなく「Markdownで見出しに従って記述せよ」と指示します。

```typescript
const prompt = `
Analyze the code provided below.

## Requirements
Please structure your response using the following Markdown headers:
1. **# Purpose**: Explain the high-level goal.
2. **# Design Patterns**: List patterns with reasoning (use bullet points).
3. **# Key Risks**: Identify potential bugs or bottlenecks.

Do not output JSON. Write in natural language with Markdown formatting.
`;
```

### 2. コンテキスト注入 (Context Injection)

前段の分析結果を次段に渡す際、Markdownはそのままテキストとしてプロンプトに埋め込めるため、非常に効率的です。

```typescript
// Documentation Generator Prompt
const prompt = `
Write documentation based on this analysis:

---
${analysisMarkdownContent} // 前段のMarkdown出力をそのまま埋め込み
---

Summarize this into a user-facing doc.
`;
```

JSONの場合、巨大なオブジェクトをstringifyするとトークン消費が激しく、LLMにとっても読みづらい形式になりがちでしたが、Markdownなら「見出し」に注目させることで効率よく情報を伝達できます。

---

## 🔄 Agentic Feedback Loop (Markdown版)

フィードバックループもMarkdownベースで行うことで、より人間に近いレビューが可能になります。

### Step 1: 初期生成 (Draft)
- **Output**: `analysis/classes/Foo.md` (v1)

### Step 2: レビュー (Review)
- **Prompt**:
  ```text
  Review the following Markdown analysis document.
  
  Report constraints:
  - Check if "Purpose" is clear.
  - Check if "Design Patterns" section exists.
  
  Output a Review Report in Markdown starting with "# Review Report".
  ```
- **Output**:
  ```markdown
  # Review Report
  ## Issues
  - The purpose section is too vague.
  - Missing analysis of error handling.
  ## Score: 7/10
  ```

### Step 3: 改善 (Refinement)
- **Prompt**:
  ```text
  Improve the original document based on this review report.
  
  [Original Document]
  ...
  
  [Review Report]
  ...
  
  Output the fully revised Markdown document.
  ```

---

## 🧩 extractionPrompt (Line-Based Text - Level 2)

抽出フェーズでは、JSONではなく **Grep-Friendly Text** を採用します。
LLMに「1行1エンティティ」で書き出すよう指示することで、パースエラーを根絶します。

```text
Extract code entities.

OUTPUT FORMAT:
TYPE: <Type> | NAME: <Name> | LINE: <Start>-<End> | [EXTENDS: <Name>] | [VISIBILITY: <public|private>] | ...

Example:
TYPE: Class | NAME: User | LINE: 1-50 | EXTENDS: Base
TYPE: Method | NAME: save | LINE: 10-20 | VISIBILITY: public
```

このテキストをシステム側で行ごとにパースし、オブジェクトに変換します。

---

## 📈 期待される効果

1.  **表現力の向上**: 複雑な設計意図を自由な文章とリスト構造で表現できる。
2.  **耐障害性**: JSONのカンマ1つで死ぬことがなくなる。
3.  **トークン効率**: 無駄な引用符や括弧（`{"key": "value"}` vs `key: value`）を減らせる。

このアプローチにより、"Agentic" な自律的改善サイクルがよりスムーズに回るようになります。
