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


	        // Function to generate pipeline overview with current stage highlighted
	        const getPipelineOverview = (currentStage: string) => `
	## Pipeline Overview (short)
	L1 Context${currentStage === 'L1' ? ' ← YOU' : ''} → L2 Discover (A/B/C)${currentStage.startsWith('L2') ? ' ← YOU' : ''} → L3 Analyze${currentStage === 'L3' ? ' ← YOU' : ''} → L3-V Validate${currentStage === 'L3V' ? ' ← YOU' : ''} → L3-R Review${currentStage === 'L3R' ? ' ← YOU' : ''} → L4 Architect${currentStage === 'L4' ? ' ← YOU' : ''} → L5-Pre Group Pages${currentStage.startsWith('L5-Pre') ? ' ← YOU' : ''} → L5 Write Pages${currentStage === 'L5' ? ' ← YOU' : ''} → L5-V Validate${currentStage === 'L5V' ? ' ← YOU' : ''} → L6 Review${currentStage === 'L6' ? ' ← YOU' : ''} → L7 Indexer${currentStage === 'L7' ? ' ← YOU' : ''} → L8 QA (README)${currentStage === 'L8' ? ' ← YOU' : ''} → L9 QA (Release Gate)${currentStage === 'L9' ? ' ← YOU' : ''}
	(Write artifacts under \`.deepwiki/\`; do not touch other files.)
	`;


        const bq = '`';
        const mdCodeBlock = bq + bq + bq;

        // Define ComponentDef interface globally within invoke scope
        interface ComponentDef { name: string; files: string[]; description: string }

        try {
            // Pre-create intermediate level directories so all phases can reliably write artifacts.
            for (const level of ['L1', 'L2', 'L3', 'L3V', 'L3R', 'L4', 'L5', 'L5V', 'L6', 'L7', 'L8', 'L9']) {
                const dirUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, intermediateDir, level));
                await vscode.workspace.fs.createDirectory(dirUri);
            }

            const existingDeepWikis = await this.discoverExistingDeepWikis(workspaceFolder, outputPath);
            const existingDeepWikisNote =
                existingDeepWikis.length > 0
                    ? `\n\n## Existing Nested DeepWikis (EXCLUDE)\nRead \`${intermediateDir}/L1/existing_deepwikis.md\` and DO NOT analyze any files under those root directories. If you need to mention them, only link to their \`.deepwiki/README.md\`.\n`
                    : '';

            // ==================================================================================
            // PHASE 0: PROJECT CONTEXT ANALYSIS (Environment Understanding)
            // This phase runs once to understand the project structure and build environment.
            // ==================================================================================

            // ---------------------------------------------------------
            // Level 0: PROJECT CONTEXT ANALYZER
            // ---------------------------------------------------------
            checkCancellation();
            logger.log('DeepWiki', 'Starting L1: Project Context Analysis...');
            await this.runPhase(
                'L1: Project Context Analyzer',
                'Analyze project environment and context',
	                `# Project Context Analyzer Agent (L1)

## Role
- **Your Stage**: L1 Analyzer (Pre-Discovery)
- **Core Responsibility**: Capture project type, build system, and conditional/active code patterns
- **Critical Success Factor**: Downstream agents must rely on this to avoid documenting inactive/generated code

## Goal
Create a concise but accurate project context document for later stages.
${existingDeepWikisNote}

## Workflow
1. Detect project type, languages, build/entry points → write "## Overview"
2. Identify target environments (runtime/platforms) → write "## Target Environments"
3. Find conditional patterns/feature flags (e.g., \`#ifdef\`, \`process.env\`) → write "## Conditional Code Patterns"
4. List generated/vendor/test/excluded code paths → write "## Generated/Excluded Code"
5. Add any analysis notes that affect interpretation → write "## Notes for Analysis"
6. Quick self-check: sections are filled and grounded in actual files.

## Output
Write Markdown to \`${intermediateDir}/L1/project_context.md\` using this structure (example only; do not wrap the whole file in fences):
${mdCodeBlock}markdown
# Project Context

## Overview
- **Project Type**: ...
- **Languages**: ...
- **Build System**: ...

## Target Environments
| Environment | Description |
|------------|-------------|
| ... | ... |

## Conditional Code Patterns
- Pattern: ...
- Examples: ...
- Affected files: ...

## Generated/Excluded Code
- **Generated**: ...
- **Vendor/External**: ...
- **Test Code**: ...

## Notes for Analysis
...
${mdCodeBlock}

## Constraints
1. **Scope**: Only write under \`.deepwiki/\`. Read source code as needed.
2. **Chat Final Response**: One short confirmation line. Do not include file contents.
3. **Incremental Writing**: Write section-by-section with \`applyPatch\`.

` + getPipelineOverview('L1'),
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
    "description": "Handles user authentication"
  }
]
`;
            await this.runPhase(
                'L2-A: Drafter',
                'Draft initial component grouping',
	                `# Component Drafter Agent (L2-A)

## Role
- **Your Stage**: L2-A Drafter (Discovery Phase - First Pass)
- **Core Responsibility**: Propose an initial logical component grouping based on functionality
- **Critical Success Factor**: Group files that truly work together as one unit

