import * as vscode from 'vscode';
import * as path from 'path';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext, DependencyAnalysis, WorkspaceStructure } from '../types';

/**
 * Subagent that analyzes project dependencies
 */
export class DependencyAnalyzerSubagent extends BaseSubagent {
  id = 'dependency-analyzer';
  name = 'Dependency Analyzer';
  description = 'Analyzes project dependencies, frameworks, and technologies';

  async execute(context: SubagentContext): Promise<DependencyAnalysis> {
    const { workspaceFolder, model, progress, token, previousResults } = context;

    progress('Analyzing dependencies...');

    const structure = previousResults.get('structure-analyzer') as WorkspaceStructure;
    const rootPath = workspaceFolder.uri.fsPath;

    let packageManager: string | null = null;
    let dependencies: Record<string, string> = {};
    let devDependencies: Record<string, string> = {};
    const frameworks: string[] = [];
    const languages: string[] = [];

    // Analyze based on config files found
    const configFiles = structure?.configFiles || [];

    // Check for Node.js projects
    if (configFiles.some((f) => f.includes('package.json'))) {
      packageManager = 'npm';
      const packageJsonPath = vscode.Uri.file(path.join(rootPath, 'package.json'));
      const content = await this.readFile(packageJsonPath);

      if (content) {
        try {
          const pkg = JSON.parse(content);
          dependencies = pkg.dependencies || {};
          devDependencies = pkg.devDependencies || {};

          // Detect frameworks
          const allDeps = { ...dependencies, ...devDependencies };
          frameworks.push(...this.detectJsFrameworks(allDeps));
          languages.push('JavaScript', 'TypeScript');

          // Check for yarn or pnpm
          const hasYarnLock = configFiles.some((f) => f.includes('yarn.lock'));
          const hasPnpmLock = configFiles.some((f) => f.includes('pnpm-lock'));
          if (hasYarnLock) packageManager = 'yarn';
          if (hasPnpmLock) packageManager = 'pnpm';
        } catch {
          // Ignore parse errors
        }
      }
    }

    // Check for Python projects
    if (
      configFiles.some(
        (f) =>
          f.includes('pyproject.toml') ||
          f.includes('setup.py') ||
          f.includes('requirements.txt')
      )
    ) {
      packageManager = packageManager || 'pip';
      languages.push('Python');

      // Try to read requirements.txt
      const reqPath = vscode.Uri.file(path.join(rootPath, 'requirements.txt'));
      const reqContent = await this.readFile(reqPath);
      if (reqContent) {
        const pyDeps = this.parsePythonRequirements(reqContent);
        dependencies = { ...dependencies, ...pyDeps };
        frameworks.push(...this.detectPythonFrameworks(pyDeps));
      }

      // Try to read pyproject.toml
      const pyprojectPath = vscode.Uri.file(path.join(rootPath, 'pyproject.toml'));
      const pyprojectContent = await this.readFile(pyprojectPath);
      if (pyprojectContent) {
        const pyDeps = this.parsePyprojectToml(pyprojectContent);
        dependencies = { ...dependencies, ...pyDeps };
        frameworks.push(...this.detectPythonFrameworks(pyDeps));
      }
    }

    // Check for Go projects
    if (configFiles.some((f) => f.includes('go.mod'))) {
      packageManager = packageManager || 'go modules';
      languages.push('Go');
      frameworks.push('Go');
    }

    // Check for Rust projects
    if (configFiles.some((f) => f.includes('Cargo.toml'))) {
      packageManager = packageManager || 'cargo';
      languages.push('Rust');
      frameworks.push('Rust');
    }

    // Check for Java projects
    if (
      configFiles.some(
        (f) => f.includes('pom.xml') || f.includes('build.gradle')
      )
    ) {
      packageManager = configFiles.some((f) => f.includes('pom.xml'))
        ? 'maven'
        : 'gradle';
      languages.push('Java');
    }

    // Use LLM to analyze and summarize if we have dependencies
    if (Object.keys(dependencies).length > 0 && !token.isCancellationRequested) {
      progress('Analyzing dependency patterns with AI...');

      try {
        const analysisPrompt = `Analyze these project dependencies and identify any additional frameworks or patterns:

Dependencies: ${JSON.stringify(dependencies, null, 2)}
Dev Dependencies: ${JSON.stringify(devDependencies, null, 2)}

Respond with a JSON object containing:
{
  "additionalFrameworks": ["framework1", "framework2"],
  "patterns": ["pattern1", "pattern2"],
  "notes": "brief analysis notes"
}`;

        const response = await this.queryModel(
          model,
          'You are a software architecture analyst. Analyze dependencies and identify frameworks and patterns. Respond only with valid JSON.',
          analysisPrompt,
          token
        );

        const analysis = this.parseJsonResponse<{
          additionalFrameworks?: string[];
        }>(response);
        if (analysis.additionalFrameworks) {
          frameworks.push(
            ...analysis.additionalFrameworks.filter(
              (f) => !frameworks.includes(f)
            )
          );
        }
      } catch {
        // Continue without AI analysis
      }
    }

    progress('Dependency analysis complete');

    return {
      packageManager,
      dependencies,
      devDependencies,
      frameworks: [...new Set(frameworks)],
      languages: [...new Set(languages)],
    };
  }

