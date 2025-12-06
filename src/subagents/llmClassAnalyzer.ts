import * as vscode from 'vscode';
import * as path from 'path';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { ExtractedClass, formatSourceRef, ExtractionSummary } from '../types/extraction';
import {
  getIntermediateFileManager,
  IntermediateFileManager,
  IntermediateFileType,
  LLMFeedbackLoop,
  LLMHelper,
  logger,
} from '../utils';

/**
 * LLMクラス分析サブエージェント (Markdown Output)
 *
 * Level 3: DEEP_ANALYSIS
 *
 * 各クラスをLLMで詳細分析し、Markdownドキュメントとして出力する。
 * JSON生成によるエラーを回避し、より自然な思考プロセスを記述させる。
 *
 * 出力:
 * - .deepwiki/intermediate/analysis/classes/{ClassName}.md
 */
export class LLMClassAnalyzerSubagent extends BaseSubagent {
  id = 'llm-class-analyzer';
  name = 'LLM Class Analyzer';
  description = 'Analyzes classes using LLM with feedback loop, generating Markdown reports';

  private helper!: LLMHelper;
  private feedbackLoop!: LLMFeedbackLoop;
  private fileManager!: IntermediateFileManager;

  async execute(context: SubagentContext): Promise<{
    classesAnalyzed: number;
    totalLLMCalls: number;
    savedToFiles: IntermediateFileType;
  }> {
    const { workspaceFolder, model, progress, token } = context;

    progress('Starting LLM class analysis (Markdown mode)...');

    this.helper = new LLMHelper(model);
    this.feedbackLoop = new LLMFeedbackLoop(model, {
      maxIterations: 3, // Markdownなら安定するので3回で十分
      targetScore: 8,
    });
    this.fileManager = getIntermediateFileManager();

    // Load extraction results
    let extractionResult: ExtractionSummary | undefined;
    try {
      extractionResult = (await this.fileManager.loadJson<ExtractionSummary>(
        IntermediateFileType.EXTRACTION_SUMMARY
      )) || undefined;
    } catch (error) {
      logger.error('LLMClassAnalyzer', 'Failed to load extraction summary', error);
      return {
        classesAnalyzed: 0,
        totalLLMCalls: 0,
        savedToFiles: IntermediateFileType.ANALYSIS_CLASS,
      };
    }

    if (!extractionResult || extractionResult.classes.length === 0) {
      progress('No classes to analyze');
      return {
        classesAnalyzed: 0,
        totalLLMCalls: 0,
        savedToFiles: IntermediateFileType.ANALYSIS_CLASS,
      };
    }

    const classes = extractionResult.classes;
    progress(`Found ${classes.length} classes to analyze`);

    let totalLLMCalls = 0;
    let analyzedCount = 0;
    const batchSize = 5; // Markdownなら高速化できる可能性

    for (let i = 0; i < classes.length; i += batchSize) {
      if (token.isCancellationRequested) break;

      const batch = classes.slice(i, i + batchSize);
      progress(`Analyzing classes ${i + 1}-${Math.min(i + batchSize, classes.length)} of ${classes.length}...`);

      const promises = batch.map(async (cls) => {
        try {
          const result = await this.analyzeClass(cls, workspaceFolder);
          if (result) {
            analyzedCount++;
            return result.iterations;
          }
        } catch (error) {
          logger.error('LLMClassAnalyzer', `Failed to analyze ${cls.name}:`, error);
        }
        return 0;
      });

      const iterations = await Promise.all(promises);
      totalLLMCalls += iterations.reduce((a, b) => a + b, 0);
    }

    return {
      classesAnalyzed: analyzedCount,
      totalLLMCalls,
      savedToFiles: IntermediateFileType.ANALYSIS_CLASS,
    };
  }

  /**
   * 単一クラスを分析してMarkdownとして保存
   */
  private async analyzeClass(
    cls: ExtractedClass,
    workspaceFolder: vscode.WorkspaceFolder
  ): Promise<{ iterations: number } | null> {
    const sourceCode = await this.readClassSource(cls, workspaceFolder);
    if (!sourceCode) return null;

    const generatePrompt = this.buildGeneratePrompt(cls, sourceCode);
    const reviewPromptTemplate = (content: string) => this.buildReviewPrompt(cls, content);
    const improvePromptTemplate = (content: string, feedback: string) =>
      this.buildImprovePrompt(cls, content, feedback);

    try {
      // Run feedback loop
      const result = await this.feedbackLoop.generateWithFeedback(
        generatePrompt,
        reviewPromptTemplate,
        improvePromptTemplate
      );

      // Save as Markdown
      await this.fileManager.saveMarkdown(
        IntermediateFileType.ANALYSIS_CLASS,
        result.improved,
        cls.name
      );

      return { iterations: result.iterations };
    } catch (error) {
      logger.error('LLMClassAnalyzer', `Analysis failed for ${cls.name}:`, error);
      return null;
    }
  }

  /**
   * クラスソース読み込み
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
      const start = Math.max(0, cls.startLine - 5);
      const end = Math.min(lines.length, cls.endLine + 2);
      return lines.slice(start, end).join('\n');
    } catch {
      return null;
    }
  }

  /**
   * 生成プロンプト (Markdown出力)
   */
  private buildGeneratePrompt(cls: ExtractedClass, sourceCode: string): string {
    return `Analyze the class \`${cls.name}\` and provide a technical report.

## Class Info
- **File:** ${cls.file}
- **Source:** ${formatSourceRef(cls.sourceRef)}
- **Methods:** ${cls.methods.map((m) => m.name).join(', ')}

## Source Code
\`\`\`${path.extname(cls.file).replace('.', '')}
${sourceCode}
\`\`\`

## Requirements
Generate a structure Markdown report with the following headers:

# Analysis: ${cls.name}

## 🎯 Purpose
(What does this class do?)

## 🧩 Design Patterns
(Identify any design patterns used, with reasoning.)

## 🔑 Key Responsibilities
(Bulleted list of responsibilities.)

## ⚙️ Key Methods
(Analyze complexity and logic of important methods.)

## 🔗 Dependencies & Interactions
(What does it depend on? What uses it?)

## ⚠️ Risks & improvements
(Potential issues or suggestions.)

Output **Markdown only**. Do NOT start with \`\`\`markdown.`;
  }

  /**
   * レビュープロンプト (Markdown)
   */
  private buildReviewPrompt(cls: ExtractedClass, content: string): string {
    return `Review this class analysis report.

## Report to Review
${content}

## Criteria
1. **Clarity**: Is the purpose clearly explained?
2. **Accuracy**: Do the design patterns and method analyses match the expected code structure?
3. **Structure**: Does it follow the required Markdown headers?

Respond with JSON (only for the review result):
{
  "score": <1-10>,
  "feedback": "...",
  "issues": ["..."],
  "suggestions": ["..."]
}`;
  }

  /**
   * 改善プロンプト (Markdown)
   */
  private buildImprovePrompt(cls: ExtractedClass, content: string, feedback: string): string {
    return `Improve the analysis report based on feedback.

## Original Report
${content}

## Feedback
${feedback}

Return the fully revised Markdown report.`;
  }
}
