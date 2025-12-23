import * as vscode from 'vscode';
import * as path from 'path';
import { IDeepWikiParameters } from '../types';
import { logger } from '../utils/logger';

/**
 * Execute an array of async tasks sequentially.
 * Failed tasks are retried once after all initial tasks complete.
 */
async function runTasksSequentially<T>(
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

    const results: T[] = new Array(tasks.length);
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
            logger.warn('Tasks', `${taskGroupName}[${i + 1}/${tasks.length}]: Failed after ${taskDuration}s, will retry later - ${String(error)}`);
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

/**
 * DeepWiki Language Model Tool (Sequential Agentic Pipeline - Component Based)
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
	L1 Context${currentStage === 'L1' ? ' ← YOU' : ''} → L2 Discover (A/B/C)${currentStage.startsWith('L2') ? ' ← YOU' : ''} → L3 Analyze${currentStage === 'L3' ? ' ← YOU' : ''} → L3-R Review${currentStage === 'L3R' ? ' ← YOU' : ''} → L4 Architect${currentStage === 'L4' ? ' ← YOU' : ''} → L5 Pages (1:1)${currentStage === 'L5' ? ' ← YOU' : ''} → L5-V Validate${currentStage === 'L5V' ? ' ← YOU' : ''} → L6 Review${currentStage === 'L6' ? ' ← YOU' : ''} → L7 Indexer${currentStage === 'L7' ? ' ← YOU' : ''} → L8 QA (README)${currentStage === 'L8' ? ' ← YOU' : ''} → L9 QA (Release Gate)${currentStage === 'L9' ? ' ← YOU' : ''}
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

        // Optional Mermaid validator tool name (empty string means no validation instructions)
        const mermaidValidatorToolName = sanitizeToolNameForPrompt(params.mermaidValidatorToolName ?? '');
        const mermaidValidationInstruction = mermaidValidatorToolName.length > 0
            ? `\n- **Mermaid Validation**: After writing any Mermaid diagram, ALWAYS validate its syntax using \`${mermaidValidatorToolName}\`. Fix any syntax errors before proceeding.`
            : '';

        // Define ComponentDef interface globally within invoke scope
        // - name: used for file naming (immutable once set)
        // - displayTitle: optional user-facing title for page headings and links (can be changed mid-pipeline)
        interface ComponentDef { name: string; displayTitle?: string; files: string[]; description: string }

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
            for (const level of ['L1', 'L2', 'L3', 'L3R', 'L4', 'L5', 'L5V', 'L6', 'L7', 'L8', 'L9']) {
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
                // L6+ is a resume mode: pages may be partially missing (we can auto-regenerate missing ones via L5).
                // Ensure the pages directory exists, but do not require any files yet.
                const pagesDirUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, outputPath, 'pages'));
                await vscode.workspace.fs.createDirectory(pagesDirUri);
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
                const projectContextUri = vscode.Uri.file(
                    path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L1', 'project_context.md')
                );
                await this.runPhase(
                    'L1: Project Context Analyzer',
                    'Analyze project environment and context',
	                    `# Project Context Analyzer Agent (L1)

## Role
- **Your Stage**: L1 Analyzer (Pre-Discovery)
- **Core Responsibility**: Capture project type, build system, architecture, vocabulary, and conditional/active code patterns
- **Critical Success Factor**: Downstream agents must rely on this to maintain consistent terminology, avoid documenting inactive/generated code, and understand the project's structure

## Goal
Create a comprehensive project context document that serves as the single source of truth for all downstream stages. This document ensures consistent terminology and accurate understanding of the codebase.
${existingDeepWikisNote}

## Workflow
1. Detect project type, languages, build system → write "## Overview"
2. Identify main entry points (main functions, index files, CLI commands) → write "## Entry Points"
3. Detect architectural patterns (MVC, Clean Architecture, Pipeline, etc.) → write "## Architecture Pattern"
4. **Identify external interfaces** (how the system interacts with the outside world) → write "## External Interfaces"
5. **Extract project-specific vocabulary** (domain terms, abbreviations, project-specific concepts) → for each term, **read surrounding code broadly** to understand actual usage → write "## Vocabulary"
6. List key external dependencies and their purposes → write "## Key Dependencies"
7. Identify coding conventions (naming, file organization) → write "## Code Conventions"
8. List key abstractions (main classes, interfaces, types) → write "## Key Abstractions"
9. Identify target environments (runtime/platforms) → write "## Target Environments"
10. Find conditional patterns/feature flags (e.g., \`#ifdef\`, \`process.env\`) → write "## Conditional Code Patterns"
11. List generated/vendor/test/excluded code paths → write "## Generated/Excluded Code"
12. Add any analysis notes that affect interpretation → write "## Notes for Analysis"
13. Quick self-check: all sections are filled and grounded in actual files.

## Output
Write Markdown to \`${intermediateDir}/L1/project_context.md\` using this structure (example only; do not wrap the whole file in fences):
${mdCodeBlock}markdown
# Project Context

## Overview
- **Project Type**: ...
- **Languages**: ...
- **Build System**: ...

## Entry Points
| Entry | File | Role |
|-------|------|------|
| Main | src/index.ts | Application entry point |
| CLI | src/cli.ts | Command-line interface |

## Architecture Pattern
- **Pattern**: ... (e.g., MVC, Clean Architecture, Pipeline, Microservices)
- **Evidence**: ... (files/structures that demonstrate this pattern)
- **Key Layers/Stages**: ... (if applicable)

## External Interfaces
> **Purpose**: Document how the system interacts with external actors and systems. This helps readers understand system boundaries before exploring internal components.

### Input Interfaces (how external actors provide data/commands to the system)
| Interface | Type | Description |
|-----------|------|-------------|
| ... | CLI / API / Config / UI / Message Queue / etc. | ... |

### Output Interfaces (how the system delivers results to external actors)
| Interface | Type | Description |
|-----------|------|-------------|
| ... | File / API Response / Database Write / Event / etc. | ... |

### External System Integrations
| System | Type | Purpose |
|--------|------|---------|
| ... | Database / API / Service / File System / etc. | ... |

## Vocabulary
> **Purpose**: Define project-specific terms based on HOW they are actually used in this codebase.

**Process for each term**:
1. Find where the term is used (variable names, function names, type definitions, comments)
2. **Read the surrounding code broadly** - not just the line where the term appears, but the entire function, class, or module to understand context
3. Write a definition based on the observed behavior/usage, NOT general knowledge or dictionary meanings

| Term | Aliases | Definition (based on actual usage in this codebase) |
|------|---------|-----------------------------------------------------|
| ... | ... | ... |

**Rules**:
- Definition must describe what the term means **in this specific codebase**, not its general/dictionary meaning
- If a term is used differently than its common meaning, document the project-specific meaning
- Do NOT guess or infer meanings - only document what you can observe from the code
- Keep Term and Aliases in their original form as they appear in the code (do not translate)

(Include: domain-specific terms, abbreviations, project-coined names, and any terms that have special meaning in this codebase)

## Key Dependencies
| Package | Purpose |
|---------|---------|
| ... | ... |

## Code Conventions
- **Naming**: ... (e.g., camelCase for functions, PascalCase for classes)
- **File Organization**: ... (e.g., feature-based, layer-based)
- **Notable Patterns**: ... (e.g., dependency injection, factory pattern)

## Key Abstractions
| Name | Type | Purpose |
|------|------|---------|
| ... | class/interface/type | ... |

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
4. **Vocabulary Accuracy**:
   - Only include terms that are actually used in the codebase
   - For each term, **read the surrounding code broadly** (entire functions, classes, or modules) to understand how it is used
   - Write definitions based on observed usage in THIS codebase, not general/dictionary meanings
   - Keep Term and Aliases in their original form (do not translate)

` + getPipelineOverview('L1'),
                    token,
                    options.toolInvocationToken,
                    [projectContextUri],
                    { maxAttempts: 3 }
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
                const componentListUri = vscode.Uri.file(
                    path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L2', 'component_list.json')
                );
                await this.runPhase(
                    'L2-A: Drafter',
                    'Draft initial component grouping',
	                    `# Component Drafter Agent (L2-A)

## Role
- **Your Stage**: L2-A Drafter (Discovery Phase - First Pass)
- **Core Responsibility**: Propose an initial logical component grouping based on functionality
- **Critical Success Factor**: Group files that truly work together as one unit

## Input
- **Project Context**: Read \`${intermediateDir}/L1/project_context.md\` thoroughly. Pay special attention to:
  - **Entry Points**: Start your exploration from these files
  - **Architecture Pattern**: Use this to inform how you group components
  - **Vocabulary**: Use these exact terms in component names and descriptions
  - **Key Abstractions**: These often map directly to components
  - **Generated/Excluded Code**: Skip these entirely
- **Excluded Roots**: Read \`${intermediateDir}/L1/existing_deepwikis.md\` and exclude those directories entirely from analysis

## Goal
Create an INITIAL draft of logical components based on **what the code does**, not just folders. Use the **Vocabulary** from L1 to ensure consistent naming.

## Workflow
1. Read the L1 project context thoroughly - especially Entry Points, Architecture Pattern, Vocabulary, and Key Abstractions.
2. Identify excluded roots from \`${intermediateDir}/L1/existing_deepwikis.md\` and DO NOT read/include any files under those roots.
3. Start exploration from the **Entry Points** identified in L1.
4. Scan the project source files and **read their contents** to understand what each file does.
5. Group files into **components** - files that work together to implement a feature or module.
6. **Use Vocabulary terms** from L1 in your component names and descriptions for consistency.
7. **Verify each file exists** before adding it to the files array.
8. Before writing, quickly sanity-check that your JSON is valid and non-empty.

## Granularity Guidelines (CRITICAL)
**IMPORTANT**: Follow these guidelines to ensure appropriate component granularity:

1. **Prefer fine-grained components**: Create more, smaller components rather than fewer, larger ones.
   - A component should represent ONE cohesive concept (e.g., "Authentication", "User API", "Config Loader")
   - If a component has more than 10-15 files, consider splitting it by sub-feature or responsibility

2. **One responsibility per component**: Each component should have a SINGLE clear purpose.
   - BAD: "API" containing auth, users, payments, etc.
   - GOOD: "Auth_API", "Users_API", "Payments_API" as separate components

3. **Avoid over-grouping by directory**: Don't combine unrelated files just because they share a parent folder.
   - Files in src/utils/ might belong to DIFFERENT components based on what they support

4. **Target component count**: For a medium-sized project (50-200 source files):
   - Expect 30-80 components typically
   - If you're generating fewer than 20 components for a large project, you're likely over-grouping
   - Each significant feature, module, or subsystem should have its own component(s)

5. **Coverage**: Ensure ALL significant source files are included in at least one component. Don't leave orphaned files.

6. **Intra-file components**: A single file CAN appear in multiple components if it contains multiple independent abstractions (e.g., a file with unrelated utility classes or multiple feature implementations). Create separate components for each distinct responsibility within such files.

## Output
Write the draft **RAW JSON (no Markdown fences)** to \`${intermediateDir}/L2/component_list.json\`.

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
                    options.toolInvocationToken,
                    [componentListUri],
                    { maxAttempts: 3 }
                );

                // Loop for Review & Refine
                let l1RetryCount = 0;
                const maxL2Retries = 6;
                let isL2Success = false;

                const componentReviewUri = vscode.Uri.file(
                    path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L2', 'review_report.md')
                );

                while (l1RetryCount < maxL2Retries) {
                    logger.log('DeepWiki', `L2 Review/Refine Loop: ${l1RetryCount + 1}/${maxL2Retries}`);

                const retryContextL2 = l1RetryCount > 0
                    ? `\n\n**CONTEXT**: Previous attempt had issues. Please review the revised component list carefully.`
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
- **Core Responsibility**: Critique the component list; identify issues but do NOT edit the JSON
- **Critical Success Factor**: Verify files exist and groupings make functional sense

## Goal
CRITIQUE the component list. Do NOT fix it yourself.

## Input
- Read \`${intermediateDir}/L2/component_list.json\`
- **Reference**: Use file listing tools and **read file contents** to verify groupings.
- **Excluded Roots**: Read \`${intermediateDir}/L1/existing_deepwikis.md\` and treat those directories as out of scope.

## Workflow
1. Review groupings for **functional cohesion**:
   - Are files that work together grouped together?
   - Are unrelated files incorrectly grouped just because they share a directory?
2. **Verification**: Read sample files to verify they actually belong together.
3. **File Existence Check**: Verify ALL file paths in the component list actually exist. Flag any non-existent files.
4. **Scope Check**: If any file path is under an excluded root, flag it as out-of-scope and request removal.
5. Check for missing core files or included noise.
6. **Coverage Check**: Scan the project's source directories and verify that all significant source files are included in at least one component. Flag any orphaned files that should be covered.
7. **Intra-file Component Detection**: When reading files, check if a single file contains multiple **independent, high-level abstractions** (e.g., multiple unrelated classes, separate feature implementations, or distinct utility groups). If so, suggest splitting these into separate components - the same file CAN appear in multiple components if it contains multiple distinct responsibilities.
8. **Granularity Consistency Check**: When you identify intra-file components in one file, check **similar files** (e.g., other files in the same directory or with similar structure) at the same granularity level. If one utils file is split by class/function group, verify other utils files are analyzed with the same granularity - inconsistent granularity often leads to missing components.${retryContextL2}

## Granularity Review (CRITICAL)
- **DO NOT suggest merging components** unless they have the EXACT SAME responsibility
- If a component seems too large (>10-15 files), suggest SPLITTING it
- Coupling between components is NORMAL and expected - do NOT suggest merging coupled components
- Prefer more, smaller components over fewer, larger ones
- If the component count seems low for the project size, suggest adding more fine-grained components

## Output
Write a critique report to \`${intermediateDir}/L2/review_report.md\`:
- If there are issues to fix, list them clearly.
- **If the component list passes all checks with no issues**, write \`APPROVED\` as the first line of the report.

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.

` + getPipelineOverview('L2-B'),
	                    token,
	                    options.toolInvocationToken,
	                    [componentReviewUri],
	                    { maxAttempts: 3 }
	                );

                // ---------------------------------------------------------
                // Check review result
                // ---------------------------------------------------------
                const reviewContent = new TextDecoder().decode(
                    await vscode.workspace.fs.readFile(componentReviewUri)
                );
                const isApproved = reviewContent.trim().toUpperCase().startsWith('APPROVED');

                if (isApproved) {
                    // Review passed - validate JSON and exit
                    const fileListUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L2', 'component_list.json'));
                    try {
                        const fileListContent = await vscode.workspace.fs.readFile(fileListUri);
                        const contentStr = new TextDecoder().decode(fileListContent);
                        componentList = this.parseJson<ComponentDef[]>(contentStr);

                        if (!Array.isArray(componentList) || componentList.length === 0) {
                            throw new Error('Parsed JSON is not a valid array or is empty.');
                        }

                        logger.log('DeepWiki', `L2 Success: Review approved. Identified ${componentList.length} logical components.`);
                        isL2Success = true;
                        break;
                    } catch (e) {
                        logger.error('DeepWiki', `L2 JSON validation failed despite approval: ${e}`);
                        // Continue to refiner to fix JSON issues
                    }
                }

	                // ---------------------------------------------------------
	                // Level 1-C: COMPONENT REFINER (Fix & Finalize)
	                // ---------------------------------------------------------
	                await this.runPhase(
	                    `L2-C: Refiner (Attempt ${l1RetryCount + 1})`,
	                    'Refine component list based on review',
	                    `# Component Refiner Agent (L2-C)

## Role
- **Your Stage**: L2-C Refiner (Discovery Phase - Final Output)
- **Core Responsibility**: Apply L2-B feedback to the component list and produce validated JSON
- **Critical Success Factor**: Produce valid JSON that L2 can use - your output feeds the entire pipeline

## Goal
Refine the component list based on review feedback.

## Input
- Component List: \`${intermediateDir}/L2/component_list.json\`
- Review: \`${intermediateDir}/L2/review_report.md\`
- Excluded Roots: \`${intermediateDir}/L1/existing_deepwikis.md\`

## Workflow
1. Read the Component List and the Review Report.
2. Apply the suggested fixes from the review to the component list.
3. Remove any file paths that fall under excluded roots (already documented elsewhere).
4. Ensure: (a) no missing core files, (b) no duplicate component names, (c) each component has a clear purpose. Note: The same file CAN appear in multiple components.
5. Produce valid JSON.${retryContextL2}

## Granularity Guidelines (CRITICAL)
- **NEVER reduce the number of components** unless L2-B explicitly identified a duplicate component
- If L2-B suggests splitting a large component, DO split it into multiple smaller components
- Tight coupling is NOT a reason to merge - keep components separate
- Each component should focus on ONE responsibility - if unsure, keep them separate
- More pages is better than fewer pages for documentation completeness
- **Coverage**: If L2-B flags orphaned files, add them to appropriate components or create new components for them
- **Intra-file components**: The same file CAN appear in multiple components if it contains distinct responsibilities. Do NOT remove a file from one component just because it appears in another

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
	                    options.toolInvocationToken,
	                    [componentListUri],
	                    { maxAttempts: 3 }
	                );

                // ---------------------------------------------------------
                // Check JSON validity after refinement
                // ---------------------------------------------------------
                const fileListUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L2', 'component_list.json'));
                try {
                    const fileListContent = await vscode.workspace.fs.readFile(fileListUri);
                    const contentStr = new TextDecoder().decode(fileListContent);
                    componentList = this.parseJson<ComponentDef[]>(contentStr);

                    if (!Array.isArray(componentList) || componentList.length === 0) {
                        throw new Error('Parsed JSON is not a valid array or is empty.');
                    }

                    logger.log('DeepWiki', `L2 Refinement produced valid JSON with ${componentList.length} components. Re-reviewing...`);
                    // Continue loop to re-review the refined result
                } catch (e) {
                    logger.error('DeepWiki', `L2 Attempt ${l1RetryCount + 1} Failed: ${e}`);
                }
                l1RetryCount++;
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
            // 1 component == 1 page: page count == component count.

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
            }

            while (componentsToAnalyze.length > 0 && loopCount < MAX_LOOPS) {
                logger.log('DeepWiki', `>>> Starting Analysis/Writing Loop ${loopCount + 1}/${MAX_LOOPS} with ${componentsToAnalyze.length} components...`);

                const firstLoop = loopCount === 0;
                let initialSkipTo: LoopStart = firstLoop ? loopStart : 'L3';

                // Auto-repair missing pages when resuming from L6+.
                // If pages are missing, rerun L5 (Writer + Validator) for those components before continuing to L6.
                if (firstLoop && startStageIndex >= stageOrder.indexOf('L6') && initialSkipTo === 'L6') {
                    const missingComponentNames: string[] = [];
                    for (const component of componentList) {
                        const pageUri = vscode.Uri.file(
                            path.join(workspaceFolder.uri.fsPath, outputPath, 'pages', `${component.name}.md`)
                        );
                        try {
                            await vscode.workspace.fs.stat(pageUri);
                        } catch {
                            missingComponentNames.push(component.name);
                        }
                    }

                    if (missingComponentNames.length > 0) {
                        logger.warn(
                            'DeepWiki',
                            `Resume detected ${missingComponentNames.length} missing page(s). Auto-running L5 Writer for missing components.`
                        );
                        componentsToAnalyze = componentList.filter(c => missingComponentNames.includes(c.name));
                        initialSkipTo = 'L5';
                    }
                }

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
- **Project Context**: Read \`${intermediateDir}/L1/project_context.md\` for:
  - **Vocabulary**: Use these exact terms consistently in your analysis
  - **Architecture Pattern**: Frame your analysis within this context
  - **Key Abstractions**: Reference these when documenting relationships

## Workflow
1. Read \`${intermediateDir}/L1/project_context.md\` to understand vocabulary and architecture context
2. **Project Context Correction** (IMPORTANT): While reading project context, if you notice inaccuracies based on the source code you're analyzing:
   - **Vocabulary errors**: A term's definition doesn't match actual code usage
   - **Architecture mismatch**: The described pattern differs from what you observe
   - **Missing abstractions**: Important types/classes exist but aren't listed
   - **Wrong dependencies**: Dependencies described incorrectly
   → **Directly edit** \`${intermediateDir}/L1/project_context.md\` using \`${editToolNameForPrompt}\` to fix the issue immediately, then continue your analysis
3. Create empty file \`${intermediateDir}/L3/${paddedIndex}_${component.name}_analysis.md\`
4. Read source code files for this component
5. Token-stability workflow (do NOT write all at once):
   - Use \`${editToolNameForPrompt}\` after EACH section.
   - Prefer short bullets/tables over long paragraphs.
   - If you are running out of space, stop adding narrative first; do NOT drop CEI anchors.
   - Keep each \`${editToolNameForPrompt}\` small (aim: one section at a time; avoid huge single patches).
6. Priority order (highest → lowest):
   1) CEI blocks (with evidence anchors) → 2) Diagrams → 3) Critical flows → 4) Narrative summary
7. For each analysis section: Analyze → Use \`${editToolNameForPrompt}\` to write
   - Overview and Architecture
   - Key Logic
   - **Causal Analysis** (see below)
   - Edge Cases & Failure Modes
   - Integration Points & Dependencies
8. Create Mermaid diagrams → Use \`${editToolNameForPrompt}\` to write
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
1. **Scope**: Only write under \`.deepwiki/\`. Read source code as needed. You may edit \`${intermediateDir}/L1/project_context.md\` if you find inaccuracies.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.
3. **Incremental Writing**: Use \`${editToolNameForPrompt}\` after each instruction step. Due to token limits, writing all at once risks data loss.
4. **Project Context Correction**: If you find inaccuracies in project_context.md, fix them directly using \`${editToolNameForPrompt}\` (do not just report them).${mermaidValidationInstruction}

` + getPipelineOverview('L3'),
                        token,
                        options.toolInvocationToken,
                        [analysisFileUri]
                    );
                };

                // Initial L3 analysis
                const l3Tasks = componentsToAnalyze.map(createL3Task);
                await runTasksSequentially(l3Tasks, `L3 Analysis (Loop ${loopCount + 1})`, token);

                // ---------------------------------------------------------
                // L3-R: REVIEWER (Deeper review of each component analysis; parallel)
                // NOTE: L3V was removed - L3R now handles file existence check and triggers retries
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

## Workflow (Incremental Write Pattern - MANDATORY)

1. **Initialize Review File (FIRST)**
   - Create \`${intermediateDir}/L3R/${reviewFile}\` with a header:
     \`\`\`markdown
     # L3R Review: ${component.name}
     Analysis file: ${analysisFile}
     \`\`\`
   - Use \`${editToolNameForPrompt}\` immediately to write this header.

2. **File Existence Check**
   - Check if \`${intermediateDir}/L3/${analysisFile}\` exists.
   - **IMMEDIATELY** append result to \`${intermediateDir}/L3R/${reviewFile}\`:
     \`\`\`markdown
     ## File Check
     - Status: {EXISTS / MISSING / EMPTY}
     \`\`\`
   - Use \`${editToolNameForPrompt}\` to write this section NOW.
   - If the file does NOT exist or is empty:
     - Append "**Result**: RETRY_REQUIRED - Analysis file missing" to review file
     - Write \`${intermediateDir}/L3R/${retryFile}\` as \`["${component.name}"]\`
     - Stop (no further steps).

3. **Claim Verification (Incremental)**
   - Open the L3 analysis file and the component's source files.
   - Extract ONLY lines that start with \`- Claim:\` from the L3 analysis file.
   - For EACH batch of claims (process 3-5 at a time):
     - Verify against ACTUAL SOURCE CODE (APIs, control flow, events, state changes).
     - Use the nearby \`- Evidence:\` anchors to navigate quickly.
     - For each evidence anchor: confirm file path exists and symbol appears in that file.
     - If a claim cannot be verified: delete it or rewrite it into a narrower, verifiable claim.
     - **IMMEDIATELY** append verification result to \`${intermediateDir}/L3R/${reviewFile}\`:
       \`\`\`markdown
       ### Claims Batch {N}
       - Verified: {list of verified claims}
       - Removed/Rewritten: {list with reasons}
       \`\`\`
     - Use \`${editToolNameForPrompt}\` to write this section NOW.
     - If changes needed, patch the L3 analysis file using \`${editToolNameForPrompt}\`.
   - If the analysis is too thin (only headings / vague), add missing critical details ONLY if you can justify them from code.

4. **Diagram Verification (Incremental)**
   - Extract all Mermaid code fences (\`\`\`mermaid ... \`\`\`).
   - For EACH diagram:
     - Verify all referenced identifiers against source (functions/classes/types/events/commands must exist).
     - If describing cross-file calls or state transitions, verify at least one concrete code path supports it.
     - If a diagram cannot be verified, delete it or rewrite it into a smaller, verifiable diagram.
     - **IMMEDIATELY** append verification result to \`${intermediateDir}/L3R/${reviewFile}\`:
       \`\`\`markdown
       ### Diagram: {diagram description or index}
       - Status: {VERIFIED / FIXED / REMOVED}
       - Details: {what was checked or changed}
       \`\`\`
     - Use \`${editToolNameForPrompt}\` to write this section NOW.
     - If changes needed, patch the L3 analysis file using \`${editToolNameForPrompt}\`.

5. **Final Summary and Verdict**
   - Append final summary to \`${intermediateDir}/L3R/${reviewFile}\`:
     \`\`\`markdown
     ## Summary
     - Total claims processed: {count}
     - Claims verified: {count}
     - Claims removed/rewritten: {count}
     - Diagrams processed: {count}
     - Diagrams verified: {count}
     - Diagrams removed/fixed: {count}

     ## Final Verdict
     **Result**: {PASS / RETRY_REQUIRED}
     **Reason**: {Brief explanation}
     \`\`\`
   - Use \`${editToolNameForPrompt}\` to write this final section.

6. **Retry Decision**
   - If the analysis is fundamentally broken or too incomplete to fix safely, write \`${intermediateDir}/L3R/${retryFile}\` as raw JSON array \`["${component.name}"]\`.
   - Otherwise, do not create the retry file.

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
                await runTasksSequentially(l3rTasks, `L3 Review (Loop ${loopCount + 1})`, token);

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
                        await runTasksSequentially(l3RetryTasks, `L3 Re-Analyze (Loop ${loopCount + 1})`, token);
                        // Re-run L3-R only for the re-analyzed components once (do not request further retries).
                        const l3rSecondPassTasks = retryComponents.map(createL3RTask);
                        await runTasksSequentially(l3rSecondPassTasks, `L3 Review (2nd pass, Loop ${loopCount + 1})`, token);
                    }
                }
                }

                // Note: L3-PC step was removed because L3 Analyzer now directly edits project_context.md
                // when it discovers inaccuracies during analysis.

                // ---------------------------------------------------------
                // Level 4: ARCHITECT (Runs in every loop to keep overview up to date)
                // Input: All L3 analysis files (even from previous loops)
                // ---------------------------------------------------------
                if (runL4Stage) {
                    const l4OverviewUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L4', 'overview.md'));
                    const l4RelationshipsUri = vscode.Uri.file(
                        path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L4', 'relationships.md')
                    );
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
- \`${intermediateDir}/L1/project_context.md\` - **Read first** for:
  - **Vocabulary**: Use these exact terms consistently in your overview
  - **Architecture Pattern**: Frame the system architecture within this context
- Read ALL files in \`${intermediateDir}/L3/\` (including previous loops) and any necessary source files.

## Workflow
1. Read \`${intermediateDir}/L1/project_context.md\` to understand vocabulary and architecture context.
2. Read L3 analysis and confirm key responsibilities/links.
3. Source verification (mandatory):
   - For at least 10 key claims you plan to include in L4, open the referenced source files and verify the claim is consistent with the code.
   - If a claim cannot be confirmed from source, either delete it or rephrase it into a narrower, verifiable statement.
4. Write \`${intermediateDir}/L4/overview.md\`:
   - high-level architecture, major components, rationale ("why this shape?")
5. Write \`${intermediateDir}/L4/relationships.md\`:
   - cross-component event/state causality map
   - include diagrams (see below)
6. Quick self-check: overview matches L3 facts; diagrams render; no raw code pasted.

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
3. **Incremental Writing**: Write section-by-section with \`${editToolNameForPrompt}\`.${mermaidValidationInstruction}

` + getPipelineOverview('L4'),
                    token,
                    options.toolInvocationToken,
                    [l4OverviewUri, l4RelationshipsUri],
                    { maxAttempts: 3 }
                );
                }

                // ---------------------------------------------------------
                // Level 5: PAGES (deterministic 1:1 mapping)
                // ---------------------------------------------------------
                // The wiki pages are intentionally kept at a stable granularity:
                // one generated page per discovered component.
                //
                // L5 is responsible for:
                // 1) writing `.deepwiki/pages/*.md` (1 component = 1 page)
                // 2) grouping pages for README navigation (`page_groups.json`, via the L5-G subagent)
                if (runL5Stages) {
                logger.log('DeepWiki', `L5 Pages: ${componentsForThisLoop.length} components in this loop (1:1 mapping)`);

                // ---------------------------------------------------------
                // Level 5-G: PAGE GROUPER (for README TOC & diagrams)
                // Also reviews and directly updates component list if needed
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

                // Save current component list to detect changes after L5-G
                const componentListBeforeL5G = JSON.stringify(componentList);

                await this.runPhase(
                    `L5-G: Page Grouper (Loop ${loopCount + 1})`,
                    'Group pages and review project context, component structure',
                    `# Page Grouper Agent (L5-G)

## Role
- **Your Stage**: L5-G Page Grouper (Information Architecture for README)
- **Core Responsibility**:
  1. Review and update project context if L3/L4 analysis revealed inaccuracies
  2. Review and update component structure based on L3/L4 insights
  3. Create stable, reader-friendly groups of pages for the README TOC

## Goal
1. Correct project context if L3/L4 analysis revealed inaccuracies
2. Evaluate and fix component list if L3/L4 analysis revealed issues
3. Group the generated pages (pageName values) into 3–8 groups

## Input
- Project context: \`${intermediateDir}/L1/project_context.md\`
- Components list: \`${intermediateDir}/L2/component_list.json\`
- L3 analyses: \`${intermediateDir}/L3/*_analysis.md\`
- L4 overview/relationships:
  - \`${intermediateDir}/L4/overview.md\`
  - \`${intermediateDir}/L4/relationships.md\`

## Workflow

### Part 0: Project Context Review (Do First)
1. Read \`${intermediateDir}/L1/project_context.md\` and all L3 analyses.
2. Check if L3/L4 revealed inaccuracies in project context:
   - **Vocabulary errors**: A term's definition doesn't match how it's actually used in code
   - **Architecture mismatch**: The described pattern doesn't match what L3/L4 discovered
   - **Missing key abstractions**: Important types/classes discovered in L3 but not listed
   - **Wrong dependencies**: Dependencies described incorrectly or missing important ones
   - **Entry points incorrect**: Main entry points changed or were misidentified
3. If inaccuracies found: **Directly edit** \`${intermediateDir}/L1/project_context.md\` to fix the issues.
4. If NO inaccuracies found: Leave project_context.md unchanged.

### Part 1: Component Review
1. Read all L3 analyses and L4 outputs.
2. Check if L3/L4 revealed issues with component groupings:
   - **Split needed**: A component has multiple unrelated responsibilities → SPLIT IT (preferred action)
   - **Merge needed**: ONLY merge if two components are almost identical in purpose (very rare!)
   - **Files missing**: L3 discovered important files not in the component
   - **Wrong grouping**: A file belongs to a different component
3. If changes needed: **Directly edit** \`${intermediateDir}/L2/component_list.json\` to fix the issues.
4. If NO changes needed: Leave component_list.json unchanged.

**CRITICAL - Granularity Preservation**:
- **DO NOT reduce the number of components unless absolutely necessary**
- Prefer SPLITTING over MERGING - more pages is better than fewer pages
- Tight coupling between components is NORMAL - it does NOT justify merging them
- A component calling another component is NOT a reason to merge
- Only merge if two components have the EXACT SAME responsibility (very rare)

### Part 2: Page Grouping
5. Read \`${intermediateDir}/L2/component_list.json\` (use the updated version if you modified it).
6. Create 3–8 groups with clear names; assign every page to exactly one group.
7. Write to \`${intermediateDir}/L5/page_groups.json\`.

## Output
1. \`${intermediateDir}/L1/project_context.md\` - Edit directly if inaccuracies found (keep Markdown format)
2. \`${intermediateDir}/L2/component_list.json\` - Edit directly if changes needed (keep valid JSON format)
3. \`${intermediateDir}/L5/page_groups.json\` - **RAW JSON (no fences)**, page groupings

**Page groups format**:
${mdCodeBlock}json
${pageGroupsExample}
${mdCodeBlock}

## Constraints
1. **Conservative updates**: Only modify project_context.md or component_list.json when L3/L4 clearly indicates a problem.
2. **Valid formats**: project_context.md must remain valid Markdown; component_list.json must remain a valid JSON array of {name, files, description}.
3. Each \`pages\` item must be an exact component \`name\` (no \`.md\` suffix).
4. Every page must appear exactly once across all groups.
5. **Scope**: Only write under \`.deepwiki/\`.
6. **Chat Final Response**: One short confirmation line.

` + getPipelineOverview('L5'),
                    token,
                    options.toolInvocationToken
                );

                // ---------------------------------------------------------
                // Check if L5-G modified component_list.json
                // ---------------------------------------------------------
                try {
                    const componentListUri = vscode.Uri.file(
                        path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L2', 'component_list.json')
                    );
                    const updatedContent = await vscode.workspace.fs.readFile(componentListUri);
                    const updatedList = this.parseJson<ComponentDef[]>(new TextDecoder().decode(updatedContent));

                    if (Array.isArray(updatedList) && JSON.stringify(updatedList) !== componentListBeforeL5G) {
                        logger.log('DeepWiki', `L5-G: Component list was modified (${updatedList.length} components). Restarting from L3...`);
                        componentList = updatedList;
                        componentsToAnalyze = [...updatedList];
                        loopCount++;
                        continue; // Restart loop from L3 with updated components
                    }
                } catch (e) {
                    logger.log('DeepWiki', `L5-G: Could not check component list changes (${e instanceof Error ? e.message : 'error'})`);
                }

                // ---------------------------------------------------------
                // Level 5: WRITER (Write pages; 1 component = 1 page)
                // ---------------------------------------------------------
                const pageTemplate = `
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

## External Interface
{Describe how other modules interact with these components. List public methods, props, and events.}
	`; // The template ends here
                // Task generator function for L5 writing (shared by initial and retry)
                const createL5Task = (component: ComponentDef) => {
                    const pageUris = [
                        vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, outputPath, 'pages', `${component.name}.md`))
                    ];
                    return () => this.runPhase(
                        `L5: Writer (Loop ${loopCount + 1})`,
                        `Write documentation page`,
	                        `# Writer Agent (L5)

## Role
- **Your Stage**: L5 Writer (Analysis Loop - Documentation Generation, runs in parallel)
- **Core Responsibility**: Transform L3 analysis into readable, well-structured documentation pages
- **Critical Success Factor**: L6 will review your output - focus on clarity and causal explanations

## Input
- Assigned Component: ${JSON.stringify({ name: component.name, displayTitle: component.displayTitle, files: component.files, description: component.description })}
  - \`name\`: Used for file naming (e.g., \`pages/{name}.md\`) - DO NOT change
  - \`displayTitle\`: If present, use this as the page's H1 heading instead of \`name\`
- For each component, read the matching L3 analysis file in \`${intermediateDir}/L3/\` (named like \`001_ComponentName_analysis.md\`)
- **Project Context**: Read \`${intermediateDir}/L1/project_context.md\` for:
  - **Vocabulary**: Use these exact terms consistently in your documentation
  - **Architecture Pattern**: Frame explanations within this architectural context

## Workflow
1. Read \`${intermediateDir}/L1/project_context.md\` to understand vocabulary and architecture context
2. For EACH assigned component: Create \`${outputPath}/pages/{name}.md\` (use \`name\` for filename, but use \`displayTitle\` if present for the H1 heading)
3. Read the L3 analysis for that component
4. Synthesize and consolidate L3 content into a reader-friendly page.
   - You MAY read source code files to verify accuracy, but do NOT perform a fresh full analysis beyond what is needed to validate correctness.
5. Iterate through sections (Architecture, Mechanics, Interface): Synthesize content → Use \`${editToolNameForPrompt}\` to write immediately
6. Generate an ASCII tree of ALL files from ALL components in this page → Use \`${editToolNameForPrompt}\` to write
7. **Grounding requirement**: Do NOT add new statements beyond what is supported by L3; if unsure, omit rather than guessing. Ensure the "File Structure" section lists all component source files (it will be used for verification).
8. Token-stability workflow:
   - Use \`${editToolNameForPrompt}\` after EACH major section.
   - Keep each \`${editToolNameForPrompt}\` small (aim: one section at a time; avoid huge single patches).

**Consolidation Guidelines**:
- If a page has multiple components, weave their descriptions together
- Identify shared concepts and present them once, not repeatedly
- Show how the components within the page interact with each other
- The page should read as a unified document, not separate sections glued together

**Causal Explanation**:
When describing Internal Mechanics, explain the CAUSAL FLOW (e.g., "Because X happens, Y triggers Z").

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
6. **No Intermediate Links**: Do NOT include links to intermediate analysis files (e.g., intermediate/L3/, ../L3/, ../L4/). Only reference other pages via their final page files in \`pages/\` directory. If filenames contain spaces, wrap link targets in angle brackets, e.g. \`[Page Name](<Page Name.md>)\`.${mermaidValidationInstruction}

` + getPipelineOverview('L5'),
                        token,
                        options.toolInvocationToken,
                        pageUris
                    );
                };

                // Initial L5 writing
                const l5Tasks = componentsToAnalyze.map(createL5Task);
                await runTasksSequentially(l5Tasks, `L5 Writing (Loop ${loopCount + 1})`, token);

                // ---------------------------------------------------------
                // L5 Validator: Check for missing page files and retry if needed
                // ---------------------------------------------------------
                const l5ExpectedPages = componentsToAnalyze.map(c => ({
                    pageName: c.name,
                    file: `${c.name}.md`
                }));
                await this.runPhase(
                    `L5-V: Validator (Loop ${loopCount + 1})`,
                    'Validate L5 output files',
                    `# L5 Validator Agent

## Role
Quality gate for L5 outputs: ensure expected page files exist.

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
                    const parsed = this.parseJson<unknown>(new TextDecoder().decode(content));
                    if (Array.isArray(parsed) && parsed.every(p => typeof p === 'string')) {
                        l5FailedPages = parsed;
                    } else {
                        logger.warn('DeepWiki', 'L5-V: page_validation_failures.json is not a string array; retrying all pages for safety.');
                        l5FailedPages = componentsToAnalyze.map(c => c.name);
                    }
                    await vscode.workspace.fs.delete(l5FailuresUri);
                } catch { /* no failures file or invalid */ }

                if (l5FailedPages.length > 0) {
                    logger.log('DeepWiki', `L5 Validator requested retry for ${l5FailedPages.length} page(s): ${l5FailedPages.join(', ')}`);
                    // Retry using the same task generator function
                    const failedComponents = componentsToAnalyze.filter(c => l5FailedPages.includes(c.name));
                    const l5RetryTasks = failedComponents.map(createL5Task);
                    await runTasksSequentially(l5RetryTasks, `L5 Retry (Loop ${loopCount + 1})`, token);
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
- Read relevant L3 analysis files in \`${intermediateDir}/L3/\` for each page's components
- Read \`${intermediateDir}/L2/component_list.json\` to map pageName ↔ component ↔ source files
  - \`name\`: Used for file naming (e.g., \`pages/{name}.md\`)
  - \`displayTitle\`: If present, the page's H1 heading should match this instead of \`name\`

## Workflow (Incremental Write Pattern - MANDATORY)

1. **Initialize Report (FIRST)**
   - Create \`${intermediateDir}/L6/review_report.md\` with a header:
     \`\`\`markdown
     # L6 Page Review Report
     Generated: {timestamp}
     Loop: ${loopCount + 1}
     \`\`\`
   - Use \`${editToolNameForPrompt}\` immediately to write this header.

2. **Inventory Check**
   - Read \`${intermediateDir}/L2/component_list.json\` and compute the expected page files: \`{component.name}.md\` (1 component = 1 page).
   - List files in \`${outputPath}/pages/\`.
   - Identify:
     - Missing pages: expected but not present
     - Extra pages: present but not in component_list (these should usually be deleted unless clearly intentional)
   - **IMMEDIATELY** append inventory results to \`${intermediateDir}/L6/review_report.md\`:
     \`\`\`markdown
     ## Inventory
     - Expected pages: {count}
     - Found pages: {count}
     - Missing: {list or "None"}
     - Extra: {list or "None"}
     \`\`\`
   - Use \`${editToolNameForPrompt}\` to write this section NOW before proceeding.
   - If any pages are missing:
     - ${isLastLoop ? 'Do NOT request retries; add a prominent warning note to README and/or affected areas about missing pages.' : `Write \`${intermediateDir}/L6/retry_request.json\` as a raw JSON array of the missing component names so the pipeline can regenerate them.`}