  private detectJsFrameworks(deps: Record<string, string>): string[] {
    const frameworks: string[] = [];
    const frameworkMap: Record<string, string> = {
      react: 'React',
      'react-dom': 'React',
      next: 'Next.js',
      vue: 'Vue.js',
      nuxt: 'Nuxt',
      angular: 'Angular',
      '@angular/core': 'Angular',
      svelte: 'Svelte',
      '@sveltejs/kit': 'SvelteKit',
      express: 'Express',
      fastify: 'Fastify',
      koa: 'Koa',
      nestjs: 'NestJS',
      '@nestjs/core': 'NestJS',
      electron: 'Electron',
      'react-native': 'React Native',
      gatsby: 'Gatsby',
      remix: 'Remix',
      '@remix-run/node': 'Remix',
      astro: 'Astro',
      vite: 'Vite',
      webpack: 'Webpack',
      tailwindcss: 'Tailwind CSS',
      prisma: 'Prisma',
      '@prisma/client': 'Prisma',
      mongoose: 'MongoDB/Mongoose',
      typeorm: 'TypeORM',
      sequelize: 'Sequelize',
      jest: 'Jest',
      vitest: 'Vitest',
      mocha: 'Mocha',
      cypress: 'Cypress',
      playwright: 'Playwright',
      '@playwright/test': 'Playwright',
      storybook: 'Storybook',
      '@storybook/react': 'Storybook',
    };

    for (const [dep, name] of Object.entries(frameworkMap)) {
      if (deps[dep]) {
        frameworks.push(name);
      }
    }

    return [...new Set(frameworks)];
  }

  private detectPythonFrameworks(deps: Record<string, string>): string[] {
    const frameworks: string[] = [];
    const frameworkMap: Record<string, string> = {
      django: 'Django',
      flask: 'Flask',
      fastapi: 'FastAPI',
      tornado: 'Tornado',
      pyramid: 'Pyramid',
      aiohttp: 'aiohttp',
      starlette: 'Starlette',
      celery: 'Celery',
      sqlalchemy: 'SQLAlchemy',
      pandas: 'Pandas',
      numpy: 'NumPy',
      tensorflow: 'TensorFlow',
      pytorch: 'PyTorch',
      torch: 'PyTorch',
      keras: 'Keras',
      scikit: 'scikit-learn',
      pytest: 'pytest',
      unittest: 'unittest',
    };

    for (const [dep, name] of Object.entries(frameworkMap)) {
      const depLower = dep.toLowerCase();
      if (
        Object.keys(deps).some((d) => d.toLowerCase().includes(depLower))
      ) {
        frameworks.push(name);
      }
    }

    return [...new Set(frameworks)];
  }

  private parsePythonRequirements(content: string): Record<string, string> {
    const deps: Record<string, string> = {};
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) {
        continue;
      }

      // Parse package==version or package>=version etc.
      const match = trimmed.match(/^([a-zA-Z0-9_-]+)([<>=!~]+.*)?$/);
      if (match) {
        deps[match[1]] = match[2] || '*';
      }
    }

    return deps;
  }

  private parsePyprojectToml(content: string): Record<string, string> {
    const deps: Record<string, string> = {};

    // Simple TOML parsing for dependencies
    const depsMatch = content.match(
      /\[(?:project\.)?dependencies\]([\s\S]*?)(?:\[|$)/
    );
    if (depsMatch) {
      const depsSection = depsMatch[1];
      const lines = depsSection.split('\n');

      for (const line of lines) {
        const match = line.match(/^\s*"?([a-zA-Z0-9_-]+)"?\s*[=:]/);
        if (match) {
          deps[match[1]] = '*';
        }
      }
    }

    return deps;
  }
}
