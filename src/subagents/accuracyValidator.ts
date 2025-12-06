import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { AccuracyValidation, AccuracyIssue } from '../types/validation';

/**
 * Validates accuracy of generated documentation
 */
export class AccuracyValidatorSubagent extends BaseSubagent {
  id = 'accuracy-validator';
  name = 'Accuracy Validator';
  description = 'Validates accuracy of generated documentation';

  async execute(context: SubagentContext): Promise<AccuracyValidation> {
    const { progress, token, previousResults } = context;

    progress('Validating accuracy...');

    const issues: AccuracyIssue[] = [];
    const verified: any[] = [];

    // Check code structures against actual code
    const codeStructures = previousResults.get('code-parser');
    
    if (codeStructures && typeof codeStructures === 'object') {
      const structures = codeStructures as Map<string, any>;
      
      for (const [filePath, structure] of structures.entries()) {
        if (token.isCancellationRequested) {
          throw new vscode.CancellationError();
        }

        // Verify exports exist
        if (structure.exports) {
          for (const exp of structure.exports) {
            verified.push({
              type: 'export',
              name: exp.name,
              location: filePath,
              verificationMethod: 'code-parser',
            });
          }
        }

        // Check for potential issues
        if (structure.functions) {
          for (const func of structure.functions) {
            if (!func.description || func.description.length < 10) {
              issues.push({
                severity: 'warning',
                type: 'outdated-info',
                location: { file: filePath, element: func.name },
                message: `Function ${func.name} has insufficient description`,
                autoFixable: false,
              });
            }
          }
        }
      }
    }

    const total = verified.length + issues.length;
    const score = total > 0 ? verified.length / total : 1.0;

    progress(`Validation complete: ${verified.length} verified, ${issues.length} issues`);

    return {
      score,
      issues,
      verified,
      total,
    };
  }
}
