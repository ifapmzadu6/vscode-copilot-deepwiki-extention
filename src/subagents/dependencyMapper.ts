import * as vscode from 'vscode';
import * as path from 'path';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { ExtractionSummary, ExtractedImport, createSourceRef } from '../types/extraction';
import { DependencyGraph, DependencyGraphNode, DependencyGraphEdge } from '../types/relationships';
import { getIntermediateFileManager, IntermediateFileType, logger } from '../utils';

/**
 * 依存関係マッパーサブエージェント
 *
 * Level 4: RELATIONSHIP
 *
 * 抽出結果からファイル間の依存関係グラフを構築:
 * - インポート/エクスポート関係
 * - 外部依存関係
 * - 循環依存の検出
 *
 * 出力:
 * - .deepwiki/intermediate/relationships/dependency-graph.json
 */
export class DependencyMapperSubagent extends BaseSubagent {
  id = 'dependency-mapper';
  name = 'Dependency Mapper';
  description = 'Creates dependency graph between files and modules';

  private fileManager: any;

  async execute(context: SubagentContext): Promise<DependencyGraph> {
    const { workspaceFolder, progress, token, previousResults } = context;

    progress('Mapping dependencies...');

    this.fileManager = getIntermediateFileManager();

    // Get extraction results from Level 2
    const extractionResult = previousResults.get('code-extractor') as ExtractionSummary | undefined;

    if (!extractionResult) {
      progress('No extraction results found');
      return this.createEmptyGraph();
    }

    // Build dependency graph
    const nodes: DependencyGraphNode[] = [];
    const edges: DependencyGraphEdge[] = [];
    const externalDependencies = new Set<string>();

    // Create nodes for each file
    const fileToNode = new Map<string, DependencyGraphNode>();
    const allFiles = new Set<string>();

    // Collect all files from extraction
    for (const file of extractionResult.byFile.keys()) {
      allFiles.add(file);
    }

    // Create nodes
    for (const file of allFiles) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      const fileResult = extractionResult.byFile.get(file);
      const exports = fileResult
        ? fileResult.exports.map((e) => e.name)
        : [];

      const node: DependencyGraphNode = {
        id: file,
        path: file,
        type: 'file',
        module: this.getModuleName(file),
        exports,
        isExternal: false,
      };

      nodes.push(node);
      fileToNode.set(file, node);
    }

    // Build edges from imports
    for (const imp of extractionResult.imports) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      if (imp.isExternal) {
        externalDependencies.add(imp.source);
        continue;
      }

      // Resolve the import path
      const targetPath = this.resolveImportPath(imp, workspaceFolder);

      if (targetPath && allFiles.has(targetPath)) {
        const edge: DependencyGraphEdge = {
          from: imp.file,
          to: targetPath,
          type: this.getImportType(imp),
          line: imp.line,
          sourceRef: imp.sourceRef,
          items: this.getImportedItems(imp),
          isTypeOnly: imp.isTypeOnly,
        };

        edges.push(edge);
      }
    }

    // Detect cycles
    const cycles = this.detectCycles(nodes, edges);

    const graph: DependencyGraph = {
      nodes,
      edges,
      cycles,
      externalDependencies: Array.from(externalDependencies).sort(),
    };

    // Save to intermediate file
    await this.fileManager.saveJson(IntermediateFileType.RELATIONSHIP_DEPENDENCY_GRAPH, graph);

    progress(`Mapped ${nodes.length} files with ${edges.length} dependencies (${cycles.length} cycles detected)`);

    return graph;
  }

  /**
   * 空のグラフを作成
   */
  private createEmptyGraph(): DependencyGraph {
    return {
      nodes: [],
      edges: [],
      cycles: [],
      externalDependencies: [],
    };
  }

  /**
   * ファイルパスからモジュール名を取得
   */
  private getModuleName(filePath: string): string {
    const dir = path.dirname(filePath);
    return path.basename(dir) || 'root';
  }

  /**
   * インポートパスを解決
   */
  private resolveImportPath(imp: ExtractedImport, workspaceFolder: vscode.WorkspaceFolder): string | null {
    // External imports are already filtered out
    if (imp.isExternal) {
      return null;
    }

    const sourceDir = path.dirname(imp.file);
    let targetPath = imp.source;

    // Handle relative imports
    if (targetPath.startsWith('.')) {
      targetPath = path.join(sourceDir, targetPath);
    }

    // Normalize path
    targetPath = path.normalize(targetPath);

    // Add extension if missing
    if (!path.extname(targetPath)) {
      // Try common extensions
      const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
      for (const ext of extensions) {
        const fullPath = targetPath + ext;
        // Just return the normalized path - we'll check existence later
        return fullPath;
      }
      // Default to .ts
      return targetPath + '.ts';
    }

    return targetPath;
  }

  /**
   * インポートタイプを判定
   */
  private getImportType(imp: ExtractedImport): 'import' | 'require' | 'dynamic-import' {
    // Based on how the import was detected
    if (imp.source.includes('require')) {
      return 'require';
    }
    // Dynamic imports would need additional detection
    return 'import';
  }

  /**
   * インポートされたアイテムを取得
   */
  private getImportedItems(imp: ExtractedImport): string[] {
    const items: string[] = [];

    if (imp.defaultImport) {
      items.push(`default as ${imp.defaultImport}`);
    }

    if (imp.namespaceImport) {
      items.push(`* as ${imp.namespaceImport}`);
    }

    items.push(...imp.items);

    return items;
  }

  /**
   * 循環依存を検出
   */
  private detectCycles(nodes: DependencyGraphNode[], edges: DependencyGraphEdge[]): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    // Build adjacency list
    const adjacency = new Map<string, string[]>();
    for (const node of nodes) {
      adjacency.set(node.id, []);
    }
    for (const edge of edges) {
      const deps = adjacency.get(edge.from);
      if (deps) {
        deps.push(edge.to);
      }
    }

    const dfs = (nodeId: string, path: string[]): void => {
      visited.add(nodeId);
      recursionStack.add(nodeId);
      path.push(nodeId);

      const dependencies = adjacency.get(nodeId) || [];
      for (const dep of dependencies) {
        if (!visited.has(dep)) {
          dfs(dep, [...path]);
        } else if (recursionStack.has(dep)) {
          // Found a cycle
          const cycleStart = path.indexOf(dep);
          if (cycleStart !== -1) {
            const cycle = path.slice(cycleStart);
            // Only add if not already detected
            if (!this.isCycleAlreadyFound(cycles, cycle)) {
              cycles.push(cycle);
            }
          }
        }
      }

      recursionStack.delete(nodeId);
    };

    for (const node of nodes) {
      if (!visited.has(node.id)) {
        dfs(node.id, []);
      }
    }

    return cycles;
  }

  /**
   * サイクルが既に見つかっているかチェック
   */
  private isCycleAlreadyFound(cycles: string[][], newCycle: string[]): boolean {
    const newSet = new Set(newCycle);
    for (const existing of cycles) {
      if (existing.length === newCycle.length) {
        const existingSet = new Set(existing);
        if ([...newSet].every((n) => existingSet.has(n))) {
          return true;
        }
      }
    }
    return false;
  }
}
