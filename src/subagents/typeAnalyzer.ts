import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { TypeAnalysis, CodeStructure } from '../types/analysis';

/**
 * Analyzes type information
 */
export class TypeAnalyzerSubagent extends BaseSubagent {
  id = 'type-analyzer';
  name = 'Type Analyzer';
  description = 'Analyzes type information in the codebase';

  async execute(context: SubagentContext): Promise<TypeAnalysis[]> {
    const { progress, token, previousResults } = context;

    progress('Analyzing types...');

    const codeStructures = previousResults.get('code-parser') as Map<string, CodeStructure> | undefined;
    
    if (!codeStructures) {
      return [];
    }

    const analyses: TypeAnalysis[] = [];

    for (const [filePath, structure] of codeStructures.entries()) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      if (structure.types.length > 0 || structure.interfaces.length > 0) {
        analyses.push({
          file: filePath,
          types: structure.types.map(t => ({
            name: t.name,
            kind: 'object' as any,
            definition: t.definition || t.name,
            description: t.description,
            usages: 0,
          })),
          interfaces: structure.interfaces.map(i => ({
            name: i.name,
            extends: i.extends || [],
            properties: i.properties || [],
            methods: i.methods || [],
            description: i.description,
            usages: 0,
          })),
          generics: [],
        });
      }
    }

    progress(`Analyzed types in ${analyses.length} files`);

    return analyses;
  }
}
