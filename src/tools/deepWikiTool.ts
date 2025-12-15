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
        const startFromStage = options.input.startFromStage || 'L1';
        return {
            invocationMessage: 'Initializing DeepWiki Component Pipeline...',
            confirmationMessages: {
                title: 'Generate DeepWiki',
                message: new vscode.MarkdownString(
                    'Start the DeepWiki generation pipeline?\n\n' +
                    `This will analyze your workspace by **Components** and generate documentation in \`${outputPath}\`.\n\n` +
                    `Start from stage: \`${startFromStage}\`${startFromStage === 'L1' ? '' : ' (resume; earlier stages are skipped and existing artifacts are reused)'}.`
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
        const stageOrder = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9'] as const;
        type Stage = typeof stageOrder[number];
        const startFromStageRaw = String(params.startFromStage || 'L1').toUpperCase();
        const startFromStage: Stage = (stageOrder as readonly string[]).includes(startFromStageRaw)
            ? (startFromStageRaw as Stage)
            : 'L1';
        const startStageIndex = stageOrder.indexOf(startFromStage);
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

        if (!workspaceFolder) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Error: No workspace folder open.')
            ]);
        }



        const intermediateDir = `${outputPath}/intermediate`;
        logger.log('DeepWiki', 'Starting Component-Based Pipeline...');
        if (startFromStage !== 'L1') {
            logger.log('DeepWiki', `Resume mode: starting from stage ${startFromStage} (skipping earlier stages)`);
        }

        // Helper to check for cancellation and throw if requested
        const checkCancellation = () => {
            if (token.isCancellationRequested) {
                logger.warn('DeepWiki', 'Pipeline cancelled by user');
                throw new vscode.CancellationError();
            }
        };

        // Check for cancellation before starting
        checkCancellation();

        // Clean up previous output only on full runs (L1 start).
        if (startFromStage === 'L1') {
            await this.cleanOutputDirectory(workspaceFolder, outputPath);
        } else {
            logger.log('DeepWiki', `Skipping cleanup (resume mode; startFromStage=${startFromStage})`);
        }


	        // Function to generate pipeline overview with current stage highlighted
	        const getPipelineOverview = (currentStage: string) => `
	## Pipeline Overview (short)
	L1 Context${currentStage === 'L1' ? ' ← YOU' : ''} → L2 Discover (A/B/C)${currentStage.startsWith('L2') ? ' ← YOU' : ''} → L3 Analyze${currentStage === 'L3' ? ' ← YOU' : ''} → L3-V Validate${currentStage === 'L3V' ? ' ← YOU' : ''} → L3-R Review${currentStage === 'L3R' ? ' ← YOU' : ''} → L4 Architect${currentStage === 'L4' ? ' ← YOU' : ''} → L5 Pages (1:1)${currentStage === 'L5' ? ' ← YOU' : ''} → L5-V Validate${currentStage === 'L5V' ? ' ← YOU' : ''} → L6 Review${currentStage === 'L6' ? ' ← YOU' : ''} → L7 Indexer${currentStage === 'L7' ? ' ← YOU' : ''} → L8 QA (README)${currentStage === 'L8' ? ' ← YOU' : ''} → L9 QA (Release Gate)${currentStage === 'L9' ? ' ← YOU' : ''}
	(Write artifacts under \`.deepwiki/\`; do not touch other files.)
	`;


        const bq = '`';
        const mdCodeBlock = bq + bq + bq;
        const sanitizeToolNameForPrompt = (value: string) =>
            value
                .replace(/[`]/g, '')
                .replace(/[\r\n\t]/g, ' ')
                .trim()
                .slice(0, 80);

        const editToolNameForPrompt = sanitizeToolNameForPrompt(params.fileEditToolName ?? '');
        if (editToolNameForPrompt.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    'Error: `fileEditToolName` is required. Please provide the available file-edit tool name for subagents (e.g., "apply_patch" or "replace_string_in_file").'
                ),
            ]);
        }

        // Define ComponentDef interface globally within invoke scope
        interface ComponentDef { name: string; files: string[]; description: string }
        interface PageGroup { pageName: string; components: string[]; rationale: string }

        const requireFile = async (relativePathFromWorkspace: string): Promise<void> => {
            const uri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, relativePathFromWorkspace));
            await vscode.workspace.fs.stat(uri);
        };

        const requireAnyFileMatch = async (glob: string): Promise<void> => {
            const pattern = new vscode.RelativePattern(workspaceFolder, glob);
            const files = await vscode.workspace.findFiles(pattern);
            if (files.length === 0) {
                throw new Error(`Missing required artifacts: no files match "${glob}"`);
            }
        };

        try {
            // Pre-create intermediate level directories so all phases can reliably write artifacts.
            for (const level of ['L1', 'L2', 'L3', 'L3V', 'L3R', 'L4', 'L5', 'L5V', 'L6', 'L7', 'L8', 'L9']) {
                const dirUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, intermediateDir, level));
                await vscode.workspace.fs.createDirectory(dirUri);
            }

            // Resume prerequisites (only for stages we are skipping).
            if (startFromStage === 'L2') {
                await requireFile(path.join(intermediateDir, 'L1', 'project_context.md'));
            }
            if (startStageIndex >= stageOrder.indexOf('L3')) {
                await requireFile(path.join(intermediateDir, 'L2', 'component_list.json'));
            }
            if (startFromStage === 'L4') {
                await requireAnyFileMatch(`${intermediateDir}/L3/*_analysis.md`);
            }
            if (startStageIndex >= stageOrder.indexOf('L5')) {
                await requireFile(path.join(intermediateDir, 'L4', 'overview.md'));
                await requireFile(path.join(intermediateDir, 'L4', 'relationships.md'));
            }
            if (startStageIndex >= stageOrder.indexOf('L6')) {
                await requireFile(path.join(intermediateDir, 'L5', 'page_structure.json'));
                await requireAnyFileMatch(`${outputPath}/pages/*.md`);
            }
            if (startStageIndex >= stageOrder.indexOf('L7')) {
                // Prefer L5 grouping artifact for stable README TOC/diagrams.
                // If missing (e.g., older runs), the Indexer will fall back to generating it.
                try {
                    await requireFile(path.join(intermediateDir, 'L5', 'page_groups.json'));
                } catch {
                    // ignore
                }
            }
            if (startStageIndex >= stageOrder.indexOf('L8')) {
                await requireFile(path.join(outputPath, 'README.md'));
            }

            const existingDeepWikis =
                startStageIndex <= stageOrder.indexOf('L7')
                    ? await this.discoverExistingDeepWikis(workspaceFolder, outputPath)
                    : [];
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
            if (startFromStage === 'L1') {
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
3. **Incremental Writing**: Write section-by-section with \`${editToolNameForPrompt}\`.

` + getPipelineOverview('L1'),
                    token,
                    options.toolInvocationToken
                );
            }

            // ==================================================================================
            // PHASE 1: DISCOVERY & EXTRACTION (The Foundation)
            // These phases run once to establish the baseline.
            // ==================================================================================

            // ---------------------------------------------------------
            // Level 1-A: COMPONENT DRAFTER
            // ---------------------------------------------------------
            let componentList: ComponentDef[] = [];
            const jsonExample = `
[
  {
    "name": "Auth Module", 
    "files": ["src/auth/auth.controller.ts", "src/auth/auth.service.ts"], 
    "description": "Handles user authentication"
  }
]
`;
            if (startStageIndex <= stageOrder.indexOf('L2')) {
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
4. **Naming**: Use filename-safe component names (no \`/\`, no leading/trailing spaces). Use \`_\` as a separator, e.g. \`Editor_Core\`, \`Configuration_System\` (NOT \`Editor/Core\`).
5. **JSON Strictness**: Output must be a single JSON array (starts with \`[\` and ends with \`]\`), no trailing commas, no comments.

` + getPipelineOverview('L2-A'),
                    token,
                    options.toolInvocationToken
                );

                // Loop for Review & Refine
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
4. **Naming**: Component \`name\` values must be filename-safe (no \`/\`). Use \`_\` as a separator, e.g. \`Editor_Core\`, \`Configuration_System\` (NOT \`Editor/Core\`). Rename any component that violates this.

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
            } else {
                // Resume mode: reuse existing L2 output
                const fileListUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L2', 'component_list.json'));
                const fileListContent = await vscode.workspace.fs.readFile(fileListUri);
                const contentStr = new TextDecoder().decode(fileListContent);
                componentList = this.parseJson<ComponentDef[]>(contentStr);
                if (!Array.isArray(componentList) || componentList.length === 0) {
                    throw new Error('Resume failed: component_list.json is missing or empty. Start from L2 or L1.');
                }
                logger.log('DeepWiki', `Resume: Loaded ${componentList.length} logical components from L2 output.`);
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

            type LoopStart = 'L3' | 'L4' | 'L5' | 'L6';
            const loopStart: LoopStart =
                startFromStage === 'L4'
                    ? 'L4'
                    : startFromStage === 'L5'
                        ? 'L5'
                        : startFromStage === 'L6'
                            ? 'L6'
                            : 'L3';

            // Resume mode starting at L7+ skips the analysis/writing loop entirely.
            if (startStageIndex >= stageOrder.indexOf('L7')) {
                componentsToAnalyze = [];
                try {
                    const pageStructureUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L5', 'page_structure.json'));
                    const content = await vscode.workspace.fs.readFile(pageStructureUri);
                    finalPageCount = this.parseJson<PageGroup[]>(new TextDecoder().decode(content)).length;
                } catch {
                    finalPageCount = 0;
                }
            }

            while (componentsToAnalyze.length > 0 && loopCount < MAX_LOOPS) {
                logger.log('DeepWiki', `>>> Starting Analysis/Writing Loop ${loopCount + 1}/${MAX_LOOPS} with ${componentsToAnalyze.length} components...`);

                const firstLoop = loopCount === 0;
                const initialSkipTo: LoopStart = firstLoop ? loopStart : 'L3';
                const runL3Stages = initialSkipTo === 'L3';
                const runL4Stage = initialSkipTo === 'L3' || initialSkipTo === 'L4';
                const runL5Stages = initialSkipTo === 'L3' || initialSkipTo === 'L4' || initialSkipTo === 'L5';

                // Filter chunks to only include componentsToAnalyze
                // The chunking logic here is simplified. L3/L5 should be able to handle individual component analysis.
                // For a more robust solution, L3/L5 should accept an array of component names rather than a chunk.
                // For now, we'll re-chunk the componentsToAnalyze.

                const componentsForThisLoop = componentsToAnalyze.map(c => c.name);

                if (runL3Stages) {
                // ---------------------------------------------------------
                // Level 3: ANALYZER (Process current components - 1 component per task)
                // ---------------------------------------------------------
                // Task generator function for L3 analysis (shared by initial and retry)
                const createL3Task = (component: ComponentDef) => {
                    const componentStr = JSON.stringify(component);
                    const originalIndex = componentList.findIndex(c => c.name === component.name);
                    const paddedIndex = String(originalIndex + 1).padStart(3, '0');
                    const analysisFileUri = vscode.Uri.file(
                        path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L3', `${paddedIndex}_${component.name}_analysis.md`)
                    );
                    return () => this.runPhase(
                        `L3: Analyzer (Loop ${loopCount + 1}, ${component.name})`,
                        `Analyze component`,
                        `# Analyzer Agent (L3)

## Role
- **Your Stage**: L3 Analyzer (Analysis Loop - may retry up to 5 times)
- **Core Responsibility**: Deep analysis - understand HOW code works, trace event/state causality, create diagrams
- **Critical Success Factor**: L4 and L5 depend on your analysis - be thorough and accurate

## Reasoning Style (Priority)
- **Causal-chain-first**: Prioritize explaining causality over summarization.
- Keep the write-up grounded in the assigned source files (use real function/class/event names and file paths as anchors).

## Depth Targets (Write More Than a Summary)
Your output must be detailed enough that L4 can reconstruct architecture and relationships without re-reading source code.

- Include **at least 10 concrete anchors** in the form \`path/to/file.ts::SymbolName\` (functions, classes, events, commands, services, config keys).
- Include **2–4 critical end-to-end flows** with step-by-step call/event sequences (what triggers it → what runs → what state changes → what observable effect).
- Include **edge cases / failure modes** (at least 5 bullets) that are visible in code paths (validation, fallbacks, cancellation, retries, platform differences).
- Write **at least 12 Claims→Evidence→Implication (CEI) blocks** across the document. Each CEI block must include **≥ 2 Evidence anchors**.
- Prefer specifics over generalities; if you can't justify a claim from code, omit it.

## Claims → Evidence → Implication (CEI) Format (MANDATORY)
Write key statements as CEI blocks so downstream stages can verify and reuse them.

Use this exact bullet structure:
- Claim: ...
  - Evidence: \`path/to/file.ts::SymbolName\` — why this supports the claim
  - Evidence: \`path/to/file.ts::OtherSymbol\` — why this supports the claim
  - Implication: what this means for behavior/architecture/integration (no speculation)

## Input
- **Assigned Component**: ${componentStr}
- **Source Code Files**: The original source files listed in the component

## Workflow
1. Create empty file \`${intermediateDir}/L3/${paddedIndex}_${component.name}_analysis.md\`
2. Read source code files for this component
3. Token-stability workflow (do NOT write all at once):
   - Use \`${editToolNameForPrompt}\` after EACH section.
   - Prefer short bullets/tables over long paragraphs.
   - If you are running out of space, stop adding narrative first; do NOT drop CEI anchors.
   - Keep each \`${editToolNameForPrompt}\` small (aim: one section at a time; avoid huge single patches).
4. Priority order (highest → lowest):
   1) CEI blocks (with evidence anchors) → 2) Diagrams → 3) Critical flows → 4) Narrative summary
5. For each analysis section: Analyze → Use \`${editToolNameForPrompt}\` to write
   - Overview and Architecture
   - Key Logic
   - **Causal Analysis** (see below)
   - Edge Cases & Failure Modes
   - Integration Points & Dependencies
6. Create Mermaid diagrams → Use \`${editToolNameForPrompt}\` to write
   - **Recommended**: \`stateDiagram-v2\` (for state causality), \`sequenceDiagram\` (for event flow), \`C4Context\`, \`classDiagram\`, \`block\`
   - **Forbidden**: \`flowchart\`, \`graph TD\`

## Causal Analysis Requirements
Analyze the source code and document:

### Event Causality
- **Event Chain**: Trace how events propagate (e.g., "User clicks button → \`click\` event → \`handleClick()\` → emits \`data.updated\` → \`onDataUpdated()\` triggers")
- **Event Sources**: Where do events originate? (user actions, timers, external APIs)
- **Event Consumers**: Who listens and what do they do?

### State Causality
- **State Dependencies**: Which states depend on other states? (e.g., "\`isLoading\` must be false before \`data\` can be set")
- **Mutation Triggers**: What causes state changes? (events, function calls, lifecycle hooks)
- **Downstream Effects**: What happens when state X changes? (UI re-renders, side effects, other state updates)

### Causal Diagram
Create a \`stateDiagram-v2\` showing state transitions with event triggers:
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
Write Markdown to \`${intermediateDir}/L3/${paddedIndex}_${component.name}_analysis.md\` using this structure (example only; do not wrap the whole file in fences):
${mdCodeBlock}markdown
# ${component.name} - Analysis

## File Structure
- ...

## Overview and Architecture
- ...

## Key Logic

### Key Types & APIs
| Symbol | Location | Responsibility |
|--------|----------|----------------|
| ... | ... | ... |

### Critical Flows
1. ...
2. ...

### CEI Blocks (Key Logic)
- Claim: ...
  - Evidence: \`...\`
  - Evidence: \`...\`
  - Implication: ...

## Causal Analysis

### Event Causality
- ...

### State Causality
- ...

### CEI Blocks (Causality)
- Claim: ...
  - Evidence: \`...\`
  - Evidence: \`...\`
  - Implication: ...

## Edge Cases & Failure Modes
- ...

## Integration Points & Dependencies
- Upstream callers/triggers: ...
- Downstream consumers/effects: ...
- Contracts (events/services/commands/config keys): ...

## Diagrams
${mdCodeBlock}mermaid
stateDiagram-v2
    [*] --> Idle
${mdCodeBlock}
${mdCodeBlock}
- Do not wrap the entire file in Markdown fences.
- Mermaid diagrams must be in \`\`\`mermaid fences.
- Avoid large raw code pastes; reference symbols/paths instead.

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.
3. **Incremental Writing**: Use \`${editToolNameForPrompt}\` after each instruction step. Due to token limits, writing all at once risks data loss.

` + getPipelineOverview('L3'),
                        token,
                        options.toolInvocationToken,
                        [analysisFileUri]
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
Quality gate for L3 outputs: ensure expected analysis files exist and are structurally rich enough to support L4/L5 without re-reading source code.

## Expected Files
Directory: \`${intermediateDir}/L3/\`
Files to verify:
${l3ExpectedFiles.map(f => `- \`${f.file}\` (Component: ${f.name})`).join('\n')}

## Workflow
1. List files in \`${intermediateDir}/L3/\`
2. Compare against expected files above and identify missing files
3. For each PRESENT file, run these checks and record pass/fail per component:
   - **Required headings present**:
     - \`## File Structure\`
     - \`## Overview and Architecture\`
     - \`## Key Logic\`
     - \`## Causal Analysis\`
     - \`## Edge Cases & Failure Modes\`
     - \`## Integration Points & Dependencies\`
     - \`## Diagrams\`
   - **CEI density**:
     - Count occurrences of \`- Claim:\` (must be \`>= 12\`)
     - Count occurrences of \`- Evidence:\` (must be \`>= 24\`)
     - Evidence anchors must include \`::\` (e.g., \`path/to/file.ts::Symbol\`)
   - **Anchor density**:
     - At least 10 concrete anchors in backticks matching \`*::*\` (e.g., \`path/to/file.ts::Symbol\`)
   - **Diagram presence**:
     - At least one Mermaid fence \`\`\`mermaid
     - Mermaid content includes \`stateDiagram-v2\`
   - **No obvious placeholders**:
     - Reject if it still contains \`TODO\`, \`TBD\`, \`{...}\`, or repeated \`- ...\` placeholders as the majority of content.
4. Always write a short report to \`${intermediateDir}/L3V/validation_report.md\`:
   - Missing components
   - Components that failed checks (which check failed, and observed counts)
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
                }

                // ---------------------------------------------------------
                // Level 4: ARCHITECT (Runs in every loop to keep overview up to date)
                // Input: All L3 analysis files (even from previous loops)
                // ---------------------------------------------------------
                if (runL4Stage) {
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
2. Source verification (mandatory):
   - For at least 10 key claims you plan to include in L4, open the referenced source files and verify the claim is consistent with the code.
   - If a claim cannot be confirmed from source, either delete it or rephrase it into a narrower, verifiable statement.
3. Write \`${intermediateDir}/L4/overview.md\`:
   - high-level architecture, major components, rationale ("why this shape?")
4. Write \`${intermediateDir}/L4/relationships.md\`:
   - cross-component event/state causality map
   - include diagrams (see below)
5. Quick self-check: overview matches L3 facts; diagrams render; no raw code pasted.

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
3. **Incremental Writing**: Write section-by-section with \`${editToolNameForPrompt}\`.

` + getPipelineOverview('L4'),
                    token,
                    options.toolInvocationToken
                );
                }

                // ---------------------------------------------------------
                // Level 5: PAGE STRUCTURE (deterministic 1:1 mapping)
                // ---------------------------------------------------------
                // The wiki pages are intentionally kept at a stable granularity:
                // one generated page per discovered component.
                //
                // L5 is responsible for:
                // 1) writing `page_structure.json` (this deterministic mapping)
                // 2) grouping pages for README navigation (`page_groups.json`, via the L5-G subagent)
                if (runL5Stages) {
                let pageStructure: PageGroup[] = [];
                pageStructure = componentsForThisLoop.map(componentName => ({
                    pageName: componentName,
                    components: [componentName],
                    rationale: '1:1 mapping: component page'
                }));

                const pageStructureUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L5', 'page_structure.json'));
                await vscode.workspace.fs.writeFile(pageStructureUri, Buffer.from(JSON.stringify(pageStructure, null, 2)));
                finalPageCount = pageStructure.length;
                logger.log('DeepWiki', `L5 Page Structure: ${componentsForThisLoop.length} components -> ${pageStructure.length} pages (1:1 mapping)`);

                // ---------------------------------------------------------
                // Level 5-G: PAGE GROUPER (for README TOC & diagrams)
                // ---------------------------------------------------------
                const pageGroupsExample = `
[
  {
    "groupName": "Authentication",
    "pages": ["Authentication", "Authorization"],
    "rationale": "User identity, permissions, and auth flows"
  },
  {
    "groupName": "Infrastructure",
    "pages": ["Configuration", "Logging"],
    "rationale": "Cross-cutting runtime infrastructure"
  }
]
`;

                await this.runPhase(
                    `L5-G: Page Grouper (Loop ${loopCount + 1})`,
                    'Group pages for README navigation',
                    `# Page Grouper Agent (L5-G)

## Role
- **Your Stage**: L5-G Page Grouper (Information Architecture for README)
- **Core Responsibility**: Create stable, reader-friendly groups of pages for the README TOC and diagrams.

## Goal
Group the generated pages (pageName values) into 3–8 groups so the README navigation and diagrams don't drift.

## Input
- Page structure (source of truth): \`${intermediateDir}/L5/page_structure.json\`
- L4 overview/relationships (optional signal for clustering):
  - \`${intermediateDir}/L4/overview.md\`
  - \`${intermediateDir}/L4/relationships.md\`

## Workflow
1. Read \`${intermediateDir}/L5/page_structure.json\` and collect the full set of pageName values.
2. Create 3–8 groups with clear, human-friendly names (avoid overly generic names like "Misc" unless unavoidable).
3. Assign EVERY pageName to exactly one group.
4. Keep groups balanced; avoid single-page groups unless that page is truly standalone/important.
5. Provide a short rationale per group.

## Output
Write FINAL **RAW JSON (no fences)** to \`${intermediateDir}/L5/page_groups.json\`.

**Format example (do not include fences in the file)**:
${mdCodeBlock}json
${pageGroupsExample}
${mdCodeBlock}

## Constraints
1. Output must be a single valid JSON array.
2. Each \`pages\` item must be an exact pageName from \`${intermediateDir}/L5/page_structure.json\` (no \`.md\` suffix).
3. Every page must appear exactly once across all groups (no missing/duplicates).
4. **Scope**: Only write under \`.deepwiki/\`.
5. **Chat Final Response**: One short confirmation line; no file contents.

` + getPipelineOverview('L5'),
                    token,
                    options.toolInvocationToken
                );

                // ---------------------------------------------------------
                // Level 5: WRITER (Process pages based on page_structure.json)
                // ---------------------------------------------------------
                const pageTemplate = `
> **Note**: This documentation was auto-generated by an LLM. While we strive for accuracy, please refer to the source code for authoritative information.

# {PageName}

## Summary
{Description of what this page covers}

### Claims
- Claim: ...
- Claim: ...

### Evidence (Anchors)
- [\`path/to/file.ts\`](/path/to/file.ts)::Symbol — supports summary claim X
- [\`path/to/file.ts\`](/path/to/file.ts)::Symbol — supports summary claim Y

## Use Cases
{Description of how and when to use these components}

### Claims
- Claim: ...
- Claim: ...

### Evidence (Anchors)
- [\`path/to/file.ts\`](/path/to/file.ts)::Symbol — supports use case claim X

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

### Claims
- Claim: ...
- Claim: ...

### Claims → Evidence → Implication (CEI)
- Claim: ...
  - Evidence: [\`path/to/file.ts\`](/path/to/file.ts)::Symbol — why this supports the claim
  - Evidence: [\`path/to/file.ts\`](/path/to/file.ts)::OtherSymbol — why this supports the claim
  - Implication: what this means for behavior/architecture/integration

### Element-Level Mechanics (when applicable)
If you split "Internal Mechanics Details" into multiple elements (e.g., components/modules/services), use subsections like:

#### {ElementName}
##### Use Cases
- {When/why to use this element}
- {Common workflows involving it}
- {When NOT to use it / pitfalls}

##### Mechanics
{Element-specific causal flow: triggers → state/data changes → side effects}

${mdCodeBlock}mermaid
%% REQUIRED for each element subsection: stateDiagram-v2 showing this element's state transitions (include triggers/conditions on edges).
stateDiagram-v2
    [*] --> ...
${mdCodeBlock}

##### Evidence (Anchors)
- [\`path/to/file.ts\`](/path/to/file.ts)::Symbol — supports this element’s mechanics claim

## External Interface
{Describe how other modules interact with these components. List public methods, props, and events.}

### Claims
- Claim: ...
- Claim: ...

### Evidence (Anchors)
- [\`path/to/file.ts\`](/path/to/file.ts)::Symbol — supports external interface claim X
	`; // The template ends here
                // Task generator function for L5 writing (shared by initial and retry)
                const createL5Task = (pageChunk: PageGroup[]) => {
                    const pageUris = pageChunk.map((p) =>
                        vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, outputPath, 'pages', `${p.pageName}.md`))
                    );
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
3. Synthesize and consolidate L3 content into a reader-friendly page.
   - You MAY read source code files to verify claims and evidence anchors, but do NOT perform a fresh full analysis beyond what is needed to validate correctness.
4. Iterate through sections (Architecture, Mechanics, Interface): Synthesize content → Use \`${editToolNameForPrompt}\` to write immediately
5. Generate an ASCII tree of ALL files from ALL components in this page → Use \`${editToolNameForPrompt}\` to write
6. **Grounding requirement**: Do NOT add new claims beyond what is supported by L3; if unsure, omit the claim rather than guessing. Ensure the "File Structure" section lists all component source files (it will be used for verification).
7. If present, read validator feedback for your page(s) and apply it:
   - \`${intermediateDir}/L5V/evidence_feedback_{pageName}.md\`
   - Remove/rewrite unsupported claims and add missing evidence anchors.
8. Token-stability workflow:
   - Use \`${editToolNameForPrompt}\` after EACH major section.
   - If you are running out of space, keep \`### Claims\` and \`### Evidence (Anchors)\` first; reduce narrative text.
   - Keep each \`${editToolNameForPrompt}\` small (aim: one section at a time; avoid huge single patches).

**Consolidation Guidelines**:
- If a page has multiple components, weave their descriptions together
- Identify shared concepts and present them once, not repeatedly
- Show how the components within the page interact with each other
- The page should read as a unified document, not separate sections glued together

**Causal Explanation**:
When describing Internal Mechanics, explain the CAUSAL FLOW (e.g., "Because X happens, Y triggers Z").

**Claims (MUST USE \`- Claim:\` LINES)**:
- Every major section must include a \`### Claims\` subsection with \`- Claim:\` lines.
- L5-V will ONLY validate claims that appear on \`- Claim:\` lines. Any important statement not written as a claim line may be deleted as unsupported.

**Claims → Evidence → Implication (CEI)**:
For key mechanics (especially "## Internal Mechanics Details"), add a short CEI list:
- Claim: ...
  - Evidence: \`path/to/file.ts::Symbol\` — why this supports the claim
  - Evidence: \`path/to/file.ts::OtherSymbol\` — why this supports the claim
  - Implication: what this means for behavior/architecture/integration

**Evidence Anchors**:
For every major section, include a "### Evidence (Anchors)" subsection with concrete \`path::Symbol\` anchors.
These anchors must be verifiable in the page’s components’ L3 analyses. If you cannot provide verifiable anchors, DELETE or narrow the claim.

**Source Links (Allowed)**:
- You MAY include Markdown links to source files, preferably repo-root relative (GitHub-style), e.g. \`[\`src/foo.ts\`](/src/foo.ts)\`.
- Do NOT link to intermediate artifacts (\`intermediate/\`, \`../L3/\`, etc.).

**Element-Level State Diagrams**:
If you split "## Internal Mechanics Details" into element subsections (e.g., \`### Auth Service\`, \`### Session Store\`), include a **stateDiagram-v2 in EACH element subsection**. If an element is effectively stateless, use a trivial state diagram (e.g., a single "Stateless" state) and briefly explain why.

**Element-Level Use Cases**:
If you split "## Internal Mechanics Details" into element subsections, include a short use case explanation inside each element subsection (under "##### Use Cases").

### Template
` + pageTemplate + `

## Output
Write files to \`${outputPath}/pages/\`.

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.
3. **Incremental Writing**: Use \`${editToolNameForPrompt}\` after each instruction step. Due to token limits, writing all at once risks data loss.
4. **Do NOT include raw source code or implementation details.**
5. **Strictly separate External Interface from Internal Mechanics.** Use tables for API references. If you include signatures, keep them short (no bodies).
6. **No Intermediate Links**: Do NOT include links to intermediate analysis files (e.g., intermediate/L3/, ../L3/, ../L4/). Only reference other pages via their final page files in \`pages/\` directory. If filenames contain spaces, wrap link targets in angle brackets, e.g. \`[Page Name](<Page Name.md>)\`.

` + getPipelineOverview('L5'),
                        token,
                        options.toolInvocationToken,
                        pageUris
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
Quality gate for L5 outputs: ensure expected page files exist AND that claims are grounded in L3 via evidence anchors.

## Expected Files
Directory: \`${outputPath}/pages/\`
Files to verify:
${l5ExpectedPages.map(p => `- \`${p.file}\` (Page: ${p.pageName})`).join('\n')}

## Workflow
1. List files in \`${outputPath}/pages/\`
2. Compare against expected files above
3. If ALL files exist → Write empty array to \`${intermediateDir}/L5V/page_validation_failures.json\`
4. If ANY files are MISSING → Write JSON array of missing page names to \`${intermediateDir}/L5V/page_validation_failures.json\`
5. Evidence grounding (reverse synthesis):
   - Read \`${intermediateDir}/L5/page_structure.json\` to map pages → components.
   - For each page, read the relevant L3 analysis files for its components in \`${intermediateDir}/L3/\`.
   - Read the page Markdown and extract ONLY lines that start with \`- Claim:\` (ignore all other text for claim extraction).
   - Associate each claim with its nearest preceding section heading (e.g., Summary / Use Cases / Internal Mechanics Details / External Interface).
   - For each extracted claim, find support in L3 and record at least 2 evidence anchors in the form \`path/to/file.ts::SymbolName\`.
   - Source verification (mandatory):
     - For each evidence anchor’s file path, confirm the file exists in the workspace.
     - Spot-check that the referenced symbol name appears in that file (string match is acceptable).
   - If a claim cannot be supported, mark it as unsupported.
   - Ensure each major section contains a "### Evidence (Anchors)" subsection. If missing, treat as a failure.
   - Ensure each major section contains a "### Claims" subsection with \`- Claim:\` lines. If missing or empty, treat as a failure.
6. Write an evidence map to \`${intermediateDir}/L5V/evidence_map.json\` as RAW JSON (no fences).
7. For any page with unsupported claims or missing evidence sections:
   - Write feedback to \`${intermediateDir}/L5V/evidence_feedback_{pageName}.md\` describing what to delete/rewrite and which anchors are required.
   - Add that pageName to \`${intermediateDir}/L5V/evidence_validation_failures.json\` (raw JSON array of page names; no fences).
8. If all pages are supported and evidence sections are present, write \`[]\` to \`${intermediateDir}/L5V/evidence_validation_failures.json\`.

## Output
Write to \`${intermediateDir}/L5V/page_validation_failures.json\`:
- If all present: \`[]\`
- If missing: \`["Page A", "Page B"]\`

Write to \`${intermediateDir}/L5V/evidence_map.json\` (RAW JSON; no fences). This is an intermediate artifact; it may reference L3 files.
- Array of objects:
  - \`pageName\`
  - \`section\`
  - \`claim\`
  - \`verdict\`: \`"supported" | "weak" | "unsupported"\`
  - \`evidence\`: array of objects:
    - \`l3File\`: string (e.g. \`001_Component_analysis.md\`)
    - \`anchor\`: string (\`path::Symbol\`)

Write to \`${intermediateDir}/L5V/evidence_validation_failures.json\`:
- If all supported: \`[]\`
- If failures: \`["Page A", "Page B"]\`

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

                const l5EvidenceFailuresUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L5V', 'evidence_validation_failures.json'));
                let l5EvidenceFailedPages: string[] = [];
                try {
                    const content = await vscode.workspace.fs.readFile(l5EvidenceFailuresUri);
                    l5EvidenceFailedPages = this.parseJson<string[]>(new TextDecoder().decode(content));
                    await vscode.workspace.fs.delete(l5EvidenceFailuresUri);
                } catch { /* no failures file or invalid */ }

                const l5RetryPages = Array.from(new Set([...l5FailedPages, ...l5EvidenceFailedPages]));
                if (l5RetryPages.length > 0) {
                    logger.log('DeepWiki', `L5 Validator requested retry for ${l5RetryPages.length} page(s): ${l5RetryPages.join(', ')}`);
                    // Retry using the same task generator function
                    const failedPageStructure = pageStructure.filter(p => l5RetryPages.includes(p.pageName));
                    const retryPageChunks: PageGroup[][] = [];
                    for (let i = 0; i < failedPageStructure.length; i += pageChunkSize) {
                        retryPageChunks.push(failedPageStructure.slice(i, i + pageChunkSize));
                    }
                    const l5RetryTasks = retryPageChunks.map(createL5Task);
                    await runWithConcurrencyLimit(l5RetryTasks, DEFAULT_MAX_CONCURRENCY, `L5 Retry (Loop ${loopCount + 1})`, token);
                }
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
- Read evidence mapping (reverse synthesis), if present: \`${intermediateDir}/L5V/evidence_map.json\`

## Workflow
1. **Inventory**: Read \`${intermediateDir}/L5/page_structure.json\` and ensure every expected page exists under \`${outputPath}/pages/\`.
2. For EACH page:
   - **File Structure**: Ensure the "File Structure" section includes an accurate list of source files (populate it from \`${intermediateDir}/L2/component_list.json\`; remove any non-existent paths).
   - **No placeholders**: Remove/replace obvious placeholders (e.g., "TODO", "TBD", "{...}").
   - **Element-level use cases**: If "## Internal Mechanics Details" is split into multiple element subsections, ensure EACH element subsection includes a concrete use case explanation (why/when to use it, pitfalls).
   - **Element-level diagrams**: If "## Internal Mechanics Details" is split into multiple element subsections, ensure EACH element subsection includes a \`stateDiagram-v2\` describing that element's state transitions (trivial single-state diagram is acceptable for stateless elements).
   - **Accuracy**: Verify statements against ACTUAL SOURCE CODE using the file list in "File Structure" (and \`${intermediateDir}/L2/component_list.json\`) as the starting set. If a statement cannot be verified, DELETE the smallest possible block (sentence/row) rather than guessing.
   - **Evidence Map Gate**: If \`${intermediateDir}/L5V/evidence_map.json\` marks a claim as \`unsupported\`, DELETE or rewrite that claim so it becomes supported (do not keep unsupported claims).
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
3. **Incremental Writing**: Use \`${editToolNameForPrompt}\` after each instruction step. Due to token limits, writing all at once risks data loss.

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
            if (startStageIndex <= stageOrder.indexOf('L7')) {
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
- \`${intermediateDir}/L5/page_groups.json\` (source of truth for README grouping; created by L5-G)
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

### 2. Components
Use \`${intermediateDir}/L5/page_groups.json\` to group the TOC.
For EACH group:
- Print a short group heading and (optionally) the group's rationale.
- Under it, list each page in that group as:
  - Link: If filename has no spaces: \`[PageName](pages/PageName.md)\`; if it has spaces: \`[PageName](<pages/Page Name.md>)\`
  - One-line description using the page_structure rationale for that page.

### 2.5 Existing DeepWikis (optional)
If \`${intermediateDir}/L1/existing_deepwikis.md\` is not "(none)", add a short section listing links to those existing docs (link to their \`.deepwiki/README.md\` only; do not summarize their internals).

### 3. Quick self-check
- Both diagrams present and render.
- Components list matches page_structure exactly.
- Grouped TOC matches page_groups exactly.
- No links to intermediate files.

## Output
1. Write Markdown to \`${outputPath}/README.md\` (no fences around the whole file).
2. Write a short build log to \`${intermediateDir}/L7/indexer_report.md\` (what you changed/validated; keep it brief).

## Constraints
1. **Scope**: Only write under \`.deepwiki/\`. Read source code as needed.
2. **Chat Final Response**: One short confirmation line. Do not include file contents.
3. **Incremental Writing**: Write section-by-section with \`${editToolNameForPrompt}\`.
4. **Sanitize Intermediate Links**: Never link to intermediate paths; only to final pages.
5. **Synthesize, Don't Dump**: Summarize and connect; do not copy L4 verbatim.

` + getPipelineOverview('L7'),
                    token,
                    options.toolInvocationToken
                );
            }

            // ---------------------------------------------------------
            // Final QA: README verifier (avoid duplicating L6 page review loop)
            // ---------------------------------------------------------
            if (startStageIndex <= stageOrder.indexOf('L8')) {
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
3. **Incremental Writing**: Use \`${editToolNameForPrompt}\` as you go.
4. **Chat Final Response**: One short confirmation line; no file contents.
`,
                    token,
                    options.toolInvocationToken
                );
            }

            // ---------------------------------------------------------
            // Final QA: Release Gate
            // ---------------------------------------------------------
            if (startStageIndex <= stageOrder.indexOf('L9')) {
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
2. **Incremental Writing**: Use \`${editToolNameForPrompt}\` as you go.
3. **Chat Final Response**: One short confirmation line; no file contents.
`,
                    token,
                    options.toolInvocationToken
                );
            }

            if (finalPageCount === 0) {
                try {
                    const pageStructureUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L5', 'page_structure.json'));
                    const content = await vscode.workspace.fs.readFile(pageStructureUri);
                    finalPageCount = this.parseJson<PageGroup[]>(new TextDecoder().decode(content)).length;
                } catch {
                    // ignore
                }
            }

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
        toolInvocationToken: vscode.ChatParticipantToolToken | undefined,
        cleanupUrisOnRequestFailed?: vscode.Uri[]
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
            let resultText = '';
            for (const part of result.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    if (resultPreview === '') {
                        resultPreview = part.value.substring(0, 150).replace(/\n/g, ' ');
                    }
                    resultText += part.value + '\n';
                }
            }

            // Some subagent failures are reported as plain text. If we see a known marker phrase,
            // delete the expected output files so downstream validators will retry cleanly.
            if (/(your request failed|hit the length limit|there was a network error)/i.test(resultText)) {
                logger.warn('DeepWiki', `Subagent reported request failure in phase "${agentName}". Cleaning outputs for retry.`);
                if (cleanupUrisOnRequestFailed && cleanupUrisOnRequestFailed.length > 0) {
                    for (const uri of cleanupUrisOnRequestFailed) {
                        try {
                            await vscode.workspace.fs.delete(uri, { recursive: true });
                        } catch {
                            // ignore cleanup errors (missing files etc.)
                        }
                    }
                } else {
                    throw new Error(`Subagent request failed in phase "${agentName}"`);
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
