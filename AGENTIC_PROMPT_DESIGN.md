# Agentic反復プロンプト設計 - LLMパーサー改善案

## 💡 現状の問題点

### 現在のアプローチ（単発LLM呼び出し）

```typescript
// 現在: 1回のLLM呼び出しで終了
const result = await this.helper.generateJsonStrict<{
  classes: any[];
  functions: any[];
  // ...
}>(prompt);
```

**問題**:
- ❌ 1回の回答で完璧な抽出を期待している
- ❌ エラーや見落としがあっても修正されない
- ❌ LLMの自己修正能力を活用していない
- ❌ 複雑なコードで精度が低下する可能性

---

## 🚀 改善案: Agentic反復アプローチ

### 戦略1: 段階的抽出（Step-by-step Extraction）

**コンセプト**: 複雑なタスクを小さなステップに分解し、各ステップでLLMに自律的に考えさせる

```typescript
/**
 * Agentic多段階抽出
 */
async extractWithAgenticApproach(
  relativePath: string,
  content: string,
  language: string
): Promise<FileExtractionResult> {

  // STEP 1: まず構造を理解させる（Think step）
  const structurePrompt = `You are analyzing ${language} code. First, understand its structure.

SOURCE CODE:
\`\`\`${language}
${content}
\`\`\`

Think step by step:
1. What is the overall purpose of this file?
2. What are the main components (classes, functions, etc.)?
3. What are the key relationships and dependencies?

Provide your analysis as natural language explanation.`;

  const structureAnalysis = await this.helper.generate(structurePrompt, {
    systemPrompt: 'You are a code analysis expert. Think carefully before extracting.'
  });

  // STEP 2: 分析に基づいて抽出（Extract based on understanding）
  const extractionPrompt = `Based on your understanding, extract code entities.

YOUR ANALYSIS:
${structureAnalysis}

SOURCE CODE:
\`\`\`${language}
${content}
\`\`\`

Now extract entities as JSON:
{ "classes": [...], "functions": [...], ... }

Be thorough and precise. Use 1-indexed line numbers.`;

  const extraction = await this.helper.generateJsonStrict(extractionPrompt);

  // STEP 3: 自己検証（Self-verification）
  const verificationPrompt = `Verify your extraction is complete and accurate.

ORIGINAL CODE:
\`\`\`${language}
${content}
\`\`\`

YOUR EXTRACTION:
${JSON.stringify(extraction, null, 2)}

Check:
1. Did you miss any classes or functions?
2. Are line numbers accurate?
3. Did you capture all inheritance/protocols?
4. Are visibility modifiers correct?

Respond with JSON:
{
  "isComplete": true/false,
  "issues": ["issue 1", "issue 2"],
  "missedEntities": ["entity 1", "entity 2"]
}`;

  const verification = await this.helper.generateJsonStrict(verificationPrompt);

  // STEP 4: 必要に応じて再抽出（Iterative refinement）
  if (!verification.isComplete && verification.missedEntities.length > 0) {
    const refinementPrompt = `You missed some entities. Extract them now.

MISSED ENTITIES:
${verification.missedEntities.join(', ')}

SOURCE CODE:
\`\`\`${language}
${content}
\`\`\`

Extract the missed entities as JSON (same format).`;

    const additionalEntities = await this.helper.generateJsonStrict(refinementPrompt);

    // Merge results
    extraction.classes.push(...(additionalEntities.classes || []));
    extraction.functions.push(...(additionalEntities.functions || []));
  }

  return this.transformToExtractionResult(extraction);
}
```

**利点**:
- ✅ LLMが自分で考える時間を持つ
- ✅ 段階的に精度向上
- ✅ 見落としを自己検出
- ✅ 複雑なコードでも高精度

**欠点**:
- ❌ LLM呼び出し回数: 3-4回/ファイル（コスト増）
- ❌ 処理時間: 2-3倍

---

### 戦略2: Chain-of-Thought + Few-shot Examples

**コンセプト**: LLMに思考プロセスを示し、例を与えて学習させる

```typescript
private buildAgenticExtractionPrompt(
  relativePath: string,
  content: string,
  language: string
): string {
  return `You are a code parser. Extract entities using chain-of-thought reasoning.

## Step 1: Analyze the code structure

First, read through the code and identify:
- What type of code is this? (class definition, module, script, etc.)
- How many major entities are there?
- What are the relationships between them?

## Step 2: Extract entities systematically

For each entity:
1. Identify its type (class, function, interface, etc.)
2. Find its exact start and end lines (1-indexed)
3. Extract all properties and methods
4. Capture inheritance/protocols
5. Determine visibility modifiers

## Few-shot Examples

Example 1: Swift class
\`\`\`swift
public class DrinkingSession: ObservableObject {
    @Published var startTime: Date

    public init(participants: Int) {
        self.startTime = Date()
    }
}
\`\`\`

Extraction:
\`\`\`json
{
  "classes": [{
    "name": "DrinkingSession",
    "startLine": 1,
    "endLine": 7,
    "implements": ["ObservableObject"],
    "isExported": true,
    "properties": [{
      "name": "startTime",
      "type": "Date",
      "visibility": "public",
      "line": 2
    }],
    "methods": [{
      "name": "init",
      "startLine": 4,
      "endLine": 6,
      "visibility": "public",
      "parameters": [{"name": "participants", "type": "Int"}]
    }]
  }]
}
\`\`\`

Example 2: TypeScript interface
\`\`\`typescript
export interface User {
  id: number;
  name: string;
  email?: string;
}
\`\`\`

Extraction:
\`\`\`json
{
  "interfaces": [{
    "name": "User",
    "startLine": 1,
    "endLine": 5,
    "isExported": true,
    "properties": [
      {"name": "id", "type": "number", "isOptional": false, "line": 2},
      {"name": "name", "type": "string", "isOptional": false, "line": 3},
      {"name": "email", "type": "string", "isOptional": true, "line": 4}
    ]
  }]
}
\`\`\`

## Now extract from this ${language} file:

FILE: ${relativePath}

\`\`\`${language}
${content}
\`\`\`

Think step by step, then provide the extraction as JSON.

Your response should be:
{
  "thinking": "Brief analysis of what you see in the code",
  "classes": [...],
  "functions": [...],
  "interfaces": [...],
  "typeAliases": [...],
  "enums": [...]
}`;
}
```

**利点**:
- ✅ Few-shot学習で精度向上
- ✅ Chain-of-Thoughtで論理的抽出
- ✅ LLM呼び出し: 1回/ファイル（効率的）

**欠点**:
- ❌ プロンプトが長い（トークン消費増）

---

### 戦略3: LLMFeedbackLoopの活用（既存インフラ使用）

**コンセプト**: 既に実装されている`LLMFeedbackLoop`を活用

```typescript
async extractWithFeedbackLoop(
  relativePath: string,
  content: string,
  language: string
): Promise<FileExtractionResult> {

  const feedbackLoop = new LLMFeedbackLoop(this.helper.model, {
    maxIterations: 3,
    targetScore: 8.5,
  });

  // 生成プロンプト
  const generatePrompt = this.buildExtractionPrompt(relativePath, content, language);

  // レビュープロンプトテンプレート
  const reviewPromptTemplate = (extraction: string) => `
Review this code extraction for accuracy and completeness.

SOURCE CODE:
\`\`\`${language}
${content}
\`\`\`

EXTRACTION:
${extraction}

Score (1-10) on:
1. Completeness: Did it extract all entities?
2. Accuracy: Are line numbers correct?
3. Relationships: Captured inheritance/protocols?
4. Details: Captured visibility, types, parameters?

Respond with JSON:
{
  "score": <weighted average>,
  "feedback": "Specific issues found",
  "issues": [
    {"entity": "ClassName", "issue": "Missing method X"},
    {"entity": "functionY", "issue": "Wrong line number"}
  ]
}`;

  // 改善プロンプトテンプレート
  const improvePromptTemplate = (extraction: string, feedback: string) => `
Improve this extraction based on feedback.

SOURCE CODE:
\`\`\`${language}
${content}
\`\`\`

CURRENT EXTRACTION:
${extraction}

FEEDBACK:
${feedback}

Provide improved extraction as JSON (same format).`;

  // フィードバックループ実行
  const result = await feedbackLoop.generateWithFeedback(
    generatePrompt,
    reviewPromptTemplate,
    improvePromptTemplate
  );

  const extraction = JSON.parse(result.improved);
  return this.transformToExtractionResult(extraction);
}
```

**利点**:
- ✅ 既存インフラ活用（実装コスト低）
- ✅ 自動的に反復改善
- ✅ スコアベースで品質保証
- ✅ 最大3回の反復で精度向上

**欠点**:
- ❌ LLM呼び出し: 2-4回/ファイル（コスト中）

---

## 📊 各戦略の比較

| 戦略 | LLM呼び出し | 精度 | 速度 | 実装コスト | 推奨度 |
|------|------------|------|------|-----------|--------|
| 現在（単発） | 1回/ファイル | 70% | ⚡⚡⚡ | - | ⭐⭐ |
| 戦略1: 段階的抽出 | 3-4回/ファイル | 90% | ⚡ | 高 | ⭐⭐⭐ |
| 戦略2: Chain-of-Thought | 1回/ファイル | 85% | ⚡⚡ | 中 | ⭐⭐⭐⭐ |
| 戦略3: Feedback Loop | 2-4回/ファイル | 92% | ⚡⚡ | 低 | ⭐⭐⭐⭐⭐ |

---

## 🎯 推奨実装: ハイブリッドアプローチ

**組み合わせ**: 戦略2（Chain-of-Thought） + 戦略3（Feedback Loop）

```typescript
async extractWithLLM(
  relativePath: string,
  content: string,
  language: string,
  token: vscode.CancellationToken
): Promise<FileExtractionResult | null> {

  // オプション: ファイルサイズで戦略を切り替え
  const lines = content.split('\n').length;
  const useAgenticApproach = lines > 100; // 100行以上なら反復アプローチ

  if (useAgenticApproach) {
    // 複雑なファイル: Feedback Loopで反復改善
    return await this.extractWithFeedbackLoop(relativePath, content, language);
  } else {
    // シンプルなファイル: Chain-of-Thought 1回
    const prompt = this.buildChainOfThoughtPrompt(relativePath, content, language);
    const result = await this.helper.generateJsonStrict(prompt);
    return this.transformToExtractionResult(result);
  }
}
```

**利点**:
- ✅ 小さいファイル: 高速（1回LLM呼び出し）
- ✅ 大きいファイル: 高精度（反復改善）
- ✅ コスト最適化
- ✅ 最大限の精度

---

## 💰 コスト影響分析

### 現在のアプローチ（単発）
- 50ファイル × 1回 = **50 LLM呼び出し**
- コスト: **$0.60**

### Feedback Loopアプローチ
- 50ファイル × 平均2.5回 = **125 LLM呼び出し**
- コスト: **$1.50**

### ハイブリッドアプローチ
- 小ファイル30個 × 1回 = 30呼び出し
- 大ファイル20個 × 2.5回 = 50呼び出し
- 合計: **80 LLM呼び出し**
- コスト: **$0.96**

**結論**: ハイブリッドで**60%コスト増**だが、**精度20%向上**

---

## 🚀 実装優先順位

### Phase 1: Chain-of-Thoughtプロンプト改善（即座に実装可能）
- [ ] Few-shot examplesを追加
- [ ] 段階的思考プロセスを追加
- [ ] コスト: ゼロ増
- [ ] 精度: 70% → 85%

### Phase 2: Feedback Loop統合（1-2時間）
- [ ] `extractWithFeedbackLoop()` 実装
- [ ] レビュー・改善プロンプト作成
- [ ] 大きいファイルのみ適用
- [ ] コスト: 60%増
- [ ] 精度: 85% → 92%

### Phase 3: 自己検証ステップ（将来）
- [ ] 段階的抽出の実装
- [ ] 自己検証ロジック
- [ ] 最高精度を目指す

---

## ✅ 次のステップ

どれを実装しますか？

1. **今すぐ**: Chain-of-Thoughtプロンプト改善（コストゼロ、効果大）
2. **今日中**: Feedback Loop統合（1-2時間、精度最大化）
3. **将来**: 段階的抽出（完全Agentic）

推奨は **1 → 2** の順番で実装です。
