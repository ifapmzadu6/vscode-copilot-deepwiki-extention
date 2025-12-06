import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import {
  AccuracyValidation,
  CompletenessValidation,
  ConsistencyValidation,
  ValidationResult,
  ValidationRecommendation,
} from '../types/validation';

/**
 * 全品質メトリクスを集約し、ゲート判定を行うサブエージェント
 *
 * Level 6: QUALITY_REVIEW
 */
export class QualityGateSubagent extends BaseSubagent {
  id = 'quality-gate';
  name = 'Quality Gate';
  description = 'Aggregates validation results and computes overall quality score with recommendations';

  async execute(context: SubagentContext): Promise<ValidationResult> {
    const { previousResults, progress } = context;

    progress('Aggregating quality metrics...');

    const accuracy = (previousResults.get('accuracy-validator') as AccuracyValidation) || {
      score: 0,
      issues: [],
      verified: [],
      total: 0,
    };
    const completeness = (previousResults.get('completeness-checker') as CompletenessValidation) || {
      score: 0,
      coverage: {
        filesDocumented: 0,
        totalFiles: 0,
        exportsCovered: 0,
        totalExports: 0,
        classesCovered: 0,
        totalClasses: 0,
        functionsCovered: 0,
        totalFunctions: 0,
        examplesCoverage: 0,
      },
      missing: [],
      suggestions: [],
    };
    const consistency = (previousResults.get('consistency-checker') as ConsistencyValidation) || {
      score: 0,
      inconsistencies: [],
      standards: [],
    };
    const linkCheck = previousResults.get('link-validator') as
      | { brokenLinks?: Array<{ from: string; to: string }>; recommendations?: ValidationRecommendation[] }
      | undefined;
    const layerCheck = previousResults.get('layer-violation-checker') as
      | { violations?: Array<{ from: string; to: string }>; recommendations?: ValidationRecommendation[] }
      | undefined;

    const overallScore = this.weightedScore(accuracy.score, completeness.score, consistency.score);
    const recommendations = this.buildRecommendations(
      accuracy,
      completeness,
      consistency,
      overallScore,
      linkCheck?.recommendations || [],
      layerCheck?.recommendations || []
    );

    return {
      isValid: overallScore >= 0.8,
      accuracy,
      completeness,
      consistency,
      overallScore,
      recommendations,
    };
  }

  private weightedScore(acc: number, comp: number, cons: number): number {
    // Accuracy 45%, Completeness 35%, Consistency 20%
    return acc * 0.45 + comp * 0.35 + cons * 0.2;
  }

  private buildRecommendations(
    accuracy: AccuracyValidation,
    completeness: CompletenessValidation,
    consistency: ConsistencyValidation,
    overall: number,
    linkRecs: ValidationRecommendation[],
    layerRecs: ValidationRecommendation[]
  ): ValidationRecommendation[] {
    const recs: ValidationRecommendation[] = [];

    if (accuracy.score < 0.9) {
      recs.push({
        priority: accuracy.score < 0.7 ? 'high' : 'medium',
        category: 'accuracy',
        title: 'Fix inaccurate or weakly described items',
        description: 'Resolve issues flagged by accuracy-validator and enrich short descriptions.',
        action: 'Regenerate sections with invalid references or missing descriptions',
        impact: 'Improves trustworthiness of docs',
        effort: 'medium',
        autoApplicable: false,
      });
    }

    if (completeness.score < 0.85) {
      recs.push({
        priority: completeness.score < 0.6 ? 'high' : 'medium',
        category: 'completeness',
        title: 'Cover missing APIs and examples',
        description: 'Fill missing documentation for exports/classes/functions and add examples where absent.',
        action: 'Trigger regeneration for missing items list',
        impact: 'Improves coverage of public surface',
        effort: 'medium',
        autoApplicable: false,
      });
    }

    if (consistency.score < 0.9) {
      recs.push({
        priority: 'medium',
        category: 'consistency',
        title: 'Fix style/terminology inconsistencies',
        description: 'Apply consistency-checker findings (naming, formatting, cross-reference).',
        action: 'Normalize terminology and fix broken cross-references',
        impact: 'Improves readability and navigation',
        effort: 'low',
        autoApplicable: false,
      });
    }

    recs.push(...linkRecs);
    recs.push(...layerRecs);

    if (overall < 0.8) {
      recs.push({
        priority: 'critical',
        category: 'quality',
        title: 'Quality gate failed',
        description: 'Overall score below threshold; regenerate problematic pages and rerun validation.',
        action: 'Identify low-score pages and rerun LLM generation with stricter prompts',
        impact: 'Blocks release of incomplete docs',
        effort: 'medium',
        autoApplicable: false,
      });
    }

    return recs;
  }
}
