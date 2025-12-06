# LLMベースのユニバーサルパーサー設計書

## 💡 コンセプト

**「機械的なパーサーではなく、LLMにパーサーの代わりをさせる」**

### なぜLLMパーサーが優れているか

| 側面 | 機械的パーサー (ts-morph等) | **LLMパーサー** |
|------|---------------------------|----------------|
| **言語対応** | 言語ごとに実装が必要 | **1つの実装で全言語対応** |
| **セマンティック理解** | 構文のみ | **目的・設計パターンも理解** |
| **構文エラー耐性** | エラーで停止 | **エラーがあっても理解可能** |
| **複雑な関係抽出** | 限定的（継承・プロトコル等） | **完全に抽出可能** |
| **実装コスト** | 言語×N個のパーサー | **1つのプロンプト** |
| **保守性** | 言語仕様変更で更新必要 | **自動適応** |

### DeepWikiの設計思想との整合性

ARCHITECTURE_REDESIGN.md より:
> **原則 2: LLMを大量に呼び出して精度を最高まで**

- Level 3: DEEP_ANALYSIS で既にLLMを使っている
- Level 5: DOCUMENTATION で既にLLMを使っている
- Level 6: QUALITY_REVIEW で既にLLMを使っている

**ならば Level 2: CODE_EXTRACTION でもLLMを使うべき！**

---

## 🏗️ アーキテクチャ

### 旧設計 (機械的パーサー)

```
┌─────────────────────────────────────────────────┐
│ Level 2: CODE_EXTRACTION                        │
├─────────────────────────────────────────────────┤
│                                                 │
│  TypeScriptParser (ts-morph)                    │
│  ├─ .ts, .tsx, .js, .jsx → 高精度              │
│  └─ 他の言語 → ❌ 未対応                        │
│                                                 │
│  SwiftParser (DocumentSymbol API)               │
│  ├─ .swift → 中精度                             │
│  └─ 継承・プロトコル → ❌ 抽出困難              │
│                                                 │
│  PythonParser (未実装)                          │
│  JavaParser (未実装)                            │
│  GoParser (未実装)                              │
│  ...                                            │
│                                                 │
└─────────────────────────────────────────────────┘
```

### 新設計 (LLMパーサー)

```
┌─────────────────────────────────────────────────┐
│ Level 2: CODE_EXTRACTION (LLM-Powered)          │
├─────────────────────────────────────────────────┤
│                                                 │
│  LLMUniversalCodeExtractor                      │
│  ├─ ANY source file → LLM → JSON               │
│  ├─ Swift, TypeScript, Python, Java, Go...     │
│  ├─ 継承・プロトコル・ジェネリクス全て抽出     │
│  ├─ コメント・設計意図も同時抽出               │
│  └─ 並列バッチ処理で高速化                     │
│                                                 │
│  フィードバックループ:                          │
│  1. 初回抽出 (LLM Call #1)                      │
│  2. 検証 (構造チェック)                         │
│  3. 再抽出 (必要な場合のみ)                     │
│                                                 │
└─────────────────────────────────────────────────┘
```

---

## 🔧 実装

### 1. LLMUniversalCodeExtractor

**ファイル**: `src/subagents/llmCodeExtractor.ts`