## Input
- **Project Context**: Read \`${intermediateDir}/L1/project_context.md\` for project structure and build system info
- **Excluded Roots**: Read \`${intermediateDir}/L1/existing_deepwikis.md\` and exclude those directories entirely from analysis

## Goal
Create an INITIAL draft of logical components based on **what the code does**, not just folders.

## Workflow
1. Read the L1 project context to understand the project structure (exclude generated/vendor code).
2. Identify excluded roots from \`${intermediateDir}/L1/existing_deepwikis.md\` and DO NOT read/include any files under those roots.
3. Scan the project source files and **read their contents** to understand what each file does.
4. Group files into **components** - files that work together to implement a feature or module.
5. **Verify each file exists** before adding it to the files array.
6. Before writing, quickly sanity-check that your JSON is valid and non-empty.

## Output
Write the draft **RAW JSON (no Markdown fences)** to \`${intermediateDir}/L2/component_draft.json\`.

**Format (raw JSON; no backticks, no fences)**:
Example:
${jsonExample}

> IMPORTANT: the file content must be raw JSON only. Your chat reply: one short confirmation line.

## Constraints
1. **Files**: The "files" array must contain actual file paths with extensions (e.g., "src/auth/auth.ts"), NOT directory paths.
2. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
3. **Chat Final Response**: Keep your chat reply brief (e.g., "Draft written."). Do not include JSON or file contents.
4. **Naming**: \`name\` must be filename-safe across platforms (avoid \`<>:"/\\\\|?*\`; no leading/trailing spaces).
5. **JSON Strictness**: Output must be a single JSON array (starts with \`[\` and ends with \`]\`), no trailing commas, no comments.

` + getPipelineOverview('L2-A'),
                token,
                options.toolInvocationToken
            );

            // Loop for Review & Refine
            let componentList: ComponentDef[] = [];
            let l1RetryCount = 0;
            const maxL2Retries = 6;
            let isL2Success = false;

            while (l1RetryCount < maxL2Retries) {
                logger.log('DeepWiki', `L2 Review/Refine Loop: ${l1RetryCount + 1}/${maxL2Retries}`);

                const retryContextL2 = l1RetryCount > 0
                    ? `\n\n**CONTEXT**: Previous attempt failed to produce valid JSON. Please review more carefully and ensure valid format.`
                    : '';

                // ---------------------------------------------------------
                // Level 1-B: COMPONENT REVIEWER (Critique Only)
                // ---------------------------------------------------------
                await this.runPhase(
                    `L2-B: Reviewer (Attempt ${l1RetryCount + 1})`,
                    'Critique component grouping',
	                    `# Component Reviewer Agent (L2-B)

## Role
- **Your Stage**: L2-B Reviewer (Discovery Phase - Quality Gate)
- **Core Responsibility**: Critique L2-A's draft; identify issues but do NOT edit the draft JSON
- **Critical Success Factor**: Verify files exist and groupings make functional sense

## Goal
CRITIQUE the draft. Do NOT fix it yourself.

## Input
- Read \`${intermediateDir}/L2/component_draft.json\`
- **Reference**: Use file listing tools and **read file contents** to verify groupings.
- **Excluded Roots**: Read \`${intermediateDir}/L1/existing_deepwikis.md\` and treat those directories as out of scope.

## Workflow
1. Review groupings for **functional cohesion**:
   - Are files that work together grouped together?
   - Are unrelated files incorrectly grouped just because they share a directory?
2. **Verification**: Read sample files to verify they actually belong together.
3. **File Existence Check**: Verify ALL file paths in the draft actually exist. Flag any non-existent files.
4. **Scope Check**: If any file path is under an excluded root, flag it as out-of-scope and request removal.
5. Check for missing core files or included noise.${retryContextL2}

## Output
Write a critique report to \`${intermediateDir}/L2/review_report.md\` (point out what to change and why).

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.

` + getPipelineOverview('L2-B'),
                    token,
                    options.toolInvocationToken
                );

                // ---------------------------------------------------------
                // Level 1-C: COMPONENT REFINER (Fix & Finalize)
                // ---------------------------------------------------------
                await this.runPhase(
                    `L2-C: Refiner (Attempt ${l1RetryCount + 1})`,
                    'Refine component list based on review',
	                    `# Component Refiner Agent (L2-C)

## Role
- **Your Stage**: L2-C Refiner (Discovery Phase - Final Output)
- **Core Responsibility**: Merge L2-A draft with L2-B feedback into validated JSON
- **Critical Success Factor**: Produce valid JSON that L2 can use - your output feeds the entire pipeline

## Goal
Create the FINAL component list.

## Input
- Draft: \`${intermediateDir}/L2/component_draft.json\`
- Review: \`${intermediateDir}/L2/review_report.md\`
- Excluded Roots: \`${intermediateDir}/L1/existing_deepwikis.md\`

## Workflow
1. Read the Draft and the Review Report.
2. Apply the suggested fixes to the component list.
3. Remove any file paths that fall under excluded roots (already documented elsewhere).
4. Ensure: (a) no missing core files, (b) no duplicates, (c) each component has a clear purpose.
5. Produce valid JSON.${retryContextL2}

## Output
- Write the FINAL **RAW JSON (no fences)** to \`${intermediateDir}/L2/component_list.json\`.
- Format must be a valid non-empty JSON array.

## Constraints
1. **File Existence**: All file paths in the "files" array MUST exist. Fix typos/paths where possible; remove only if truly unfixable.
2. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
3. **Chat Final Response**: Keep your chat reply brief (e.g., "List finalized."). Do not include JSON or file contents.

` + getPipelineOverview('L2-C'),
                    token,
                    options.toolInvocationToken
                );

                // ---------------------------------------------------------
                // Check JSON validity
                // ---------------------------------------------------------
                const fileListUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L2', 'component_list.json'));
                try {
                    const fileListContent = await vscode.workspace.fs.readFile(fileListUri);
                    const contentStr = new TextDecoder().decode(fileListContent);
                    componentList = this.parseJson<ComponentDef[]>(contentStr);

                    if (!Array.isArray(componentList) || componentList.length === 0) {
                        throw new Error('Parsed JSON is not a valid array or is empty.');
                    }

                    logger.log('DeepWiki', `L2 Success: Identified ${componentList.length} logical components.`);
                    isL2Success = true;
                    break; // Exit loop on success
                } catch (e) {
                    logger.error('DeepWiki', `L2 Attempt ${l1RetryCount + 1} Failed: ${e}`);
                    l1RetryCount++;
                }
            }

            if (!isL2Success) {
                throw new Error('L2 Discovery failed to produce valid components after retries. Pipeline stopped.');
            }

            // Level 2: EXTRACTOR (Symbol-Level Parallel Extraction)
            // ---------------------------------------------------------
            // Each symbol (function/class/method) is processed by a separate subagent
            // Step 1: Extract symbols and generate skeleton files

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
                // Task generator function for L3 analysis (shared by initial and retry)
                const createL3Task = (component: ComponentDef) => {
                    const componentStr = JSON.stringify(component);
                    const originalIndex = componentList.findIndex(c => c.name === component.name);
                    const paddedIndex = String(originalIndex + 1).padStart(3, '0');
                    return () => this.runPhase(
                        `L3: Analyzer (Loop ${loopCount + 1}, ${component.name})`,
                        `Analyze component`,
                        `# Analyzer Agent (L3)

## Role
- **Your Stage**: L3 Analyzer (Analysis Loop - may retry up to 5 times)
- **Core Responsibility**: Deep analysis - understand HOW code works, trace event/state causality, create diagrams
- **Critical Success Factor**: L4 and L5 depend on your analysis - be thorough and accurate

## Input
- **Assigned Component**: ${componentStr}
- **Source Code Files**: The original source files listed in the component

## Workflow
1. Create empty file \`${intermediateDir}/L3/${paddedIndex}_${component.name}_analysis.md\`
2. Read source code files for this component
3. For each analysis section: Analyze → Use \`applyPatch\` to write
   - Overview and Architecture
   - Key Logic
   - **Causal Analysis** (use the template below; do not rename headings)
4. Create Mermaid diagrams → Use \`applyPatch\` to write
   - **Recommended**: \`stateDiagram-v2\` (for state causality), \`sequenceDiagram\` (for event flow), \`C4Context\`, \`classDiagram\`, \`block\`
   - **Forbidden**: \`flowchart\`, \`graph TD\`

## Grounding (MANDATORY)
- Be objective and grounded in the assigned source files.
- For each bullet you write, include at least one concrete anchor: a file path and/or a real identifier (function/class/command/event name) that exists in the code.
- Do NOT write "Unknown" inside the main analysis sections. If something cannot be verified from the source files, record it under "## Open Questions (Need Verification)" at the end, and explain what would be needed to confirm it.

## Causal Analysis Template (MANDATORY)
Write a \`## Causal Analysis\` section and include the following headings EXACTLY (fill all that apply; if truly not applicable, write "N/A" and explain why).

### Trigger(s)
- What initiates behavior? (API calls, commands, UI events, timers, background jobs, extension activation, etc.)

### Preconditions & Guards
- Feature flags, environment checks, permission checks, validation, early returns.

### Step-by-Step Causal Chain
- A → B → C in the order it happens (name key functions/classes; mention where control transfers).

### State & Data (Read/Write)
- What data/state is read or written? (in-memory, files, DB, caches). Include the "source of truth".

### State Inventory (for Diagram)
- List the key states you will use in the \`stateDiagram-v2\`.
- For each state, define it in terms of concrete code conditions (e.g., boolean flags, enum values, object lifecycle, file presence).

### Boundaries (Async/Thread/Transaction)
- Where async boundaries occur (await/promise/event emitter), transaction boundaries, queues/RPC boundaries.

### Side Effects & External I/O
- File system writes, network calls, VS Code APIs that mutate workspace/editor state, logging/telemetry.

### Error Paths & Retries
- Failure modes and propagation (throws, error returns), retry loops/backoff, user-facing errors.

### Invariants (Postconditions)
- Conditions that must hold after success (and after failure, if relevant).

### Causal Diagram(s)
- **Default requirement**: Include a \`stateDiagram-v2\` for state transitions (include event triggers on edges) using the states from "State Inventory".
- **Fallback (only if truly not applicable)**: Use a \`sequenceDiagram\` instead, and explicitly explain why a state machine is not a good fit (e.g., pure stateless utilities/types/config with no meaningful triggers/state transitions).

Example \`stateDiagram-v2\` (event triggers on edges):
\`\`\`mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Loading : user.submit
    Loading --> Success : api.response
    Loading --> Error : api.error
    Success --> Idle : user.reset
    Error --> Loading : user.retry
\`\`\`

## Output
Write to \`${intermediateDir}/L3/${paddedIndex}_${component.name}_analysis.md\`

## Open Questions (Need Verification)
If any critical detail cannot be verified from the assigned source files, add this final section (otherwise omit it):
- Question/uncertainty
- Why it is uncertain (what evidence is missing)
- What file/config/runtime evidence would confirm it

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.
3. **Incremental Writing**: Use \`applyPatch\` after each instruction step. Due to token limits, writing all at once risks data loss.

` + getPipelineOverview('L3'),
                        token,
                        options.toolInvocationToken
                    );
                };

                // Initial L3 analysis
                const l3Tasks = componentsToAnalyze.map(createL3Task);
                await runWithConcurrencyLimit(l3Tasks, DEFAULT_MAX_CONCURRENCY, `L3 Analysis (Loop ${loopCount + 1})`, token);

                // ---------------------------------------------------------
                // L3 Validator: Check for missing files and retry if needed
                // ---------------------------------------------------------
                const l3ExpectedFiles = componentsToAnalyze.map((c) => {
                    const originalIndex = componentList.findIndex(comp => comp.name === c.name);
                    return {
                        name: c.name,
                        file: `${String(originalIndex + 1).padStart(3, '0')}_${c.name}_analysis.md`
                    };
                });
                await this.runPhase(
                    `L3-V: Validator (Loop ${loopCount + 1})`,
                    'Validate L3 output files',
                    `# L3 Validator Agent

## Role
Quality gate for L3 outputs: ensure expected analysis files exist and are minimally usable for downstream stages.

## Expected Files
Directory: \`${intermediateDir}/L3/\`
Files to verify:
${l3ExpectedFiles.map(f => `- \`${f.file}\` (Component: ${f.name})`).join('\n')}

