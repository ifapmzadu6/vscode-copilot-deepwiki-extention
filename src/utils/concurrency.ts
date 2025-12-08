/**
 * Concurrency control utilities for limiting parallel subagent execution.
 */

/**
 * Execute an array of async tasks with a maximum concurrency limit.
 * This prevents rate limiting issues when running many subagents in parallel.
 *
 * @param tasks - Array of functions that return promises
 * @param maxConcurrency - Maximum number of tasks to run in parallel (default: 5)
 * @returns Promise that resolves to an array of results in the same order as input
 */
export async function runWithConcurrencyLimit<T>(
    tasks: (() => Promise<T>)[],
    maxConcurrency: number = 5
): Promise<T[]> {
    if (tasks.length === 0) {
        return [];
    }

    // Ensure maxConcurrency is at least 1
    const limit = Math.max(1, Math.min(maxConcurrency, tasks.length));

    const results: T[] = new Array(tasks.length);
    let currentIndex = 0;
    let completedCount = 0;

    return new Promise((resolve, reject) => {
        let hasRejected = false;

        const runNext = async (workerIndex: number): Promise<void> => {
            while (currentIndex < tasks.length && !hasRejected) {
                const taskIndex = currentIndex++;
                try {
                    results[taskIndex] = await tasks[taskIndex]();
                    completedCount++;

                    if (completedCount === tasks.length) {
                        resolve(results);
                    }
                } catch (error) {
                    if (!hasRejected) {
                        hasRejected = true;
                        reject(error);
                    }
                    return;
                }
            }
        };

        // Start initial workers up to the concurrency limit
        const workers: Promise<void>[] = [];
        for (let i = 0; i < limit; i++) {
            workers.push(runNext(i));
        }
    });
}

/**
 * Default maximum concurrency for subagent execution.
 * This value balances throughput with API rate limits.
 */
export const DEFAULT_MAX_CONCURRENCY = 5;
