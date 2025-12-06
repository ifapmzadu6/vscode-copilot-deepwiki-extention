import * as vscode from 'vscode';
import * as path from 'path';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext, DependencyAnalysis } from '../types';
import { getIntermediateFileManager, IntermediateFileType, logger } from '../utils';

/**
 * 依存関係解析サブエージェント
 *
 * package.json とロックファイルから依存情報を収集し、
 * 使用パッケージやパッケージマネージャを特定する。
 *
 * 出力: .deepwiki/intermediate/analysis/dependencies.json (レガシー互換)
 */
export class DependencyAnalyzerSubagent extends BaseSubagent {
  id = 'dependency-analyzer';
  name = 'Dependency Analyzer';
  description = 'Analyzes package manifests to collect dependency information';

  async execute(context: SubagentContext): Promise<DependencyAnalysis> {
    const { workspaceFolder, progress } = context;
    const workspacePath = workspaceFolder.uri.fsPath;

    const manifestPath = path.join(workspacePath, 'package.json');
    const lockFiles = [
      { name: 'pnpm-lock.yaml', manager: 'pnpm' },
      { name: 'yarn.lock', manager: 'yarn' },
      { name: 'package-lock.json', manager: 'npm' },
      { name: 'bun.lockb', manager: 'bun' },
    ];

    progress('Analyzing dependencies...');

    const manifest = await this.readJsonFile<Record<string, any>>(manifestPath);

    const dependencies = manifest?.dependencies ?? {};
    const devDependencies = manifest?.devDependencies ?? {};
    const packageManager =
      manifest?.packageManager ||
      this.detectPackageManager(workspacePath, lockFiles) ||
      null;

    const analysis: DependencyAnalysis = {
      packageManager,
      dependencies,
      devDependencies,
      frameworks: [],
      languages: [],
    };

    // Save for downstream consumers (legacy key expected by FinalDocumentGenerator)
    try {
      const fileManager = getIntermediateFileManager(workspaceFolder.uri);
      await fileManager.saveJson(IntermediateFileType.DEPENDENCIES, analysis, undefined, {
        dependencies: ['package.json'],
      });
    } catch (error) {
      logger.error('DependencyAnalyzer', 'Failed to save intermediate dependencies', error);
    }

    progress(`Dependencies found: ${Object.keys(dependencies).length} (dev: ${Object.keys(devDependencies).length})`);

    return analysis;
  }

  /**
   * ロックファイルからパッケージマネージャを推定
   */
  private detectPackageManager(
    workspacePath: string,
    lockFiles: Array<{ name: string; manager: string }>
  ): string | null {
    for (const lock of lockFiles) {
      const lockPath = path.join(workspacePath, lock.name);
      try {
        // eslint-disable-next-line no-sync
        require('fs').accessSync(lockPath);
        return lock.manager;
      } catch {
        // not present
      }
    }
    return null;
  }

  /**
   * 安全にJSONファイルを読み込む
   */
  private async readJsonFile<T>(filePath: string): Promise<T | null> {
    try {
      const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      return JSON.parse(Buffer.from(content).toString('utf-8')) as T;
    } catch {
      return null;
    }
  }
}
