import * as vscode from 'vscode';
import * as path from 'path';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { ExtractedFunction, formatSourceRef, ExtractionSummary } from '../types/extraction';
import { FunctionLLMAnalysis, ParameterAnalysis, ErrorScenario, GeneratedExample } from '../types/llmAnalysis';
import { getIntermediateFileManager, IntermediateFileType, LLMFeedbackLoop, LLMHelper, logger } from '../utils';

/**
 * LLM関数分析サブエージェント
 *
 * Level 3: DEEP_ANALYSIS
 *
 * 各関数をLLMで詳細分析し、以下を抽出:
 * - 目的・責務
 * - アルゴリズム
 * - 計算量
 * - 入出力分析
 * - エラーハンドリング
 * - 使用例
 *
 * LLMフィードバックループ:
 * 1. 初期分析生成
 * 2. 品質レビュー（スコア評価）
 * 3. 改善（スコア < 8 の場合）
 * 4. 最終確認
 *
 * 出力:
 * - .deepwiki/intermediate/analysis/functions/{functionName}.json
 */
export class LLMFunctionAnalyzerSubagent extends BaseSubagent {
  id = 'llm-function-analyzer';
  name = 'LLM Function Analyzer';
  description = 'Analyzes functions using LLM with feedback loop for deep insights';

  private helper!: LLMHelper;
  private feedbackLoop!: LLMFeedbackLoop;
  private fileManager: any;

  async execute(context: SubagentContext): Promise<Map<string, FunctionLLMAnalysis>> {
    const { workspaceFolder, model, progress, token, previousResults } = context;

    progress('Starting LLM function analysis...');

    this.helper = new LLMHelper(model);
    this.feedbackLoop = new LLMFeedbackLoop(model, {
      maxIterations: 3, // 関数は比較的シンプルなので3回まで
      targetScore: 8, // 目標スコア 8/10
    });
    this.fileManager = getIntermediateFileManager();

    // Get extraction results from Level 2
    const extractionResult = previousResults.get('code-extractor') as ExtractionSummary | undefined;
    if (!extractionResult || extractionResult.functions.length === 0) {
      progress('No functions to analyze');
      return new Map();
    }

    // Filter to only exported functions (public API)
    const functions = extractionResult.functions.filter((f) => f.isExported);
    progress(`Found ${functions.length} exported functions to analyze`);

    const results = new Map<string, FunctionLLMAnalysis>();

    // Analyze functions in parallel batches
    const batchSize = 5; // 関数は小さいので並列度を上げる
    let totalLLMCalls = 0;

    for (let i = 0; i < functions.length; i += batchSize) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      const batch = functions.slice(i, i + batchSize);
      progress(`Analyzing functions ${i + 1}-${Math.min(i + batchSize, functions.length)} of ${functions.length}...`);

      const batchPromises = batch.map(async (func) => {
        try {
          const analysis = await this.analyzeFunction(func, workspaceFolder, token);
          if (analysis) {
            totalLLMCalls += analysis.llmIterations;
            return { name: this.getFunctionKey(func), analysis };
          }
        } catch (error) {
          logger.error('LLMFunctionAnalyzer', `Failed to analyze ${func.name}:`, error);
        }
        return null;
      });

      const batchResults = await Promise.all(batchPromises);

      for (const result of batchResults) {
        if (result) {
          results.set(result.name, result.analysis);

          // Save to intermediate file
          await this.fileManager.saveJson(IntermediateFileType.ANALYSIS_FUNCTION, result.analysis, result.name, {
            llmAnalyzed: true,
            llmScore: result.analysis.llmScore,
            llmIterations: result.analysis.llmIterations,
          });
        }
      }
    }

    progress(`Function analysis complete: ${results.size} functions analyzed with ${totalLLMCalls} LLM calls`);

