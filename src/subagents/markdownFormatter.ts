import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext, DeepWikiSite } from '../types';
import {
  getIntermediateFileManager,
  IntermediateFileType,
  logger,
} from '../utils';

/**
 * Formats documentation into well-structured Markdown
 */
export class MarkdownFormatterSubagent extends BaseSubagent {
  id = 'markdown-formatter';
  name = 'Markdown Formatter';
  description = 'Formats documentation into Markdown';

  async execute(context: SubagentContext): Promise<{
    formattedContentLength: number;
    savedToFile: IntermediateFileType;
  }> {
    const { progress } = context;

    progress('Formatting final markdown...');

    const fileManager = getIntermediateFileManager();

    // Try to load DeepWikiSite (new format)
    const site = (await fileManager.loadJson<DeepWikiSite>(IntermediateFileType.OUTPUT_SITE_CONFIG));

    if (site) {
      // Format DeepWikiSite to single markdown
      const markdown = this.formatSite(site);
      await fileManager.saveFinalPage('deepwiki.md', markdown);

      return {
        formattedContentLength: markdown.length,
        savedToFile: IntermediateFileType.OUTPUT_PAGE,
      };
    }

    progress('No documentation found to format');
    return {
      formattedContentLength: 0,
      savedToFile: IntermediateFileType.OUTPUT_PAGE,
    };
  }

  private formatSite(site: DeepWikiSite): string {
    let md = `# ${site.projectName}\n\n`;
    if (site.projectDescription) {
      md += `${site.projectDescription}\n\n`;
    }

    // Table of Contents
    md += `## Table of Contents\n\n`;
    for (const page of site.pages) {
      if (!page.parent) {
        md += `- [${page.title}](#${page.slug})\n`;
        // Find children
        const children = site.pages.filter(p => p.parent === page.id);
        for (const child of children) {
          md += `  - [${child.title}](#${child.slug})\n`;
        }
      }
    }
    md += `\n---\n\n`;

    // Pages sorted by order
    const sortedPages = [...site.pages].sort((a, b) => a.order - b.order);

    for (const page of sortedPages) {
      md += `<a id="${page.slug}"></a>\n`;
      md += `# ${page.title}\n\n`;

      for (const section of page.sections) {
        md += `<a id="${section.id}"></a>\n`;
        md += `## ${section.title}\n\n`;
        md += `${section.content}\n\n`;

        if (section.diagrams) {
          for (const diagram of section.diagrams) {
            md += '```mermaid\n' + diagram + '\n```\n\n';
          }
        }
      }
      md += `\n---\n\n`;
    }

    return md;
  }
}
