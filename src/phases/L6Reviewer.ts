import * as vscode from 'vscode';
import * as path from 'path';
import { ComponentDef } from '../types';
import { PhaseContext, runPhase, getPipelineOverview } from './PhaseRunner';
import { logger } from '../utils/logger';

/** Maximum loops for the analysis/writing pipeline */
export const MAX_LOOPS = 5;

/**
 * L6: Page Reviewer Phase
 * Quality gate that verifies accuracy, fixes minor issues, and requests retry for major problems.
 * 
 * @returns Array of component names that need retry, or empty array if no retries needed
 */
export async function runL6(
    ctx: PhaseContext,
    componentList: ComponentDef[],
    loopCount: number,
    parseJson: <T>(content: string) => T
): Promise<string[]> {
    const isLastLoop = loopCount === MAX_LOOPS - 1;
    const retryInstruction = isLastLoop
        ? `This is the FINAL attempt. Do NOT request retries. Fix minor issues directly within the pages. If a page is fundamentally broken, add a prominent warning note to the page itself, explaining the issue.`
        : `If a page has MAJOR missing information or wrong analysis, list the Component Name(s) that need re-analysis (L3/L4/L5) in "${ctx.intermediateDir}/L6/retry_request.json".
           Format: ["Auth Module", "Utils"].
           For minor issues (typos, formatting, broken links), fix the page directly.`;

    await runPhase(
        `L6: Page Reviewer (Loop ${loopCount + 1})`,
        'Review pages and decide on retries',
        `# Page Reviewer Agent (L6)

## Role
- **Your Stage**: L6 Reviewer (Analysis Loop - Quality Gate)
- **Core Responsibility**: Final quality gate - verify accuracy against source code, fix minor issues, request retry for major problems
- **Critical Success Factor**: You are the last line of defense before final output - be thorough

## Goal
Check pages in \`${ctx.outputPath}/pages/\` for quality based on ALL L3 analysis files.

## Input
- Read generated pages in \`${ctx.outputPath}/pages/\`
- Read all L3 analysis files in \`${ctx.intermediateDir}/L3/\`

## Workflow
1. **Accuracy**: Verify content against ACTUAL SOURCE CODE → If errors found, use \`applyPatch\` to fix immediately
2. **Completeness**: Ensure no sections (Overview, Architecture, API) are empty or placeholders → Use \`applyPatch\` to fill if needed
3. **Connectivity**: Verify that all links work and point to existing files → Use \`applyPatch\` to fix broken links
4. **Formatting**: Fix broken Markdown tables or Mermaid syntax errors → Use \`applyPatch\` to write fixes
5. **Numerical Consistency**: Check for inconsistent numerical values (e.g., "8h" vs "8 hours") → Use \`applyPatch\` to unify
6. **Signature Accuracy**: Verify method/function signatures match actual source code
   - If a signature is incorrect, read the actual source file and use \`applyPatch\` to fix
7. **CRITICAL - Remove Intermediate Links**: REMOVE any references to intermediate directory files (intermediate/, ../L3/, ../L4/, etc.) → Use \`applyPatch\` to fix
8. ${retryInstruction}

## Output
- Overwrite pages in \`${ctx.outputPath}/pages/\` if fixing.
- Write \`${ctx.intermediateDir}/L6/retry_request.json\` ONLY if requesting retries.

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.
3. **Incremental Writing**: Use \`applyPatch\` after each instruction step. Due to token limits, writing all at once risks data loss.

` + getPipelineOverview('L6'),
        ctx
    );

    // Check for retry requests
    const retryFileUri = vscode.Uri.file(path.join(ctx.workspaceFolder.uri.fsPath, ctx.intermediateDir, 'L6', 'retry_request.json'));
    let retryNames: string[] = [];
    try {
        const retryContent = await vscode.workspace.fs.readFile(retryFileUri);
        retryNames = parseJson<string[]>(new TextDecoder().decode(retryContent));
        await vscode.workspace.fs.delete(retryFileUri);
    } catch {
        logger.log('DeepWiki', 'No retry request found or file invalid.');
    }

    if (retryNames && Array.isArray(retryNames) && retryNames.length > 0) {
        logger.log('DeepWiki', `Reviewer requested retry for: ${retryNames.join(', ')}`);
        // Validate that retry names are valid component names
        const validRetryNames = retryNames.filter(name =>
            componentList.some(c => c.name === name)
        );
        if (validRetryNames.length === 0) {
            logger.warn('DeepWiki', 'Retry requested for unknown components. Stopping loop.');
            return [];
        }
        return validRetryNames;
    }

    logger.log('DeepWiki', 'No retries requested. Pipeline finished.');
    return [];
}
