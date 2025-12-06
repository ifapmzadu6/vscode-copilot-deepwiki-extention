# ファイルベースパイプライン設計方針 (v2: Markdown-Centric)

## 🎯 設計哲学

> **"Data for Machines, Text for Intelligence"**

1. **Text/Structured Text**: Extraction, Analysis, Docs, Review (Levels 2, 3, 5, 6, 7)
2. **JSON**: Only for internal Relationship Graphs (Level 4) and metadata (Level 1)

## 🔑 核心原則

### 1. "Markdown-First" for Intelligence
LLMはJSONよりも自然言語（Markdown）の生成・理解が得意です。
深い分析やドキュメント生成を行うフェーズでは、無理にJSONに押し込めず、**構造化されたMarkdown**を使用します。

**メリット**:
- 📝 **記述力**: 自由な表現、コードブロック、リストが自然に使える
- 🛡️ **堅牢性**: SyntaxError（カンマ忘れ等）が発生しない
- 🧠 **思考の連続性**: 自然言語で思考の流れを止めずに出力できる
- 👀 **可視性**: 人間が中間ファイルを直接読んで理解・デバッグできる

### 2. ファイル形式の使い分け

| レベル | フェーズ | 形式 | 理由 |
|--------|----------|------|------|
| L1 | DISCOVERY | 🟠 **JSON** | ファイルリストなど機械的なデータ処理が主 |
| L2 | EXTRACTION | � **Text (Grep)** | JSONパースエラー回避、LLMの出力安定化のため |
| L3 | DEEP_ANALYSIS | 🟢 **Markdown** | クラスの目的や設計意図など、深い記述が必要 |
| L4 | RELATIONSHIP | 🟠 **JSON** | グラフ構造（ノード・エッジ）の表現に最適 |
| L5 | DOCUMENTATION | 🟢 **Markdown** | 最終成果物がMarkdownであり、ドラフトもMDが自然 |
| L6 | QUALITY_REVIEW | 🟢 **Markdown** | レビューコメントや改善提案は自然言語が最適 |
| L7 | OUTPUT | 🟢 **Markdown** | 最終出力 |

## 📊 パイプラインデータフロー

```mermaid
flowchart TD
    Build[Build Pipeline]
    
    subgraph Structured["Structured Data (JSON)"]
        L1[L1: Discovery]
        L4[L4: Relationships]
    end
    
    subgraph Semantic["Text / Markdown"]
        L2[L2: Extraction (Text)]
        L3[L3: Deep Analysis (MD)]
        L5[L5: Documentation (MD)]
        L6[L6: Review (MD)]
        L7[L7: Output (MD)]
    end

    L1 --> L2
    L2 -- Entities --> L3
    L2 -- References --> L4
    L3 -- Insights (MD) --> L5
    L4 -- Graphs (JSON) --> L5
    L5 -- Drafts (MD) --> L6
    L6 -- Feedback (MD) --> L7
```

---

## 🔧 実装ガイドライン

### A. 分析エージェント (Markdown出力)

**入力**: `extraction-summary.json` (JSON)
**出力**: `analysis/classes/MyClass.md` (Markdown)

**プロンプト例**:
```text
Analyze the class `MyClass`. Use the following Markdown structure:

# MyClass Analysis

## Purpose
(Describe the purpose here...)

## Key Responsibilities
- Responsibility 1
- Responsibility 2

## Design Patterns
- **Singleton**: Because it...
```

**Subagent実装**:
```typescript
// .mdファイルとして保存
await this.fileManager.saveMarkdown(
  IntermediateFileType.ANALYSIS_CLASS, 
  markdownContent, 
  className
);
```

### B. ドキュメント生成エージェント (Markdown入力)

**入力**: 
- `analysis/classes/*.md` (Markdownをテキストとして読み込む)
- `relationships/*.json` (JSONをオブジェクトとして読み込む)

**処理**:
LLMに対して「以下の分析レポート(Markdown)と依存グラフ(JSON)を元に、ドキュメントを作成せよ」と指示する。MarkdownはそのままコンテキストとしてLLMに渡しやすいため、プロンプト構築が容易になる。

---

## ✅ チェックリスト

新しいSubagentを作成する際の確認項目：

- [ ] **形式の選択**: データ処理ならJSON、知的生成ならMarkdownを選んだか？
- [ ] **Markdown構造**: 見出し（#）で明確にセクション分けされているか？
- [ ] **JSONパース回避**: 分析結果を無理に正規表現でパースしようとしていないか？（Markdownのまま渡すのが正解）
- [ ] **ファイル保存**: `saveJson` ではなく `saveMarkdown` を使用しているか？

## 🎨 メリット

1. **エラー激減**: JSONパースエラーによる失敗がなくなる
2. **品質向上**: LLMがフォーマットに縛られず、内容に集中できる
3. **デバッグ体験**: 中間生成物がそのまま「読み物」として機能する

---

## 📝 関連ドキュメント
- `ARCHITECTURE_REDESIGN.md`: 全体アーキテクチャ詳細
- `LLM_PARSER_DESIGN.md`: L2抽出（Grep-friendly Text）の詳細