## Workflow
1. List files in \`${intermediateDir}/L3/\`
2. Compare against expected files above and identify missing files
3. For each PRESENT file, do quick sanity checks:
   - Not empty / not a placeholder stub
   - Contains at least a title and some substantive content (not just headings)
   - Contains a \`## Causal Analysis\` section
   - Contains ALL required headings under Causal Analysis:
     - \`### Trigger(s)\`
     - \`### Preconditions & Guards\`
     - \`### Step-by-Step Causal Chain\`
     - \`### State & Data (Read/Write)\`
     - \`### State Inventory (for Diagram)\`
     - \`### Boundaries (Async/Thread/Transaction)\`
     - \`### Side Effects & External I/O\`
     - \`### Error Paths & Retries\`
     - \`### Invariants (Postconditions)\`
     - \`### Causal Diagram(s)\`
   - Includes at least one Mermaid diagram block (\`\`\`mermaid ... \`\`\`) under \`### Causal Diagram(s)\`
   - If the string "Unknown" appears, it must ONLY appear under a final section titled exactly \`## Open Questions (Need Verification)\` (otherwise fail)
4. Always write a short report to \`${intermediateDir}/L3V/validation_report.md\`:
   - Missing components
   - Components that failed sanity checks (brief reason)
5. If ALL files exist AND pass sanity checks → Write empty array to \`${intermediateDir}/L3V/validation_failures.json\`
6. If ANY files are missing OR fail sanity checks → Write JSON array of component names that must be retried to \`${intermediateDir}/L3V/validation_failures.json\`

## Output
Write to \`${intermediateDir}/L3V/validation_failures.json\`:
- If all present: \`[]\`
- If retry needed: \`["Component A", "Component B"]\`

## Constraints
1. Keep response brief (e.g., "Validation complete.")
`,
                    token,
                    options.toolInvocationToken
                );

                // Check L3 validation result and retry failed components
                const l3FailuresUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L3V', 'validation_failures.json'));
                let l3FailedComponents: string[] = [];
                try {
                    const content = await vscode.workspace.fs.readFile(l3FailuresUri);
                    l3FailedComponents = this.parseJson<string[]>(new TextDecoder().decode(content));
                    await vscode.workspace.fs.delete(l3FailuresUri);
                } catch { /* no failures file or invalid */ }

                if (l3FailedComponents.length > 0) {
                    logger.log('DeepWiki', `L3 Validator found ${l3FailedComponents.length} missing files, retrying: ${l3FailedComponents.join(', ')}`);
                    // Retry using the same task generator function
                    const failedL3Components = componentsToAnalyze.filter(c => l3FailedComponents.includes(c.name));
                    const l3RetryTasks = failedL3Components.map(createL3Task);
                    await runWithConcurrencyLimit(l3RetryTasks, DEFAULT_MAX_CONCURRENCY, `L3 Retry (Loop ${loopCount + 1})`, token);
                }

                // ---------------------------------------------------------
                // L3-R: REVIEWER (Deeper review of each component analysis; parallel)
                // ---------------------------------------------------------
                const createL3RTask = (component: ComponentDef) => {
                    const componentStr = JSON.stringify(component);
                    const originalIndex = componentList.findIndex(c => c.name === component.name);
                    const paddedIndex = String(originalIndex + 1).padStart(3, '0');
                    const analysisFile = `${paddedIndex}_${component.name}_analysis.md`;
                    const reviewFile = `${paddedIndex}_${component.name}_review.md`;
                    const retryFile = `${paddedIndex}_${component.name}_retry.json`;
                    return () => this.runPhase(
                        `L3-R: Reviewer (Loop ${loopCount + 1}, ${component.name})`,
                        `Review L3 analysis`,
                        `# L3 Reviewer Agent (L3-R)

## Role
- **Your Stage**: L3-R Reviewer (Quality Gate)
- **Core Responsibility**: Review the L3 analysis for correctness and usefulness before L4 synthesis.
- **Critical Success Factor**: Catch wrong/invented statements early so they don't propagate.

## Input
- **Assigned Component**: ${componentStr}
- Component list (source of truth): \`${intermediateDir}/L2/component_list.json\`
- L3 analysis file: \`${intermediateDir}/L3/${analysisFile}\`

## Workflow
1. Open the L3 analysis file and the component's source files.
2. Verify at least 3 concrete claims in the analysis against ACTUAL SOURCE CODE (APIs, control flow, events, state changes).
3. If you find an unverifiable or wrong claim: delete or rewrite the smallest possible part in the L3 analysis (do not guess).
4. If the analysis is too thin (only headings / vague), add missing critical details ONLY if you can justify them from code.
5. Ensure diagrams (if present) are consistent with code; remove/adjust broken or misleading diagrams.
6. Write a short review note to \`${intermediateDir}/L3R/${reviewFile}\`:
   - What you verified
   - What you changed (if any)
   - Remaining concerns (if any)
7. If the analysis is fundamentally broken or too incomplete to fix safely, write \`${intermediateDir}/L3R/${retryFile}\` as raw JSON array \`["${component.name}"]\`. Otherwise, do not create the file.

## Constraints
1. **Scope**: Only modify files under \`.deepwiki/\`. Read source code as needed.
2. **No guessing**: If you can't verify, delete rather than invent.
3. **Chat Final Response**: One short confirmation line; no file contents.

` + getPipelineOverview('L3R'),
                        token,
                        options.toolInvocationToken
                    );
                };

                const l3rTasks = componentsToAnalyze.map(createL3RTask);
                await runWithConcurrencyLimit(l3rTasks, DEFAULT_MAX_CONCURRENCY, `L3 Review (Loop ${loopCount + 1})`, token);

                const l3rRetryPattern = new vscode.RelativePattern(workspaceFolder, `${intermediateDir}/L3R/*_retry.json`);
                const l3rRetryUris = await vscode.workspace.findFiles(l3rRetryPattern);
                const l3rRetryNamesSet = new Set<string>();
                for (const uri of l3rRetryUris) {
                    try {
                        const content = await vscode.workspace.fs.readFile(uri);
                        const names = this.parseJson<string[]>(new TextDecoder().decode(content));
                        if (Array.isArray(names)) names.forEach(n => l3rRetryNamesSet.add(n));
                    } catch {
                        // ignore invalid retry file
                    } finally {
                        try {
                            await vscode.workspace.fs.delete(uri);
                        } catch {
                            // ignore delete failures
                        }
                    }
                }

                const l3rRetryNames = Array.from(l3rRetryNamesSet);
                if (l3rRetryNames.length > 0) {
                    logger.log('DeepWiki', `L3 Reviewer requested re-analysis for: ${l3rRetryNames.join(', ')}`);
                    const retryComponents = componentsToAnalyze.filter(c => l3rRetryNames.includes(c.name));
                    if (retryComponents.length > 0) {
                        const l3RetryTasks = retryComponents.map(createL3Task);
                        await runWithConcurrencyLimit(l3RetryTasks, DEFAULT_MAX_CONCURRENCY, `L3 Re-Analyze (Loop ${loopCount + 1})`, token);
                        // Re-run L3-R only for the re-analyzed components once (do not request further retries).
                        const l3rSecondPassTasks = retryComponents.map(createL3RTask);
                        await runWithConcurrencyLimit(l3rSecondPassTasks, DEFAULT_MAX_CONCURRENCY, `L3 Review (2nd pass, Loop ${loopCount + 1})`, token);
                    }
                }

                // ---------------------------------------------------------
                // Level 4: ARCHITECT (Runs in every loop to keep overview up to date)
                // Input: All L3 analysis files (even from previous loops)
                // ---------------------------------------------------------
	                await this.runPhase(
	                    `L4: Architect (Loop ${loopCount + 1})`,
	                    'Update system overview and maps',
	                    `# Architect Agent (L4)

## Role
- **Your Stage**: L4 Architect (Analysis Loop)
- **Core Responsibility**: Synthesize system-level architecture and cross-component causality
- **Critical Success Factor**: Indexer depends on your clarity and correctness

## Goal
Produce a coherent system overview from ALL L3 analyses.

## Input
Read ALL files in \`${intermediateDir}/L3/\` (including previous loops) and any necessary source files.

## Workflow
1. Read L3 analysis and confirm key responsibilities/links.
2. Write \`${intermediateDir}/L4/overview.md\`:
   - high-level architecture, major components, rationale ("why this shape?")
3. Write \`${intermediateDir}/L4/relationships.md\`:
   - cross-component event/state causality map
   - include diagrams (see below)
4. Quick self-check: overview matches L3 facts; diagrams render; no raw code pasted.

## Diagrams
- **Required**: at least one \`stateDiagram-v2\` for cross-component state/event flow
- **Recommended**: \`C4Context\`, \`sequenceDiagram\`, \`classDiagram\`, \`block\`
- **Forbidden**: \`flowchart\`, \`graph TD\`

## Output
- \`${intermediateDir}/L4/overview.md\`
- \`${intermediateDir}/L4/relationships.md\`
- Include at least TWO diagrams total.

## Constraints
1. **Scope**: Only write under \`.deepwiki/\`. Read source code as needed.
2. **Chat Final Response**: One short confirmation line. Do not include file contents.
3. **Incremental Writing**: Write section-by-section with \`applyPatch\`.

` + getPipelineOverview('L4'),
                    token,
                    options.toolInvocationToken
                );

                // ---------------------------------------------------------
                // Level 5 Pre: PAGE CONSOLIDATOR (3-stage: Draft → Review → Refine)
                // ---------------------------------------------------------
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
Write draft to \`${intermediateDir}/L5/page_structure_draft.json\`.

**Format (raw JSON; no backticks, no fences)**:
Example:
${pageStructureExample}

**Rules**:
- Every component from the input list MUST appear in exactly one page group
- \`pageName\` should be descriptive and user-friendly
- \`rationale\` explains why these components belong together

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.
3. **Naming**: \`pageName\` must be a filename-safe page slug across platforms (avoid \`<>:"/\\\\|?*\`; no leading/trailing spaces).
4. **JSON Strictness**: Output must be a single JSON array (starts with \`[\` and ends with \`]\`), no trailing commas, no comments.

` + getPipelineOverview('L5-Pre'),
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
- **Core Responsibility**: Critique L5-Pre-A's draft; identify issues but do NOT edit the draft JSON
- **Critical Success Factor**: Ensure groupings and page names feel right for readers

