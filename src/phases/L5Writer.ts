import * as vscode from 'vscode';
import * as path from 'path';
import { PageGroup, ComponentDef } from '../types';
import { PhaseContext, runPhase, getPipelineOverview } from './PhaseRunner';
import { logger } from '../utils/logger';
import { runWithConcurrencyLimit, DEFAULT_MAX_CONCURRENCY } from '../utils/concurrency';

/** Maximum retries for L5-Pre consolidation loop */
const MAX_L5PRE_RETRIES = 6;

/** Number of pages per L5 writer task */
const PAGE_CHUNK_SIZE = 1;

/**
 * L5-Pre: Page Structure Consolidator (3-stage: Draft → Review → Refine)
 * Groups components into logical pages for documentation.
 * 
 * @returns Array of PageGroup representing page structure
 */
export async function runL5Pre(
    ctx: PhaseContext,
    componentList: ComponentDef[],
    componentsForThisLoop: string[],
    loopCount: number,
    parseJson: <T>(content: string) => T
): Promise<{ pageStructure: PageGroup[]; finalPageCount: number }> {
    const mdCodeBlock = '```';
    const pageStructureExample = `
[
  {
    "pageName": "Authentication",
    "components": ["Auth Module", "Session Manager", "Login Handler"],
    "rationale": "All handle user authentication flow"
  },
  {
    "pageName": "Utilities",
    "components": ["String Utils"],
    "rationale": "Standalone utility module"
  }
]
`;

    let pageStructure: PageGroup[] = [];
    let l5PreRetryCount = 0;
    let isL5PreSuccess = false;

    // L5-Pre-A: Page Structure Drafter
    await runPhase(
        `L5-Pre-A: Drafter (Loop ${loopCount + 1})`,
        'Draft initial page structure',
        `# Page Structure Drafter Agent (L5-Pre-A)

## Role
- **Your Stage**: L5-Pre-A Drafter (Page Consolidation Phase - First Pass)
- **Core Responsibility**: Create initial page grouping proposal based on L3 analysis
- **Critical Success Factor**: Group related components logically - perfection not required, L5-Pre-B will review

## Goal
Create an INITIAL draft of page structure by analyzing L3 outputs.

## Input
- Read ALL files in \`${ctx.intermediateDir}/L3/\`
- Component list: ${JSON.stringify(componentsForThisLoop)}

## Workflow
1. **Read all L3 analysis files** to understand each component's responsibility and scope.
2. **Identify consolidation opportunities**:
   - Components with overlapping responsibilities (e.g., "Auth", "Session", "Login" all relate to authentication)
   - Components that are too granular to warrant separate pages
   - Components that users would naturally look for together
3. **Draft page structure**:
   - Group related components into single pages where it improves readability
   - Keep components separate if they have distinct, substantial responsibilities
   - Aim for balanced page sizes (not too large, not too small)

## Output
Write draft to \`${ctx.intermediateDir}/L5/page_structure_draft.json\`.

**Format**:
${mdCodeBlock}json
${pageStructureExample}
${mdCodeBlock}

**Rules**:
- Every component from the input list MUST appear in exactly one page group
- \`pageName\` should be descriptive and user-friendly
- \`rationale\` explains why these components belong together

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.

` + getPipelineOverview('L5-Pre'),
        ctx
    );

    // L5-Pre Review/Refine Loop
    while (l5PreRetryCount < MAX_L5PRE_RETRIES) {
        logger.log('DeepWiki', `L5-Pre Review/Refine Loop: ${l5PreRetryCount + 1}/${MAX_L5PRE_RETRIES}`);

        const retryContextL5Pre = l5PreRetryCount > 0
            ? `\n\n**CONTEXT**: Previous attempt failed to produce valid JSON. Please review more carefully and ensure valid format.`
            : '';

        // L5-Pre-B: Page Structure Reviewer
        await runPhase(
            `L5-Pre-B: Reviewer (Loop ${loopCount + 1}, Attempt ${l5PreRetryCount + 1})`,
            'Review page structure draft',
            `# Page Structure Reviewer Agent (L5-Pre-B)

## Role
- **Your Stage**: L5-Pre-B Reviewer (Page Consolidation Phase - Quality Gate)
- **Core Responsibility**: Critique L5-Pre-A's draft - identify issues but do NOT fix them
- **Critical Success Factor**: Ensure page groupings make sense from a documentation user's perspective

## Goal
CRITIQUE the draft page structure. Do NOT fix it yourself.

## Input
- Read \`${ctx.intermediateDir}/L5/page_structure_draft.json\`
- Read L3 analysis files in \`${ctx.intermediateDir}/L3/\` for reference

## Workflow
1. **Check grouping logic**:
   - Are related components grouped together?
   - Are there groups that should be split (too large/unfocused)?
   - Are there groups that should be merged (too small/redundant)?
2. **Verify completeness**:
   - Are all components from ${JSON.stringify(componentsForThisLoop)} included?
   - Is any component listed in multiple groups?
3. **Assess user experience**:
   - Would a developer easily find what they're looking for?
   - Are page names intuitive and descriptive?
4. **Check rationales**:
   - Do the rationales actually justify the groupings?

## Output
Write critique report to \`${ctx.intermediateDir}/L5/page_structure_review.md\`.

Include:
- Issues found (if any)
- Suggested improvements
- Overall assessment (Good/Needs Work)${retryContextL5Pre}

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.

` + getPipelineOverview('L5-Pre'),
            ctx
        );

        // L5-Pre-C: Page Structure Refiner
        await runPhase(
            `L5-Pre-C: Refiner (Loop ${loopCount + 1}, Attempt ${l5PreRetryCount + 1})`,
            'Finalize page structure',
            `# Page Structure Refiner Agent (L5-Pre-C)

## Role
- **Your Stage**: L5-Pre-C Refiner (Page Consolidation Phase - Final Output)
- **Core Responsibility**: Merge draft with review feedback into final page structure
- **Critical Success Factor**: Produce valid JSON that L5 Writer can use

## Goal
Create the FINAL page structure by applying review feedback.

## Input
- Draft: \`${ctx.intermediateDir}/L5/page_structure_draft.json\`
- Review: \`${ctx.intermediateDir}/L5/page_structure_review.md\`

## Workflow
1. Read the Draft and the Review Report.
2. Apply the suggested improvements to the page structure.
3. Produce the final valid JSON.${retryContextL5Pre}

## Output
Write FINAL JSON to \`${ctx.intermediateDir}/L5/page_structure.json\`.

**Format**:
${mdCodeBlock}json
${pageStructureExample}
${mdCodeBlock}

**Rules**:
- Every component MUST appear in exactly one page group
- \`pageName\` should be descriptive and user-friendly
- \`rationale\` explains why these components belong together (or why a component stands alone)
- Output must be valid JSON array

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.

` + getPipelineOverview('L5-Pre'),
            ctx
        );

        // Check JSON validity
        const pageStructureUri = vscode.Uri.file(path.join(ctx.workspaceFolder.uri.fsPath, ctx.intermediateDir, 'L5', 'page_structure.json'));
        try {
            const pageStructureContent = await vscode.workspace.fs.readFile(pageStructureUri);
            pageStructure = parseJson<PageGroup[]>(new TextDecoder().decode(pageStructureContent));

            if (!Array.isArray(pageStructure) || pageStructure.length === 0) {
                throw new Error('Parsed JSON is not a valid array or is empty.');
            }

            logger.log('DeepWiki', `L5-Pre Success: ${componentList.length} components -> ${pageStructure.length} pages`);
            isL5PreSuccess = true;
            break;
        } catch (e) {
            logger.error('DeepWiki', `L5-Pre Attempt ${l5PreRetryCount + 1} Failed: ${e}`);
            l5PreRetryCount++;
        }
    }

    // Fallback if L5-Pre failed after all retries
    if (!isL5PreSuccess) {
        logger.warn('DeepWiki', `L5-Pre failed after ${MAX_L5PRE_RETRIES} retries, falling back to 1:1 mapping`);
        pageStructure = componentsForThisLoop.map(name => ({
            pageName: name,
            components: [name],
            rationale: 'Fallback: individual page'
        }));
    }

    return { pageStructure, finalPageCount: pageStructure.length };
}

