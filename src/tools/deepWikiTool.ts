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
        const isAuto = startFromStage.toLowerCase() === 'auto';
        const stageDescription = isAuto
            ? '`auto` (AI will analyze existing artifacts and determine optimal resume point)'
            : `\`${startFromStage}\`${startFromStage === 'L1' ? '' : ' (resume; earlier stages are skipped and existing artifacts are reused)'}`;
        return {
            invocationMessage: 'Initializing DeepWiki Component Pipeline...',
            confirmationMessages: {
                title: 'Generate DeepWiki',
                message: new vscode.MarkdownString(
                    'Start the DeepWiki generation pipeline?\n\n' +
                    `This will analyze your workspace by **Components** and generate documentation in \`${outputPath}\`.\n\n` +
                    `Start from stage: ${stageDescription}.`
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
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

        if (!workspaceFolder) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Error: No workspace folder open.')
            ]);
        }

        const intermediateDir = `${outputPath}/intermediate`;

        // Determine start stage (may be overridden by auto-detection below)
        let startFromStageRaw = String(params.startFromStage || 'L1').toUpperCase();
        const isAutoDetect = startFromStageRaw === 'AUTO';
        let startFromStage: Stage;
        let autoDetectedReason = '';

        if (isAutoDetect) {
            logger.log('DeepWiki', 'Auto-detect mode: Running L0-Auto subagent to determine resume point...');

            // Run auto-detection subagent
            const autoDetectResult = await this.runAutoDetectSubagent(
                workspaceFolder,
                outputPath,
                intermediateDir,
                token,
                options.toolInvocationToken
            );

            startFromStage = autoDetectResult.stage;
            autoDetectedReason = autoDetectResult.reason;
            logger.log('DeepWiki', `Auto-detect result: ${startFromStage} - ${autoDetectedReason}`);
        } else {
            startFromStage = (stageOrder as readonly string[]).includes(startFromStageRaw)
                ? (startFromStageRaw as Stage)
                : 'L1';
        }

        const startStageIndex = stageOrder.indexOf(startFromStage);

        logger.log('DeepWiki', 'Starting Component-Based Pipeline...');
        if (startFromStage !== 'L1') {
            const reasonSuffix = autoDetectedReason ? ` (${autoDetectedReason})` : '';
            logger.log('DeepWiki', `Resume mode: starting from stage ${startFromStage} (skipping earlier stages)${reasonSuffix}`);
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

            // Deep Thinking Protocol: Enhances subagent reasoning by utilizing the "scratchpad" pattern.
            // Subagent text output before tool calls is discarded from user view but remains in context,
            // allowing detailed internal reasoning without cluttering the final output.
            const getDeepThinkingProtocol = () => `

## Deep Thinking Protocol (IMPORTANT)
Your text output before each tool call is invisible to users but remains in YOUR context. Use this as a "scratchpad" to maximize reasoning quality:

### Before EACH Tool Call
1. **Situation Analysis**: Describe current state and what you're trying to accomplish
2. **Hypotheses** (generate 3): List three possible approaches or interpretations
3. **Decision**: Choose the best hypothesis and explain why

### After EACH Tool Result
1. **Reflection**: Was your hypothesis correct? What did you learn?
2. **Adjustment**: How does this change your next action?

### Final Output
- Keep your final chat response brief and polished (e.g., "Task completed.")
- All detailed reasoning stays in your pre-tool-call text (which is discarded from user view)
- Do NOT include your thinking process in files you write

This protocol improves accuracy by forcing explicit reasoning before actions.

## Anti-Hallucination Rules
You are generating technical documentation. Accuracy is more important than completeness.

### Rules
1. **Only write what you've verified in source code**
   - Every function name should exist in the codebase
   - Every parameter name and type should match the source
   - Every relationship (A calls B, A extends B) should be verifiable in code

2. **When uncertain, omit rather than guess**
   - If you're not sure, don't write it
   - A shorter document with only verified facts is better than a longer document with errors

3. **Common hallucination patterns to avoid**:
   - Inventing function names that "sound right"
   - Describing parameters that don't exist
   - Claiming relationships between components without code evidence
   - Using vague words like "handles", "manages", "processes" without specific implementation details
   - Making architecture claims based on assumptions

4. **Self-check before every write**:
   - "Did I actually see this in the source code?"
   - "Can I point to the exact line that proves this?"
   - "Am I making an assumption or stating a verified fact?"

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
        // - id: internal identifier (immutable, used for L3 filenames, page_groups, retry references)
        // - name: display name and output filename (can be refined by L4)
        interface ComponentDef { id: string; name: string; files: string[]; description: string }

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
` + getDeepThinkingProtocol() + `
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
3. **Incremental Writing**: File write/create operations have output size limits. Read/search are unlimited, but you MUST write section-by-section with \`${editToolNameForPrompt}\`. Writing all at once will fail.
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
    "id": "Auth_Module",
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
` + getDeepThinkingProtocol() + `
## Input
- **Project Context**: Read \`${intermediateDir}/L1/project_context.md\` thoroughly. Pay special attention to:
  - **Entry Points**: Start your exploration from these files
  - **Architecture Pattern**: Use this to inform how you group components
  - **Vocabulary**: Use these exact terms in component names and descriptions
  - **Key Abstractions**: These often map directly to components
  - **Generated/Excluded Code**: Skip these entirely
- **Excluded Roots**: Read \`${intermediateDir}/L1/existing_deepwikis.md\` and exclude those directories entirely from analysis

## Goal
Build the component list **incrementally, ONE component at a time**. Each iteration: read existing JSON, add ONE new component, save. This prevents output size limits.

## Workflow (INCREMENTAL - CRITICAL)
1. Read the L1 project context thoroughly - especially Entry Points, Architecture Pattern, Vocabulary, and Key Abstractions.
2. Identify excluded roots from \`${intermediateDir}/L1/existing_deepwikis.md\` and DO NOT read/include any files under those roots.
3. Read \`${intermediateDir}/L2/component_list.json\` using file read tools:
   - If it doesn't exist or is empty, start with an empty array \`[]\`
   - If it exists, parse the existing components and note which files are already covered
4. Start exploration from the **Entry Points** identified in L1. Identify which source files are NOT YET covered by any existing component.
5. From the uncovered files, **read their contents** to understand what each file does, then identify ONE cohesive component (files that work together).
6. **Use Vocabulary terms** from L1 in your component names and descriptions for consistency.
7. **Verify each file exists** before adding it to the files array.
8. **Add ONLY that ONE component** (with \`id\`, \`name\`, \`files\`, \`description\`) to the array and use \`${editToolNameForPrompt}\` to write immediately.
9. **Repeat steps 3-8** until all significant source files are covered.

**IMPORTANT**: Add components ONE AT A TIME. Do NOT try to output all components at once.

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
Each component must have:
- \`id\`: Internal identifier (filename-safe, immutable after creation). Used for L3 analysis filenames and internal references.
- \`name\`: Display name (initially same as id, but L4 may refine it later). Used for page filenames and headings.
- \`files\`: Array of source file paths
- \`description\`: Brief description of the component's purpose

Example:
${jsonExample}

> IMPORTANT: Set \`id\` and \`name\` to the same value initially. The \`id\` will never change, but \`name\` may be refined by L4.

## Constraints
1. **Files**: The "files" array must contain actual file paths with extensions (e.g., "src/auth/auth.ts"), NOT directory paths.
2. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
3. **Chat Final Response**: Keep your chat reply brief (e.g., "Added N components, total M."). Do not include JSON or file contents.
4. **Naming**: Use filename-safe values for \`id\` (no \`/\`, no spaces). Use \`_\` as a separator, e.g. \`Editor_Core\`, \`Configuration_System\`.
5. **JSON Strictness**: Output must be a single JSON array (starts with \`[\` and ends with \`]\`), no trailing commas, no comments.
6. **Incremental Writes (CRITICAL)**: File write/create operations have output size limits. Read/search operations are unlimited, but you MUST write incrementally - add ONE component, save, repeat. Writing all at once will fail.

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
` + getDeepThinkingProtocol() + `
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
3. **Incremental Writing**: File write/create operations have output size limits. Read/search are unlimited, but write the review report incrementally if it is long.

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
` + getDeepThinkingProtocol() + `
## Goal
Refine the component list based on review feedback, applying fixes **ONE AT A TIME** to avoid output size limits.

## Input
- Component List: \`${intermediateDir}/L2/component_list.json\`
- Review: \`${intermediateDir}/L2/review_report.md\`
- Excluded Roots: \`${intermediateDir}/L1/existing_deepwikis.md\`

## Workflow (INCREMENTAL - CRITICAL)
1. Read the Component List and the Review Report using file read tools.
2. Identify all issues flagged in the review.
3. **Apply ONE fix at a time**:
   - Read the current JSON using file read tools
   - Apply ONE modification (add/remove/update one component)
   - Produce valid JSON with \`id\`, \`name\`, \`files\`, and \`description\` for each component
   - Use \`${editToolNameForPrompt}\` to write the updated JSON immediately
   - Repeat for each remaining fix
4. Remove any file paths that fall under excluded roots.
5. Ensure: (a) no missing core files, (b) no duplicate \`id\` values, (c) each component has a clear purpose. Note: The same file CAN appear in multiple components.

**IMPORTANT**: Apply changes ONE AT A TIME. Do NOT try to output the entire modified list at once.${retryContextL2}

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
- Format must be a valid non-empty JSON array with \`{id, name, files, description}\` for each component.

## Constraints
1. **File Existence**: All file paths in the "files" array MUST exist. Fix typos/paths where possible; remove only if truly unfixable.
2. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
3. **Chat Final Response**: Keep your chat reply brief (e.g., "Applied N fixes, total M components."). Do not include JSON or file contents.
4. **ID/Name**: The \`id\` must be filename-safe (no \`/\`, no spaces). Use \`_\` as a separator. Set \`id\` and \`name\` to the same value (L4 may refine \`name\` later).
5. **Incremental Writes (CRITICAL)**: File write/create operations have output size limits. Read/search operations are unlimited, but you MUST write incrementally - apply ONE fix, save, repeat. Writing all at once will fail.

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
                    const missingComponentIds: string[] = [];
                    for (const component of componentList) {
                        // Page filename uses `name`, check if file exists
                        const pageUri = vscode.Uri.file(
                            path.join(workspaceFolder.uri.fsPath, outputPath, 'pages', `${component.name}.md`)
                        );
                        try {
                            await vscode.workspace.fs.stat(pageUri);
                        } catch {
                            // Track by id for matching
                            missingComponentIds.push(component.id);
                        }
                    }

                    if (missingComponentIds.length > 0) {
                        logger.warn(
                            'DeepWiki',
                            `Resume detected ${missingComponentIds.length} missing page(s). Auto-running L5 Writer for missing components.`
                        );
                        componentsToAnalyze = componentList.filter(c => missingComponentIds.includes(c.id));
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
                    const originalIndex = componentList.findIndex(c => c.id === component.id);
                    const paddedIndex = String(originalIndex + 1).padStart(3, '0');
                    const analysisFileUri = vscode.Uri.file(
                        path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L3', `${paddedIndex}_${component.id}_analysis.md`)
                    );
                    return () => this.runPhase(
                        `L3: Analyzer (Loop ${loopCount + 1}, ${component.name})`,
                        `Analyze component`,
                        `# Analyzer Agent (L3)

## Role
- **Your Stage**: L3 Analyzer (Analysis Loop - may retry up to 5 times)
- **Core Responsibility**: Deep analysis - understand HOW code works, trace event/state causality, create diagrams
- **Critical Success Factor**: L4 and L5 depend on your analysis - be thorough and accurate

## Anti-Hallucination (Generator Focus)
Apply the Anti-Hallucination Rules from Deep Thinking Protocol. As a content generator:
- Only write claims you can directly support with code evidence (use CEI format)
- If you cannot find clear evidence for something, OMIT it entirely - do not guess
- Use exact symbol names from source code; never invent names that "sound right"
- When uncertain about behavior, describe what the code literally does, not what it might do
` + getDeepThinkingProtocol() + `
## Reasoning Style (Priority)
- **Causal-chain-first**: Prioritize explaining causality over summarization.
- Keep the write-up grounded in the assigned source files (use real function/class/event names and file paths as anchors).

## Depth Targets (Write More Than a Summary)
Your output must be detailed enough that L4 can reconstruct architecture and relationships without re-reading source code.

Requirements are classified as:
- **MUST**: Minimum requirements. Analysis will be rejected if not met.
- **SHOULD**: Recommended for comprehensive analysis.

### Component Size Guide
Determine component size from the assigned component's file list, then apply requirements accordingly:

| Size | Files | LOC | Requirements |
|------|-------|-----|--------------|
| **Small** | 1-2 | <300 | MUST only |
| **Medium** | 3-5 | 300-1000 | MUST + most SHOULD |
| **Large** | 6+ | >1000 | MUST + all SHOULD |

*Count files from the component definition. Estimate LOC by reading source files.*

### Anchors & Symbols
- **MUST**: Include **at least 10 concrete anchors** in the form \`path/to/file.ts::SymbolName\`
- **SHOULD**: Target **20+ anchors** for comprehensive coverage (functions, classes, events, commands, services, config keys, constants, type definitions)
- **SHOULD**: Document all public methods and their signatures for major types/classes
- **SHOULD**: Reference configuration keys, environment variables, and magic strings with their locations

### Critical Flows
- **MUST**: Include **at least 2 critical end-to-end flows** with step-by-step sequences
- **SHOULD**: Target **4–6 flows** for complex components
- **MUST**: Each flow must include **at least 3 steps** with concrete function/method references
- **SHOULD**: Each flow includes **5+ steps** with both success and failure paths

### Edge Cases & Error Handling
- **MUST**: Include **at least 4 edge cases / failure modes** visible in code paths
- **SHOULD**: Target **8+ edge cases** covering validation, fallbacks, cancellation, retries, timeout handling, resource cleanup
- **SHOULD**: For each edge case, specify trigger condition, handling mechanism, and recovery behavior
- **SHOULD**: Document error propagation patterns

### CEI Blocks (Claims → Evidence → Implication)
- **MUST**: Write **at least 8 CEI blocks** across the document
- **SHOULD**: Target **18+ CEI blocks** distributed across sections: Key Logic (6+), Causal Analysis (4+), Data Flow (4+), Edge Cases (4+)
- **MUST**: Each CEI block must include **≥ 2 Evidence anchors**
- **SHOULD**: Each CEI block includes **≥ 3 Evidence anchors** with line-level references

### Data Flow Paths
- **MUST**: Include **at least 1 data flow path** showing input → processing → output
- **SHOULD**: Target **4+ data flow paths** with data shape changes documented at each step
- **SHOULD**: Identify data validation checkpoints and failure handling

### Diagrams
- **MUST**: Include **at least 1 Mermaid diagram** (stateDiagram-v2 or sequenceDiagram)
- **SHOULD**: Include **3+ diagrams**: stateDiagram-v2, sequenceDiagram, and one additional (classDiagram, C4Context, or block)
- **MUST**: Each diagram must have **at least 4 nodes/states**
- **SHOULD**: Each diagram has **6+ nodes/states** showing meaningful relationships

### Quality Bar (All MUST)
- Prefer specifics over generalities; if you can't justify a claim from code, omit it
- Every claim must trace back to a concrete code location
- If a section seems thin, dig deeper into the source code before moving on

## Claims → Evidence → Implication (CEI) Format
Write key statements as CEI blocks so downstream stages can verify and reuse them. CEI blocks provide verifiable, reusable facts for L4/L5.

### CEI Structure (MUST use this format)
- Claim: [precise, verifiable statement about code behavior]
  - Evidence: \`path/to/file.ts:L42::functionName\` — [explanation of how this supports the claim]
  - Evidence: \`path/to/file.ts:L78::ClassName.methodName\` — [additional evidence]
  - Implication: [concrete consequence for behavior/architecture/integration]

### CEI Quality Requirements
- **MUST (Specificity)**: Claims must be precise enough to be falsifiable (e.g., "validates input using Zod schema" not "handles validation")
- **MUST (Evidence Depth)**: Each evidence must explain WHY it supports the claim, not just WHERE the code is
- **SHOULD (Line References)**: Include line numbers (e.g., \`:L42\`) for easier verification
- **SHOULD (Cross-file Tracing)**: When behavior spans files, include evidence from all relevant files

### CEI Categories
Ensure coverage across categories:
| Category | MUST | SHOULD |
|----------|------|--------|
| **Behavioral**: What the code does | 3+ | 6+ |
| **Structural**: How code is organized | 2+ | 4+ |
| **Contractual**: Guarantees made/expected | 2+ | 4+ |
| **Failure**: How errors are handled | 1+ | 4+ |

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
3. Create empty file \`${intermediateDir}/L3/${paddedIndex}_${component.id}_analysis.md\`
4. Read source code files for this component
5. Token-stability workflow (do NOT write all at once):
   - Use \`${editToolNameForPrompt}\` after EACH section.
   - Prefer short bullets/tables over long paragraphs.
   - If you are running out of space, stop adding narrative first; do NOT drop CEI anchors.
   - Keep each \`${editToolNameForPrompt}\` small (aim: one section at a time; avoid huge single patches).
6. Priority order (highest → lowest):
   1) CEI blocks (with evidence anchors) → 2) Data Flow paths → 3) Diagrams → 4) Critical flows → 5) Narrative summary
7. For each analysis section: Analyze → Use \`${editToolNameForPrompt}\` to write
   - Overview and Architecture
   - Key Logic
   - **Causal Analysis** (see below)
   - **Data Flow Analysis** (see below)
   - Edge Cases & Failure Modes
   - Integration Points & Dependencies
8. Create Mermaid diagrams → Use \`${editToolNameForPrompt}\` to write
   - **Recommended**: \`stateDiagram-v2\` (for state causality), \`sequenceDiagram\` (for event flow), \`C4Context\`, \`classDiagram\`, \`block\`
   - **Forbidden**: \`flowchart\`, \`graph TD\`

## Causal Analysis Requirements
Analyze the source code and document cause-and-effect relationships. This section should answer "why does X happen?" for significant behaviors.

### Event Causality
- **MUST**: Document **at least 2 event chains** showing how events propagate
- **SHOULD**: Target **4+ complete chains** with full paths (trigger → handler → state change → side effects)
- **MUST**: Identify primary event sources (user actions, system events, external events)
- **SHOULD**: For each event type, list all listeners and their side effects
- **SHOULD**: Document debouncing, throttling, or sequencing constraints if present

### State Causality
- **MUST**: Identify **at least 3 key state variables** with their mutation triggers
- **SHOULD**: Target **6+ state variables** with full analysis
- **SHOULD**: Map state dependencies with concrete examples
- **SHOULD**: For each state change, trace downstream effects (UI updates, side effects, cascaded updates)

### Temporal Relationships
**Include if**: Component uses Promise/async-await, setTimeout/setInterval, event listeners, or has operations that must complete in order.

- **SHOULD**: Document ordering constraints (what must happen before what)
- **SHOULD**: Identify race conditions and their handling mechanisms
- **SHOULD**: Describe async coordination (locks, queues, debouncing)

**Skip if**: All functions are synchronous with no callbacks, timers, or external event handling.

### Causal Diagrams
- **MUST**: Create **at least 1 diagram** showing state/event flow
- **SHOULD**: Create **2 diagrams**: stateDiagram-v2 (4+ states) and sequenceDiagram (4+ participants)

Example stateDiagram-v2:
\`\`\`mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Loading : submit
    Loading --> Success : response
    Loading --> Error : error
    Success --> Idle : reset
    Error --> Idle : dismiss
\`\`\`

Example sequenceDiagram:
\`\`\`mermaid
sequenceDiagram
    participant U as User
    participant C as Component
    participant S as Service
    participant API as API

    U->>C: action
    C->>S: process
    S->>API: request
    API-->>S: response
    S-->>C: result
    C-->>U: update
\`\`\`

## Data Flow Analysis Requirements
Trace how data moves through the component from input to output.

### Data Entry Points
- **MUST**: Identify **at least 2 data entry points** with source type and entry function
- **SHOULD**: Create input types table with schema, required/optional fields
- **SHOULD**: Document validation gates (validation function, rules, failure handling)

### Data Transformation Pipeline
- **MUST**: Document **at least 2 transformation steps** (e.g., parse → validate → transform → output)
- **SHOULD**: Target **4+ transformation steps** with input/output types
- **SHOULD**: Document data shape changes at each step
- **SHOULD**: Identify branching points where data flow splits

### Data Output & Persistence
- **MUST**: Identify **at least 1 output destination** with format
- **SHOULD**: Document all output destinations with serialization method
- **SHOULD**: Document persistence points (storage type, lifetime, read/write patterns)

### Data Integrity & Validation (SHOULD)
- Validation checkpoint table (location, type, failure handling)
- Error boundaries and recovery behavior
- Data contracts (input/output guarantees)

### Data Flow Diagram
- **MUST**: Include **at least 1 diagram** showing data transformation flow
- **SHOULD**: Include a sequenceDiagram with 4+ participants

Example:
\`\`\`mermaid
sequenceDiagram
    participant In as Input
    participant V as Validator
    participant T as Transformer
    participant Out as Output

    In->>V: raw data
    V->>T: validated
    T->>Out: transformed
\`\`\`

## Output
Write Markdown to \`${intermediateDir}/L3/${paddedIndex}_${component.id}_analysis.md\` using this structure (example only; do not wrap the whole file in fences):
${mdCodeBlock}markdown
# ${component.name} - Analysis

## File Structure
| File | Purpose | Key Exports |
|------|---------|-------------|
| path/to/file.ts | ... | Symbol1, Symbol2 |

## Overview and Architecture
- Architecture pattern: ...
- Design rationale: ...
- Key responsibilities: ...

## Key Logic

### Key Types & APIs
| Symbol | Location | Signature | Responsibility |
|--------|----------|-----------|----------------|
| ClassName | path/to/file.ts:L10 | class ClassName | ... |
| methodName | path/to/file.ts:L42 | (args) => ReturnType | ... |

### Public Interface
| Method/Property | Type | Description |
|-----------------|------|-------------|
| ... | ... | ... |

### Critical Flows (4-6 flows, each with 5+ steps)
#### Flow 1: [Name]
1. Entry: \`file.ts::entryPoint\` receives trigger
2. Validation: \`file.ts::validate\` checks input
3. Processing: \`file.ts::process\` transforms data
4. Side effect: \`file.ts::notify\` emits event
5. Return: formatted result to caller

#### Flow 2: [Name] (Failure Path)
1. ...

### CEI Blocks (Key Logic) - at least 6 blocks
- Claim: [precise behavioral claim]
  - Evidence: \`path/to/file.ts:L42::functionName\` — [explanation]
  - Evidence: \`path/to/file.ts:L78::ClassName.method\` — [explanation]
  - Evidence: \`path/to/other.ts:L15::CONSTANT\` — [explanation]
  - Implication: [concrete consequence]

## Causal Analysis

### State Inventory
| State Variable | Type | Initial Value | Mutators |
|----------------|------|---------------|----------|
| ... | ... | ... | ... |

### Event Chains (at least 4 chains)
1. **[Event Name]**: trigger → handler → state change → side effects → UI update
2. ...

### State Dependencies
- \`stateA\` depends on: \`stateB\`, \`stateC\`
- \`derivedState\` = computed from \`stateX\` + \`stateY\`

### Temporal Constraints
- [ordering requirement 1]
- [race condition handling]

### CEI Blocks (Causality) - at least 4 blocks
- Claim: ...
  - Evidence: \`...\`
  - Evidence: \`...\`
  - Evidence: \`...\`
  - Implication: ...

## Data Flow Analysis

### Data Entry Points
| Entry Point | Source | Type/Schema | Validation |
|-------------|--------|-------------|------------|
| ... | ... | ... | ... |

### Data Transformation Pipeline
| Step | Function | Input → Output | Side Effects |
|------|----------|----------------|--------------|
| 1. Parse | \`file.ts::parse\` | RawInput → ParsedData | none |
| 2. Validate | \`file.ts::validate\` | ParsedData → ValidData | throws on invalid |
| 3. Transform | \`file.ts::transform\` | ValidData → Enriched | none |
| 4. Persist | \`file.ts::save\` | Enriched → Stored | writes to DB |

### Data Shape Evolution
- Raw: \`{ raw: string }\`
- Parsed: \`{ data: object, meta: object }\`
- Validated: \`{ ...data, valid: true }\`
- Output: \`{ result: ProcessedData }\`

### Data Output & Persistence
| Destination | Type | Format | Lifetime |
|-------------|------|--------|----------|
| ... | ... | ... | ... |

### CEI Blocks (Data Flow) - at least 4 blocks
- Claim: ...
  - Evidence: \`...\`
  - Evidence: \`...\`
  - Evidence: \`...\`
  - Implication: ...

## Edge Cases & Failure Modes (at least 8 items)
| Scenario | Trigger | Handling | Recovery |
|----------|---------|----------|----------|
| Invalid input | malformed data | validation error thrown | caller retry |
| Timeout | network delay > 30s | AbortController cancels | exponential backoff |
| ... | ... | ... | ... |

### Error Propagation
- Errors at layer X bubble up to layer Y
- Error transformation: InternalError → UserFacingError

## Integration Points & Dependencies

### Upstream (who calls this component)
| Caller | Trigger | Expected Response |
|--------|---------|-------------------|
| ... | ... | ... |

### Downstream (what this component calls)
| Dependency | Purpose | Failure Impact |
|------------|---------|----------------|
| ... | ... | ... |

### Contracts
- Events emitted: \`event.name\` with payload \`{...}\`
- Events consumed: \`other.event\` expecting payload \`{...}\`
- Config keys: \`CONFIG_KEY\` (type, default, description)

## Diagrams

### State Diagram (minimum 8 states)
${mdCodeBlock}mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Validating : submit
    Validating --> Loading : valid
    Validating --> Error : invalid
    Loading --> Processing : response
    Loading --> Error : timeout
    Processing --> Success : complete
    Processing --> Error : failed
    Success --> Idle : reset
    Error --> Idle : dismiss
${mdCodeBlock}

### Sequence Diagram (minimum 6 participants)
${mdCodeBlock}mermaid
sequenceDiagram
    participant U as User
    participant C as Component
    participant V as Validator
    participant S as Service
    participant A as API
    participant D as Database

    U->>C: action
    C->>V: validate
    V-->>C: result
    C->>S: process
    S->>A: request
    A->>D: query
    D-->>A: data
    A-->>S: response
    S-->>C: result
    C-->>U: update
${mdCodeBlock}

### Data Flow Diagram
${mdCodeBlock}mermaid
sequenceDiagram
    participant In as Input
    participant V as Validator
    participant T as Transformer
    participant P as Persister
    participant Out as Output

    In->>V: raw data
    V->>T: validated
    T->>P: transformed
    P->>Out: persisted
${mdCodeBlock}
${mdCodeBlock}
- Do not wrap the entire file in Markdown fences.
- Mermaid diagrams must be in \`\`\`mermaid fences.
- Avoid large raw code pastes; reference symbols/paths instead.

## Constraints
1. **Scope**: Only write under \`.deepwiki/\`. Read source code as needed. You may edit \`${intermediateDir}/L1/project_context.md\` if you find inaccuracies.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.
3. **Incremental Writing**: File write/create operations have output size limits. Read/search are unlimited, but you MUST use \`${editToolNameForPrompt}\` after each instruction step. Writing all at once will fail.
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
                    const originalIndex = componentList.findIndex(c => c.id === component.id);
                    const paddedIndex = String(originalIndex + 1).padStart(3, '0');
                    const analysisFile = `${paddedIndex}_${component.id}_analysis.md`;
                    const reviewFile = `${paddedIndex}_${component.id}_review.md`;
                    const retryFile = `${paddedIndex}_${component.id}_retry.json`;
                    return () => this.runPhase(
                        `L3-R: Reviewer (Loop ${loopCount + 1}, ${component.name})`,
                        `Review L3 analysis`,
                        `# L3 Reviewer Agent (L3-R)

## Role
- **Your Stage**: L3-R Reviewer (Quality Gate)
- **Core Responsibility**: Verify L3 analysis meets MUST requirements and contains no fabricated claims.
- **Critical Success Factor**: Catch wrong/invented statements early so they don't propagate.

## Anti-Hallucination (Reviewer Focus)
Apply the Anti-Hallucination Rules from Deep Thinking Protocol strictly. As a reviewer:
- Your job is to CATCH lies, not create content
- If L3 made unverifiable claims, DELETE them - do not try to fix or rewrite
- Request RETRY only when MUST requirements are not met or content is fundamentally broken

## MUST Requirements Checklist
Before issuing PASS, verify the analysis meets ALL MUST requirements:

| Requirement | Minimum | Check |
|-------------|---------|-------|
| Concrete anchors | 10+ | Count \`path/to/file.ts::Symbol\` references |
| Critical flows | 2 flows, 3+ steps each | Count flow sections with step-by-step sequences |
| Edge cases | 4+ | Count edge case bullets |
| CEI blocks | 8+ total | Count \`- Claim:\` lines |
| CEI evidence | 2+ per CEI | Check each CEI has ≥2 Evidence lines |
| Data flow paths | 1+ | Check Data Flow Analysis section exists |
| Diagrams | 1+ with 4+ nodes | Check mermaid blocks |

**RETRY if any MUST requirement is not met.**
` + getDeepThinkingProtocol() + `
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
     - Write \`${intermediateDir}/L3R/${retryFile}\` as \`["${component.id}"]\`
     - Stop (no further steps).

3. **MUST Requirements Check**
   - Count items against the MUST Requirements Checklist above.
   - **IMMEDIATELY** append to review file:
     \`\`\`markdown
     ## MUST Requirements
     | Requirement | Found | Required | Status |
     |-------------|-------|----------|--------|
     | Anchors | {N} | 10+ | {OK/FAIL} |
     | Critical flows | {N} | 2+ | {OK/FAIL} |
     | Edge cases | {N} | 4+ | {OK/FAIL} |
     | CEI blocks | {N} | 8+ | {OK/FAIL} |
     | Data flow section | {Y/N} | Y | {OK/FAIL} |
     | Diagrams | {N} | 1+ | {OK/FAIL} |
     \`\`\`
   - Use \`${editToolNameForPrompt}\` to write this section NOW.
   - If ANY requirement shows FAIL:
     - Append "**Result**: RETRY_REQUIRED - MUST requirements not met"
     - Write \`${intermediateDir}/L3R/${retryFile}\` as \`["${component.id}"]\`
     - Stop (no further steps).

4. **Claim Verification (Incremental)**
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

5. **Diagram Verification (Incremental)**
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

6. **Final Summary and Verdict**
   - Append final summary to \`${intermediateDir}/L3R/${reviewFile}\`:
     \`\`\`markdown
     ## Summary
     - MUST requirements: PASSED
     - Claims processed: {count}, verified: {count}, removed: {count}
     - Diagrams processed: {count}, verified: {count}, fixed: {count}

     ## Final Verdict
     **Result**: PASS
     **Reason**: All MUST requirements met, claims verified against source code.
     \`\`\`
   - Use \`${editToolNameForPrompt}\` to write this final section.
   - Do NOT create retry file if all checks passed.

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

                const l3rRetryIds = Array.from(l3rRetryNamesSet);
                if (l3rRetryIds.length > 0) {
                    logger.log('DeepWiki', `L3 Reviewer requested re-analysis for: ${l3rRetryIds.join(', ')}`);
                    const retryComponents = componentsToAnalyze.filter(c => l3rRetryIds.includes(c.id));
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
` + getDeepThinkingProtocol() + `
## Goal
1. Produce a coherent system overview from ALL L3 analyses.
2. Review and refine component \`name\` values for clarity and consistency.

## Input
- \`${intermediateDir}/L1/project_context.md\` - **Read first** for:
  - **Vocabulary**: Use these exact terms consistently in your overview
  - **Architecture Pattern**: Frame the system architecture within this context
- \`${intermediateDir}/L2/component_list.json\` - Component definitions with \`id\` and \`name\`
- Read ALL files in \`${intermediateDir}/L3/\` (including previous loops) and any necessary source files.

## Workflow

### Part 1: Name Refinement (Do First)
1. Read \`${intermediateDir}/L2/component_list.json\` and all L3 analyses.
2. For each component, evaluate if the current \`name\` is:
   - **Clear**: Does it accurately describe what the component does?
   - **Consistent**: Does it follow naming conventions of other components? (e.g., all use \`_\` separators, similar style)
   - **User-friendly**: Will documentation readers understand it?
3. If a \`name\` needs improvement:
   - Update ONLY the \`name\` field in \`${intermediateDir}/L2/component_list.json\`
   - **NEVER change the \`id\` field** - it must remain unchanged
   - Examples:
     - \`"PKCE_Handler"\` → \`"OAuth2_Authentication"\` (more descriptive)
     - \`"Utils_Misc"\` → \`"String_Utilities"\` (more specific)
     - \`"auth-module"\` → \`"Auth_Module"\` (consistent style)
4. Write changes using \`${editToolNameForPrompt}\` before proceeding to Part 2.

### Part 2: System Overview
5. Read \`${intermediateDir}/L1/project_context.md\` to understand vocabulary and architecture context.
6. Read L3 analysis and confirm key responsibilities/links.
7. Source verification (mandatory):
   - For at least 10 key claims you plan to include in L4, open the referenced source files and verify the claim is consistent with the code.
   - If a claim cannot be confirmed from source, either delete it or rephrase it into a narrower, verifiable statement.
8. Write \`${intermediateDir}/L4/overview.md\`:
   - high-level architecture, major components, rationale ("why this shape?")
9. Write \`${intermediateDir}/L4/relationships.md\`:
   - cross-component event/state causality map
   - include diagrams (see below)
10. Quick self-check: overview matches L3 facts; diagrams render; no raw code pasted.

## Diagrams
- **Required**: at least one \`stateDiagram-v2\` for cross-component state/event flow
- **Recommended**: \`C4Context\`, \`sequenceDiagram\`, \`classDiagram\`, \`block\`
- **Forbidden**: \`flowchart\`, \`graph TD\`

## Output
- \`${intermediateDir}/L2/component_list.json\` - Edit \`name\` fields if refinement needed (keep \`id\` unchanged)
- \`${intermediateDir}/L4/overview.md\`
- \`${intermediateDir}/L4/relationships.md\`
- Include at least TWO diagrams total.

## Constraints
1. **Scope**: Only write under \`.deepwiki/\`. Read source code as needed.
2. **ID Immutability**: NEVER modify \`id\` fields in component_list.json. Only \`name\` can be changed.
3. **Chat Final Response**: One short confirmation line. Do not include file contents.
4. **Incremental Writing**: File write/create operations have output size limits. Read/search are unlimited, but you MUST write section-by-section with \`${editToolNameForPrompt}\`. Writing all at once will fail.${mermaidValidationInstruction}

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
    "pages": ["Auth_Login", "Auth_OAuth2"],
    "rationale": "User identity, permissions, and auth flows"
  },
  {
    "groupName": "Infrastructure",
    "pages": ["Config_Manager", "Logger"],
    "rationale": "Cross-cutting runtime infrastructure"
  }
]
`;
                // NOTE: "pages" array should contain component IDs (not names)

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
` + getDeepThinkingProtocol() + `
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
2. **Valid formats**: project_context.md must remain valid Markdown; component_list.json must remain a valid JSON array of {id, name, files, description}.
3. **Page groups use \`id\`**: Each \`pages\` item must be an exact component \`id\` (not \`name\`, no \`.md\` suffix).
4. Every component \`id\` must appear exactly once across all groups.
5. **Scope**: Only write under \`.deepwiki/\`.
6. **Chat Final Response**: One short confirmation line.
7. **ID Immutability**: When editing component_list.json, NEVER change \`id\` fields. Only \`name\`, \`files\`, \`description\` can be modified.

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

## Anti-Hallucination (Writer Focus)
Apply the Anti-Hallucination Rules from Deep Thinking Protocol. As a documentation writer:
- Stay grounded in L3 analysis - do not add claims beyond what L3 supports
- If L3 is vague on a topic, keep your writing equally brief rather than elaborating
- Verify symbol names against L3's evidence anchors before using them
- When in doubt, write less - L6 can request retry if content is insufficient
` + getDeepThinkingProtocol() + `
## Input
- Assigned Component: ${JSON.stringify({ id: component.id, name: component.name, files: component.files, description: component.description })}
  - \`id\`: Internal identifier (use to find L3 analysis file: \`{index}_{id}_analysis.md\`)
  - \`name\`: Display name (use for output filename and page H1 heading)
- For each component, read the matching L3 analysis file in \`${intermediateDir}/L3/\` (named like \`001_{id}_analysis.md\`)
- **Project Context**: Read \`${intermediateDir}/L1/project_context.md\` for:
  - **Vocabulary**: Use these exact terms consistently in your documentation
  - **Architecture Pattern**: Frame explanations within this architectural context

## Workflow
1. Read \`${intermediateDir}/L1/project_context.md\` to understand vocabulary and architecture context
2. For EACH assigned component: Create \`${outputPath}/pages/{name}.md\` with the page title (H1: \`# {name}\`) and Overview section
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

## Content Quality Requirements

### Minimum Content Depth
To ensure pages are detailed and useful, each section must meet these minimum requirements:

**## Summary** (2-3 substantial paragraphs minimum):
- **Paragraph 1 (3-5 sentences)**: What this component/module does, its primary purpose and responsibility in the system
- **Paragraph 2 (3-5 sentences)**: Key architectural decisions, design patterns used, and why they were chosen
- **Paragraph 3 (2-4 sentences)**: High-level context of where this fits in the overall system

**## Use Cases** (3-5 concrete use cases minimum):
- Each use case must include:
  - When/why to use this (triggering conditions, context)
  - Step-by-step workflow or example scenario (3-5 steps)
  - Expected outcomes and side effects
- Use cases should cover common scenarios, edge cases, and "when NOT to use" guidance

**## Internal Mechanics Details** (substantial content):
- Explain not just WHAT the code does, but WHY it does it that way
- For each major component/module/class:
  - Purpose and responsibility (2-3 sentences)
  - How it works internally (causal flow with specific function/method names)
  - State management approach (if applicable)
  - Key algorithms or logic patterns (2-4 sentences each)
- Include at least 1-2 code flow examples tracing through actual function calls
- Minimum 4-6 substantial paragraphs for this section overall

**## External Interface** (comprehensive API documentation):
- For each public method/function/event:
  - Purpose and when to call it (2-3 sentences)
  - Parameters with types and descriptions
  - Return value and its meaning
  - Side effects or state changes it triggers
  - Related methods or typical call sequences
- Use tables for quick reference, but add prose explanations after tables

**Element-Level Subsections** (if splitting Internal Mechanics):
- Each element must have consistent level of detail
- If one element gets 3 paragraphs of explanation, ALL elements should get 2-4 paragraphs
- Each element must include: use cases (3+ bullets), mechanics (2-3 paragraphs), state diagram

### Consistency Guidelines
**Granularity**: All components/modules/elements at the same hierarchical level should receive similar depth of coverage:
- If explaining one service with 3 methods in detail, explain ALL services with similar detail
- If one element has a 5-step workflow explanation, others should have 3-7 step explanations (similar scale)
- Avoid mixing high-level summaries with low-level implementation details in the same section

**Completeness**: Do NOT skip sections or use placeholders. Every section in the template must be filled with actual content.

### Template
` + pageTemplate + `

## Output
Write files to \`${outputPath}/pages/\`.

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.
3. **Incremental Writing**: File write/create operations have output size limits. Read/search are unlimited, but you MUST use \`${editToolNameForPrompt}\` after each instruction step. Writing all at once will fail.
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
                    id: c.id,
                    name: c.name,
                    file: `${c.name}.md`
                }));
                await this.runPhase(
                    `L5-V: Validator (Loop ${loopCount + 1})`,
                    'Validate L5 output files',
                    `# L5 Validator Agent

## Role
Quality gate for L5 outputs: ensure expected page files exist.
` + getDeepThinkingProtocol() + `
## Expected Files
Directory: \`${outputPath}/pages/\`
Files to verify (filename derived from \`name\`, report missing by \`id\`):
${l5ExpectedPages.map(p => `- \`${p.file}\` (id: ${p.id})`).join('\n')}