## Goal
CRITIQUE the draft page structure. Do NOT fix it yourself.

## Input
- Read \`${intermediateDir}/L5/page_structure_draft.json\`
- Read L3 analysis files in \`${intermediateDir}/L3/\` for reference

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
Write critique report to \`${intermediateDir}/L5/page_structure_review.md\` (what to change and why).

Include:
- Issues found (if any)
- Suggested improvements
- Overall assessment (Good/Needs Work)${retryContextL5Pre}

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.

` + getPipelineOverview('L5-Pre'),
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

## Workflow
1. Read the Draft and the Review Report.
2. Apply the suggested improvements to the page structure.
3. Self-check: all components included exactly once; no empty groups.
4. Produce the final valid JSON.${retryContextL5Pre}

## Output
Write FINAL **RAW JSON (no fences)** to \`${intermediateDir}/L5/page_structure.json\`.

**Format example (do not include fences in the file)**:
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
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Page structure finalized."). Do not include JSON or file contents.

` + getPipelineOverview('L5-Pre'),
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
> **Note**: This documentation was auto-generated by an LLM. While we strive for accuracy, please refer to the source code for authoritative information.

# {PageName}

## Summary
{Description of what this page covers}

## Sources
- \`path/to/source/file\` (add multiple; prefer \`src/...\`)

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
                // Task generator function for L5 writing (shared by initial and retry)
                const createL5Task = (pageChunk: PageGroup[]) => {
                    return () => this.runPhase(
                        `L5: Writer (Loop ${loopCount + 1})`,
                        `Write ${pageChunk.length} documentation pages`,
	                        `# Writer Agent (L5)

