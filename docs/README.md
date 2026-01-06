# DeepWiki Generator Documentation

This documentation covers the architecture, implementation patterns, and configuration options for the DeepWiki Generator VS Code extension.

## Overview

DeepWiki Generator is a VS Code extension that generates comprehensive technical documentation for codebases using autonomous AI agents. It orchestrates a sophisticated 9-stage pipeline (L1-L9) with validation gates and self-correction loops to produce high-quality, verified documentation.

## Documentation Index

### Architecture & Design

- **[Architecture Overview](./architecture.md)** - System architecture, pipeline flow, and design decisions
- **[Agent Orchestration Patterns](./agent-orchestration.md)** - Programmatic, Agentic, and Hybrid orchestration paradigms

### Implementation Details

- **[Pipeline Stages](./pipeline-stages.md)** - Detailed description of each pipeline stage (L1-L9)
- **[runSubagent Patterns](./runSubagent-patterns.md)** - Patterns for programmatic agent orchestration using `runSubagent`

### Configuration

- **[Configuration Guide](./configuration.md)** - Tool parameters, resume options, and customization

## Quick Start

1. Install the extension in VS Code
2. Open Copilot Chat (Ctrl+Shift+I / Cmd+Shift+I)
3. Type: `@workspace #createDeepWiki`
4. Documentation will be generated in `.deepwiki/`

## Key Features

| Feature | Description |
|---------|-------------|
| **Autonomous Agents** | Specialized sub-agents handle discovery, analysis, writing, and review |
| **Validation Gates** | L1-R, L3-R, and L5-V stages verify outputs and trigger retries |
| **Self-Correction** | Multiple feedback loops ensure quality (L2, L3, L5, L6) |
| **Proof-Driven** | Fact Extraction phase prevents hallucination by grounding in source code |
| **Component-Based** | Documents logical components rather than individual files |

## Output Structure

```
.deepwiki/
├── README.md           # Landing page with system overview
├── pages/              # Component documentation (1 component = 1 page)
└── intermediate/       # Pipeline artifacts (L1-L9 outputs)
```

## Requirements

- VS Code 1.95.0+
- GitHub Copilot extension
