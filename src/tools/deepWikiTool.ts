import * as vscode from 'vscode';
import * as path from 'path';
import { IDeepWikiParameters } from '../types';
import { logger } from '../utils/logger';
import { runWithConcurrencyLimit, DEFAULT_MAX_CONCURRENCY } from '../utils/concurrency';

/**
 * DeepWiki Language Model Tool (5-Stage Parallel Agentic Pipeline - Component Based)
 * 
 * Orchestrates a pipeline that documents code by "Logical Components".
 * Includes a "Critical Failure Loop" where the L6 Reviewer can request re-analysis (L3/L5)
 * for components with fundamental issues.
 */
export class DeepWikiTool implements vscode.LanguageModelTool<IDeepWikiParameters> {
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IDeepWikiParameters>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const outputPath = options.input.outputPath || '.deepwiki';
        return {
            invocationMessage: 'Initializing DeepWiki Component Pipeline...',
            confirmationMessages: {
                title: 'Generate DeepWiki',
                message: new vscode.MarkdownString(
                    'Start the DeepWiki generation pipeline?\n\n' +
                    'This will analyze your workspace by **Components** and generate documentation in `' + outputPath + '`.'
                ),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<IDeepWikiParameters>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const params = options.input;
        const outputPath = params.outputPath || '.deepwiki';
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

        if (!workspaceFolder) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Error: No workspace folder open.')
            ]);
        }



        const intermediateDir = `${outputPath}/intermediate`;
        logger.log('DeepWiki', 'Starting Component-Based Pipeline...');

        // Helper to check for cancellation and throw if requested
        const checkCancellation = () => {
            if (token.isCancellationRequested) {
                logger.warn('DeepWiki', 'Pipeline cancelled by user');
                throw new vscode.CancellationError();
            }
        };

        // Check for cancellation before starting
        checkCancellation();

        // Clean up previous output
        await this.cleanOutputDirectory(workspaceFolder, outputPath);



        const bq = '`';
        const mdCodeBlock = bq + bq + bq;

        // Define ComponentDef interface globally within invoke scope
        interface ComponentDef { name: string; files: string[]; importance: string; description: string }

        try {
            // ==================================================================================
            // PHASE 0: PROJECT CONTEXT ANALYSIS (Environment Understanding)
            // This phase runs once to understand the project structure and build environment.
            // ==================================================================================

            // ---------------------------------------------------------
            // Level 0: PROJECT CONTEXT ANALYZER
            // ---------------------------------------------------------
            checkCancellation();
            logger.log('DeepWiki', 'Starting L0: Project Context Analysis...');
            await this.runPhase(
                'L0: Project Context Analyzer',
                'Analyze project environment and context',
                `# Project Context Analyzer Agent (L0)

## Role
- **Your Stage**: L0 Analyzer (Pre-Discovery Phase)
- **Core Responsibility**: Understand project structure, build system, and conditional code patterns
- **Critical Success Factor**: Provide context that helps subsequent agents understand which code is active/conditional



## Goal
Analyze the project and create a context document for downstream agents.

## Instructions
1. Detect Project Type, Languages, Build System → Use \`apply_patch\` to write "## Overview" section
2. Identify Target Environments → Use \`apply_patch\` to write "## Target Environments" table
3. Find Conditional Patterns → Use \`apply_patch\` to write "## Conditional Code Patterns" section
   - C/C++: \`#ifdef\`, \`#if defined\`, \`#ifndef\`
   - Python: \`if TYPE_CHECKING\`, platform checks, \`sys.platform\`
   - JS/TS: \`process.env\` checks, feature flags
4. Note Generated/Excluded Code → Use \`apply_patch\` to write "## Generated/Excluded Code" section
5. Add important notes for downstream agents → Use \`apply_patch\` to write "## Notes for Analysis" section

## Output
Write to \`${intermediateDir}/L0/project_context.md\`

Use this format:
${mdCodeBlock}markdown
# Project Context

## Overview
- **Project Type**: [e.g., Web Application, Embedded Firmware, CLI Tool, VS Code Extension]
- **Languages**: [e.g., TypeScript (80%), Python (20%)]
- **Build System**: [e.g., npm, Makefile, CMake] (entry point file if applicable)

## Target Environments
| Environment | Description |
|------------|-------------|
| [env name] | [description] |

## Conditional Code Patterns
[Describe patterns found in the codebase]
- Pattern: [e.g., #ifdef FEATURE_X]
- Examples: [list of flags/conditions found]
- Affected files: [files where this pattern appears]

## Generated/Excluded Code
- **Generated**: [paths to auto-generated code]
- **Vendor/External**: [paths to external dependencies]
- **Test Code**: [paths to test files]

## Notes for Analysis
[Any important context for downstream agents, e.g., "Feature flags are defined in config.h"]
${mdCodeBlock}

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.
3. **Incremental Writing**: Use \`apply_patch\` after each instruction step. Due to token limits, writing all at once risks data loss.`,
                token,
                options.toolInvocationToken
            );

            // ==================================================================================
            // PHASE 1: DISCOVERY & EXTRACTION (The Foundation)
            // These phases run once to establish the baseline.
            // ==================================================================================

            // ---------------------------------------------------------
            // Level 1-A: COMPONENT DRAFTER
            // ---------------------------------------------------------
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
            await this.runPhase(
                'L1-A: Drafter',
                'Draft initial component grouping',
                `# Component Drafter Agent (L1-A)

## Role
- **Your Stage**: L1-A Drafter (Discovery Phase - First Pass)
- **Core Responsibility**: Create initial component grouping from project files
- **Critical Success Factor**: Group related files logically - perfection not required, L1-B will review



## Input
- **Project Context**: Read \`${intermediateDir}/L0/project_context.md\` for project structure and build system info

## Goal
Create an INITIAL draft of logical components.

## Instructions
1. Read the L0 project context to understand the project structure.
2. Scan the project source files (refer to L0 context for relevant directories).
3. Group related files into Components based on directory structure.
4. Assign tentative importance (High/Medium/Low).
5. Consider the L0 context when grouping (e.g., exclude generated/vendor code).

## Output
Write the draft JSON to \`${intermediateDir}/L1/component_draft.json\`.

**Format**:
${mdCodeBlock}json
${jsonExample}
${mdCodeBlock}

> **IMPORTANT**: Write RAW JSON only.

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.`,
                token,
                options.toolInvocationToken
            );

            // Loop for Review & Refine
            let componentList: ComponentDef[] = [];
            let l1RetryCount = 0;
            const maxL1Retries = 6;
            let isL1Success = false;

            while (l1RetryCount < maxL1Retries) {
                logger.log('DeepWiki', `L1 Review/Refine Loop: ${l1RetryCount + 1}/${maxL1Retries}`);

                const retryContextL1 = l1RetryCount > 0
                    ? `\n\n**CONTEXT**: Previous attempt failed to produce valid JSON. Please review more carefully and ensure valid format.`
                    : '';

                // ---------------------------------------------------------
                // Level 1-B: COMPONENT REVIEWER (Critique Only)
                // ---------------------------------------------------------
                await this.runPhase(
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
- Read \`${intermediateDir}/L1/component_draft.json\`
- **Reference**: Use file listing tools to verify the ACTUAL project structure.

## Instructions
1. Critique the draft for granularity and accuracy.
2. **Verification**: Verify that the grouped files actually exist and make sense together.
3. Check for missing core files or included noise.${retryContextL1}

## Output
Write a critique report to \`${intermediateDir}/L1/review_report.md\`.

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.`,
                    token,
                    options.toolInvocationToken
                );

                // ---------------------------------------------------------
                // Level 1-C: COMPONENT REFINER (Fix & Finalize)
                // ---------------------------------------------------------
                await this.runPhase(
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
- Draft: \`${intermediateDir}/L1/component_draft.json\`
- Review: \`${intermediateDir}/L1/review_report.md\`

## Instructions
1. Read the Draft and the Review Report.
2. Apply the suggested fixes to the component list.
3. Produce the valid JSON.${retryContextL1}

## Output
- Write the FINAL JSON to \`${intermediateDir}/L1/component_list.json\`.
- Format must be valid JSON array.

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.`,
                    token,
                    options.toolInvocationToken
                );

                // ---------------------------------------------------------
                // Check JSON validity
                // ---------------------------------------------------------
                const fileListUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L1', 'component_list.json'));
                try {
                    const fileListContent = await vscode.workspace.fs.readFile(fileListUri);
                    const contentStr = new TextDecoder().decode(fileListContent);
                    componentList = this.parseJson<ComponentDef[]>(contentStr);

                    if (!Array.isArray(componentList) || componentList.length === 0) {
                        throw new Error('Parsed JSON is not a valid array or is empty.');
                    }

                    logger.log('DeepWiki', `L1 Success: Identified ${componentList.length} logical components.`);
                    isL1Success = true;
                    break; // Exit loop on success
                } catch (e) {
                    logger.error('DeepWiki', `L1 Attempt ${l1RetryCount + 1} Failed: ${e}`);
                    l1RetryCount++;
                }
            }

            if (!isL1Success) {
                throw new Error('L1 Discovery failed to produce valid components after retries. Pipeline stopped.');
            }

            // Level 2: EXTRACTOR (Parallel - Runs once for all components)
            // ---------------------------------------------------------
            // Create tasks for L2 extraction (1 component per file)
            const l2Tasks = componentList.map((component, index) => {
                const componentStr = JSON.stringify(component);
                // Create a safe filename from component name (remove special chars, limit length)
                // Keep number prefix for ordering
                const paddedIndex = String(index + 1).padStart(3, '0'); // 001, 002, etc.
                return () => this.runPhase(
                    `L2: Extractor (${component.name})`,
                    `Extract entities`,
                    `# Extractor Agent (L2)

## Role
- **Your Stage**: L2 Extraction (runs in parallel batches)
- **Core Responsibility**: Extract precise API signatures from source code - no interpretation
- **Critical Success Factor**: Copy signatures EXACTLY as written - your accuracy directly impacts L3's analysis quality



## Input
- Assigned Component: ${componentStr}
- **Project Context**: Read \`${intermediateDir}/L0/project_context.md\` for conditional code patterns

## Instructions
1. Create empty file \`${intermediateDir}/L2/${paddedIndex}_${component.name}.md\`
2. For each function/method/class: Analyze one → Use \`apply_patch\` to write → Repeat

**What to extract**:
- **Signature**: Full signature with EXACT parameter names and types (copy as-is from source)
- **Brief description**: One-line summary of purpose
- **Internal Logic**: Key internal logic steps (3-5 bullet points)
- **Side Effects**: Side effects (file I/O, state mutations, API calls, events, etc.)
- **Called By**: Functions/methods that call this (if identifiable)
- **Calls**: Functions/methods/libraries this calls
- **Conditional**: If within a conditional block (e.g., \`#ifdef\`), note the condition

**CRITICAL**: Copy signatures EXACTLY as they appear in the code. Do NOT paraphrase.

## Output
Write to \`${intermediateDir}/L2/${paddedIndex}_${component.name}.md\`

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
3. **Incremental Writing**: Use \`apply_patch\` after each instruction step. Due to token limits, writing all at once risks data loss.`,
                    token,
                    options.toolInvocationToken
                );
            });
            await runWithConcurrencyLimit(l2Tasks, DEFAULT_MAX_CONCURRENCY, 'L2 Extraction', token);


            // ==================================================================================
            // PHASE 2: ANALYSIS & WRITING LOOP (Critical Failure Loop)
            // L3 -> L4 -> L5 -> L6 -> (Retry L3/L4/L5 if L6 requests)
            // ==================================================================================

            let componentsToAnalyze = [...componentList]; // All components initially
            let loopCount = 0;
            const MAX_LOOPS = 5; // Initial run + 4 retries
            let finalPageCount = 0; // Track final page count for completion message

            while (componentsToAnalyze.length > 0 && loopCount < MAX_LOOPS) {
                logger.log('DeepWiki', `>>> Starting Analysis/Writing Loop ${loopCount + 1}/${MAX_LOOPS} with ${componentsToAnalyze.length} components...`);

                // Filter chunks to only include componentsToAnalyze
                // The chunking logic here is simplified. L3/L5 should be able to handle individual component analysis.
                // For a more robust solution, L3/L5 should accept an array of component names rather than a chunk.
                // For now, we'll re-chunk the componentsToAnalyze.

                const componentsForThisLoop = componentsToAnalyze.map(c => c.name);

                // ---------------------------------------------------------
                // Level 3: ANALYZER (Process current components - 1 component per task)
                // ---------------------------------------------------------
                // Create tasks for L3 analysis (1 component per task, like L2)
                const l3Tasks = componentsToAnalyze.map((component, index) => {
                    const componentStr = JSON.stringify(component);
                    // Keep number prefix for ordering
                    const paddedIndex = String(index + 1).padStart(3, '0');
                    return () => this.runPhase(
                        `L3: Analyzer (Loop ${loopCount + 1}, ${component.name})`,
                        `Analyze component`,
                        `# Analyzer Agent (L3)

## Role
- **Your Stage**: L3 Analyzer (Analysis Loop - may retry up to 5 times)
- **Core Responsibility**: Deep analysis - understand HOW code works, trace causality, create diagrams
- **Critical Success Factor**: L4 and L5 depend on your analysis - be thorough and accurate



## Input
Assigned Component: ${componentStr}

## Instructions
1. Create empty file \`${intermediateDir}/L3/${paddedIndex}_${component.name}_analysis.md\`
2. Read L2 extraction and source code files
3. For each analysis section (Overview, Architecture, Key Logic, etc.): Analyze → Use \`apply_patch\` to write
4. Create Mermaid diagram → Use \`apply_patch\` to write
   - **Recommended**: \`C4Context\`, \`stateDiagram-v2\`, \`sequenceDiagram\`, \`classDiagram\`, \`block\`
   - **Forbidden**: \`flowchart\`, \`graph TD\`

## Output
Write to \`${intermediateDir}/L3/${paddedIndex}_${component.name}_analysis.md\`

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.
3. **Incremental Writing**: Use \`apply_patch\` after each instruction step. Due to token limits, writing all at once risks data loss.`,
                        token,
                        options.toolInvocationToken
                    );
                });
                await runWithConcurrencyLimit(l3Tasks, DEFAULT_MAX_CONCURRENCY, `L3 Analysis (Loop ${loopCount + 1})`, token);

                // ---------------------------------------------------------
                // Level 4: ARCHITECT (Runs in every loop to keep overview up to date)
                // Input: All L3 analysis files (even from previous loops)
                // ---------------------------------------------------------
                const bq = '`'; // Define backtick for Mermaid in L4 prompt
                await this.runPhase(
                    `L4: Architect (Loop ${loopCount + 1})`,
                    'Update system overview and maps',
                    `# Architect Agent (L4)

## Role
- **Your Stage**: L4 Architect (Analysis Loop - System Overview)
- **Core Responsibility**: See the big picture - map component relationships and architectural decisions
- **Critical Success Factor**: Indexer uses your overview for the final README - explain the "why" behind the architecture



## Goal
Create a system-level overview based on ALL available L3 analysis.

## Input
Read ALL files in \`${intermediateDir}/L3/\` (including those from previous loops).

## Instructions
1. Read L3 analysis files → Understand component landscape
2. Define High-Level Architecture → Use \`apply_patch\` to write \`overview.md\`
3. Analyze Causal Impact (how changes propagate) → Use \`apply_patch\` to write
4. Explain the 'Why' behind architectural decisions → Use \`apply_patch\` to write
5. Create Mermaid diagrams → Use \`apply_patch\` to write \`relationships.md\`
   - **Recommended**: \`C4Context\`, \`stateDiagram-v2\`, \`sequenceDiagram\`, \`classDiagram\`, \`block\`
   - **Forbidden**: \`flowchart\`, \`graph TD\`

## Output
- Write to \`${intermediateDir}/L4/overview.md\`
- Write to \`${intermediateDir}/L4/relationships.md\`
- Include at least TWO diagrams

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.
3. **Incremental Writing**: Use \`apply_patch\` after each instruction step. Due to token limits, writing all at once risks data loss.`,
                    token,
                    options.toolInvocationToken
                );

                // ---------------------------------------------------------
                // Level 5 Pre: PAGE CONSOLIDATOR (3-stage: Draft → Review → Refine)
                // ---------------------------------------------------------
                const mdCodeBlock = bq + bq + bq;
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
                // L5-Pre retry loop variables
                interface PageGroup { pageName: string; components: string[]; rationale: string }
                let pageStructure: PageGroup[] = [];
                let l5PreRetryCount = 0;
                const maxL5PreRetries = 6;
                let isL5PreSuccess = false;

                // L5-Pre-A: Page Structure Drafter (runs once before retry loop)
                await this.runPhase(
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
- Read ALL files in \`${intermediateDir}/L3/\`
- Component list: ${JSON.stringify(componentsForThisLoop)}

## Instructions
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
Write draft to \`${intermediateDir}/L5/page_structure_draft.json\`.

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
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.`,
                    token,
                    options.toolInvocationToken
                );

                // L5-Pre Review/Refine Loop
                while (l5PreRetryCount < maxL5PreRetries) {
                    logger.log('DeepWiki', `L5-Pre Review/Refine Loop: ${l5PreRetryCount + 1}/${maxL5PreRetries}`);

                    const retryContextL5Pre = l5PreRetryCount > 0
                        ? `\n\n**CONTEXT**: Previous attempt failed to produce valid JSON. Please review more carefully and ensure valid format.`
                        : '';

                    // L5-Pre-B: Page Structure Reviewer
                    await this.runPhase(
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
- Read \`${intermediateDir}/L5/page_structure_draft.json\`
- Read L3 analysis files in \`${intermediateDir}/L3/\` for reference

## Instructions
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
Write critique report to \`${intermediateDir}/L5/page_structure_review.md\`.

Include:
- Issues found (if any)
- Suggested improvements
- Overall assessment (Good/Needs Work)${retryContextL5Pre}

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.`,
                        token,
                        options.toolInvocationToken
                    );

                    // L5-Pre-C: Page Structure Refiner
                    await this.runPhase(
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
- Draft: \`${intermediateDir}/L5/page_structure_draft.json\`
- Review: \`${intermediateDir}/L5/page_structure_review.md\`

## Instructions
1. Read the Draft and the Review Report.
2. Apply the suggested improvements to the page structure.
3. Produce the final valid JSON.${retryContextL5Pre}

## Output
Write FINAL JSON to \`${intermediateDir}/L5/page_structure.json\`.

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
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.`,
                        token,
                        options.toolInvocationToken
                    );

                    // ---------------------------------------------------------
                    // Check JSON validity for L5-Pre
                    // ---------------------------------------------------------
                    const pageStructureUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L5', 'page_structure.json'));
                    try {
                        const pageStructureContent = await vscode.workspace.fs.readFile(pageStructureUri);
                        pageStructure = this.parseJson<PageGroup[]>(new TextDecoder().decode(pageStructureContent));

                        if (!Array.isArray(pageStructure) || pageStructure.length === 0) {
                            throw new Error('Parsed JSON is not a valid array or is empty.');
                        }

                        finalPageCount = pageStructure.length;
                        logger.log('DeepWiki', `L5-Pre Success: ${componentList.length} components -> ${pageStructure.length} pages`);
                        isL5PreSuccess = true;
                        break; // Exit loop on success
                    } catch (e) {
                        logger.error('DeepWiki', `L5-Pre Attempt ${l5PreRetryCount + 1} Failed: ${e}`);
                        l5PreRetryCount++;
                    }
                }

                // Fallback if L5-Pre failed after all retries
                if (!isL5PreSuccess) {
                    logger.warn('DeepWiki', `L5-Pre failed after ${maxL5PreRetries} retries, falling back to 1:1 mapping`);
                    pageStructure = componentsForThisLoop.map(name => ({
                        pageName: name,
                        components: [name],
                        rationale: 'Fallback: individual page'
                    }));
                    finalPageCount = pageStructure.length;
                }

                // ---------------------------------------------------------
                // Level 5: WRITER (Process pages based on page_structure.json)
                // ---------------------------------------------------------
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
`; // The template ends here
                // Create tasks for L5 writing based on page_structure.json
                const pageChunkSize = 3;
                const pageChunks: PageGroup[][] = [];
                for (let i = 0; i < pageStructure.length; i += pageChunkSize) {
                    pageChunks.push(pageStructure.slice(i, i + pageChunkSize));
                }

                const l5Tasks = pageChunks.map((pageChunk, index) => {
                    return () => this.runPhase(
                        `L5: Writer (Loop ${loopCount + 1}, Batch ${index + 1})`,
                        `Write ${pageChunk.length} documentation pages`,
                        `# Writer Agent (L5)

## Role
- **Your Stage**: L5 Writer (Analysis Loop - Documentation Generation, runs in parallel)
- **Core Responsibility**: Transform L3 analysis into readable, well-structured documentation pages
- **Critical Success Factor**: L6 will review your output - focus on clarity and causal explanations



## Input
- Assigned Pages: ${JSON.stringify(pageChunk)}
- For each page, find and read L3 analysis files for the components listed in \`${intermediateDir}/L3/\` (files are named with component names)

## Instructions
1. For EACH assigned page: Create \`${outputPath}/pages/{pageName}.md\` with the page title and Overview section
2. Read L3 analysis for ALL components in that page's \`components\` array
3. Iterate through sections (Architecture, Mechanics, Interface): Synthesize content → Use \`apply_patch\` to write immediately
4. Generate an ASCII tree of ALL files from ALL components in this page → Use \`apply_patch\` to write

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
Write files to \`${outputPath}/pages/\`.

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.
3. **Incremental Writing**: Use \`apply_patch\` after each instruction step. Due to token limits, writing all at once risks data loss.
4. **Do NOT include raw source code or implementation details.**
5. **Strictly separate External Interface from Internal Mechanics.** Use tables for API references.
6. **No Intermediate Links**: Do NOT include links to intermediate analysis files (e.g., intermediate/L3/, ../L3/, ../L4/). Only reference other pages via their final page files in \`pages/\` directory: [Page Name](PageName.md)`,
                        token,
                        options.toolInvocationToken
                    );
                });
                await runWithConcurrencyLimit(l5Tasks, DEFAULT_MAX_CONCURRENCY, `L5 Writing (Loop ${loopCount + 1})`, token);

                // ---------------------------------------------------------
                // Level 6: PAGE REVIEWER (Check & Request Retry)
                // Input: All generated pages and all L3 analysis
                // ---------------------------------------------------------
                const isLastLoop = loopCount === MAX_LOOPS - 1;
                const retryInstruction = isLastLoop
                    ? `This is the FINAL attempt. Do NOT request retries. Fix minor issues directly within the pages. If a page is fundamentally broken, add a prominent warning note to the page itself, explaining the issue.`
                    : `If a page has MAJOR missing information or wrong analysis, list the Component Name(s) that need re-analysis (L3/L4/L5) in "` + intermediateDir + `/L6/retry_request.json".
                       Format: ["Auth Module", "Utils"].
                       For minor issues (typos, formatting, broken links), fix the page directly.`;

                await this.runPhase(
                    `L6: Page Reviewer (Loop ${loopCount + 1})`,
                    'Review pages and decide on retries',
                    `# Page Reviewer Agent (L6)

## Role
- **Your Stage**: L6 Reviewer (Analysis Loop - Quality Gate)
- **Core Responsibility**: Final quality gate - verify accuracy against source code, fix minor issues, request retry for major problems
- **Critical Success Factor**: You are the last line of defense before final output - be thorough



## Goal
Check pages in \`${outputPath}/pages/\` for quality based on ALL L3 analysis files.

## Input
- Read generated pages in \`${outputPath}/pages/\`
- Read all L3 analysis files in \`${intermediateDir}/L3/\`

## Instructions
1. **Accuracy**: Verify content against ACTUAL SOURCE CODE → If errors found, use \`apply_patch\` to fix immediately
2. **Completeness**: Ensure no sections (Overview, Architecture, API) are empty or placeholders → Use \`apply_patch\` to fill if needed
3. **Connectivity**: Verify that all links work and point to existing files → Use \`apply_patch\` to fix broken links
4. **Formatting**: Fix broken Markdown tables or Mermaid syntax errors → Use \`apply_patch\` to write fixes
5. **Numerical Consistency**: Check for inconsistent numerical values (e.g., "8h" vs "8 hours") → Use \`apply_patch\` to unify
6. **Signature Accuracy**: Verify method/function signatures match actual source code
   - If a signature is incorrect, read the actual source file and use \`apply_patch\` to fix
7. **CRITICAL - Remove Intermediate Links**: REMOVE any references to intermediate directory files (intermediate/, ../L3/, ../L4/, etc.) → Use \`apply_patch\` to fix
8. ` + retryInstruction + `

## Output
- Overwrite pages in \`${outputPath}/pages/\` if fixing.
- Write \`${intermediateDir}/L6/retry_request.json\` ONLY if requesting retries.

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.
3. **Incremental Writing**: Use \`apply_patch\` after each instruction step. Due to token limits, writing all at once risks data loss.`,
                    token,
                    options.toolInvocationToken
                );

                // ---------------------------------------------------------
                // Check for Retries
                // ---------------------------------------------------------
                // L6 requested a retry: need to re-run L3/L4/L5 for specific components
                const retryFileUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L6', 'retry_request.json'));
                let retryNames: string[] | null = null;
                try {
                    const retryContent = await vscode.workspace.fs.readFile(retryFileUri);
                    retryNames = this.parseJson<string[]>(new TextDecoder().decode(retryContent));
                    await vscode.workspace.fs.delete(retryFileUri); // Delete the retry request file
                } catch (e) {
                    // File not found or invalid means no retries requested
                    logger.log('DeepWiki', 'No retry request found or file invalid.');
                }

                if (retryNames && Array.isArray(retryNames) && retryNames.length > 0) {
                    logger.log('DeepWiki', `Reviewer requested retry for: ${retryNames.join(', ')}`);
                    // Filter componentList to get the actual component objects for retry
                    componentsToAnalyze = componentList.filter(c => retryNames!.includes(c.name));
                    if (componentsToAnalyze.length === 0) {
                        logger.warn('DeepWiki', 'Retry requested for unknown components. Stopping loop.');
                        break;
                    }
                } else {
                    logger.log('DeepWiki', 'No retries requested. Pipeline finished.');
                    componentsToAnalyze = []; // Stop loop
                }

                loopCount++;
            }

            // ---------------------------------------------------------
            // INDEXER
            // ---------------------------------------------------------
            await this.runPhase(
                'Indexer',
                'Create README and Sidebar',
                `# Indexer Agent

## Role
- **Your Stage**: Indexer (Final Stage)
- **Core Responsibility**: Create a high-quality README that serves as the definitive entry point for understanding this codebase
- **Critical Success Factor**: The README should answer "What is this? How is it organized? Where do I start?" within the first screen



## Input
- Read \`${intermediateDir}/L4/overview.md\`
- Read \`${intermediateDir}/L4/relationships.md\`
- Scan \`${outputPath}/pages/\`

## Instructions
Create \`${outputPath}/README.md\` with the following CONTENT sections (in order):

### 0. Disclaimer (at the very top)
Add this exact text at the very beginning of the README:
> **Note**: This documentation was auto-generated by an LLM. While we strive for accuracy, please refer to the source code for authoritative information.

### 1. Architecture Overview

**A. One-Line Summary**
Summarize the ENTIRE system in ONE sentence.

**B. System Context (C4Context diagram) - REQUIRED**
Show how this system fits in the bigger picture:
- Write 2-3 sentences explaining the system context BEFORE the diagram
- Use \`C4Context\` Mermaid diagram
- Show: external systems/users, system boundaries
- Keep it high-level (5-7 nodes max)

**C. Core State Transitions (stateDiagram-v2) - REQUIRED**
Show the fundamental state machine of the system:
- Write 2-3 sentences explaining the state flow BEFORE the diagram
- Use \`stateDiagram-v2\` Mermaid diagram
- Show: main states, what triggers transitions
- Focus on the CORE flow, not edge cases

**D. Component Overview (block) - REQUIRED**
List all major components/modules as a visual map:
- Write 2-3 sentences explaining the component structure BEFORE the diagram
- Use \`block\` Mermaid diagram
- Group related components together using nested blocks
- **Arrows (-->) are forbidden** in block diagrams; use grouping alone to convey structure
- This should serve as a VISUAL TABLE OF CONTENTS

### 2. Components
For each component shown in the block diagram above:
- **Name** with link to its page: [ComponentName](pages/ComponentName.md)
- **One-line description** of what it does

## Output
- Write README.md to \`${outputPath}/README.md\`

## Constraints
1. **Scope**: Do NOT Modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.
3. **Incremental Writing**: You have a limited token budget. Write incrementally.
   - Do NOT: Analyze all items then write all at end
   - DO: Analyze one item, write immediately, then move to next
   - Create file with first section, then use \`apply_patch\` to write each section IMMEDIATELY after analyzing it.
4. **Sanitize Intermediate Links**: REMOVE or REWRITE any references to intermediate directory files (e.g., intermediate/, ../L3/, ../L4/). Only include links to final pages in the \`pages/\` directory.
5. **Synthesize, Don't Dump**: Do NOT just copy L4 Overview - synthesize it into the sections above.
6. **Required Diagrams**: All 3 diagrams (C4Context, stateDiagram, block) are REQUIRED.`,
                token,
                options.toolInvocationToken
            );

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `✅ DeepWiki Generation Completed!\n\nDocumented ${componentList.length} components into ${finalPageCount} pages. Check the \`${outputPath}\` directory.`
                )
            ]);

        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error('DeepWiki', `Pipeline failed: ${msg}`);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`❌ Pipeline failed: ${msg}`)
            ]);
        }
    }

    private async cleanOutputDirectory(
        workspaceFolder: vscode.WorkspaceFolder,
        outputPath?: string
    ): Promise<void> {
        const dirName = outputPath?.trim() || '.deepwiki';
        if (dirName === '' || dirName === '.' || dirName === '/' || dirName === '\\') {
            logger.warn('DeepWiki', 'Skipping cleanup: unsafe output path');
            return;
        }

        const targetPath = path.normalize(path.join(workspaceFolder.uri.fsPath, dirName));
        if (!targetPath.startsWith(path.normalize(workspaceFolder.uri.fsPath + path.sep))) {
            logger.warn('DeepWiki', `Skipping cleanup: outputPath escapes workspace (${dirName})`);
            return;
        }

        const targetUri = vscode.Uri.file(targetPath);
        logger.log('DeepWiki', `Preparing cleanup for output directory: ${targetUri.fsPath}`);
        try {
            await vscode.workspace.fs.delete(targetUri, { recursive: true });
            logger.log('DeepWiki', `Cleaned output directory: ${targetUri.fsPath}`);
        } catch (error) {
            const code = (error as { code?: string }).code;
            const message = error instanceof Error ? error.message : String(error);
            if (code === 'FileNotFound' || /ENOENT/.test(message)) {
                logger.log('DeepWiki', `No existing output directory to clean at: ${targetUri.fsPath}`);
                return; // nothing to delete
            }
            logger.warn('DeepWiki', `Output cleanup skipped: ${message}`);
        }
    }

    private parseJson<T>(content: string): T {
        let jsonStr = content.trim();
        const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (match) {
            jsonStr = match[1].trim();
        }
        return JSON.parse(jsonStr);
    }

    private async runPhase(
        agentName: string,
        description: string,
        prompt: string,
        cancellationToken: vscode.CancellationToken,
        toolInvocationToken: vscode.ChatParticipantToolToken | undefined
    ): Promise<void> {
        const startTime = Date.now();
        logger.log('DeepWiki', `>>> Starting Phase: ${agentName} - ${description}`);

        // Wait 10 seconds before each subagent call to avoid API rate limits
        await new Promise(resolve => setTimeout(resolve, 10000));

        try {
            const result = await vscode.lm.invokeTool(
                'runSubagent',
                {
                    input: {
                        description: description,
                        prompt: prompt
                    },
                    toolInvocationToken: toolInvocationToken
                },
                cancellationToken
            );

            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            let resultPreview = '';
            for (const part of result.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    resultPreview = part.value.substring(0, 150).replace(/\n/g, ' ');
                    break;
                }
            }
            logger.log('DeepWiki', `<<< Completed Phase: ${agentName} in ${duration}s - ${resultPreview}...`);
        } catch (error) {
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            logger.error('DeepWiki', `!!! Failed Phase: ${agentName} after ${duration}s`, error);
            throw error;
        }
    }


}
