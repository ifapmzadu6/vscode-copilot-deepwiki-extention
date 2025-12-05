import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import {
  SubagentContext,
  DiagramCollection,
  ArchitectureAnalysis,
  DependencyAnalysis,
  WorkspaceStructure,
  ModuleInfo,
} from '../types';

/**
 * Subagent that generates Mermaid diagrams for architecture visualization
 */
export class DiagramGeneratorSubagent extends BaseSubagent {
  id = 'diagram-generator';
  name = 'Diagram Generator';
  description = 'Generates Mermaid diagrams for architecture visualization';

  async execute(context: SubagentContext): Promise<DiagramCollection> {
    const { model, progress, token, previousResults } = context;

    progress('Generating architecture diagrams...');

    const structure = previousResults.get('structure-analyzer') as WorkspaceStructure;
    const dependencies = previousResults.get('dependency-analyzer') as DependencyAnalysis;
    const architecture = previousResults.get('architecture-analyzer') as ArchitectureAnalysis;

    const diagrams: DiagramCollection = {
      architectureOverview: '',
      moduleDependencies: '',
      directoryStructure: '',
      layerDiagram: '',
    };

    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    // Generate architecture overview diagram
    progress('Generating architecture overview diagram...');
    diagrams.architectureOverview = await this.generateArchitectureOverview(
      model,
      architecture,
      dependencies,
      token
    );

    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    // Generate module dependencies diagram
    progress('Generating module dependencies diagram...');
    diagrams.moduleDependencies = this.generateModuleDependenciesDiagram(
      architecture?.modules || []
    );

    // Generate directory structure diagram
    progress('Generating directory structure diagram...');
    diagrams.directoryStructure = this.generateDirectoryStructureDiagram(
      structure?.directories || []
    );

    // Generate layer diagram
    progress('Generating layer diagram...');
    diagrams.layerDiagram = this.generateLayerDiagram(architecture?.layers || []);

    progress('Diagram generation complete');

    return diagrams;
  }

  /**
   * Generate an architecture overview diagram using LLM
   */
  private async generateArchitectureOverview(
    model: vscode.LanguageModelChat,
    architecture: ArchitectureAnalysis | undefined,
    dependencies: DependencyAnalysis | undefined,
    token: vscode.CancellationToken
  ): Promise<string> {
    const modules = architecture?.modules || [];
    const patterns = architecture?.patterns || [];
    const layers = architecture?.layers || [];
    const frameworks = dependencies?.frameworks || [];

    const prompt = `Generate a Mermaid flowchart diagram showing the high-level architecture of this project.

Project Information:
- Architectural Patterns: ${patterns.join(', ') || 'Unknown'}
- Layers: ${layers.join(', ') || 'Unknown'}
- Frameworks: ${frameworks.join(', ') || 'Unknown'}
- Modules: ${modules.map((m) => `${m.name} (${m.type})`).join(', ') || 'Unknown'}

Requirements:
1. Use Mermaid flowchart syntax (flowchart TD or flowchart LR)
2. Show the main components/layers and their relationships
3. Use appropriate shapes: [(database)], ([service]), [[component]], etc.
4. Add meaningful labels to connections
5. Group related components using subgraph when appropriate
6. Keep it readable - max 15-20 nodes

Respond with ONLY the Mermaid code, no explanation. Start with \`\`\`mermaid and end with \`\`\``;

    try {
      const response = await this.queryModel(
        model,
        'You are a software architect who creates clear, accurate Mermaid diagrams. Generate only valid Mermaid syntax.',
        prompt,
        token
      );

      return this.extractMermaidCode(response);
    } catch {
      // Fallback to a basic diagram
      return this.generateBasicArchitectureDiagram(modules, layers);
    }
  }

