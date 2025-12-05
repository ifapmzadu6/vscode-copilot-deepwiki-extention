import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';

/**
 * Generates table of contents for documentation
 */
export class TOCGeneratorSubagent extends BaseSubagent {
  id = 'toc-generator';
  name = 'TOC Generator';
  description = 'Generates table of contents';

  async execute(context: SubagentContext): Promise<string> {
    const { progress, previousResults } = context;

    progress('Generating table of contents...');

    const formattedDoc = previousResults.get('markdown-formatter') as string | undefined;
    
    if (!formattedDoc) {
      return '';
    }

    const toc: string[] = [];
    toc.push('## Table of Contents');
    toc.push('');

    // Extract headings from markdown
    const lines = formattedDoc.split('\n');
    let currentLevel = 0;

    for (const line of lines) {
      const match = line.match(/^(#{1,6})\s+(.+)$/);
      if (match) {
        const level = match[1].length;
        const title = match[2];

        // Skip the main title
        if (level === 1) continue;

        // Generate anchor
        const anchor = title
          .toLowerCase()
          .replace(/[^\w\s-]/g, '')
          .replace(/\s+/g, '-');

        const indent = '  '.repeat(level - 2);
        toc.push(`${indent}- [${title}](#${anchor})`);
      }
    }

    progress('Table of contents generated');

    return toc.join('\n');
  }
}
