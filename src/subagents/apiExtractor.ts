import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { PublicAPI, CodeStructure } from '../types/analysis';

/**
 * Extracts public API information
 */
export class APIExtractorSubagent extends BaseSubagent {
  id = 'api-extractor';
  name = 'API Extractor';
  description = 'Extracts public API information';

  async execute(context: SubagentContext): Promise<PublicAPI[]> {
    const { progress, token, previousResults } = context;

    progress('Extracting public APIs...');

    const codeStructures = previousResults.get('code-parser') as Map<string, CodeStructure> | undefined;
    
    if (!codeStructures) {
      return [];
    }

    const apis: PublicAPI[] = [];

    for (const [filePath, structure] of codeStructures.entries()) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      const exports = structure.exports.filter(e => e.isPublic).map(exp => ({
        name: exp.name,
        kind: exp.type as any,
        signature: exp.name,
        description: `Exported ${exp.type}`,
        examples: [],
        relatedAPIs: [],
      }));

      if (exports.length > 0) {
        apis.push({
          module: filePath,
          exports,
          examples: [],
        });
      }
    }

    progress(`Extracted ${apis.length} public APIs`);

    return apis;
  }
}
