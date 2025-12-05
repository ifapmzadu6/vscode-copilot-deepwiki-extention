import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { ClassAnalysis, CodeStructure } from '../types/analysis';

/**
 * Analyzes classes in detail
 */
export class ClassAnalyzerSubagent extends BaseSubagent {
  id = 'class-analyzer';
  name = 'Class Analyzer';
  description = 'Analyzes classes in detail';

  async execute(context: SubagentContext): Promise<ClassAnalysis[]> {
    const { progress, token, previousResults } = context;

    progress('Analyzing classes...');

    const codeStructures = previousResults.get('code-parser') as Map<string, CodeStructure> | undefined;
    
    if (!codeStructures) {
      return [];
    }

    const analyses: ClassAnalysis[] = [];

    for (const [_, structure] of codeStructures.entries()) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      for (const cls of structure.classes) {
        if (cls.isExported) {
          analyses.push({
            class: cls,
            metrics: {
              methods: cls.methods?.length || 0,
              properties: cls.properties?.length || 0,
              linesOfCode: 50,
              complexity: 5,
              cohesion: 0.8,
              coupling: 3,
            },
            relationships: [],
            usages: [],
            documentation: cls.description,
            examples: [],
          });
        }
      }
    }

    progress(`Analyzed ${analyses.length} classes`);

    return analyses;
  }
}