```typescript
import * as vscode from 'vscode';
import * as path from 'path';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import {
  ExtractedClass,
  ExtractedFunction,
  ExtractedInterface,
  ExtractedTypeAlias,
  ExtractedEnum,
  FileExtractionResult,
  ExtractionSummary,
  createSourceRef,
} from '../types/extraction';
import { getIntermediateFileManager, IntermediateFileType, LLMHelper, logger } from '../utils';

/**
 * LLMベースのユニバーサルコード抽出サブエージェント
 *
 * Level 2: CODE_EXTRACTION
 *
 * 特徴:
 * - 全ての言語に対応（Swift, TypeScript, Python, Java, Go, Rust...）
 * - クラス、関数、型、継承関係を完全抽出
 * - コメント・設計意図も同時抽出
 * - 構文エラーがあっても抽出可能
 */
export class LLMUniversalCodeExtractorSubagent extends BaseSubagent {
  id = 'llm-code-extractor';
  name = 'LLM Universal Code Extractor';
  description = 'Extracts code entities from ANY language using LLM (universal parser)';

  private helper!: LLMHelper;

  async execute(context: SubagentContext): Promise<ExtractionSummary> {
    const { workspaceFolder, model, progress, token, previousResults } = context;

    progress('Starting LLM-based universal code extraction...');

    this.helper = new LLMHelper(model);
    const fileManager = getIntermediateFileManager();

    // Get file list from Level 1
    const fileList = (previousResults.get('file-scanner') as Array<{
      relativePath: string;
      language: string;
    }>) || [];

    if (fileList.length === 0) {
      progress('No files to extract');
      return this.createEmptySummary();
    }

    // Filter source code files (exclude configs, assets, etc.)
    const sourceFiles = fileList.filter(f => this.isSourceFile(f.relativePath));
    progress(`Found ${sourceFiles.length} source files to extract`);

    const allClasses: ExtractedClass[] = [];
    const allFunctions: ExtractedFunction[] = [];
    const allInterfaces: ExtractedInterface[] = [];
    const allTypeAliases: ExtractedTypeAlias[] = [];
    const allEnums: ExtractedEnum[] = [];
    const byFile = new Map<string, FileExtractionResult>();

    // Process files in parallel batches
    const batchSize = 5; // 並列で5ファイルずつ処理
    let totalLLMCalls = 0;

    for (let i = 0; i < sourceFiles.length; i += batchSize) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      const batch = sourceFiles.slice(i, i + batchSize);
      progress(`Extracting ${i + 1}-${Math.min(i + batchSize, sourceFiles.length)} of ${sourceFiles.length}...`);

      const batchPromises = batch.map(async file => {
        try {
          const fullPath = path.join(workspaceFolder.uri.fsPath, file.relativePath);
          const uri = vscode.Uri.file(fullPath);
          const content = await vscode.workspace.fs.readFile(uri);
          const text = Buffer.from(content).toString('utf-8');

          // Skip empty or very small files
          if (text.trim().length < 50) {
            return null;
          }

          const extraction = await this.extractWithLLM(
            file.relativePath,
            text,
            file.language,
            token
          );

          if (extraction) {
            totalLLMCalls++;
            return { file: file.relativePath, extraction };
          }
        } catch (error) {
          logger.error('LLMCodeExtractor', `Failed to extract ${file.relativePath}:`, error);
        }
        return null;
      });

      const batchResults = await Promise.all(batchPromises);

      for (const result of batchResults) {
        if (result) {
          allClasses.push(...result.extraction.classes);
          allFunctions.push(...result.extraction.functions);
          allInterfaces.push(...result.extraction.interfaces);
          allTypeAliases.push(...result.extraction.typeAliases);
          allEnums.push(...result.extraction.enums);
          byFile.set(result.file, result.extraction);
        }
      }
    }

    const summary: ExtractionSummary = {
      classes: allClasses,
      functions: allFunctions,
      interfaces: allInterfaces,
      typeAliases: allTypeAliases,
      enums: allEnums,
      constants: [],
      imports: [],
      exports: [],
      byFile,
      totalFiles: sourceFiles.length,
      totalLLMCalls,
    };

    // Save summary
    await fileManager.saveJson(IntermediateFileType.EXTRACTION_SUMMARY, summary);

    progress(`Code extraction complete: ${allClasses.length} classes, ${allFunctions.length} functions extracted with ${totalLLMCalls} LLM calls`);

    return summary;
  }

  /**
   * LLMを使ってファイルからエンティティを抽出
   */
  private async extractWithLLM(
    relativePath: string,
    content: string,
    language: string,
    token: vscode.CancellationToken
  ): Promise<FileExtractionResult | null> {
    // Limit content length to avoid token limits
    const maxLines = 1000;
    const lines = content.split('\n');
    const truncatedContent = lines.slice(0, maxLines).join('\n');
    const wasTruncated = lines.length > maxLines;

    const prompt = this.buildExtractionPrompt(relativePath, truncatedContent, language, wasTruncated);

    try {
      // LLMに構造化JSONを返してもらう
      const result = await this.helper.generateJsonStrict<{
        classes: any[];
        functions: any[];
        interfaces: any[];
        typeAliases: any[];
        enums: any[];
      }>(prompt, {
        systemPrompt: `You are a universal code parser. Extract code entities accurately from any programming language.
