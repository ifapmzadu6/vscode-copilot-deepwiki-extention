import * as vscode from 'vscode';
import { SubagentContext } from './index';

/**
 * Pipeline execution level/phase
 */
export enum PipelineLevel {
  ANALYSIS = 1,
  DEEP_ANALYSIS = 2,
  QUALITY_ENHANCEMENT = 3,
  VALIDATION = 4,
  OUTPUT = 5,
}

/**
 * Status of a pipeline task
 */
export enum TaskStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

/**
 * Result of a pipeline task execution
 */
export interface TaskResult<T = unknown> {
  taskId: string;
  status: TaskStatus;
  data?: T;
  error?: Error;
  duration: number;
  startTime: number;
  endTime?: number;
}

/**
 * Configuration for a pipeline task
 */
export interface PipelineTaskConfig {
  id: string;
  name: string;
  level: PipelineLevel;
  dependencies: string[];
  parallel: boolean;
  optional: boolean;
  retryCount?: number;
  timeout?: number;
}

/**
 * Context for pipeline execution
 */
export interface PipelineContext {
  workspaceFolder: vscode.WorkspaceFolder;
  model: vscode.LanguageModelChat;
  parameters: {
    outputPath?: string;
    includePrivate?: boolean;
    maxDepth?: number;
  };
  token: vscode.CancellationToken;
}

/**
 * Pipeline execution state
 */
export interface PipelineState {
  currentLevel: PipelineLevel;
  completedTasks: Set<string>;
  pendingTasks: Set<string>;
  results: Map<string, TaskResult>;
  errors: Error[];
}

/**
 * Options for parallel execution
 */
export interface ParallelExecutionOptions {
  maxConcurrency?: number;
  stopOnError?: boolean;
  timeout?: number;
}

/**
 * Result of parallel execution
 */
export interface ParallelExecutionResult<T = unknown> {
  successful: TaskResult<T>[];
  failed: TaskResult<T>[];
  skipped: string[];
  totalDuration: number;
}

/**
 * Interface for pipeline orchestrator
 */
export interface IPipelineOrchestrator {
  execute(context: PipelineContext): Promise<Map<string, unknown>>;
  getProgress(): { current: number; total: number; currentTask: string };
  cancel(): void;
}

/**
 * Interface for parallel executor
 */
export interface IParallelExecutor {
  executeInParallel<T>(
    tasks: Array<() => Promise<T>>,
    options?: ParallelExecutionOptions
  ): Promise<ParallelExecutionResult<T>>;
}

/**
 * Interface for result aggregator
 */
export interface IResultAggregator {
  aggregate(results: Map<string, TaskResult>): Map<string, unknown>;
  getResultByLevel(level: PipelineLevel): Map<string, unknown>;
  getAllResults(): Map<string, unknown>;
}
