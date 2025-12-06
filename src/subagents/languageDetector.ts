import * as path from 'path';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { getIntermediateFileManager, IntermediateFileType, logger } from '../utils';

interface LanguageDetectionResult {
  primary: string | null;
  all: string[];
  byLanguage: Record<string, number>;
}

/**
 * 言語検出サブエージェント
 *
 * Level 1: DISCOVERY
 * file-scanner の結果をもとに使用言語を集計する。
 */
export class LanguageDetectorSubagent extends BaseSubagent {
  id = 'language-detector';
  name = 'Language Detector';
  description = 'Detects languages used in the workspace';

  async execute(context: SubagentContext): Promise<LanguageDetectionResult> {
    const { previousResults, progress } = context;

    progress('Detecting languages...');

    const fileList = previousResults.get('file-scanner') as Array<{
      relativePath: string;
      language: string;
    }> | undefined;

    if (!fileList || fileList.length === 0) {
      return { primary: null, all: [], byLanguage: {} };
    }

    const byLanguage: Record<string, number> = {};

    for (const file of fileList) {
      const language = this.normalizeLanguage(file.language, file.relativePath);
      byLanguage[language] = (byLanguage[language] || 0) + 1;
    }

    const sorted = Object.entries(byLanguage).sort((a, b) => b[1] - a[1]);
    const primary = sorted[0]?.[0] ?? null;
    const all = sorted.map(([lang]) => lang);

    const result: LanguageDetectionResult = {
      primary,
      all,
      byLanguage,
    };

    try {
      const fileManager = getIntermediateFileManager();
      await fileManager.saveJson(IntermediateFileType.DISCOVERY_LANGUAGES, result);
    } catch (error) {
      logger.error('LanguageDetector', 'Failed to save language detection', error);
    }

    progress(`Primary language: ${primary || 'unknown'} (${fileList.length} files scanned)`);

    return result;
  }

  /**
   * 拡張子から言語名を正規化
   */
  private normalizeLanguage(language: string, relativePath: string): string {
    if (language && language !== 'plaintext') return language;

    const ext = path.extname(relativePath).toLowerCase();
    const map: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.py': 'python',
      '.java': 'java',
      '.kt': 'kotlin',
      '.rs': 'rust',
      '.go': 'go',
      '.rb': 'ruby',
      '.php': 'php',
      '.cs': 'csharp',
      '.cpp': 'cpp',
      '.c': 'c',
      '.swift': 'swift',
      '.m': 'objective-c',
      '.mm': 'objective-c++',
      '.json': 'json',
      '.yaml': 'yaml',
      '.yml': 'yaml',
      '.md': 'markdown',
      '.css': 'css',
      '.scss': 'scss',
      '.vue': 'vue',
      '.svelte': 'svelte',
    };

    return map[ext] || 'plaintext';
  }
}
