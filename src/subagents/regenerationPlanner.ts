import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { ValidationResult } from '../types/validation';

/**
 * 再生成プランナー
 *
 * Quality Gate の結果から、どのページ/セクション/モジュールを再生成するかを決定する。
 */
export class RegenerationPlannerSubagent extends BaseSubagent {
  id = 'regeneration-planner';
  name = 'Regeneration Planner';
  description = 'Plans regeneration tasks based on quality gate recommendations';

  async execute(context: SubagentContext): Promise<{
    shouldRegenerate: boolean;
    targets: string[];
    reason: string;
  }> {
    const { previousResults, progress } = context;

    progress('Planning regeneration based on quality results...');

    const quality = previousResults.get('quality-gate') as ValidationResult | undefined;
    const docQuality = previousResults.get('document-quality-reviewer') as {
      pageReviews?: Array<{ pageId: string; overallScore: number; issues: any[] }>;
    } | undefined;

    if (!quality && !docQuality) {
      return { shouldRegenerate: false, targets: [], reason: 'No quality results' };
    }

    const targets = new Set<string>();

    // pick low-score pages from document quality reviews
    if (docQuality?.pageReviews) {
      for (const review of docQuality.pageReviews) {
        if ((review.overallScore || 0) < 7 || (review.issues?.length || 0) > 0) {
          targets.add(review.pageId.replace('-revised', ''));
        }
      }
    }

    // fallback: use recommendations categories
    if (quality?.recommendations) {
      for (const rec of quality.recommendations) {
        if (rec.category === 'accuracy' || rec.category === 'completeness') {
          targets.add(rec.title);
        }
      }
    }

    const shouldRegenerate = !quality?.isValid || (quality?.overallScore ?? 1) < 0.85 || targets.size > 0;

    return {
      shouldRegenerate,
      targets: Array.from(targets),
      reason: shouldRegenerate ? 'Quality below threshold' : 'Quality acceptable',
    };
  }
}
