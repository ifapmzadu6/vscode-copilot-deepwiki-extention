import * as vscode from 'vscode';
import * as path from 'path';
import { IDeepWikiParameters } from '../types';
import { logger } from '../utils/logger';
import { runTasksSequentially, sanitizeToolNameForPrompt, ComponentDef } from './helpers';
import {
    getMermaidValidationInstruction,
    getCodeUsagesInstruction,
    PromptParams,
    getL1AnalyzerPrompt,
    getL1RReviewerPrompt,
    getL2ADrafterPrompt,
    getL2BReviewerPrompt,
    getL2CRefinerPrompt,
    getL3AnalyzerPrompt,
    getL3RReviewerPrompt,
    getL4ArchitectPrompt,
    getL5GPageGrouperPrompt,
    getL5WriterPrompt,
    getL5VValidatorPrompt,
    getL6PageReviewerPrompt,
    getL7IndexerPrompt,
    getL8FinalQAPrompt,
    getL9ReleaseGatePrompt,
} from './prompts';

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

    prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IDeepWikiParameters>,
        _token: vscode.CancellationToken
    ): vscode.PreparedToolInvocation {
        const outputPath = options.input.outputPath ?? '.deepwiki';
        const startFromStage = options.input.startFromStage ?? 'L1';
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
        const outputPath = params.outputPath ?? '.deepwiki';
        const stageOrder = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9'] as const;
        type Stage = (typeof stageOrder)[number];
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

        if (!workspaceFolder) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Error: No workspace folder open.'),
            ]);
        }

        const intermediateDir = `${outputPath}/intermediate`;

        // Determine start stage (may be overridden by auto-detection below)
        const startFromStageRaw = String(params.startFromStage ?? 'L1').toUpperCase();
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
            logger.log(
                'DeepWiki',
                `Resume mode: starting from stage ${startFromStage} (skipping earlier stages)${reasonSuffix}`
            );
        }

        // Helper to check for cancellation and throw if requested
        const checkCancellation = (): void => {
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

        const bq = '`';
        const mdCodeBlock = bq + bq + bq;

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
        const mermaidValidationInstruction = getMermaidValidationInstruction(mermaidValidatorToolName);

        // Optional code usages lookup tool name (empty string means no usage lookup instructions)
        const codeUsagesToolName = sanitizeToolNameForPrompt(params.codeUsagesToolName ?? '');
        const codeUsagesInstruction = getCodeUsagesInstruction(codeUsagesToolName);

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
            for (const level of ['L1', 'L1R', 'L2', 'L3', 'L3R', 'L4', 'L5', 'L5V', 'L6', 'L7', 'L8', 'L9']) {
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

            // Create shared prompt parameters object
            const promptParams: PromptParams = {
                intermediateDir,
                outputPath,
                editToolNameForPrompt,
                mdCodeBlock,
                existingDeepWikisNote,
                mermaidValidationInstruction,
                codeUsagesInstruction,
                codeUsagesToolName,
            };

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
                    getL1AnalyzerPrompt(promptParams),
                    token,
                    options.toolInvocationToken,
                    path.join(workspaceFolder.uri.fsPath, outputPath),
                    [projectContextUri],
                    { maxAttempts: 3 }
                );

                // ---------------------------------------------------------
                // L1-R: PROJECT CONTEXT REVIEWER
                // ---------------------------------------------------------
                const l1rReviewUri = vscode.Uri.file(
                    path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L1R', 'review.md')
                );
                await this.runPhase(
                    'L1-R: Project Context Reviewer',
                    'Verify and fix L1 project context',
                    getL1RReviewerPrompt(promptParams),
                    token,
                    options.toolInvocationToken,
                    path.join(workspaceFolder.uri.fsPath, outputPath),
                    [l1rReviewUri]
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
                    getL2ADrafterPrompt(promptParams, jsonExample),
                    token,
                    options.toolInvocationToken,
                    path.join(workspaceFolder.uri.fsPath, outputPath),
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

                    const retryContextL2 =
                        l1RetryCount > 0
                            ? `\n\n**CONTEXT**: Previous attempt had issues. Please review the revised component list carefully.`
                            : '';

                    // ---------------------------------------------------------
                    // Level 1-B: COMPONENT REVIEWER (Critique Only)
                    // ---------------------------------------------------------
                    await this.runPhase(
                        `L2-B: Reviewer (Attempt ${l1RetryCount + 1})`,
                        'Critique component grouping',
                        getL2BReviewerPrompt(promptParams, retryContextL2),
                        token,
                        options.toolInvocationToken,
                        path.join(workspaceFolder.uri.fsPath, outputPath),
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
                        const fileListUri = vscode.Uri.file(
                            path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L2', 'component_list.json')
                        );
                        try {
                            const fileListContent = await vscode.workspace.fs.readFile(fileListUri);
                            const contentStr = new TextDecoder().decode(fileListContent);
                            componentList = this.parseJson<ComponentDef[]>(contentStr);

                            if (!Array.isArray(componentList) || componentList.length === 0) {
                                throw new Error('Parsed JSON is not a valid array or is empty.');
                            }

                            logger.log(
                                'DeepWiki',
                                `L2 Success: Review approved. Identified ${componentList.length} logical components.`
                            );
                            isL2Success = true;
                            break;
                        } catch (e) {
                            logger.error(
                                'DeepWiki',
                                `L2 JSON validation failed despite approval: ${e instanceof Error ? e.message : String(e)}`
                            );
                            // Continue to refiner to fix JSON issues
                        }
                    }

                    // ---------------------------------------------------------
                    // Level 1-C: COMPONENT REFINER (Fix & Finalize)
                    // ---------------------------------------------------------
                    await this.runPhase(
                        `L2-C: Refiner (Attempt ${l1RetryCount + 1})`,
                        'Refine component list based on review',
                        getL2CRefinerPrompt(promptParams, retryContextL2),
                        token,
                        options.toolInvocationToken,
                        path.join(workspaceFolder.uri.fsPath, outputPath),
                        [componentListUri],
                        { maxAttempts: 3 }
                    );
                    // ---------------------------------------------------------
                    // Check JSON validity after refinement
                    // ---------------------------------------------------------
                    const fileListUri = vscode.Uri.file(
                        path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L2', 'component_list.json')
                    );
                    try {
                        const fileListContent = await vscode.workspace.fs.readFile(fileListUri);
                        const contentStr = new TextDecoder().decode(fileListContent);
                        componentList = this.parseJson<ComponentDef[]>(contentStr);

                        if (!Array.isArray(componentList) || componentList.length === 0) {
                            throw new Error('Parsed JSON is not a valid array or is empty.');
                        }

                        logger.log(
                            'DeepWiki',
                            `L2 Refinement produced valid JSON with ${componentList.length} components. Re-reviewing...`
                        );
                        // Continue loop to re-review the refined result
                    } catch (e) {
                        logger.error(
                            'DeepWiki',
                            `L2 Attempt ${l1RetryCount + 1} Failed: ${e instanceof Error ? e.message : String(e)}`
                        );
                    }
                    l1RetryCount++;
                }

                if (!isL2Success) {
                    throw new Error('L2 Discovery failed to produce valid components after retries. Pipeline stopped.');
                }
            } else {
                // Resume mode: reuse existing L2 output
                const fileListUri = vscode.Uri.file(
                    path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L2', 'component_list.json')
                );
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
                startFromStage === 'L4' ? 'L4' : startFromStage === 'L5' ? 'L5' : startFromStage === 'L6' ? 'L6' : 'L3';

            // Resume mode starting at L7+ skips the analysis/writing loop entirely.
            if (startStageIndex >= stageOrder.indexOf('L7')) {
                componentsToAnalyze = [];
            }

            while (componentsToAnalyze.length > 0 && loopCount < MAX_LOOPS) {
                logger.log(
                    'DeepWiki',
                    `>>> Starting Analysis/Writing Loop ${loopCount + 1}/${MAX_LOOPS} with ${componentsToAnalyze.length} components...`
                );

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
                        componentsToAnalyze = componentList.filter((c) => missingComponentIds.includes(c.id));
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

                const componentsForThisLoop = componentsToAnalyze.map((c) => c.name);

                if (runL3Stages) {
                    // ---------------------------------------------------------
                    // Level 3: ANALYZER (Process current components - 1 component per task)
                    // ---------------------------------------------------------
                    // Task generator function for L3 analysis (shared by initial and retry)
                    const createL3Task = (component: ComponentDef) => {
                        const componentStr = JSON.stringify(component);
                        const originalIndex = componentList.findIndex((c) => c.id === component.id);
                        const paddedIndex = String(originalIndex + 1).padStart(3, '0');
                        const analysisFileUri = vscode.Uri.file(
                            path.join(
                                workspaceFolder.uri.fsPath,
                                intermediateDir,
                                'L3',
                                `${paddedIndex}_${component.id}_analysis.md`
                            )
                        );
                        return () =>
                            this.runPhase(
                                `L3: Analyzer (Loop ${loopCount + 1}, ${component.name})`,
                                `Analyze component`,
                                getL3AnalyzerPrompt(promptParams, {
                                    componentStr,
                                    paddedIndex,
                                    componentId: component.id,
                                    loopCount,
                                }),
                                token,
                                options.toolInvocationToken,
                                path.join(workspaceFolder.uri.fsPath, outputPath),
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
                        const originalIndex = componentList.findIndex((c) => c.id === component.id);
                        const paddedIndex = String(originalIndex + 1).padStart(3, '0');
                        const analysisFile = `${paddedIndex}_${component.id}_analysis.md`;
                        const reviewFile = `${paddedIndex}_${component.id}_review.md`;
                        const retryFile = `${paddedIndex}_${component.id}_retry.json`;
                        return () =>
                            this.runPhase(
                                `L3-R: Reviewer (Loop ${loopCount + 1}, ${component.name})`,
                                `Review L3 analysis`,
                                getL3RReviewerPrompt(promptParams, {
                                    componentStr,
                                    componentName: component.name,
                                    componentId: component.id,
                                    paddedIndex,
                                    analysisFile,
                                    reviewFile,
                                    retryFile,
                                }),
                                token,
                                options.toolInvocationToken,
                                path.join(workspaceFolder.uri.fsPath, outputPath)
                            );
                    };
                    const l3rTasks = componentsToAnalyze.map(createL3RTask);
                    await runTasksSequentially(l3rTasks, `L3 Review (Loop ${loopCount + 1})`, token);

                    const l3rRetryPattern = new vscode.RelativePattern(
                        workspaceFolder,
                        `${intermediateDir}/L3R/*_retry.json`
                    );
                    const l3rRetryUris = await vscode.workspace.findFiles(l3rRetryPattern);
                    const l3rRetryNamesSet = new Set<string>();
                    for (const uri of l3rRetryUris) {
                        try {
                            const content = await vscode.workspace.fs.readFile(uri);
                            const names = this.parseJson<string[]>(new TextDecoder().decode(content));
                            if (Array.isArray(names)) names.forEach((n) => l3rRetryNamesSet.add(n));
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
                        const retryComponents = componentsToAnalyze.filter((c) => l3rRetryIds.includes(c.id));
                        if (retryComponents.length > 0) {
                            const l3RetryTasks = retryComponents.map(createL3Task);
                            await runTasksSequentially(l3RetryTasks, `L3 Re-Analyze (Loop ${loopCount + 1})`, token);
                            // Re-run L3-R only for the re-analyzed components once (do not request further retries).
                            const l3rSecondPassTasks = retryComponents.map(createL3RTask);
                            await runTasksSequentially(
                                l3rSecondPassTasks,
                                `L3 Review (2nd pass, Loop ${loopCount + 1})`,
                                token
                            );
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
                    const l4OverviewUri = vscode.Uri.file(
                        path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L4', 'overview.md')
                    );
                    const l4RelationshipsUri = vscode.Uri.file(
                        path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L4', 'relationships.md')
                    );
                    await this.runPhase(
                        `L4: Architect (Loop ${loopCount + 1})`,
                        'Update system overview and maps',
                        getL4ArchitectPrompt(promptParams, loopCount),
                        token,
                        options.toolInvocationToken,
                        path.join(workspaceFolder.uri.fsPath, outputPath),
                        [l4OverviewUri, l4RelationshipsUri],
                        { maxAttempts: 3 }
                    );
                }
                // Level 5: PAGES (deterministic 1:1 mapping)
                // ---------------------------------------------------------
                // The wiki pages are intentionally kept at a stable granularity:
                // one generated page per discovered component.
                //
                // L5 is responsible for:
                // 1) writing `.deepwiki/pages/*.md` (1 component = 1 page)
                // 2) grouping pages for README navigation (`page_groups.json`, via the L5-G subagent)
                if (runL5Stages) {
                    logger.log(
                        'DeepWiki',
                        `L5 Pages: ${componentsForThisLoop.length} components in this loop (1:1 mapping)`
                    );

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
                        getL5GPageGrouperPrompt(promptParams, pageGroupsExample, loopCount),
                        token,
                        options.toolInvocationToken,
                        path.join(workspaceFolder.uri.fsPath, outputPath)
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
                            logger.log(
                                'DeepWiki',
                                `L5-G: Component list was modified (${updatedList.length} components). Restarting from L3...`
                            );
                            componentList = updatedList;
                            componentsToAnalyze = [...updatedList];
                            loopCount++;
                            continue; // Restart loop from L3 with updated components
                        }
                    } catch (e) {
                        logger.log(
                            'DeepWiki',
                            `L5-G: Could not check component list changes (${e instanceof Error ? e.message : 'error'})`
                        );
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
                            vscode.Uri.file(
                                path.join(workspaceFolder.uri.fsPath, outputPath, 'pages', `${component.name}.md`)
                            ),
                        ];
                        return () =>
                            this.runPhase(
                                `L5: Writer (Loop ${loopCount + 1})`,
                                `Write documentation page`,
                                getL5WriterPrompt(
                                    promptParams,
                                    component.id,
                                    component.name,
                                    component.files || [],
                                    component.description || '',
                                    pageTemplate,
                                    loopCount
                                ),
                                token,
                                options.toolInvocationToken,
                                path.join(workspaceFolder.uri.fsPath, outputPath),
                                pageUris,
                                { maxAttempts: 3 }
                            );
                    };
                    // Initial L5 writing
                    const l5Tasks = componentsToAnalyze.map(createL5Task);
                    await runTasksSequentially(l5Tasks, `L5 Writing (Loop ${loopCount + 1})`, token);

                    // ---------------------------------------------------------
                    // L5 Validator: Check for missing page files and retry if needed
                    // ---------------------------------------------------------
                    const l5ExpectedPages = componentsToAnalyze.map((c) => ({
                        id: c.id,
                        name: c.name,
                        file: `${c.name}.md`,
                    }));
                    await this.runPhase(
                        `L5-V: Validator (Loop ${loopCount + 1})`,
                        'Validate L5 output files',
                        getL5VValidatorPrompt(promptParams, l5ExpectedPages),
                        token,
                        options.toolInvocationToken,
                        path.join(workspaceFolder.uri.fsPath, outputPath)
                    );

                    // Check L5 validation result and retry failed pages
                    const l5FailuresUri = vscode.Uri.file(
                        path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L5V', 'page_validation_failures.json')
                    );
                    let l5FailedIds: string[] = [];
                    try {
                        const content = await vscode.workspace.fs.readFile(l5FailuresUri);
                        const parsed = this.parseJson<unknown>(new TextDecoder().decode(content));
                        if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) {
                            l5FailedIds = parsed;
                        } else {
                            logger.warn(
                                'DeepWiki',
                                'L5-V: page_validation_failures.json is not a string array; retrying all pages for safety.'
                            );
                            l5FailedIds = componentsToAnalyze.map((c) => c.id);
                        }
                        await vscode.workspace.fs.delete(l5FailuresUri);
                    } catch {
                        /* no failures file or invalid */
                    }

                    if (l5FailedIds.length > 0) {
                        logger.log(
                            'DeepWiki',
                            `L5 Validator requested retry for ${l5FailedIds.length} page(s): ${l5FailedIds.join(', ')}`
                        );
                        // Retry using the same task generator function
                        const failedComponents = componentsToAnalyze.filter((c) => l5FailedIds.includes(c.id));
                        const l5RetryTasks = failedComponents.map(createL5Task);
                        await runTasksSequentially(l5RetryTasks, `L5 Retry (Loop ${loopCount + 1})`, token);
                    }
                }

                // ---------------------------------------------------------
                // Level 6: PAGE REVIEWER (Check & Request Retry)
                // Input: All generated pages and all L3 analysis
                // ---------------------------------------------------------
                const isLastLoop = loopCount === MAX_LOOPS - 1;
                const _retryInstruction = isLastLoop
                    ? `This is the FINAL attempt. Do NOT request retries. Fix minor issues directly within the pages. If a page is fundamentally broken, add a prominent warning note to the page itself, explaining the issue.`
                    : `If a page has MAJOR missing information or wrong analysis, list the component **id** values that need re-analysis (L3/L4/L5) in "` +
                      intermediateDir +
                      `/L6/retry_request.json".
                       Format: ["Auth_Module", "Utils"] (use \`id\`, not \`name\`).
                       For minor issues (typos, formatting, broken links), fix the page directly.`;

                await this.runPhase(
                    `L6: Page Reviewer (Loop ${loopCount + 1})`,
                    'Review pages and decide on retries',
                    getL6PageReviewerPrompt(promptParams, loopCount, isLastLoop),
                    token,
                    options.toolInvocationToken,
                    path.join(workspaceFolder.uri.fsPath, outputPath),
                    undefined,
                    { maxAttempts: 3 }
                );
                // ---------------------------------------------------------
                // Check for Retries
                // ---------------------------------------------------------
                // L6 requested a retry: need to re-run L3/L4/L5 for specific components
                const retryFileUri = vscode.Uri.file(
                    path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L6', 'retry_request.json')
                );
                let retryNames: string[] | null = null;
                try {
                    const retryContent = await vscode.workspace.fs.readFile(retryFileUri);
                    retryNames = this.parseJson<string[]>(new TextDecoder().decode(retryContent));
                    await vscode.workspace.fs.delete(retryFileUri); // Delete the retry request file
                } catch {
                    // File not found or invalid means no retries requested
                    logger.log('DeepWiki', 'No retry request found or file invalid.');
                }

                if (retryNames && Array.isArray(retryNames) && retryNames.length > 0) {
                    logger.log('DeepWiki', `Reviewer requested retry for: ${retryNames.join(', ')}`);
                    // Filter componentList to get the actual component objects for retry (match by id)
                    componentsToAnalyze = componentList.filter((c) => retryNames.includes(c.id));
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
                const l7ReportUri = vscode.Uri.file(
                    path.join(workspaceFolder.uri.fsPath, intermediateDir, 'L7', 'indexer_report.md')
                );
                await this.runPhase(
                    'L7: Indexer',
                    'Create README and Sidebar',
                    getL7IndexerPrompt(promptParams),
                    token,
                    options.toolInvocationToken,
                    path.join(workspaceFolder.uri.fsPath, outputPath),
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
                    getL8FinalQAPrompt(promptParams),
                    token,
                    options.toolInvocationToken,
                    path.join(workspaceFolder.uri.fsPath, outputPath),
                    undefined,
                    { maxAttempts: 3 }
                );
            }
            // Final QA: Release Gate
            // ---------------------------------------------------------
            if (startStageIndex <= stageOrder.indexOf('L9')) {
                await this.runPhase(
                    'L9: Final QA (Release Gate)',
                    'Final output integrity checks and cleanup',
                    getL9ReleaseGatePrompt(promptParams),
                    token,
                    options.toolInvocationToken,
                    path.join(workspaceFolder.uri.fsPath, outputPath),
                    undefined,
                    { maxAttempts: 3 }
                );
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `✅ DeepWiki Generation Completed!\n\nDocumented ${componentList.length} components into ${componentList.length} pages. Check the \`${outputPath}\` directory.`
                ),
            ]);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error('DeepWiki', `Pipeline failed: ${msg}`);
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`❌ Pipeline failed: ${msg}`)]);
        }
    }

    private async cleanOutputDirectory(workspaceFolder: vscode.WorkspaceFolder, outputPath?: string): Promise<void> {
        const dirName = outputPath?.trim() ?? '.deepwiki';
        if (dirName === '' || dirName === '.' || dirName === '/' || dirName === '\\') {
            logger.warn('DeepWiki', 'Skipping cleanup: unsafe output path');
            return;
        }

        const targetPath = path.normalize(path.join(workspaceFolder.uri.fsPath, dirName));
        if (!targetPath.startsWith(path.normalize(workspaceFolder.uri.fsPath + path.sep) ?? '')) {
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
        return JSON.parse(jsonStr) as T;
    }

    /**
     * Close editor tabs for .deepwiki/ files, but only if they are not pinned and are in preview mode.
     * This prevents auto-generated files from cluttering the editor, while respecting user's explicit choices.
     */
    private async closeDeepWikiEditors(deepWikiPath: string): Promise<void> {
        try {
            const tabsToClose: vscode.Tab[] = [];

            for (const tabGroup of vscode.window.tabGroups.all) {
                for (const tab of tabGroup.tabs) {
                    // Check if this is a text file tab
                    if (tab.input instanceof vscode.TabInputText) {
                        const filePath = tab.input.uri.fsPath;

                        // Check if the file is under .deepwiki/
                        if (filePath.startsWith(deepWikiPath)) {
                            // Only close if:
                            // 1. NOT pinned (user explicitly pinned the tab)
                            // 2. IS in preview mode (single-click, not double-click)
                            if (!tab.isPinned && tab.isPreview) {
                                tabsToClose.push(tab);
                            }
                        }
                    }
                }
            }

            if (tabsToClose.length > 0) {
                await vscode.window.tabGroups.close(tabsToClose);
                logger.log(
                    'DeepWiki',
                    `Closed ${tabsToClose.length} preview tab(s) from ${path.basename(deepWikiPath)}/`
                );
            }
        } catch (error) {
            // Don't fail the entire process if tab closing fails
            logger.warn(
                'DeepWiki',
                `Failed to close editor tabs: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    private async runPhase(
        agentName: string,
        description: string,
        prompt: string,
        cancellationToken: vscode.CancellationToken,
        toolInvocationToken: vscode.ChatParticipantToolToken | undefined,
        deepWikiPath: string,
        cleanupUrisOnRequestFailed?: vscode.Uri[],
        options?: { maxAttempts?: number; retryDelayMs?: number }
    ): Promise<void> {
        const maxAttempts = Math.max(1, options?.maxAttempts ?? 1);
        const retryDelayMs = Math.max(0, options?.retryDelayMs ?? 15000);
        const isRetryableFailureText = (text: string): boolean =>
            /(your request failed|hit the length limit|there was a network error|no response was returned|rate limit|too many requests|429|timed out|timeout|econnreset|socket hang up)/i.test(
                text
            );

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const startTime = Date.now();
            logger.log(
                'DeepWiki',
                `>>> Starting Phase: ${agentName} (attempt ${attempt}/${maxAttempts}) - ${description}`
            );

            // Wait before each subagent call to avoid API rate limits (and give transient failures time to clear).
            await new Promise((resolve) => setTimeout(resolve, attempt === 1 ? 10000 : retryDelayMs));

            try {
                const result = await vscode.lm.invokeTool(
                    'runSubagent',
                    {
                        input: {
                            description: description,
                            prompt: prompt,
                        },
                        toolInvocationToken: toolInvocationToken,
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

                // Close preview tabs for .deepwiki/ files after phase completion
                await this.closeDeepWikiEditors(deepWikiPath);

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
        const isRetryableFailureText = (text: string): boolean =>
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
L1 Context → L1-R Review → L2 Discover (A/B/C) → L3 Analyze → L3-R Review → L4 Architect → L5 Pages (1:1) → L5-V Validate → L6 Review → L7 Indexer → L8 QA (README) → L9 QA (Release Gate)
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
            logger.log(
                'DeepWiki',
                `>>> Starting Phase: L0-Auto (Resume Point Detector) (attempt ${attempt}/${maxAttempts})`
            );

            // Wait before each subagent call to avoid API rate limits
            await new Promise((resolve) => setTimeout(resolve, attempt === 1 ? 10000 : retryDelayMs));

            try {
                const result = await vscode.lm.invokeTool(
                    'runSubagent',
                    {
                        input: {
                            description: 'Detect optimal resume point',
                            prompt: prompt,
                        },
                        toolInvocationToken: toolInvocationToken,
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
                    logger.warn(
                        'DeepWiki',
                        `L0-Auto JSON parse failed: ${parseError instanceof Error ? parseError.message : String(parseError)}`
                    );
                }

                // Fallback: try to find stage mention in text
                const stageMention = resultText.match(/\b(L[1-9])\b/i);
                if (stageMention) {
                    const stage = stageMention[1].toUpperCase() as
                        | 'L1'
                        | 'L2'
                        | 'L3'
                        | 'L4'
                        | 'L5'
                        | 'L6'
                        | 'L7'
                        | 'L8'
                        | 'L9';
                    logger.log(
                        'DeepWiki',
                        `<<< Completed Phase: L0-Auto in ${duration}s - Fallback detected: ${stage}`
                    );
                    return { stage, reason: 'Auto-detected from text analysis' };
                }

                logger.log(
                    'DeepWiki',
                    `<<< Completed Phase: L0-Auto in ${duration}s - No stage detected, defaulting to L1`
                );
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
