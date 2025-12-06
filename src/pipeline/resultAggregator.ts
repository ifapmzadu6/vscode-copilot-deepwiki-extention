import {
  IResultAggregator,
  TaskResult,
  PipelineLevel,
  TaskStatus,
} from '../types/pipeline';

/**
 * Aggregates and manages results from pipeline tasks
 *
 * File-based approach:
 * - Subagents save their results to intermediate files
 * - ResultAggregator only stores metadata (file paths, status, duration)
 * - Actual data is loaded from files on-demand
 */
export class ResultAggregator implements IResultAggregator {
  // Metadata only - not the actual data
  private results: Map<string, TaskResult>;
  private levelMap: Map<PipelineLevel, Set<string>>;

  constructor() {
    this.results = new Map();
    this.levelMap = new Map();

    // Initialize level map
    Object.values(PipelineLevel)
      .filter((v) => typeof v === 'number')
      .forEach((level) => {
        this.levelMap.set(level as PipelineLevel, new Set());
      });
  }

  /**
   * Add a result to the aggregator
   *
   * Note: result.data should be lightweight metadata only, NOT the full data.
   * The full data should be saved to intermediate files by the subagent.
   */
  addResult(result: TaskResult, level: PipelineLevel): void {
    this.results.set(result.taskId, result);
    this.levelMap.get(level)?.add(result.taskId);
  }

  /**
   * Aggregate all results into a simplified map
   */
  aggregate(results: Map<string, TaskResult>): Map<string, unknown> {
    const aggregated = new Map<string, unknown>();

    for (const [taskId, result] of results.entries()) {
      if (result.status === TaskStatus.COMPLETED && result.data !== undefined) {
        aggregated.set(taskId, result.data);
      }
    }

    return aggregated;
  }

  /**
   * Get results by pipeline level
   */
  getResultByLevel(level: PipelineLevel): Map<string, unknown> {
    const levelResults = new Map<string, unknown>();
    const taskIds = this.levelMap.get(level);

    if (taskIds) {
      for (const taskId of taskIds) {
        const result = this.results.get(taskId);
        if (result?.status === TaskStatus.COMPLETED && result.data !== undefined) {
          levelResults.set(taskId, result.data);
        }
      }
    }

    return levelResults;
  }

  /**
   * Get all successful results
   */
  getAllResults(): Map<string, unknown> {
    return this.aggregate(this.results);
  }

  /**
   * Get failed results
   */
  getFailedResults(): Map<string, TaskResult> {
    const failed = new Map<string, TaskResult>();

    for (const [taskId, result] of this.results.entries()) {
      if (result.status === TaskStatus.FAILED) {
        failed.set(taskId, result);
      }
    }

    return failed;
  }

  /**
   * Get completion statistics
   */
  getStatistics(): {
    total: number;
    completed: number;
    failed: number;
    skipped: number;
    totalDuration: number;
    averageDuration: number;
  } {
    let total = 0;
    let completed = 0;
    let failed = 0;
    let skipped = 0;
    let totalDuration = 0;

    for (const result of this.results.values()) {
      total++;
      totalDuration += result.duration;

      switch (result.status) {
        case TaskStatus.COMPLETED:
          completed++;
          break;
        case TaskStatus.FAILED:
          failed++;
          break;
        case TaskStatus.SKIPPED:
          skipped++;
          break;
      }
    }

    return {
      total,
      completed,
      failed,
      skipped,
      totalDuration,
      averageDuration: total > 0 ? totalDuration / total : 0,
    };
  }

  /**
   * Get results for specific task IDs
   */
  getResults(taskIds: string[]): Map<string, unknown> {
    const results = new Map<string, unknown>();

    for (const taskId of taskIds) {
      const result = this.results.get(taskId);
      if (result?.status === TaskStatus.COMPLETED && result.data !== undefined) {
        results.set(taskId, result.data);
      }
    }

    return results;
  }

  /**
   * Check if a task completed successfully
   */
  hasSuccessfulResult(taskId: string): boolean {
    const result = this.results.get(taskId);
    return result?.status === TaskStatus.COMPLETED;
  }

  /**
   * Get the result data for a specific task
   */
  getResultData<T>(taskId: string): T | undefined {
    const result = this.results.get(taskId);
    return result?.status === TaskStatus.COMPLETED ? (result.data as T) : undefined;
  }
}
