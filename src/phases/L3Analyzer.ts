import * as vscode from 'vscode';
import * as path from 'path';
import { ComponentDef } from '../types';
import { PhaseContext, runPhase, getPipelineOverview } from './PhaseRunner';
import { logger } from '../utils/logger';
import { runWithConcurrencyLimit, DEFAULT_MAX_CONCURRENCY } from '../utils/concurrency';

/**
 * L3: Analyzer Phase
 * Deep component analysis with causality tracing and diagrams.
 */
export async function runL3(
    ctx: PhaseContext,
    componentList: ComponentDef[],
    componentsToAnalyze: ComponentDef[],
    loopCount: number,
    parseJson: <T>(content: string) => T
): Promise<void> {
    // Task generator function for L3 analysis (shared by initial and retry)
    const createL3Task = (component: ComponentDef) => {
        const componentStr = JSON.stringify(component);
        const originalIndex = componentList.findIndex(c => c.name === component.name);
        const paddedIndex = String(originalIndex + 1).padStart(3, '0');
        return () => runPhase(
            `L3: Analyzer (Loop ${loopCount + 1}, ${component.name})`,
            `Analyze component`,
            `# Analyzer Agent (L3)

## Role
- **Your Stage**: L3 Analyzer (Analysis Loop - may retry up to 5 times)
- **Core Responsibility**: Deep analysis - understand HOW code works, trace causality, create diagrams
- **Critical Success Factor**: L4 and L5 depend on your analysis - be thorough and accurate

## Input
Assigned Component: ${componentStr}

## Workflow
1. Create empty file \`${ctx.intermediateDir}/L3/${paddedIndex}_${component.name}_analysis.md\`
2. Read L2 extraction and source code files
3. For each analysis section (Overview, Architecture, Key Logic, etc.): Analyze → Use \`applyPatch\` to write
4. Create Mermaid diagram → Use \`applyPatch\` to write
   - **Recommended**: \`C4Context\`, \`stateDiagram-v2\`, \`sequenceDiagram\`, \`classDiagram\`, \`block\`
   - **Forbidden**: \`flowchart\`, \`graph TD\`

## Output
Write to \`${ctx.intermediateDir}/L3/${paddedIndex}_${component.name}_analysis.md\`

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.
3. **Incremental Writing**: Use \`applyPatch\` after each instruction step. Due to token limits, writing all at once risks data loss.

` + getPipelineOverview('L3'),
            ctx
        );
    };

    // Initial L3 analysis
    const l3Tasks = componentsToAnalyze.map(createL3Task);
    await runWithConcurrencyLimit(l3Tasks, DEFAULT_MAX_CONCURRENCY, `L3 Analysis (Loop ${loopCount + 1})`, ctx.token);

    // L3 Validator
    const l3ExpectedFiles = componentsToAnalyze.map((c) => {
        const originalIndex = componentList.findIndex(comp => comp.name === c.name);
        return {
            name: c.name,
            file: `${String(originalIndex + 1).padStart(3, '0')}_${c.name}_analysis.md`
        };
    });
    await runPhase(
        `L3-V: Validator (Loop ${loopCount + 1})`,
        'Validate L3 output files',
        `# L3 Validator Agent

## Role
Check that all expected L3 analysis files exist.

## Expected Files
Directory: \`${ctx.intermediateDir}/L3/\`
Files to verify:
${l3ExpectedFiles.map(f => `- \`${f.file}\` (Component: ${f.name})`).join('\n')}

## Workflow
1. List files in \`${ctx.intermediateDir}/L3/\`
2. Compare against expected files above
3. If ALL files exist → Write empty array to \`${ctx.intermediateDir}/L3/validation_failures.json\`
4. If ANY files are MISSING → Write JSON array of missing component names to \`${ctx.intermediateDir}/L3/validation_failures.json\`

## Output
Write to \`${ctx.intermediateDir}/L3/validation_failures.json\`:
- If all present: \`[]\`
- If missing: \`["Component A", "Component B"]\`

## Constraints
1. Keep response brief (e.g., "Validation complete.")
`,
        ctx
    );

    // Check L3 validation result and retry failed components
    const l3FailuresUri = vscode.Uri.file(path.join(ctx.workspaceFolder.uri.fsPath, ctx.intermediateDir, 'L3', 'validation_failures.json'));
    let l3FailedComponents: string[] = [];
    try {
        const content = await vscode.workspace.fs.readFile(l3FailuresUri);
        l3FailedComponents = parseJson<string[]>(new TextDecoder().decode(content));
        await vscode.workspace.fs.delete(l3FailuresUri);
    } catch { /* no failures file or invalid */ }

    if (l3FailedComponents.length > 0) {
        logger.log('DeepWiki', `L3 Validator found ${l3FailedComponents.length} missing files, retrying: ${l3FailedComponents.join(', ')}`);
        const failedL3Components = componentsToAnalyze.filter(c => l3FailedComponents.includes(c.name));
        const l3RetryTasks = failedL3Components.map(createL3Task);
        await runWithConcurrencyLimit(l3RetryTasks, DEFAULT_MAX_CONCURRENCY, `L3 Retry (Loop ${loopCount + 1})`, ctx.token);
    }
}