  /**
   * Generate module dependencies diagram
   */
  private generateModuleDependenciesDiagram(modules: ModuleInfo[]): string {
    if (modules.length === 0) {
      return '';
    }

    const lines: string[] = ['flowchart LR'];
    const nodeIds = new Map<string, string>();

    // Create node IDs
    modules.forEach((mod, index) => {
      const nodeId = `M${index}`;
      nodeIds.set(mod.path, nodeId);
    });

    // Add nodes with appropriate shapes based on type
    modules.forEach((mod, index) => {
      const nodeId = `M${index}`;
      const shape = this.getShapeForType(mod.type);
      const label = mod.name.length > 20 ? mod.name.substring(0, 17) + '...' : mod.name;
      lines.push(`    ${nodeId}${shape.open}"${label}"${shape.close}`);
    });

    // Add connections based on imports
    modules.forEach((mod) => {
      const sourceId = nodeIds.get(mod.path);
      if (sourceId && mod.imports) {
        for (const imp of mod.imports) {
          // Find if this import corresponds to another module
          const targetMod = modules.find(
            (m) => imp.includes(m.name) || imp.includes(m.path)
          );
          if (targetMod) {
            const targetId = nodeIds.get(targetMod.path);
            if (targetId && sourceId !== targetId) {
              lines.push(`    ${sourceId} --> ${targetId}`);
            }
          }
        }
      }
    });

    // Add styling
    lines.push('');
    lines.push('    classDef service fill:#e1f5fe,stroke:#01579b');
    lines.push('    classDef component fill:#f3e5f5,stroke:#4a148c');
    lines.push('    classDef utility fill:#fff3e0,stroke:#e65100');
    lines.push('    classDef config fill:#e8f5e9,stroke:#1b5e20');
    lines.push('    classDef test fill:#fce4ec,stroke:#880e4f');

    // Apply styles
    modules.forEach((mod, index) => {
      const nodeId = `M${index}`;
      if (mod.type === 'service') {
        lines.push(`    class ${nodeId} service`);
      } else if (mod.type === 'component') {
        lines.push(`    class ${nodeId} component`);
      } else if (mod.type === 'utility') {
        lines.push(`    class ${nodeId} utility`);
      } else if (mod.type === 'config') {
        lines.push(`    class ${nodeId} config`);
      } else if (mod.type === 'test') {
        lines.push(`    class ${nodeId} test`);
      }
    });

    return lines.join('\n');
  }

  /**
   * Generate directory structure diagram
   */
  private generateDirectoryStructureDiagram(directories: string[]): string {
    if (directories.length === 0) {
      return '';
    }

    const lines: string[] = ['flowchart TD'];
    const topLevelDirs = directories
      .filter((d) => !d.includes('/') || d.split('/').length <= 2)
      .slice(0, 15); // Limit for readability

    // Create root node
    lines.push('    ROOT[("Project Root")]');

    // Group directories by first level
    const grouped = new Map<string, string[]>();
    for (const dir of topLevelDirs) {
      const parts = dir.split('/');
      const firstLevel = parts[0];
      if (!grouped.has(firstLevel)) {
        grouped.set(firstLevel, []);
      }
      if (parts.length > 1) {
        grouped.get(firstLevel)?.push(parts.slice(1).join('/'));
      }
    }

    // Add first-level directories
    let nodeIndex = 0;
    grouped.forEach((subDirs, dirName) => {
      const nodeId = `D${nodeIndex++}`;
      const icon = this.getDirectoryIcon(dirName);
      lines.push(`    ${nodeId}["${icon} ${dirName}"]`);
      lines.push(`    ROOT --> ${nodeId}`);

      // Add subdirectories
      subDirs.slice(0, 5).forEach((subDir) => {
        const subNodeId = `D${nodeIndex++}`;
        const subIcon = this.getDirectoryIcon(subDir);
        lines.push(`    ${subNodeId}["${subIcon} ${subDir}"]`);
        lines.push(`    ${nodeId} --> ${subNodeId}`);
      });
    });

    return lines.join('\n');
  }

  /**
   * Generate layer diagram
   */
  private generateLayerDiagram(layers: string[]): string {
    if (layers.length === 0) {
      return '';
    }

    const lines: string[] = ['flowchart TB'];

    // Order layers from top to bottom (presentation -> data)
    const orderedLayers = this.orderLayers(layers);

    orderedLayers.forEach((layer, index) => {
      const nodeId = `L${index}`;
      const color = this.getLayerColor(layer);
      lines.push(`    ${nodeId}["${layer}"]`);
      lines.push(`    style ${nodeId} fill:${color},stroke:#333,stroke-width:2px`);

      if (index > 0) {
        lines.push(`    L${index - 1} --> ${nodeId}`);
      }
    });

    return lines.join('\n');
  }

