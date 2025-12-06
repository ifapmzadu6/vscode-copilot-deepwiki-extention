import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { ConsistencyValidation, Inconsistency } from '../types/validation';

/**
 * Checks consistency across documentation
 */
export class ConsistencyCheckerSubagent extends BaseSubagent {
  id = 'consistency-checker';
  name = 'Consistency Checker';
  description = 'Checks consistency across documentation';

  async execute(context: SubagentContext): Promise<ConsistencyValidation> {
    const { progress, token, previousResults } = context;

    progress('Checking consistency...');

    const inconsistencies: Inconsistency[] = [];

    // Check naming consistency
    const codeStructures = previousResults.get('code-parser') as Map<string, any> | undefined;
    
    if (codeStructures) {
      const namingPatterns = new Map<string, Set<string>>();

      for (const [filePath, structure] of codeStructures.entries()) {
        if (token.isCancellationRequested) {
          throw new vscode.CancellationError();
        }

        // Collect naming patterns
        if (structure.functions) {
          for (const func of structure.functions) {
            const pattern = this.detectNamingPattern(func.name);
            if (!namingPatterns.has(pattern)) {
              namingPatterns.set(pattern, new Set());
            }
            namingPatterns.get(pattern)!.add(func.name);
          }
        }
      }

      // Check for inconsistencies
      if (namingPatterns.size > 2) {
        inconsistencies.push({
          severity: 'warning',
          type: 'naming',
          locations: [],
          description: 'Multiple naming conventions detected',
          expectedPattern: 'camelCase',
          actualPattern: Array.from(namingPatterns.keys()).join(', '),
          autoFixable: false,
        });
      }
    }

    const score = inconsistencies.length === 0 ? 1.0 : Math.max(0, 1.0 - inconsistencies.length * 0.1);

    progress(`Consistency check: ${inconsistencies.length} inconsistencies found`);

    return {
      score,
      inconsistencies,
      standards: [
        {
          standard: 'Naming Convention',
          compliant: inconsistencies.filter(i => i.type === 'naming').length === 0,
          violations: inconsistencies.filter(i => i.type === 'naming').map(i => i.description),
          recommendations: ['Use consistent camelCase for functions and variables'],
        },
      ],
    };
  }

  private detectNamingPattern(name: string): string {
    if (/^[a-z][a-zA-Z0-9]*$/.test(name)) return 'camelCase';
    if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) return 'PascalCase';
    if (/^[a-z]+(_[a-z0-9]+)*$/.test(name)) return 'snake_case';
    if (/^[A-Z]+(_[A-Z0-9]+)*$/.test(name)) return 'SCREAMING_SNAKE_CASE';
    return 'mixed';
  }
}
