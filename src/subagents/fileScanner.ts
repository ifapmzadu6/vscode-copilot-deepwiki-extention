import * as vscode from 'vscode';
import * as path from 'path';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { ScannedFile } from '../types/analysis';
import { DiscoveredFile } from '../types/extraction';
import {
  IntermediateFileManager,
  IntermediateFileType,
  initIntermediateFileManager,
} from '../utils/intermediateFileManager';
import { logger } from '../utils/logger';

// Configuration constants
// TODO: Move to centralized configuration module for better maintainability
const MAX_FILES_TO_SCAN = 10000;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * ファイルリストの中間データ型
 */
interface FileListIntermediate {
  totalFiles: number;
  byLanguage: Record<string, number>;
  byDirectory: Record<string, string[]>;
  files: Array<{
    path: string;
    relativePath: string;
    language: string;
    size: number;
  }>;
}

/**
 * Scans all files in the workspace and collects basic information
 * 中間ファイル出力: .deepwiki/intermediate/analysis/file-list.json
 */
export class FileScannerSubagent extends BaseSubagent {
  id = 'file-scanner';
  name = 'File Scanner';
  description = 'Scans workspace files and collects basic information';

  private fileManager: IntermediateFileManager | null = null;

  async execute(context: SubagentContext): Promise<ScannedFile[]> {
    const { workspaceFolder, progress, token } = context;

    // 中間ファイルマネージャーを初期化
    this.fileManager = initIntermediateFileManager(
      workspaceFolder.uri,
      context.parameters.outputPath
    );

    progress('Scanning workspace files...');

    // Find all files
    const excludePattern = `{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.next/**,**/build/**,**/__pycache__/**,**/*.pyc,**/venv/**,**/.venv/**,**/coverage/**,**/.nyc_output/**}`;
    const allFiles = await this.findFiles('**/*', excludePattern, MAX_FILES_TO_SCAN, workspaceFolder);

    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    const rootPath = workspaceFolder.uri.fsPath;
    const scannedFiles: ScannedFile[] = [];

    for (const uri of allFiles) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      const relativePath = path.relative(rootPath, uri.fsPath);
      const ext = path.extname(uri.fsPath);

      // Get file stats
      let size = 0;
      let lastModified = 0;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        size = stat.size;
        lastModified = stat.mtime;
      } catch {
        // Ignore stat errors
      }

      // Skip binary and very large files
      if (size > MAX_FILE_SIZE_BYTES) {
        continue;
      }

      const language = this.getLanguageFromExtension(ext);

      scannedFiles.push({
        path: uri.fsPath,
        relativePath,
        size,
        language,
        lastModified,
      });
    }

    progress(`Scanned ${scannedFiles.length} files`);

    // 中間ファイルに保存
    await this.saveIntermediateFile(scannedFiles);

    return scannedFiles;
  }

  /**
   * 中間ファイルに保存
   */
  private async saveIntermediateFile(files: ScannedFile[]): Promise<void> {
    if (!this.fileManager) return;

    // 言語別・ディレクトリ別に集計
    const byLanguage: Record<string, number> = {};
    const byDirectory: Record<string, string[]> = {};

    for (const file of files) {
      // 言語別カウント
      byLanguage[file.language] = (byLanguage[file.language] || 0) + 1;

      // ディレクトリ別ファイルリスト
      const dir = path.dirname(file.relativePath);
      if (!byDirectory[dir]) {
        byDirectory[dir] = [];
      }
      byDirectory[dir].push(path.basename(file.relativePath));
    }

    const intermediate: FileListIntermediate = {
      totalFiles: files.length,
      byLanguage,
      byDirectory,
      files: files.map((f) => ({
        path: f.path,
        relativePath: f.relativePath,
        language: f.language,
        size: f.size,
      })),
    };

    await this.fileManager.saveJson(
      IntermediateFileType.FILE_LIST,
      intermediate
    );

    // 新アーキテクチャ向け: discovery/files.json
    const discoveryFiles: DiscoveredFile[] = files.map((f) => ({
      path: f.path,
      relativePath: f.relativePath,
      language: f.language,
      size: f.size,
      lineCount: 0,
      isEntryPoint: false,
      isConfig: false,
      isTest: /(__tests__|\.test\.|\.spec\.)/.test(f.relativePath),
      category: this.getCategory(f.relativePath),
    }));

    await this.fileManager.saveJson(
      IntermediateFileType.DISCOVERY_FILES,
      {
        files: discoveryFiles,
        summary: {
          totalFiles: discoveryFiles.length,
          totalLines: 0,
          byLanguage,
          byCategory: discoveryFiles.reduce<Record<string, number>>((acc, cur) => {
            acc[cur.category] = (acc[cur.category] || 0) + 1;
            return acc;
          }, {}),
        },
        entryPoints: [],
        configFiles: [],
      }
    );

    logger.log('FileScanner', 'Saved intermediate file: file-list.json');
  }

  private getCategory(relativePath: string): DiscoveredFile['category'] {
    if (/(\.test\.|\.spec\.|__tests__)/.test(relativePath)) return 'test';
    if (/config|\.config\./.test(relativePath)) return 'config';
    if (/\.(md|mdx|txt)$/.test(relativePath)) return 'doc';
    if (/\.(png|jpg|jpeg|gif|svg|ico)$/.test(relativePath)) return 'asset';
    if (/node_modules|\.git/.test(relativePath)) return 'other';
    return 'core';
  }

  private getLanguageFromExtension(ext: string): string {
    const languageMap: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescriptreact',
      '.js': 'javascript',
      '.jsx': 'javascriptreact',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
      '.py': 'python',
      '.java': 'java',
      '.go': 'go',
      '.rs': 'rust',
      '.rb': 'ruby',
      '.php': 'php',
      '.cs': 'csharp',
      '.cpp': 'cpp',
      '.cc': 'cpp',
      '.c': 'c',
      '.h': 'c',
      '.hpp': 'cpp',
      '.swift': 'swift',
      '.kt': 'kotlin',
      '.scala': 'scala',
      '.vue': 'vue',
      '.svelte': 'svelte',
      '.html': 'html',
      '.css': 'css',
      '.scss': 'scss',
      '.sass': 'sass',
      '.less': 'less',
      '.json': 'json',
      '.yaml': 'yaml',
      '.yml': 'yaml',
      '.xml': 'xml',
      '.md': 'markdown',
      '.sql': 'sql',
      '.sh': 'shellscript',
      '.bash': 'shellscript',
      '.zsh': 'shellscript',
      '.ps1': 'powershell',
      '.dockerfile': 'dockerfile',
    };

    return languageMap[ext.toLowerCase()] || 'plaintext';
  }
}
