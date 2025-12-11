import { PhaseContext, runPhase, getPipelineOverview } from './PhaseRunner';

/**
 * L4: Architect Phase
 * Creates system-level overview, component relationships, and architecture maps.
 */
export async function runL4(
    ctx: PhaseContext,
    loopCount: number
): Promise<void> {
    await runPhase(
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
Read ALL files in \`${ctx.intermediateDir}/L3/\` (including those from previous loops).

## Workflow
1. Read L3 analysis files → Understand component landscape
2. Define High-Level Architecture → Use \`applyPatch\` to write \`overview.md\`
3. Analyze Causal Impact (how changes propagate) → Use \`applyPatch\` to write
4. Explain the 'Why' behind architectural decisions → Use \`applyPatch\` to write
5. Create Mermaid diagrams → Use \`applyPatch\` to write \`relationships.md\`
   - **Recommended**: \`C4Context\`, \`stateDiagram-v2\`, \`sequenceDiagram\`, \`classDiagram\`, \`block\`
   - **Forbidden**: \`flowchart\`, \`graph TD\`

## Output
- Write to \`${ctx.intermediateDir}/L4/overview.md\`
- Write to \`${ctx.intermediateDir}/L4/relationships.md\`
- Include at least TWO diagrams

## Constraints
1. **Scope**: Do NOT modify files outside of the ".deepwiki" directory. Read-only access is allowed for source code.
2. **Chat Final Response**: Keep your chat reply brief (e.g., "Task completed."). Do not include file contents in your response.
3. **Incremental Writing**: Use \`applyPatch\` after each instruction step. Due to token limits, writing all at once risks data loss.

` + getPipelineOverview('L4'),
        ctx
    );
}
