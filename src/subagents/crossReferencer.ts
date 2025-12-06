import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';

/**
 * Creates cross-references between documentation elements
 */
export class CrossReferencerSubagent extends BaseSubagent {
  id = 'cross-referencer';
  name = 'Cross Referencer';
  description = 'Creates cross-references between documentation elements';

  async execute(context: SubagentContext): Promise<Map<string, string[]>> {
    const { progress, token, previousResults } = context;

    progress('Creating cross-references...');

    const references = new Map<string, string[]>();

    // Build cross-references based on dependencies and usage
    const dependencyGraph = previousResults.get('dependency-mapper');
    
    if (dependencyGraph && typeof dependencyGraph === 'object' && 'nodes' in dependencyGraph) {
      const graph = dependencyGraph as any;
      for (const [nodeId, node] of graph.nodes.entries()) {
        if (token.isCancellationRequested) {
          throw new vscode.CancellationError();
        }

        const refs: string[] = [];
        
        if (node.dependencies) {
          refs.push(...node.dependencies);
        }
        
        if (node.dependents) {
          refs.push(...node.dependents);
        }

        if (refs.length > 0) {
          references.set(nodeId, [...new Set(refs)]);
        }
      }
    }

    progress(`Created ${references.size} cross-references`);

    return references;
  }
}
