# Configuration Guide

This document describes the configuration options and parameters for the DeepWiki Generator.

## Tool Parameters

When invoking the `createDeepWiki` tool, you can pass the following parameters:

| Parameter | Required | Type | Default | Description |
|-----------|----------|------|---------|-------------|
| `fileEditToolName` | **Yes** | string | - | Name of the file edit tool available to sub-agents |
| `outputPath` | No | string | `.deepwiki` | Output directory for generated documentation |
| `startFromStage` | No | enum | `L1` | Stage to start/resume from |
| `mermaidValidatorToolName` | No | string | - | Mermaid syntax validator tool name |
| `codeUsagesToolName` | No | string | - | Code usages lookup tool name |

## Parameter Details

### fileEditToolName (Required)

The name of the file editing tool that sub-agents should use. This varies by environment:

| Environment | Common Tool Names |
|-------------|-------------------|
| GitHub Copilot | `apply_patch`, `replace_string_in_file` |
| Claude | `str_replace_editor`, `write_file` |
| Other | Check your environment's available tools |

**Usage in prompt**:
```
Type: @workspace #createDeepWiki fileEditToolName="apply_patch"
```

### outputPath

Directory where documentation will be generated. Relative to workspace root.

**Default**: `.deepwiki`

**Constraints**:
- Must be a valid directory path
- Cannot escape workspace root
- Cannot be `.`, `/`, or `\`

**Structure created**:
```
{outputPath}/
├── README.md
├── pages/
│   └── {ComponentName}.md
└── intermediate/
    ├── L1/
    ├── L1R/
    ├── L2/
    ├── L3/
    ├── L3R/
    ├── L4/
    ├── L5/
    ├── L5V/
    ├── L6/
    ├── L7/
    ├── L8/
    └── L9/
```

### startFromStage

Resume the pipeline from a specific stage. Useful for:
- Recovering from failures
- Re-running specific stages after manual edits
- Iterating on documentation quality

**Valid values**:
| Value | Description |
|-------|-------------|
| `L1` | Full run (default) - cleans output directory |
| `L2` | Skip L1, requires `project_context.md` |
| `L3` | Skip L1-L2, requires `component_list.json` |
| `L4` | Skip L1-L3, requires L3 analysis files |
| `L5` | Skip L1-L4, requires L4 overview/relationships |
| `L6` | Skip L1-L5, auto-regenerates missing pages |
| `L7` | Skip L1-L6, requires pages directory |
| `L8` | Skip L1-L7, requires README.md |
| `L9` | Skip L1-L8, final cleanup only |
| `auto` | AI determines optimal resume point |

**Resume Prerequisites**:

| Starting Stage | Required Artifacts |
|----------------|-------------------|
| L2 | `intermediate/L1/project_context.md` |
| L3+ | `intermediate/L2/component_list.json` |
| L4 | `intermediate/L3/*_analysis.md` (at least one) |
| L5+ | `intermediate/L4/overview.md`, `relationships.md` |
| L6+ | `pages/` directory exists |
| L7+ | `intermediate/L5/page_groups.json` (optional but preferred) |
| L8+ | `README.md` |

**Auto-Detection Mode**:

When `startFromStage=auto`, an AI sub-agent analyzes existing artifacts:
1. Checks which intermediate files exist
2. Evaluates their completeness
3. Determines the optimal stage to resume from
4. Returns stage and reasoning

### mermaidValidatorToolName

Optional tool for validating Mermaid diagram syntax. When provided, sub-agents will:
1. Generate Mermaid diagrams
2. Call the validator tool
3. Fix any syntax errors before proceeding

**Common tool names**:
- `mcp__mermaid__validate` (MCP server)
- Environment-specific validators

**Benefits**:
- Catch syntax errors early
- Ensure diagrams render correctly
- Reduce manual fixes needed

### codeUsagesToolName

Optional tool for looking up code usages/references. Enables more accurate:
- Dependency analysis
- Relationship verification
- Impact assessment

**Common tool names**:
- `list_code_usages`
- `find_references`
- Environment-specific reference tools

**When provided, sub-agents will**:
- Trace function/class/method usages
- Verify claimed caller-callee relationships
- Build accurate dependency matrices

## Usage Examples

### Basic Usage
```
@workspace #createDeepWiki fileEditToolName="apply_patch"
```

### Custom Output Path
```
@workspace #createDeepWiki fileEditToolName="apply_patch" outputPath="docs/wiki"
```

### Resume from L6
```
@workspace #createDeepWiki fileEditToolName="apply_patch" startFromStage="L6"
```

### Auto-Resume
```
@workspace #createDeepWiki fileEditToolName="apply_patch" startFromStage="auto"
```

### Full Configuration
```
@workspace #createDeepWiki fileEditToolName="apply_patch" outputPath=".deepwiki" startFromStage="L1" mermaidValidatorToolName="mcp__mermaid__validate" codeUsagesToolName="list_code_usages"
```

## Pipeline Behavior

### Full Run (L1)
When starting from L1:
1. Cleans/deletes existing output directory
2. Creates fresh intermediate directories
3. Runs all stages sequentially

### Resume Run (L2+)
When resuming:
1. **No cleanup** - preserves existing artifacts
2. Validates prerequisites exist
3. Skips earlier stages
4. Reuses existing intermediate files

### Auto-Repair (L6+)
When resuming from L6 or later:
- Automatically detects missing page files
- Re-runs L5 Writer for missing components
- Then continues with L6 review

## Retry Configuration

Built into the pipeline (not user-configurable):

| Mechanism | Max Retries | Delay |
|-----------|-------------|-------|
| Phase retry (transient failures) | 3 | 15s |
| L2 Draft→Review→Refine | 6 | - |
| L3 Analysis retry | 1 per component | - |
| L5 Page retry | 1 per component | - |
| L6 Critical Failure Loop | 5 | - |

## Logging

All pipeline activity is logged to:
- **VS Code Output Channel**: "DeepWiki Generator"
- **Format**: `[HH:MM:SS.mmm] [Prefix] Message`

To view logs:
1. Open Output panel (View → Output)
2. Select "DeepWiki Generator" from dropdown

Log prefixes:
| Prefix | Meaning |
|--------|---------|
| `Extension` | Extension lifecycle |
| `DeepWiki` | Pipeline progress |
| `Tasks` | Sequential task execution |

## Nested DeepWiki Handling

If the workspace contains subdirectories with existing `.deepwiki/README.md`:
1. Those subtrees are **excluded** from analysis
2. The generated docs only **link** to existing DeepWikis
3. Nested DeepWiki list stored in `intermediate/L1/existing_deepwikis.md`

## Security Considerations

Sub-agents operate under strict constraints:
- **Allowed**: File read/write, search, Mermaid validation
- **Forbidden**: Terminal execution, external processes

All file operations restricted to:
- Reading: Any file in workspace
- Writing: Only under `{outputPath}/`
