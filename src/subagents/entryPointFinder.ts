import * as path from 'path';
import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { getIntermediateFileManager, IntermediateFileType, logger } from '../utils';

/**
 * エントリーポイント検出サブエージェント
 *
 * package.json の main/bin とよくあるエントリファイル名から推測する。
 */
export class EntryPointFinderSubagent extends BaseSubagent {
  id = 'entry-point-finder';
  name = 'Entry Point Finder';
  description = 'Finds likely application entry points';

  async execute(context: SubagentContext): Promise<string[]> {
    const { workspaceFolder, previousResults, progress } = context;
    progress('Finding entry points...');

    const fileList = previousResults.get('file-scanner') as Array<{
      relativePath: string;
    }> | undefined;

    const candidates: Set<string> = new Set();

    // Heuristic: common entry filenames
    const commonNames = [
      'src/index.ts',
      'src/index.tsx',
      'src/index.js',
      'src/main.ts',
      'src/main.tsx',
      'src/main.js',
      'index.ts',
      'index.js',
      'server.ts',
      'server.js',
      'app.ts',
      'app.js',
    ];

    if (fileList) {
      for (const file of fileList) {
        if (commonNames.includes(file.relativePath)) {
          candidates.add(file.relativePath);
        }
      }
    }

    // package.json main/module/bin fields
    try {
      const manifestUri = vscode.Uri.joinPath(workspaceFolder.uri, 'package.json');
      const manifestBuf = await vscode.workspace.fs.readFile(manifestUri);
      const manifest = JSON.parse(Buffer.from(manifestBuf).toString('utf-8')) as Record<string, any>;

      const pkgMain = manifest.main as string | undefined;
      const pkgModule = manifest.module as string | undefined;
      const pkgBin = manifest.bin as string | Record<string, string> | undefined;

      [pkgMain, pkgModule].filter(Boolean).forEach((p) => candidates.add(p as string));

      if (typeof pkgBin === 'string') {
        candidates.add(pkgBin);
      } else if (pkgBin && typeof pkgBin === 'object') {
        Object.values(pkgBin).forEach((p) => candidates.add(p));
      }
    } catch {
      // ignore
    }

    const normalized = Array.from(candidates)
      .map((p) => path.normalize(p))
      .sort();

    try {
      const fileManager = getIntermediateFileManager();
      await fileManager.saveJson(IntermediateFileType.DISCOVERY_ENTRY_POINTS, { entryPoints: normalized });
    } catch (error) {
      logger.error('EntryPointFinder', 'Failed to save entry points', error);
    }

    progress(`Entry points detected: ${normalized.length}`);
    return normalized;
  }
}