/**
 * L5: Documentation Writer Phase
 * Transforms L3 analysis into final documentation pages.
 */
export async function runL5Writer(
    ctx: PhaseContext,
    pageStructure: PageGroup[],
    loopCount: number,
    parseJson: <T>(content: string) => T
): Promise<void> {
    const mdCodeBlock = '```';
    const pageTemplate = `
---
title: {PageName}
type: component
importance: {High/Medium/Low}
---

> **Note**: This documentation was auto-generated by an LLM. While we strive for accuracy, please refer to the source code for authoritative information.

# {PageName}

## Summary
{Description of what this page covers}

## Use Cases
{Description of how and when to use these components}

## Internal Mechanics Overview
${mdCodeBlock}mermaid
%% Overview diagram (File/Class/State) of the internal structure
${mdCodeBlock}
**File Structure:**
${mdCodeBlock}text
{ASCII Tree of files in this page's components with brief descriptions}
${mdCodeBlock}

## Internal Mechanics Details
{Describe the internal logic, state management, and data flow. Explain HOW it works, not just WHAT it does.}

${mdCodeBlock}mermaid
%% Sequence diagram or State diagram detailing the internal logic
${mdCodeBlock}

## External Interface
{Describe how other modules interact with these components. List public methods, props, and events.}
`;

    // Task generator function for L5 writing
    const createL5Task = (pageChunk: PageGroup[]) => {
        return () => runPhase(
            `L5: Writer (Loop ${loopCount + 1})`,
            `Write ${pageChunk.length} documentation pages`,
            `# Writer Agent (L5)

## Role
- **Your Stage**: L5 Writer (Analysis Loop - Documentation Generation, runs in parallel)
- **Core Responsibility**: Transform L3 analysis into readable, well-structured documentation pages
- **Critical Success Factor**: L6 will review your output - focus on clarity and causal explanations

## Input
- Assigned Pages: ${JSON.stringify(pageChunk)}
- For each page, find and read L3 analysis files for the components listed in \`${ctx.intermediateDir}/L3/\` (files are named with component names)

## Workflow
1. For EACH assigned page: Create \`${ctx.outputPath}/pages/{pageName}.md\` with the page title and Overview section
2. Read L3 analysis for ALL components in that page's \`components\` array
3. Iterate through sections (Architecture, Mechanics, Interface): Synthesize content → Use \`applyPatch\` to write immediately
4. Generate an ASCII tree of ALL files from ALL components in this page → Use \`applyPatch\` to write

**Consolidation Guidelines**:
- If a page has multiple components, weave their descriptions together
- Identify shared concepts and present them once, not repeatedly
- Show how the components within the page interact with each other
- The page should read as a unified document, not separate sections glued together

**Causal Explanation**:
When describing Internal Mechanics, explain the CAUSAL FLOW (e.g., "Because X happens, Y triggers Z").

### Template
` + pageTemplate + `

## Output
Write files to \`${ctx.outputPath}/pages/\`.

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.
3. **Incremental Writing**: Use \`applyPatch\` after each instruction step. Due to token limits, writing all at once risks data loss.
4. **Do NOT include raw source code or implementation details.**
5. **Strictly separate External Interface from Internal Mechanics.** Use tables for API references.
6. **No Intermediate Links**: Do NOT include links to intermediate analysis files (e.g., intermediate/L3/, ../L3/, ../L4/). Only reference other pages via their final page files in \`pages/\` directory: [Page Name](PageName.md)

` + getPipelineOverview('L5'),
            ctx
        );
    };

    // Create page chunks for L5 writing
    const pageChunks: PageGroup[][] = [];
    for (let i = 0; i < pageStructure.length; i += PAGE_CHUNK_SIZE) {
        pageChunks.push(pageStructure.slice(i, i + PAGE_CHUNK_SIZE));
    }

    // Initial L5 writing
    const l5Tasks = pageChunks.map(createL5Task);
    await runWithConcurrencyLimit(l5Tasks, DEFAULT_MAX_CONCURRENCY, `L5 Writing (Loop ${loopCount + 1})`, ctx.token);

    // L5 Validator
    const l5ExpectedPages = pageStructure.map(p => ({
        pageName: p.pageName,
        file: `${p.pageName}.md`
    }));
    await runPhase(
        `L5-V: Validator (Loop ${loopCount + 1})`,
        'Validate L5 output files',
        `# L5 Validator Agent

## Role
Check that all expected L5 documentation page files exist.

## Expected Files
Directory: \`${ctx.outputPath}/pages/\`
Files to verify:
${l5ExpectedPages.map(p => `- \`${p.file}\` (Page: ${p.pageName})`).join('\n')}

