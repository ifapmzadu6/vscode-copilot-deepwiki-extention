import * as vscode from 'vscode';
import * as path from 'path';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { ScannedFile } from '../types/analysis';

// Configuration constants
// TODO: Move to centralized configuration module for better maintainability
const MAX_FILES_TO_SCAN = 10000;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Scans all files in the workspace and collects basic information
 */
export class FileScannerSubagent extends BaseSubagent {
  id = 'file-scanner';
  name = 'File Scanner';
  description = 'Scans workspace files and collects basic information';

  async execute(context: SubagentContext): Promise<ScannedFile[]> {
    const { workspaceFolder, progress, token } = context;

    progress('Scanning workspace files...');

    // Find all files
    const allFiles = await this.findFiles(
      '**/*',
      '**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.next/**,**/build/**,**/__pycache__/**,**/*.pyc,**/venv/**,**/.venv/**,**/coverage/**,**/.nyc_output/**',
      MAX_FILES_TO_SCAN
    );

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

    return scannedFiles;
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