## Workflow
1. List files in \`${outputPath}/pages/\`
2. Compare against expected files above
3. If ALL files exist → Write empty array to \`${intermediateDir}/L5V/page_validation_failures.json\`
4. If ANY files are MISSING → Write JSON array of missing component **id** values to \`${intermediateDir}/L5V/page_validation_failures.json\`

## Output
Write to \`${intermediateDir}/L5V/page_validation_failures.json\`:
- If all present: \`[]\`
- If missing: \`["component_id_1", "component_id_2"]\` (use \`id\`, not \`name\`)

## Constraints
1. Keep response brief (e.g., "Validation complete.")
`,
                    token,
                    options.toolInvocationToken
                );

                // Check L5 validation result and retry failed pages
                const l5FailuresUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L5V', 'page_validation_failures.json'));
                let l5FailedIds: string[] = [];
                try {
                    const content = await vscode.workspace.fs.readFile(l5FailuresUri);
                    const parsed = this.parseJson<unknown>(new TextDecoder().decode(content));
                    if (Array.isArray(parsed) && parsed.every(p => typeof p === 'string')) {
                        l5FailedIds = parsed;
                    } else {
                        logger.warn('DeepWiki', 'L5-V: page_validation_failures.json is not a string array; retrying all pages for safety.');
                        l5FailedIds = componentsToAnalyze.map(c => c.id);
                    }
                    await vscode.workspace.fs.delete(l5FailuresUri);
                } catch { /* no failures file or invalid */ }

                if (l5FailedIds.length > 0) {
                    logger.log('DeepWiki', `L5 Validator requested retry for ${l5FailedIds.length} page(s): ${l5FailedIds.join(', ')}`);
                    // Retry using the same task generator function
                    const failedComponents = componentsToAnalyze.filter(c => l5FailedIds.includes(c.id));
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
                    : `If a page has MAJOR missing information or wrong analysis, list the component **id** values that need re-analysis (L3/L4/L5) in "` + intermediateDir + `/L6/retry_request.json".
                       Format: ["Auth_Module", "Utils"] (use \`id\`, not \`name\`).
                       For minor issues (typos, formatting, broken links), fix the page directly.`;

	                await this.runPhase(
	                    `L6: Page Reviewer (Loop ${loopCount + 1})`,
	                    'Review pages and decide on retries',
	                    `# Page Reviewer Agent (L6)

## Role
- **Your Stage**: L6 Reviewer (Analysis Loop - Quality Gate)
- **Core Responsibility**: Final quality gate - verify accuracy against source code, fix minor issues, request retry for major problems
- **Critical Success Factor**: You are the last line of defense before final output - be thorough

## Anti-Hallucination (Final Gate Focus)
Apply the Anti-Hallucination Rules from Deep Thinking Protocol. As the final quality gate:
- You are the LAST defense before output - verify actively, don't just skim
- Common issues to catch: non-existent functions, wrong parameter types, fabricated relationships
- When deleting, prefer removing the smallest incorrect unit (sentence/row) rather than entire sections
` + getDeepThinkingProtocol() + `
## Goal
Check pages in \`${outputPath}/pages/\` for quality based on ALL L3 analysis files.

## Input
- Read generated pages in \`${outputPath}/pages/\`
- Read relevant L3 analysis files in \`${intermediateDir}/L3/\` (named by \`id\`: \`{index}_{id}_analysis.md\`)
- Read \`${intermediateDir}/L2/component_list.json\` to map components:
  - \`id\`: Internal identifier (use for L3 file lookup and retry requests)
  - \`name\`: Display name (page filename is \`{name}.md\`)

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
   - Read \`${intermediateDir}/L2/component_list.json\` and compute expected page files: \`{name}.md\` (1 component = 1 page).
   - List files in \`${outputPath}/pages/\`.
   - Identify:
     - Missing pages: expected but not present
     - Extra pages: present but not in component_list (these should usually be deleted unless clearly intentional)
   - **IMMEDIATELY** append inventory results to \`${intermediateDir}/L6/review_report.md\`:
     \`\`\`markdown
     ## Inventory
     - Expected pages: {count}
     - Found pages: {count}
     - Missing: {list of names or "None"}
     - Extra: {list or "None"}
     \`\`\`
   - Use \`${editToolNameForPrompt}\` to write this section NOW before proceeding.
   - If any pages are missing:
     - ${isLastLoop ? 'Do NOT request retries; add a prominent warning note to README and/or affected areas about missing pages.' : `Write \`${intermediateDir}/L6/retry_request.json\` as a raw JSON array of the missing component **id** values (not names).`}

3. **Page-by-Page Review (Incremental)**
   For EACH existing page (filename from \`name\`, lookup L3 by \`id\`), perform the following sub-steps IN ORDER:

   a. **Read and Check**
      - Read the page file
      - Check ALL of the following:
        - **Page Title Consistency**: Verify the page's H1 heading matches the component's \`name\` from component_list.json.
          - If there's a mismatch, update the page's H1 heading to match \`name\`.
          - Note: L4 Architect already refined \`name\` for clarity, so just ensure consistency.
        - **File Structure**: Ensure the "File Structure" section includes an accurate list of source files (populate it from \`${intermediateDir}/L2/component_list.json\`; remove any non-existent paths).
        - **No placeholders**: Remove/replace obvious placeholders (e.g., "TODO", "TBD", "{...}").
        - **Element-level use cases**: If "## Internal Mechanics Details" is split into multiple element subsections, ensure EACH element subsection includes a concrete use case explanation (why/when to use it, pitfalls).
        - **Element-level diagrams**: If "## Internal Mechanics Details" is split into multiple element subsections, ensure EACH element subsection includes a \`stateDiagram-v2\` describing that element's state transitions (trivial single-state diagram is acceptable for stateless elements).
        - **Accuracy**: Verify statements against ACTUAL SOURCE CODE using the file list in "File Structure" (and \`${intermediateDir}/L2/component_list.json\`) as the starting set. If a statement cannot be verified, DELETE the smallest possible block (sentence/row) rather than guessing.
        - **Signatures**: If you list API signatures, verify they match the source; keep them brief (no bodies).
        - **Connectivity**: Fix broken links; ensure links target existing final files under \`${outputPath}/\`.
        - **Formatting**: Fix broken Markdown tables or Mermaid syntax errors.
        - **Intermediate Links**: Check for any references to intermediate artifacts (intermediate/, ../L3/, ../L4/, etc.)
        - **Content Depth**: Verify each section meets minimum content requirements:
          - Summary: 2-3 substantial paragraphs (check paragraph count and sentence count)
          - Use Cases: 3-5 concrete use cases with detailed explanations (not just bullet points)
          - Internal Mechanics Details: 4-6 substantial paragraphs minimum, with specific function/method names and causal explanations
          - External Interface: Detailed explanation for each API, not just tables
          - If a section is too shallow (e.g., only 1-2 sentences, vague descriptions, missing details), this is a MAJOR ISSUE requiring retry
        - **Granularity Consistency**: Verify consistent level of detail across all elements:
          - If the page has multiple components/modules/elements, check that they all receive similar depth of coverage
          - Count paragraphs/sentences for each element - they should be within similar range (e.g., if one element has 3 paragraphs, others should have 2-4)
          - Check that all elements have similar structure (use cases, mechanics explanation, diagrams)
          - Mixing 1-sentence summaries with 5-paragraph detailed explanations is inconsistent and requires retry

   b. **Write Review Result (IMMEDIATELY after each page check)**
      - **IMMEDIATELY** append this page's review result to \`${intermediateDir}/L6/review_report.md\`:
        \`\`\`markdown
        ### {PageName}.md
        - Status: {OK / Issues Found}
        - Title: {OK / Updated to match name}
        - File Structure: {OK / Fixed / N/A}
        - Placeholders: {None found / Removed: ...}
        - Element use cases: {OK / Added / N/A}
        - Element diagrams: {OK / Added / N/A}
        - Accuracy issues: {None / Removed: ...}
        - Links: {OK / Fixed: ...}
        - Formatting: {OK / Fixed: ...}
        - Intermediate links: {None / Removed: ...}
        - Content depth: {OK / INSUFFICIENT - specify which sections are too shallow}
        - Granularity consistency: {OK / INCONSISTENT - specify which elements have uneven detail}
        \`\`\`
      - Use \`${editToolNameForPrompt}\` to write this section NOW.

   c. **Fix Issues (if any)**
      - **Minor issues** (formatting, broken links, missing diagrams, placeholders): Fix directly in the page file using \`${editToolNameForPrompt}\`.
      - **Major issues** requiring retry (add component id to retry list):
        - Content depth: Multiple sections are too shallow (e.g., Summary has only 1 paragraph, Use Cases has only 1-2 items, Internal Mechanics has only 1-2 paragraphs)
        - Granularity consistency: Significant imbalance in detail level (e.g., one element has 5 paragraphs, another has 1 sentence)
        - Fundamental accuracy problems that cannot be fixed by simple edits
      - Only proceed to the next page AFTER writing the review result AND fixing minor issues (or noting major issues for retry).

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
  - The file must be a raw JSON array of component **id** values, e.g. \`["Auth_Module"]\` (use \`id\`, not \`name\`).

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **No guessing**: If you can't verify, delete rather than invent.
3. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.
4. **Incremental Writing**: File write/create operations have output size limits. Read/search are unlimited, but you MUST use \`${editToolNameForPrompt}\` after each instruction step. Writing all at once will fail.${mermaidValidationInstruction}

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
                    // Filter componentList to get the actual component objects for retry (match by id)
                    componentsToAnalyze = componentList.filter(c => retryNames!.includes(c.id));
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
` + getDeepThinkingProtocol() + `
## Input
- \`${intermediateDir}/L1/project_context.md\` - **Read first** for:
  - **Vocabulary**: Use these exact terms consistently in the README
  - **Architecture Pattern**: Frame the system description within this context
  - **Entry Points**: Reference these when describing where to start
- \`${intermediateDir}/L4/overview.md\`
- \`${intermediateDir}/L4/relationships.md\`
- \`${intermediateDir}/L2/component_list.json\` (source of truth for pages; 1 component = 1 page)
  - \`id\`: Internal identifier (used in page_groups.json)
  - \`name\`: Display name (page filename is \`{name}.md\`, use for link text)
- \`${intermediateDir}/L5/page_groups.json\` (source of truth for README grouping; uses \`id\` to reference components)
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
The \`pages\` array in page_groups contains component \`id\` values. Look up each \`id\` in \`${intermediateDir}/L2/component_list.json\` to get the \`name\` (for filename and link text).
If any component \`id\` from \`${intermediateDir}/L2/component_list.json\` is missing from \`${intermediateDir}/L5/page_groups.json\` (or appears twice / is unknown), FIX \`${intermediateDir}/L5/page_groups.json\` first so it covers every \`id\` exactly once, then generate the README from the corrected groups. Do NOT create an "Ungrouped"/"Other" bucket in the README.
For EACH group, create a chapter with this shape:
- Chapter heading: \`#### <GroupName>\`
- Chapter description: 3-6 sentences explaining:
  - What this group is responsible for (scope and boundaries)
  - How it relates to other groups at a high level (1-2 sentences max)
  - Where a new reader should start (name 1-2 pages as the recommended entry points)
- Pages list: include ALL pages in this group, each as:
  - Look up the component by \`id\` to get \`name\`
  - Link: Use \`name\` for both link text and filename: \`[{name}](pages/{name}.md)\` or \`[{name}](<pages/{name}.md>)\` if name has spaces
  - One-line description using \`${intermediateDir}/L2/component_list.json\` \`description\` for that component.
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
3. **Incremental Writing**: File write/create operations have output size limits. Read/search are unlimited, but you MUST write section-by-section with \`${editToolNameForPrompt}\`. Writing all at once will fail.
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

## Anti-Hallucination (README Focus)
Apply the Anti-Hallucination Rules from Deep Thinking Protocol. README-specific concerns:
- Remove marketing language ("powerful", "efficient", "robust") unless backed by measurable evidence
- Verify capability claims ("supports X", "handles Y") actually exist in source code
- Architecture descriptions must match actual component relationships
` + getDeepThinkingProtocol() + `
## Input
- \`${outputPath}/README.md\`
- All files under \`${outputPath}/pages/\`
- Source code: read as needed to verify any high-level claim

## Workflow
1. Read \`${outputPath}/README.md\` and the linked pages in \`${outputPath}/pages/\`.
2. For each claim in README, verify against generated pages or source code. If unverifiable, delete or rewrite conservatively.
3. Ensure there are no links to intermediate artifacts (intermediate/, ../L3/, ../L4/, etc.).
4. Write a report to \`${intermediateDir}/L8/factcheck_report.md\` including:
   - Files modified (at least README if changed)
   - Summary of removed/rewritten unverifiable claims
   - Any remaining known limitations

## Constraints
1. **Scope**: Only modify files under \`.deepwiki/\`. Read source code as needed.
2. **No guessing**: If you can't verify, remove or rewrite conservatively.
3. **Incremental Writing**: File write/create operations have output size limits. Read/search are unlimited, but you MUST use \`${editToolNameForPrompt}\` as you go. Writing all at once will fail.
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

## Anti-Hallucination (Release Gate Focus)
Apply the Anti-Hallucination Rules from Deep Thinking Protocol. As the release gate:
- Only perform cleanup (link fixes, placeholder removal) - do NOT add new content
- If you spot suspicious claims, remove them rather than trying to verify at this stage
- The goal is to ensure nothing obviously wrong ships, not to add value
` + getDeepThinkingProtocol() + `
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
2. **Incremental Writing**: File write/create operations have output size limits. Read/search are unlimited, but you MUST use \`${editToolNameForPrompt}\` as you go. Writing all at once will fail.
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

    /**
     * L0-Auto: Subagent that analyzes existing artifacts to determine the optimal resume point.
     * Returns the stage to resume from and a reason explaining the decision.
     */
    private async runAutoDetectSubagent(
        workspaceFolder: vscode.WorkspaceFolder,
        outputPath: string,
        intermediateDir: string,
        cancellationToken: vscode.CancellationToken,
        toolInvocationToken: vscode.ChatParticipantToolToken | undefined
    ): Promise<{ stage: 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7' | 'L8' | 'L9'; reason: string }> {
        const maxAttempts = 2;
        const retryDelayMs = 15000;
        const isRetryableFailureText = (text: string) =>
            /(your request failed|hit the length limit|there was a network error|no response was returned|rate limit|too many requests|429|timed out|timeout|econnreset|socket hang up)/i.test(
                text
            );

        // Absolute paths for subagent file access
        const workspaceRoot = workspaceFolder.uri.fsPath;
        const absoluteOutputPath = path.join(workspaceRoot, outputPath);
        const absoluteIntermediateDir = path.join(workspaceRoot, intermediateDir);

        // Pipeline Overview for context
        const pipelineOverview = `
## Pipeline Overview (short)
L1 Context → L2 Discover (A/B/C) → L3 Analyze → L3-R Review → L4 Architect → L5 Pages (1:1) → L5-V Validate → L6 Review → L7 Indexer → L8 QA (README) → L9 QA (Release Gate)
(Artifacts are stored under \`${outputPath}/\`.)
`;

        // Deep Thinking Protocol for better reasoning
        const deepThinkingProtocol = `
## Deep Thinking Protocol (IMPORTANT)
Your text output before each tool call is invisible to users but remains in YOUR context. Use this as a "scratchpad" to maximize reasoning quality:

### Before EACH Tool Call
1. **Situation Analysis**: Describe current state and what you're trying to accomplish
2. **Hypotheses** (generate 3): List three possible approaches or interpretations
3. **Decision**: Choose the best hypothesis and explain why

### After EACH Tool Result
1. **Reflection**: Was your hypothesis correct? What did you learn?
2. **Adjustment**: How does this change your next action?

### Final Output
- Keep your final chat response brief and polished
- All detailed reasoning stays in your pre-tool-call text (which is discarded from user view)
`;

        const prompt = `# Resume Point Detector Agent (L0-Auto)
${pipelineOverview}
## Role
You are the Resume Point Detector. Your task is to analyze existing DeepWiki artifacts and determine the optimal stage to resume the pipeline from.
${deepThinkingProtocol}
## Workspace Context
- **Workspace Root**: \`${workspaceRoot}\`
- **Output Directory**: \`${absoluteOutputPath}\` (relative: \`${outputPath}\`)
- **Intermediate Directory**: \`${absoluteIntermediateDir}\` (relative: \`${intermediateDir}\`)

## Your Mission
1. Examine the output directory structure
2. Check which intermediate artifacts exist
3. Verify artifact integrity and completeness
4. Determine the optimal resume point

## Artifact Checklist (check in this order)

### Stage Artifacts to Check:
1. **L1**: \`${absoluteIntermediateDir}/L1/project_context.md\` - Project context analysis
2. **L2**: \`${absoluteIntermediateDir}/L2/component_list.json\` - Component discovery list (contains array of {id, name, ...})
3. **L3**: \`${absoluteIntermediateDir}/L3/{id}_analysis.md\` - Individual component analyses (one per component)
   - **Verification**: Read component_list.json, extract all component IDs, then check if \`{id}_analysis.md\` exists for EACH component
4. **L4**: \`${absoluteIntermediateDir}/L4/overview.md\` and \`${absoluteIntermediateDir}/L4/relationships.md\` - Architecture docs
5. **L5**: \`${absoluteOutputPath}/pages/*.md\` - Generated documentation pages (one per component)
   - **Verification**: Compare page files against component_list.json to ensure all components have pages
6. **L6**: Check if L6 review was completed (no pending \`${absoluteIntermediateDir}/L6/retry_request.json\`)
7. **L7**: \`${absoluteOutputPath}/README.md\` AND \`${absoluteIntermediateDir}/L7/indexer_report.md\` - Index file and indexer report
8. **L8**: \`${absoluteIntermediateDir}/L8/factcheck_report.md\` - Fact-check report
9. **L9**: \`${absoluteIntermediateDir}/L9/release_gate_report.md\` - Release gate report

## Decision Logic

Analyze artifacts and apply this logic:
- If L9 release gate report exists and indicates PASS → pipeline is complete, recommend L9 for final verification
- If L8 fact-check exists → resume from L9
- If README.md AND L7 indexer_report.md exist → resume from L8
- If pages/*.md files exist AND match ALL components in component_list.json → resume from L7
- If pages/*.md exist but some components are missing pages → resume from L5 (to regenerate missing pages)
- If L4 overview.md and relationships.md exist → resume from L5
- If L3 analysis files exist for ALL components in component_list.json → resume from L4
- If L3 analysis files exist but some components are missing → resume from L3 (to analyze missing components)
- If L2 component_list.json exists → resume from L3
- If L1 project_context.md exists → resume from L2
- If no artifacts exist → start fresh from L1

## L3 Verification Steps (IMPORTANT)
To verify L3 completion:
1. Read \`${absoluteIntermediateDir}/L2/component_list.json\`
2. Parse the JSON array and extract all \`id\` fields
3. For each component ID, check if \`${absoluteIntermediateDir}/L3/{id}_analysis.md\` exists
4. If ALL analysis files exist → L3 is complete, can resume from L4
5. If SOME are missing → resume from L3 to analyze remaining components

## Special Checks
- If \`${absoluteIntermediateDir}/L6/retry_request.json\` exists, there may be pending retries - consider resuming from L3
- If \`${absoluteIntermediateDir}/L5V/page_validation_failures.json\` exists, some pages need regeneration - resume from L5

## Output Format (CRITICAL)
After your analysis, you MUST output a JSON block with your decision. Use EXACTLY this format:

\`\`\`json
{
  "stage": "L1",
  "reason": "Brief explanation of why this stage was chosen"
}
\`\`\`

Replace "L1" with the appropriate stage (L1-L9) and provide a clear reason.

## Important
- Read files to verify they exist and contain valid content
- Check file sizes - empty or near-empty files indicate incomplete stages
- Be conservative: if unsure about artifact quality, recommend an earlier stage
- Your JSON output MUST be parseable - ensure valid JSON syntax`;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const startTime = Date.now();
            logger.log('DeepWiki', `>>> Starting Phase: L0-Auto (Resume Point Detector) (attempt ${attempt}/${maxAttempts})`);

            // Wait before each subagent call to avoid API rate limits
            await new Promise(resolve => setTimeout(resolve, attempt === 1 ? 10000 : retryDelayMs));

            try {
                const result = await vscode.lm.invokeTool(
                    'runSubagent',
                    {
                        input: {
                            description: 'Detect optimal resume point',
                            prompt: prompt
                        },
                        toolInvocationToken: toolInvocationToken
                    },
                    cancellationToken
                );

                const duration = ((Date.now() - startTime) / 1000).toFixed(1);
                let resultText = '';
                for (const part of result.content) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        resultText += part.value + '\n';
                    }
                }

                // Check for retryable failures in response text
                if (isRetryableFailureText(resultText)) {
                    const shouldRetry = attempt < maxAttempts;
                    logger.warn(
                        'DeepWiki',
                        `Subagent reported request failure in L0-Auto (attempt ${attempt}/${maxAttempts}).${shouldRetry ? ' Retrying.' : ''}`
                    );
                    if (shouldRetry) continue;
                    return { stage: 'L1', reason: 'Auto-detection failed after retries, starting fresh' };
                }

                // Parse the JSON response using existing parseJson helper pattern
                try {
                    const parsed = this.parseJson<{ stage: string; reason: string }>(resultText);
                    const validStages = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9'];
                    const stage = validStages.includes(parsed.stage?.toUpperCase())
                        ? (parsed.stage.toUpperCase() as 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7' | 'L8' | 'L9')
                        : 'L1';
                    const reason = parsed.reason || 'Auto-detected';

                    logger.log('DeepWiki', `<<< Completed Phase: L0-Auto in ${duration}s - Detected: ${stage}`);
                    return { stage, reason };
                } catch (parseError) {
                    logger.warn('DeepWiki', `L0-Auto JSON parse failed: ${parseError}`);
                }

                // Fallback: try to find stage mention in text
                const stageMention = resultText.match(/\b(L[1-9])\b/i);
                if (stageMention) {
                    const stage = stageMention[1].toUpperCase() as 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7' | 'L8' | 'L9';
                    logger.log('DeepWiki', `<<< Completed Phase: L0-Auto in ${duration}s - Fallback detected: ${stage}`);
                    return { stage, reason: 'Auto-detected from text analysis' };
                }

                logger.log('DeepWiki', `<<< Completed Phase: L0-Auto in ${duration}s - No stage detected, defaulting to L1`);
                return { stage: 'L1', reason: 'No existing artifacts found' };
            } catch (error) {
                const duration = ((Date.now() - startTime) / 1000).toFixed(1);
                const msg = error instanceof Error ? error.message : String(error);
                const shouldRetry = attempt < maxAttempts && isRetryableFailureText(msg);
                logger.error(
                    'DeepWiki',
                    `!!! Failed Phase: L0-Auto after ${duration}s (attempt ${attempt}/${maxAttempts})${shouldRetry ? ' - retrying' : ''}`,
                    error
                );
                if (shouldRetry) continue;
                // On final error, default to L1 (fresh start)
                return { stage: 'L1', reason: 'Auto-detection failed, starting fresh' };
            }
        }

        // Should not reach here, but fallback just in case
        return { stage: 'L1', reason: 'Auto-detection exhausted retries' };
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
