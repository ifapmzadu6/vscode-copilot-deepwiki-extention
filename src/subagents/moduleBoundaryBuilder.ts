import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { DependencyGraph, ModuleBoundaries, ModuleDefinition, ModuleExport } from '../types/relationships';
import { ExtractionSummary } from '../types/extraction';
import * as path from 'path';
import { getIntermediateFileManager, IntermediateFileType } from '../utils';

/**
 * 簡易モジュール境界ビルダー
 * ディレクトリ単位でモジュールを推定し、依存グラフから内部/外部依存を計算する。
 */
export class ModuleBoundaryBuilderSubagent extends BaseSubagent {
  id = 'module-boundary-builder';
  name = 'Module Boundary Builder';
  description = 'Builds module boundaries from dependency graph and extraction results';

  async execute(context: SubagentContext): Promise<ModuleBoundaries> {
    const { previousResults, progress } = context;

    progress('Building module boundaries...');

    const depGraph = previousResults.get('dependency-mapper') as DependencyGraph | undefined;
    const extraction = previousResults.get('code-extractor') as ExtractionSummary | undefined;

    if (!depGraph || !extraction) {
      return { modules: [], moduleGraph: { nodes: [], edges: [] } };
    }

    const modulesMap = new Map<string, ModuleDefinition>();

    // group by top-level directory under src or root
    for (const node of depGraph.nodes) {
      const dir = this.getTopModuleDir(node.path);
      const mod = modulesMap.get(dir) || {
        name: dir,
        path: dir,
        files: [],
        exports: [],
        internalDependencies: [],
        externalDependencies: [],
        cohesion: 0,
        coupling: 0,
        instability: 0,
      };
      mod.files.push(node.path);
      modulesMap.set(dir, mod);
    }

    // fill exports from extraction
    for (const exp of extraction.exports) {
      const dir = this.getTopModuleDir(exp.file);
      const mod = modulesMap.get(dir);
      if (mod) {
        const entry: ModuleExport = {
          name: exp.name,
          type: exp.type === 'default' || exp.type === 'namespace' ? 'const' : exp.type,
          file: exp.file,
          sourceRef: exp.sourceRef,
          isReExport: false,
        };
        mod.exports.push(entry);
      }
    }

    // dependencies between modules
    const edges: Array<{ from: string; to: string; weight: number }> = [];
    for (const edge of depGraph.edges) {
      const fromModule = this.getTopModuleDir(edge.from);
      const toModule = this.getTopModuleDir(edge.to);
      if (fromModule === toModule) continue;
      const mFrom = modulesMap.get(fromModule);
      if (mFrom && !mFrom.internalDependencies.includes(toModule)) {
        mFrom.internalDependencies.push(toModule);
      }
      edges.push({ from: fromModule, to: toModule, weight: 1 });
    }

    const moduleGraph = {
      nodes: Array.from(modulesMap.keys()),
      edges,
    };

    const modules = Array.from(modulesMap.values());

    // save
    try {
      const fileManager = getIntermediateFileManager();
      await fileManager.saveJson(IntermediateFileType.RELATIONSHIP_MODULES, {
        modules,
        moduleGraph,
      });
    } catch {
      // ignore save errors
    }

    return {
      modules,
      moduleGraph,
    };
  }

  private getTopModuleDir(p: string): string {
    const parts = p.split(path.sep);
    const srcIndex = parts.indexOf('src');
    if (srcIndex >= 0 && parts.length > srcIndex + 1) {
      return parts[srcIndex + 1];
    }
    return parts[0] || 'root';
  }
}
