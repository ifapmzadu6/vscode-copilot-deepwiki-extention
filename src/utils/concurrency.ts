/**
 * Sequential task execution utilities.
 */
import * as vscode from 'vscode';
import { logger } from './logger';

/**
 * Execute an array of async tasks sequentially.
 * Failed tasks are retried once after all initial tasks complete.
 *
 * @param tasks - Array of functions that return promises
 * @param taskGroupName - Optional name for logging purposes
 * @param cancellationToken - Optional cancellation token to abort execution
 * @returns Promise that resolves to an array of results in the same order as input
 */
export async function runTasksSequentially<T>(
    tasks: (() => Promise<T>)[],
    taskGroupName: string = 'Tasks',
    cancellationToken?: vscode.CancellationToken
): Promise<T[]> {
    if (tasks.length === 0) {
        logger.log('Tasks', `${taskGroupName}: No tasks to execute`);
        return [];
    }

    // Check for cancellation before starting
    if (cancellationToken?.isCancellationRequested) {
        logger.warn('Tasks', `${taskGroupName}: Cancelled before starting`);
        throw new vscode.CancellationError();
    }

    logger.log('Tasks', `${taskGroupName}: Starting ${tasks.length} tasks sequentially`);

    const results: T[] = new Array(tasks.length);
    const failedIndices: number[] = [];
    let completedCount = 0;
    const startTime = Date.now();

    // First pass: run all tasks sequentially
    for (let i = 0; i < tasks.length; i++) {
        if (cancellationToken?.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        const taskStartTime = Date.now();
        logger.log('Tasks', `${taskGroupName}[${i + 1}/${tasks.length}]: Starting`);

        try {
            results[i] = await tasks[i]();
            completedCount++;
            const taskDuration = ((Date.now() - taskStartTime) / 1000).toFixed(1);
            logger.log('Tasks', `${taskGroupName}[${i + 1}/${tasks.length}]: Completed in ${taskDuration}s`);
        } catch (error) {
            if (error instanceof vscode.CancellationError) {
                throw error;
            }
            const taskDuration = ((Date.now() - taskStartTime) / 1000).toFixed(1);
            logger.warn('Tasks', `${taskGroupName}[${i + 1}/${tasks.length}]: Failed after ${taskDuration}s, will retry later - ${String(error)}`);
            failedIndices.push(i);
        }
    }

    // Retry pass: retry failed tasks once
    if (failedIndices.length > 0) {
        logger.log('Tasks', `${taskGroupName}: Retrying ${failedIndices.length} failed tasks...`);

        for (const taskIndex of failedIndices) {
            if (cancellationToken?.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            const taskStartTime = Date.now();
            logger.log('Tasks', `${taskGroupName}[${taskIndex + 1}/${tasks.length}]: Retrying...`);

            try {
                results[taskIndex] = await tasks[taskIndex]();
                completedCount++;
                const taskDuration = ((Date.now() - taskStartTime) / 1000).toFixed(1);
                logger.log('Tasks', `${taskGroupName}[${taskIndex + 1}/${tasks.length}]: Retry succeeded in ${taskDuration}s`);
            } catch (error) {
                if (error instanceof vscode.CancellationError) {
                    throw error;
                }
                const taskDuration = ((Date.now() - taskStartTime) / 1000).toFixed(1);
                logger.error('Tasks', `${taskGroupName}[${taskIndex + 1}/${tasks.length}]: Retry failed after ${taskDuration}s`, error);
            }
        }
    }

    const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
    const finalFailedCount = tasks.length - completedCount;
    logger.log('Tasks', `${taskGroupName}: All ${tasks.length} tasks settled in ${totalDuration}s (${completedCount} passed, ${finalFailedCount} failed)`);

    return results;
}
