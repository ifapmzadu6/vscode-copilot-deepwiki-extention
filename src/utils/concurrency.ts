/**
 * Concurrency control utilities for limiting parallel subagent execution.
 */
import { logger } from './logger';
/**
 * Execute an array of async tasks with a maximum concurrency limit.
 * This prevents rate limiting issues when running many subagents in parallel.
 * Failed tasks are retried once after all initial tasks complete.
 *
 * @param tasks - Array of functions that return promises
 * @param maxConcurrency - Maximum number of tasks to run in parallel (default: 3)
 * @param taskGroupName - Optional name for logging purposes
 * @returns Promise that resolves to an array of results in the same order as input
 */
export async function runWithConcurrencyLimit<T>(
    tasks: (() => Promise<T>)[],
    maxConcurrency: number = 3,
    taskGroupName: string = 'Tasks'
): Promise<T[]> {
    if (tasks.length === 0) {
        logger.log('Concurrency', `${taskGroupName}: No tasks to execute`);
        return [];
    }

    // Ensure maxConcurrency is at least 1
    const limit = Math.max(1, Math.min(maxConcurrency, tasks.length));
    logger.log('Concurrency', `${taskGroupName}: Starting ${tasks.length} tasks with concurrency limit ${limit}`);

    const results: T[] = new Array(tasks.length);
    const failedIndices: number[] = [];
    let currentIndex = 0;
    let completedCount = 0;
    const startTime = Date.now();

    // First pass: run all tasks
    await new Promise<void>((resolve) => {
        let settledCount = 0;

        const runNext = async (workerIndex: number): Promise<void> => {
            while (currentIndex < tasks.length) {
                const taskIndex = currentIndex++;
                const taskStartTime = Date.now();
                logger.log('Concurrency', `${taskGroupName}[${taskIndex + 1}/${tasks.length}]: Starting (worker ${workerIndex})`);

                try {
                    results[taskIndex] = await tasks[taskIndex]();
                    completedCount++;
                    const taskDuration = ((Date.now() - taskStartTime) / 1000).toFixed(1);
                    logger.log('Concurrency', `${taskGroupName}[${taskIndex + 1}/${tasks.length}]: Completed in ${taskDuration}s`);
                } catch (error) {
                    const taskDuration = ((Date.now() - taskStartTime) / 1000).toFixed(1);
                    logger.warn('Concurrency', `${taskGroupName}[${taskIndex + 1}/${tasks.length}]: Failed after ${taskDuration}s, will retry later - ${String(error)}`);
                    failedIndices.push(taskIndex);
                }

                settledCount++;
                if (settledCount === tasks.length) {
                    resolve();
                }
            }
        };

        // Start initial workers with staggered delay to avoid rate limits
        for (let i = 0; i < limit; i++) {
            setTimeout(() => runNext(i), i * 5000); // 5 second delay between each worker
        }
    });

    // Retry pass: retry failed tasks once
    if (failedIndices.length > 0) {
        logger.log('Concurrency', `${taskGroupName}: Retrying ${failedIndices.length} failed tasks...`);

        for (const taskIndex of failedIndices) {
            const taskStartTime = Date.now();
            logger.log('Concurrency', `${taskGroupName}[${taskIndex + 1}/${tasks.length}]: Retrying...`);

            try {
                results[taskIndex] = await tasks[taskIndex]();
                completedCount++;
                const taskDuration = ((Date.now() - taskStartTime) / 1000).toFixed(1);
                logger.log('Concurrency', `${taskGroupName}[${taskIndex + 1}/${tasks.length}]: Retry succeeded in ${taskDuration}s`);
            } catch (error) {
                const taskDuration = ((Date.now() - taskStartTime) / 1000).toFixed(1);
                logger.error('Concurrency', `${taskGroupName}[${taskIndex + 1}/${tasks.length}]: Retry failed after ${taskDuration}s`, error);
            }
        }
    }

    const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
    const finalFailedCount = tasks.length - completedCount;
    logger.log('Concurrency', `${taskGroupName}: All ${tasks.length} tasks settled in ${totalDuration}s (${completedCount} passed, ${finalFailedCount} failed)`);

    return results;
}

/**
 * Default maximum concurrency for subagent execution.
 * This value balances throughput with API rate limits.
 */
export const DEFAULT_MAX_CONCURRENCY = 3;
