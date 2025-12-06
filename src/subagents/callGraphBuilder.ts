import * as vscode from 'vscode';
import * as path from 'path';
import { Project, SourceFile, Node, CallExpression, SyntaxKind } from 'ts-morph';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import {
  ExtractionSummary,
  ExtractedFunction,
  ExtractedMethod,
  createSourceRef,
} from '../types/extraction';
import {
  CallGraph,
  CallGraphEdge,
  CallGraphNode,
} from '../types/relationships';
import {
  getIntermediateFileManager,
  IntermediateFileType,
  logger,
} from '../utils';

/**
 * ASTベースのコールグラフビルダー
 *
 * Level 4: RELATIONSHIP
 * ts-morph を使って呼び出し式を解析し、関数/メソッド間の呼び出し関係を構築する。
 * マッピングは「シンボル名一致 + 同一ファイル優先」のヒューリスティック。
 */
export class CallGraphBuilderSubagent extends BaseSubagent {
  id = 'call-graph-builder';
  name = 'Call Graph Builder';
  description = 'Builds an AST-based call graph from extracted functions and methods';

  async execute(context: SubagentContext): Promise<{
    nodesCount: number;
    edgesCount: number;
    savedToFile: IntermediateFileType;
  }> {
    const { workspaceFolder, progress, token } = context;
    progress('Building AST-based call graph...');

    const fileManager = getIntermediateFileManager();
    const extraction = (await fileManager.loadJson<ExtractionSummary>(
      IntermediateFileType.EXTRACTION_SUMMARY
    )) || undefined;

    if (!extraction) {
      progress('No extraction results found, skipping call graph');
      return {
        nodesCount: 0,
        edgesCount: 0,
        savedToFile: IntermediateFileType.RELATIONSHIP_CALL_GRAPH,
      };
    }

    const project = this.createProject(workspaceFolder.uri.fsPath);
    const sourceFiles = new Map<string, SourceFile>();
    const loadSource = (relPath: string): SourceFile | null => {
      if (sourceFiles.has(relPath)) return sourceFiles.get(relPath)!;
      const abs = path.join(workspaceFolder.uri.fsPath, relPath);
      const sf = project.addSourceFileAtPathIfExists(abs) || null;
      if (sf) sourceFiles.set(relPath, sf);
      return sf;
    };

    // Nodes
    const nodes: CallGraphNode[] = [];
    const nameToIds = new Map<string, string[]>();

    // Functions
    for (const fn of extraction.functions) {
      const node: CallGraphNode = {
        id: `${fn.file}#${fn.name}`,
        name: fn.name,
        file: fn.file,
        sourceRef: fn.sourceRef,
        type: 'function',
        isAsync: fn.isAsync,
        isExported: fn.isExported,
      };
      nodes.push(node);
      const ids = nameToIds.get(fn.name) || [];
      ids.push(node.id);
      nameToIds.set(fn.name, ids);
    }

    // Methods
    for (const cls of extraction.classes) {
      for (const method of cls.methods) {
        const node: CallGraphNode = {
          id: `${cls.file}#${cls.name}.${method.name}`,
          name: method.name,
          file: cls.file,
          sourceRef: method.sourceRef,
          type: 'method',
          className: cls.name,
          isAsync: method.isAsync,
          isExported: cls.isExported,
        };
        nodes.push(node);
        const ids = nameToIds.get(method.name) || [];
        ids.push(node.id);
        nameToIds.set(method.name, ids);
      }
    }

    // Build edges by scanning call expressions in each file
    const edges: CallGraphEdge[] = [];
    const addEdge = (from: string, to: string, file: string, line: number, isAsync: boolean) => {
      edges.push({
        from,
        to,
        line,
        sourceRef: createSourceRef(file, line),
        callType: 'direct',
        isAsync,
      });
    };

    const nodeByFile = new Map<string, CallGraphNode[]>();
    for (const n of nodes) {
      const list = nodeByFile.get(n.file) || [];
      list.push(n);
      nodeByFile.set(n.file, list);
    }

    for (const [filePath, fileNodes] of nodeByFile.entries()) {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      const sf = loadSource(filePath);
      if (!sf) continue;

      // Map positions to owning node (function/method spans)
      const spans = fileNodes.map((n) => ({
        node: n,
        start: n.sourceRef.startLine,
        end: n.sourceRef.endLine ?? n.sourceRef.startLine,
      }));

      sf.forEachDescendant((node) => {
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        if (!Node.isCallExpression(node)) return;
        const call = node as CallExpression;
        const line = call.getStartLineNumber();
        const fromOwner = spans.find((s) => line >= s.start && line <= s.end);
        if (!fromOwner) return;

        const targetName = this.getCallName(call);
        if (!targetName) return;

        const candidates = nameToIds.get(targetName);
        if (!candidates) return;

        for (const toId of candidates) {
          addEdge(fromOwner.node.id, toId, filePath, line, fromOwner.node.isAsync);
        }
      });
    }

    const graph: CallGraph = {
      nodes,
      edges,
      entryPoints: [],
      recursiveFunctions: this.findRecursive(edges),
    };

    try {
      const fileManager = getIntermediateFileManager();
      await fileManager.saveJson(IntermediateFileType.RELATIONSHIP_CALL_GRAPH, graph);
    } catch (error) {
      logger.warn('CallGraphBuilder', 'Failed to save call graph');
    }

    progress(`Call graph built: ${nodes.length} nodes, ${edges.length} edges`);
    progress(`Call graph built: ${nodes.length} nodes, ${edges.length} edges`);

    return {
      nodesCount: nodes.length,
      edgesCount: edges.length,
      savedToFile: IntermediateFileType.RELATIONSHIP_CALL_GRAPH,
    };
  }

  private getCallName(call: CallExpression): string | null {
    const expr = call.getExpression();
    if (Node.isIdentifier(expr)) {
      return expr.getText();
    }
    if (Node.isPropertyAccessExpression(expr)) {
      return expr.getName();
    }
    return null;
  }

  private findRecursive(edges: CallGraphEdge[]): string[] {
    const recursive = new Set<string>();
    for (const edge of edges) {
      if (edge.from === edge.to) recursive.add(edge.from);
    }
    return Array.from(recursive);
  }

  private emptyGraph(): CallGraph {
    return { nodes: [], edges: [], entryPoints: [], recursiveFunctions: [] };
  }

  private createProject(rootPath: string): Project {
    const tsConfigPath = path.join(rootPath, 'tsconfig.json');
    const fs = require('fs');
    if (fs.existsSync(tsConfigPath)) {
      return new Project({
        tsConfigFilePath: tsConfigPath,
        skipAddingFilesFromTsConfig: true,
      });
    }
    return new Project({
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        allowJs: true,
        jsx: 1,
      },
    });
  }
}
