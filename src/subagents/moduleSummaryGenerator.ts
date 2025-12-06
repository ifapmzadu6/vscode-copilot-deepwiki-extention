import * as vscode from 'vscode';
import * as path from 'path';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { ExtractionSummary } from '../types/extraction';
import { ModuleLLMAnalysis, ClassLLMAnalysis, FunctionLLMAnalysis } from '../types/llmAnalysis';
import { DependencyGraph, CrossReferenceIndex } from '../types/relationships';
import {
  getIntermediateFileManager,
  IntermediateFileType,
  LLMFeedbackLoop,
  LLMHelper,
  logger,
} from '../utils';

/**
 * モジュールサマリーの結果
 */
interface ModuleSummaryResult {
  moduleName: string;
  summaryPath: string;
  score: number;
  iterations: number;
}

/**
 * モジュールサマリー生成器
 *
 * Level 5: DOCUMENTATION
 *
 * Level 3/4の分析結果を使用して、各モジュールのサマリードキュメントを生成
 *
 * 処理フロー:
 * 1. Level 3のモジュール分析を読み込み
 * 2. Level 4の関係性情報を追加
 * 3. LLMでサマリー生成（フィードバックループ付き）
 * 4. 中間ファイルとして保存
 *
 * 出力:
 *   - .deepwiki/intermediate/docs/pages/{ModuleName}.draft.md
 */
export class ModuleSummaryGeneratorSubagent extends BaseSubagent {
  id = 'module-summary-generator';
  name = 'Module Summary Generator';
  description = 'Generates LLM-based summaries for each module with feedback loop';

  private helper!: LLMHelper;
  private feedbackLoop!: LLMFeedbackLoop;
  private fileManager: any;

