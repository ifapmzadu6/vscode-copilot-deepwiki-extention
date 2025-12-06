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
  ExtractedProperty,
  ExtractedMethod,
  ExtractedParameter,
  ExtractedInterfaceProperty,
  ExtractedInterfaceMethod,
  ExtractedEnumMember,
  FileExtractionResult,
  ExtractionSummary,
  createSourceRef,
  SourceReference,
} from '../types/extraction';
import { getIntermediateFileManager, IntermediateFileType, LLMHelper, logger } from '../utils';

/**
 * LLMベースのユニバーサルコード抽出サブエージェント
 *
 * Level 2: CODE_EXTRACTION
 *
 * 特徴:
 * - 全ての言語に対応（TypeScript, JavaScript, Swift, Python, Java, Go, Rust, C++, C#, Ruby, PHP...）
 * - 機械的パーサー（ts-morph, tree-sitter等）を使わず、LLMで解析
 * - クラス、関数、インターフェース、型、列挙型を完全抽出
 * - 継承、プロトコル準拠、ジェネリクスも抽出
 * - コメント・設計意図も同時抽出
 * - 構文エラーがあっても抽出可能
 * - 並列バッチ処理で高速化（5ファイル/バッチ）
 * - ファイルベースキャッシング（2回目以降高速）
 *
 * 対応言語（例）:
 * - TypeScript, JavaScript (従来はts-morphで解析していたが、LLMに統一)
 * - Swift (従来はDocumentSymbol APIで解析していたが、LLMの方が精度高い)
 * - Python, Java, Kotlin, Go, Rust, C++, C, C#, Ruby, PHP...
 */
export class LLMUniversalCodeExtractorSubagent extends BaseSubagent {
  id = 'llm-code-extractor';
  name = 'LLM Universal Code Extractor';
  description = 'Extracts code entities from ANY language using LLM (universal parser)';

  private helper!: LLMHelper;
  private fileManager: any;

