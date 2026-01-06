# Mastering `runSubagent`: Patterns for Programmatic Agent Orchestration

The `runSubagent` tool is a powerful capability within VS Code's Copilot Chat API that allows extensions to spawn autonomous, stateless AI agents. This guide distills patterns from building the DeepWiki Generator, a 9-stage agentic pipeline with validation gates and self-correction loops.

## 1. The Basics: Invoking a Sub-Agent

```typescript
import * as vscode from 'vscode';

const result = await vscode.lm.invokeTool(
    'runSubagent',
    {
        input: {
            description: "Analyze the project structure",  // Short description for UI
            prompt: "You are a Surveyor Agent. Scan the current workspace and..."  // Detailed prompt
        },
        toolInvocationToken: options.toolInvocationToken  // Pass from parent request
    },
    token  // CancellationToken
);

// Parse the result
for (const part of result.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
        console.log("Agent Output:", part.value);
    }
}
```

### Key Concepts
- **Stateless**: Each call starts fresh. No memory of previous turns.
- **Synchronous**: The call awaits completion.
- **Token Propagation**: Pass `toolInvocationToken` for workspace access.

---

## 2. Architecture: Manager-Worker Pattern

Do not try to do everything in one prompt. Use the **Manager-Worker** pattern:

- **Manager (`DeepWikiTool`)**: TypeScript code handles flow, state, retries. Does NOT use LLMs for thinking.
- **Workers (Sub-Agents)**: Specialized prompts for specific tasks (Analyzer, Writer, Reviewer).

```
┌─────────────────┐
│  DeepWikiTool   │  ◄── Manager (TypeScript)
│  (Orchestrator) │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────┐
│        runSubagent Workers          │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐       │
│  │ L1 │ │ L2 │ │ L3 │ │... │       │
│  └────┘ └────┘ └────┘ └────┘       │
└─────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│     File System (Shared State)      │
│  .deepwiki/intermediate/*.md        │
│  .deepwiki/pages/*.md               │
└─────────────────────────────────────┘
```

### Data Sharing via File System

**CRITICAL**: Do NOT rely on chat response (`result.content`) for data transfer.
- Token limits cause truncation
- Parsing complex data from text is fragile

**Best Practice**: Use the file system as shared memory.

```typescript
// Manager: Instruct agent to write to specific path
const prompt = `
Analyze the component and write results to:
\`${intermediateDir}/L3/${componentId}_analysis.md\`

CONSTRAINT: Keep chat response brief (e.g., "Task completed.")
`;

