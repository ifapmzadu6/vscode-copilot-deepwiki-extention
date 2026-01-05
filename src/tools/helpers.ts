import * as vscode from 'vscode';
import { logger } from '../utils/logger';

/**
 * Component definition for the DeepWiki pipeline.
 * - id: internal identifier (immutable, used for L3 filenames, page_groups, retry references)
 * - name: display name and output filename (can be refined by L4)
 */
export interface ComponentDef {
    id: string;
    name: string;
    files: string[];
    description: string;
}

/**
 * Sanitize a tool name for safe inclusion in prompts.
 * Removes backticks, newlines, and limits length.
 */
export function sanitizeToolNameForPrompt(value: string): string {
    return value
        .replace(/[`]/g, '')
        .replace(/[\r\n\t]/g, ' ')
        .trim()
        .slice(0, 80);
}

/**
 * Execute an array of async tasks sequentially.
 * Failed tasks are retried once after all initial tasks complete.
 */
export async function runTasksSequentially<T>(
    tasks: (() => Promise<T>)[],
    taskGroupName: string,
    cancellationToken?: vscode.CancellationToken
): Promise<T[]> {
    if (tasks.length === 0) {
        logger.log('Tasks', `${taskGroupName}: No tasks to execute`);
        return [];
    }

    if (cancellationToken?.isCancellationRequested) {
        throw new vscode.CancellationError();
    }

    logger.log('Tasks', `${taskGroupName}: Starting ${tasks.length} tasks sequentially`);

    const results: (T | undefined)[] = new Array<T | undefined>(tasks.length).fill(undefined);
    const failedIndices: number[] = [];
    let completedCount = 0;
    const startTime = Date.now();

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
            logger.warn(
                'Tasks',
                `${taskGroupName}[${i + 1}/${tasks.length}]: Failed after ${taskDuration}s, will retry later - ${String(error)}`
            );
            failedIndices.push(i);
        }
    }

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
                logger.log(
                    'Tasks',
                    `${taskGroupName}[${taskIndex + 1}/${tasks.length}]: Retry succeeded in ${taskDuration}s`
                );
            } catch (error) {
                if (error instanceof vscode.CancellationError) {
                    throw error;
                }
                const taskDuration = ((Date.now() - taskStartTime) / 1000).toFixed(1);
                logger.error(
                    'Tasks',
                    `${taskGroupName}[${taskIndex + 1}/${tasks.length}]: Retry failed after ${taskDuration}s`,
                    error
                );
            }
        }
    }

    const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
    const finalFailedCount = tasks.length - completedCount;
    logger.log(
        'Tasks',
        `${taskGroupName}: All ${tasks.length} tasks settled in ${totalDuration}s (${completedCount} passed, ${finalFailedCount} failed)`
    );

    return results.filter((r): r is T => r !== undefined);
}
