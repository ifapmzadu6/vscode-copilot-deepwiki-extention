import * as vscode from 'vscode';
import * as path from 'path';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { ExtractionSummary, ExtractedClass, ExtractedFunction, ExtractedInterface } from '../types/extraction';
import {
  ModuleLLMAnalysis,
  ComponentDescription,
  KeyEntityDescription,
  ModuleDependencyDescription,
  DataFlowDescription,
  ClassLLMAnalysis,
  FunctionLLMAnalysis,
} from '../types/llmAnalysis';
import { getIntermediateFileManager, IntermediateFileType, LLMFeedbackLoop, LLMHelper, logger } from '../utils';

/**
 * モジュール情報（ディレクトリベース）
 */
interface ModuleInfo {
  name: string;
  path: string;
  files: string[];
  classes: ExtractedClass[];
  functions: ExtractedFunction[];
  interfaces: ExtractedInterface[];
  imports: Set<string>;
  exports: Set<string>;
}

/**
 * LLMモジュール分析サブエージェント
 *
 * Level 3: DEEP_ANALYSIS
 *
 * 各モジュール（ディレクトリ）をLLMで詳細分析し、以下を抽出:
 * - 目的・責務
 * - アーキテクチャパターン
 * - キーエンティティ
 * - 内部フロー
 * - 外部インターフェース
 * - 結合度・凝集度
 *
 * 出力:
 * - .deepwiki/intermediate/analysis/modules/{moduleName}.json
 */
export class LLMModuleAnalyzerSubagent extends BaseSubagent {
  id = 'llm-module-analyzer';
  name = 'LLM Module Analyzer';
  description = 'Analyzes modules using LLM for architectural insights';

  private helper!: LLMHelper;
  private feedbackLoop!: LLMFeedbackLoop;
  private fileManager: any;

  async execute(context: SubagentContext): Promise<Map<string, ModuleLLMAnalysis>> {
    const { workspaceFolder, model, progress, token, previousResults } = context;

    progress('Starting LLM module analysis...');

    this.helper = new LLMHelper(model);
    this.feedbackLoop = new LLMFeedbackLoop(model, {
      maxIterations: 3,
      targetScore: 8,
    });
    this.fileManager = getIntermediateFileManager();

    // Get extraction results from Level 2
    const extractionResult = previousResults.get('code-extractor') as ExtractionSummary | undefined;
    if (!extractionResult) {
      progress('No extraction results found');
      return new Map();
    }

    // Get class and function analyses from Level 3
    const classAnalyses = previousResults.get('llm-class-analyzer') as Map<string, ClassLLMAnalysis> | undefined;
    const functionAnalyses = previousResults.get('llm-function-analyzer') as Map<string, FunctionLLMAnalysis> | undefined;

    // Group entities by module (directory)
    const modules = this.groupByModule(extractionResult);
    progress(`Found ${modules.size} modules to analyze`);

    const results = new Map<string, ModuleLLMAnalysis>();

    // Analyze modules sequentially (they're larger, so less parallelism)
    let index = 0;
    for (const [modulePath, moduleInfo] of modules) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      index++;
      progress(`Analyzing module ${index}/${modules.size}: ${moduleInfo.name}...`);

      try {
        const analysis = await this.analyzeModule(
          moduleInfo,
          workspaceFolder,
          classAnalyses,
          functionAnalyses,
          token
        );

        if (analysis) {
          results.set(modulePath, analysis);

          // Save to intermediate file
          await this.fileManager.saveJson(IntermediateFileType.ANALYSIS_MODULE, analysis, moduleInfo.name, {
            llmAnalyzed: true,
            llmScore: analysis.llmScore,
            llmIterations: analysis.llmIterations,
          });
        }
      } catch (error) {
        logger.error('LLMModuleAnalyzer', `Failed to analyze module ${moduleInfo.name}:`, error);
      }
    }

    progress(`Module analysis complete: ${results.size} modules analyzed`);