## Workflow
1. List files in \`${ctx.outputPath}/pages/\`
2. Compare against expected files above
3. If ALL files exist → Write empty array to \`${ctx.intermediateDir}/L5/page_validation_failures.json\`
4. If ANY files are MISSING → Write JSON array of missing page names to \`${ctx.intermediateDir}/L5/page_validation_failures.json\`

## Output
Write to \`${ctx.intermediateDir}/L5/page_validation_failures.json\`:
- If all present: \`[]\`
- If missing: \`["Page A", "Page B"]\`

## Constraints
1. Keep response brief (e.g., "Validation complete.")
`,
        ctx
    );

    // Check L5 validation result and retry failed pages
    const l5FailuresUri = vscode.Uri.file(path.join(ctx.workspaceFolder.uri.fsPath, ctx.intermediateDir, 'L5', 'page_validation_failures.json'));
    let l5FailedPages: string[] = [];
    try {
        const content = await vscode.workspace.fs.readFile(l5FailuresUri);
        l5FailedPages = parseJson<string[]>(new TextDecoder().decode(content));
        await vscode.workspace.fs.delete(l5FailuresUri);
    } catch { /* no failures file or invalid */ }

    if (l5FailedPages.length > 0) {
        logger.log('DeepWiki', `L5 Validator found ${l5FailedPages.length} missing pages, retrying: ${l5FailedPages.join(', ')}`);
        const failedPageStructure = pageStructure.filter(p => l5FailedPages.includes(p.pageName));
        const retryPageChunks: PageGroup[][] = [];
        for (let i = 0; i < failedPageStructure.length; i += PAGE_CHUNK_SIZE) {
            retryPageChunks.push(failedPageStructure.slice(i, i + PAGE_CHUNK_SIZE));
        }
        const l5RetryTasks = retryPageChunks.map(createL5Task);
        await runWithConcurrencyLimit(l5RetryTasks, DEFAULT_MAX_CONCURRENCY, `L5 Retry (Loop ${loopCount + 1})`, ctx.token);
    }
}