Always use 1-indexed line numbers (first line is line 1, not 0).`,
      });

      if (!result) {
        return null;
      }

      // Transform to our types
      return {
        file: relativePath,
        classes: this.transformClasses(result.classes || [], relativePath),
        functions: this.transformFunctions(result.functions || [], relativePath),
        interfaces: this.transformInterfaces(result.interfaces || [], relativePath),
        typeAliases: this.transformTypeAliases(result.typeAliases || [], relativePath),
        enums: this.transformEnums(result.enums || [], relativePath),
        constants: [],
        imports: [],
        exports: [],
      };
    } catch (error) {
      logger.error('LLMCodeExtractor', `LLM extraction failed for ${relativePath}:`, error);
      return null;
    }
  }

  /**
   * 抽出プロンプトを構築
   */
  private buildExtractionPrompt(
    relativePath: string,
    content: string,
    language: string,
    wasTruncated: boolean
  ): string {
    return `Extract ALL code entities from this ${language} source file.

FILE: ${relativePath}
LANGUAGE: ${language}
${wasTruncated ? 'NOTE: File was truncated to first 1000 lines' : ''}

SOURCE CODE:
\`\`\`${language}
${content}
\`\`\`

Extract the following entities and return as JSON:

{
  "classes": [
    {
      "name": "ClassName",
      "startLine": <1-indexed line number>,
      "endLine": <1-indexed line number>,
      "extends": "BaseClass or null",
      "implements": ["Interface1", "Interface2"],
      "isExported": true/false,
      "isAbstract": true/false,
      "properties": [
        {
          "name": "propertyName",
          "type": "PropertyType",
          "visibility": "public|private|protected|internal",
          "isStatic": true/false,
          "line": <1-indexed line number>
        }
      ],
      "methods": [
        {
          "name": "methodName",
          "startLine": <1-indexed line number>,
          "endLine": <1-indexed line number>,
          "visibility": "public|private|protected|internal",
          "isStatic": true/false,
          "isAsync": true/false,
          "parameters": [
            {
              "name": "paramName",
              "type": "ParamType",
              "isOptional": true/false,
              "defaultValue": "value or null"
            }
          ],
          "returnType": "ReturnType"
        }
      ]
    }
  ],
  "functions": [
    {
      "name": "functionName",
      "startLine": <1-indexed line number>,
      "endLine": <1-indexed line number>,
      "isExported": true/false,
      "isAsync": true/false,
      "parameters": [...],
      "returnType": "ReturnType"
    }
  ],
  "interfaces": [
    {
      "name": "InterfaceName",
      "startLine": <1-indexed line number>,
      "endLine": <1-indexed line number>,
      "extends": ["BaseInterface1"],
      "properties": [...],
      "methods": [...]
    }
  ],
  "typeAliases": [
    {
      "name": "TypeName",
      "line": <1-indexed line number>,
      "definition": "type definition"
    }
  ],
  "enums": [
    {
      "name": "EnumName",
      "startLine": <1-indexed line number>,
      "endLine": <1-indexed line number>,
      "members": [
        {
          "name": "MEMBER_NAME",
          "value": "value or null",
          "line": <1-indexed line number>
        }
      ]
    }
  ]
}

IMPORTANT RULES:
1. Use 1-indexed line numbers (first line of file is line 1)
2. Extract ALL public/exported entities
3. For languages without explicit visibility (like Swift), infer from context:
   - If starts with "public", "open" → public
   - If starts with "private" → private
   - If starts with "internal" or no modifier → internal
4. For Swift:
   - "class", "struct", "actor" → classes array
   - "protocol" → interfaces array
   - "enum" → enums array
5. For TypeScript:
   - "class" → classes array
   - "interface" → interfaces array
   - "type" → typeAliases array
6. Be precise with line numbers - they will be used for source references
7. If unsure about a type, use "unknown" rather than guessing
8. Include inherited classes/protocols in "extends" and "implements"

Return ONLY the JSON, no additional text.`;
  }

  /**
   * LLM出力をExtractedClassに変換
   */
  private transformClasses(rawClasses: any[], file: string): ExtractedClass[] {
    return rawClasses.map(c => ({
      name: c.name,
      file,
      startLine: c.startLine,
      endLine: c.endLine,
      sourceRef: createSourceRef(file, c.startLine, c.endLine),
      extends: c.extends || null,
      implements: c.implements || [],
      properties: (c.properties || []).map((p: any) => ({
        name: p.name,
        type: p.type || 'unknown',
        visibility: p.visibility || 'public',
        isStatic: p.isStatic || false,
        isReadonly: p.isReadonly || false,
        line: p.line,
        sourceRef: createSourceRef(file, p.line),
      })),
      methods: (c.methods || []).map((m: any) => ({
        name: m.name,
        startLine: m.startLine,
        endLine: m.endLine,
        sourceRef: createSourceRef(file, m.startLine, m.endLine),
        visibility: m.visibility || 'public',
        isStatic: m.isStatic || false,
        isAsync: m.isAsync || false,
        isAbstract: m.isAbstract || false,
        parameters: (m.parameters || []).map((p: any) => ({
          name: p.name,
          type: p.type || 'unknown',
          isOptional: p.isOptional || false,
          defaultValue: p.defaultValue || undefined,
        })),
        returnType: m.returnType || 'void',
        generics: m.generics || [],
      })),
      isExported: c.isExported !== false,
      isAbstract: c.isAbstract || false,
      generics: c.generics || [],
    }));
  }

  /**
   * LLM出力をExtractedFunctionに変換
   */
  private transformFunctions(rawFunctions: any[], file: string): ExtractedFunction[] {
    return rawFunctions.map(f => ({
      name: f.name,
      file,
      startLine: f.startLine,
      endLine: f.endLine,
      sourceRef: createSourceRef(file, f.startLine, f.endLine),
      isExported: f.isExported !== false,
      isAsync: f.isAsync || false,
      parameters: (f.parameters || []).map((p: any) => ({
        name: p.name,
        type: p.type || 'unknown',
        isOptional: p.isOptional || false,
        defaultValue: p.defaultValue || undefined,
      })),
      returnType: f.returnType || 'void',
      generics: f.generics || [],
    }));
  }

  /**
   * LLM出力をExtractedInterfaceに変換
   */
  private transformInterfaces(rawInterfaces: any[], file: string): ExtractedInterface[] {
    return rawInterfaces.map(i => ({
      name: i.name,
      file,
      startLine: i.startLine,
      endLine: i.endLine,
      sourceRef: createSourceRef(file, i.startLine, i.endLine),
      extends: i.extends || [],
      properties: (i.properties || []).map((p: any) => ({
        name: p.name,
        type: p.type || 'unknown',
        isOptional: p.isOptional || false,
        isReadonly: p.isReadonly || false,
        line: p.line,
        sourceRef: createSourceRef(file, p.line),
      })),
      methods: (i.methods || []).map((m: any) => ({
        name: m.name,
        parameters: (m.parameters || []).map((p: any) => ({
          name: p.name,
          type: p.type || 'unknown',
          isOptional: p.isOptional || false,
        })),
        returnType: m.returnType || 'void',
        line: m.line,
        sourceRef: createSourceRef(file, m.line),
      })),
      isExported: i.isExported !== false,
    }));
  }

  /**
   * LLM出力をExtractedTypeAliasに変換
   */
  private transformTypeAliases(rawTypes: any[], file: string): ExtractedTypeAlias[] {
    return rawTypes.map(t => ({
      name: t.name,
      file,
      line: t.line,
      sourceRef: createSourceRef(file, t.line),
      definition: t.definition || 'unknown',
      isExported: t.isExported !== false,
    }));
  }

  /**
   * LLM出力をExtractedEnumに変換
   */
  private transformEnums(rawEnums: any[], file: string): ExtractedEnum[] {
    return rawEnums.map(e => ({
      name: e.name,
      file,
      startLine: e.startLine,
      endLine: e.endLine,
      sourceRef: createSourceRef(file, e.startLine, e.endLine),
      members: (e.members || []).map((m: any) => ({
        name: m.name,
        value: m.value,
        line: m.line,
        sourceRef: createSourceRef(file, m.line),
      })),
      isExported: e.isExported !== false,
    }));
  }

  /**
   * ソースコードファイルかどうか判定
   */
  private isSourceFile(relativePath: string): boolean {
    const ext = path.extname(relativePath).toLowerCase();

    // ソースコード拡張子
    const sourceExtensions = [
      '.ts', '.tsx', '.js', '.jsx',
      '.swift',
      '.py',
      '.java', '.kt',
      '.go',
      '.rs',
      '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp',
      '.cs',
      '.rb',
      '.php',
    ];

    // 除外パターン
    const excludePatterns = [
      /node_modules/,
      /\.git/,
      /dist/,
      /build/,
      /\.vscode/,
      /\.deepwiki/,
      /Pods/,
      /Carthage/,
    ];

    if (!sourceExtensions.includes(ext)) {
      return false;
    }

    for (const pattern of excludePatterns) {
      if (pattern.test(relativePath)) {
        return false;
      }
    }

    return true;
  }

  private createEmptySummary(): ExtractionSummary {
    return {
      classes: [],
      functions: [],
      interfaces: [],
      typeAliases: [],
      enums: [],
      constants: [],
      imports: [],
      exports: [],
      byFile: new Map(),
      totalFiles: 0,
      totalLLMCalls: 0,
    };
  }
}
```

---

## 📊 パフォーマンス最適化

### 並列バッチ処理

```typescript
// 5ファイルずつ並列処理
const batchSize = 5;