3. **Page-by-Page Review (Incremental)**
   For EACH existing page (where pageName == component name), perform the following sub-steps IN ORDER:

   a. **Read and Check**
      - Read the page file
      - Check ALL of the following:
        - **Page Title Clarity**: Check if the page's H1 heading (derived from \`name\` or \`displayTitle\`) is clear and user-friendly.
          - If the current title is unclear, too technical, or could be improved: add/update \`displayTitle\` in \`${intermediateDir}/L2/component_list.json\` for that component.
          - Update the page's H1 heading to match the new \`displayTitle\`.
          - Example: If \`name\` is "Auth_OAuth2_PKCE" but a clearer title would be "OAuth2 認証 (PKCE)", set \`displayTitle\` to "OAuth2 認証 (PKCE)".
        - **File Structure**: Ensure the "File Structure" section includes an accurate list of source files (populate it from \`${intermediateDir}/L2/component_list.json\`; remove any non-existent paths).
        - **No placeholders**: Remove/replace obvious placeholders (e.g., "TODO", "TBD", "{...}").
        - **Element-level use cases**: If "## Internal Mechanics Details" is split into multiple element subsections, ensure EACH element subsection includes a concrete use case explanation (why/when to use it, pitfalls).
        - **Element-level diagrams**: If "## Internal Mechanics Details" is split into multiple element subsections, ensure EACH element subsection includes a \`stateDiagram-v2\` describing that element's state transitions (trivial single-state diagram is acceptable for stateless elements).
        - **Accuracy**: Verify statements against ACTUAL SOURCE CODE using the file list in "File Structure" (and \`${intermediateDir}/L2/component_list.json\`) as the starting set. If a statement cannot be verified, DELETE the smallest possible block (sentence/row) rather than guessing.
        - **Signatures**: If you list API signatures, verify they match the source; keep them brief (no bodies).
        - **Connectivity**: Fix broken links; ensure links target existing final files under \`${outputPath}/\`.
        - **Formatting**: Fix broken Markdown tables or Mermaid syntax errors.
        - **Intermediate Links**: Check for any references to intermediate artifacts (intermediate/, ../L3/, ../L4/, etc.)

   b. **Write Review Result (IMMEDIATELY after each page check)**
      - **IMMEDIATELY** append this page's review result to \`${intermediateDir}/L6/review_report.md\`:
        \`\`\`markdown
        ### {PageName}.md
        - Status: {OK / Issues Found}
        - Title: {OK / Updated displayTitle to "..."}
        - File Structure: {OK / Fixed / N/A}
        - Placeholders: {None found / Removed: ...}
        - Element use cases: {OK / Added / N/A}
        - Element diagrams: {OK / Added / N/A}
        - Accuracy issues: {None / Removed: ...}
        - Links: {OK / Fixed: ...}
        - Formatting: {OK / Fixed: ...}
        - Intermediate links: {None / Removed: ...}
        \`\`\`
      - Use \`${editToolNameForPrompt}\` to write this section NOW.

   c. **Fix Issues (if any)**
      - If issues were found, fix them in the page file using \`${editToolNameForPrompt}\`.
      - Only proceed to the next page AFTER writing the review result AND fixing issues.

4. **Final Summary and Verdict**
   - After ALL pages are reviewed, append a final summary to \`${intermediateDir}/L6/review_report.md\`:
     \`\`\`markdown
     ## Summary
     - Total pages reviewed: {count}
     - Pages with issues: {count}
     - Major issues requiring retry: {list or "None"}

     ## Final Verdict
     **Result**: {PASS / RETRY_REQUIRED}
     **Reason**: {Brief explanation - e.g., "All pages verified successfully" or "Components X, Y need re-analysis due to..."}
     \`\`\`
   - Use \`${editToolNameForPrompt}\` to write this final section.

5. **Retry Decision**
   ` + retryInstruction + `

## Output
- Overwrite pages in \`${outputPath}/pages/\` if fixing.
- Always write \`${intermediateDir}/L6/review_report.md\`.
- Write \`${intermediateDir}/L6/retry_request.json\` ONLY if requesting retries.
  - The file must be a raw JSON array of component names, e.g. \`["Auth Module"]\` (no extra fields, no fences).

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.
3. **Incremental Writing**: Use \`${editToolNameForPrompt}\` after each instruction step. Due to token limits, writing all at once risks data loss.${mermaidValidationInstruction}

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
                const readmeUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, outputPath, 'README.md'));
                const l7ReportUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L7', 'indexer_report.md'));
                await this.runPhase(
                    'L7: Indexer',
                    'Create README and Sidebar',
                    `# Indexer Agent

