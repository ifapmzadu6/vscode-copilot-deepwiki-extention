# DeepWiki Generator

A VS Code extension that generates comprehensive DeepWiki documentation for your workspace using Copilot Chat.

## Features

- **One-click documentation**: Simply invoke the `#createDeepWiki` tool in Copilot Chat to generate complete documentation
- **Subagent architecture**: Uses multiple specialized AI agents to analyze different aspects of your codebase
- **Comprehensive analysis**: Analyzes file structure, dependencies, architecture patterns, and generates module documentation

## Usage

1. Open a workspace in VS Code
2. Open Copilot Chat (Ctrl+Shift+I or Cmd+Shift+I)
3. Type: `@workspace #createDeepWiki` or ask Copilot to create documentation for your workspace
4. The tool will analyze your codebase and generate documentation in the `.deepwiki` folder

## Generated Documentation

The tool generates the following files in the `.deepwiki` folder:

- `README.md` - Main project overview and documentation
- `ARCHITECTURE.md` - Detailed architecture documentation
- `API.md` - API reference for all modules
- `deepwiki.json` - Raw JSON data for programmatic access

## How It Works

The extension uses a **subagent architecture** where multiple specialized AI agents work together:

1. **Structure Analyzer** - Scans and analyzes the workspace file structure
2. **Dependency Analyzer** - Analyzes project dependencies and detects frameworks
3. **Architecture Analyzer** - Identifies architectural patterns and layers
4. **Module Documenter** - Generates detailed documentation for each module
5. **Overview Generator** - Compiles all analysis into a comprehensive overview

Each subagent uses the Language Model API to perform intelligent analysis of your codebase.

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

## License

MIT
