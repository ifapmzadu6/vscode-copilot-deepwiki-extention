import * as vscode from 'vscode';
import * as path from 'path';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { ExtractedFunction, formatSourceRef, ExtractionSummary } from '../types/extraction';
import {
  getIntermediateFileManager,
  IntermediateFileManager,
  IntermediateFileType,
  LLMFeedbackLoop,
  LLMHelper,
  logger,
} from '../utils';

/**
 * LLM関数分析サブエージェント (Markdown Output)
 *
 * Level 3: DEEP_ANALYSIS
 *
 * 各関数をLLMで詳細分析し、Markdownレポートを出力する。
 *
 * 出力:
 * - .deepwiki/intermediate/analysis/functions/{functionName}.md
 */
export class LLMFunctionAnalyzerSubagent extends BaseSubagent {
  id = 'llm-function-analyzer';
  name = 'LLM Function Analyzer';
  description = 'Analyzes functions using LLM with feedback loop (Markdown)';

  private helper!: LLMHelper;
  private feedbackLoop!: LLMFeedbackLoop;
  private fileManager!: IntermediateFileManager;

  async execute(context: SubagentContext): Promise<{
    functionsAnalyzed: number;
    totalLLMCalls: number;
    savedToFiles: IntermediateFileType;
  }> {
    const { workspaceFolder, model, progress, token } = context;

    progress('Starting LLM function analysis (Markdown)...');

    this.helper = new LLMHelper(model);
    this.feedbackLoop = new LLMFeedbackLoop(model, {
      maxIterations: 3,
      targetScore: 8,
    });
    this.fileManager = getIntermediateFileManager();

    let extractionResult: ExtractionSummary | undefined;
    try {
      extractionResult = (await this.fileManager.loadJson<ExtractionSummary>(
        IntermediateFileType.EXTRACTION_SUMMARY
      )) || undefined;
    } catch (error) {
      logger.error('LLMFunctionAnalyzer', 'Failed to load extraction summary', error);
      return {
        functionsAnalyzed: 0,
        totalLLMCalls: 0,
        savedToFiles: IntermediateFileType.ANALYSIS_FUNCTION,
      };
    }

    if (!extractionResult || extractionResult.functions.length === 0) {
      return {
        functionsAnalyzed: 0,
        totalLLMCalls: 0,
        savedToFiles: IntermediateFileType.ANALYSIS_FUNCTION,
      };
    }

    const functions = extractionResult.functions.filter((f) => f.isExported);
    progress(`Found ${functions.length} exported functions to analyze`);

    const batchSize = 5;
    let totalLLMCalls = 0;
    let analyzedCount = 0;

    for (let i = 0; i < functions.length; i += batchSize) {
      if (token.isCancellationRequested) break;

      const batch = functions.slice(i, i + batchSize);
      progress(`Analyzing functions ${i + 1}-${Math.min(i + batchSize, functions.length)} of ${functions.length}...`);

      const promises = batch.map(async (func) => {
        try {
          const result = await this.analyzeFunction(func, workspaceFolder);
          if (result) {
            analyzedCount++;
            return result.iterations;
          }
        } catch (error) {
          logger.error('LLMFunctionAnalyzer', `Failed to analyze ${func.name}:`, error);
        }
        return 0;
      });

      const iterations = await Promise.all(promises);
      totalLLMCalls += iterations.reduce((a, b) => a + b, 0);
    }

    return {
      functionsAnalyzed: analyzedCount,
      totalLLMCalls,
      savedToFiles: IntermediateFileType.ANALYSIS_FUNCTION,
    };
  }

  private getFunctionKey(func: ExtractedFunction): string {
    const fileName = path.basename(func.file, path.extname(func.file));
    return `${fileName}_${func.name}`;
  }

  private async analyzeFunction(
    func: ExtractedFunction,
    workspaceFolder: vscode.WorkspaceFolder
  ): Promise<{ iterations: number } | null> {
    const sourceCode = await this.readFunctionSource(func, workspaceFolder);
    if (!sourceCode) return null;

    const generatePrompt = this.buildGeneratePrompt(func, sourceCode);
    const reviewPromptTemplate = (content: string) => this.buildReviewPrompt(func, content);
    const improvePromptTemplate = (content: string, feedback: string) =>
      this.buildImprovePrompt(func, content, feedback);

    try {
      const result = await this.feedbackLoop.generateWithFeedback(
        generatePrompt,
        reviewPromptTemplate,
        improvePromptTemplate
      );

      await this.fileManager.saveMarkdown(
        IntermediateFileType.ANALYSIS_FUNCTION,
        result.improved,
        this.getFunctionKey(func)
      );

      return { iterations: result.iterations };
    } catch (error) {
      logger.error('LLMFunctionAnalyzer', `Analysis failed for ${func.name}:`, error);
      return null;
    }
  }

  private async readFunctionSource(
    func: ExtractedFunction,
    workspaceFolder: vscode.WorkspaceFolder
  ): Promise<string | null> {
    try {
      const uri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, func.file));
      const content = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(content).toString('utf-8');
      const lines = text.split('\n');
      const startLine = Math.max(0, func.startLine - 3);
      const endLine = Math.min(lines.length, func.endLine + 1);
      return lines.slice(startLine, endLine).join('\n');
    } catch {
      return null;
    }
  }

  private getLanguage(file: string): string {
    const ext = path.extname(file).toLowerCase();
    const map: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.py': 'python',
      '.go': 'go',
      '.rs': 'rust',
      '.java': 'java',
    };
    return map[ext] || 'text';
  }

  private buildGeneratePrompt(func: ExtractedFunction, sourceCode: string): string {
    return `Analyze this function \`${func.name}\` and provide a technical report.

## Function Info
- **File:** ${func.file}
- **Signature:** ${func.signature}

## Source
\`\`\`${this.getLanguage(func.file)}
${sourceCode}
\`\`\`

## Requirements
Generate a Markdown report:

# Analysis: ${func.name}

## 🎯 Purpose
(What does it do?)

## 🧠 Algorithm
(How does it work?)

## 📥 Inputs & 📤 Outputs
- Params: ...
- Returns: ...

## ⚡ Complexity
- Time: O(?)
- Space: O(?)

## 🧪 Usage Example
\`\`\`typescript
example();
\`\`\`

Output **Markdown only**.`;
  }

  private buildReviewPrompt(func: ExtractedFunction, content: string): string {
    return `Review this function analysis.
    
## Report
${content}

## Criteria
1. Accuracy: Does it match the code?
2. Completeness: Are inputs/outputs covered?
3. Clarity: Is the usage example good?

Respond with JSON:
{
  "score": <1-10>,
  "feedback": "...",
  "issues": [],
  "suggestions": []
}`;
  }

  private buildImprovePrompt(func: ExtractedFunction, content: string, feedback: string): string {
    return `Improve the report based on feedback.

## Original
${content}

## Feedback
${feedback}

Return the revised Markdown report.`;
  }
}
