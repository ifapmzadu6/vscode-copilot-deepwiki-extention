import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { ExtractionSummary } from '../types/extraction';
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

    // Use extraction summary for counts
    const extraction = previousResults.get('code-extractor') as ExtractionSummary | undefined;
    const scanned = previousResults.get('file-scanner') as any[] | undefined;
    const totalFiles = scanned?.length || 0;

    const stats = extraction?.stats;
    const totalExports = stats?.totalExports || 0;
    const totalClasses = stats?.totalClasses || 0;
    const totalFunctions = stats?.totalFunctions || 0;

    // Placeholder: without downstream doc coverage, assume 0 documented yet
    const exportsCovered = 0;
    const classesCovered = 0;
    const functionsCovered = 0;
    const filesDocumented = 0;
    const examplesCoverage = 0;

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
    const classScore = coverage.totalClasses > 0 ? coverage.classesCovered / coverage.totalClasses : 0;
    const funcScore = coverage.totalFunctions > 0 ? coverage.functionsCovered / coverage.totalFunctions : 0;
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
