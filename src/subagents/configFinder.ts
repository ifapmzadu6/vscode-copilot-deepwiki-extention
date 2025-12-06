import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { getIntermediateFileManager, IntermediateFileType, logger } from '../utils';

/**
 * 設定ファイル検出サブエージェント
 *
 * よくある設定ファイル名からプロジェクトの設定ファイルを列挙する。
 */
export class ConfigFinderSubagent extends BaseSubagent {
  id = 'config-finder';
  name = 'Config Finder';
  description = 'Detects configuration files in the workspace';

  private readonly knownConfigs = [
    'tsconfig.json',
    'jsconfig.json',
    'package.json',
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.json',
    '.prettierrc',
    '.prettierrc.js',
    '.prettierrc.cjs',
    '.prettierrc.json',
    'prettier.config.js',
    'prettier.config.cjs',
    'babel.config.js',
    'babel.config.cjs',
    '.babelrc',
    '.babelrc.json',
    'webpack.config.js',
    'vite.config.ts',
    'vite.config.js',
    'next.config.js',
    'jest.config.js',
    'jest.config.ts',
    'vitest.config.ts',
    'vitest.config.js',
    'nodemon.json',
    '.npmrc',
    '.yarnrc',
    '.yarnrc.yml',
    'pnpm-workspace.yaml',
  ];

  async execute(context: SubagentContext): Promise<string[]> {
    const { previousResults, progress } = context;
    progress('Detecting config files...');

    const fileList = previousResults.get('file-scanner') as Array<{
      relativePath: string;
    }> | undefined;

    if (!fileList) {
      return [];
    }

    const configs = fileList
      .filter((f) => this.knownConfigs.some((name) => f.relativePath.endsWith(name)))
      .map((f) => f.relativePath)
      .sort();

    try {
      const fileManager = getIntermediateFileManager();
      await fileManager.saveJson(IntermediateFileType.DISCOVERY_CONFIGS, { configs });
    } catch (error) {
      logger.error('ConfigFinder', 'Failed to save configs', error);
    }

    progress(`Config files detected: ${configs.length}`);
    return configs;
  }
}
