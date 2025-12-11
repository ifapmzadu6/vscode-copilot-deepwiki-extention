import * as vscode from 'vscode';
import { IDeepWikiParameters, ComponentDef } from '../types';
import { logger } from '../utils/logger';
import {
    PhaseContext,
    runL0,
    runL1,
    runL2,
    runL3,
    runL4,
    runL5Pre,
    runL5Writer,
    runL6,
    runIndexer,
    MAX_LOOPS
} from '../phases';

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

        // Create phase context
        const ctx: PhaseContext = {
            workspaceFolder,
            outputPath,
            intermediateDir,
            token,
            toolInvocationToken: options.toolInvocationToken
        };

        try {
            // ==================================================================================
            // PHASE 0: PROJECT CONTEXT ANALYSIS
            // ==================================================================================
            checkCancellation();
            logger.log('DeepWiki', 'Starting L0: Project Context Analysis...');
            await runL0(ctx);

            // ==================================================================================
            // PHASE 1: DISCOVERY & EXTRACTION
            // ==================================================================================
            const componentList = await runL1(ctx, this.parseJson.bind(this));

            // ==================================================================================
            // PHASE 2: L2 EXTRACTION (Parallel)
            // ==================================================================================
            await runL2(ctx, componentList, this.parseJson.bind(this));

            // ==================================================================================
            // PHASE 3: ANALYSIS & WRITING LOOP (Critical Failure Loop)
            // L3 -> L4 -> L5 -> L6 -> (Retry L3/L4/L5 if L6 requests)
            // ==================================================================================
            let componentsToAnalyze: ComponentDef[] = [...componentList];
            let loopCount = 0;
            let finalPageCount = 0;

            while (componentsToAnalyze.length > 0 && loopCount < MAX_LOOPS) {
                logger.log('DeepWiki', `>>> Starting Analysis/Writing Loop ${loopCount + 1}/${MAX_LOOPS} with ${componentsToAnalyze.length} components...`);

                const componentsForThisLoop = componentsToAnalyze.map(c => c.name);

                // L3: Analyzer
                await runL3(ctx, componentList, componentsToAnalyze, loopCount, this.parseJson.bind(this));

                // L4: Architect
                await runL4(ctx, loopCount);

                // L5-Pre: Page Structure Consolidator
                const { pageStructure, finalPageCount: pageCount } = await runL5Pre(
                    ctx,
                    componentList,
                    componentsForThisLoop,
                    loopCount,
                    this.parseJson.bind(this)
                );
                finalPageCount = pageCount;

                // L5: Writer
                await runL5Writer(ctx, pageStructure, loopCount, this.parseJson.bind(this));

                // L6: Reviewer (returns retry component names)
                const retryNames = await runL6(ctx, componentList, loopCount, this.parseJson.bind(this));

                if (retryNames.length > 0) {
                    componentsToAnalyze = componentList.filter(c => retryNames.includes(c.name));
                } else {
                    componentsToAnalyze = [];
                }

                loopCount++;
            }

            // ==================================================================================
            // INDEXER: Create README
            // ==================================================================================
            await runIndexer(ctx);

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
        const path = await import('path');
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
                return;
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
}
