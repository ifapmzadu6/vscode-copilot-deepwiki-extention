import * as vscode from 'vscode';
import {
  IPipelineOrchestrator,
  PipelineContext,
  PipelineLevel,
  PipelineState,
  TaskStatus,
  TaskResult,
} from '../types/pipeline';
import { SubagentTask, SubagentContext, ProgressCallback } from '../types';
import { ParallelExecutor } from './parallelExecutor';
import { ResultAggregator } from './resultAggregator';
import { logger } from '../utils/logger';
import { initIntermediateFileManager } from '../utils/intermediateFileManager';

// Level 1: DISCOVERY
import {
  FileScannerSubagent,
  DependencyAnalyzerSubagent,
  LanguageDetectorSubagent,
  EntryPointFinderSubagent,
  ConfigFinderSubagent,
  FrameworkDetectorSubagent,
} from '../subagents';

// Level 2: CODE_EXTRACTION
import { LLMUniversalCodeExtractorSubagent } from '../subagents';

// Level 3: DEEP_ANALYSIS (LLM-based)
import {
  LLMClassAnalyzerSubagent,
  LLMFunctionAnalyzerSubagent,
  LLMModuleAnalyzerSubagent,
} from '../subagents';

// Level 4: RELATIONSHIP
import {
  DependencyMapperSubagent,
  CrossReferencerSubagent,
  InheritanceTreeBuilderSubagent,
  CallGraphBuilderSubagent,
  ModuleBoundaryBuilderSubagent,
  LayerViolationCheckerSubagent,
} from '../subagents';

// Level 5: DOCUMENTATION
import {
  ModuleSummaryGeneratorSubagent,
  FinalDocumentGeneratorSubagent,
  DiagramGeneratorSubagent,
} from '../subagents';

// Level 6: QUALITY_REVIEW
import {
  DocumentQualityReviewerSubagent,
  AccuracyValidatorSubagent,
  CompletenessCheckerSubagent,
  ConsistencyCheckerSubagent,
  SourceReferenceValidatorSubagent,
  QualityGateSubagent,
  RegenerationPlannerSubagent,
  RegenerationOrchestratorSubagent,
  LinkValidatorSubagent,
  PageRegeneratorSubagent,
} from '../subagents';

// Level 7: OUTPUT
import {
  MarkdownFormatterSubagent,
  TOCGeneratorSubagent,
  IndexBuilderSubagent,
} from '../subagents';

/**
 * 7-Level Pipeline Architecture
 *
 * Level 1: DISCOVERY
 *   - ファイル発見
 *   - フレームワーク検出
 *
 * Level 2: CODE_EXTRACTION
 *   - AST解析
 *   - クラス/関数/インターフェース抽出
 *   - 行番号付きソース参照
 *
 * Level 3: DEEP_ANALYSIS (LLM)
 *   - クラス詳細分析
 *   - 関数詳細分析
 *   - モジュール詳細分析
 *   - フィードバックループで品質向上
 *
 * Level 4: RELATIONSHIP
 *   - 依存関係グラフ
 *   - 継承ツリー
 *   - クロスリファレンス
 *
 * Level 5: DOCUMENTATION
 *   - モジュールサマリー生成
 *   - ダイアグラム生成
 *   - 最終ドキュメント生成
 *
 * Level 6: QUALITY_REVIEW
 *   - 精度検証
 *   - 完全性チェック
 *   - 一貫性チェック
 *   - ドキュメント品質レビュー
 *
 * Level 7: OUTPUT
 *   - Markdownフォーマット
 *   - TOC生成
 *   - 検索インデックス構築
 */
export class PipelineOrchestrator implements IPipelineOrchestrator {
  private state: PipelineState;
  private aggregator: ResultAggregator;
  private parallelExecutor: ParallelExecutor;
  private progressCallback?: ProgressCallback;
  private cancelled = false;

