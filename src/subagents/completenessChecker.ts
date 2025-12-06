import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { CompletenessValidation, MissingItem, CoverageMetrics } from '../types/validation';

/**
 * Checks completeness of documentation
 */
export class CompletenessCheckerSubagent extends BaseSubagent {
  id = 'completeness-checker';
  name = 'Completeness Checker';
  description = 'Checks completeness of documentation coverage';

  async execute(context: SubagentContext): Promise<CompletenessValidation> {
    const { progress, token, previousResults } = context;

    progress('Checking completeness...');

    const missing: MissingItem[] = [];

    // Count documented vs total items
    const scannedFiles = previousResults.get('file-scanner') as any[] | undefined;
    const codeStructures = previousResults.get('code-parser') as Map<string, any> | undefined;
    const examples = previousResults.get('example-generator') as Map<string, any> | undefined;

    const filesDocumented = codeStructures?.size || 0;
    const totalFiles = scannedFiles?.length || 0;

    let exportsCovered = 0;
    let totalExports = 0;
    let classesCovered = 0;
    let totalClasses = 0;
    let functionsCovered = 0;
    let totalFunctions = 0;

    if (codeStructures) {
      for (const [filePath, structure] of codeStructures.entries()) {
        if (token.isCancellationRequested) {
          throw new vscode.CancellationError();
        }

        totalExports += structure.exports?.length || 0;
        exportsCovered += structure.exports?.filter((e: any) => e.isPublic)?.length || 0;

        totalClasses += structure.classes?.length || 0;
        classesCovered += structure.classes?.filter((c: any) => c.description)?.length || 0;

        totalFunctions += structure.functions?.length || 0;
        functionsCovered += structure.functions?.filter((f: any) => f.description)?.length || 0;

        // Find missing documentation
        if (structure.exports) {
          for (const exp of structure.exports) {
            if (!exp.description || exp.description.length < 5) {
              missing.push({
                type: 'function',
                name: exp.name,
                location: filePath,
                priority: 'medium',
                reason: 'Missing or insufficient description',
              });
            }
          }
        }
      }
    }

    const examplesCoverage = examples ? examples.size / Math.max(filesDocumented, 1) : 0;

    const coverage: CoverageMetrics = {
      filesDocumented,
      totalFiles,
      exportsCovered,
      totalExports,
      classesCovered,
      totalClasses,
      functionsCovered,
      totalFunctions,
      examplesCoverage,
    };

    const score = this.calculateCompletenessScore(coverage);

    progress(`Completeness: ${(score * 100).toFixed(1)}% coverage`);

    return {
      score,
      coverage,
      missing,
      suggestions: this.generateSuggestions(missing),
    };
  }

  private calculateCompletenessScore(coverage: CoverageMetrics): number {
    const weights = {
      files: 0.2,
      exports: 0.3,
      classes: 0.2,
      functions: 0.2,
      examples: 0.1,
    };

    const fileScore = coverage.totalFiles > 0 ? coverage.filesDocumented / coverage.totalFiles : 0;
    const exportScore = coverage.totalExports > 0 ? coverage.exportsCovered / coverage.totalExports : 0;
    const classScore = coverage.totalClasses > 0 ? coverage.classesCovered / coverage.totalClasses : 1;
    const funcScore = coverage.totalFunctions > 0 ? coverage.functionsCovered / coverage.totalFunctions : 1;
    const exampleScore = coverage.examplesCoverage;

    return (
      fileScore * weights.files +
      exportScore * weights.exports +
      classScore * weights.classes +
      funcScore * weights.functions +
      exampleScore * weights.examples
    );
  }

  private generateSuggestions(missing: MissingItem[]): string[] {
    const suggestions: string[] = [];

    if (missing.length > 0) {
      suggestions.push(`Document ${missing.length} missing items`);
    }

    const highPriority = missing.filter(m => m.priority === 'high').length;
    if (highPriority > 0) {
      suggestions.push(`Focus on ${highPriority} high-priority items first`);
    }

    return suggestions;
  }
}
