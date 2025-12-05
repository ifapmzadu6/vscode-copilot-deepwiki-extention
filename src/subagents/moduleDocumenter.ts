import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import {
  SubagentContext,
  ModuleDocumentation,
  FileAnalysis,
  ArchitectureAnalysis,
  WorkspaceStructure,
} from '../types';

/**
 * Subagent that generates documentation for each module
 */
export class ModuleDocumenterSubagent extends BaseSubagent {
  id = 'module-documenter';
  name = 'Module Documenter';
  description = 'Generates detailed documentation for each module';

  async execute(context: SubagentContext): Promise<ModuleDocumentation[]> {
    const { workspaceFolder, model, progress, token, previousResults, parameters } =
      context;

    progress('Generating module documentation...');

    const structure = previousResults.get('structure-analyzer') as WorkspaceStructure;
    const architecture = previousResults.get('architecture-analyzer') as ArchitectureAnalysis;

    const modules = architecture?.modules || [];
    const documentation: ModuleDocumentation[] = [];

    // Limit modules to document based on parameters (increased for better coverage)
    const maxModules = Math.min(modules.length, (parameters.maxDepth || 5) * 10);
    const modulesToDocument = modules.slice(0, maxModules);

    for (let i = 0; i < modulesToDocument.length; i++) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      const mod = modulesToDocument[i];
      progress(`Documenting module ${i + 1}/${modulesToDocument.length}: ${mod.name}`);

      // Get files in this module
      const moduleFiles = structure.files.filter((f) =>
        f.relativePath.startsWith(mod.path)
      );

      // Get sample code from key files
      const keyFiles = this.selectKeyFiles(moduleFiles.map((f) => f.relativePath));
      const codeSnippets: string[] = [];

      // Increased file limit from 3 to 10 for better analysis
      for (const filePath of keyFiles.slice(0, 10)) {
        const file = moduleFiles.find((f) => f.relativePath === filePath);
        if (file) {
          const content = await this.readFile(file.uri);
          if (content) {
            // Increased content limit from 2000 to 8000 chars for deeper analysis
            const truncated =
              content.length > 8000
                ? content.substring(0, 8000) + '\n... (truncated)'
                : content;
            codeSnippets.push(`// ${filePath}\n${truncated}`);
          }
        }
      }

      // Generate documentation using LLM
      const docPrompt = `Generate documentation for this module:

Module Name: ${mod.name}
Module Path: ${mod.path}
Module Type: ${mod.type}
Current Description: ${mod.description}
Files in Module: ${moduleFiles.map((f) => f.relativePath).join(', ')}

Code Samples:
${codeSnippets.join('\n\n---\n\n')}

Respond with a JSON object:
{
  "description": "Detailed description of what this module does",
  "usage": "How to use this module (with code examples if applicable)",
  "api": {
    "path": "${mod.path}",
    "summary": "Brief summary of the module's purpose",
    "exports": [{"name": "exportName", "type": "class|function|const|interface|type|default", "isPublic": true}],
    "imports": [{"source": "source-package", "names": ["import1"], "isExternal": true}],
    "classes": [{"name": "ClassName", "description": "description", "methods": ["method1"], "properties": ["prop1"], "isExported": true}],
    "functions": [{"name": "funcName", "description": "description", "parameters": ["param: type"], "returnType": "ReturnType", "isExported": true, "isAsync": false}]
  }
}`;

      try {
        const response = await this.queryModel(
          model,
          'You are a technical documentation writer. Generate clear, comprehensive documentation. Respond only with valid JSON.',
          docPrompt,
          token
        );

        const doc = this.parseJsonResponse<{
          description: string;
          usage: string;
          api: FileAnalysis;
        }>(response);

        documentation.push({
          name: mod.name,
          path: mod.path,
          description: doc.description || mod.description,
          usage: doc.usage || '',
          api: doc.api || this.createEmptyFileAnalysis(mod.path),
        });
      } catch {
        // Fall back to basic documentation
        documentation.push({
          name: mod.name,
          path: mod.path,
          description: mod.description,
          usage: '',
          api: this.createEmptyFileAnalysis(mod.path),
        });
      }
    }

    progress('Module documentation complete');

    return documentation;
  }

  private selectKeyFiles(files: string[]): string[] {
    // Prioritize certain file types
    const priorities = [
      // Entry points
      (f: string) => /index\.(ts|js|tsx|jsx)$/.test(f),
      // Main files
      (f: string) => /main\.(ts|js|py|go|rs)$/.test(f),
      // Type definitions
      (f: string) => /types?\.(ts|d\.ts)$/.test(f),
      // API/Route files
      (f: string) => /(api|route|controller)\.(ts|js)$/.test(f),
      // Service files
      (f: string) => /service\.(ts|js)$/.test(f),
      // Model/Entity files
      (f: string) => /(model|entity)\.(ts|js|py)$/.test(f),
    ];

    const selected: string[] = [];

    for (const priority of priorities) {
      for (const file of files) {
        if (priority(file) && !selected.includes(file)) {
          selected.push(file);
        }
      }
    }

    // Add remaining source files
    const sourceExtensions = ['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs', '.java'];
    for (const file of files) {
      if (!selected.includes(file)) {
        const ext = file.substring(file.lastIndexOf('.'));
        if (sourceExtensions.includes(ext)) {
          selected.push(file);
        }
      }
    }

    return selected;
  }

  private createEmptyFileAnalysis(path: string): FileAnalysis {
    return {
      path,
      summary: '',
      exports: [],
      imports: [],
      classes: [],
      functions: [],
    };
  }
}
