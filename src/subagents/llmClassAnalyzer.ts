import * as vscode from 'vscode';
import * as path from 'path';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { ExtractedClass, formatSourceRef, ExtractionSummary } from '../types/extraction';
import { ClassLLMAnalysis, MethodAnalysis, IdentifiedPattern } from '../types/llmAnalysis';
import { getIntermediateFileManager, IntermediateFileType, LLMFeedbackLoop, LLMHelper, logger } from '../utils';

/**
 * LLMクラス分析サブエージェント
 *
 * Level 3: DEEP_ANALYSIS
 *
 * 各クラスをLLMで詳細分析し、以下を抽出:
 * - 目的・責務
 * - デザインパターン
 * - キーメソッドの分析
 * - 状態管理
 * - エラーハンドリング
 * - 依存関係
 *
 * LLMフィードバックループ:
 * 1. 初期分析生成
 * 2. 品質レビュー（スコア評価）
 * 3. 改善（スコア < 8 の場合）
 * 4. 最終確認
 *
 * 出力:
 * - .deepwiki/intermediate/analysis/classes/{ClassName}.json
 */
export class LLMClassAnalyzerSubagent extends BaseSubagent {
  id = 'llm-class-analyzer';
  name = 'LLM Class Analyzer';
  description = 'Analyzes classes using LLM with feedback loop for deep insights';

  private helper!: LLMHelper;
  private feedbackLoop!: LLMFeedbackLoop;
  private fileManager: any;

  async execute(context: SubagentContext): Promise<Map<string, ClassLLMAnalysis>> {
    const { workspaceFolder, model, progress, token, previousResults } = context;

    progress('Starting LLM class analysis...');

    this.helper = new LLMHelper(model);
    this.feedbackLoop = new LLMFeedbackLoop(model, {
      maxIterations: 4, // 最大4回のフィードバックループ
      targetScore: 8, // 目標スコア 8/10
    });
    this.fileManager = getIntermediateFileManager();

    // Get extraction results from Level 2
    const extractionResult = previousResults.get('code-extractor') as ExtractionSummary | undefined;
    if (!extractionResult || extractionResult.classes.length === 0) {
      progress('No classes to analyze');
      return new Map();
    }

    const classes = extractionResult.classes;
    progress(`Found ${classes.length} classes to analyze`);

    const results = new Map<string, ClassLLMAnalysis>();

    // Analyze classes in parallel batches
    const batchSize = 3; // 並列で3つずつ処理
    let totalLLMCalls = 0;

    for (let i = 0; i < classes.length; i += batchSize) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      const batch = classes.slice(i, i + batchSize);
      progress(`Analyzing classes ${i + 1}-${Math.min(i + batchSize, classes.length)} of ${classes.length}...`);

      const batchPromises = batch.map(async (cls) => {
        try {
          const analysis = await this.analyzeClass(cls, workspaceFolder, token);
          if (analysis) {
            totalLLMCalls += analysis.llmIterations;
            return { name: cls.name, analysis };
          }
        } catch (error) {
          logger.error('LLMClassAnalyzer', `Failed to analyze ${cls.name}:`, error);
        }
        return null;
      });

      const batchResults = await Promise.all(batchPromises);

      for (const result of batchResults) {
        if (result) {
          results.set(result.name, result.analysis);

          // Save to intermediate file
          await this.fileManager.saveJson(IntermediateFileType.ANALYSIS_CLASS, result.analysis, result.name, {
            llmAnalyzed: true,
            llmScore: result.analysis.llmScore,
            llmIterations: result.analysis.llmIterations,
          });
        }
      }
    }

    progress(`Class analysis complete: ${results.size} classes analyzed with ${totalLLMCalls} LLM calls`);