  constructor() {
    this.state = {
      currentLevel: PipelineLevel.DISCOVERY,
      completedTasks: new Set(),
      pendingTasks: new Set(),
      results: new Map(),
      errors: [],
    };
    this.aggregator = new ResultAggregator();
    this.parallelExecutor = new ParallelExecutor();
  }

  /**
   * Execute the complete 7-level pipeline
   */
  async execute(context: PipelineContext): Promise<Map<string, unknown>> {
    logger.log('PipelineOrchestrator', 'Starting 7-level pipeline execution');

    // Initialize intermediate file manager
    initIntermediateFileManager(
      context.workspaceFolder.uri,
      context.parameters.outputPath
    );

    // Limit regeneration loops to avoid infinite recursion
    let regenerationAttempts = 0;

    try {
      // Build the 7-level pipeline
      const pipeline = this.buildPipeline(context);

      // Execute each level sequentially
    for (const level of [
      PipelineLevel.DISCOVERY,
      PipelineLevel.CODE_EXTRACTION,
      PipelineLevel.DEEP_ANALYSIS,
      PipelineLevel.RELATIONSHIP,
      PipelineLevel.DOCUMENTATION,
      PipelineLevel.QUALITY_REVIEW,
      PipelineLevel.OUTPUT,
    ]) {
        if (this.cancelled || context.token.isCancellationRequested) {
          throw new vscode.CancellationError();
        }

        this.state.currentLevel = level;
        const levelTasks = pipeline.get(level) || [];

        if (levelTasks.length === 0) {
          continue;
        }

        logger.log(
          'PipelineOrchestrator',
          `Executing Level ${level}: ${this.getLevelName(level)} (${levelTasks.length} tasks)`
        );

        await this.executeLevel(level, levelTasks, context);

        // After quality review, optionally rerun documentation + quality once if regeneration is requested
        if (level === PipelineLevel.QUALITY_REVIEW) {
          const regenResult = this.aggregator.getResultData<{ shouldRegenerate?: boolean }>(
            'regeneration-orchestrator'
          );
          if (regenResult?.shouldRegenerate && regenerationAttempts < 1) {
            regenerationAttempts++;
            logger.log('PipelineOrchestrator', 'Regeneration requested; rerunning documentation and quality review');

            const docTasks = pipeline.get(PipelineLevel.DOCUMENTATION) || [];
            const qualityTasks = pipeline.get(PipelineLevel.QUALITY_REVIEW) || [];

            if (docTasks.length > 0) {
              await this.executeLevel(PipelineLevel.DOCUMENTATION, docTasks, context);
            }
            if (qualityTasks.length > 0) {
              await this.executeLevel(PipelineLevel.QUALITY_REVIEW, qualityTasks, context);
            }
          }
        }
      }

      logger.log('PipelineOrchestrator', 'Pipeline execution completed successfully');
      return this.aggregator.getAllResults();
    } catch (error) {
      if (error instanceof vscode.CancellationError) {
        logger.log('PipelineOrchestrator', 'Pipeline execution cancelled');
        throw error;
      }

      logger.error('PipelineOrchestrator', 'Pipeline execution failed:', error);
      this.state.errors.push(
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  /**
   * Get human-readable level name
   */
  private getLevelName(level: PipelineLevel): string {
    switch (level) {
      case PipelineLevel.DISCOVERY:
        return 'Discovery';
      case PipelineLevel.CODE_EXTRACTION:
        return 'Code Extraction';
      case PipelineLevel.DEEP_ANALYSIS:
        return 'Deep Analysis (LLM)';
      case PipelineLevel.RELATIONSHIP:
        return 'Relationship Building';
      case PipelineLevel.DOCUMENTATION:
        return 'Documentation Generation';
      case PipelineLevel.QUALITY_REVIEW:
        return 'Quality Review';
      case PipelineLevel.OUTPUT:
        return 'Final Output';
      default:
        return `Level ${level}`;
    }
  }

  /**
   * Execute all tasks in a specific level
   */
  private async executeLevel(
    level: PipelineLevel,
    tasks: SubagentTask[],
    context: PipelineContext
  ): Promise<void> {
    // Get concurrency limit from configuration
    const config = vscode.workspace.getConfiguration('deepwiki');
    const maxConcurrency = config.get<number>('maxConcurrency', 5);

    // Separate parallel and sequential tasks
    const parallelTasks = tasks.filter((t) => this.canRunInParallel(t, level));
    const sequentialTasks = tasks.filter((t) => !this.canRunInParallel(t, level));

    // Execute parallel tasks first
    if (parallelTasks.length > 0) {
      const taskFunctions = parallelTasks.map((task) => () =>
        this.executeTask(task, context)
      );

      const result = await this.parallelExecutor.executeInParallel(taskFunctions, {
        maxConcurrency,
        stopOnError: false,
      });

      // Store results
      for (const success of result.successful) {
        const taskId = success.taskId.replace('task-', '');
        const task = parallelTasks[parseInt(taskId)];
        if (task) {
          this.aggregator.addResult(
            {
              taskId: task.id,
              status: TaskStatus.COMPLETED,
              data: success.data,
              duration: success.duration,
              startTime: success.startTime,
              endTime: success.endTime,
            },
            level
          );
          this.state.completedTasks.add(task.id);
        }
      }

      // Log failures but continue
      for (const failure of result.failed) {
        const taskId = failure.taskId.replace('task-', '');
        const task = parallelTasks[parseInt(taskId)];
        if (task) {
          logger.error('PipelineOrchestrator', `Task ${task.id} failed:`, failure.error);
          this.state.errors.push(failure.error || new Error('Unknown error'));
        }
      }
    }

    // Execute sequential tasks
    for (const task of sequentialTasks) {
      if (this.cancelled || context.token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      try {
        const startTime = Date.now();
        const result = await this.executeTask(task, context);
        const endTime = Date.now();

        this.aggregator.addResult(
          {
            taskId: task.id,
            status: TaskStatus.COMPLETED,
            data: result,
            duration: endTime - startTime,
            startTime,
            endTime,
          },
          level
        );
        this.state.completedTasks.add(task.id);
      } catch (error) {
        logger.error('PipelineOrchestrator', `Task ${task.id} failed:`, error);
        this.state.errors.push(error instanceof Error ? error : new Error(String(error)));
        // Continue with other tasks
      }
    }
  }

  /**
   * Execute a single task
   */
  private async executeTask(
    task: SubagentTask,
    pipelineContext: PipelineContext
  ): Promise<unknown> {
    const progress: ProgressCallback = (message: string, increment?: number) => {
      logger.log(task.id, message);
      if (this.progressCallback) {
        this.progressCallback(message, increment);
      }
    };

    const context: SubagentContext = {
      workspaceFolder: pipelineContext.workspaceFolder,
      model: pipelineContext.model,
      parameters: pipelineContext.parameters,
      previousResults: this.aggregator.getAllResults(),
      progress,
      token: pipelineContext.token,
    };

    return await task.execute(context);
  }

  /**
   * Determine if a task can run in parallel within its level
   */
  private canRunInParallel(task: SubagentTask, level: PipelineLevel): boolean {
    // Level 1: Run sequentially to ensure downstream discovery tasks see file-scanner results
    if (level === PipelineLevel.DISCOVERY) {
      return false;
    }

    // Level 2: Code extraction runs sequentially (single task)
    if (level === PipelineLevel.CODE_EXTRACTION) {
      return false;
    }

    // Level 3: LLM analyzers run sequentially (module analyzer depends on class/function)
    if (level === PipelineLevel.DEEP_ANALYSIS) {
      const parallelTasks = [
        'llm-class-analyzer',
        'llm-function-analyzer',
      ];
      return parallelTasks.includes(task.id);
    }

    // Level 4: Relationship tasks can run in parallel
    if (level === PipelineLevel.RELATIONSHIP) {
      return true;
    }

    // Level 5-7: Sequential for consistency
    return false;
  }

  /**
   * Build the 7-level pipeline structure
   */
  private buildPipeline(
    context: PipelineContext
  ): Map<PipelineLevel, SubagentTask[]> {
    const pipeline = new Map<PipelineLevel, SubagentTask[]>();

    // =======================================================================
    // Level 1: DISCOVERY - File discovery and basic information
    // =======================================================================
    pipeline.set(PipelineLevel.DISCOVERY, [
      new FileScannerSubagent(),
      new DependencyAnalyzerSubagent(),
      new LanguageDetectorSubagent(),
      new EntryPointFinderSubagent(),
      new ConfigFinderSubagent(),
      new FrameworkDetectorSubagent(),
    ]);

    // =======================================================================
    // Level 2: CODE_EXTRACTION - LLM-based universal code extraction
    // Supports ALL languages: TypeScript, JavaScript, Swift, Python, Java, Go, Rust, C++, C#, Ruby, PHP...
    // No more language-specific parsers (ts-morph, DocumentSymbol, etc.)
    // =======================================================================
    pipeline.set(PipelineLevel.CODE_EXTRACTION, [
      new LLMUniversalCodeExtractorSubagent(),
    ]);

    // =======================================================================
    // Level 3: DEEP_ANALYSIS - LLM-based deep analysis with feedback loop
    // =======================================================================
    pipeline.set(PipelineLevel.DEEP_ANALYSIS, [
      new LLMClassAnalyzerSubagent(),
      new LLMFunctionAnalyzerSubagent(),
      new LLMModuleAnalyzerSubagent(), // Runs after class/function analyzers
    ]);

    // =======================================================================
    // Level 4: RELATIONSHIP - Relationship building
    // =======================================================================
    pipeline.set(PipelineLevel.RELATIONSHIP, [
      new DependencyMapperSubagent(),
      new CrossReferencerSubagent(),
      new InheritanceTreeBuilderSubagent(),
      new CallGraphBuilderSubagent(),
      new ModuleBoundaryBuilderSubagent(),
      new LayerViolationCheckerSubagent(),
    ]);

    // =======================================================================
    // Level 5: DOCUMENTATION - Document generation with feedback loop
    // =======================================================================
    pipeline.set(PipelineLevel.DOCUMENTATION, [
      new ModuleSummaryGeneratorSubagent(),
      new DiagramGeneratorSubagent(),
      new FinalDocumentGeneratorSubagent(),
    ]);

    // =======================================================================
    // Level 6: QUALITY_REVIEW - Quality review and improvement
    // =======================================================================
    pipeline.set(PipelineLevel.QUALITY_REVIEW, [
      new DocumentQualityReviewerSubagent(),
      new AccuracyValidatorSubagent(),
      new CompletenessCheckerSubagent(),
      new ConsistencyCheckerSubagent(),
      new SourceReferenceValidatorSubagent(),
      new LinkValidatorSubagent(),
      new QualityGateSubagent(),
      new RegenerationPlannerSubagent(),
      new RegenerationOrchestratorSubagent(),
      new PageRegeneratorSubagent(),
    ]);

    // =======================================================================
    // Level 7: OUTPUT - Final output generation
    // =======================================================================
    pipeline.set(PipelineLevel.OUTPUT, [
      new MarkdownFormatterSubagent(),
      new TOCGeneratorSubagent(),
      new IndexBuilderSubagent(),
    ]);

    return pipeline;
  }

  /**
   * Get current progress
   */
  getProgress(): { current: number; total: number; currentTask: string } {
    const total = this.state.completedTasks.size + this.state.pendingTasks.size;
    const current = this.state.completedTasks.size;
    const currentTask = this.getLevelName(this.state.currentLevel);

    return { current, total, currentTask };
  }

  /**
   * Cancel the pipeline execution
   */
  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Set progress callback
   */
  setProgressCallback(callback: ProgressCallback): void {
    this.progressCallback = callback;
  }

  /**
   * Get aggregator for accessing results
   */
  getAggregator(): ResultAggregator {
    return this.aggregator;
  }
}
