import * as vscode from 'vscode';
import * as path from 'path';
import { IDeepWikiParameters } from '../types';
import { logger } from '../utils/logger';

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

        // Clean up previous output
        await this.cleanOutputDirectory(workspaceFolder, outputPath);

        const commonConstraints = `
CONSTRAINTS:
1. **Security & Tool Usage**:
   - **ALLOWED TOOLS**: You MUST ONLY use the following tools:
     - File Operations: \`list_dir\`, \`read_file\`, \`create_file\`, \`create_directory\`, \`replace_string_in_file\`, \`multi_replace_string_in_file\`.
     - Search: \`file_search\`, \`grep_search\`, \`semantic_search\`, \`list_code_usages\`.
   - **FORBIDDEN**: Do NOT use \`run_in_terminal\`, \`run_task\`, \`install_extension\`, or any other tools not listed above.

2. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
3. **Chat Output**: Do NOT output the full content of any file in your chat response. Keep it brief.
`;
        const bq = '`';
        const mdCodeBlock = bq + bq + bq;

        // Define ComponentDef interface globally within invoke scope
        interface ComponentDef { name: string; files: string[]; importance: string; description: string }

        try {
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
- **Pipeline Position**: First stage of discovery. You receive nothing and output the initial draft.
- **Responsibility**: Create a rough grouping of project files into logical components.

## Goal
Create an INITIAL draft of logical components.

## Instructions
1. Scan the project files (\`src/\`).
2. Group related files into Components based on directory structure.
3. Assign tentative importance (High/Medium/Low).

## Output
Write the draft JSON to \`${intermediateDir}/component_draft.json\`.

**Format**:
${mdCodeBlock}json
${jsonExample}
${mdCodeBlock}

> **IMPORTANT**: Write RAW JSON only.
` + commonConstraints,
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
- **Pipeline Position**: Receives L1-A draft → outputs critique report → L1-C refines based on this.
- **Responsibility**: Quality gate. Identify issues but do NOT fix them.

## Goal
CRITIQUE the draft. Do NOT fix it yourself.

## Input
- Read \`${intermediateDir}/component_draft.json\`
- **Reference**: Use file listing tools to verify the ACTUAL project structure.

## Instructions
1. Critique the draft for granularity and accuracy.
2. **Verification**: Verify that the grouped files actually exist and make sense together.
3. Check for missing core files or included noise.${retryContextL1}

## Output
Write a critique report to \`${intermediateDir}/L1_review_report.md\`.
` + commonConstraints,
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
- **Pipeline Position**: Receives L1-A draft + L1-B critique → outputs final component list → L2 uses this.
- **Responsibility**: Merge feedback and produce the validated JSON.

## Goal
Create the FINAL component list.

## Input
- Draft: \`${intermediateDir}/component_draft.json\`
- Review: \`${intermediateDir}/L1_review_report.md\`

## Instructions
1. Read the Draft and the Review Report.
2. Apply the suggested fixes to the component list.
3. Produce the valid JSON.${retryContextL1}

## Output
- Write the FINAL JSON to \`${intermediateDir}/component_list.json\`.
- Format must be valid JSON array.
` + commonConstraints,
                    token,
                    options.toolInvocationToken
                );

                // ---------------------------------------------------------
                // Check JSON validity
                // ---------------------------------------------------------
                const fileListUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, intermediateDir, 'component_list.json'));
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

            // ---------------------------------------------------------
            // Level 2: EXTRACTOR (Parallel - Runs once for all components)
            // ---------------------------------------------------------
            const chunkSize = 3;
            const chunks = [];
            for (let i = 0; i < componentList.length; i += chunkSize) {
                chunks.push(componentList.slice(i, i + chunkSize));
            }

            const l2Promises = chunks.map((chunk, index) => {
                const chunkStr = JSON.stringify(chunk);
                return this.runPhase(
                    `L2: Extractor (Chunk ${index + 1})`,
                    `Extract entities`,
                    `# Extractor Agent (L2)

## Role
- **Pipeline Position**: Receives L1-C component list → outputs API signatures → L3 uses this for analysis.
- **Responsibility**: Extract precise code signatures. No interpretation, just extraction.

## Input
Assigned Components: ${chunkStr}

## Instructions
1. Extract public API signatures from source code with EXACT parameter names and types.
2. For each method/function, include:
   - Full signature (method name, parameters with types, return type)
   - Brief description of purpose
3. **CRITICAL**: Copy signatures EXACTLY as they appear in the code. Do NOT paraphrase or summarize parameter names.
4. For enums, include ALL cases with their raw values (e.g., \`.full = "一日飲み"\`).
5. For computed properties, include the return type.

## Output
Write to \`${intermediateDir}/L2_extraction_chunk${index + 1}.md\`.
` + commonConstraints,
                    token,
                    options.toolInvocationToken
                );
            });
            await Promise.all(l2Promises);


            // ==================================================================================
            // PHASE 2: ANALYSIS & WRITING LOOP (Critical Failure Loop)
            // L3 -> L4 -> L5 -> L6 -> (Retry L3/L4/L5 if L6 requests)
            // ==================================================================================

            let componentsToAnalyze = [...componentList]; // All components initially
            let loopCount = 0;
            const MAX_LOOPS = 5; // Initial run + 4 retries

            while (componentsToAnalyze.length > 0 && loopCount < MAX_LOOPS) {
                logger.log('DeepWiki', `>>> Starting Analysis/Writing Loop ${loopCount + 1}/${MAX_LOOPS} with ${componentsToAnalyze.length} components...`);

                // Filter chunks to only include componentsToAnalyze
                // The chunking logic here is simplified. L3/L5 should be able to handle individual component analysis.
                // For a more robust solution, L3/L5 should accept an array of component names rather than a chunk.
                // For now, we'll re-chunk the componentsToAnalyze.

                const componentsForThisLoop = componentsToAnalyze.map(c => c.name);
                const currentChunks: ComponentDef[][] = []; // Array of arrays of ComponentDef
                const tempChunk: ComponentDef[] = [];
                for (const component of componentsToAnalyze) {
                    tempChunk.push(component);
                    if (tempChunk.length === chunkSize) {
                        currentChunks.push([...tempChunk]);
                        tempChunk.length = 0; // Clear tempChunk
                    }
                }
                if (tempChunk.length > 0) currentChunks.push(tempChunk);


                // ---------------------------------------------------------
                // Level 3: ANALYZER (Process current components)
                // L3 output files are now component-specific
                // ---------------------------------------------------------
                const l3Promises = currentChunks.map((chunk, index) => {
                    return this.runPhase(
                        `L3: Analyzer (Loop ${loopCount + 1}, Batch ${index + 1})`,
                        `Analyze ${chunk.length} components`,
                        `# Analyzer Agent (L3)

## Role
- **Pipeline Position**: Receives L2 extractions → outputs deep analysis → L4/L5 use this.
- **Responsibility**: Understand HOW the code works, trace causality, and create diagrams.

## Input
Assigned Components: ${JSON.stringify(chunk)}

## Instructions
1. For EACH component, read its L2 extraction (search in intermediate folder) and source code.
2. **Think about Causality**: Trace logic flow and state changes.
3. **Visualize**: Define at least one specific Mermaid diagram for each component (e.g., Sequence Diagram for flows, State Diagram for lifecycle, Class Diagram for structure).
4. **Cross-Verify**: When documenting values (durations, thresholds, percentages, enum raw values):
   - ALWAYS read the actual source file to confirm.
   - Quote the exact value from source (e.g., \`fullDayHours: 9.0\` from line 42).
   - Do NOT guess or paraphrase values.

## Output
Create a SEPARATE analysis file for EACH component.
- For a component named "MyComponent", write to \`${intermediateDir}/analysis/MyComponent_analysis.md\`.
` + commonConstraints,
                        token,
                        options.toolInvocationToken
                    );
                });
                await Promise.all(l3Promises);

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
- **Pipeline Position**: Receives ALL L3 analysis → outputs system overview → Indexer uses this.
- **Responsibility**: See the big picture. Map component relationships and explain architectural decisions.

## Goal
Create a system-level overview based on ALL available L3 analysis.

## Input
Read ALL files in \`${intermediateDir}/analysis/\` (including those from previous loops).

## Instructions
1. Define the High-Level Architecture.
2. **Analyze Causal Impact**: How does a change in one component propagate to others?
3. Explain the 'Why' behind the architectural decisions.
4. **Visualize**: Draw a Component Diagram using Mermaid showing interactions. Also consider a Data Flow Diagram or System Context Diagram.

## Output
- Write Overview to \`${intermediateDir}/L4_overview.md\`.
- Write Architecture Map to \`${intermediateDir}/L4_relationships.md\`.
- Include at least TWO diagrams (e.g., \`graph TD\` for component interactions, \`sequenceDiagram\` for key flows).
` + commonConstraints,
                    token,
                    options.toolInvocationToken
                );

                // ---------------------------------------------------------
                // Level 5: WRITER (Process current components)
                // ---------------------------------------------------------
                const mdCodeBlock = bq + bq + bq;
                const pageTemplate = `
---
title: {ComponentName}
type: component
importance: {High/Medium/Low}
---

# {ComponentName}

## Summary
{Description}

## Use Cases
{Description of how and when to use this component}

## Internal Mechanics Overview
${mdCodeBlock}mermaid
%% Overview diagram (File/Class/State) of the internal structure
${mdCodeBlock}
**File Structure:**
${mdCodeBlock}text
{ASCII Tree of files in this component with brief descriptions}
${mdCodeBlock}

## Internal Mechanics Details
{Describe the internal logic, state management, and data flow. Explain HOW it works, not just WHAT it does.}

${mdCodeBlock}mermaid
%% Sequence diagram or State diagram detailing the internal logic
${mdCodeBlock}

## External Interface
{Describe how other modules interact with this component. List public methods, props, and events.}
`; // The template ends here
                const l5Promises = currentChunks.map((chunk, index) => {
                    return this.runPhase(
                        `L5: Writer (Loop ${loopCount + 1}, Batch ${index + 1})`,
                        `Write documentation pages`,
                        `# Writer Agent (L5)

## Role
- **Pipeline Position**: Receives L3 analysis → outputs final documentation pages → L6 reviews this.
- **Responsibility**: Transform technical analysis into readable, well-structured documentation.

## Input
- Assigned Components: ${JSON.stringify(chunk)}
- Read \`${intermediateDir}/analysis/{ComponentName}_analysis.md\` for each assigned component.

## Instructions
1. For EACH assigned component, create/overwrite its page in \`${outputPath}/pages/{ComponentName}.md\`.
2. **File Tree**: Generate an ASCII tree of the component's files and add a brief comment for each file explaining its role.
3. **Causal Explanation**: When describing Internal Mechanics, explain the CAUSAL FLOW (e.g., "Because X happens, Y triggers Z").
4. Avoid static descriptions; tell the story of the data flow.
5. Use this Template:
` + pageTemplate + `

## Constraints
- **Do NOT include raw source code or implementation details.**
- **Strictly separate External Interface from Internal Mechanics.**
- Use tables for API references.

## Output
Write files to \`${outputPath}/pages/\`.
` + commonConstraints,
                        token,
                        options.toolInvocationToken
                    );
                });
                await Promise.all(l5Promises);

                // ---------------------------------------------------------
                // Level 6: PAGE REVIEWER (Check & Request Retry)
                // Input: All generated pages and all L3 analysis
                // ---------------------------------------------------------
                const isLastLoop = loopCount === MAX_LOOPS - 1;
                const retryInstruction = isLastLoop
                    ? `This is the FINAL attempt. Do NOT request retries. Fix minor issues directly within the pages. If a page is fundamentally broken, add a prominent warning note to the page itself, explaining the issue.`
                    : `If a page has MAJOR missing information or wrong analysis, list the Component Name(s) that need re-analysis (L3/L4/L5) in "` + intermediateDir + `/retry_request.json".
                       Format: ["Auth Module", "Utils"].
                       For minor issues (typos, formatting, broken links), fix the page directly.`;

                await this.runPhase(
                    `L6: Page Reviewer (Loop ${loopCount + 1})`,
                    'Review pages and decide on retries',
                    `# Page Reviewer Agent (L6)

## Role
- **Pipeline Position**: Receives L5 pages + L3 analysis → outputs fixes or retry requests → Final quality gate.
- **Responsibility**: Ensure accuracy, consistency, and completeness. You are the last line of defense.

## Goal
Check pages in \`${outputPath}/pages/\` for quality based on ALL L3 analysis files.

## Input
- Read generated pages in \`${outputPath}/pages/\`
- Read all L3 analysis files in \`${intermediateDir}/analysis/\`

## Instructions
1. **Accuracy**: Verify content against ACTUAL SOURCE CODE. Read the source files referenced in the page to ensure descriptions are correct. Do not trust the text blindly.
2. **Completeness**: Ensure no sections (Overview, Architecture, API) are empty or placeholders.
3. **Connectivity**: Verify that all links work and point to existing files.
4. **Formatting**: Fix broken Markdown tables or Mermaid syntax errors.
5. **Numerical Consistency**: Check for inconsistent numerical values within the document.
   - Duration formats: Ensure "8 hours" vs "9 hours" vs "8h" are consistent.
   - Percentages: Ensure "25%" vs "0.25" are unified.
   - If values conflict, VERIFY against source code and unify to the correct value.
6. **Signature Accuracy**: Verify method/function signatures match actual source code.
   - Parameter names and types must match exactly.
   - If a signature is incorrect, fix it by reading the actual source file.
7. ` + retryInstruction + `

## Output
- Overwrite pages in \`${outputPath}/pages/\` if fixing.
- Write \`${intermediateDir}/retry_request.json\` ONLY if requesting retries.
` + commonConstraints,
                    token,
                    options.toolInvocationToken
                );

                // ---------------------------------------------------------
                // Check for Retries
                // ---------------------------------------------------------
                // L6 requested a retry: need to re-run L3/L4/L5 for specific components
                const retryFileUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, intermediateDir, 'retry_request.json'));
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
                `You are the Indexer Agent.
Input: 
- "` + intermediateDir + `/L4_overview.md"
- Scan "` + outputPath + `/pages/"

Instructions:
1. Create "` + outputPath + `/README.md" including the L4 Overview and a comprehensive Table of Contents, linking to ALL generated pages.
   - Categorize pages if possible (e.g., by importance or module type).

Output:
- Write README.md.
` + commonConstraints,
                token,
                options.toolInvocationToken
            );

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    '✅ DeepWiki Generation Completed!\n\n' +
                    `Documented ${componentList.length} components. Check the \`${outputPath}\` directory.`
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
        logger.log('DeepWiki', `>>> Starting Phase: ${agentName}`);
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
            for (const part of result.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    logger.log(agentName, `Result: ${part.value.substring(0, 200)}...`);
                }
            }
        } catch (error) {
            logger.error(agentName, `Failed: ${error}`);
            throw error;
        }
    }
}