  async execute(context: SubagentContext): Promise<ModuleSummaryResult[]> {
    const { workspaceFolder, model, progress, token, previousResults } = context;

    progress('Generating module summaries with LLM...');

    this.helper = new LLMHelper(model);
    this.feedbackLoop = new LLMFeedbackLoop(model, {
      maxIterations: 3,
      targetScore: 8,
    });
    this.fileManager = getIntermediateFileManager();

    // Get Level 3 analysis results
    const moduleAnalyses = previousResults.get('llm-module-analyzer') as Map<string, ModuleLLMAnalysis> | undefined;
    const classAnalyses = previousResults.get('llm-class-analyzer') as Map<string, ClassLLMAnalysis> | undefined;
    const functionAnalyses = previousResults.get('llm-function-analyzer') as Map<string, FunctionLLMAnalysis> | undefined;

    // Get Level 4 relationship results
    const dependencyGraph = previousResults.get('dependency-mapper') as DependencyGraph | undefined;
    const crossRefs = previousResults.get('cross-referencer') as CrossReferenceIndex | undefined;

    if (!moduleAnalyses || moduleAnalyses.size === 0) {
      progress('No module analyses found');
      return [];
    }

    progress(`Found ${moduleAnalyses.size} modules to summarize`);

    const results: ModuleSummaryResult[] = [];

    // Generate summaries in parallel batches
    const modules = Array.from(moduleAnalyses.entries());
    const batchSize = 3;

    for (let i = 0; i < modules.length; i += batchSize) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      const batch = modules.slice(i, i + batchSize);
      progress(`Processing modules ${i + 1}-${Math.min(i + batchSize, modules.length)} of ${modules.length}...`);

      const batchPromises = batch.map(async ([path, analysis]) => {
        return this.generateModuleSummary(
          analysis,
          classAnalyses,
          functionAnalyses,
          dependencyGraph,
          crossRefs
        );
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    // Generate architecture overview
    await this.generateArchitectureOverview(
      Array.from(moduleAnalyses.values()),
      dependencyGraph,
      token
    );

    progress(`Generated ${results.length} module summaries`);

    return results;
  }

  /**
   * モジュールサマリーを生成（フィードバックループ付き）
   */
  private async generateModuleSummary(
    module: ModuleLLMAnalysis,
    classAnalyses: Map<string, ClassLLMAnalysis> | undefined,
    functionAnalyses: Map<string, FunctionLLMAnalysis> | undefined,
    dependencyGraph: DependencyGraph | undefined,
    crossRefs: CrossReferenceIndex | undefined
  ): Promise<ModuleSummaryResult> {
    // Build context from Level 3 analyses
    const classContext = this.buildClassContext(module, classAnalyses);
    const functionContext = this.buildFunctionContext(module, functionAnalyses);
    const dependencyContext = this.buildDependencyContext(module, dependencyGraph);
    const usageContext = this.buildUsageContext(module, crossRefs);

    const generatePrompt = `
Generate a comprehensive technical documentation summary for this module.

## Module Information

**Name:** ${module.name}
**Path:** ${module.path}
**Purpose:** ${module.purpose}
**Category:** ${module.category}
**Cohesion:** ${module.cohesion}
**Coupling:** ${module.coupling}

### Responsibilities
${module.responsibilities.map(r => `- ${r}`).join('\n')}

### Architecture
**Pattern:** ${module.architecture.pattern}
${module.architecture.layers ? `**Layers:** ${module.architecture.layers.join(', ')}` : ''}

**Components:**
${module.architecture.components.map(c => `- ${c.name} (${c.type}): ${c.role}`).join('\n')}

### Key Classes (with LLM Analysis)
${classContext}

### Key Functions (with LLM Analysis)
${functionContext}

### Dependencies
${dependencyContext}

### Usage
${usageContext}

### Data Flow
**Inputs:**
${module.dataFlow.inputs.map(i => `- ${i.name} from ${i.source}`).join('\n') || '  (none)'}

**Outputs:**
${module.dataFlow.outputs.map(o => `- ${o.name} to ${o.destination}`).join('\n') || '  (none)'}

**Transformations:**
${module.dataFlow.transformations.map(t => `- ${t}`).join('\n') || '  (none)'}

---

Generate a Markdown summary with these sections:

1. ## Overview
   - Purpose and responsibilities
   - Key features
   - **Include source file references as links: [file:line]()**

2. ## Architecture
   - Design patterns used
   - How components are organized
   - Key interactions

3. ## Main Components
   - Important classes with their purpose
   - Key functions with their role
   - **Reference specific source locations**

4. ## Data Flow
   - How data moves through this module
   - Input/output handling

5. ## Dependencies
   - What this module depends on
   - What depends on this module

6. ## Usage Examples
   - How to use key classes/functions
   - Common patterns

Be specific and technical. Include actual source references like [src/foo.ts:42]().
Focus on the ACTUAL implementation details from the analysis.
`;

    const reviewPromptTemplate = (content: string) => `
Review this module documentation for quality.

Documentation:
${content}

Score each criterion from 1-10:
1. **Technical Accuracy** - Does it accurately describe the code?
2. **Completeness** - Are all major components covered?
3. **Source References** - Are source locations properly referenced?
4. **Clarity** - Is it easy to understand?
5. **Usefulness** - Would a developer find this helpful?

Respond with JSON:
{
  "score": <average of all scores, 1-10>,
  "feedback": "<overall assessment>",
  "issues": ["<specific issue 1>", "<specific issue 2>"],
  "suggestions": ["<specific suggestion 1>", "<specific suggestion 2>"]
}
`;

    const improvePromptTemplate = (content: string, feedback: string) => `
Improve this module documentation based on the feedback.

Current Documentation:
${content}

Feedback:
${feedback}

Requirements:
- Address ALL issues mentioned in the feedback
- Add more specific source references [file:line]()
- Include more technical details
- Improve clarity and organization

Provide the improved documentation in the same Markdown format.
`;

    try {
      const result = await this.feedbackLoop.generateWithFeedback(
        generatePrompt,
        reviewPromptTemplate,
        improvePromptTemplate
      );

      // Save as draft
      const mdPath = await this.fileManager.saveMarkdown(
        IntermediateFileType.DOCS_PAGE_DRAFT,
        result.improved,
        module.name
      );

      logger.log('ModuleSummaryGenerator', `${module.name}: Score ${result.score}/10 (${result.iterations} iterations)`);

      return {
        moduleName: module.name,
        summaryPath: mdPath,
        score: result.score,
        iterations: result.iterations,
      };
    } catch (error) {
      logger.error('ModuleSummaryGenerator', `Failed to generate summary for ${module.name}:`, error);

      // Create fallback summary
      const fallbackSummary = this.createFallbackSummary(module);
      const mdPath = await this.fileManager.saveMarkdown(
        IntermediateFileType.DOCS_PAGE_DRAFT,
        fallbackSummary,
        module.name
      );

      return {
        moduleName: module.name,
        summaryPath: mdPath,
        score: 0,
        iterations: 0,
      };
    }
  }

  /**
   * クラス分析からコンテキストを構築
   */
  private buildClassContext(
    module: ModuleLLMAnalysis,
    classAnalyses: Map<string, ClassLLMAnalysis> | undefined
  ): string {
    if (!classAnalyses) {
      return module.keyClasses.map(c =>
        `- **${c.name}** (${c.importance}): ${c.summary}`
      ).join('\n') || '  (none)';
    }

    const lines: string[] = [];
    for (const keyClass of module.keyClasses) {
      const analysis = classAnalyses.get(keyClass.name);
      if (analysis) {
        lines.push(`- **${keyClass.name}** [${analysis.sourceRef.file}:${analysis.sourceRef.startLine}]()`);
        lines.push(`  - Purpose: ${analysis.purpose}`);
        lines.push(`  - Category: ${analysis.category}`);
        if (analysis.designPatterns.length > 0) {
          lines.push(`  - Patterns: ${analysis.designPatterns.map(p => p.name).join(', ')}`);
        }
        if (analysis.keyMethods.length > 0) {
          lines.push(`  - Key Methods: ${analysis.keyMethods.slice(0, 3).map(m => m.name).join(', ')}`);
        }
      } else {
        lines.push(`- **${keyClass.name}** (${keyClass.importance}): ${keyClass.summary}`);
      }
    }

    return lines.join('\n') || '  (none)';
  }

  /**
   * 関数分析からコンテキストを構築
   */
  private buildFunctionContext(
    module: ModuleLLMAnalysis,
    functionAnalyses: Map<string, FunctionLLMAnalysis> | undefined
  ): string {
    if (!functionAnalyses) {
      return module.keyFunctions.map(f =>
        `- **${f.name}** (${f.importance}): ${f.summary}`
      ).join('\n') || '  (none)';
    }

    const lines: string[] = [];
    for (const keyFunc of module.keyFunctions) {
      // Try to find the analysis
      let analysis: FunctionLLMAnalysis | undefined;
      for (const [key, a] of functionAnalyses) {
        if (key.endsWith(`_${keyFunc.name}`)) {
          analysis = a;
          break;
        }
      }

      if (analysis) {
        lines.push(`- **${keyFunc.name}** [${analysis.sourceRef.file}:${analysis.sourceRef.startLine}]()`);
        lines.push(`  - Purpose: ${analysis.purpose}`);
        lines.push(`  - Category: ${analysis.category}`);
        lines.push(`  - Complexity: Time ${analysis.complexity.time}, Space ${analysis.complexity.space}`);
      } else {
        lines.push(`- **${keyFunc.name}** (${keyFunc.importance}): ${keyFunc.summary}`);
      }
    }

    return lines.join('\n') || '  (none)';
  }

  /**
   * 依存関係からコンテキストを構築
   */
  private buildDependencyContext(
    module: ModuleLLMAnalysis,
    dependencyGraph: DependencyGraph | undefined
  ): string {
    const lines: string[] = [];

    // From module analysis
    lines.push('**Internal Dependencies:**');
    for (const dep of module.dependencies) {
      lines.push(`- ${dep.module}: ${dep.purpose} (${dep.coupling})`);
    }

    if (lines.length === 1) {
      lines.push('  (none)');
    }

    lines.push('\n**Dependents:**');
    for (const dep of module.dependents) {
      lines.push(`- ${dep.module}: ${dep.purpose} (${dep.coupling})`);
    }

    if (module.dependents.length === 0) {
      lines.push('  (none)');
    }

    // Add info from dependency graph if available
    if (dependencyGraph) {
      const moduleFiles = dependencyGraph.nodes.filter(n => n.module === module.name);
      const externalDeps = new Set<string>();

      for (const edge of dependencyGraph.edges) {
        const fromNode = dependencyGraph.nodes.find(n => n.id === edge.from);
        if (fromNode?.module === module.name && edge.isTypeOnly === false) {
          // Find target module
          const toNode = dependencyGraph.nodes.find(n => n.id === edge.to);
          if (toNode && toNode.module !== module.name) {
            externalDeps.add(toNode.module || toNode.path);
          }
        }
      }

      if (externalDeps.size > 0) {
        lines.push('\n**From Dependency Graph:**');
        for (const dep of externalDeps) {
          lines.push(`- ${dep}`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * 使用状況からコンテキストを構築
   */
  private buildUsageContext(
    module: ModuleLLMAnalysis,
    crossRefs: CrossReferenceIndex | undefined
  ): string {
    if (!crossRefs) {
      return 'Usage information not available';
    }

    const lines: string[] = [];
    const mostUsed = crossRefs.mostUsed
      .filter(item => {
        // Check if this entity belongs to this module
        const entity = crossRefs.byEntity.get(item.entityId);
        if (entity && entity.definition.file.includes(module.path)) {
          return true;
        }
        return false;
      })
      .slice(0, 5);

    if (mostUsed.length > 0) {
      lines.push('**Most Used Components:**');
      for (const item of mostUsed) {
        const entity = crossRefs.byEntity.get(item.entityId);
        if (entity) {
          lines.push(`- ${entity.definition.name} (${item.usageCount} usages)`);
        }
      }
    } else {
      lines.push('No significant usage patterns detected.');
    }

    return lines.join('\n');
  }

  /**
   * フォールバックサマリーを作成
   */
  private createFallbackSummary(module: ModuleLLMAnalysis): string {
    return `# ${module.name}

## Overview

${module.purpose}

**Category:** ${module.category}
**Path:** ${module.path}

### Responsibilities
${module.responsibilities.map(r => `- ${r}`).join('\n') || '- Not analyzed'}

## Architecture

**Pattern:** ${module.architecture.pattern}

### Components
${module.architecture.components.map(c => `- **${c.name}** (${c.type}): ${c.role}`).join('\n') || '- Not analyzed'}

## Main Components

### Key Classes
${module.keyClasses.map(c => `- **${c.name}** (${c.importance}): ${c.summary}`).join('\n') || '- None identified'}

### Key Functions
${module.keyFunctions.map(f => `- **${f.name}** (${f.importance}): ${f.summary}`).join('\n') || '- None identified'}

## Dependencies

### Depends On
${module.dependencies.map(d => `- ${d.module}: ${d.purpose}`).join('\n') || '- None'}

### Used By
${module.dependents.map(d => `- ${d.module}: ${d.purpose}`).join('\n') || '- None'}

---
*Summary generation incomplete. Score: 0*
`;
  }

  /**
   * アーキテクチャ概要を生成
   */
  private async generateArchitectureOverview(
    modules: ModuleLLMAnalysis[],
    dependencyGraph: DependencyGraph | undefined,
    token: vscode.CancellationToken
  ): Promise<void> {
    const moduleList = modules.map(m => ({
      name: m.name,
      purpose: m.purpose,
      category: m.category,
      pattern: m.architecture.pattern,
      cohesion: m.cohesion,
      coupling: m.coupling,
    }));

    const prompt = `
Generate an architecture overview document for this project.

## Modules
${JSON.stringify(moduleList, null, 2)}

${dependencyGraph ? `
## Dependency Information
- Total files: ${dependencyGraph.nodes.length}
- Total dependencies: ${dependencyGraph.edges.length}
- Cycles detected: ${dependencyGraph.cycles.length}
- External dependencies: ${dependencyGraph.externalDependencies.length}
` : ''}

Generate a Markdown document with:

1. ## System Overview
   - Overall system purpose
   - High-level architecture

2. ## Module Relationships
   - How modules depend on each other
   - Data flow between modules

3. ## Core Modules
   - Which modules are most important
   - Why they are central

4. ## Architecture Diagram (Mermaid)
   - Show module dependencies as a flowchart
   - Use actual module names

5. ## Quality Assessment
   - Cohesion and coupling analysis
   - Identified issues or improvements

Be specific and use actual module names.
`;

    try {
      const overview = await this.helper.generate(prompt);

      await this.fileManager.saveMarkdown(
        IntermediateFileType.DOCS_PAGE_DRAFT,
        overview,
        'architecture'
      );

      logger.log('ModuleSummaryGenerator', 'Generated architecture overview');
    } catch (error) {
      logger.error('ModuleSummaryGenerator', 'Failed to generate architecture overview:', error);
    }
  }
}
