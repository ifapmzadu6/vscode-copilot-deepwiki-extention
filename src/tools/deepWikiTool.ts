import * as vscode from 'vscode';
import * as path from 'path';
import {
  IDeepWikiParameters,
  DeepWikiDocument,
  PipelineContext,
  DependencyAnalysis,
} from '../types';
import { ValidationResult } from '../types/validation';
import {
  DeepWikiSite,
  DeepWikiPage,
  NavigationItem,
  formatTable,
  formatSourceReference,
} from '../types/deepwiki';
import { PipelineOrchestrator } from '../pipeline/orchestrator';
import { logger } from '../utils/logger';

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
    const workspaceFolder = this.resolveWorkspaceFolder();
    const workspaceName = workspaceFolder?.name || 'current workspace';

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

    // Resolve target workspace (prefer active editor's folder)
    const workspaceFolder = this.resolveWorkspaceFolder();
    if (!workspaceFolder) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          'Error: No workspace folder is open. Please open a folder first.'
        ),
      ]);
    }

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
      // Clean output directory once per invocation to avoid mixing runs
      await this.cleanOutputDirectory(workspaceFolder, params.outputPath);

      // Always use the new multi-stage pipeline
      logger.log('DeepWiki', 'Using multi-stage pipeline');
      const results = await this.runPipelineOrchestrator(
        workspaceFolder,
        model,
        params,
        token
      );

      // Capture rich outputs from the 7-level pipeline
      const finalResult = results.get('final-document-generator');
      const finalSite = this.isDeepWikiSite(finalResult) ? finalResult : undefined;
      const finalDocument = this.isDeepWikiDocument(finalResult) ? finalResult : undefined;
      const formattedReadme = typeof results.get('markdown-formatter') === 'string'
        ? (results.get('markdown-formatter') as string)
        : undefined;
      const quality = results.get('quality-gate') as ValidationResult | undefined;

      // Build document from pipeline results or from generated DeepWiki site
      const document =
        finalDocument ||
        (finalSite ? this.buildDocumentFromSite(finalSite) : null) ||
        this.buildDocumentFromResults(results, workspaceFolder);

      if (!document) {
        throw new Error('Failed to generate DeepWiki document from pipeline');
      }

      // Write documentation to files
      const outputPath = await this.writeDocumentation(
        workspaceFolder,
        document,
        finalSite,
        params.outputPath,
        {
          readmeContent: formattedReadme,
          skipPages: !!finalSite, // keep LLM-generated pages intact if already written by subagent
          qualityResult: quality,
        }
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
   * Run the multi-stage pipeline orchestrator
   */
  private async runPipelineOrchestrator(
    workspaceFolder: vscode.WorkspaceFolder,
    model: vscode.LanguageModelChat,
    parameters: IDeepWikiParameters,
    token: vscode.CancellationToken
  ): Promise<Map<string, unknown>> {
    logger.log('DeepWiki', 'Using new multi-stage pipeline orchestrator');

    const pipelineContext: PipelineContext = {
      workspaceFolder,
      model,
      parameters,
      token,
    };

    const orchestrator = new PipelineOrchestrator();

    // Set progress callback
    orchestrator.setProgressCallback((message: string) => {
      logger.log('Pipeline', message);
    });

    // Execute the pipeline
    const results = await orchestrator.execute(pipelineContext);

    return results;
  }

  /**
   * Write the documentation to files
   */
  private async writeDocumentation(
    workspaceFolder: vscode.WorkspaceFolder,
    document: DeepWikiDocument,
    site: DeepWikiSite | undefined,
    outputPath?: string,
    options?: {
      readmeContent?: string;
      skipPages?: boolean;
      qualityResult?: ValidationResult;
    }
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

    // If we have a DeepWiki site, write it in DeepWiki.com format
    if (site && !options?.skipPages) {
      await this.writeDeepWikiSite(fullPath, site);
    }

    // Write main README
    const readmeContent = options?.readmeContent
      ? options.readmeContent
      : this.generateMarkdownReadme(document, site, options?.qualityResult);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(path.join(fullPath, 'README.md')),
      new TextEncoder().encode(readmeContent)
    );

    // Write raw JSON data
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(path.join(fullPath, 'deepwiki.json')),
      new TextEncoder().encode(JSON.stringify({ document, site }, null, 2))
    );

    return fullPath;
  }

  /**
   * Write DeepWiki.com-style site structure
   */
  private async writeDeepWikiSite(basePath: string, site: DeepWikiSite): Promise<void> {
    // Create pages directory
    const pagesDir = path.join(basePath, 'pages');
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(pagesDir));
    } catch {
      // Directory might already exist
    }

    // Write each page as a separate markdown file
    for (const page of site.pages) {
      const pageContent = this.renderPage(page, site);
      const fileName = `${page.slug}.md`;
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(path.join(pagesDir, fileName)),
        new TextEncoder().encode(pageContent)
      );
    }

    // Write navigation/sidebar file
    const sidebarContent = this.renderSidebar(site.navigation);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(path.join(basePath, '_sidebar.md')),
      new TextEncoder().encode(sidebarContent)
    );

    // Write site index
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(path.join(basePath, 'site.json')),
      new TextEncoder().encode(JSON.stringify(site, null, 2))
    );
  }

  /**
   * Render a single page to markdown
   */
  private renderPage(page: DeepWikiPage, site: DeepWikiSite): string {
    const lines: string[] = [];

    // Page title
    lines.push(`# ${page.title}`);
    lines.push('');

    // Relevant source files (if any)
    if (page.sources && page.sources.length > 0) {
      lines.push('**Relevant source files:**');
      lines.push('');
      for (const source of page.sources.slice(0, 5)) {
        lines.push(`- ${formatSourceReference(source)}`);
      }
      lines.push('');
    }

    // Render each section
    for (const section of page.sections) {
      lines.push(`## ${section.title}`);
      lines.push('');

      // Section content
      if (section.content) {
        lines.push(section.content);
        lines.push('');
      }

      // Diagrams
      if (section.diagrams && section.diagrams.length > 0) {
        for (const diagram of section.diagrams) {
          if (diagram) {
            lines.push('```mermaid');
            lines.push(diagram);
            lines.push('```');
            lines.push('');
          }
        }
      }

      // Tables
      if (section.tables && section.tables.length > 0) {
        for (const table of section.tables) {
          lines.push(formatTable(table));
          lines.push('');
        }
      }

      // Code examples
      if (section.codeExamples && section.codeExamples.length > 0) {
        for (const example of section.codeExamples) {
          if (example.title) {
            lines.push(`**${example.title}:**`);
            lines.push('');
          }
          lines.push(`\`\`\`${example.language}`);
          lines.push(example.code);
          lines.push('```');
          lines.push('');
        }
      }

      // Section sources
      if (section.sources && section.sources.length > 0) {
        lines.push('');
        lines.push('**Sources:**');
        for (const source of section.sources) {
          lines.push(`- ${formatSourceReference(source)}`);
        }
        lines.push('');
      }
    }

    // Related pages
    if (page.relatedPages && page.relatedPages.length > 0) {
      lines.push('---');
      lines.push('');
      lines.push('**See also:**');
      for (const relatedId of page.relatedPages) {
        const relatedPage = site.pages.find(p => p.id === relatedId);
        if (relatedPage) {
          lines.push(`- [${relatedPage.title}](${relatedPage.slug}.md)`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Render sidebar navigation
   */
  private renderSidebar(navigation: NavigationItem[]): string {
    const lines: string[] = [];
    lines.push('<!-- DeepWiki Navigation -->');
    lines.push('');

    for (const item of navigation) {
      lines.push(`- [${item.title}](pages/${item.path})`);
      
      if (item.children && item.children.length > 0) {
        for (const child of item.children) {
          lines.push(`  - [${child.title}](pages/${child.path})`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Generate the main README markdown
   */
  private generateMarkdownReadme(
    doc: DeepWikiDocument,
    site?: DeepWikiSite,
    quality?: ValidationResult
  ): string {
    const lines: string[] = [];

    lines.push(`# ${doc.title}`);
    lines.push('');
    lines.push(`> Generated by DeepWiki on ${new Date(doc.generatedAt).toLocaleDateString()}`);
    lines.push('');
    
    // Add navigation links if site is available
    if (site && site.navigation.length > 0) {
      lines.push('## 📚 Documentation');
      lines.push('');
      for (const nav of site.navigation) {
        lines.push(`- [${nav.title}](pages/${nav.path})`);
        if (nav.children && nav.children.length > 0) {
          for (const child of nav.children) {
            lines.push(`  - [${child.title}](pages/${child.path})`);
          }
        }
      }
      lines.push('');
    }

    lines.push('## Overview');
    lines.push('');
    lines.push(doc.overview);
    lines.push('');
    lines.push('## Quick Facts');
    lines.push('');
    lines.push(`| Property | Value |`);
    lines.push(`| --- | --- |`);
    lines.push(`| **Languages** | ${doc.dependencies.languages.join(', ') || 'Unknown'} |`);
    lines.push(`| **Frameworks** | ${doc.dependencies.frameworks.join(', ') || 'None'} |`);
    lines.push(`| **Package Manager** | ${doc.dependencies.packageManager || 'Unknown'} |`);
    lines.push(`| **Architecture Patterns** | ${doc.architecture.patterns.join(', ') || 'Unknown'} |`);
    lines.push('');
    if (quality) {
      lines.push('## Quality Summary');
      lines.push('');
      lines.push(`- Overall Score: ${(quality.overallScore * 100).toFixed(1)}% (${quality.isValid ? 'pass' : 'fail'})`);
      lines.push(`- Accuracy: ${(quality.accuracy.score * 100).toFixed(1)}%`);
      lines.push(`- Completeness: ${(quality.completeness.score * 100).toFixed(1)}%`);
      lines.push(`- Consistency: ${(quality.consistency.score * 100).toFixed(1)}%`);
      if (quality.recommendations?.length) {
        lines.push('- Top Recommendations:');
        for (const rec of quality.recommendations.slice(0, 3)) {
          lines.push(`  - (${rec.priority}) ${rec.title}: ${rec.action}`);
        }
      }
      lines.push('');
    }
    lines.push('## Architecture Overview');
    lines.push('');
    if (doc.diagrams?.architectureOverview) {
      lines.push('```mermaid');
      lines.push(doc.diagrams.architectureOverview);
      lines.push('```');
      lines.push('');
    }
    if (doc.architecture.patterns.length > 0) {
      lines.push(`**Patterns:** ${doc.architecture.patterns.join(', ')}`);
      lines.push('');
    }
    if (doc.diagrams?.moduleDependencies) {
      lines.push('### Module Dependencies');
      lines.push('');
      lines.push('```mermaid');
      lines.push(doc.diagrams.moduleDependencies);
      lines.push('```');
      lines.push('');
    }
    if (doc.architecture.modules.length > 0) {
      lines.push('### Key Modules');
      lines.push('');
      for (const mod of doc.architecture.modules.slice(0, 10)) {
        lines.push(`- **${mod.name}** (\`${mod.path}\`): ${mod.description}`);
      }
      lines.push('');
    }
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
    
    // Create a table for modules
    lines.push('| Module | Path | Description |');
    lines.push('| --- | --- | --- |');
    for (const mod of doc.modules.slice(0, 20)) {
      lines.push(`| **${mod.name}** | \`${mod.path}\` | ${mod.description.split('\n')[0]} |`);
    }
    lines.push('');
    lines.push('## API Highlights');
    lines.push('');
    if (doc.modules.length === 0) {
      lines.push('No API surface detected.');
      lines.push('');
    } else {
      for (const mod of doc.modules.slice(0, 8)) {
        lines.push(`### ${mod.name}`);
        lines.push('');
        lines.push(mod.description.split('\n')[0] || '');
        lines.push('');

        const exports = mod.api?.exports || [];
        if (exports.length > 0) {
          lines.push('| Export | Kind | Visibility |');
          lines.push('| --- | --- | --- |');
          for (const exp of exports.slice(0, 10)) {
            const visibility = exp.isPublic ? 'public' : 'internal';
            lines.push(`| \`${exp.name}\` | ${exp.type} | ${visibility} |`);
          }
          lines.push('');
        } else {
          lines.push('No exports detected.');
          lines.push('');
        }
      }
    }
    if (site) {
      lines.push('---');
      lines.push('');
      lines.push('*See the [pages/](./pages/) directory for detailed documentation.*');
    }

    return lines.join('\n');
  }

  /**
   * Build a DeepWikiDocument from pipeline results
   */
  private buildDocumentFromResults(
    results: Map<string, unknown>,
    workspaceFolder?: vscode.WorkspaceFolder
  ): DeepWikiDocument | null {
    try {
      const fileScanner = results.get('file-scanner') as
        | Array<{ relativePath: string; language?: string; size?: number }>
        | { files: Array<{ relativePath: string; language?: string; size?: number }> }
        | undefined;
      const frameworkDetector = results.get('framework-detector') as Array<{ name: string }> | undefined;
      const dependencyAnalysis = results.get('dependency-analyzer') as DependencyAnalysis | undefined;
      const languageDetection = results.get('language-detector') as
        | { all?: string[]; primary?: string | null }
        | undefined;
      const entryPointFinder = results.get('entry-point-finder') as string[] | { entryPoints?: string[] } | undefined;
      const configFinder = results.get('config-finder') as string[] | { configs?: string[] } | undefined;
      const moduleSummaries = results.get('module-summary-generator') as Array<{
        modulePath: string;
        summary: string;
      }> | undefined;

      const workspaceName = workspaceFolder?.name || vscode.workspace.workspaceFolders?.[0]?.name || 'Project';
      const workspaceUri = workspaceFolder?.uri || vscode.workspace.workspaceFolders?.[0]?.uri;

      // Build WorkspaceFile array from file scanner results
      const filesInput = Array.isArray(fileScanner)
        ? fileScanner
        : fileScanner?.files || [];

      const files = filesInput.map((f) => ({
        uri: workspaceUri ? vscode.Uri.joinPath(workspaceUri, f.relativePath) : vscode.Uri.file(f.relativePath),
        relativePath: f.relativePath,
        language: this.detectLanguage(f.relativePath),
        size: f.size ?? 0,
      }));

      return {
        title: `${workspaceName} Documentation`,
        generatedAt: new Date().toISOString(),
        overview: 'Documentation generated by DeepWiki 7-level pipeline.',
        dependencies: {
          languages: languageDetection?.all || dependencyAnalysis?.languages || [],
          frameworks: frameworkDetector ? frameworkDetector.map((f) => f.name) : dependencyAnalysis?.frameworks || [],
          packageManager: dependencyAnalysis?.packageManager || null,
          dependencies: dependencyAnalysis?.dependencies || {},
          devDependencies: dependencyAnalysis?.devDependencies || {},
        },
        architecture: {
          patterns: [],
          layers: [],
          modules: [],
          entryPoints: (entryPointFinder && Array.isArray(entryPointFinder)
            ? entryPointFinder
            : entryPointFinder && (entryPointFinder as { entryPoints?: string[] }).entryPoints) || [],
        },
        modules: (moduleSummaries || []).map((m) => ({
          name: m.modulePath.split('/').pop() || m.modulePath,
          path: m.modulePath,
          description: m.summary,
          usage: '',
          api: {
            path: m.modulePath,
            summary: m.summary,
            exports: [],
            imports: [],
            classes: [],
            functions: [],
          },
        })),
        diagrams: {
          architectureOverview: '',
          moduleDependencies: '',
          directoryStructure: '',
          layerDiagram: '',
        },
        structure: {
          rootPath: workspaceUri?.fsPath || '',
          files,
          directories: [],
          entryPoints: (entryPointFinder && Array.isArray(entryPointFinder)
            ? entryPointFinder
            : entryPointFinder && (entryPointFinder as { entryPoints?: string[] }).entryPoints) || [],
          configFiles: (configFinder && Array.isArray(configFinder)
            ? configFinder
            : configFinder && (configFinder as { configs?: string[] }).configs) || [],
        },
      };
    } catch {
      return null;
    }
  }

  /**
   * Build a DeepWikiDocument from a generated DeepWikiSite
   */
  private buildDocumentFromSite(site: DeepWikiSite): DeepWikiDocument {
    const overviewPage =
      site.pages.find((p) => p.slug === 'overview' || p.id.includes('overview')) ||
      site.pages[0];
    const overviewContent = overviewPage
      ? overviewPage.sections.map((s) => s.content || '').join('\n\n')
      : 'Documentation generated by DeepWiki pipeline.';

    return {
      title: site.projectName || 'Project Documentation',
      generatedAt: site.generatedAt,
      overview: overviewContent,
      dependencies: {
        languages: [],
        frameworks: [],
        packageManager: null,
        dependencies: {},
        devDependencies: {},
      },
      architecture: {
        patterns: [],
        layers: [],
        modules: [],
        entryPoints: [],
      },
      modules: [],
      diagrams: {
        architectureOverview: '',
        moduleDependencies: '',
        directoryStructure: '',
        layerDiagram: '',
      },
      structure: {
        rootPath: '',
        files: [],
        directories: [],
        entryPoints: [],
        configFiles: [],
      },
    };
  }

  private isDeepWikiSite(value: unknown): value is DeepWikiSite {
    return Boolean(
      value &&
      typeof value === 'object' &&
      'pages' in (value as Record<string, unknown>) &&
      'navigation' in (value as Record<string, unknown>)
    );
  }

  private isDeepWikiDocument(value: unknown): value is DeepWikiDocument {
    return Boolean(
      value &&
      typeof value === 'object' &&
      'modules' in (value as Record<string, unknown>) &&
      'dependencies' in (value as Record<string, unknown>)
    );
  }

  /**
   * Prefer the workspace folder of the active editor; fall back to the first workspace.
   */
  private resolveWorkspaceFolder(): vscode.WorkspaceFolder | null {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri) {
      const folder = vscode.workspace.getWorkspaceFolder(activeUri);
      if (folder) {
        return folder;
      }
    }
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0] : null;
  }

  /**
   * Remove the existing DeepWiki output directory before a fresh run.
   * Safeguards prevent deleting workspace root.
   */
  private async cleanOutputDirectory(
    workspaceFolder: vscode.WorkspaceFolder,
    outputPath?: string
  ): Promise<void> {
    const dirName = outputPath?.trim() || '.deepwiki';
    if (dirName === '' || dirName === '.' || dirName === '/' || dirName === '\\') {
      logger.warn('DeepWiki', 'Skipping cleanup: unsafe output path');
      return;
    }

    // Normalize and ensure target stays inside workspace
    const targetPath = path.normalize(path.join(workspaceFolder.uri.fsPath, dirName));
    if (!targetPath.startsWith(path.normalize(workspaceFolder.uri.fsPath + path.sep))) {
      logger.warn('DeepWiki', `Skipping cleanup: outputPath escapes workspace (${dirName})`);
      return;
    }

    const targetUri = vscode.Uri.file(targetPath);
    logger.log('DeepWiki', `Preparing cleanup for output directory: ${targetUri.fsPath}`);
    try {
      await vscode.workspace.fs.delete(targetUri, { recursive: true });
      logger.log('DeepWiki', `Cleaned output directory: ${targetUri.fsPath}`);
    } catch (error) {
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : String(error);
      if (code === 'FileNotFound' || /ENOENT/.test(message)) {
        logger.log('DeepWiki', `No existing output directory to clean at: ${targetUri.fsPath}`);
        return; // nothing to delete
      }
      logger.warn('DeepWiki', `Output cleanup skipped: ${message}`);
    }
  }

  /**
   * Detect language from file extension
   */
  private detectLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const languageMap: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescriptreact',
      '.js': 'javascript',
      '.jsx': 'javascriptreact',
      '.py': 'python',
      '.java': 'java',
      '.go': 'go',
      '.rs': 'rust',
      '.rb': 'ruby',
      '.php': 'php',
      '.cs': 'csharp',
      '.cpp': 'cpp',
      '.c': 'c',
      '.md': 'markdown',
      '.json': 'json',
      '.yaml': 'yaml',
      '.yml': 'yaml',
    };
    return languageMap[ext] || 'plaintext';
  }
}
