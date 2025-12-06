# DeepWiki Generator

A VS Code extension that generates comprehensive DeepWiki documentation for your workspace using Copilot Chat with an advanced multi-stage analysis pipeline.

## Features

- **One-click documentation**: Simply invoke the `#createDeepWiki` tool in Copilot Chat to generate complete documentation
- **Multi-stage pipeline architecture**: Uses a sophisticated 5-level pipeline with 18+ specialized AI agents
- **Parallel execution**: Independent analysis tasks run concurrently for maximum efficiency
- **Self-validation**: Automated quality checks ensure accurate and complete documentation
- **Comprehensive analysis**: Analyzes file structure, dependencies, architecture patterns, design patterns, and generates detailed module documentation with examples

## Usage

1. Open a workspace in VS Code
2. Open Copilot Chat (Ctrl+Shift+I or Cmd+Shift+I)
3. Type: `@workspace #createDeepWiki` or ask Copilot to create documentation for your workspace
4. The tool will analyze your codebase and generate documentation in the `.deepwiki` folder

## Generated Documentation

The tool generates the following files in the `.deepwiki` folder:

- `README.md` - Main project overview and documentation
- `ARCHITECTURE.md` - Detailed architecture documentation with diagrams
- `API.md` - API reference for all modules
- `deepwiki.json` - Raw JSON data for programmatic access

## Multi-Stage Pipeline Architecture

The extension uses an advanced **5-level pipeline architecture** where multiple specialized AI agents work together:

### Level 1: Analysis Phase (Parallel)
1. **File Scanner** - Scans all workspace files and collects metadata
2. **Structure Analyzer** - Analyzes workspace file structure and organization
3. **Dependency Analyzer** - Analyzes project dependencies and detects package managers
4. **Framework Detector** - Identifies frameworks and libraries used
5. **Architecture Analyzer** - Identifies high-level architectural patterns

### Level 2: Deep Analysis Phase (Parallel per module)
6. **Code Parser** - Performs AST-based code structure analysis
7. **Dependency Mapper** - Creates detailed dependency graphs
8. **Pattern Recognizer** - Detects design patterns (Singleton, Factory, Observer, etc.)
9. **Function Analyzer** - Analyzes functions with complexity metrics
10. **Class Analyzer** - Analyzes classes with relationship mapping
11. **API Extractor** - Extracts public API information
12. **Type Analyzer** - Analyzes type information and interfaces
13. **Module Documenter** - Generates detailed documentation for each module

### Level 3: Quality Enhancement Phase
14. **Example Generator** - Automatically generates usage examples
15. **Diagram Generator** - Creates Mermaid diagrams for visualization
16. **Cross Referencer** - Resolves cross-references between elements

### Level 4: Validation Phase
17. **Accuracy Validator** - Validates accuracy of generated documentation
18. **Completeness Checker** - Checks documentation coverage and completeness
19. **Consistency Checker** - Ensures consistency across documentation

### Level 5: Output Phase
20. **Overview Generator** - Compiles all analysis into comprehensive overview
21. **Markdown Formatter** - Formats documentation into well-structured Markdown
22. **TOC Generator** - Generates table of contents
23. **Index Builder** - Builds searchable index

### Pipeline Features
- **Parallel Execution**: Tasks within the same level run concurrently
- **Dependency Management**: Tasks automatically wait for required prerequisites
- **Error Resilience**: Failures in optional tasks don't stop the pipeline
- **Progress Tracking**: Real-time progress updates during generation

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `outputPath` | string | `.deepwiki` | Output directory for generated documentation |
| `includePrivate` | boolean | `false` | Include private/internal APIs in documentation |
| `maxDepth` | number | `5` | Maximum depth for analyzing nested modules |

## Requirements

- VS Code 1.95.0 or higher
- GitHub Copilot extension

## Development

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Watch for changes
npm run watch
```

## Architecture Details

The extension is built with:
- **TypeScript**: Strongly typed for reliability
- **Modular Design**: Each subagent is independent and reusable
- **Scalable Pipeline**: Easy to add new analysis phases or subagents
- **VS Code Language Model API**: Leverages GitHub Copilot for intelligent analysis

## License

MIT
