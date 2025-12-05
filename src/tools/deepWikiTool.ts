import * as vscode from 'vscode';
import * as path from 'path';
import {
  IDeepWikiParameters,
  SubagentContext,
  SubagentTask,
  DeepWikiDocument,
  ProgressCallback,
  PipelineContext,
} from '../types';
import {
  StructureAnalyzerSubagent,
  DependencyAnalyzerSubagent,
  ArchitectureAnalyzerSubagent,
  ModuleDocumenterSubagent,
  DiagramGeneratorSubagent,
  OverviewGeneratorSubagent,
} from '../subagents';
import { PipelineOrchestrator } from '../pipeline/orchestrator';

/**
 * DeepWiki Language Model Tool
 *
 * This tool generates comprehensive documentation (DeepWiki) for the current workspace
 * by running multiple subagent tasks that analyze different aspects of the codebase.
 */
export class DeepWikiTool implements vscode.LanguageModelTool<IDeepWikiParameters> {
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /**
   * Prepare the tool invocation - show confirmation message
   */
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<IDeepWikiParameters>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspaceName = workspaceFolders?.[0]?.name || 'current workspace';

    const confirmationMessages = {
      title: 'Generate DeepWiki Documentation',
      message: new vscode.MarkdownString(
        `Generate comprehensive DeepWiki documentation for **${workspaceName}**?\n\n` +
          `This will analyze:\n` +
          `- 📁 File structure and organization\n` +
          `- 📦 Dependencies and frameworks\n` +
          `- 🏗️ Architecture patterns\n` +
          `- 📝 Module documentation\n\n` +
          `Output: \`${options.input.outputPath || '.deepwiki'}\``
      ),
    };

