import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { ExtractionSummary } from '../types/extraction';
import { InheritanceTree, InheritanceNode, InheritanceEdge } from '../types/relationships';
import {
  getIntermediateFileManager,
  IntermediateFileManager,
  IntermediateFileType,
  logger,
} from '../utils';

/**
 * 継承ツリービルダーサブエージェント
 *
 * Level 4: RELATIONSHIP
 *
 * 抽出結果からクラス/インターフェースの継承関係を構築:
 * - extends関係
 * - implements関係
 * - ルートクラスの特定
 * - 継承の深さ計算
 *
 * 出力:
 * - .deepwiki/intermediate/relationships/inheritance.json
 */
export class InheritanceTreeBuilderSubagent extends BaseSubagent {
  id = 'inheritance-tree-builder';
  name = 'Inheritance Tree Builder';
  description = 'Builds inheritance hierarchy between classes and interfaces';

  private fileManager!: IntermediateFileManager;

  async execute(context: SubagentContext): Promise<{
    nodesCount: number;
    edgesCount: number;
    maxDepth: number;
    savedToFile: IntermediateFileType;
  }> {
    const { progress, token, previousResults } = context;

    progress('Building inheritance tree...');

    this.fileManager = getIntermediateFileManager();

    // Load extraction results from file (Level 2)
    let extractionResult: ExtractionSummary | undefined;
    try {
      extractionResult = (await this.fileManager.loadJson<ExtractionSummary>(
        IntermediateFileType.EXTRACTION_SUMMARY
      )) || undefined;
    } catch (error) {
      logger.error('InheritanceTreeBuilder', 'Failed to load extraction summary', error);
      return {
        nodesCount: 0,
        edgesCount: 0,
        maxDepth: 0,
        savedToFile: IntermediateFileType.RELATIONSHIP_INHERITANCE,
      };
    }

    if (!extractionResult) {
      progress('No extraction results found');
      return {
        nodesCount: 0,
        edgesCount: 0,
        maxDepth: 0,
        savedToFile: IntermediateFileType.RELATIONSHIP_INHERITANCE,
      };
    }

    const nodes: InheritanceNode[] = [];
    const edges: InheritanceEdge[] = [];
    const nodeMap = new Map<string, InheritanceNode>();

    // Create nodes for all classes
    for (const cls of extractionResult.classes) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      const node: InheritanceNode = {
        id: `class:${cls.name}`,
        name: cls.name,
        file: cls.file,
        sourceRef: cls.sourceRef,
        type: cls.isAbstract ? 'abstract-class' : 'class',
        isExternal: false,
      };

      nodes.push(node);
      nodeMap.set(cls.name, node);
    }

    // Create nodes for all interfaces
    for (const iface of extractionResult.interfaces) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      const node: InheritanceNode = {
        id: `interface:${iface.name}`,
        name: iface.name,
        file: iface.file,
        sourceRef: iface.sourceRef,
        type: 'interface',
        isExternal: false,
      };

