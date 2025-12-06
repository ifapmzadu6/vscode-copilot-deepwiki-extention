import * as vscode from 'vscode';
import * as path from 'path';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { ExtractionSummary, ExtractedClass, ExtractedFunction, ExtractedInterface } from '../types/extraction';
import {
  getIntermediateFileManager,
  IntermediateFileManager,
  IntermediateFileType,
  LLMFeedbackLoop,
  LLMHelper,
  logger,
} from '../utils';

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
 * LLMモジュール分析サブエージェント (Markdown Output)
 *
 * Level 3: DEEP_ANALYSIS
 *
 * 各モジュール（ディレクトリ）をLLMで詳細分析し、Markdownレポートを出力する。
 *
 * 出力:
 * - .deepwiki/intermediate/analysis/modules/{moduleName}.md
 */
export class LLMModuleAnalyzerSubagent extends BaseSubagent {
  id = 'llm-module-analyzer';
  name = 'LLM Module Analyzer';
  description = 'Analyzes modules using LLM for architectural insights (Markdown)';

  private helper!: LLMHelper;
  private feedbackLoop!: LLMFeedbackLoop;
  private fileManager!: IntermediateFileManager;

  async execute(context: SubagentContext): Promise<{
    modulesAnalyzed: number;
    savedToFiles: IntermediateFileType;
  }> {
    const { workspaceFolder, model, progress, token } = context;

    progress('Starting LLM module analysis (Markdown)...');

    this.helper = new LLMHelper(model);
    this.feedbackLoop = new LLMFeedbackLoop(model, {
      maxIterations: 3,
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
      logger.error('LLMModuleAnalyzer', 'Failed to load extraction summary', error);
      return {
        modulesAnalyzed: 0,
        savedToFiles: IntermediateFileType.ANALYSIS_MODULE,
      };
    }

    if (!extractionResult) {
      return {
        modulesAnalyzed: 0,
        savedToFiles: IntermediateFileType.ANALYSIS_MODULE,
      };
    }

    // Load class and function analyses (Markdown strings)
    const classAnalyses = await this.fileManager.loadAllClassAnalyses();
    const functionAnalyses = await this.fileManager.loadAllFunctionAnalyses();

    // Group entities by module
    const modules = this.groupByModule(extractionResult);
    progress(`Found ${modules.size} modules to analyze`);

    let analyzedCount = 0;
    let index = 0;

    for (const [modulePath, moduleInfo] of modules) {
      if (token.isCancellationRequested) break;
      index++;
      progress(`Analyzing module ${index}/${modules.size}: ${moduleInfo.name}...`);

      try {
        const result = await this.analyzeModule(
          moduleInfo,
          classAnalyses,
          functionAnalyses
        );

        if (result) {
          analyzedCount++;
        }
      } catch (error) {
        logger.error('LLMModuleAnalyzer', `Failed to analyze module ${moduleInfo.name}:`, error);
      }
    }

    return {
      modulesAnalyzed: analyzedCount,
      savedToFiles: IntermediateFileType.ANALYSIS_MODULE,
    };
  }

  private groupByModule(extraction: ExtractionSummary): Map<string, ModuleInfo> {
    const modules = new Map<string, ModuleInfo>();
    const getModulePath = (filePath: string) => path.dirname(filePath);
    const getModuleInfo = (modulePath: string): ModuleInfo => {
      if (!modules.has(modulePath)) {
        modules.set(modulePath, {
          name: path.basename(modulePath) || 'root',
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

    extraction.classes.forEach(c => {
      const m = getModuleInfo(getModulePath(c.file));
      m.classes.push(c);
      if (!m.files.includes(c.file)) m.files.push(c.file);
    });
    extraction.functions.forEach(f => {
      const m = getModuleInfo(getModulePath(f.file));
      m.functions.push(f);
      if (!m.files.includes(f.file)) m.files.push(f.file);
    });
    extraction.interfaces.forEach(i => {
      const m = getModuleInfo(getModulePath(i.file));
      m.interfaces.push(i);
      if (!m.files.includes(i.file)) m.files.push(i.file);
    });
    extraction.imports.forEach(i => getModuleInfo(getModulePath(i.file)).imports.add(i.source));
    extraction.exports.forEach(e => getModuleInfo(getModulePath(e.file)).exports.add(e.name));

    // Filter small modules
    const significantModules = new Map<string, ModuleInfo>();
    for (const [p, i] of modules) {
      if (i.files.length >= 2 || i.classes.length > 0) significantModules.set(p, i);
    }
    return significantModules;
  }

  /**
   * Analyze module and save as Markdown
   */
  private async analyzeModule(
    module: ModuleInfo,
    classAnalyses: Map<string, string>,
    functionAnalyses: Map<string, string>
  ): Promise<boolean> {
    const classContext = this.buildClassContext(module.classes, classAnalyses);
    const functionContext = this.buildFunctionContext(module.functions, functionAnalyses);

    const generatePrompt = this.buildGeneratePrompt(module, classContext, functionContext);
    const reviewPromptTemplate = (content: string) => this.buildReviewPrompt(module, content);
    const improvePromptTemplate = (content: string, feedback: string) =>
      this.buildImprovePrompt(module, content, feedback);

    const result = await this.feedbackLoop.generateWithFeedback(
      generatePrompt,
      reviewPromptTemplate,
      improvePromptTemplate
    );

    await this.fileManager.saveMarkdown(
      IntermediateFileType.ANALYSIS_MODULE,
      result.improved,
      module.name
    );

    return true;
  }

  private buildClassContext(
    classes: ExtractedClass[],
    analyses: Map<string, string>
  ): string {
    if (classes.length === 0) return '(none)';

    // Pick top 5 classes or use all if few
    const targetClasses = classes.slice(0, 10);
    return targetClasses.map(c => {
      const analysisFull = analyses.get(c.name);
      // Extract first 100-200 chars or summary from markdown
      const summary = analysisFull
        ? analysisFull.split('\n').slice(0, 5).join('\n') // Take header and first paragraph
        : '(No analysis available)';

      return `### Class: ${c.name}\n${summary}`;
    }).join('\n\n');
  }

  private buildFunctionContext(
    functions: ExtractedFunction[],
    analyses: Map<string, string>
  ): string {
    const exportedFunctions = functions.filter(f => f.isExported).slice(0, 10);
    if (exportedFunctions.length === 0) return '(none)';

    return exportedFunctions.map(f => {
      // Find analysis key if possible (filename_funcname)
      const likelyKey = Object.keys(analyses).find(k => k.endsWith(`_${f.name}`)) || '';
      // Wait, Map keys iteration is better
      let analysisFull = '';
      for (const [k, v] of analyses) {
        if (k.endsWith(`_${f.name}`)) {
          analysisFull = v;
          break;
        }
      }

      const summary = analysisFull
        ? analysisFull.split('\n').slice(0, 5).join('\n')
        : '(No analysis available)';

      return `### Function: ${f.name}\n${summary}`;
    }).join('\n\n');
  }

  private buildGeneratePrompt(module: ModuleInfo, classContext: string, functionContext: string): string {
    return `Analyze this module (directory) structure.

## Module Info
- **Name:** ${module.name}
- **Path:** ${module.path}
- **Files:** ${module.files.length}

## Components
${classContext}
${functionContext}

## Requirements
Generate a structural analysis report in Markdown:

# Analysis: Module ${module.name}

## 🎯 Purpose
(1-2 sentences on what this module is for)

## 🏗️ Architecture
- **Pattern**: (MVC, Facade, etc.)
- **Cohesion**: (Is it focused?)
- **Coupling**: (Does it rely heavily on others?)

## 📦 Components
(Briefly describe key components based on the context provided)

## 🔄 Data Flow
(How data moves in/out - inferred)

## ⚠️ Issues / Suggestions
(Refactoring ideas)

Output **Markdown only**.`;
  }

  private buildReviewPrompt(module: ModuleInfo, content: string): string {
    return `Review this module analysis.
    
## Report
${content}

## Criteria
1. **Insightful**: Does it explain *why* the module exists?
2. **Architectural**: Does it identify patterns?
3. **Formatted**: Are headers used correctly?

Respond with JSON:
{
  "score": <1-10>,
  "feedback": "...",
  "issues": [],
  "suggestions": []
}`;
  }

  private buildImprovePrompt(module: ModuleInfo, content: string, feedback: string): string {
    return `Improve the report based on feedback.

## Original
${content}

## Feedback
${feedback}

Return the revised Markdown report.`;
  }
}
