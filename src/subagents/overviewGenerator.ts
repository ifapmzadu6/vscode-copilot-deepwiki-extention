import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import {
  SubagentContext,
  DeepWikiDocument,
  WorkspaceStructure,
  DependencyAnalysis,
  ArchitectureAnalysis,
  ModuleDocumentation,
  DiagramCollection,
} from '../types';
import * as path from 'path';

/**
 * Subagent that generates the final DeepWiki overview document
 */
export class OverviewGeneratorSubagent extends BaseSubagent {
  id = 'overview-generator';
  name = 'Overview Generator';
  description = 'Generates the final DeepWiki overview and compiles all documentation';

  async execute(context: SubagentContext): Promise<DeepWikiDocument> {
    const { workspaceFolder, model, progress, token, previousResults } = context;

    progress('Generating project overview...');

    const structure = previousResults.get('structure-analyzer') as WorkspaceStructure;
    const dependencies = previousResults.get('dependency-analyzer') as DependencyAnalysis;
    const architecture = previousResults.get('architecture-analyzer') as ArchitectureAnalysis;
    const modules = previousResults.get('module-documenter') as ModuleDocumentation[];
    const diagrams = previousResults.get('diagram-generator') as DiagramCollection;

    // Generate project title from workspace folder name
    const projectName = path.basename(workspaceFolder.uri.fsPath);
    const title = this.formatTitle(projectName);

    // Generate overview using LLM
    const overviewPrompt = `Generate a comprehensive project overview for documentation:

Project: ${title}
Languages: ${dependencies?.languages?.join(', ') || 'Unknown'}
Frameworks: ${dependencies?.frameworks?.join(', ') || 'None detected'}
Architecture Patterns: ${architecture?.patterns?.join(', ') || 'Unknown'}
Layers: ${architecture?.layers?.join(', ') || 'Unknown'}
Total Files: ${structure?.files?.length || 0}
Total Directories: ${structure?.directories?.length || 0}
Entry Points: ${structure?.entryPoints?.join(', ') || 'None detected'}

Modules (${modules?.length || 0}):
${modules?.map((m) => `- ${m.name}: ${m.description}`).join('\n') || 'None'}

Key Dependencies:
${this.formatDependencies(dependencies?.dependencies || {})}

Generate a comprehensive overview (2-4 paragraphs) that:
1. Describes what this project does
2. Explains the technology stack
3. Describes the architecture
4. Highlights key features or modules

Respond with just the overview text, no JSON.`;

    let overview = '';
    try {
      overview = await this.queryModel(
        model,
        'You are a technical writer creating project documentation. Write clear, professional overviews.',
        overviewPrompt,
        token
      );
    } catch {
      // Generate a basic overview
      overview = this.generateBasicOverview(
        title,
        dependencies,
        architecture,
        structure,
        modules
      );
    }

    progress('Compiling final documentation...');

    const deepWikiDocument: DeepWikiDocument = {
      title,
      overview,
      structure: structure || {
        rootPath: workspaceFolder.uri.fsPath,
        files: [],
        directories: [],
        entryPoints: [],
        configFiles: [],
      },
      dependencies: dependencies || {
        packageManager: null,
        dependencies: {},
        devDependencies: {},
        frameworks: [],
        languages: [],
      },
      architecture: architecture || {
        patterns: [],
        modules: [],
        entryPoints: [],
        layers: [],
      },
      modules: modules || [],
      diagrams: diagrams || {
        architectureOverview: '',
        moduleDependencies: '',
        directoryStructure: '',
        layerDiagram: '',
      },
      generatedAt: new Date().toISOString(),
    };

    progress('DeepWiki generation complete!');

    return deepWikiDocument;
  }

  private formatTitle(name: string): string {
    // Convert kebab-case or snake_case to Title Case
    return name
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  private formatDependencies(deps: Record<string, string>): string {
    const entries = Object.entries(deps);
    if (entries.length === 0) return 'None';

    return entries
      .slice(0, 15)
      .map(([name, version]) => `- ${name}: ${version}`)
      .join('\n');
  }

  private generateBasicOverview(
    title: string,
    dependencies: DependencyAnalysis | null,
    architecture: ArchitectureAnalysis | null,
    structure: WorkspaceStructure | null,
    modules: ModuleDocumentation[] | null
  ): string {
    const parts: string[] = [];

    parts.push(`# ${title}\n`);

    if (dependencies?.languages?.length) {
      parts.push(
        `This project is built using ${dependencies.languages.join(', ')}.`
      );
    }

    if (dependencies?.frameworks?.length) {
      parts.push(`It utilizes ${dependencies.frameworks.join(', ')} framework(s).`);
    }

    if (architecture?.patterns?.length) {
      parts.push(
        `The codebase follows ${architecture.patterns.join(', ')} architectural pattern(s).`
      );
    }

    if (structure?.files?.length) {
      parts.push(
        `The project contains ${structure.files.length} files across ${structure.directories.length} directories.`
      );
    }

    if (modules?.length) {
      parts.push(`\nKey modules include:`);
      for (const mod of modules.slice(0, 5)) {
        parts.push(`- **${mod.name}**: ${mod.description}`);
      }
    }

    return parts.join(' ');
  }
}
