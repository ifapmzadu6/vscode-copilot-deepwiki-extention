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
import {
  FileScannerSubagent,
  CodeParserSubagent,
  DependencyMapperSubagent,
  FrameworkDetectorSubagent,
  PatternRecognizerSubagent,
  FunctionAnalyzerSubagent,
  ClassAnalyzerSubagent,
  APIExtractorSubagent,
  TypeAnalyzerSubagent,
  ExampleGeneratorSubagent,
  CrossReferencerSubagent,
  AccuracyValidatorSubagent,
  CompletenessCheckerSubagent,
  ConsistencyCheckerSubagent,
  MarkdownFormatterSubagent,
  TOCGeneratorSubagent,
  IndexBuilderSubagent,
  StructureAnalyzerSubagent,
  DependencyAnalyzerSubagent,
  ArchitectureAnalyzerSubagent,
  ModuleDocumenterSubagent,
  DiagramGeneratorSubagent,
  OverviewGeneratorSubagent,
} from '../subagents';

/**
 * Orchestrates the entire multi-stage analysis pipeline
 */
export class PipelineOrchestrator implements IPipelineOrchestrator {
  private state: PipelineState;
  private aggregator: ResultAggregator;
  private parallelExecutor: ParallelExecutor;
  private progressCallback?: ProgressCallback;
  private cancelled = false;

  constructor() {
    this.state = {
      currentLevel: PipelineLevel.ANALYSIS,
      completedTasks: new Set(),
      pendingTasks: new Set(),
      results: new Map(),
      errors: [],
    };
    this.aggregator = new ResultAggregator();
    this.parallelExecutor = new ParallelExecutor();
  }

  /**
   * Execute the complete pipeline
   */
  async execute(context: PipelineContext): Promise<Map<string, unknown>> {
    console.log('[PipelineOrchestrator] Starting pipeline execution');

    try {
      // Define the pipeline levels and their tasks
      const pipeline = this.buildPipeline(context);

      // Execute each level sequentially, but tasks within a level can run in parallel
      for (const level of [
        PipelineLevel.ANALYSIS,
        PipelineLevel.DEEP_ANALYSIS,
        PipelineLevel.QUALITY_ENHANCEMENT,
        PipelineLevel.VALIDATION,
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

        console.log(
          `[PipelineOrchestrator] Executing Level ${level}: ${levelTasks.length} tasks`
        );

        await this.executeLevel(level, levelTasks, context);
      }

      console.log('[PipelineOrchestrator] Pipeline execution completed');
      return this.aggregator.getAllResults();
    } catch (error) {
      if (error instanceof vscode.CancellationError) {
        console.log('[PipelineOrchestrator] Pipeline execution cancelled');
        throw error;
      }

      console.error('[PipelineOrchestrator] Pipeline execution failed:', error);
      this.state.errors.push(
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
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
    const config = await vscode.workspace.getConfiguration('deepwiki');
    const maxConcurrency = config.get<number>('maxConcurrency', 5);

    // Separate parallel and sequential tasks
    const parallelTasks = tasks.filter((t) => this.canRunInParallel(t));
    const sequentialTasks = tasks.filter((t) => !this.canRunInParallel(t));

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
          console.error(`[PipelineOrchestrator] Task ${task.id} failed:`, failure.error);
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
        const result = await this.executeTask(task, context);
        this.aggregator.addResult(
          {
            taskId: task.id,
            status: TaskStatus.COMPLETED,
            data: result,
            duration: 0,
            startTime: Date.now(),
            endTime: Date.now(),
          },
          level
        );
        this.state.completedTasks.add(task.id);
      } catch (error) {
        console.error(`[PipelineOrchestrator] Task ${task.id} failed:`, error);
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
      console.log(`[${task.id}] ${message}`);
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
   * Determine if a task can run in parallel
   */
  private canRunInParallel(task: SubagentTask): boolean {
    // Tasks at level 1 (ANALYSIS) can mostly run in parallel
    // Tasks at level 2 (DEEP_ANALYSIS) can run in parallel per module
    // Level 3+ typically need results from previous levels
    const parallelTaskIds = [
      'file-scanner',
      'framework-detector',
      'pattern-recognizer',
      'function-analyzer',
      'class-analyzer',
      'api-extractor',
      'type-analyzer',
      'example-generator',
    ];

    return parallelTaskIds.includes(task.id);
  }

  /**
   * Build the pipeline structure
   */
  private buildPipeline(
    context: PipelineContext
  ): Map<PipelineLevel, SubagentTask[]> {
    const pipeline = new Map<PipelineLevel, SubagentTask[]>();

    // Level 1: Analysis Phase (can run in parallel)
    pipeline.set(PipelineLevel.ANALYSIS, [
      new FileScannerSubagent(),
      new StructureAnalyzerSubagent(), // Keep for compatibility
      new DependencyAnalyzerSubagent(), // Keep for compatibility
      new FrameworkDetectorSubagent(),
      new ArchitectureAnalyzerSubagent(), // Keep for compatibility
    ]);

    // Level 2: Deep Analysis Phase (needs Level 1 results)
    pipeline.set(PipelineLevel.DEEP_ANALYSIS, [
      new CodeParserSubagent(),
      new DependencyMapperSubagent(),
      new PatternRecognizerSubagent(),
      new FunctionAnalyzerSubagent(),
      new ClassAnalyzerSubagent(),
      new APIExtractorSubagent(),
      new TypeAnalyzerSubagent(),
      new ModuleDocumenterSubagent(), // Keep for compatibility
    ]);

    // Level 3: Quality Enhancement Phase
    pipeline.set(PipelineLevel.QUALITY_ENHANCEMENT, [
      new ExampleGeneratorSubagent(),
      new DiagramGeneratorSubagent(), // Keep for compatibility
      new CrossReferencerSubagent(),
    ]);

    // Level 4: Validation Phase
    pipeline.set(PipelineLevel.VALIDATION, [
      new AccuracyValidatorSubagent(),
      new CompletenessCheckerSubagent(),
      new ConsistencyCheckerSubagent(),
    ]);

    // Level 5: Output Phase
    pipeline.set(PipelineLevel.OUTPUT, [
      new OverviewGeneratorSubagent(), // Keep for final document generation
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
    const currentTask = `Level ${this.state.currentLevel}`;

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