    return {
      invocationMessage: `Generating DeepWiki for ${workspaceName}...`,
      confirmationMessages,
    };
  }

  /**
   * Execute the tool - run all subagents and generate documentation
   */
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<IDeepWikiParameters>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const params = options.input;

    // Validate workspace
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          'Error: No workspace folder is open. Please open a folder first.'
        ),
      ]);
    }

    const workspaceFolder = workspaceFolders[0];

    // Get the language model
    const model = await this.getLanguageModel(token);
    if (!model) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          'Error: Could not access the language model. Please ensure GitHub Copilot is active.'
        ),
      ]);
    }

    try {
      // Check if new pipeline is enabled (default to true)
      // Can be configured via workspace settings or extension configuration
      const config = vscode.workspace.getConfiguration('deepwiki');
      const useNewPipeline = config.get<boolean>('useMultiStagePipeline', true);

      let document: DeepWikiDocument;

      if (useNewPipeline) {
        console.log('[DeepWiki] Using multi-stage pipeline');
        document = await this.runPipelineOrchestrator(
          workspaceFolder,
          model,
          params,
          token
        );
      } else {
        console.log('[DeepWiki] Using legacy pipeline');
        document = await this.runSubagents(
          workspaceFolder,
          model,
          params,
          token
        );
      }

      // Write documentation to files
      const outputPath = await this.writeDocumentation(
        workspaceFolder,
        document,
        params.outputPath
      );

      // Return success result
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `✅ DeepWiki documentation generated successfully!\n\n` +
            `📁 Output location: ${outputPath}\n\n` +
            `## Summary\n` +
            `- **Project**: ${document.title}\n` +
            `- **Languages**: ${document.dependencies.languages.join(', ') || 'Unknown'}\n` +
            `- **Frameworks**: ${document.dependencies.frameworks.join(', ') || 'None'}\n` +
            `- **Architecture**: ${document.architecture.patterns.join(', ') || 'Unknown'}\n` +
            `- **Modules documented**: ${document.modules.length}\n` +
            `- **Files analyzed**: ${document.structure.files.length}\n\n` +
            `## Overview\n${document.overview}`
        ),
      ]);
    } catch (error) {
      if (error instanceof vscode.CancellationError) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('⚠️ DeepWiki generation was cancelled.'),
        ]);
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `❌ Error generating DeepWiki: ${errorMessage}`
        ),
      ]);
    }
  }

  /**
   * Get the language model for subagent queries
   */
  private async getLanguageModel(
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChat | null> {
    const models = await vscode.lm.selectChatModels({
      vendor: 'copilot',
      family: 'gpt-4o',
    });

    if (models.length > 0) {
      return models[0];
    }

    // Fall back to any available model
    const allModels = await vscode.lm.selectChatModels({
      vendor: 'copilot',
    });

    return allModels.length > 0 ? allModels[0] : null;
  }

  /**
   * Run all subagents sequentially to analyze the workspace
   */
  private async runSubagents(
    workspaceFolder: vscode.WorkspaceFolder,
    model: vscode.LanguageModelChat,
    parameters: IDeepWikiParameters,
    token: vscode.CancellationToken
  ): Promise<DeepWikiDocument> {
    // Define the subagent pipeline
    const subagents: SubagentTask[] = [
      new StructureAnalyzerSubagent(),
      new DependencyAnalyzerSubagent(),
      new ArchitectureAnalyzerSubagent(),
      new ModuleDocumenterSubagent(),
      new DiagramGeneratorSubagent(),
      new OverviewGeneratorSubagent(),
    ];

    // Track results from each subagent
    const results = new Map<string, unknown>();

    // Progress tracking
    const totalSteps = subagents.length;
    let currentStep = 0;

    // Create progress callback
    const progress: ProgressCallback = (message: string) => {
      console.log(`[DeepWiki] ${message}`);
      // In a real implementation, you might use vscode.window.withProgress
      // but Language Model Tools don't have direct access to that API during invoke
    };

    // Run each subagent
    for (const subagent of subagents) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      currentStep++;
      progress(`[${currentStep}/${totalSteps}] Running ${subagent.name}...`);

      const context: SubagentContext = {
        workspaceFolder,
        model,
        parameters,
        previousResults: results,
        progress,
        token,
      };

      try {
        const result = await subagent.execute(context);
        results.set(subagent.id, result);
        progress(`[${currentStep}/${totalSteps}] ${subagent.name} complete`);
      } catch (error) {
        if (error instanceof vscode.CancellationError) {
          throw error;
        }
        console.error(`[DeepWiki] Error in ${subagent.name}:`, error);
        // Continue with other subagents even if one fails
      }
    }

    // Return the final document from the overview generator
    const document = results.get('overview-generator') as DeepWikiDocument;
    if (!document) {
      throw new Error('Failed to generate DeepWiki document');
    }

    return document;
  }

  /**
   * Run the new multi-stage pipeline orchestrator
   */
  private async runPipelineOrchestrator(
    workspaceFolder: vscode.WorkspaceFolder,
    model: vscode.LanguageModelChat,
    parameters: IDeepWikiParameters,
    token: vscode.CancellationToken
  ): Promise<DeepWikiDocument> {
    console.log('[DeepWiki] Using new multi-stage pipeline orchestrator');

    const pipelineContext: PipelineContext = {
      workspaceFolder,
      model,
      parameters,
      token,
    };

    const orchestrator = new PipelineOrchestrator();

    // Set progress callback
    orchestrator.setProgressCallback((message: string) => {
      console.log(`[Pipeline] ${message}`);
    });

    // Execute the pipeline
    const results = await orchestrator.execute(pipelineContext);

    // Extract the final document from results
    const document = results.get('overview-generator') as DeepWikiDocument;
    if (!document) {
      throw new Error('Failed to generate DeepWiki document from pipeline');
    }

    return document;
  }

  /**
   * Write the documentation to files
   */
  private async writeDocumentation(
    workspaceFolder: vscode.WorkspaceFolder,
    document: DeepWikiDocument,
    outputPath?: string
  ): Promise<string> {
    const basePath = outputPath || '.deepwiki';
    const fullPath = path.join(workspaceFolder.uri.fsPath, basePath);

    // Create output directory
    const outputUri = vscode.Uri.file(fullPath);
    try {
      await vscode.workspace.fs.createDirectory(outputUri);
    } catch {
      // Directory might already exist
    }

    // Write main README
    const readmeContent = this.generateMarkdownReadme(document);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(path.join(fullPath, 'README.md')),
      new TextEncoder().encode(readmeContent)
    );

    // Write architecture documentation
    const archContent = this.generateArchitectureDoc(document);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(path.join(fullPath, 'ARCHITECTURE.md')),
      new TextEncoder().encode(archContent)
    );

    // Write API documentation
    const apiContent = this.generateApiDoc(document);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(path.join(fullPath, 'API.md')),
      new TextEncoder().encode(apiContent)
    );

    // Write raw JSON data
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(path.join(fullPath, 'deepwiki.json')),
      new TextEncoder().encode(JSON.stringify(document, null, 2))
    );

    return fullPath;
  }

  /**
   * Generate the main README markdown
   */
  private generateMarkdownReadme(doc: DeepWikiDocument): string {
    const lines: string[] = [];

    lines.push(`# ${doc.title}`);
    lines.push('');
    lines.push(`> Generated by DeepWiki on ${new Date(doc.generatedAt).toLocaleDateString()}`);
    lines.push('');
    lines.push('## Overview');
    lines.push('');
    lines.push(doc.overview);
    lines.push('');
    lines.push('## Quick Facts');
    lines.push('');
    lines.push(`- **Languages**: ${doc.dependencies.languages.join(', ') || 'Unknown'}`);
    lines.push(`- **Frameworks**: ${doc.dependencies.frameworks.join(', ') || 'None'}`);
    lines.push(`- **Package Manager**: ${doc.dependencies.packageManager || 'Unknown'}`);
    lines.push(`- **Architecture Patterns**: ${doc.architecture.patterns.join(', ') || 'Unknown'}`);
    lines.push('');
    lines.push('## Project Structure');
    lines.push('');
    lines.push('### Layers');
    lines.push('');
    for (const layer of doc.architecture.layers) {
      lines.push(`- ${layer}`);
    }
    lines.push('');
    lines.push('### Entry Points');
    lines.push('');
    for (const entry of doc.structure.entryPoints) {
      lines.push(`- \`${entry}\``);
    }
    lines.push('');
    lines.push('### Configuration Files');
    lines.push('');
    for (const config of doc.structure.configFiles.slice(0, 10)) {
      lines.push(`- \`${config}\``);
    }
    lines.push('');
    lines.push('## Modules');
    lines.push('');
    for (const mod of doc.modules) {
      lines.push(`### ${mod.name}`);
      lines.push('');
      lines.push(`**Path**: \`${mod.path}\``);
      lines.push('');
      lines.push(mod.description);
      lines.push('');
      if (mod.usage) {
        lines.push('**Usage**:');
        lines.push('');
        lines.push(mod.usage);
        lines.push('');
      }
    }
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('*See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed architecture documentation.*');
    lines.push('');
    lines.push('*See [API.md](./API.md) for API reference.*');

    return lines.join('\n');
  }

  /**
   * Generate architecture documentation
   */
  private generateArchitectureDoc(doc: DeepWikiDocument): string {
    const lines: string[] = [];

    lines.push(`# ${doc.title} - Architecture`);
    lines.push('');

    // Add architecture overview diagram
    if (doc.diagrams?.architectureOverview) {
      lines.push('## Architecture Overview');
      lines.push('');
      lines.push('```mermaid');
      lines.push(doc.diagrams.architectureOverview);
      lines.push('```');
      lines.push('');
    }

    lines.push('## Architectural Patterns');
    lines.push('');
    for (const pattern of doc.architecture.patterns) {
      lines.push(`### ${pattern}`);
      lines.push('');
    }

    // Add layer diagram
    if (doc.diagrams?.layerDiagram) {
      lines.push('## Layer Structure');
      lines.push('');
      lines.push('```mermaid');
      lines.push(doc.diagrams.layerDiagram);
      lines.push('```');
      lines.push('');
    } else {
      lines.push('## Layers');
      lines.push('');
      for (const layer of doc.architecture.layers) {
        lines.push(`### ${layer}`);
        lines.push('');
      }
    }

    // Add module dependencies diagram
    if (doc.diagrams?.moduleDependencies) {
      lines.push('## Module Dependencies');
      lines.push('');
      lines.push('```mermaid');
      lines.push(doc.diagrams.moduleDependencies);
      lines.push('```');
      lines.push('');
    }

    lines.push('## Module Structure');
    lines.push('');
    lines.push('```');
    for (const mod of doc.architecture.modules) {
      lines.push(`${mod.path}/ (${mod.type})`);
      lines.push(`  └── ${mod.description}`);
    }
    lines.push('```');
    lines.push('');

    // Add directory structure diagram
    if (doc.diagrams?.directoryStructure) {
      lines.push('## Directory Structure');
      lines.push('');
      lines.push('```mermaid');
      lines.push(doc.diagrams.directoryStructure);
      lines.push('```');
      lines.push('');
    }

    lines.push('## Dependencies');
    lines.push('');
    lines.push('### Production Dependencies');
    lines.push('');
    for (const [name, version] of Object.entries(doc.dependencies.dependencies).slice(0, 20)) {
      lines.push(`- \`${name}\`: ${version}`);
    }
    lines.push('');
    lines.push('### Development Dependencies');
    lines.push('');
    for (const [name, version] of Object.entries(doc.dependencies.devDependencies).slice(0, 20)) {
      lines.push(`- \`${name}\`: ${version}`);
    }

    return lines.join('\n');
  }

  /**
   * Generate API documentation
   */
  private generateApiDoc(doc: DeepWikiDocument): string {
    const lines: string[] = [];

    lines.push(`# ${doc.title} - API Reference`);
    lines.push('');

    for (const mod of doc.modules) {
      lines.push(`## ${mod.name}`);
      lines.push('');
      lines.push(`**Path**: \`${mod.path}\``);
      lines.push('');

      if (mod.api) {
        if (mod.api.summary) {
          lines.push(mod.api.summary);
          lines.push('');
        }

        if (mod.api.exports?.length > 0) {
          lines.push('### Exports');
          lines.push('');
          for (const exp of mod.api.exports) {
            lines.push(`- \`${exp.name}\` (${exp.type})${exp.isPublic ? '' : ' - internal'}`);
          }
          lines.push('');
        }

        if (mod.api.classes?.length > 0) {
          lines.push('### Classes');
          lines.push('');
          for (const cls of mod.api.classes) {
            lines.push(`#### ${cls.name}`);
            lines.push('');
            lines.push(cls.description);
            lines.push('');
            if (cls.methods?.length > 0) {
              lines.push('**Methods**:');
              for (const method of cls.methods) {
                lines.push(`- \`${method}\``);
              }
              lines.push('');
            }
          }
        }

        if (mod.api.functions?.length > 0) {
          lines.push('### Functions');
          lines.push('');
          for (const func of mod.api.functions) {
            lines.push(`#### ${func.isAsync ? 'async ' : ''}\`${func.name}\``);
            lines.push('');
            lines.push(func.description);
            lines.push('');
            if (func.parameters?.length > 0) {
              lines.push('**Parameters**:');
              for (const param of func.parameters) {
                lines.push(`- \`${param}\``);
              }
              lines.push('');
            }
            if (func.returnType) {
              lines.push(`**Returns**: \`${func.returnType}\``);
              lines.push('');
            }
          }
        }
      }

      lines.push('---');
      lines.push('');
    }

    return lines.join('\n');
  }
}
