import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';

/**
 * 再生成オーケストレーター
 * Quality Gate と Regeneration Planner の結果をもとに、再生成が必要かを判断し、
 * 後続サブエージェントにフラグを渡す（実際の再生成は FinalDocumentGenerator を再呼び出しする側で行う想定）。
 */
export class RegenerationOrchestratorSubagent extends BaseSubagent {
  id = 'regeneration-orchestrator';
  name = 'Regeneration Orchestrator';
  description = 'Determines whether regeneration is required based on quality results';

  async execute(context: SubagentContext): Promise<{
    shouldRegenerate: boolean;
    reason: string;
    targets: string[];
  }> {
    const { previousResults, progress } = context;

    progress('Evaluating regeneration necessity...');

    const quality = previousResults.get('quality-gate') as {
      isValid?: boolean;
      overallScore?: number;
      recommendations?: Array<{ category: string; title: string }>;
    } | undefined;

    const plan = previousResults.get('regeneration-planner') as {
      shouldRegenerate?: boolean;
      targets?: string[];
      reason?: string;
    } | undefined;

    const shouldRegenerate =
      plan?.shouldRegenerate ||
      (quality && quality.overallScore !== undefined && quality.overallScore < 0.85);

    const targets = plan?.targets || [];
    const reason = plan?.reason || (shouldRegenerate ? 'Quality below threshold' : 'Quality acceptable');

    return {
      shouldRegenerate: !!shouldRegenerate,
      reason,
      targets,
    };
  }
}