      nodes.push(node);
      nodeMap.set(iface.name, node);
    }

    // Build extends edges for classes
    for (const cls of extractionResult.classes) {
      if (cls.extends) {
        const parentNode = nodeMap.get(cls.extends);
        const childNode = nodeMap.get(cls.name);

        if (childNode) {
          // If parent exists in our codebase
          if (parentNode) {
            edges.push({
              from: childNode.id,
              to: parentNode.id,
              type: 'extends',
              sourceRef: cls.sourceRef,
            });
          } else {
            // Parent is external, create a placeholder node
            const externalNode: InheritanceNode = {
              id: `external:${cls.extends}`,
              name: cls.extends,
              file: '',
              sourceRef: { file: '', startLine: 0 },
              type: 'class',
              isExternal: true,
            };

            if (!nodeMap.has(cls.extends)) {
              nodes.push(externalNode);
              nodeMap.set(cls.extends, externalNode);
            }

            edges.push({
              from: childNode.id,
              to: `external:${cls.extends}`,
              type: 'extends',
              sourceRef: cls.sourceRef,
            });
          }
        }
      }

      // Build implements edges
      for (const impl of cls.implements) {
        const childNode = nodeMap.get(cls.name);
        const ifaceNode = nodeMap.get(impl);

        if (childNode) {
          if (ifaceNode) {
            edges.push({
              from: childNode.id,
              to: ifaceNode.id,
              type: 'implements',
              sourceRef: cls.sourceRef,
            });
          } else {
            // Interface is external
            const externalNode: InheritanceNode = {
              id: `external:${impl}`,
              name: impl,
              file: '',
              sourceRef: { file: '', startLine: 0 },
              type: 'interface',
              isExternal: true,
            };

            if (!nodeMap.has(impl)) {
              nodes.push(externalNode);
              nodeMap.set(impl, externalNode);
            }

            edges.push({
              from: childNode.id,
              to: `external:${impl}`,
              type: 'implements',
              sourceRef: cls.sourceRef,
            });
          }
        }
      }
    }

    // Build extends edges for interfaces
    for (const iface of extractionResult.interfaces) {
      for (const ext of iface.extends) {
        const childNode = nodeMap.get(iface.name);
        const parentNode = nodeMap.get(ext);

        if (childNode) {
          if (parentNode) {
            edges.push({
              from: childNode.id,
              to: parentNode.id,
              type: 'extends',
              sourceRef: iface.sourceRef,
            });
          } else {
            // Parent interface is external
            const externalNode: InheritanceNode = {
              id: `external:${ext}`,
              name: ext,
              file: '',
              sourceRef: { file: '', startLine: 0 },
              type: 'interface',
              isExternal: true,
            };

            if (!nodeMap.has(ext)) {
              nodes.push(externalNode);
              nodeMap.set(ext, externalNode);
            }

            edges.push({
              from: childNode.id,
              to: `external:${ext}`,
              type: 'extends',
              sourceRef: iface.sourceRef,
            });
          }
        }
      }
    }

    // Find roots (nodes with no parent)
    const childIds = new Set(edges.map((e) => e.from));
    const roots = nodes
      .filter((n) => !childIds.has(n.id) || !edges.some((e) => e.from === n.id))
      .filter((n) => !n.isExternal)
      .map((n) => n.id);

    // Calculate max depth
    const depth = this.calculateMaxDepth(nodes, edges);

    const tree: InheritanceTree = {
      nodes,
      edges,
      roots,
      depth,
    };

    // Save to intermediate file
    await this.fileManager.saveJson(IntermediateFileType.RELATIONSHIP_INHERITANCE, tree);

    progress(`Built inheritance tree: ${nodes.length} nodes, ${edges.length} edges, max depth ${depth}`);

    return {
      nodesCount: nodes.length,
      edgesCount: edges.length,
      maxDepth: depth,
      savedToFile: IntermediateFileType.RELATIONSHIP_INHERITANCE,
    };
  }

  /**
   * 空のツリーを作成
   */
  private createEmptyTree(): InheritanceTree {
    return {
      nodes: [],
      edges: [],
      roots: [],
      depth: 0,
    };
  }

  /**
   * 最大の継承深さを計算
   */
  private calculateMaxDepth(nodes: InheritanceNode[], edges: InheritanceEdge[]): number {
    // Build adjacency list (child -> parent)
    const parentMap = new Map<string, string[]>();
    for (const edge of edges) {
      if (!parentMap.has(edge.from)) {
        parentMap.set(edge.from, []);
      }
      parentMap.get(edge.from)!.push(edge.to);
    }

    const depthCache = new Map<string, number>();

    const getDepth = (nodeId: string, visited: Set<string>): number => {
      if (visited.has(nodeId)) {
        return 0; // Cycle detected
      }

      if (depthCache.has(nodeId)) {
        return depthCache.get(nodeId)!;
      }

      const parents = parentMap.get(nodeId) || [];
      if (parents.length === 0) {
        depthCache.set(nodeId, 0);
        return 0;
      }

      visited.add(nodeId);
      let maxParentDepth = 0;
      for (const parent of parents) {
        const parentDepth = getDepth(parent, visited);
        maxParentDepth = Math.max(maxParentDepth, parentDepth);
      }
      visited.delete(nodeId);

      const depth = maxParentDepth + 1;
      depthCache.set(nodeId, depth);
      return depth;
    };

    let maxDepth = 0;
    for (const node of nodes) {
      const depth = getDepth(node.id, new Set());
      maxDepth = Math.max(maxDepth, depth);
    }

    return maxDepth;
  }
}
