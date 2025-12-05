import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext, WorkspaceStructure, WorkspaceFile } from '../types';
import * as path from 'path';

/**
 * Subagent that analyzes the workspace file structure
 */
export class StructureAnalyzerSubagent extends BaseSubagent {
  id = 'structure-analyzer';
  name = 'Structure Analyzer';
  description = 'Analyzes the workspace file and directory structure';

  async execute(context: SubagentContext): Promise<WorkspaceStructure> {
    const { workspaceFolder, progress, token } = context;

    progress('Scanning workspace files...');

    // Find all files in workspace
    const allFiles = await this.findFiles(
      '**/*',
      '**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.next/**,**/build/**,**/__pycache__/**,**/*.pyc,**/venv/**,**/.venv/**',
      5000
    );

    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    progress('Analyzing file types...');

    const files: WorkspaceFile[] = [];
    const directories = new Set<string>();
    const configFiles: string[] = [];
    const entryPoints: string[] = [];

    const rootPath = workspaceFolder.uri.fsPath;

    for (const uri of allFiles) {
      const relativePath = path.relative(rootPath, uri.fsPath);
      const fileName = path.basename(uri.fsPath);
      const ext = path.extname(uri.fsPath);
      const dir = path.dirname(relativePath);

      // Track directories
      if (dir && dir !== '.') {
        const parts = dir.split(path.sep);
        let currentPath = '';
        for (const part of parts) {
          currentPath = currentPath ? path.join(currentPath, part) : part;
          directories.add(currentPath);
        }
      }

      // Get file stats
      let size = 0;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        size = stat.size;
      } catch {
        // Ignore stat errors
      }

      // Determine language
      const language = this.getLanguageFromExtension(ext);

      files.push({
        uri,
        relativePath,
        language,
        size,
      });

      // Identify config files
      if (this.isConfigFile(fileName)) {
        configFiles.push(relativePath);
      }

      // Identify entry points
      if (this.isEntryPoint(fileName, relativePath)) {
        entryPoints.push(relativePath);
      }
    }

    progress('Structure analysis complete');

    return {
      rootPath,
      files,
      directories: Array.from(directories).sort(),
      entryPoints,
      configFiles,
    };
  }

  private getLanguageFromExtension(ext: string): string {
    const languageMap: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescriptreact',
      '.js': 'javascript',
      '.jsx': 'javascriptreact',
      '.py': 'python',
      '.java': 'java',
      '.go': 'go',
      '.rs': 'rust',
      '.rb': 'ruby',
      '.php': 'php',
      '.cs': 'csharp',
      '.cpp': 'cpp',
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

  private isConfigFile(fileName: string): boolean {
    const configPatterns = [
      'package.json',
      'tsconfig.json',
      'jsconfig.json',
      '.eslintrc',
      '.prettierrc',
      'webpack.config',
      'vite.config',
      'rollup.config',
      'babel.config',
      '.babelrc',
      'jest.config',
      'vitest.config',
      'tailwind.config',
      'postcss.config',
      'next.config',
      'nuxt.config',
      'angular.json',
      'Cargo.toml',
      'go.mod',
      'pyproject.toml',
      'setup.py',
      'requirements.txt',
      'Gemfile',
      'composer.json',
      'pom.xml',
      'build.gradle',
      'Makefile',
      'CMakeLists.txt',
      'Dockerfile',
      'docker-compose',
      '.env',
      '.gitignore',
      '.dockerignore',
    ];

    const lowerFileName = fileName.toLowerCase();
    return configPatterns.some(
      (pattern) =>
        lowerFileName === pattern.toLowerCase() ||
        lowerFileName.startsWith(pattern.toLowerCase())
    );
  }

  private isEntryPoint(fileName: string, relativePath: string): boolean {
    const entryPatterns = [
      'index.ts',
      'index.js',
      'main.ts',
      'main.js',
      'app.ts',
      'app.js',
      'server.ts',
      'server.js',
      'main.py',
      'app.py',
      '__main__.py',
      'main.go',
      'main.rs',
      'Main.java',
      'Program.cs',
    ];

    const lowerFileName = fileName.toLowerCase();

    // Check if it's a common entry point name
    if (
      entryPatterns.some((pattern) => lowerFileName === pattern.toLowerCase())
    ) {
      // Prefer root-level or src-level entry points
      const depth = relativePath.split(path.sep).length;
      return depth <= 2;
    }

    return false;
  }
}
