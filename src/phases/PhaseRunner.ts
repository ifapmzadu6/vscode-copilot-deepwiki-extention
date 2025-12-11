import * as vscode from 'vscode';
import { logger } from '../utils/logger';

/**
 * Context object passed to all phase runners.
 * Contains shared state and utilities needed by each phase.
 */
export interface PhaseContext {
    workspaceFolder: vscode.WorkspaceFolder;
    outputPath: string;
    intermediateDir: string;
    token: vscode.CancellationToken;
    toolInvocationToken: vscode.ChatParticipantToolToken | undefined;
}

/**
 * Runs a single phase of the DeepWiki pipeline by invoking a subagent.
 * 
 * @param agentName - Display name for the phase (e.g., "L3: Analyzer")
 * @param description - Brief description of what this phase does
 * @param prompt - Full prompt to send to the subagent
 * @param ctx - Phase context with cancellation token and tool invocation token
 */
export async function runPhase(
    agentName: string,
    description: string,
    prompt: string,
    ctx: PhaseContext
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
                toolInvocationToken: ctx.toolInvocationToken
            },
            ctx.token
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

/**
 * Generate pipeline overview with current stage highlighted.
 * Used in prompts to show agents where they are in the pipeline.
 */
export function getPipelineOverview(currentStage: string): string {
    return `
## Pipeline Overview
- **Complete Pipeline Flow:**
   0. **L0 Project Context**${currentStage === 'L0' ? ' **← YOU ARE HERE**' : ''}:
      - Analyzes project structure, build system, and conditional code patterns
      - Outputs \`project_context.md\` for downstream agents to reference
   1. **L1 Discovery (L1-A → L1-B → L1-C)**${currentStage.startsWith('L1') ? ' **← YOU ARE HERE**' : ''}:
      - L1-A Drafter: Creates initial component grouping${currentStage === 'L1-A' ? ' **← YOU**' : ''}
      - L1-B Reviewer: Critiques the draft${currentStage === 'L1-B' ? ' **← YOU**' : ''}
      - L1-C Refiner: Produces final validated component list${currentStage === 'L1-C' ? ' **← YOU**' : ''}
      - Uses L0 context to understand project structure
   2. **L2 Extraction**${currentStage === 'L2' ? ' **← YOU ARE HERE**' : ''}:
      - Extracts API signatures, internal logic, side effects, and dependency relationships
      - Provides structured insights (Internal Logic, Side Effects, Called By/Calls) for L3's causal analysis
      - Notes conditional code patterns based on L0 context
   3. **L3 Analyzer**${currentStage === 'L3' ? ' **← YOU ARE HERE**' : ''}:
      - Deep component analysis with causality tracing and diagrams
   4. **L4 Architect**${currentStage === 'L4' ? ' **← YOU ARE HERE**' : ''}:
      - System-level overview, component relationships, and architecture maps
   5. **L5 Documentation Generation**${currentStage.startsWith('L5') ? ' **← YOU ARE HERE**' : ''}:
      - **L5-Pre Consolidator** (Pre-A → Pre-B → Pre-C): Groups components into pages${currentStage.startsWith('L5-Pre') ? ' **← YOU**' : ''}
      - **L5 Writer**: Transforms analysis into final documentation pages based on page_structure.json${currentStage === 'L5' ? ' **← YOU**' : ''}
   6. **L6 Reviewer**${currentStage === 'L6' ? ' **← YOU ARE HERE**' : ''}:
      - Quality gate - fixes minor issues, requests retry for major problems
   7. **Indexer**${currentStage === 'Indexer' ? ' **← YOU ARE HERE**' : ''}:
      - Creates final README with table of contents
      - Links all generated pages together
      - Sanitizes any intermediate references
- **Strategic Context:**
   - **Project Context**: L0 provides build system and conditional code awareness to all downstream agents
   - **Parallel Execution**: L2, L3, and L5 run in parallel batches to handle multiple components efficiently
   - **Quality Gates**: L1-B and L6 serve as quality checkpoints to ensure accuracy
   - **Page Consolidation**: L5-Pre analyzes L3 outputs and groups similar components into single pages for better documentation structure
 `;
}