// After agent completes, Manager reads the file
const content = await vscode.workspace.fs.readFile(outputUri);
```

### Why File Output?

| Approach | Limit | Use Case |
|----------|-------|----------|
| Chat response | ~4K tokens | Simple confirmations |
| File output | Unlimited | Analysis, documentation, JSON data |

---

## 3. Advanced Patterns

### A. Sequential Processing with Auto-Retry

Run sub-agents sequentially to allow context propagation (e.g., one agent fixes shared files for subsequent agents).

```typescript
async function runTasksSequentially<T>(
    tasks: (() => Promise<T>)[],
    taskGroupName: string,
    cancellationToken?: vscode.CancellationToken
): Promise<T[]> {
    const results: (T | undefined)[] = new Array(tasks.length).fill(undefined);
    const failedIndices: number[] = [];

    // First pass: run all tasks
    for (let i = 0; i < tasks.length; i++) {
        if (cancellationToken?.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
        try {
            results[i] = await tasks[i]();
        } catch (error) {
            if (error instanceof vscode.CancellationError) throw error;
            failedIndices.push(i);
        }
    }

    // Second pass: retry failed tasks once
    for (const idx of failedIndices) {
        if (cancellationToken?.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
        try {
            results[idx] = await tasks[idx]();
        } catch { /* logged */ }
    }

    return results.filter((r): r is T => r !== undefined);
}
```

**Usage in DeepWiki**:
```typescript
const l3Tasks = components.map(component => createL3Task(component));
await runTasksSequentially(l3Tasks, 'L3 Analysis', token);
```

**Benefits**:
- Context propagation (L3 can fix `project_context.md` for subsequent L3 runs)
- Automatic retry for transient failures
- Clean cancellation handling

### B. Self-Correction Loop (Draft → Review → Refine)

LLMs make mistakes. Implement feedback loops:

```typescript
let retryCount = 0;
const MAX_RETRIES = 6;

while (retryCount < MAX_RETRIES) {
    // 1. Draft
    await runPhase('L2-A: Drafter', 'Draft component list', draftPrompt);

    // 2. Review
    await runPhase('L2-B: Reviewer', 'Critique the draft', reviewPrompt);

    // 3. Check review result
    const reviewContent = await readFile('review_report.md');
    if (reviewContent.startsWith('APPROVED')) {
        break;  // Exit loop on success
    }

    // 4. Refine based on feedback
    await runPhase('L2-C: Refiner', 'Apply fixes', refinePrompt);
    retryCount++;
}
```

**DeepWiki's L2 Loop**:
- **Drafter** proposes component groupings
- **Reviewer** critiques (writes `APPROVED` or issues list)
- **Refiner** applies fixes
- Loop until valid JSON or max retries

### C. Validation Gates

Insert validation stages to catch issues early:

```typescript
// After L3 Analysis
await runPhase('L3-R: Reviewer', 'Verify analysis quality', l3rPrompt);

// Check for retry requests
const retryFiles = await vscode.workspace.findFiles(
    `${intermediateDir}/L3R/*_retry.json`
);

const retryIds: string[] = [];
for (const uri of retryFiles) {
    const content = JSON.parse(await readFile(uri));
    retryIds.push(...content);
    await vscode.workspace.fs.delete(uri);  // Cleanup
}

// Retry failed components
if (retryIds.length > 0) {
    const retryComponents = components.filter(c => retryIds.includes(c.id));
    const retryTasks = retryComponents.map(c => createL3Task(c));
    await runTasksSequentially(retryTasks, 'L3 Retry', token);
}
```

**DeepWiki's Validation Gates**:
| Gate | Purpose | On Failure |
|------|---------|------------|
| L1-R | Verify project context | Direct fix |
| L3-R | Verify analysis quality | Retry component |
| L5-V | Verify page files exist | Retry page |

### D. Critical Failure Loop

When a downstream stage finds fundamental issues, loop back to earlier stages:

```typescript
let loopCount = 0;
const MAX_LOOPS = 5;

while (componentsToAnalyze.length > 0 && loopCount < MAX_LOOPS) {
    // L3: Analyze
    await runL3(componentsToAnalyze);

    // L4: Architect
    await runL4();

    // L5: Write pages
    await runL5(componentsToAnalyze);

    // L6: Review pages
    await runL6();

    // Check for retry requests
    const retryRequest = await readJsonOrNull('L6/retry_request.json');

    if (retryRequest && retryRequest.length > 0) {
        // Loop back to L3 with specific components
        componentsToAnalyze = components.filter(c => retryRequest.includes(c.id));
        loopCount++;
    } else {
        componentsToAnalyze = [];  // Exit loop
    }
}
```

### E. Phase Runner with Retry

Wrap sub-agent calls with automatic retry for transient failures:

```typescript
private async runPhase(
    agentName: string,
    description: string,
    prompt: string,
    token: vscode.CancellationToken,
    toolInvocationToken: vscode.ChatParticipantToolToken | undefined,
    options?: { maxAttempts?: number; retryDelayMs?: number }
): Promise<void> {
    const maxAttempts = options?.maxAttempts ?? 1;
    const retryDelayMs = options?.retryDelayMs ?? 15000;

    const isRetryable = (text: string): boolean =>
        /(request failed|rate limit|timeout|network error)/i.test(text);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Wait before each attempt (rate limit protection)
        await new Promise(r => setTimeout(r, attempt === 1 ? 10000 : retryDelayMs));

        try {
            const result = await vscode.lm.invokeTool('runSubagent', {
                input: { description, prompt },
                toolInvocationToken
            }, token);

            // Check if result indicates failure
            const resultText = extractText(result);
            if (isRetryable(resultText) && attempt < maxAttempts) {
                continue;  // Retry
            }

            return;  // Success
        } catch (error) {
            if (attempt >= maxAttempts || !isRetryable(String(error))) {
                throw error;
            }
        }
    }
}
```

---

## 4. Prompt Engineering Tips

### 1. Deep Thinking Protocol

Enable "scratchpad" reasoning (text before tool calls is discarded from user view):

```typescript
const getDeepThinkingProtocol = (): string => `
## Deep Thinking Protocol
Your text output before each tool call is invisible to users but remains in YOUR context.

### Before EACH Tool Call
1. **Situation Analysis**: Current state and goal
2. **Hypotheses** (3): Possible approaches
3. **Decision**: Best approach and why

### After EACH Tool Result
1. **Reflection**: Was hypothesis correct?
2. **Adjustment**: Next action

### Final Output
Keep final chat response brief. Detailed reasoning stays in pre-tool text.
`;
```

### 2. Anti-Hallucination Rules

```typescript
const antiHallucinationRules = `
## Anti-Hallucination Rules

1. **Only write verified facts from source code**
   - Every function name must exist
   - Every relationship must be verifiable

2. **When uncertain, omit rather than guess**
   - Shorter document with facts > longer document with errors

3. **Avoid vague words**: "handles", "manages", "processes"
   - Use specific implementation details instead

4. **Self-check before every write**:
   - "Did I actually see this in the source code?"
   - "Can I point to the exact line?"
`;
```

### 3. Incremental Writing

Prevent output size limit issues:

```typescript
const incrementalWritingConstraint = `
## Incremental Writing (CRITICAL)
File write operations have output size limits.

**Workflow**:
1. Write ONE section at a time
2. Use \`${editToolName}\` after EACH section
3. Do NOT try to write entire file at once

**Priority** (if running out of space):
1. CEI blocks with evidence
2. Data flow paths
3. Diagrams
4. Narrative summary
`;
```

### 4. Structured Output

Force specific formats for machine-readable output:

```typescript
const outputFormat = `
## Output
Write RAW JSON to \`${outputPath}\`:

**Format** (no markdown fences):
[
  {
    "id": "ComponentId",
    "name": "Component Name",
    "files": ["path/to/file.ts"]
  }
]

**JSON Rules**:
- No trailing commas
- No comments
- Starts with \`[\`, ends with \`]\`
`;
```

---

## 5. Pitfalls & Solutions

### Template Literal Escaping

**Problem**: Markdown uses backticks, TypeScript template literals use backticks.

**Solution**:
```typescript
const bq = '`';
const mdCodeBlock = bq + bq + bq;
const prompt = `Use this format:
${mdCodeBlock}json
{"key": "value"}
${mdCodeBlock}`;
```

### Sanitizing User Input in Prompts

**Problem**: User-provided tool names could break prompts.

**Solution**:
```typescript
const sanitize = (value: string): string =>
    value
        .replace(/[`]/g, '')
        .replace(/[\r\n\t]/g, ' ')
        .trim()
        .slice(0, 80);

const toolName = sanitize(params.fileEditToolName ?? '');
```

### Handling Cancellation

**Problem**: Long pipelines need graceful cancellation.

**Solution**:
```typescript
const checkCancellation = (): void => {
    if (token.isCancellationRequested) {
        logger.warn('DeepWiki', 'Pipeline cancelled by user');
        throw new vscode.CancellationError();
    }
};

// Check before each major operation
checkCancellation();
await runPhase(...);
```

---

## Summary

By combining **TypeScript's control flow** with **`runSubagent`'s autonomous capabilities**, you can build powerful, self-correcting agentic workflows. Key principles:

1. **Manager-Worker Pattern**: Code controls flow, agents do thinking
2. **File System as Memory**: Avoid chat response for data transfer
3. **Sequential with Retry**: Enable context propagation and fault tolerance
4. **Validation Gates**: Catch issues early, trigger targeted retries
5. **Critical Failure Loop**: Allow fundamental re-analysis when needed
6. **Prompt Engineering**: Deep thinking, anti-hallucination, incremental writing
