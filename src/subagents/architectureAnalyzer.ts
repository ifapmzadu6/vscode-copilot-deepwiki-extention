import * as vscode from 'vscode';
import * as path from 'path';
import { BaseSubagent } from './baseSubagent';
import {
  SubagentContext,
  ArchitectureAnalysis,
  ModuleInfo,
  WorkspaceStructure,
  DependencyAnalysis,
} from '../types';

/**
 * Subagent that analyzes project architecture
 */
export class ArchitectureAnalyzerSubagent extends BaseSubagent {
  id = 'architecture-analyzer';
  name = 'Architecture Analyzer';
  description = 'Analyzes the overall project architecture and patterns';

  async execute(context: SubagentContext): Promise<ArchitectureAnalysis> {
    const { workspaceFolder, model, progress, token, previousResults, parameters } =
      context;

    progress('Analyzing architecture...');

    const structure = previousResults.get('structure-analyzer') as WorkspaceStructure;
    const dependencies = previousResults.get('dependency-analyzer') as DependencyAnalysis;

    const modules: ModuleInfo[] = [];
    const patterns: string[] = [];
    const layers: string[] = [];

    // Analyze directory structure to identify architectural patterns
    const directories = structure?.directories || [];
    const files = structure?.files || [];

    // Detect common architectural patterns from directory structure
    patterns.push(...this.detectPatternsFromStructure(directories));
    layers.push(...this.detectLayers(directories));

    // Group files into modules
    const moduleGroups = this.groupFilesIntoModules(files, directories, parameters.maxDepth || 5);

    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    progress('Analyzing modules with AI...');

    // Use LLM to analyze architecture
    const sampleFiles = files.slice(0, 50).map((f) => f.relativePath);
    const analysisPrompt = `Analyze this project structure and identify architectural patterns:

Directory Structure:
${directories.slice(0, 100).join('\n')}

Sample Files:
${sampleFiles.join('\n')}

Detected Frameworks: ${dependencies?.frameworks?.join(', ') || 'Unknown'}
Languages: ${dependencies?.languages?.join(', ') || 'Unknown'}

Respond with a JSON object:
{
  "patterns": ["pattern1", "pattern2"],
  "layers": ["layer1", "layer2"],
  "modules": [
    {
      "name": "module name",
      "path": "path/to/module",
      "type": "module|component|service|utility|config|test|other",
      "description": "brief description"
    }
  ]
}`;

    try {
      const response = await this.queryModel(
        model,
        'You are a software architect. Analyze project structures and identify patterns. Respond only with valid JSON.',
        analysisPrompt,
        token
      );

      const analysis = this.parseJsonResponse<{
        patterns?: string[];
        layers?: string[];
        modules?: Array<{
          name: string;
          path: string;
          type: string;
          description: string;
        }>;
      }>(response);

      if (analysis.patterns) {
        patterns.push(
          ...analysis.patterns.filter((p) => !patterns.includes(p))
        );
      }
      if (analysis.layers) {
        layers.push(...analysis.layers.filter((l) => !layers.includes(l)));
      }
      if (analysis.modules) {
        for (const mod of analysis.modules) {
          modules.push({
            name: mod.name,
            path: mod.path,
            type: (mod.type as ModuleInfo['type']) || 'module',
            description: mod.description,
            exports: [],
            imports: [],
          });
        }
      }
    } catch {
      // Fall back to automatic module detection
      for (const [modulePath, moduleFiles] of Object.entries(moduleGroups)) {
        const moduleName = path.basename(modulePath) || 'root';
        modules.push({
          name: moduleName,
          path: modulePath,
          type: this.inferModuleType(modulePath, moduleFiles as string[]),
          description: `Module containing ${(moduleFiles as string[]).length} files`,
          exports: [],
          imports: [],
        });
      }
    }

    progress('Architecture analysis complete');

    return {
      patterns: [...new Set(patterns)],
      modules,
      entryPoints: structure?.entryPoints || [],
      layers: [...new Set(layers)],
    };
  }