## Role
- **Your Stage**: L5 Writer (Analysis Loop - Documentation Generation, runs in parallel)
- **Core Responsibility**: Transform L3 analysis into readable, well-structured documentation pages
- **Critical Success Factor**: L6 will review your output - focus on clarity and causal explanations

## Input
- Assigned Pages: ${JSON.stringify(pageChunk)}
- For each page, read the matching L3 analysis files in \`${intermediateDir}/L3/\` (named like \`001_ComponentName_analysis.md\`)

## Workflow
1. For EACH assigned page: Create \`${outputPath}/pages/{pageName}.md\` with the page title and Overview section
2. Read L3 analysis for ALL components in that page's \`components\` array
3. Do NOT re-analyze source code; synthesize and consolidate L3 content into a reader-friendly page.
4. Iterate through sections (Architecture, Mechanics, Interface): Synthesize content → Use \`applyPatch\` to write immediately
5. Generate an ASCII tree of ALL files from ALL components in this page → Use \`applyPatch\` to write
6. **Grounding requirement**: Maintain a \`## Sources\` section listing the component source files this page is based on (and any additional files you read). Do NOT add new claims beyond what is supported by L3; if unsure, omit the claim rather than guessing.

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
3. **Incremental Writing**: Use \`applyPatch\` after each instruction step. Due to token limits, writing all at once risks data loss.
4. **Do NOT include raw source code or implementation details.**
5. **Strictly separate External Interface from Internal Mechanics.** Use tables for API references. If you include signatures, keep them short (no bodies).
6. **No Intermediate Links**: Do NOT include links to intermediate analysis files (e.g., intermediate/L3/, ../L3/, ../L4/). Only reference other pages via their final page files in \`pages/\` directory. If filenames contain spaces, wrap link targets in angle brackets, e.g. \`[Page Name](<Page Name.md>)\`.

` + getPipelineOverview('L5'),
                        token,
                        options.toolInvocationToken
                    );
                };

                // Create page chunks for L5 writing
                const pageChunkSize = 1;
                const pageChunks: PageGroup[][] = [];
                for (let i = 0; i < pageStructure.length; i += pageChunkSize) {
                    pageChunks.push(pageStructure.slice(i, i + pageChunkSize));
                }

                // Initial L5 writing
                const l5Tasks = pageChunks.map(createL5Task);
                await runWithConcurrencyLimit(l5Tasks, DEFAULT_MAX_CONCURRENCY, `L5 Writing (Loop ${loopCount + 1})`, token);

                // ---------------------------------------------------------
                // L5 Validator: Check for missing page files and retry if needed
                // ---------------------------------------------------------
                const l5ExpectedPages = pageStructure.map(p => ({
                    pageName: p.pageName,
                    file: `${p.pageName}.md`
                }));
                await this.runPhase(
                    `L5-V: Validator (Loop ${loopCount + 1})`,
                    'Validate L5 output files',
                    `# L5 Validator Agent

## Role
Check that all expected L5 documentation page files exist.

## Expected Files
Directory: \`${outputPath}/pages/\`
Files to verify:
${l5ExpectedPages.map(p => `- \`${p.file}\` (Page: ${p.pageName})`).join('\n')}