    return results;
  }

  /**
   * 抽出結果をモジュールごとにグループ化
   */
  private groupByModule(extraction: ExtractionSummary): Map<string, ModuleInfo> {
    const modules = new Map<string, ModuleInfo>();

    // Helper to get module path from file path
    const getModulePath = (filePath: string): string => {
      const dir = path.dirname(filePath);
      // src/subagents/foo.ts -> src/subagents
      return dir;
    };

    // Helper to get or create module info
    const getModuleInfo = (modulePath: string): ModuleInfo => {
      if (!modules.has(modulePath)) {
        const name = path.basename(modulePath) || 'root';
        modules.set(modulePath, {
          name,
          path: modulePath,
          files: [],
          classes: [],
          functions: [],
          interfaces: [],
          imports: new Set(),
          exports: new Set(),
        });
      }
      return modules.get(modulePath)!;
    };

    // Group classes
    for (const cls of extraction.classes) {
      const modulePath = getModulePath(cls.file);
      const module = getModuleInfo(modulePath);
      module.classes.push(cls);
      if (!module.files.includes(cls.file)) {
        module.files.push(cls.file);
      }
    }

    // Group functions
    for (const func of extraction.functions) {
      const modulePath = getModulePath(func.file);
      const module = getModuleInfo(modulePath);
      module.functions.push(func);
      if (!module.files.includes(func.file)) {
        module.files.push(func.file);
      }
    }

    // Group interfaces
    for (const iface of extraction.interfaces) {
      const modulePath = getModulePath(iface.file);
      const module = getModuleInfo(modulePath);
      module.interfaces.push(iface);
      if (!module.files.includes(iface.file)) {
        module.files.push(iface.file);
      }
    }

    // Collect imports/exports
    for (const imp of extraction.imports) {
      const modulePath = getModulePath(imp.file);
      const module = getModuleInfo(modulePath);
      module.imports.add(imp.source);
    }

    for (const exp of extraction.exports) {
      const modulePath = getModulePath(exp.file);
      const module = getModuleInfo(modulePath);
      module.exports.add(exp.name);
    }

    // Filter out very small modules (less than 2 files)
    const significantModules = new Map<string, ModuleInfo>();
    for (const [path, info] of modules) {
      if (info.files.length >= 2 || info.classes.length > 0) {
        significantModules.set(path, info);
      }
    }

    return significantModules;
  }

  /**
   * 単一モジュールを分析
   */
  private async analyzeModule(
    module: ModuleInfo,
    workspaceFolder: vscode.WorkspaceFolder,
    classAnalyses: Map<string, ClassLLMAnalysis> | undefined,
    functionAnalyses: Map<string, FunctionLLMAnalysis> | undefined,
    token: vscode.CancellationToken
  ): Promise<ModuleLLMAnalysis | null> {
    // Build context from previous analyses
    const classContext = this.buildClassContext(module.classes, classAnalyses);
    const functionContext = this.buildFunctionContext(module.functions, functionAnalyses);

    // Generate analysis prompt
    const generatePrompt = this.buildGeneratePrompt(module, classContext, functionContext);

    // Review prompt template
    const reviewPromptTemplate = (content: string) => this.buildReviewPrompt(module, content);

    // Improve prompt template
    const improvePromptTemplate = (content: string, feedback: string) =>
      this.buildImprovePrompt(module, content, feedback);

    try {
      // Run feedback loop
      const result = await this.feedbackLoop.generateWithFeedback(
        generatePrompt,
        reviewPromptTemplate,
        improvePromptTemplate
      );

      // Parse the result
      const analysis = this.parseAnalysisResult(result.improved, module, result.score, result.iterations);

      return analysis;
    } catch (error) {
      logger.error('LLMModuleAnalyzer', `Analysis failed for ${module.name}:`, error);
      return this.createFallbackAnalysis(module);
    }
  }

  /**
   * クラス分析からコンテキストを構築
   */
  private buildClassContext(
    classes: ExtractedClass[],
    analyses: Map<string, ClassLLMAnalysis> | undefined
  ): string {
    if (!analyses || classes.length === 0) {
      return classes.map((c) => `- ${c.name}: ${c.methods.length} methods, ${c.properties.length} properties`).join('\n');
    }

    return classes
      .map((c) => {
        const analysis = analyses.get(c.name);
        if (analysis) {
          return `- **${c.name}** (${analysis.category}): ${analysis.purpose}`;
        }
        return `- ${c.name}: ${c.methods.length} methods`;
      })
      .join('\n');
  }

  /**
   * 関数分析からコンテキストを構築
   */
  private buildFunctionContext(
    functions: ExtractedFunction[],
    analyses: Map<string, FunctionLLMAnalysis> | undefined
  ): string {
    const exportedFunctions = functions.filter((f) => f.isExported);
    if (!analyses || exportedFunctions.length === 0) {
      return exportedFunctions.map((f) => `- ${f.name}(${f.parameters.map((p) => p.name).join(', ')})`).join('\n');
    }

    return exportedFunctions
      .map((f) => {
        const key = `${path.basename(f.file, path.extname(f.file))}_${f.name}`;
        const analysis = analyses.get(key);
        if (analysis) {
          return `- **${f.name}** (${analysis.category}): ${analysis.purpose}`;
        }
        return `- ${f.name}(${f.parameters.map((p) => p.name).join(', ')})`;
      })
      .join('\n');
  }

  /**
   * 分析生成プロンプトを構築
   */
  private buildGeneratePrompt(module: ModuleInfo, classContext: string, functionContext: string): string {
    const importList = Array.from(module.imports).slice(0, 20).join(', ');
    const exportList = Array.from(module.exports).slice(0, 20).join(', ');

    return `Analyze this module/directory as an architectural unit and provide insights.

## Module Information

**Name:** ${module.name}
**Path:** ${module.path}
**Files:** ${module.files.length} files

### Key Classes (${module.classes.length})
${classContext || '  (none)'}

### Key Functions (${module.functions.filter((f) => f.isExported).length} exported)
${functionContext || '  (none)'}

### Interfaces (${module.interfaces.length})
${module.interfaces.map((i) => `- ${i.name}`).join('\n') || '  (none)'}

### Dependencies (imports)
${importList || '  (none)'}

### Public API (exports)
${exportList || '  (none)'}

## Analysis Required

Provide a detailed JSON analysis with the following structure:

\`\`\`json
{
  "purpose": "1-2 sentence description of this module's purpose",
  "responsibilities": ["responsibility 1", "responsibility 2"],
  "category": "core|feature|utility|infrastructure|integration|other",
  "architecture": {
    "pattern": "The architectural pattern used (e.g., MVC, Repository, Factory)",
    "layers": ["layer1", "layer2"],
    "components": [
      {
        "name": "ComponentName",
        "type": "class|function|subsystem",
        "role": "What role this component plays"
      }
    ]
  },
  "keyClasses": [
    {
      "name": "ClassName",
      "importance": "critical|high|medium",
      "summary": "Brief summary of why this class is important"
    }
  ],
  "keyFunctions": [
    {
      "name": "functionName",
      "importance": "critical|high|medium",
      "summary": "Brief summary of why this function is important"
    }
  ],
  "keyTypes": [
    {
      "name": "TypeName",
      "importance": "critical|high|medium",
      "summary": "Brief summary of why this type is important"
    }
  ],
  "internalFlow": "How data/control flows within this module",
  "externalInterface": "How external code interacts with this module",
  "dependencies": [
    {
      "module": "module name",
      "purpose": "Why this dependency is needed",
      "coupling": "tight|loose"
    }
  ],
  "dependents": [
    {
      "module": "module name",
      "purpose": "Why that module depends on this",
      "coupling": "tight|loose"
    }
  ],
  "dataFlow": {
    "inputs": [{"name": "input name", "source": "where it comes from"}],
    "outputs": [{"name": "output name", "destination": "where it goes"}],
    "transformations": ["transformation 1", "transformation 2"]
  },
  "cohesion": "low|medium|high",
  "coupling": "low|medium|high",
  "suggestions": ["Optional improvement suggestions"]
}
\`\`\`

Focus on architectural insights and relationships.
Be specific about the actual files and entities in this module.
Do NOT make up information - only analyze what is present.`;
  }

  /**
   * レビュープロンプトを構築
   */
  private buildReviewPrompt(module: ModuleInfo, content: string): string {
    return `Review this module analysis for quality and accuracy.

## Module Being Analyzed
**Name:** ${module.name}
**Path:** ${module.path}
**Files:** ${module.files.length}
**Classes:** ${module.classes.length}
**Functions:** ${module.functions.length}

## Analysis to Review
${content}

## Evaluation Criteria (Score each 1-10)

1. **Architectural Accuracy** (weight: 30%)
   - Is the architecture pattern correctly identified?
   - Are the layers and components accurate?

2. **Relationship Understanding** (weight: 25%)
   - Are dependencies correctly identified?
   - Is the data flow accurately described?

3. **Key Entity Identification** (weight: 25%)
   - Are the most important classes/functions highlighted?
   - Is their importance correctly assessed?

4. **Usefulness** (weight: 20%)
   - Would this help someone understand the module?
   - Are the insights actionable?

## Response Format

Respond with JSON:
\`\`\`json
{
  "score": <weighted average 1-10>,
  "feedback": "Overall assessment",
  "issues": [
    {"criterion": "Architectural Accuracy", "issue": "specific issue"}
  ],
  "suggestions": [
    "Specific suggestion 1"
  ]
}
\`\`\``;
  }

  /**
   * 改善プロンプトを構築
   */
  private buildImprovePrompt(module: ModuleInfo, content: string, feedback: string): string {
    return `Improve this module analysis based on the feedback.

## Current Analysis
${content}

## Feedback
${feedback}

## Improvement Instructions

1. Address ALL issues mentioned in the feedback
2. Be more specific about actual file and entity names
3. Improve architectural insights
4. Do NOT make up information

Provide the improved analysis in the SAME JSON format as before.`;
  }

  /**
   * 分析結果をパース
   */
  private parseAnalysisResult(
    content: string,
    module: ModuleInfo,
    score: number,
    iterations: number
  ): ModuleLLMAnalysis {
    try {
      // Extract JSON from response
      const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || content.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const jsonStr = jsonMatch[1] || jsonMatch[0];
        const parsed = JSON.parse(jsonStr);

        return {
          name: module.name,
          path: module.path,
          purpose: parsed.purpose || `Module ${module.name}`,
          responsibilities: parsed.responsibilities || [],
          category: parsed.category || 'other',
          architecture: {
            pattern: parsed.architecture?.pattern || 'unknown',
            layers: parsed.architecture?.layers,
            components: (parsed.architecture?.components || []).map((c: any): ComponentDescription => ({
              name: c.name,
              type: c.type || 'class',
              role: c.role || '',
            })),
          },
          keyClasses: this.parseKeyEntities(parsed.keyClasses, module.classes),
          keyFunctions: this.parseKeyEntities(parsed.keyFunctions, module.functions),
          keyTypes: this.parseKeyEntities(parsed.keyTypes, module.interfaces),
          internalFlow: parsed.internalFlow || 'Not analyzed',
          externalInterface: parsed.externalInterface || 'Not analyzed',
          dependencies: (parsed.dependencies || []).map((d: any): ModuleDependencyDescription => ({
            module: d.module,
            purpose: d.purpose || '',
            coupling: d.coupling || 'loose',
          })),
          dependents: (parsed.dependents || []).map((d: any): ModuleDependencyDescription => ({
            module: d.module,
            purpose: d.purpose || '',
            coupling: d.coupling || 'loose',
          })),
          dataFlow: this.parseDataFlow(parsed.dataFlow),
          cohesion: parsed.cohesion || 'medium',
          coupling: parsed.coupling || 'medium',
          suggestions: parsed.suggestions,
          llmScore: score,
          llmIterations: iterations,
          analyzedAt: new Date().toISOString(),
        };
      }
    } catch (error) {
      logger.error('LLMModuleAnalyzer', `Failed to parse analysis for ${module.name}:`, error);
    }

    return this.createFallbackAnalysis(module);
  }

  /**
   * キーエンティティをパース
   */
  private parseKeyEntities(
    parsed: any[],
    entities: Array<{ name: string; file: string; startLine: number; endLine?: number }>
  ): KeyEntityDescription[] {
    if (!parsed) return [];

    return parsed.map((p: any): KeyEntityDescription => {
      const entity = entities.find((e) => e.name === p.name);
      return {
        name: p.name,
        sourceRef: entity
          ? { file: entity.file, startLine: entity.startLine, endLine: entity.endLine }
          : { file: '', startLine: 0 },
        importance: p.importance || 'medium',
        summary: p.summary || '',
      };
    });
  }

  /**
   * データフローをパース
   */
  private parseDataFlow(parsed: any): DataFlowDescription {
    if (!parsed) {
      return {
        inputs: [],
        outputs: [],
        transformations: [],
      };
    }

    return {
      inputs: (parsed.inputs || []).map((i: any) => ({
        name: i.name || '',
        source: i.source || '',
      })),
      outputs: (parsed.outputs || []).map((o: any) => ({
        name: o.name || '',
        destination: o.destination || '',
      })),
      transformations: parsed.transformations || [],
    };
  }

  /**
   * フォールバック分析を作成
   */
  private createFallbackAnalysis(module: ModuleInfo): ModuleLLMAnalysis {
    return {
      name: module.name,
      path: module.path,
      purpose: `Module ${module.name}`,
      responsibilities: [],
      category: 'other',
      architecture: {
        pattern: 'unknown',
        components: [],
      },
      keyClasses: module.classes.slice(0, 5).map((c): KeyEntityDescription => ({
        name: c.name,
        sourceRef: c.sourceRef,
        importance: 'medium',
        summary: '',
      })),
      keyFunctions: module.functions.filter((f) => f.isExported).slice(0, 5).map((f): KeyEntityDescription => ({
        name: f.name,
        sourceRef: f.sourceRef,
        importance: 'medium',
        summary: '',
      })),
      keyTypes: module.interfaces.slice(0, 5).map((i): KeyEntityDescription => ({
        name: i.name,
        sourceRef: i.sourceRef,
        importance: 'medium',
        summary: '',
      })),
      internalFlow: 'Not analyzed',
      externalInterface: 'Not analyzed',
      dependencies: [],
      dependents: [],
      dataFlow: {
        inputs: [],
        outputs: [],
        transformations: [],
      },
      cohesion: 'medium',
      coupling: 'medium',
      llmScore: 0,
      llmIterations: 0,
      analyzedAt: new Date().toISOString(),
    };
  }
}
