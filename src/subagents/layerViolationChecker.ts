import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { DependencyGraph, ModuleBoundaries } from '../types/relationships';
import { ValidationRecommendation } from '../types/validation';

/**
 * 簡易レイヤ違反検出サブエージェント
 *
 * Heuristic: モジュール名の辞書順をレイヤ順とみなし、上位レイヤ（小さい順）から下位レイヤ（大きい順）への依存のみ許容。
 * 逆方向の依存をレイヤ違反として報告する。
 */
export class LayerViolationCheckerSubagent extends BaseSubagent {
  id = 'layer-violation-checker';
  name = 'Layer Violation Checker';
  description = 'Detects simple layer violations between modules (heuristic)';

  async execute(context: SubagentContext): Promise<{
    violations: Array<{ from: string; to: string }>;
    recommendations: ValidationRecommendation[];
  }> {
    const { previousResults, progress } = context;
    progress('Checking layer violations...');

    const depGraph = previousResults.get('dependency-mapper') as DependencyGraph | undefined;
    const moduleBoundaries = previousResults.get('module-boundary-builder') as ModuleBoundaries | undefined;

    if (!depGraph || !moduleBoundaries) {
      return { violations: [], recommendations: [] };
    }

    const order = moduleBoundaries.modules.map((m) => m.name).sort();
    const index = new Map(order.map((m, i) => [m, i]));

    const violations: Array<{ from: string; to: string }> = [];
    for (const edge of depGraph.edges) {
      const fromMod = this.topModule(edge.from);
      const toMod = this.topModule(edge.to);
      if (fromMod === toMod) continue;
      const fromIdx = index.get(fromMod);
      const toIdx = index.get(toMod);
      if (fromIdx !== undefined && toIdx !== undefined && fromIdx > toIdx) {
        violations.push({ from: fromMod, to: toMod });
      }
    }

    const recommendations: ValidationRecommendation[] = [];
    if (violations.length > 0) {
      recommendations.push({
        priority: 'medium',
        category: 'quality',
        title: 'Layer violations detected',
        description: `${violations.length} module dependencies violate inferred layering`,
        action: 'Refactor to remove upward dependencies or adjust layering rules',
        impact: 'Improves architectural adherence',
        effort: 'medium',
        autoApplicable: false,
      });
    }

    return { violations, recommendations };
  }

  private topModule(p: string): string {
    const parts = p.split('/');
    const idx = parts.indexOf('src');
    if (idx >= 0 && parts.length > idx + 1) return parts[idx + 1];
    return parts[0] || p;
  }
}
