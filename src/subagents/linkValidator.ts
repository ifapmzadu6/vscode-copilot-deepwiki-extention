import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { DeepWikiSite } from '../types/deepwiki';
import { ValidationRecommendation } from '../types/validation';

/**
 * Link/related-page検証サブエージェント
 *
 * FinalDocumentGenerator が生成したサイト構造を検証し、
 * 存在しない関連ページ参照を検出する。
 */
export class LinkValidatorSubagent extends BaseSubagent {
  id = 'link-validator';
  name = 'Link Validator';
  description = 'Validates page links and related page references';

  async execute(context: SubagentContext): Promise<{
    brokenLinks: Array<{ from: string; to: string }>;
    recommendations: ValidationRecommendation[];
  }> {
    const { previousResults, progress } = context;
    progress('Validating links...');

    const site = previousResults.get('final-document-generator') as DeepWikiSite | undefined;
    if (!site || !site.pages) {
      return { brokenLinks: [], recommendations: [] };
    }

    const pageIds = new Set(site.pages.map((p) => p.id));
    const broken: Array<{ from: string; to: string }> = [];

    for (const page of site.pages) {
      if (!page.relatedPages) continue;
      for (const rel of page.relatedPages) {
        if (!pageIds.has(rel)) {
          broken.push({ from: page.id, to: rel });
        }
      }
    }

    const recommendations: ValidationRecommendation[] = [];
    if (broken.length > 0) {
      recommendations.push({
        priority: 'medium',
        category: 'quality',
        title: 'Fix broken related page links',
        description: `${broken.length} broken related page references detected`,
        action: 'Update relatedPages to existing page ids or remove invalid references',
        impact: 'Improves navigation integrity',
        effort: 'low',
        autoApplicable: false,
      });
    }

    return { brokenLinks: broken, recommendations };
  }
}
