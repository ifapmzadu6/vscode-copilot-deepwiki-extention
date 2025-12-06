import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext, DeepWikiDocument, ValidationResult } from '../types';

/**
 * Formats documentation into well-structured Markdown
 */
export class MarkdownFormatterSubagent extends BaseSubagent {
  id = 'markdown-formatter';
  name = 'Markdown Formatter';
  description = 'Formats documentation into Markdown';

  async execute(context: SubagentContext): Promise<string> {
    const { progress, previousResults } = context;

    progress('Formatting documentation...');

    // Prefer final-document-generator output; fall back to overview-generator
    // Prefer regenerated site if available
    const regenerated = previousResults.get('page-regenerator') as DeepWikiDocument | undefined;
    const overview =
      regenerated ||
      (previousResults.get('final-document-generator') as DeepWikiDocument | undefined) ||
      (previousResults.get('overview-generator') as DeepWikiDocument | undefined);

    const quality = previousResults.get('quality-gate') as ValidationResult | undefined;
    
    if (!overview) {
      return '# Documentation\n\nNo content available.';
    }

    const sections: string[] = [];

    sections.push(`# ${overview.title}`);
    sections.push('');
    sections.push(`> Generated on ${new Date(overview.generatedAt).toLocaleDateString()}`);
    sections.push('');

    if (overview.overview) {
      sections.push('## Overview');
      sections.push('');
      sections.push(overview.overview);
      sections.push('');
    }

    if (overview.architecture) {
      sections.push('## Architecture');
      sections.push('');
      sections.push(`**Patterns**: ${overview.architecture.patterns.join(', ')}`);
      sections.push('');
      sections.push(`**Layers**: ${overview.architecture.layers.join(', ')}`);
      sections.push('');
    }

    if (overview.dependencies) {
      sections.push('## Dependencies');
      sections.push('');
      sections.push(`**Package Manager**: ${overview.dependencies.packageManager || 'Unknown'}`);
      sections.push('');
      sections.push(`**Languages**: ${overview.dependencies.languages.join(', ')}`);
      sections.push('');
      sections.push(`**Frameworks**: ${overview.dependencies.frameworks.join(', ')}`);
      sections.push('');
    }

    if (overview.modules && overview.modules.length > 0) {
      sections.push('## Modules');
      sections.push('');

      for (const module of overview.modules.slice(0, 20)) {
        sections.push(`### ${module.name}`);
        sections.push('');
        sections.push(`**Path**: \`${module.path}\``);
        sections.push('');
        sections.push(module.description);
        sections.push('');
      }
    }

    if (quality) {
      sections.push('## Quality Summary');
      sections.push('');
      sections.push(`- Overall Score: ${(quality.overallScore * 100).toFixed(1)}%`);
      sections.push(`- Accuracy: ${(quality.accuracy.score * 100).toFixed(1)}%`);
      sections.push(`- Completeness: ${(quality.completeness.score * 100).toFixed(1)}%`);
      sections.push(`- Consistency: ${(quality.consistency.score * 100).toFixed(1)}%`);
      sections.push('');
      if (quality.recommendations.length > 0) {
        sections.push('### Recommendations');
        for (const rec of quality.recommendations.slice(0, 5)) {
          sections.push(`- (${rec.priority}) ${rec.title}: ${rec.action}`);
        }
        sections.push('');
      }
    }

    progress('Formatting complete');

    return sections.join('\n');
  }
}
