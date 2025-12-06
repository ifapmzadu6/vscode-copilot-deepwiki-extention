import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext, DependencyAnalysis } from '../types';
import { FrameworkInfo } from '../types/analysis';
import { getIntermediateFileManager, IntermediateFileType, logger } from '../utils';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Detects frameworks and libraries used in the project
 */
export class FrameworkDetectorSubagent extends BaseSubagent {
  id = 'framework-detector';
  name = 'Framework Detector';
  description = 'Detects frameworks and libraries used in the project';

  async execute(context: SubagentContext): Promise<FrameworkInfo[]> {
    const { workspaceFolder, progress, token, previousResults } = context;

    progress('Detecting frameworks...');

    const depAnalysis = (previousResults.get('dependency-analyzer') as DependencyAnalysis | undefined) ||
      (await this.readManifestDependencies(workspaceFolder.uri.fsPath));

    const frameworks: FrameworkInfo[] = [];
    const allDeps = { ...(depAnalysis?.dependencies || {}), ...(depAnalysis?.devDependencies || {}) };

    // Detect major frameworks
    const frameworkMap: Record<string, { name: string; category: FrameworkInfo['category'] }> = {
      'react': { name: 'React', category: 'frontend' },
      'vue': { name: 'Vue.js', category: 'frontend' },
      'angular': { name: 'Angular', category: 'frontend' },
      '@angular/core': { name: 'Angular', category: 'frontend' },
      'svelte': { name: 'Svelte', category: 'frontend' },
      'next': { name: 'Next.js', category: 'fullstack' },
      'express': { name: 'Express', category: 'backend' },
      'fastify': { name: 'Fastify', category: 'backend' },
      '@nestjs/core': { name: 'NestJS', category: 'backend' },
      'django': { name: 'Django', category: 'backend' },
      'flask': { name: 'Flask', category: 'backend' },
      'fastapi': { name: 'FastAPI', category: 'backend' },
      'jest': { name: 'Jest', category: 'testing' },
      'vitest': { name: 'Vitest', category: 'testing' },
      'pytest': { name: 'pytest', category: 'testing' },
      'vite': { name: 'Vite', category: 'build' },
      'webpack': { name: 'Webpack', category: 'build' },
      'prisma': { name: 'Prisma', category: 'orm' },
      '@prisma/client': { name: 'Prisma', category: 'orm' },
      'typeorm': { name: 'TypeORM', category: 'orm' },
      'mongoose': { name: 'Mongoose', category: 'orm' },
      'sqlalchemy': { name: 'SQLAlchemy', category: 'orm' },
    };

    for (const [dep, info] of Object.entries(frameworkMap)) {
      if (allDeps[dep] || Object.keys(allDeps).some(d => d.includes(dep))) {
        frameworks.push({
          name: info.name,
          version: allDeps[dep],
          category: info.category,
          confidence: 1.0,
          files: [],
          patterns: [dep],
        });
      }
    }

    try {
      const fileManager = getIntermediateFileManager();
      await fileManager.saveJson(IntermediateFileType.DISCOVERY_FRAMEWORKS, { frameworks });
    } catch (error) {
      logger.error('FrameworkDetector', 'Failed to save frameworks', error);
    }

    progress(`Detected ${frameworks.length} frameworks`);

    return frameworks;
  }

  /**
   * package.json を直接読んで依存情報を取得するフォールバック
   */
  private async readManifestDependencies(workspacePath: string): Promise<DependencyAnalysis> {
    try {
      const manifestPath = path.join(workspacePath, 'package.json');
      const buf = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(buf) as Record<string, any>;
      return {
        packageManager: manifest.packageManager || null,
        dependencies: manifest.dependencies || {},
        devDependencies: manifest.devDependencies || {},
        frameworks: [],
        languages: [],
      };
    } catch {
      return {
        packageManager: null,
        dependencies: {},
        devDependencies: {},
        frameworks: [],
        languages: [],
      };
    }
  }
}
