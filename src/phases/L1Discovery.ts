import * as vscode from 'vscode';
import * as path from 'path';
import { ComponentDef } from '../types';
import { PhaseContext, runPhase, getPipelineOverview } from './PhaseRunner';
import { logger } from '../utils/logger';

/** Maximum retries for L1 Review/Refine loop */
const MAX_L1_RETRIES = 6;

/**
 * L1: Component Discovery Pipeline (L1-A → L1-B → L1-C)
 * Discovers and groups logical components in the codebase.
 * 
 * @returns Array of ComponentDef representing discovered components
 */
export async function runL1(
    ctx: PhaseContext,
    parseJson: <T>(content: string) => T
): Promise<ComponentDef[]> {
    const mdCodeBlock = '```';
    const jsonExample = `
[
  {
    "name": "Auth Module", 
    "files": ["src/auth/auth.controller.ts", "src/auth/auth.service.ts"], 
    "importance": "high",
    "description": "Handles user authentication"
  }
]
`;

    // L1-A: Component Drafter
    await runPhase(
        'L1-A: Drafter',
        'Draft initial component grouping',
        `# Component Drafter Agent (L1-A)

## Role
- **Your Stage**: L1-A Drafter (Discovery Phase - First Pass)
- **Core Responsibility**: Create initial component grouping from project files
- **Critical Success Factor**: Group related files logically - perfection not required, L1-B will review

## Input
- **Project Context**: Read \`${ctx.intermediateDir}/L0/project_context.md\` for project structure and build system info

## Goal
Create an INITIAL draft of logical components.

## Workflow
1. Read the L0 project context to understand the project structure.
2. Scan the project source files (refer to L0 context for relevant directories).
3. Group related files into Components based on directory structure.
4. Assign tentative importance (High/Medium/Low).
5. Consider the L0 context when grouping (e.g., exclude generated/vendor code).

## Output
Write the draft JSON to \`${ctx.intermediateDir}/L1/component_draft.json\`.

**Format**:
${mdCodeBlock}json
${jsonExample}
${mdCodeBlock}

> **IMPORTANT**: Write RAW JSON only.

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.

` + getPipelineOverview('L1-A'),
        ctx
    );

    // Review/Refine Loop
    let componentList: ComponentDef[] = [];
    let l1RetryCount = 0;
    let isL1Success = false;

    while (l1RetryCount < MAX_L1_RETRIES) {
        logger.log('DeepWiki', `L1 Review/Refine Loop: ${l1RetryCount + 1}/${MAX_L1_RETRIES}`);

        const retryContextL1 = l1RetryCount > 0
            ? `\n\n**CONTEXT**: Previous attempt failed to produce valid JSON. Please review more carefully and ensure valid format.`
            : '';

        // L1-B: Component Reviewer (Critique Only)
        await runPhase(
            `L1-B: Reviewer (Attempt ${l1RetryCount + 1})`,
            'Critique component grouping',
            `# Component Reviewer Agent (L1-B)

## Role
- **Your Stage**: L1-B Reviewer (Discovery Phase - Quality Gate)
- **Core Responsibility**: Critique L1-A's draft - identify issues but do NOT fix them
- **Critical Success Factor**: Verify files actually exist and are grouped logically

## Goal
CRITIQUE the draft. Do NOT fix it yourself.

## Input
- Read \`${ctx.intermediateDir}/L1/component_draft.json\`
- **Reference**: Use file listing tools to verify the ACTUAL project structure.

## Workflow
1. Critique the draft for granularity and accuracy.
2. **Verification**: Verify that the grouped files actually exist and make sense together.
3. Check for missing core files or included noise.${retryContextL1}

## Output
Write a critique report to \`${ctx.intermediateDir}/L1/review_report.md\`.

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.

` + getPipelineOverview('L1-B'),
            ctx
        );

        // L1-C: Component Refiner (Fix & Finalize)
        await runPhase(
            `L1-C: Refiner (Attempt ${l1RetryCount + 1})`,
            'Refine component list based on review',
            `# Component Refiner Agent (L1-C)

## Role
- **Your Stage**: L1-C Refiner (Discovery Phase - Final Output)
- **Core Responsibility**: Merge L1-A draft with L1-B feedback into validated JSON
- **Critical Success Factor**: Produce valid JSON that L2 can use - your output feeds the entire pipeline

## Goal
Create the FINAL component list.

## Input
- Draft: \`${ctx.intermediateDir}/L1/component_draft.json\`
- Review: \`${ctx.intermediateDir}/L1/review_report.md\`

## Workflow
1. Read the Draft and the Review Report.
2. Apply the suggested fixes to the component list.
3. Produce the valid JSON.${retryContextL1}

## Output
- Write the FINAL JSON to \`${ctx.intermediateDir}/L1/component_list.json\`.
- Format must be valid JSON array.

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.

` + getPipelineOverview('L1-C'),
            ctx
        );

        // Check JSON validity
        const fileListUri = vscode.Uri.file(path.join(ctx.workspaceFolder.uri.fsPath, ctx.intermediateDir, 'L1', 'component_list.json'));
        try {
            const fileListContent = await vscode.workspace.fs.readFile(fileListUri);
            const contentStr = new TextDecoder().decode(fileListContent);
            componentList = parseJson<ComponentDef[]>(contentStr);

            if (!Array.isArray(componentList) || componentList.length === 0) {
                throw new Error('Parsed JSON is not a valid array or is empty.');
            }

            logger.log('DeepWiki', `L1 Success: Identified ${componentList.length} logical components.`);
            isL1Success = true;
            break;
        } catch (e) {
            logger.error('DeepWiki', `L1 Attempt ${l1RetryCount + 1} Failed: ${e}`);
            l1RetryCount++;
        }
    }

    if (!isL1Success) {
        throw new Error('L1 Discovery failed to produce valid components after retries. Pipeline stopped.');
    }

    return componentList;
}
