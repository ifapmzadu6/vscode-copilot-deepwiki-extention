import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';

/**
 * Builds index of all documented items
 */
export class IndexBuilderSubagent extends BaseSubagent {
  id = 'index-builder';
  name = 'Index Builder';
  description = 'Builds searchable index';

  async execute(context: SubagentContext): Promise<Map<string, string[]>> {
    const { progress, previousResults } = context;

    progress('Building index...');

    const index = new Map<string, string[]>();

    // Index all code structures
    const codeStructures = previousResults.get('code-parser') as Map<string, any> | undefined;
    
    if (codeStructures) {
      for (const [filePath, structure] of codeStructures.entries()) {
        const items: string[] = [];

        if (structure.classes) {
          items.push(...structure.classes.map((c: any) => `class:${c.name}`));
        }

        if (structure.functions) {
          items.push(...structure.functions.map((f: any) => `function:${f.name}`));
        }

        if (structure.interfaces) {
          items.push(...structure.interfaces.map((i: any) => `interface:${i.name}`));
        }

        if (structure.types) {
          items.push(...structure.types.map((t: any) => `type:${t.name}`));
        }

        if (items.length > 0) {
          index.set(filePath, items);
        }
      }
    }

    progress(`Indexed ${index.size} files`);

    return index;
  }
}
