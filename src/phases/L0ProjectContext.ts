import { PhaseContext, runPhase, getPipelineOverview } from './PhaseRunner';

/**
 * L0: Project Context Analyzer
 * Analyzes project structure, build system, and conditional code patterns.
 */
export async function runL0(ctx: PhaseContext): Promise<void> {
    const mdCodeBlock = '```';

    await runPhase(
        'L0: Project Context Analyzer',
        'Analyze project environment and context',
        `# Project Context Analyzer Agent (L0)

## Role
- **Your Stage**: L0 Analyzer (Pre-Discovery Phase)
- **Core Responsibility**: Understand project structure, build system, and conditional code patterns
- **Critical Success Factor**: Provide context that helps subsequent agents understand which code is active/conditional

## Goal
Analyze the project and create a context document for downstream agents.

## Workflow
1. Detect Project Type, Languages, Build System → Use \`applyPatch\` to write "## Overview" section
2. Identify Target Environments → Use \`applyPatch\` to write "## Target Environments" table
3. Find Conditional Patterns → Use \`applyPatch\` to write "## Conditional Code Patterns" section
   - C/C++: \`#ifdef\`, \`#if defined\`, \`#ifndef\`
   - Python: \`if TYPE_CHECKING\`, platform checks, \`sys.platform\`
   - JS/TS: \`process.env\` checks, feature flags
4. Note Generated/Excluded Code → Use \`applyPatch\` to write "## Generated/Excluded Code" section
5. Add important notes for downstream agents → Use \`applyPatch\` to write "## Notes for Analysis" section

## Output
Write to \`${ctx.intermediateDir}/L0/project_context.md\`

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
3. **Incremental Writing**: Use \`applyPatch\` after each instruction step. Due to token limits, writing all at once risks data loss.

` + getPipelineOverview('L0'),
        ctx
    );
}