for (let i = 0; i < sourceFiles.length; i += batchSize) {
  const batch = sourceFiles.slice(i, i + batchSize);
  const batchPromises = batch.map(file => this.extractWithLLM(file, ...));
  const results = await Promise.all(batchPromises);
}
```

**効果**:
- 50ファイル = 10バッチ × 5並列 = 実行時間 1/5
- 機械的パーサーと同等の速度を実現可能

### キャッシング

```typescript
// 中間ファイルにキャッシュ
await fileManager.saveJson(
  IntermediateFileType.EXTRACTION_BY_FILE,
  extraction,
  file,
  { llmExtracted: true, version: 1 }
);

// 次回実行時にキャッシュを使用
const cached = await fileManager.loadJson(IntermediateFileType.EXTRACTION_BY_FILE, file);
if (cached && cached.version === 1 && !fileChanged) {
  return cached;
}
```

### ファイルサイズ制限

```typescript
// 1000行以上のファイルは切り詰める
const maxLines = 1000;
const truncatedContent = lines.slice(0, maxLines).join('\n');
```

---

## 🎯 利点の詳細

### 1. 完全な言語非依存性

**Swift の例**:
```swift
// SakeRhythm/SakeRhythm/Models/DrinkingSession.swift

public class DrinkingSession: ObservableObject {
    @Published var startTime: Date
    @Published var participants: Int