  /**
   * Extract Mermaid code from LLM response
   */
  private extractMermaidCode(response: string): string {
    // Try to extract code block
    const mermaidMatch = response.match(/```mermaid\s*([\s\S]*?)```/);
    if (mermaidMatch) {
      return mermaidMatch[1].trim();
    }

    // Try to extract any code block
    const codeMatch = response.match(/```\s*([\s\S]*?)```/);
    if (codeMatch) {
      return codeMatch[1].trim();
    }

    // Return as-is if it looks like Mermaid code
    if (response.includes('flowchart') || response.includes('graph')) {
      return response.trim();
    }

    return '';
  }

  /**
   * Generate a basic architecture diagram as fallback
   */
  private generateBasicArchitectureDiagram(
    modules: ModuleInfo[],
    layers: string[]
  ): string {
    const lines: string[] = ['flowchart TD'];

    if (layers.length > 0) {
      layers.forEach((layer, index) => {
        lines.push(`    L${index}["${layer}"]`);
        if (index > 0) {
          lines.push(`    L${index - 1} --> L${index}`);
        }
      });
    } else if (modules.length > 0) {
      const limitedModules = modules.slice(0, 10);
      limitedModules.forEach((mod, index) => {
        lines.push(`    M${index}["${mod.name}"]`);
      });
    } else {
      lines.push('    A["Application"]');
    }

    return lines.join('\n');
  }

  /**
   * Get Mermaid shape for module type
   */
  private getShapeForType(type: ModuleInfo['type']): { open: string; close: string } {
    switch (type) {
      case 'service':
        return { open: '([', close: '])' }; // Stadium shape
      case 'component':
        return { open: '[[', close: ']]' }; // Subroutine shape
      case 'utility':
        return { open: '{{', close: '}}' }; // Hexagon
      case 'config':
        return { open: '[(', close: ')]' }; // Cylinder
      case 'test':
        return { open: '(', close: ')' }; // Rounded
      default:
        return { open: '[', close: ']' }; // Rectangle
    }
  }

  /**
   * Get icon for directory type
   */
  private getDirectoryIcon(dirName: string): string {
    const lower = dirName.toLowerCase();
    if (lower.includes('src') || lower.includes('source')) return '📁';
    if (lower.includes('test') || lower.includes('spec')) return '🧪';
    if (lower.includes('config')) return '⚙️';
    if (lower.includes('doc')) return '📚';
    if (lower.includes('asset') || lower.includes('static')) return '🖼️';
    if (lower.includes('component')) return '🧩';
    if (lower.includes('service')) return '⚡';
    if (lower.includes('util') || lower.includes('helper')) return '🔧';
    if (lower.includes('api')) return '🔌';
    if (lower.includes('model') || lower.includes('entity')) return '📊';
    return '📂';
  }

  /**
   * Order layers from top (presentation) to bottom (data)
   */
  private orderLayers(layers: string[]): string[] {
    const order = [
      'Presentation',
      'UI',
      'View',
      'Application',
      'Service',
      'Business',
      'Domain',
      'Core',
      'Data',
      'Infrastructure',
      'Persistence',
      'API',
      'Utility',
      'Configuration',
      'Test',
    ];

    return layers.sort((a, b) => {
      const aIndex = order.findIndex((o) => a.toLowerCase().includes(o.toLowerCase()));
      const bIndex = order.findIndex((o) => b.toLowerCase().includes(o.toLowerCase()));
      return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
    });
  }

  /**
   * Get color for layer type
   */
  private getLayerColor(layer: string): string {
    const lower = layer.toLowerCase();
    if (lower.includes('presentation') || lower.includes('ui') || lower.includes('view'))
      return '#e3f2fd';
    if (lower.includes('application') || lower.includes('service')) return '#f3e5f5';
    if (lower.includes('domain') || lower.includes('core') || lower.includes('business'))
      return '#fff3e0';
    if (lower.includes('data') || lower.includes('infrastructure') || lower.includes('persistence'))
      return '#e8f5e9';
    if (lower.includes('api')) return '#fce4ec';
    if (lower.includes('utility') || lower.includes('configuration')) return '#eceff1';
    if (lower.includes('test')) return '#f5f5f5';
    return '#fafafa';
  }
}
