import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { FunctionAnalysis, CodeStructure } from '../types/analysis';

/**
 * Analyzes functions in detail
 */
export class FunctionAnalyzerSubagent extends BaseSubagent {
  id = 'function-analyzer';
  name = 'Function Analyzer';
  description = 'Analyzes functions in detail';

  async execute(context: SubagentContext): Promise<FunctionAnalysis[]> {
    const { progress, token, previousResults } = context;

    progress('Analyzing functions...');

    const codeStructures = previousResults.get('code-parser') as Map<string, CodeStructure> | undefined;
    
    if (!codeStructures) {
      return [];
    }

    const analyses: FunctionAnalysis[] = [];

    // Analyze exported functions
    for (const [_, structure] of codeStructures.entries()) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      for (const func of structure.functions) {
        if (func.isExported) {
          analyses.push({
            function: func,
            complexity: {
              cyclomatic: func.complexity || 1,
              cognitive: func.complexity || 1,
              lines: 10,
              parameters: func.parameters?.length || 0,
              returns: 1,
              nesting: 1,
            },
            dependencies: [],
            usages: [],
            documentation: func.description,
            examples: [],
          });
        }
      }
    }

    progress(`Analyzed ${analyses.length} functions`);

    return analyses;
  }
}
