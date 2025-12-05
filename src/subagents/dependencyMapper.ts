import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { DependencyGraph, DependencyNode, CodeStructure, ScannedFile } from '../types/analysis';

/**
 * Maps dependencies between files and modules
 */
export class DependencyMapperSubagent extends BaseSubagent {
  id = 'dependency-mapper';
  name = 'Dependency Mapper';
  description = 'Creates dependency graph between files and modules';

  async execute(context: SubagentContext): Promise<DependencyGraph> {
    const { progress, token, previousResults } = context;

    progress('Mapping dependencies...');

    const codeStructures = previousResults.get('code-parser') as Map<string, CodeStructure> | undefined;
    const scannedFiles = previousResults.get('file-scanner') as ScannedFile[] | undefined;

    if (!codeStructures || !scannedFiles) {
      // Return empty graph if prerequisites not available
      return {
        nodes: new Map(),
        edges: [],
        cycles: [],
        layers: [],
      };
    }

    const nodes = new Map<string, DependencyNode>();
    const edges: Array<{ from: string; to: string }> = [];

    // Build dependency nodes
    for (const [filePath, structure] of codeStructures.entries()) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      const dependencies: string[] = [];
      
      // Extract dependencies from imports
      for (const imp of structure.imports) {
        if (!imp.isExternal) {
          dependencies.push(imp.source);
        }
      }

      const node: DependencyNode = {
        id: filePath,
        path: filePath,
        type: 'file',
        dependencies,
        dependents: [],
        isExternal: false,
        cyclic: false,
      };

      nodes.set(filePath, node);

      // Add edges
      for (const dep of dependencies) {
        edges.push({ from: filePath, to: dep });
      }
    }

    // Build dependents
    for (const edge of edges) {
      const targetNode = nodes.get(edge.to);
      if (targetNode) {
        targetNode.dependents.push(edge.from);
      }
    }

    // Detect cycles (simple detection)
    const cycles = this.detectCycles(nodes, edges);

    // Mark cyclic nodes
    for (const cycle of cycles) {
      for (const nodeId of cycle) {
        const node = nodes.get(nodeId);
        if (node) {
          node.cyclic = true;
        }
      }
    }

    progress(`Mapped ${nodes.size} dependencies with ${edges.length} edges`);

    return {
      nodes,
      edges,
      cycles,
      layers: [], // Layer analysis would be more complex
    };
  }

  private detectCycles(
    nodes: Map<string, DependencyNode>,
    edges: Array<{ from: string; to: string }>
  ): string[][] {
    // Simple cycle detection using DFS
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const dfs = (nodeId: string, path: string[]): void => {
      visited.add(nodeId);
      recursionStack.add(nodeId);
      path.push(nodeId);

      const node = nodes.get(nodeId);
      if (node) {
        for (const dep of node.dependencies) {
          if (!visited.has(dep)) {
            dfs(dep, [...path]);
          } else if (recursionStack.has(dep)) {
            // Found a cycle
            const cycleStart = path.indexOf(dep);
            if (cycleStart !== -1) {
              cycles.push(path.slice(cycleStart));
            }
          }
        }
      }

      recursionStack.delete(nodeId);
    };

    for (const nodeId of nodes.keys()) {
      if (!visited.has(nodeId)) {
        dfs(nodeId, []);
      }
    }

    return cycles;
  }
}