    return results;
  }

  /**
   * 関数のユニークキーを生成
   */
  private getFunctionKey(func: ExtractedFunction): string {
    // ファイル名と関数名を組み合わせてユニークキーを生成
    const fileName = path.basename(func.file, path.extname(func.file));
    return `${fileName}_${func.name}`;
  }

  /**
   * 単一関数を分析
   */
  private async analyzeFunction(
    func: ExtractedFunction,
    workspaceFolder: vscode.WorkspaceFolder,
    token: vscode.CancellationToken
  ): Promise<FunctionLLMAnalysis | null> {
    // Read the actual source code
    const sourceCode = await this.readFunctionSource(func, workspaceFolder);
    if (!sourceCode) {
      return null;
    }

    // Generate analysis prompt
    const generatePrompt = this.buildGeneratePrompt(func, sourceCode);

    // Review prompt template
    const reviewPromptTemplate = (content: string) => this.buildReviewPrompt(func, content);

    // Improve prompt template
    const improvePromptTemplate = (content: string, feedback: string) =>
      this.buildImprovePrompt(func, content, feedback);

    try {
      // Run feedback loop
      const result = await this.feedbackLoop.generateWithFeedback(
        generatePrompt,
        reviewPromptTemplate,
        improvePromptTemplate
      );

      // Parse the result
      const analysis = this.parseAnalysisResult(result.improved, func, result.score, result.iterations);

      return analysis;
    } catch (error) {
      logger.error('LLMFunctionAnalyzer', `Analysis failed for ${func.name}:`, error);
      return this.createFallbackAnalysis(func);
    }
  }

  /**
   * 関数のソースコードを読み込む
   */
  private async readFunctionSource(
    func: ExtractedFunction,
    workspaceFolder: vscode.WorkspaceFolder
  ): Promise<string | null> {
    try {
      const uri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, func.file));
      const content = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(content).toString('utf-8');
      const lines = text.split('\n');

      // Extract function code (with some context)
      const startLine = Math.max(0, func.startLine - 3); // 3 lines before for context
      const endLine = Math.min(lines.length, func.endLine + 1);

      return lines.slice(startLine, endLine).join('\n');
    } catch (error) {
      return null;
    }
  }

  /**
   * 分析生成プロンプトを構築
   */
  private buildGeneratePrompt(func: ExtractedFunction, sourceCode: string): string {
    const paramList = func.parameters
      .map((p) => `  - ${p.name}: ${p.type}${p.isOptional ? ' (optional)' : ''}${p.defaultValue ? ` = ${p.defaultValue}` : ''}`)
      .join('\n');

    return `Analyze this function in detail and provide a comprehensive technical analysis.

## Function Information

**Name:** ${func.name}
**File:** ${func.file}
**Location:** ${formatSourceRef(func.sourceRef)}
**Signature:** ${func.signature}
**Return Type:** ${func.returnType}
**Async:** ${func.isAsync}
**Exported:** ${func.isExported}

### Parameters (${func.parameters.length})
${paramList || '  (none)'}

${func.jsdoc ? `### JSDoc\n${func.jsdoc}\n` : ''}

## Source Code

\`\`\`${this.getLanguage(func.file)}
${sourceCode}
\`\`\`

## Analysis Required

Provide a detailed JSON analysis with the following structure:

\`\`\`json
{
  "purpose": "1-2 sentence description of what this function does and why it exists",
  "category": "utility|handler|transformer|validator|factory|hook|middleware|other",
  "algorithm": "Brief description of the algorithm/approach used",
  "complexity": {
    "time": "O(n) or similar",
    "space": "O(1) or similar"
  },
  "keySteps": ["step 1", "step 2", "step 3"],
  "inputDescription": [
    {
      "name": "paramName",
      "type": "paramType",
      "purpose": "What this parameter is used for",
      "constraints": "Any constraints or valid ranges",
      "defaultBehavior": "What happens if not provided (for optional params)"
    }
  ],
  "outputDescription": "Description of what the function returns and when",
  "sideEffects": ["side effect 1", "side effect 2"],
  "errorScenarios": [
    {
      "condition": "When does this error occur",
      "behavior": "What happens (throw, return null, etc)",
      "recoverable": true/false
    }
  ],
  "usagePatterns": ["Pattern 1: how this function is typically used"],
  "examples": [
    {
      "title": "Basic Usage",
      "description": "Description of the example",
      "code": "example code snippet"
    }
  ],
  "suggestions": ["Optional improvement suggestions"]
}
\`\`\`

Be specific and technical. Use actual names from the code.
Focus on the ACTUAL implementation details you can see in the source.
Do NOT make up information - only analyze what is present in the code.`;
  }

  /**
   * レビュープロンプトを構築
   */
  private buildReviewPrompt(func: ExtractedFunction, content: string): string {
    return `Review this function analysis for quality and accuracy.

## Function Being Analyzed
**Name:** ${func.name}
**File:** ${func.file}
**Signature:** ${func.signature}

## Analysis to Review
${content}

## Evaluation Criteria (Score each 1-10)

1. **Technical Accuracy** (weight: 30%)
   - Does the analysis match what the code actually does?
   - Is the algorithm description correct?
   - Are complexity estimates accurate?

2. **Completeness** (weight: 25%)
   - Are all parameters described?
   - Are error scenarios covered?
   - Is the return value explained?

3. **Specificity** (weight: 25%)
   - Does it use actual names from the code?
   - Are descriptions specific, not generic?
   - Are real implementation details mentioned?

4. **Usefulness** (weight: 20%)
   - Would a developer find this helpful?
   - Are the usage examples practical?
   - Is the purpose clear?

## Response Format

Respond with JSON:
\`\`\`json
{
  "score": <weighted average 1-10>,
  "feedback": "Overall assessment",
  "issues": [
    {"criterion": "Technical Accuracy", "issue": "specific issue"},
    {"criterion": "Completeness", "issue": "specific issue"}
  ],
  "suggestions": [
    "Specific suggestion 1",
    "Specific suggestion 2"
  ]
}
\`\`\``;
  }

  /**
   * 改善プロンプトを構築
   */
  private buildImprovePrompt(func: ExtractedFunction, content: string, feedback: string): string {
    return `Improve this function analysis based on the feedback.

## Current Analysis
${content}

## Feedback
${feedback}

## Improvement Instructions

1. Address ALL issues mentioned in the feedback
2. Keep information that is already accurate
3. Add more specific details from the code
4. Improve usage examples to be more practical
5. Do NOT make up information

Provide the improved analysis in the SAME JSON format as before.
The improved analysis should score higher on all criteria.`;
  }

  /**
   * 分析結果をパース
   */
  private parseAnalysisResult(
    content: string,
    func: ExtractedFunction,
    score: number,
    iterations: number
  ): FunctionLLMAnalysis {
    try {
      // Extract JSON from response
      const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || content.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const jsonStr = jsonMatch[1] || jsonMatch[0];
        const parsed = JSON.parse(jsonStr);

        // Validate and transform to FunctionLLMAnalysis
        return {
          name: func.name,
          sourceRef: func.sourceRef,
          purpose: parsed.purpose || `Function ${func.name}`,
          category: parsed.category || 'other',
          algorithm: parsed.algorithm || 'Not analyzed',
          complexity: {
            time: parsed.complexity?.time || 'unknown',
            space: parsed.complexity?.space || 'unknown',
          },
          keySteps: parsed.keySteps || [],
          inputDescription: (parsed.inputDescription || []).map((p: any): ParameterAnalysis => ({
            name: p.name,
            type: p.type || 'unknown',
            purpose: p.purpose || '',
            constraints: p.constraints,
            defaultBehavior: p.defaultBehavior,
          })),
          outputDescription: parsed.outputDescription || func.returnType,
          sideEffects: parsed.sideEffects || [],
          errorScenarios: (parsed.errorScenarios || []).map((e: any): ErrorScenario => ({
            condition: e.condition || '',
            behavior: e.behavior || '',
            recoverable: e.recoverable !== false,
          })),
          usagePatterns: parsed.usagePatterns || [],
          examples: (parsed.examples || []).map((ex: any): GeneratedExample => ({
            title: ex.title || 'Example',
            description: ex.description || '',
            code: ex.code || '',
          })),
          suggestions: parsed.suggestions,
          llmScore: score,
          llmIterations: iterations,
          analyzedAt: new Date().toISOString(),
        };
      }
    } catch (error) {
      logger.error('LLMFunctionAnalyzer', `Failed to parse analysis for ${func.name}:`, error);
    }

    return this.createFallbackAnalysis(func);
  }

  /**
   * フォールバック分析を作成
   */
  private createFallbackAnalysis(func: ExtractedFunction): FunctionLLMAnalysis {
    return {
      name: func.name,
      sourceRef: func.sourceRef,
      purpose: `Function ${func.name} in ${func.file}`,
      category: 'other',
      algorithm: 'Not analyzed',
      complexity: {
        time: 'unknown',
        space: 'unknown',
      },
      keySteps: [],
      inputDescription: func.parameters.map((p): ParameterAnalysis => ({
        name: p.name,
        type: p.type,
        purpose: '',
      })),
      outputDescription: func.returnType,
      sideEffects: [],
      errorScenarios: [],
      usagePatterns: [],
      examples: [],
      llmScore: 0,
      llmIterations: 0,
      analyzedAt: new Date().toISOString(),
    };
  }

  /**
   * ファイル拡張子から言語を取得
   */
  private getLanguage(file: string): string {
    const ext = path.extname(file).toLowerCase();
    const map: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.swift': 'swift',
      '.py': 'python',
      '.go': 'go',
      '.rs': 'rust',
      '.java': 'java',
      '.kt': 'kotlin',
    };
    return map[ext] || 'text';
  }
}