## Workflow
1. List files in \`${outputPath}/pages/\`
2. Compare against expected files above
3. If ALL files exist → Write empty array to \`${intermediateDir}/L5V/page_validation_failures.json\`
4. If ANY files are MISSING → Write JSON array of missing page names to \`${intermediateDir}/L5V/page_validation_failures.json\`

## Output
Write to \`${intermediateDir}/L5V/page_validation_failures.json\`:
- If all present: \`[]\`
- If missing: \`["Page A", "Page B"]\`

## Constraints
1. Keep response brief (e.g., "Validation complete.")
`,
                    token,
                    options.toolInvocationToken
                );

                // Check L5 validation result and retry failed pages
                const l5FailuresUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L5V', 'page_validation_failures.json'));
                let l5FailedPages: string[] = [];
                try {
                    const content = await vscode.workspace.fs.readFile(l5FailuresUri);
                    l5FailedPages = this.parseJson<string[]>(new TextDecoder().decode(content));
                    await vscode.workspace.fs.delete(l5FailuresUri);
                } catch { /* no failures file or invalid */ }

                if (l5FailedPages.length > 0) {
                    logger.log('DeepWiki', `L5 Validator found ${l5FailedPages.length} missing pages, retrying: ${l5FailedPages.join(', ')}`);
                    // Retry using the same task generator function
                    const failedPageStructure = pageStructure.filter(p => l5FailedPages.includes(p.pageName));
                    const retryPageChunks: PageGroup[][] = [];
                    for (let i = 0; i < failedPageStructure.length; i += pageChunkSize) {
                        retryPageChunks.push(failedPageStructure.slice(i, i + pageChunkSize));
                    }
                    const l5RetryTasks = retryPageChunks.map(createL5Task);
                    await runWithConcurrencyLimit(l5RetryTasks, DEFAULT_MAX_CONCURRENCY, `L5 Retry (Loop ${loopCount + 1})`, token);
                }

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
- Read relevant L3 analysis files in \`${intermediateDir}/L3/\` for each page’s components
- Read \`${intermediateDir}/L5/page_structure.json\` and \`${intermediateDir}/L2/component_list.json\` to map pages ↔ components ↔ source files

## Workflow
1. **Inventory**: Read \`${intermediateDir}/L5/page_structure.json\` and ensure every expected page exists under \`${outputPath}/pages/\`.
2. For EACH page:
   - **Sources**: Ensure a meaningful \`## Sources\` section exists. Populate it from the component file list (from \`${intermediateDir}/L2/component_list.json\`) plus any extra files you read to verify details. Remove any non-existent paths.
   - **No placeholders**: Remove/replace obvious placeholders (e.g., "TODO", "TBD", "{...}").
   - **Accuracy**: Verify statements against ACTUAL SOURCE CODE using the Sources as the starting set. If a statement cannot be verified, DELETE the smallest possible block (sentence/row) rather than guessing.
   - **Signatures**: If you list API signatures, verify they match the source; keep them brief (no bodies).
   - **Connectivity**: Fix broken links; ensure links target existing final files under \`${outputPath}/\`.
   - **Formatting**: Fix broken Markdown tables or Mermaid syntax errors.
3. **CRITICAL - Remove Intermediate Links**: REMOVE any references to intermediate artifacts (intermediate/, ../L3/, ../L4/, etc.) in final docs.
4. **Report**: Write \`${intermediateDir}/L6/review_report.md\` summarizing:
   - Files fixed (and what changed)
   - Claims removed due to unverifiability
   - Any major issues
5. ` + retryInstruction + `

## Output
- Overwrite pages in \`${outputPath}/pages/\` if fixing.
- Always write \`${intermediateDir}/L6/review_report.md\`.
- Write \`${intermediateDir}/L6/retry_request.json\` ONLY if requesting retries.
  - The file must be a raw JSON array of component names, e.g. \`["Auth Module"]\` (no extra fields, no fences).

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.
3. **Incremental Writing**: Use \`applyPatch\` after each instruction step. Due to token limits, writing all at once risks data loss.

` + getPipelineOverview('L6'),
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
                'L7: Indexer',
                'Create README and Sidebar',
	                `# Indexer Agent

## Role
- **Your Stage**: L7 Indexer
- **Core Responsibility**: Synthesize L4/L5 outputs into a high‑quality landing README
- **Critical Success Factor**: First screen should answer "What is this? How is it organized? Where do I start?"

## Input
- \`${intermediateDir}/L4/overview.md\`
- \`${intermediateDir}/L4/relationships.md\`
- \`${intermediateDir}/L5/page_structure.json\` (source of truth for pages)
- All files under \`${outputPath}/pages/\`
- Existing nested DeepWikis list: \`${intermediateDir}/L1/existing_deepwikis.md\`

## Workflow
Create \`${outputPath}/README.md\` with these sections in order:

### 0. Disclaimer (top)
Insert exactly:
> **Note**: This documentation was auto-generated by an LLM. While we strive for accuracy, please refer to the source code for authoritative information.

### 1. Architecture Overview
**A. One-Line Summary** — one sentence for the whole system.

**B. System Context (C4Context) — REQUIRED**
- 2–3 sentence preface, then diagram.
- High-level only (5–7 nodes).

**C. Core State Transitions (stateDiagram-v2) — REQUIRED**
- 2–3 sentence preface, then diagram.
- Show main states and triggers only.

**D. Component Overview (block) — REQUIRED**
- Must match pages in \`${intermediateDir}/L5/page_structure.json\` exactly.
- Each block = one page; no arrows; max one nesting level.
- 2–3 sentence preface, then diagram.

### 2. Components
For EACH page in \`${intermediateDir}/L5/page_structure.json\`:
- Link: If filename has no spaces: \`[PageName](pages/PageName.md)\`; if it has spaces: \`[PageName](<pages/Page Name.md>)\`
- One-line description using the rationale.

### 2.5 Existing DeepWikis (optional)
If \`${intermediateDir}/L1/existing_deepwikis.md\` is not "(none)", add a short section listing links to those existing docs (link to their \`.deepwiki/README.md\` only; do not summarize their internals).

### 3. Quick self-check
- All three diagrams present and render.
- Components list matches page_structure exactly.
- No links to intermediate files.

## Output
1. Write Markdown to \`${outputPath}/README.md\` (no fences around the whole file).
2. Write a short build log to \`${intermediateDir}/L7/indexer_report.md\` (what you changed/validated; keep it brief).

## Constraints
1. **Scope**: Only write under \`.deepwiki/\`. Read source code as needed.
2. **Chat Final Response**: One short confirmation line. Do not include file contents.
3. **Incremental Writing**: Write section-by-section with \`applyPatch\`.
4. **Sanitize Intermediate Links**: Never link to intermediate paths; only to final pages.
5. **Synthesize, Don't Dump**: Summarize and connect; do not copy L4 verbatim.

` + getPipelineOverview('L7'),
                token,
                options.toolInvocationToken
            );

            // ---------------------------------------------------------
            // Final QA: README verifier (avoid duplicating L6 page review loop)
            // ---------------------------------------------------------
            await this.runPhase(
                'L8: Final QA (README Verifier)',
                'Verify README claims and diagrams against generated pages and source code',
                `# Final QA Agent (README Verifier)

## Role
- **Your Stage**: L8 Final QA (README-only)
- **Core Responsibility**: Ensure \`${outputPath}/README.md\` contains no unverifiable claims.
- **Critical Success Factor**: README is the entry point; it must not hallucinate.

## Input
- \`${outputPath}/README.md\`
- All files under \`${outputPath}/pages/\`
- Source code: read as needed to verify any high-level claim

## Workflow
1. Read \`${outputPath}/README.md\` and the linked pages in \`${outputPath}/pages/\`.
2. Verify the one-line summary and any architectural assertions against the pages and, when needed, actual source code.
3. If anything cannot be verified, delete it or rewrite it conservatively (no guessing).
4. Ensure there are no links to intermediate artifacts (intermediate/, ../L3/, ../L4/, etc.).
5. Write a report to \`${intermediateDir}/L8/factcheck_report.md\` including:
   - Files modified (at least README if changed)
   - Summary of removed/rewritten unverifiable claims
   - Any remaining known limitations (if any)

## Constraints
1. **Scope**: Only modify files under \`.deepwiki/\`. Read source code as needed.
2. **No guessing**: If you can't verify, remove or rewrite conservatively.
3. **Incremental Writing**: Use \`applyPatch\` as you go.
4. **Chat Final Response**: One short confirmation line; no file contents.
`,
                token,
                options.toolInvocationToken
            );

            // ---------------------------------------------------------
            // Final QA: Release Gate
            // ---------------------------------------------------------
            await this.runPhase(
                'L9: Final QA (Release Gate)',
                'Final output integrity checks and cleanup',
                `# Final QA Agent (Release Gate)

## Role
- **Your Stage**: L9 Final QA (Release Gate)
- **Core Responsibility**: Enforce final output invariants right before completion.

## Input
- \`${outputPath}/README.md\`
- \`${outputPath}/pages/*.md\`

## Workflow
1. Scan ALL docs under \`${outputPath}/README.md\` and \`${outputPath}/pages/\`.
2. Enforce these invariants (fix by editing docs as needed):
   - No references/links to intermediate artifacts (intermediate/, ../L3/, ../L4/, etc.)
   - No obvious placeholder text (e.g., "TODO", "TBD", "{...}")
   - Links between docs resolve to existing final files under \`${outputPath}/\`
3. Do not add new product claims; restrict yourself to cleanup, link fixes, and removing placeholders/unverifiable remnants.
4. Write a short gate report to \`${intermediateDir}/L9/release_gate_report.md\` with what you changed/fixed.

## Constraints
1. **Scope**: Only modify files under \`.deepwiki/\`.
2. **Incremental Writing**: Use \`applyPatch\` as you go.
3. **Chat Final Response**: One short confirmation line; no file contents.
`,
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

    private async discoverExistingDeepWikis(
        workspaceFolder: vscode.WorkspaceFolder,
        outputPath: string
    ): Promise<Array<{ rootDir: string; deepWikiReadme: string; linkFromGeneratedReadme: string }>> {
        const workspaceRoot = workspaceFolder.uri.fsPath;
        const intermediateDir = `${outputPath}/intermediate`;
        const outputDirFsPath = path.join(workspaceRoot, outputPath);

        const include = new vscode.RelativePattern(workspaceFolder, '**/.deepwiki/README.md');
        const exclude = new vscode.RelativePattern(workspaceFolder, `{**/node_modules/**,**/.git/**,${outputPath}/**}`);
        const matches = await vscode.workspace.findFiles(include, exclude);

        const items: Array<{ rootDir: string; deepWikiReadme: string; linkFromGeneratedReadme: string }> = [];

        for (const uri of matches) {
            const readmeFsPath = uri.fsPath;
            const deepWikiDir = path.dirname(readmeFsPath);
            const rootDirFsPath = path.dirname(deepWikiDir);

            // Exclude the generated output directory itself (e.g., workspaceRoot/.deepwiki).
            if (path.normalize(deepWikiDir) === path.normalize(outputDirFsPath)) continue;

            const rootDir = path.relative(workspaceRoot, rootDirFsPath).replace(/\\/g, '/');
            const deepWikiReadme = path.relative(workspaceRoot, readmeFsPath).replace(/\\/g, '/');
            const linkFromGeneratedReadme = path
                .relative(path.join(workspaceRoot, outputPath), readmeFsPath)
                .replace(/\\/g, '/');
            items.push({ rootDir: rootDir || '.', deepWikiReadme, linkFromGeneratedReadme });
        }

        items.sort((a, b) => a.rootDir.localeCompare(b.rootDir));

        const mdLines: string[] = ['# Existing Nested DeepWikis', ''];
        if (items.length === 0) {
            mdLines.push('- (none)');
        } else {
            mdLines.push(
                'Directories that already contain their own `.deepwiki` docs. Exclude these roots from analysis and only link to their README if needed.'
            );
            mdLines.push('');
            for (const item of items) {
                mdLines.push(`- Root: \`${item.rootDir}\``);
                mdLines.push(`  - README: \`${item.deepWikiReadme}\``);
                mdLines.push(`  - LinkFromGeneratedREADME: \`${item.linkFromGeneratedReadme}\``);
            }
        }
        mdLines.push('');

        const mdPath = path.join(workspaceRoot, intermediateDir, 'L1', 'existing_deepwikis.md');
        const jsonPath = path.join(workspaceRoot, intermediateDir, 'L1', 'existing_deepwikis.json');
        await vscode.workspace.fs.writeFile(vscode.Uri.file(mdPath), new TextEncoder().encode(mdLines.join('\n')));
        await vscode.workspace.fs.writeFile(vscode.Uri.file(jsonPath), new TextEncoder().encode(JSON.stringify(items, null, 2) + '\n'));

        return items;
    }

}