  private detectPatternsFromStructure(directories: string[]): string[] {
    const patterns: string[] = [];
    const dirSet = new Set(directories.map((d) => d.toLowerCase()));

    // MVC pattern
    if (
      (dirSet.has('models') || dirSet.has('model')) &&
      (dirSet.has('views') || dirSet.has('view')) &&
      (dirSet.has('controllers') || dirSet.has('controller'))
    ) {
      patterns.push('MVC (Model-View-Controller)');
    }

    // Component-based architecture
    if (dirSet.has('components') || dirSet.has('src/components')) {
      patterns.push('Component-Based Architecture');
    }

    // Feature-based/Module-based
    if (dirSet.has('features') || dirSet.has('modules')) {
      patterns.push('Feature-Based/Modular Architecture');
    }

    // Clean Architecture / Hexagonal
    if (
      (dirSet.has('domain') || dirSet.has('core')) &&
      (dirSet.has('infrastructure') || dirSet.has('adapters'))
    ) {
      patterns.push('Clean/Hexagonal Architecture');
    }

    // Layered Architecture
    if (
      dirSet.has('services') &&
      (dirSet.has('repositories') || dirSet.has('data'))
    ) {
      patterns.push('Layered Architecture');
    }

    // Microservices indicators
    if (
      directories.some(
        (d) =>
          d.includes('services/') &&
          directories.filter((dir) => dir.startsWith('services/')).length > 3
      )
    ) {
      patterns.push('Microservices');
    }

    // API-first
    if (dirSet.has('api') || dirSet.has('routes') || dirSet.has('endpoints')) {
      patterns.push('API-First Design');
    }

    // Event-driven
    if (
      dirSet.has('events') ||
      dirSet.has('handlers') ||
      dirSet.has('listeners')
    ) {
      patterns.push('Event-Driven Architecture');
    }

    return patterns;
  }

  private detectLayers(directories: string[]): string[] {
    const layers: string[] = [];
    const dirSet = new Set(directories.map((d) => d.toLowerCase()));

    const layerPatterns: Record<string, string[]> = {
      'Presentation Layer': ['ui', 'views', 'pages', 'components', 'screens'],
      'Application Layer': ['app', 'application', 'usecases', 'use-cases'],
      'Domain Layer': ['domain', 'core', 'entities', 'models'],
      'Infrastructure Layer': ['infrastructure', 'infra', 'adapters', 'external'],
      'Data Layer': ['data', 'repositories', 'database', 'persistence'],
      'API Layer': ['api', 'routes', 'endpoints', 'controllers'],
      'Service Layer': ['services', 'business'],
      'Utility Layer': ['utils', 'utilities', 'helpers', 'lib', 'common'],
      'Test Layer': ['tests', 'test', '__tests__', 'spec'],
      'Configuration Layer': ['config', 'configuration', 'settings'],
    };

    for (const [layer, patterns] of Object.entries(layerPatterns)) {
      if (patterns.some((p) => dirSet.has(p) || dirSet.has(`src/${p}`))) {
        layers.push(layer);
      }
    }

    return layers;
  }

  private groupFilesIntoModules(
    files: { relativePath: string }[],
    directories: string[],
    maxDepth: number
  ): Record<string, string[]> {
    const modules: Record<string, string[]> = {};

    for (const file of files) {
      const parts = file.relativePath.split(path.sep);
      const depth = Math.min(parts.length - 1, maxDepth);

      let modulePath = '';
      if (depth > 0) {
        modulePath = parts.slice(0, depth).join(path.sep);
      }

      if (!modules[modulePath]) {
        modules[modulePath] = [];
      }
      modules[modulePath].push(file.relativePath);
    }

    return modules;
  }

  private inferModuleType(
    modulePath: string,
    files: string[]
  ): ModuleInfo['type'] {
    const lowerPath = modulePath.toLowerCase();

    if (
      lowerPath.includes('test') ||
      lowerPath.includes('spec') ||
      lowerPath.includes('__tests__')
    ) {
      return 'test';
    }
    if (
      lowerPath.includes('component') ||
      lowerPath.includes('ui') ||
      lowerPath.includes('view')
    ) {
      return 'component';
    }
    if (lowerPath.includes('service') || lowerPath.includes('api')) {
      return 'service';
    }
    if (
      lowerPath.includes('util') ||
      lowerPath.includes('helper') ||
      lowerPath.includes('lib')
    ) {
      return 'utility';
    }
    if (lowerPath.includes('config') || lowerPath.includes('setting')) {
      return 'config';
    }

    return 'module';
  }
}