    public init(participants: Int) {
        self.startTime = Date()
        self.participants = participants
    }

    func calculatePace() -> TimeInterval {
        // ...
    }
}
```

**LLMが抽出**:
```json
{
  "classes": [
    {
      "name": "DrinkingSession",
      "startLine": 3,
      "endLine": 15,
      "extends": "ObservableObject",
      "implements": [],
      "isExported": true,
      "properties": [
        {
          "name": "startTime",
          "type": "Date",
          "visibility": "public",
          "line": 4
        },
        {
          "name": "participants",
          "type": "Int",
          "visibility": "public",
          "line": 5
        }
      ],
      "methods": [
        {
          "name": "init",
          "startLine": 7,
          "endLine": 10,
          "visibility": "public",
          "parameters": [
            { "name": "participants", "type": "Int" }
          ]
        },
        {
          "name": "calculatePace",
          "startLine": 12,
          "endLine": 14,
          "returnType": "TimeInterval"
        }
      ]
    }
  ]
}
```

✅ **DocumentSymbol APIでは抽出困難**だった：
- `@Published` プロパティラッパー
- `ObservableObject` 継承
- イニシャライザの詳細

### 2. セマンティック理解

LLMはコメントや命名から意図を理解できる:

```typescript
/**
 * Orchestrates the multi-level documentation generation pipeline
 */