    return results;
  }

  /**
   * 単一クラスを分析
   */
  private async analyzeClass(
    cls: ExtractedClass,
    workspaceFolder: vscode.WorkspaceFolder,
    token: vscode.CancellationToken
  ): Promise<ClassLLMAnalysis | null> {
    // Read the actual source code
    const sourceCode = await this.readClassSource(cls, workspaceFolder);
    if (!sourceCode) {
      return null;
    }

    const sourceRef = cls.sourceRef;

    // Generate analysis prompt
    const generatePrompt = this.buildGeneratePrompt(cls, sourceCode);

    // Review prompt template
    const reviewPromptTemplate = (content: string) => this.buildReviewPrompt(cls, content);

    // Improve prompt template
    const improvePromptTemplate = (content: string, feedback: string) =>
      this.buildImprovePrompt(cls, content, feedback);

    try {
      // Run feedback loop
      const result = await this.feedbackLoop.generateWithFeedback(
        generatePrompt,
        reviewPromptTemplate,
        improvePromptTemplate
      );

      // Parse the result
      const analysis = this.parseAnalysisResult(result.improved, cls, result.score, result.iterations);

      return analysis;
    } catch (error) {
      logger.error('LLMClassAnalyzer', `Analysis failed for ${cls.name}:`, error);
      return this.createFallbackAnalysis(cls);
    }
  }

  /**
   * クラスのソースコードを読み込む
   */
  private async readClassSource(
    cls: ExtractedClass,
    workspaceFolder: vscode.WorkspaceFolder
  ): Promise<string | null> {
    try {
      const uri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, cls.file));
      const content = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(content).toString('utf-8');
      const lines = text.split('\n');

      // Extract class code (with some context)
      const startLine = Math.max(0, cls.startLine - 5); // 5 lines before for context (imports, comments)
      const endLine = Math.min(lines.length, cls.endLine + 2);

      return lines.slice(startLine, endLine).join('\n');
    } catch (error) {
      return null;
    }
  }

  /**
   * 分析生成プロンプトを構築
   */
  private buildGeneratePrompt(cls: ExtractedClass, sourceCode: string): string {
    const methodList = cls.methods
      .map((m) => `  - ${m.name}(${m.parameters.map((p) => p.name).join(', ')}): ${m.returnType}`)
      .join('\n');

    const propertyList = cls.properties.map((p) => `  - ${p.name}: ${p.type}`).join('\n');

    return `Analyze this class in detail and provide a comprehensive technical analysis.

## Class Information

**Name:** ${cls.name}
**File:** ${cls.file}
**Location:** ${formatSourceRef(cls.sourceRef)}
${cls.extends ? `**Extends:** ${cls.extends}` : ''}
${cls.implements.length > 0 ? `**Implements:** ${cls.implements.join(', ')}` : ''}
**Exported:** ${cls.isExported}
**Abstract:** ${cls.isAbstract}

### Properties (${cls.properties.length})
${propertyList || '  (none)'}

### Methods (${cls.methods.length})
${methodList || '  (none)'}

## Source Code

\`\`\`${this.getLanguage(cls.file)}
${sourceCode}
\`\`\`

## Analysis Required

Provide a detailed JSON analysis with the following structure:

\`\`\`json
{
  "purpose": "1-2 sentence description of what this class does and why it exists",
  "responsibilities": ["responsibility 1", "responsibility 2", "..."],
  "category": "controller|service|model|utility|factory|builder|adapter|other",
  "designPatterns": [
    {
      "name": "Pattern Name",
      "type": "creational|structural|behavioral|architectural",
      "confidence": 0.0-1.0,
      "explanation": "Why this pattern applies",
      "elements": ["element1", "element2"]
    }
  ],
  "keyMethods": [
    {
      "name": "methodName",
      "purpose": "What this method does",
      "algorithm": "Brief description of the algorithm/logic",
      "complexity": "O(n) or similar",
      "sideEffects": ["side effect 1", "side effect 2"]
    }
  ],
  "stateManagement": "How this class manages its internal state",
  "lifecycle": "Any lifecycle patterns (initialization, cleanup, etc.)",
  "errorHandling": "How errors are handled in this class",
  "dependencies": [
    {
      "name": "DependencyName",
      "role": "What role this dependency plays",
      "isRequired": true/false
    }
  ],
  "usedBy": ["List of likely consumers based on its purpose"],
  "complexity": "low|medium|high",
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
  private buildReviewPrompt(cls: ExtractedClass, content: string): string {
    return `Review this class analysis for quality and accuracy.

## Class Being Analyzed
**Name:** ${cls.name}
**File:** ${cls.file}

## Analysis to Review
${content}

## Evaluation Criteria (Score each 1-10)

1. **Technical Accuracy** (weight: 30%)
   - Does the analysis match what the code actually does?
   - Are the identified patterns correct?
   - Are method descriptions accurate?

2. **Completeness** (weight: 25%)
   - Are all important methods analyzed?
   - Are dependencies identified?
   - Is the purpose clearly stated?

3. **Specificity** (weight: 25%)
   - Does it use actual names from the code?
   - Are descriptions specific, not generic?
   - Are real implementation details mentioned?

4. **Usefulness** (weight: 20%)
   - Would a developer find this helpful?
   - Does it explain WHY, not just WHAT?
   - Are the insights actionable?

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
  private buildImprovePrompt(cls: ExtractedClass, content: string, feedback: string): string {
    return `Improve this class analysis based on the feedback.

## Current Analysis
${content}

## Feedback
${feedback}

## Improvement Instructions

1. Address ALL issues mentioned in the feedback
2. Keep information that is already accurate
3. Add more specific details from the code
4. Use actual names and line references where possible
5. Do NOT make up information

Provide the improved analysis in the SAME JSON format as before.
The improved analysis should score higher on all criteria.`;
  }

  /**
   * 分析結果をパース
   */
  private parseAnalysisResult(
    content: string,
    cls: ExtractedClass,
    score: number,
    iterations: number
  ): ClassLLMAnalysis {
    try {
      // Extract JSON from response
      const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || content.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const jsonStr = jsonMatch[1] || jsonMatch[0];
        const parsed = JSON.parse(jsonStr);

        // Validate and transform to ClassLLMAnalysis
        return {
          name: cls.name,
          sourceRef: cls.sourceRef,
          purpose: parsed.purpose || 'Unknown purpose',
          responsibilities: parsed.responsibilities || [],
          category: parsed.category || 'other',
          designPatterns: (parsed.designPatterns || []).map((p: any) => ({
            name: p.name,
            type: p.type || 'behavioral',
            confidence: p.confidence || 0.5,
            explanation: p.explanation || '',
            elements: p.elements || [],
          })),
          keyMethods: (parsed.keyMethods || []).map((m: any) => {
            // Find the actual method to get source reference
            const actualMethod = cls.methods.find((am) => am.name === m.name);
            return {
              name: m.name,
              sourceRef: actualMethod?.sourceRef || cls.sourceRef,
              purpose: m.purpose || '',
              algorithm: m.algorithm,
              complexity: m.complexity || 'unknown',
              sideEffects: m.sideEffects || [],
            };
          }),
          stateManagement: parsed.stateManagement || 'Not analyzed',
          lifecycle: parsed.lifecycle,
          errorHandling: parsed.errorHandling || 'Not analyzed',
          dependencies: (parsed.dependencies || []).map((d: any) => ({
            name: d.name,
            role: d.role || '',
            isRequired: d.isRequired !== false,
          })),
          usedBy: (parsed.usedBy || []).map((u: any) => ({
            by: typeof u === 'string' ? u : u.by || 'Unknown',
            context: typeof u === 'string' ? '' : u.context || '',
          })),
          complexity: parsed.complexity || 'medium',
          suggestions: parsed.suggestions,
          llmScore: score,
          llmIterations: iterations,
          analyzedAt: new Date().toISOString(),
        };
      }
    } catch (error) {
      logger.error('LLMClassAnalyzer', `Failed to parse analysis for ${cls.name}:`, error);
    }

    return this.createFallbackAnalysis(cls);
  }

  /**
   * フォールバック分析を作成
   */
  private createFallbackAnalysis(cls: ExtractedClass): ClassLLMAnalysis {
    return {
      name: cls.name,
      sourceRef: cls.sourceRef,
      purpose: `Class ${cls.name} in ${cls.file}`,
      responsibilities: [],
      category: 'other',
      designPatterns: [],
      keyMethods: cls.methods.slice(0, 5).map((m) => ({
        name: m.name,
        sourceRef: m.sourceRef,
        purpose: `Method ${m.name}`,
        complexity: 'unknown',
        sideEffects: [],
      })),
      stateManagement: 'Not analyzed',
      errorHandling: 'Not analyzed',
      dependencies: [],
      usedBy: [],
      complexity: 'medium',
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