  async execute(context: SubagentContext): Promise<ExtractionSummary> {
    const { workspaceFolder, model, progress, token, previousResults } = context;

    progress('Starting LLM-based universal code extraction...');

    this.helper = new LLMHelper(model);
    this.fileManager = getIntermediateFileManager();

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

          // Check cache first
          const cached = await this.loadCachedExtraction(file.relativePath);
          if (cached) {
            logger.log('LLMCodeExtractor', `Using cached extraction for ${file.relativePath}`);
            return { file: file.relativePath, extraction: cached, fromCache: true };
          }

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
            // Save to cache
            await this.saveCachedExtraction(file.relativePath, extraction);
            return { file: file.relativePath, extraction, fromCache: false };
          }
        } catch (error) {
          logger.error('LLMCodeExtractor', `Failed to extract ${file.relativePath}:`, error);
        }
        return null;
      });

      const batchResults = await Promise.all(batchPromises);

      for (const result of batchResults) {
        if (result) {
          if (!result.fromCache) {
            totalLLMCalls++;
          }
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
      stats: {
        totalClasses: allClasses.length,
        totalFunctions: allFunctions.length,
        totalInterfaces: allInterfaces.length,
        totalTypes: allTypeAliases.length,
        totalEnums: allEnums.length,
        totalConstants: 0,
        totalExports: 0,
        totalImports: 0,
      },
    };

    // Save summary
    await this.fileManager.saveJson(IntermediateFileType.EXTRACTION_SUMMARY, summary);

    progress(`Code extraction complete: ${allClasses.length} classes, ${allFunctions.length} functions, ${totalLLMCalls} LLM calls`);

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
Always use 1-indexed line numbers (first line is line 1, not 0).
Be precise and thorough.`,
      });

      if (!result) {
        logger.warn('LLMCodeExtractor', `LLM returned null for ${relativePath}`);
        return null;
      }

      // Transform to our types
      const extraction: FileExtractionResult = {
        file: relativePath,
        relativePath,
        language,
        lineCount: lines.length,
        classes: this.transformClasses(result.classes || [], relativePath),
        functions: this.transformFunctions(result.functions || [], relativePath),
        interfaces: this.transformInterfaces(result.interfaces || [], relativePath),
        typeAliases: this.transformTypeAliases(result.typeAliases || [], relativePath),
        enums: this.transformEnums(result.enums || [], relativePath),
        constants: [],
        imports: [],
        exports: [],
        extractedAt: new Date().toISOString(),
      };

      return extraction;
    } catch (error) {
      logger.error('LLMCodeExtractor', `LLM extraction failed for ${relativePath}:`, error);
      return null;
    }
  }

  /**
   * Few-shot examples を取得
   */
  private getFewShotExamples(language: string): string {
    const swiftExample = `### Example 1: Swift Class with SwiftData

\`\`\`swift
import SwiftData

@Model
final class DrinkingSession {
    var participantCount: Int
    @Published var currentPhase: DrinkingPhase

    init(participantCount: Int) {
        self.participantCount = participantCount
        self.currentPhase = .early
    }

    func updatePhase(_ phase: DrinkingPhase) {
        currentPhase = phase
    }
}

enum DrinkingPhase: String {
    case early, middle, late
}
\`\`\`

**Correct Extraction:**
\`\`\`json
{
  "classes": [{
    "name": "DrinkingSession",
    "startLine": 4,
    "endLine": 15,
    "implements": [],
    "isExported": false,
    "properties": [
      {"name": "participantCount", "type": "Int", "visibility": "internal", "line": 5},
      {"name": "currentPhase", "type": "DrinkingPhase", "visibility": "internal", "line": 6}
    ],
    "methods": [
      {
        "name": "init",
        "startLine": 8,
        "endLine": 11,
        "visibility": "internal",
        "parameters": [{"name": "participantCount", "type": "Int"}],
        "returnType": "void"
      },
      {
        "name": "updatePhase",
        "startLine": 13,
        "endLine": 15,
        "visibility": "internal",
        "parameters": [{"name": "phase", "type": "DrinkingPhase"}],
        "returnType": "void"
      }
    ]
  }],
  "enums": [{
    "name": "DrinkingPhase",
    "startLine": 17,
    "endLine": 19,
    "members": [
      {"name": "early", "line": 18},
      {"name": "middle", "line": 18},
      {"name": "late", "line": 18}
    ]
  }]
}
\`\`\``;

    const typeScriptExample = `### Example 2: TypeScript Interface

\`\`\`typescript
export interface User {
  id: number;
  name: string;
  email?: string;
}

export class UserService {
  async getUser(id: number): Promise<User> {
    // implementation
  }
}
\`\`\`

**Correct Extraction:**
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
  }],
  "classes": [{
    "name": "UserService",
    "startLine": 7,
    "endLine": 11,
    "isExported": true,
    "methods": [{
      "name": "getUser",
      "startLine": 8,
      "endLine": 10,
      "isAsync": true,
      "parameters": [{"name": "id", "type": "number"}],
      "returnType": "Promise<User>"
    }]
  }]
}
\`\`\``;

    const pythonExample = `### Example 3: Python Class

\`\`\`python
class DataProcessor:
    def __init__(self, name: str):
        self.name = name
        self._cache = {}

    def process(self, data: list) -> dict:
        return {"processed": len(data)}
\`\`\`

**Correct Extraction:**
\`\`\`json
{
  "classes": [{
    "name": "DataProcessor",
    "startLine": 1,
    "endLine": 7,
    "properties": [
      {"name": "name", "type": "str", "visibility": "public", "line": 3},
      {"name": "_cache", "type": "dict", "visibility": "private", "line": 4}
    ],
    "methods": [
      {
        "name": "__init__",
        "startLine": 2,
        "endLine": 4,
        "parameters": [{"name": "name", "type": "str"}]
      },
      {
        "name": "process",
        "startLine": 6,
        "endLine": 7,
        "parameters": [{"name": "data", "type": "list"}],
        "returnType": "dict"
      }
    ]
  }]
}
\`\`\``;

    // Return relevant examples based on language
    if (language.toLowerCase().includes('swift')) {
      return swiftExample + '\n\n' + typeScriptExample;
    } else if (language.toLowerCase().includes('typescript') || language.toLowerCase().includes('javascript')) {
      return typeScriptExample + '\n\n' + swiftExample;
    } else if (language.toLowerCase().includes('python')) {
      return pythonExample + '\n\n' + swiftExample;
    } else {
      // Default: show all examples
      return swiftExample + '\n\n' + typeScriptExample;
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
    return `You are an expert code parser. Extract ALL code entities using careful analysis.

## Step 1: Understand the Code

First, analyze what you see:

FILE: ${relativePath}
LANGUAGE: ${language}
${wasTruncated ? 'NOTE: File was truncated to first 1000 lines' : ''}

SOURCE CODE:
\`\`\`${language}
${content}
\`\`\`

- What type of code is this? (app file, model, view, utility, etc.)
- How many classes, functions, or other entities do you see?
- What are the key relationships? (inheritance, protocols, etc.)

## Step 2: Learn from Examples

${this.getFewShotExamples(language)}

## Step 3: Extract Systematically

Now extract ALL entities from the source code above.

For each entity:
1. Identify its exact location (line numbers are 1-indexed, first line = 1)
2. Capture all details (properties, methods, parameters, types)
3. Don't skip anything - be thorough

Return as JSON:

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
          "isReadonly": true/false,
          "isOptional": true/false,
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
          "isAbstract": true/false,
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
      "properties": [
        {
          "name": "propName",
          "type": "PropType",
          "isOptional": true/false,
          "isReadonly": true/false,
          "line": <1-indexed line number>
        }
      ],
      "methods": [
        {
          "name": "methodName",
          "parameters": [...],
          "returnType": "ReturnType",
          "line": <1-indexed line number>
        }
      ]
    }
  ],
  "typeAliases": [
    {
      "name": "TypeName",
      "startLine": <1-indexed line number>,
      "endLine": <1-indexed line number>,
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

## Step 4: Critical Rules

⚠️ **CRITICAL - Line Numbers:**
- Use 1-indexed line numbers (first line of file is line 1, NOT 0)
- Count carefully - line numbers are used for source code references
- Double-check your line numbers match the actual code

⚠️ **CRITICAL - Completeness:**
- Extract EVERY class, function, interface, enum, type
- Don't skip anything, even if it seems small
- Include ALL properties and methods, not just public ones

⚠️ **Language-Specific Rules:**

**Swift:**
- \`class\`, \`struct\`, \`actor\` → \`classes\` array
- \`protocol\` → \`interfaces\` array
- \`enum\` → \`enums\` array
- Capture \`@Model\`, \`@Published\`, \`@State\` decorators
- Protocol conformance (e.g., \`: ObservableObject\`) → \`implements\`
- Default visibility is \`internal\` (not public)

**TypeScript/JavaScript:**
- \`class\` → \`classes\` array
- \`interface\` → \`interfaces\` array
- \`type\` → \`typeAliases\` array
- \`export\` → set \`isExported: true\`

**Python:**
- \`class\` → \`classes\` array
- Top-level \`def\` → \`functions\` array
- Methods starting with \`_\` → \`visibility: "private"\`

**Constructors/Initializers:**
- Swift: \`init(...)\` → method with name "init"
- TypeScript: \`constructor(...)\` → method with name "constructor"
- Python: \`__init__(...)\` → method with name "__init__"

## Step 5: Output

Return ONLY valid JSON. No markdown, no explanations, just the JSON object.
Be thorough and accurate - this extraction will be used to generate documentation.`;
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
      extends: c.extends || undefined,
      implements: c.implements || [],
      properties: (c.properties || []).map((p: any): ExtractedProperty => ({
        name: p.name,
        type: p.type || 'unknown',
        visibility: p.visibility || 'public',
        isStatic: p.isStatic || false,
        isReadonly: p.isReadonly || false,
        isOptional: p.isOptional || false,
        line: p.line,
        sourceRef: createSourceRef(file, p.line),
        decorators: p.decorators || [],
      })),
      methods: (c.methods || []).map((m: any): ExtractedMethod => ({
        name: m.name,
        startLine: m.startLine,
        endLine: m.endLine,
        sourceRef: createSourceRef(file, m.startLine, m.endLine),
        signature: this.buildMethodSignature(m),
        visibility: m.visibility || 'public',
        isStatic: m.isStatic || false,
        isAsync: m.isAsync || false,
        isAbstract: m.isAbstract || false,
        isGenerator: m.isGenerator || false,
        parameters: (m.parameters || []).map((p: any): ExtractedParameter => ({
          name: p.name,
          type: p.type || 'unknown',
          isOptional: p.isOptional || false,
          isRest: p.isRest || false,
          defaultValue: p.defaultValue || undefined,
          decorators: [],
        })),
        returnType: m.returnType || 'void',
        typeParameters: m.typeParameters || [],
        decorators: m.decorators || [],
      })),
      isExported: c.isExported !== false,
      isAbstract: c.isAbstract || false,
      isDefault: c.isDefault || false,
      decorators: c.decorators || [],
      typeParameters: c.typeParameters || [],
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
      signature: this.buildFunctionSignature(f),
      isExported: f.isExported !== false,
      isDefault: f.isDefault || false,
      isAsync: f.isAsync || false,
      isGenerator: f.isGenerator || false,
      parameters: (f.parameters || []).map((p: any): ExtractedParameter => ({
        name: p.name,
        type: p.type || 'unknown',
        isOptional: p.isOptional || false,
        isRest: p.isRest || false,
        defaultValue: p.defaultValue || undefined,
        decorators: [],
      })),
      returnType: f.returnType || 'void',
      typeParameters: f.typeParameters || [],
      decorators: [],
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
      typeParameters: i.typeParameters || [],
      properties: (i.properties || []).map((p: any): ExtractedInterfaceProperty => ({
        name: p.name,
        type: p.type || 'unknown',
        isOptional: p.isOptional || false,
        isReadonly: p.isReadonly || false,
        line: p.line,
        sourceRef: createSourceRef(file, p.line),
      })),
      methods: (i.methods || []).map((m: any): ExtractedInterfaceMethod => ({
        name: m.name,
        line: m.line,
        sourceRef: createSourceRef(file, m.line),
        signature: this.buildMethodSignature(m),
        parameters: (m.parameters || []).map((p: any): ExtractedParameter => ({
          name: p.name,
          type: p.type || 'unknown',
          isOptional: p.isOptional || false,
          isRest: false,
          decorators: [],
        })),
        returnType: m.returnType || 'void',
        isOptional: m.isOptional || false,
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
      startLine: t.startLine,
      endLine: t.endLine || t.startLine,
      sourceRef: createSourceRef(file, t.startLine, t.endLine),
      definition: t.definition || 'unknown',
      isExported: t.isExported !== false,
      typeParameters: t.typeParameters || [],
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
      members: (e.members || []).map((m: any): ExtractedEnumMember => ({
        name: m.name,
        value: m.value,
        line: m.line,
        sourceRef: createSourceRef(file, m.line),
      })),
      isExported: e.isExported !== false,
      isConst: e.isConst || false,
    }));
  }

  /**
   * メソッドシグネチャを構築
   */
  private buildMethodSignature(method: any): string {
    const params = (method.parameters || [])
      .map((p: any) => `${p.name}: ${p.type || 'unknown'}`)
      .join(', ');
    return `${method.name}(${params}): ${method.returnType || 'void'}`;
  }

  /**
   * 関数シグネチャを構築
   */
  private buildFunctionSignature(func: any): string {
    const params = (func.parameters || [])
      .map((p: any) => `${p.name}: ${p.type || 'unknown'}`)
      .join(', ');
    return `${func.name}(${params}): ${func.returnType || 'void'}`;
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
      /\.min\./,
      /\.bundle\./,
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

  /**
   * キャッシュから抽出結果を読み込む
   */
  private async loadCachedExtraction(relativePath: string): Promise<FileExtractionResult | null> {
    try {
      const cached = await this.fileManager.loadJson(
        IntermediateFileType.EXTRACTION_BY_FILE,
        relativePath.replace(/[\/\\]/g, '_')
      );

      if (cached && cached.extractedAt) {
        // Check if file has been modified since extraction
        // For now, just return cached result
        return cached as FileExtractionResult;
      }
    } catch (error) {
      // Cache miss is not an error
    }
    return null;
  }

  /**
   * 抽出結果をキャッシュに保存
   */
  private async saveCachedExtraction(relativePath: string, extraction: FileExtractionResult): Promise<void> {
    try {
      await this.fileManager.saveJson(
        IntermediateFileType.EXTRACTION_BY_FILE,
        extraction,
        relativePath.replace(/[\/\\]/g, '_')
      );
    } catch (error) {
      logger.error('LLMCodeExtractor', `Failed to save cache for ${relativePath}:`, error);
    }
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
      stats: {
        totalClasses: 0,
        totalFunctions: 0,
        totalInterfaces: 0,
        totalTypes: 0,
        totalEnums: 0,
        totalConstants: 0,
        totalExports: 0,
        totalImports: 0,
      },
    };
  }
}