## Role
- **Your Stage**: L7 Indexer
- **Core Responsibility**: Synthesize L4/L5 outputs into a high-quality landing README
- **Critical Success Factor**: First screen should answer "What is this? How is it organized? Where do I start?"

## Input
- \`${intermediateDir}/L1/project_context.md\` - **Read first** for:
  - **Vocabulary**: Use these exact terms consistently in the README
  - **Architecture Pattern**: Frame the system description within this context
  - **Entry Points**: Reference these when describing where to start
- \`${intermediateDir}/L4/overview.md\`
- \`${intermediateDir}/L4/relationships.md\`
- \`${intermediateDir}/L2/component_list.json\` (source of truth for pages; 1 component = 1 page)
  - \`name\`: Used for file path (e.g., \`pages/{name}.md\`)
  - \`displayTitle\`: If present, use this as link text instead of \`name\`
- \`${intermediateDir}/L5/page_groups.json\` (source of truth for README grouping; created by L5-G)
- All files under \`${outputPath}/pages/\`
- Existing nested DeepWikis list: \`${intermediateDir}/L1/existing_deepwikis.md\`

## Workflow
1. Read \`${intermediateDir}/L1/project_context.md\` first to understand vocabulary and architecture context.
2. Create \`${outputPath}/README.md\` with these sections in order:

### Title (top)
- Use a neutral title that reflects the whole repository/workspace (not a single subproject/component).
- If the repo clearly contains multiple deliverables (e.g., extension + CLI + server), the title and one-line summary must reflect that multi-deliverable nature.

### 0. Disclaimer (top)
Insert exactly:
> **Note**: This documentation was auto-generated by an LLM. While we strive for accuracy, please refer to the source code for authoritative information.

### 1. Architecture Overview
**A. One-Line Summary** - one sentence for the whole repository/workspace (not a single component).
- Coverage requirement: the summary must be consistent with the full set of groups/pages (use \`${intermediateDir}/L5/page_groups.json\` and \`${intermediateDir}/L2/component_list.json\`). Do not describe only one subproject if multiple exist.
- If needed, explicitly say "This repository contains multiple related subprojects/deliverables: ..." (keep it to 1 sentence).

**B. System Context (C4Context) - REQUIRED**
- 2-3 sentence preface, then diagram.
- High-level only (5-7 nodes).
- **External actors/systems are REQUIRED**: The diagram MUST show what external entities interact with this system (users, external APIs, databases, file systems, other services, etc.). This is the primary purpose of a C4 Context diagram.
- Place the target system(s) in the center, surrounded by external actors and systems that interact with it.
- Must describe the whole system/repo: include the major subsystems/groups from \`${intermediateDir}/L5/page_groups.json\` (not just one subproject).
- If the repo has multiple deliverables (e.g., extension + CLI + server), the diagram must include each deliverable as a top-level node (even if simplified).

**C. External Interfaces - REQUIRED**
After the System Context diagram, add a brief section (3-6 bullet points) listing the primary external interfaces:
- **Input interfaces**: How external actors provide data/commands to the system (CLI args, API endpoints, config files, UI, message queues, etc.)
- **Output interfaces**: How the system delivers results to external actors (files generated, API responses, database writes, notifications, etc.)
- **Dependencies**: External systems/services the system relies on (databases, third-party APIs, runtime environments, etc.)
- **Source**: Use \`${intermediateDir}/L1/project_context.md\` (## External Interfaces section) as the primary reference, supplemented by L3/L4 analysis.
This section helps readers understand the system boundaries before diving into internal components.

**D. Core State Transitions (stateDiagram-v2) - REQUIRED**
- 2-3 sentence preface, then diagram.
- Show main states and triggers only (5-10 states max).
- **No deep nesting**: Avoid \`state X { ... }\` composite states. Keep the diagram flat for readability.
- Must be system-wide: represent cross-subsystem transitions that span multiple groups (use \`${intermediateDir}/L4/relationships.md\` as the primary source).

### 2. Components
Use \`${intermediateDir}/L5/page_groups.json\` to structure the README as **chapters** (one chapter per group, in the same order as page_groups).
If any component page name from \`${intermediateDir}/L2/component_list.json\` is missing from \`${intermediateDir}/L5/page_groups.json\` (or appears twice / is unknown), FIX \`${intermediateDir}/L5/page_groups.json\` first so it covers every pageName exactly once, then generate the README from the corrected groups. Do NOT create an "Ungrouped"/"Other" bucket in the README.
For EACH group, create a chapter with this shape:
- Chapter heading: \`#### <GroupName>\`
- Chapter description: 3-6 sentences explaining:
  - What this group is responsible for (scope and boundaries)
  - How it relates to other groups at a high level (1-2 sentences max)
  - Where a new reader should start (name 1-2 pages as the recommended entry points)
- Pages list: include ALL pages in this group, each as:
  - Link text: Use \`displayTitle\` if present, otherwise use \`name\`
  - Link target: Always use \`name\` for the file path (e.g., \`[DisplayTitle](pages/Name.md)\` or \`[DisplayTitle](<pages/Name With Spaces.md>)\`)
  - One-line description using \`${intermediateDir}/L2/component_list.json\` \`description\` for that component (or a conservative summary from the page itself).
- Do NOT add source-code links in the README. Keep navigation focused on the generated pages (\`pages/*.md\`); detailed code entry points belong inside each page if needed.

### 2.5 Existing DeepWikis (optional)
If \`${intermediateDir}/L1/existing_deepwikis.md\` is not "(none)", add a short section listing links to those existing docs (link to their \`.deepwiki/README.md\` only; do not summarize their internals).

### 3. Quick self-check
- Both diagrams present and render.
- **System Context diagram includes external actors/systems** (not just internal components). A reader should immediately understand what interacts with this system from outside.
- **External Interfaces section is present** with Input/Output/Dependencies clearly listed.
- Diagrams describe the system as a whole (not a single component/group).
- Title + one-line summary reflect the whole repo (sanity check: can a reader infer at least 2-3 top groups' purposes from them? If not, rewrite to be broader).
- Components list matches component_list exactly (1 component = 1 page).
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
6. **No Validation Results in README**: Do NOT include verifier/validator results, fact-check notes, retry details, or "what I validated" prose inside \`${outputPath}/README.md\`. Put that only in \`${intermediateDir}/L7/indexer_report.md\`.${mermaidValidationInstruction}

` + getPipelineOverview('L7'),
                    token,
                    options.toolInvocationToken,
                    [readmeUri, l7ReportUri],
                    { maxAttempts: 3 }
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
5. **No Validation Results in README**: Do NOT add any "Verification", "Validation", "Fact-check", or similar sections/notes to \`${outputPath}/README.md\`. Keep all verification results exclusively in \`${intermediateDir}/L8/factcheck_report.md\`.
`,
                    token,
                    options.toolInvocationToken,
                    undefined,
                    { maxAttempts: 3 }
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
4. **No Validation Results in README**: Do NOT add any "Verification", "Validation", "Release Gate", or similar report sections into \`${outputPath}/README.md\`. Keep gate details exclusively in \`${intermediateDir}/L9/release_gate_report.md\`.
`,
                    token,
                    options.toolInvocationToken,
                    undefined,
                    { maxAttempts: 3 }
                );
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `✅ DeepWiki Generation Completed!\n\nDocumented ${componentList.length} components into ${componentList.length} pages. Check the \`${outputPath}\` directory.`
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
        cleanupUrisOnRequestFailed?: vscode.Uri[],
        options?: { maxAttempts?: number; retryDelayMs?: number }
    ): Promise<void> {
        const maxAttempts = Math.max(1, options?.maxAttempts ?? 1);
        const retryDelayMs = Math.max(0, options?.retryDelayMs ?? 15000);
        const isRetryableFailureText = (text: string) =>
            /(your request failed|hit the length limit|there was a network error|no response was returned|rate limit|too many requests|429|timed out|timeout|econnreset|socket hang up)/i.test(
                text
            );

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const startTime = Date.now();
            logger.log('DeepWiki', `>>> Starting Phase: ${agentName} (attempt ${attempt}/${maxAttempts}) - ${description}`);

            // Wait before each subagent call to avoid API rate limits (and give transient failures time to clear).
            await new Promise(resolve => setTimeout(resolve, attempt === 1 ? 10000 : retryDelayMs));

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
                if (isRetryableFailureText(resultText)) {
                    const shouldRetry = attempt < maxAttempts;
                    logger.warn(
                        'DeepWiki',
                        `Subagent reported request failure in phase "${agentName}" (attempt ${attempt}/${maxAttempts}).${shouldRetry ? ' Retrying.' : ''}`
                    );

                    if (cleanupUrisOnRequestFailed && cleanupUrisOnRequestFailed.length > 0) {
                        for (const uri of cleanupUrisOnRequestFailed) {
                            try {
                                await vscode.workspace.fs.delete(uri, { recursive: true });
                            } catch {
                                // ignore cleanup errors (missing files etc.)
                            }
                        }
                    }
                    if (shouldRetry) continue;
                    throw new Error(`Subagent request failed in phase "${agentName}"`);
                }

                logger.log('DeepWiki', `<<< Completed Phase: ${agentName} in ${duration}s - ${resultPreview}...`);
                return;
            } catch (error) {
                const duration = ((Date.now() - startTime) / 1000).toFixed(1);
                const msg = error instanceof Error ? error.message : String(error);
                const shouldRetry = attempt < maxAttempts && isRetryableFailureText(msg);
                logger.error(
                    'DeepWiki',
                    `!!! Failed Phase: ${agentName} after ${duration}s (attempt ${attempt}/${maxAttempts})${shouldRetry ? ' - retrying' : ''}`,
                    error
                );
                if (shouldRetry) {
                    if (cleanupUrisOnRequestFailed && cleanupUrisOnRequestFailed.length > 0) {
                        for (const uri of cleanupUrisOnRequestFailed) {
                            try {
                                await vscode.workspace.fs.delete(uri, { recursive: true });
                            } catch {
                                // ignore cleanup errors
                            }
                        }
                    }
                    continue;
                } else {
                    throw error;
                }
            }
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
        await vscode.workspace.fs.writeFile(vscode.Uri.file(mdPath), new TextEncoder().encode(mdLines.join('\n')));

        return items;
    }

}
