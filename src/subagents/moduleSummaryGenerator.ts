import * as vscode from 'vscode';
import * as path from 'path';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { DependencyGraph } from '../types/relationships';
import {
  getIntermediateFileManager,
  IntermediateFileManager,
  IntermediateFileType,
  LLMFeedbackLoop,
  LLMHelper,
  logger,
} from '../utils';

interface ModuleSummaryResult {
  moduleName: string;
  summaryPath: string;
  score: number;
  iterations: number;
}

/**
 * モジュールサマリー生成器 (Markdown Input/Output)
 *
 * Level 5: DOCUMENTATION
 *
 * Level 3 (Analysis Markdown) と Level 4 (Graph JSON) を統合し、
 * ユーザー向けのドキュメントページ下書き (Draft) を生成する。
 *
 * 入力:
 * - analysis/modules/*.md
 * - analysis/classes/*.md
 * - relationships/dependency-graph.json
 *
 * 出力:
 * - docs/pages/{ModuleName}.draft.md
 */
export class ModuleSummaryGeneratorSubagent extends BaseSubagent {
  id = 'module-summary-generator';
  name = 'Module Summary Generator';
  description = 'Generates documentation drafts from analysis reports (Markdown)';

  private helper!: LLMHelper;
  private feedbackLoop!: LLMFeedbackLoop;
  private fileManager!: IntermediateFileManager;

  async execute(context: SubagentContext): Promise<{
    summariesGenerated: number;
    savedToFiles: IntermediateFileType;
  }> {
    const { workspaceFolder, model, progress, token } = context;

    progress('Generating module summaries (Markdown flow)...');

    this.helper = new LLMHelper(model);
    this.feedbackLoop = new LLMFeedbackLoop(model, {
      maxIterations: 3,
      targetScore: 8,
    });
    this.fileManager = getIntermediateFileManager();

    // Load L3 Analysis (Markdown)
    const moduleAnalyses = await this.fileManager.loadAllModuleAnalyses(); // Map<string, string>
    const classAnalyses = await this.fileManager.loadAllClassAnalyses();   // Map<string, string>

    // Load L4 Relationships (JSON)
    const dependencyGraph =
      (await this.fileManager.loadJson<DependencyGraph>(IntermediateFileType.RELATIONSHIP_DEPENDENCY_GRAPH)) || undefined;

    if (moduleAnalyses.size === 0) {
      progress('No module analyses found');
      return {
        summariesGenerated: 0,
        savedToFiles: IntermediateFileType.DOCS_PAGE_DRAFT,
      };
    }

    progress(`Found ${moduleAnalyses.size} module reports to synthesize`);

    // Sort modules by name for consistent processing
    const modules = Array.from(moduleAnalyses.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const results: ModuleSummaryResult[] = [];
    const batchSize = 3;

    for (let i = 0; i < modules.length; i += batchSize) {
      if (token.isCancellationRequested) break;
      const batch = modules.slice(i, i + batchSize);
      progress(`Processing batch ${Math.floor(i / batchSize) + 1}...`);

      const promises = batch.map(async ([moduleName, analysisContent]) => {
        try {
          return await this.generateDocumentPage(
            moduleName,
            analysisContent,
            classAnalyses,
            dependencyGraph
          );
        } catch (error) {
          logger.error('ModuleSummaryGenerator', `Failed to generate page for ${moduleName}:`, error);
          return null;
        }
      });

      const batchResults = await Promise.all(promises);
      batchResults.forEach(r => {
        if (r) results.push(r);
      });
    }

    // Generate architecture overview (if architecture.md exists, or generate new based on all modules)
    // For now, we focus on module pages.

    return {
      summariesGenerated: results.length,
      savedToFiles: IntermediateFileType.DOCS_PAGE_DRAFT,
    };
  }

  private async generateDocumentPage(
    moduleName: string,
    moduleAnalysis: string,
    classAnalyses: Map<string, string>,
    dependencyGraph: DependencyGraph | undefined
  ): Promise<ModuleSummaryResult> {

    // 1. Prepare Context
    // Extract related class analyses (simple string matching for now, or just leave it to user to explore)
    // To make it better, we could look for class names mentioned in the module analysis? 
    // Or just pick top classes from the module if we had the mapping.
    // L2 extraction summary would have the mapping, but we don't load it here.
    // For simplicity, we just pass the Module Analysis as the primary source.
    // We can interpret the dependency graph to find related modules.

    let relatedNodes = '';
    if (dependencyGraph) {
      const moduleNodes = dependencyGraph.nodes.filter(n => n.module === moduleName);
      const outgoing = dependencyGraph.edges
        .filter(e => moduleNodes.some(n => n.id === e.from))
        .map(e => dependencyGraph.nodes.find(n => n.id === e.to)?.module)
        .filter(m => m && m !== moduleName);

      relatedNodes = `**Dependencies:** ${Array.from(new Set(outgoing)).join(', ') || 'None'}`;
    }

    const generatePrompt = `
Write a User-Facing Technical Documentation Page for the module \`${moduleName}\`.

## Source Material (Analysis Report)
${moduleAnalysis}

## Additional Context
${relatedNodes}

## Requirements
 Synthesize the analysis into a polished documentation page.
 Style: Professional, clear, developer-friendly.
 Format: Markdown.

 Structure:
 # Module: ${moduleName}

 ## Overview
 (High-level summary)

 ## Key Features
 (Bullet points)

 ## Architecture & Design
 (Explain the pattern and structure)

 ## API & Usage
 (How to use it, key classes/functions)

 ## Dependencies
 (What it relies on)
`;

    const reviewPromptTemplate = (content: string) => `
Review this documentation page.

## Content
${content}

## Criteria
1. **Readability**: Is it easy to read?
2. **Completeness**: Does it cover the overview and usage?
3. **Structure**: Are headers clear?

Respond with JSON: {"score": <1-10>, "feedback": "...", "suggestions": []}
`;

    const improvePromptTemplate = (content: string, feedback: string) => `
Improve the documentation page based on feedback.

## Original
${content}

## Feedback
${feedback}

Return the revised Markdown page.
`;

    const result = await this.feedbackLoop.generateWithFeedback(
      generatePrompt,
      reviewPromptTemplate,
      improvePromptTemplate
    );

    // Save Draft
    const outPath = await this.fileManager.saveMarkdown(
      IntermediateFileType.DOCS_PAGE_DRAFT,
      result.improved,
      moduleName
    );

    return {
      moduleName,
      summaryPath: outPath,
      score: result.score,
      iterations: result.iterations
    };
  }
}