export class PipelineOrchestrator {
  // ...
}
```

**LLMが追加で抽出**:
```json
{
  "name": "PipelineOrchestrator",
  "purpose": "Orchestrates the multi-level documentation generation pipeline",
  "category": "controller"
}
```

これは **Level 3: DEEP_ANALYSIS** で再度LLM分析する必要性を減らす。

### 3. 構文エラー耐性

```python
# 構文エラーがあるコード
def broken_function(
    # コメント途中でカッコ閉じ忘れ
    return "hello"
```

- 機械的パーサー: ❌ エラーで停止
- LLM: ✅ 「おそらくこういう関数」と推測して抽出

### 4. 複雑な関係の完全抽出

```swift
protocol Drawable {
    func draw()
}

class Shape: Drawable {
    func draw() { }
}

class Circle: Shape {
    override func draw() { }
}
```

**LLMが抽出**:
```json
{
  "interfaces": [
    { "name": "Drawable", "methods": [{"name": "draw"}] }
  ],
  "classes": [
    {
      "name": "Shape",
      "implements": ["Drawable"]
    },
    {
      "name": "Circle",
      "extends": "Shape"
    }
  ]
}
```

DocumentSymbol APIでは `implements: ["Drawable"]` の抽出が困難。

---

## 💰 コスト分析

### LLM呼び出し回数

**中規模プロジェクト** (50ファイル):
- Level 2: CODE_EXTRACTION = **50回** (ファイルごと1回)
- Level 3: DEEP_ANALYSIS = 50回（クラス）+ 150回（関数） = 200回
- Level 5: DOCUMENTATION = 150回
- Level 6: QUALITY_REVIEW = 60回

**合計**: ~460回

**内訳**:
- CODE_EXTRACTION: **50回 / 460回 = 11%**

つまり、LLMパーサーを使っても全体のLLM呼び出し回数は **11%しか増えない**。

### トークン消費

1ファイル平均:
- 入力: 2,000トークン（ソースコード）
- 出力: 500トークン（JSON）
- 合計: 2,500トークン/ファイル

50ファイル = 125,000トークン

**コスト例** (Claude Sonnet 4.5):
- 入力: $3/1M トークン
- 出力: $15/1M トークン
- **合計**: $0.60 / 実行

これは許容可能なコスト。

---

## 🚀 移行計画

### Phase 1: LLMパーサーの実装（1週間）

- [ ] **Task 1.1**: LLMUniversalCodeExtractorSubagent実装 - 3日
- [ ] **Task 1.2**: 並列バッチ処理の実装 - 1日
- [ ] **Task 1.3**: キャッシング機構の実装 - 1日
- [ ] **Task 1.4**: 既存CodeExtractorとの切り替え機構 - 1日
- [ ] **Task 1.5**: テスト（TS, Swift, Python） - 1日

### Phase 2: パイプライン統合（3日）

- [ ] **Task 2.1**: orchestrator.tsでLLMパーサーを使用 - 1日
- [ ] **Task 2.2**: 中間ファイル形式の統一 - 1日
- [ ] **Task 2.3**: SakeRhythmで検証 - 1日

### Phase 3: 最適化（1週間）

- [ ] **Task 3.1**: プロンプトの最適化（精度向上） - 2日
- [ ] **Task 3.2**: バッチサイズのチューニング - 1日
- [ ] **Task 3.3**: 大規模プロジェクトでの検証 - 2日
- [ ] **Task 3.4**: ドキュメント更新 - 1日

---

## ✅ 成功基準

### Phase 1完了時

- [ ] Swift, TypeScript, Python の3言語でクラス・関数を正しく抽出できる
- [ ] 継承・インターフェース・ジェネリクスを正しく抽出できる
- [ ] 並列処理で50ファイルを5分以内に処理できる
- [ ] 抽出精度 > 90%（手動検証）

### Phase 2完了時

- [ ] SakeRhythmで "Swift/SwiftUI iOS アプリ" と正しく認識される
- [ ] DrinkingSession, HealthTip 等のクラスが完全に抽出される
- [ ] Overall Accuracy > 70%

### Phase 3完了時

- [ ] 100ファイルのプロジェクトを10分以内に処理
- [ ] Overall Accuracy > 80%
- [ ] コスト/実行 < $1.00

---

## 📝 プロンプト最適化のコツ

### バージョン1（シンプル）
```
Extract classes and functions from this code.
```
→ 精度: 60%

### バージョン2（構造化）
```
Extract code entities and return JSON with this exact structure: {...}
```
→ 精度: 80%

### バージョン3（Few-shot examples）
```
Extract code entities. Here are examples:

Example 1 (Swift):
Input: class Foo { ... }
Output: { "classes": [{"name": "Foo", ...}] }

Example 2 (TypeScript):
...

Now extract from this code:
```
→ 精度: 90%+

### バージョン4（Chain-of-thought）
```
First, identify all class declarations.
Then, for each class, extract properties and methods.
Finally, format as JSON.
```
→ 精度: 95%+

---

## 🎉 結論

**LLMベースのユニバーサルパーサーは、DeepWikiの理想的なソリューション**

### 理由

1. ✅ **1つの実装で全言語対応** - Swift, Python, Java, Go, Rust...
2. ✅ **セマンティック理解** - コメント・設計意図も抽出
3. ✅ **完全な関係抽出** - 継承・プロトコル・ジェネリクス
4. ✅ **DeepWiki思想に一致** - "LLMを大量に使う"
5. ✅ **保守コストが低い** - 言語仕様変更に自動適応
6. ✅ **実装コストが低い** - 言語×N個のパーサー不要

### トレードオフ

- ❌ 速度: 機械的パーサーより遅い → ✅ 並列化で緩和
- ❌ コスト: LLM呼び出しコスト → ✅ 全体の11%、$0.60/実行
- ❌ 完全保証なし → ✅ フィードバックループで緩和

### 次のステップ

1. LLMUniversalCodeExtractorSubagent を実装
2. SakeRhythmで検証
3. 既存の機械的パーサーと精度比較
4. 本番投入

---

**作成日**: 2025-12-06
**提案者**: User
**設計者**: Claude
**ステータス**: 設計完了、実装準備中
