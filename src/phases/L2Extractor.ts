import * as vscode from 'vscode';
import * as path from 'path';
import { ComponentDef } from '../types';
import { PhaseContext, runPhase, getPipelineOverview } from './PhaseRunner';
import { logger } from '../utils/logger';
import { runWithConcurrencyLimit, DEFAULT_MAX_CONCURRENCY } from '../utils/concurrency';

/**
 * L2: Extractor Phase
 * Extracts API signatures, internal logic, side effects, and dependency relationships.
 */
export async function runL2(
    ctx: PhaseContext,
    componentList: ComponentDef[],
    parseJson: <T>(content: string) => T
): Promise<void> {
    // Task generator function for L2 extraction (shared by initial and retry)
    const createL2Task = (component: ComponentDef) => {
        const componentStr = JSON.stringify(component);
        const paddedIndex = String(componentList.findIndex(c => c.name === component.name) + 1).padStart(3, '0');
        return () => runPhase(
            `L2: Extractor (${component.name})`,
            `Extract entities`,
            `# Extractor Agent (L2)

## Role
- **Your Stage**: L2 Extraction (runs in parallel batches)
- **Core Responsibility**: Extract precise API signatures from source code - no interpretation
- **Critical Success Factor**: Copy signatures EXACTLY as written - your accuracy directly impacts L3's analysis quality

## Input
- Assigned Component: ${componentStr}
- **Project Context**: Read \`${ctx.intermediateDir}/L0/project_context.md\` for conditional code patterns

## Workflow
1. Create empty file \`${ctx.intermediateDir}/L2/${paddedIndex}_${component.name}.md\`
2. For each function/method/class: Analyze one → Use \`applyPatch\` to write → Repeat

**What to extract**:
- **Signature**: Full signature with EXACT parameter names and types (copy as-is from source)
- **Brief description**: One-line summary of purpose
- **Internal Logic**: Key internal logic steps (3-5 bullet points)
- **Side Effects**: Side effects (file I/O, state mutations, API calls, events, etc.)
- **Called By**: Functions/methods that call this (Direct callers only, Depth=1)
- **Calls**: Functions/methods/libraries this calls (Direct calls only, Depth=1)
- **Conditional**: If within a conditional block (e.g., \`#ifdef\`), note the condition

**CRITICAL**: Copy signatures EXACTLY as they appear in the code. Do NOT paraphrase.

## Output
Write to \`${ctx.intermediateDir}/L2/${paddedIndex}_${component.name}.md\`

Use this format:
\`\`\`markdown
### \`processData(input: DataType, options?: ProcessOptions): Result\`
Processes input data and returns transformed result

**Conditional**: Only when \`FEATURE_X\` is defined

**Internal Logic**:
- Validates input schema
- Applies transformation rules
- Handles edge cases for null values

**Side Effects**:
- Writes to database via \`saveToDb()\`
- Emits 'data.processed' event
- Updates in-memory cache

**Called By**:
- \`HttpHandler.handlePost()\`
- \`BatchProcessor.processQueue()\`

**Calls**:
- \`validateInput(input)\`
- \`transformData(input, options)\`
- \`saveToDb(result)\`
\`\`\`

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.
3. **Incremental Writing**: Use \`applyPatch\` after each instruction step. Due to token limits, writing all at once risks data loss.

` + getPipelineOverview('L2'),
            ctx
        );
    };

    // Initial L2 extraction
    const l2Tasks = componentList.map(createL2Task);
    await runWithConcurrencyLimit(l2Tasks, DEFAULT_MAX_CONCURRENCY, 'L2 Extraction', ctx.token);

    // L2 Validator
    const l2ExpectedFiles = componentList.map((c, i) => ({
        name: c.name,
        file: `${String(i + 1).padStart(3, '0')}_${c.name}.md`
    }));
    await runPhase(
        'L2-V: Validator',
        'Validate L2 output files',
        `# L2 Validator Agent

## Role
Check that all expected L2 output files exist.

## Expected Files
Directory: \`${ctx.intermediateDir}/L2/\`
Files to verify:
${l2ExpectedFiles.map(f => `- \`${f.file}\` (Component: ${f.name})`).join('\n')}

## Workflow
1. List files in \`${ctx.intermediateDir}/L2/\`
2. Compare against expected files above
3. If ALL files exist → Write empty array to \`${ctx.intermediateDir}/L2/validation_failures.json\`
4. If ANY files are MISSING → Write JSON array of missing component names to \`${ctx.intermediateDir}/L2/validation_failures.json\`

## Output
Write to \`${ctx.intermediateDir}/L2/validation_failures.json\`:
- If all present: \`[]\`
- If missing: \`["Component A", "Component B"]\`

## Constraints
1. Keep response brief (e.g., "Validation complete.")
`,
        ctx
    );

    // Check validation result and retry failed components
    const l2FailuresUri = vscode.Uri.file(path.join(ctx.workspaceFolder.uri.fsPath, ctx.intermediateDir, 'L2', 'validation_failures.json'));
    let l2FailedComponents: string[] = [];
    try {
        const content = await vscode.workspace.fs.readFile(l2FailuresUri);
        l2FailedComponents = parseJson<string[]>(new TextDecoder().decode(content));
        await vscode.workspace.fs.delete(l2FailuresUri);
    } catch { /* no failures file or invalid */ }

    if (l2FailedComponents.length > 0) {
        logger.log('DeepWiki', `L2 Validator found ${l2FailedComponents.length} missing files, retrying: ${l2FailedComponents.join(', ')}`);
        const failedL2Components = componentList.filter(c => l2FailedComponents.includes(c.name));
        const l2RetryTasks = failedL2Components.map(createL2Task);
        await runWithConcurrencyLimit(l2RetryTasks, DEFAULT_MAX_CONCURRENCY, 'L2 Retry', ctx.token);
    }
}
