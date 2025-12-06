import {
  IParallelExecutor,
  ParallelExecutionOptions,
  ParallelExecutionResult,
  TaskResult,
  TaskStatus,
} from '../types/pipeline';

/**
 * Manages parallel execution of tasks with concurrency control
 */
export class ParallelExecutor implements IParallelExecutor {
  /**
   * Execute multiple tasks in parallel with optional concurrency limit
   */
  async executeInParallel<T>(
    tasks: Array<() => Promise<T>>,
    options?: ParallelExecutionOptions
  ): Promise<ParallelExecutionResult<T>> {
    const maxConcurrency = options?.maxConcurrency || Infinity;
    const stopOnError = options?.stopOnError ?? false;
    const timeout = options?.timeout;

    const startTime = Date.now();
    const successful: TaskResult<T>[] = [];
    const failed: TaskResult<T>[] = [];
    const skipped: string[] = [];

    let currentIndex = 0;
    const executing = new Map<number, Promise<void>>();
    let hasError = false;

    const executeTask = async (taskIndex: number): Promise<void> => {
      if (hasError && stopOnError) {
        skipped.push(`task-${taskIndex}`);
        return;
      }

      const taskStartTime = Date.now();
      const taskId = `task-${taskIndex}`;

      try {
        const taskPromise = tasks[taskIndex]();
        const result = timeout
          ? await this.withTimeout(taskPromise, timeout)
          : await taskPromise;

        const taskEndTime = Date.now();
        successful.push({
          taskId,
          status: TaskStatus.COMPLETED,
          data: result,
          duration: taskEndTime - taskStartTime,
          startTime: taskStartTime,
          endTime: taskEndTime,
        });
      } catch (error) {
        const taskEndTime = Date.now();
        hasError = true;

        failed.push({
          taskId,
          status: TaskStatus.FAILED,
          error: error instanceof Error ? error : new Error(String(error)),
          duration: taskEndTime - taskStartTime,
          startTime: taskStartTime,
          endTime: taskEndTime,
        });

        if (stopOnError) {
          return;
        }
      }
    };

    // Execute tasks with concurrency control
    while (currentIndex < tasks.length || executing.size > 0) {
      // Start new tasks up to the concurrency limit
      while (
        currentIndex < tasks.length &&
        executing.size < maxConcurrency &&
        !(hasError && stopOnError)
      ) {
        const taskIndex = currentIndex;
        const taskPromise = executeTask(taskIndex).finally(() => {
          executing.delete(taskIndex);
        });
        executing.set(taskIndex, taskPromise);
        currentIndex++;
      }

      // Wait for at least one task to complete
      if (executing.size > 0) {
        await Promise.race(Array.from(executing.values()));
      }
    }

    const totalDuration = Date.now() - startTime;

    return {
      successful,
      failed,
      skipped,
      totalDuration,
    };
  }

  /**
   * Execute a promise with a timeout
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('Task timeout')), timeoutMs)
      ),
    ]);
  }

  /**
   * Execute tasks in batches
   */
  async executeInBatches<T>(
    tasks: Array<() => Promise<T>>,
    batchSize: number
  ): Promise<ParallelExecutionResult<T>> {
    const results: ParallelExecutionResult<T> = {
      successful: [],
      failed: [],
      skipped: [],
      totalDuration: 0,
    };

    const startTime = Date.now();

    for (let i = 0; i < tasks.length; i += batchSize) {
      const batch = tasks.slice(i, i + batchSize);
      const batchResult = await this.executeInParallel(batch);

      results.successful.push(...batchResult.successful);
      results.failed.push(...batchResult.failed);
      results.skipped.push(...batchResult.skipped);
    }

    results.totalDuration = Date.now() - startTime;

    return results;
  }
}
