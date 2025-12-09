/**
 * Concurrency control utilities for limiting parallel subagent execution.
 */
import * as vscode from 'vscode';
import { logger } from './logger';
/**
 * Execute an array of async tasks with a maximum concurrency limit.
 * This prevents rate limiting issues when running many subagents in parallel.
 * Failed tasks are retried once after all initial tasks complete.
 *
 * @param tasks - Array of functions that return promises
 * @param maxConcurrency - Maximum number of tasks to run in parallel (default: 3)
 * @param taskGroupName - Optional name for logging purposes
 * @param cancellationToken - Optional cancellation token to abort execution
 * @returns Promise that resolves to an array of results in the same order as input
 */
export async function runWithConcurrencyLimit<T>(
    tasks: (() => Promise<T>)[],
    maxConcurrency: number = 3,
    taskGroupName: string = 'Tasks',
    cancellationToken?: vscode.CancellationToken
): Promise<T[]> {
    if (tasks.length === 0) {
        logger.log('Concurrency', `${taskGroupName}: No tasks to execute`);
        return [];
    }

    // Check for cancellation before starting
    if (cancellationToken?.isCancellationRequested) {
        logger.warn('Concurrency', `${taskGroupName}: Cancelled before starting`);
        throw new vscode.CancellationError();
    }

    // Ensure maxConcurrency is at least 1
    const limit = Math.max(1, Math.min(maxConcurrency, tasks.length));
    logger.log('Concurrency', `${taskGroupName}: Starting ${tasks.length} tasks with concurrency limit ${limit}`);

    const results: T[] = new Array(tasks.length);
    const failedIndices: number[] = [];
    let currentIndex = 0;
    let completedCount = 0;
    let cancelled = false;
    const startTime = Date.now();

    // Set up cancellation listener
    const cancellationListener = cancellationToken?.onCancellationRequested(() => {
        cancelled = true;
        logger.warn('Concurrency', `${taskGroupName}: Cancellation requested`);
    });

    try {
        // First pass: run all tasks
        await new Promise<void>((resolve) => {
            let settledCount = 0;

            const runNext = async (workerIndex: number): Promise<void> => {
                while (currentIndex < tasks.length && !cancelled) {
                    const taskIndex = currentIndex++;
                    const taskStartTime = Date.now();
                    logger.log('Concurrency', `${taskGroupName}[${taskIndex + 1}/${tasks.length}]: Starting (worker ${workerIndex})`);

                    try {
                        results[taskIndex] = await tasks[taskIndex]();
                        completedCount++;
                        const taskDuration = ((Date.now() - taskStartTime) / 1000).toFixed(1);
                        logger.log('Concurrency', `${taskGroupName}[${taskIndex + 1}/${tasks.length}]: Completed in ${taskDuration}s`);
                    } catch (error) {
                        if (error instanceof vscode.CancellationError) {
                            cancelled = true;
                        } else {
                            const taskDuration = ((Date.now() - taskStartTime) / 1000).toFixed(1);
                            logger.warn('Concurrency', `${taskGroupName}[${taskIndex + 1}/${tasks.length}]: Failed after ${taskDuration}s, will retry later - ${String(error)}`);
                            failedIndices.push(taskIndex);
                        }
                    }

                    settledCount++;
                    if (settledCount === tasks.length || cancelled) {
                        resolve();
                    }
                }
            };

            // Start initial workers with staggered delay to avoid rate limits
            for (let i = 0; i < limit; i++) {
                setTimeout(() => {
                    if (!cancelled) {
                        runNext(i);
                    } else {
                        settledCount += (tasks.length - currentIndex);
                        if (settledCount >= tasks.length) {
                            resolve();
                        }
                    }
                }, i * 5000); // 5 second delay between each worker
            }
        });

        // Check for cancellation before retry
        if (cancelled) {
            throw new vscode.CancellationError();
        }

        // Retry pass: retry failed tasks once
        if (failedIndices.length > 0) {
            logger.log('Concurrency', `${taskGroupName}: Retrying ${failedIndices.length} failed tasks...`);

            for (const taskIndex of failedIndices) {
                if (cancelled) break;

                const taskStartTime = Date.now();
                logger.log('Concurrency', `${taskGroupName}[${taskIndex + 1}/${tasks.length}]: Retrying...`);

                try {
                    results[taskIndex] = await tasks[taskIndex]();
                    completedCount++;
                    const taskDuration = ((Date.now() - taskStartTime) / 1000).toFixed(1);
                    logger.log('Concurrency', `${taskGroupName}[${taskIndex + 1}/${tasks.length}]: Retry succeeded in ${taskDuration}s`);
                } catch (error) {
                    if (error instanceof vscode.CancellationError) {
                        cancelled = true;
                        break;
                    }
                    const taskDuration = ((Date.now() - taskStartTime) / 1000).toFixed(1);
                    logger.error('Concurrency', `${taskGroupName}[${taskIndex + 1}/${tasks.length}]: Retry failed after ${taskDuration}s`, error);
                }
            }
        }

        if (cancelled) {
            throw new vscode.CancellationError();
        }

        const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
        const finalFailedCount = tasks.length - completedCount;
        logger.log('Concurrency', `${taskGroupName}: All ${tasks.length} tasks settled in ${totalDuration}s (${completedCount} passed, ${finalFailedCount} failed)`);

        return results;
    } finally {
        // Clean up cancellation listener
        cancellationListener?.dispose();
    }
}

/**
 * Default maximum concurrency for subagent execution.
 * This value balances throughput with API rate limits.
 */
export const DEFAULT_MAX_CONCURRENCY = 2;
