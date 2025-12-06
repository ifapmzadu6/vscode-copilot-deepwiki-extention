import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import {
  getIntermediateFileManager,
  IntermediateFileManager,
  IntermediateFileType,
  LLMHelper,
  LLMFeedbackLoop,
} from '../utils';
import {
  DeepWikiSite,
  DeepWikiPage,
  NavigationItem,
  PageSection,
} from '../types/deepwiki';
import * as path from 'path';

/**
 * 最終ドキュメント統合生成器
 * 
 * 中間ファイルから読み込み、最終的なDeepWikiドキュメントを生成
 * 
 * 入力:
 *   - .deepwiki/intermediate/analysis/*.json (依存関係、言語、フレームワーク)
 *   - .deepwiki/intermediate/summaries/*.summary.md (モジュールサマリー)
 *   - .deepwiki/intermediate/summaries/architecture.summary.md
 * 
 * 出力:
 *   - .deepwiki/pages/*.md (最終ドキュメント)
 *   - .deepwiki/_meta.json (ナビゲーション・メタデータ)
 */
export class FinalDocumentGeneratorSubagent extends BaseSubagent {
  id = 'final-document-generator';
  name = 'Final Document Generator';
  description = 'Generates final DeepWiki documentation from intermediate files';

  private helper!: LLMHelper;
  private feedbackLoop!: LLMFeedbackLoop;
  private fileManager!: IntermediateFileManager;

  async execute(context: SubagentContext): Promise<{
    pagesGenerated: number;
    siteConfigSaved: boolean;
    savedToFile: IntermediateFileType;
  }> {
    const { workspaceFolder, model, progress, token, previousResults } = context;

    progress('Loading intermediate files...');

    this.helper = new LLMHelper(model);
    this.feedbackLoop = new LLMFeedbackLoop(model, {
      maxIterations: 2,
      targetScore: 8,
    });
    this.fileManager = getIntermediateFileManager();

    // 1. 中間ファイルを読み込み
    const intermediateData = await this.loadIntermediateData();
    const projectName = path.basename(workspaceFolder.uri.fsPath);

    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    // 2. ページを生成
    const pages: DeepWikiPage[] = [];

    progress('Generating Overview page...');
    pages.push(await this.generateOverviewPage(projectName, intermediateData, token));

    progress('Generating Architecture page...');
    pages.push(await this.generateArchitecturePage(intermediateData, token));

    progress('Generating Getting Started pages...');
    pages.push(...await this.generateGettingStartedPages(intermediateData, token));

    progress('Generating Core Systems pages...');
    pages.push(...await this.generateCoreSystemsPages(intermediateData, token));

    progress('Generating Development pages...');
    pages.push(...await this.generateDevelopmentPages(intermediateData, token));

    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    // 3. 全体品質レビュー
    progress('Reviewing document quality...');
    await this.reviewAndImprovePages(pages, token);

    // 4. 最終ファイルを保存
    progress('Saving final documents...');
    await this.saveFinalDocuments(pages);

    // 5. ナビゲーション構築
    const navigation = this.buildNavigation(pages);

    const site: DeepWikiSite = {
      projectName: this.formatTitle(projectName),
      projectDescription: await this.generateProjectDescription(projectName, intermediateData),
      generatedAt: new Date().toISOString(),
      navigation,
      pages,
      index: this.buildSearchIndex(pages, intermediateData),
    };

    // Save site config
    await this.fileManager.saveJson(IntermediateFileType.OUTPUT_SITE_CONFIG, site);

    progress('Document generation complete!');

    return {
      pagesGenerated: pages.length,
      siteConfigSaved: true,
      savedToFile: IntermediateFileType.OUTPUT_SITE_CONFIG,
    };
  }

  /**
   * 中間ファイルを読み込み
   */
  private async loadIntermediateData(): Promise<IntermediateData> {
    const dependencies =
      (await this.fileManager.loadJson(IntermediateFileType.DEPENDENCIES)) || {};
    const languages =
      (await this.fileManager.loadJson(IntermediateFileType.DISCOVERY_LANGUAGES)) ||
      (await this.fileManager.loadJson(IntermediateFileType.LANGUAGES)) ||
      {};
    const frameworks =
      (await this.fileManager.loadJson(IntermediateFileType.DISCOVERY_FRAMEWORKS)) ||
      (await this.fileManager.loadJson(IntermediateFileType.FRAMEWORKS)) ||
      {};
    const fileList =
      (await this.fileManager.loadJson(IntermediateFileType.DISCOVERY_FILES)) ||
      (await this.fileManager.loadJson(IntermediateFileType.FILE_LIST)) ||
      {};
    const architecture =
      (await this.fileManager.loadMarkdown(IntermediateFileType.ARCHITECTURE_SUMMARY, 'architecture')) || '';

    // CHANGED: Load drafts from L5 instead of legacy summaries
    const moduleSummaries = await this.fileManager.loadAllPageDrafts();

    const callGraph = await this.fileManager.loadJson(IntermediateFileType.RELATIONSHIP_CALL_GRAPH);
    const dependencyGraph = await this.fileManager.loadJson(IntermediateFileType.RELATIONSHIP_DEPENDENCY_GRAPH);
    const inheritance = await this.fileManager.loadJson(IntermediateFileType.RELATIONSHIP_INHERITANCE);
    const crossRefs = await this.fileManager.loadJson(IntermediateFileType.RELATIONSHIP_CROSS_REFS);
    const moduleBoundaries = await this.fileManager.loadJson(IntermediateFileType.RELATIONSHIP_MODULES);
    const quality = await this.fileManager.loadJson(IntermediateFileType.REVIEW_OVERALL);
    const sourceRefs = await this.fileManager.loadJson(IntermediateFileType.REVIEW_SOURCE_REFS);

    return {
      dependencies,
      languages,
      frameworks,
      fileList,
      architecture,
      moduleSummaries,
      callGraph,
      dependencyGraph,
      inheritance,
      crossRefs,
      moduleBoundaries,
      quality,
      sourceRefs,
    };
  }

  /**
   * Overview ページを生成
   */
  private async generateOverviewPage(
    projectName: string,
    data: IntermediateData,
    token: vscode.CancellationToken
  ): Promise<DeepWikiPage> {
    const title = this.formatTitle(projectName);

    // LLMでPurpose and Scopeを生成
    const purposePrompt = `Write a "Purpose and Scope" section for the ${title} project documentation.

Project Information:
- Primary Language: ${data.languages?.primary || 'Unknown'}
- Languages: ${data.languages?.all?.join(', ') || 'Unknown'}
- Frameworks: ${data.frameworks?.frameworks?.join(', ') || 'None'}
- Total Files: ${data.fileList?.totalFiles || 0}

Module Summaries Available:
${Array.from(data.moduleSummaries?.keys() || []).slice(0, 5).join(', ')}

Write 2-3 professional paragraphs explaining:
1. What this project is and what it does
2. Its main purpose and target use cases
3. High-level overview of its capabilities`;

    const purposeContent = await this.helper.generate(purposePrompt, {
      systemPrompt: 'You are a technical documentation expert. Write clear, professional documentation.',
    });

    // LLMでアーキテクチャ図を生成
    const diagramPrompt = `Create a Mermaid flowchart showing the high-level architecture of the ${title} project.

Information:
- Languages: ${data.languages?.all?.join(', ')}
- Frameworks: ${data.frameworks?.frameworks?.join(', ')}
- Modules: ${Array.from(data.moduleSummaries?.keys() || []).join(', ')}

Create a clear diagram with:
- Main components/layers as nodes
- Data flow arrows
- Proper styling

Output ONLY the Mermaid code (no markdown code blocks).`;

    let architectureDiagram = '';
    try {
      const diagramResponse = await this.helper.generate(diagramPrompt);
      // Extract mermaid code
      const match = diagramResponse.match(/```mermaid\n([\s\S]*?)```/) ||
        diagramResponse.match(/(flowchart[\s\S]*)/);
      architectureDiagram = match ? match[1].trim() : diagramResponse.trim();
    } catch {
      // Skip diagram on error
    }

    // Key Technologies テーブル
    const technologiesTable = this.generateTechnologiesTable(data);

    const sections: PageSection[] = [
      {
        id: 'purpose-and-scope',
        title: 'Purpose and Scope',
        content: purposeContent,
      },
      {
        id: 'what-is-project',
        title: `What is ${title}`,
        content: this.generateWhatIsSection(title, data),
        diagrams: architectureDiagram ? [architectureDiagram] : undefined,
      },
      {
        id: 'key-technologies',
        title: 'Key Technologies',
        content: '',
        tables: [technologiesTable],
      },
    ];

    return {
      id: '1-overview',
      title: 'Overview',
      slug: 'overview',
      order: 1,
      sections,
      relatedPages: ['1.1-architecture-overview', '2-getting-started'],
    };
  }

  /**
   * Architecture ページを生成（中間サマリーを活用）
   */
  private async generateArchitecturePage(
    data: IntermediateData,
    token: vscode.CancellationToken
  ): Promise<DeepWikiPage> {
    const sections: PageSection[] = [];

    // 中間ファイルのアーキテクチャサマリーを使用（なければLLM生成）
    if (data.architecture) {
      sections.push({
        id: 'architecture-overview',
        title: 'Architecture Overview',
        content: data.architecture,
      });
    } else {
      const archPrompt = `Generate an architecture overview for this project.

Languages: ${data.languages?.all?.join(', ')}
Frameworks: ${data.frameworks?.frameworks?.join(', ')}
Modules: ${Array.from(data.moduleSummaries?.keys() || []).join(', ')}

Write about:
1. Overall system architecture
2. How components are organized
3. Key design patterns used`;

      const archContent = await this.helper.generate(archPrompt);
      sections.push({
        id: 'architecture-overview',
        title: 'Architecture Overview',
        content: archContent,
      });
    }

    // 依存グラフをMermaid化
    const depDiagram = this.renderDependencyDiagram(data);
    if (depDiagram) {
      sections.push({
        id: 'dependency-graph',
        title: 'Dependency Graph',
        content: '',
        diagrams: [depDiagram],
      });
    }

    // Call graph をMermaid化
    const callDiagram = this.renderCallDiagram(data);
    if (callDiagram) {
      sections.push({
        id: 'call-graph',
        title: 'Call Graph',
        content: '',
        diagrams: [callDiagram],
      });
    }

    // 継承ツリー
    const inheritanceDiagram = this.renderInheritanceDiagram(data);
    if (inheritanceDiagram) {
      sections.push({
        id: 'inheritance',
        title: 'Inheritance',
        content: '',
        diagrams: [inheritanceDiagram],
      });
    }

    // モジュール関係図を生成
    const modules = Array.from(data.moduleSummaries?.keys() || []);
    if (modules.length > 0) {
      const moduleDiagramPrompt = `Create a Mermaid flowchart showing module relationships.

Modules: ${modules.join(', ')}

Show:
- Each module as a node
- Dependencies between modules
- Group related modules

Output ONLY Mermaid code.`;

      try {
        const diagramResponse = await this.helper.generate(moduleDiagramPrompt);
        const match = diagramResponse.match(/```mermaid\n([\s\S]*?)```/) ||
          diagramResponse.match(/(flowchart[\s\S]*)/);
        if (match) {
          sections.push({
            id: 'module-structure',
            title: 'Module Structure',
            content: 'The following diagram shows how modules relate to each other:',
            diagrams: [match[1].trim()],
          });
        }
      } catch {
        // Skip on error
      }
    }

    // ディレクトリ構造
    if (data.fileList?.byDirectory) {
      const dirs = Object.keys(data.fileList.byDirectory).slice(0, 15);
      sections.push({
        id: 'directory-structure',
        title: 'Directory Structure',
        content: '```\n' + dirs.map(d => `├── ${d}/`).join('\n') + '\n```',
      });
    }

    // Module boundaries summary
    const moduleBoundarySection = this.renderModuleBoundaries(data);
    if (moduleBoundarySection) {
      sections.push(moduleBoundarySection);
    }

    return {
      id: '1.1-architecture-overview',
      title: 'Architecture Overview',
      slug: 'architecture-overview',
      order: 1.1,
      parent: '1-overview',
      sections,
      relatedPages: ['1-overview', '4-core-systems'],
    };
  }

  /**
   * Getting Started ページを生成
   */
  private async generateGettingStartedPages(
    data: IntermediateData,
    token: vscode.CancellationToken
  ): Promise<DeepWikiPage[]> {
    const pages: DeepWikiPage[] = [];
    const primaryLang = data.languages?.primary || 'Unknown';
    const frameworks = data.frameworks?.frameworks || [];

    // Index page
    pages.push({
      id: '2-getting-started',
      title: 'Getting Started',
      slug: 'getting-started',
      order: 2,
      sections: [{
        id: 'getting-started-intro',
        title: 'Introduction',
        content: await this.generateGettingStartedIntro(primaryLang, frameworks),
      }],
      relatedPages: ['2.1-installation', '2.2-configuration'],
    });

    // Installation page
    const installContent = await this.generateInstallationContent(primaryLang, frameworks, data);
    pages.push({
      id: '2.1-installation',
      title: 'Installation',
      slug: 'installation',
      order: 2.1,
      parent: '2-getting-started',
      sections: [{
        id: 'installation-steps',
        title: 'Installation Steps',
        content: installContent,
      }],
      relatedPages: ['2-getting-started', '2.2-configuration'],
    });

    // Configuration page
    pages.push({
      id: '2.2-configuration',
      title: 'Configuration',
      slug: 'configuration',
      order: 2.2,
      parent: '2-getting-started',
      sections: [{
        id: 'configuration-overview',
        title: 'Configuration',
        content: await this.generateConfigurationContent(primaryLang, frameworks, data),
      }],
      relatedPages: ['2.1-installation', '3-core-systems'],
    });

    return pages;
  }

  /**
   * Core Systems ページを生成（モジュールサマリーを活用）
   */
  private async generateCoreSystemsPages(
    data: IntermediateData,
    token: vscode.CancellationToken
  ): Promise<DeepWikiPage[]> {
    const pages: DeepWikiPage[] = [];
    const moduleSummaries = data.moduleSummaries || new Map();
    const moduleBoundaries = data.moduleBoundaries?.modules || [];

    // Index page
    const moduleList = Array.from(moduleSummaries.keys());

    const indexContent = moduleList.length > 0
      ? `This section covers the core systems and modules of the project.\n\n**Modules:**\n\n${moduleList.map(m => `- [${m}](${m.toLowerCase()})`).join('\n')}`
      : 'This section covers the core systems of the project.';

    pages.push({
      id: '4-core-systems',
      title: 'Core Systems',
      slug: 'core-systems',
      order: 4,
      sections: [{
        id: 'core-systems-overview',
        title: 'Overview',
        content: indexContent,
      }],
      relatedPages: moduleList.slice(0, 5).map((m, i) => `4.${i + 1}-${m.toLowerCase()}`),
    });

    // 各モジュールのページ（中間サマリーを使用）
    let moduleIndex = 1;
    for (const [moduleName, summaryContent] of moduleSummaries) {
      if (token.isCancellationRequested) break;

      const pageId = `4.${moduleIndex}-${moduleName.toLowerCase().replace(/\s+/g, '-')}`;
      const boundary = moduleBoundaries.find((m: any) => m.name === moduleName);

      // 中間サマリーを直接使用
      let content = summaryContent;

      // サマリーが短すぎる場合はLLMで補強
      if (content.length < 500) {
        const enhancePrompt = `Enhance this module documentation:

${content}

Add more details about:
1. Key classes/functions
2. Usage examples
3. How it integrates with other modules

Keep the existing content and add to it.`;

        try {
          content = await this.helper.generate(enhancePrompt);
        } catch {
          // Keep original on error
        }
      }

      const sections = [
        {
          id: 'module-content',
          title: moduleName,
          content,
        },
      ];

      if (boundary) {
        sections.push({
          id: 'module-api',
          title: 'Exports',
          content:
            boundary.exports?.map((e: any) => `- \`${e.name}\` (${e.type}) [${e.sourceRef.file}:${e.sourceRef.startLine}]()`).join('\n') ||
            'No exports detected.',
        });
      }

      pages.push({
        id: pageId,
        title: moduleName,
        slug: moduleName.toLowerCase().replace(/\s+/g, '-'),
        order: 4 + moduleIndex * 0.1,
        parent: '4-core-systems',
        sections,
        relatedPages: ['4-core-systems'],
      });

      moduleIndex++;
      if (moduleIndex > 10) break; // 最大10モジュール
    }

    return pages;
  }

  /**
   * Development ページを生成
   */
  private async generateDevelopmentPages(
    data: IntermediateData,
    token: vscode.CancellationToken
  ): Promise<DeepWikiPage[]> {
    const pages: DeepWikiPage[] = [];
    const primaryLang = data.languages?.primary || 'Unknown';

    // Development index
    pages.push({
      id: '5-development',
      title: 'Development',
      slug: 'development',
      order: 5,
      sections: [{
        id: 'development-overview',
        title: 'Development Guide',
        content: await this.generateDevelopmentOverview(primaryLang, data),
      }],
      relatedPages: ['5.1-setup', '5.2-testing'],
    });

    // Setup page
    pages.push({
      id: '5.1-setup',
      title: 'Development Setup',
      slug: 'development-setup',
      order: 5.1,
      parent: '5-development',
      sections: [{
        id: 'dev-setup',
        title: 'Setting Up Development Environment',
        content: await this.generateDevSetupContent(primaryLang, data),
      }],
      relatedPages: ['5-development', '5.2-testing'],
    });

    // Testing page
    pages.push({
      id: '5.2-testing',
      title: 'Testing',
      slug: 'testing',
      order: 5.2,
      parent: '5-development',
      sections: [{
        id: 'testing-guide',
        title: 'Testing Guide',
        content: await this.generateTestingContent(primaryLang, data),
      }],
      relatedPages: ['5-development', '5.1-setup'],
    });

    return pages;
  }

  /**
   * ページ品質をレビューして改善
   */
  private async reviewAndImprovePages(pages: DeepWikiPage[], token: vscode.CancellationToken): Promise<void> {
    for (const page of pages) {
      if (token.isCancellationRequested) break;

      for (const section of page.sections) {
        // 短すぎるセクションを検出
        if (section.content.length < 200) {
          const reviewPrompt = `This documentation section is too brief. Enhance it:

Title: ${section.title}
Current Content:
${section.content}

Make it more comprehensive with:
- More details
- Examples where appropriate
- Clear explanations`;

          try {
            const improved = await this.helper.generate(reviewPrompt);
            section.content = improved;
          } catch {
            // Keep original on error
          }
        }
      }
    }
  }

  /**
   * 最終ドキュメントを保存
   */
  private async saveFinalDocuments(pages: DeepWikiPage[]): Promise<void> {
    // Filter related pages to existing ids
    const pageIds = new Set(pages.map((p) => p.id));
    for (const page of pages) {
      if (page.relatedPages) {
        page.relatedPages = page.relatedPages.filter((r) => pageIds.has(r));
      }
    }

    for (const page of pages) {
      let content = `# ${page.title}\n\n`;

      for (const section of page.sections) {
        // Skip header if matches page title
        if (!(page.sections.length === 1 && section.title === page.title)) {
          content += `## ${section.title}\n\n`;
        }

        let sectionContent = section.content;
        sectionContent = sectionContent.replace(/^#\s+.*$/m, '').trim();

        content += sectionContent + '\n\n';

        if (section.diagrams?.length) {
          for (const diagram of section.diagrams) {
            content += '```mermaid\n' + diagram + '\n```\n\n';
          }
        }

        if (section.tables?.length) {
          for (const table of section.tables) {
            content += this.formatTable(table) + '\n\n';
          }
        }
      }

      await this.fileManager.saveFinalPage(`${page.slug}.md`, content);
    }

    // メタデータを保存
    const meta = {
      pages: pages.map(p => ({
        id: p.id,
        title: p.title,
        slug: p.slug,
        order: p.order,
        parent: p.parent,
      })),
      generatedAt: new Date().toISOString(),
    };

    await this.fileManager.saveFinalPage('_meta.json', JSON.stringify(meta, null, 2));
  }

  // ===============================
  // Helper methods
  // ===============================

  private formatTitle(name: string): string {
    return name.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  private generateWhatIsSection(title: string, data: IntermediateData): string {
    const parts: string[] = [];
    parts.push(`**${title}** is a ${data.languages?.primary || 'software'} project`);

    if (data.frameworks?.frameworks?.length) {
      parts.push(`built with ${data.frameworks.frameworks.join(', ')}`);
    }

    return parts.join(' ') + '.';
  }

  private generateTechnologiesTable(data: IntermediateData): any {
    const rows: string[][] = [];

    if (data.languages?.all?.length) {
      rows.push(['Languages', data.languages.all.join(', '), '-']);
    }
    if (data.frameworks?.frameworks?.length) {
      rows.push(['Frameworks', data.frameworks.frameworks.join(', '), '-']);
    }
    if (data.dependencies?.packageManager) {
      rows.push(['Package Manager', data.dependencies.packageManager, '-']);
    }

    return {
      headers: ['Technology', 'Details', 'Notes'],
      rows,
    };
  }

  /**
   * Mermaid dependency diagram from relationship graph
   */
  private renderDependencyDiagram(data: IntermediateData): string | null {
    const graph = data.dependencyGraph;
    if (!graph || !graph.edges || graph.edges.length === 0) return null;

    const lines: string[] = ['flowchart LR'];
    for (const edge of graph.edges.slice(0, 80)) {
      const from = this.sanitizeNode(edge.from);
      const to = this.sanitizeNode(edge.to);
      lines.push(`  ${from} --> ${to}`);
    }
    return lines.join('\n');
  }

  private renderCallDiagram(data: IntermediateData): string | null {
    const cg = data.callGraph;
    if (!cg || !cg.edges || cg.edges.length === 0) return null;
    const lines: string[] = ['flowchart LR'];
    for (const edge of cg.edges.slice(0, 80)) {
      const from = this.sanitizeNode(edge.from);
      const to = this.sanitizeNode(edge.to);
      lines.push(`  ${from} --> ${to}`);
    }
    return lines.join('\n');
  }

  private renderInheritanceDiagram(data: IntermediateData): string | null {
    const inh = data.inheritance;
    if (!inh || !inh.edges || inh.edges.length === 0) return null;
    const lines: string[] = ['classDiagram'];
    for (const edge of inh.edges.slice(0, 80)) {
      const from = this.sanitizeNode(edge.from);
      const to = this.sanitizeNode(edge.to);
      const arrow = edge.type === 'implements' ? '..|>' : '--|>';
      lines.push(`  ${from} ${arrow} ${to}`);
    }
    return lines.join('\n');
  }

  private sanitizeNode(id: string): string {
    return id.replace(/[^a-zA-Z0-9_]/g, '_').slice(-50) || 'node';
  }

  private renderModuleBoundaries(data: IntermediateData): PageSection | null {
    if (!data.moduleBoundaries?.modules?.length) return null;
    const rows = data.moduleBoundaries.modules.slice(0, 30).map((m: any) => {
      const deps = (m.internalDependencies || []).join(', ') || 'None';
      return `- **${m.name}** (${m.files.length} files) — deps: ${deps}`;
    });
    return {
      id: 'module-boundaries',
      title: 'Module Boundaries',
      content: rows.join('\n'),
    };
  }

  private formatTable(table: any): string {
    if (!table.headers || !table.rows) return '';

    let md = '| ' + table.headers.join(' | ') + ' |\n';
    md += '| ' + table.headers.map(() => '---').join(' | ') + ' |\n';
    for (const row of table.rows) {
      md += '| ' + row.join(' | ') + ' |\n';
    }
    return md;
  }

  private buildNavigation(pages: DeepWikiPage[]): NavigationItem[] {
    const navigation: NavigationItem[] = [];
    const topLevel = pages.filter(p => !p.parent).sort((a, b) => a.order - b.order);

    for (const page of topLevel) {
      const navItem: NavigationItem = {
        id: page.id,
        title: page.title,
        path: `${page.slug}.md`,
        order: page.order,
        children: [],
      };

      const children = pages
        .filter(p => p.parent === page.id)
        .sort((a, b) => a.order - b.order);

      for (const child of children) {
        navItem.children!.push({
          id: child.id,
          title: child.title,
          path: `${child.slug}.md`,
          order: child.order,
        });
      }

      navigation.push(navItem);
    }

    return navigation;
  }

  private buildSearchIndex(pages: DeepWikiPage[], data: IntermediateData) {
    const files =
      data.fileList?.files?.slice(0, 200).map((f: any) => ({
        path: f.relativePath,
        language: f.language,
        description: '',
        pageId: '1-overview',
      })) || [];

    const symbols: any[] = [];
    if (data.crossRefs?.byEntity) {
      for (const [entityId, ref] of Object.entries(data.crossRefs.byEntity as Record<string, any>)) {
        symbols.push({
          id: entityId,
          name: ref.definition?.name,
          file: ref.definition?.file,
          sourceRef: ref.definition?.sourceRef,
          usedAt: ref.usages?.length || 0,
        });
      }
    }

    const keywords = pages
      .flatMap(p => [p.title, ...p.sections.map(s => s.title)])
      .map(k => k.toLowerCase());

    return { files, symbols, keywords };
  }

  // Content generators
  private async generateGettingStartedIntro(lang: string, frameworks: string[]): Promise<string> {
    return this.helper.generate(`Write a brief introduction for the "Getting Started" section of documentation for a ${lang} project using ${frameworks.join(', ')}. 2-3 paragraphs.`);
  }

  private async generateInstallationContent(lang: string, frameworks: string[], data: IntermediateData): Promise<string> {
    const pm = data.dependencies?.packageManager || 'npm';
    return this.helper.generate(`Write installation instructions for a ${lang} project using ${frameworks.join(', ')} with ${pm}. Include prerequisites, installation commands, and verification steps.`);
  }

  private async generateConfigurationContent(lang: string, frameworks: string[], data: IntermediateData): Promise<string> {
    return this.helper.generate(`Write configuration documentation for a ${lang} project. Explain common configuration options and how to customize the project.`);
  }

  private async generateDevelopmentOverview(lang: string, data: IntermediateData): Promise<string> {
    return this.helper.generate(`Write a development guide overview for a ${lang} project. Include information about development workflow, best practices, and contribution guidelines.`);
  }

  private async generateDevSetupContent(lang: string, data: IntermediateData): Promise<string> {
    return this.helper.generate(`Write development environment setup instructions for a ${lang} project. Include IDE setup, required tools, and environment configuration.`);
  }

  private async generateTestingContent(lang: string, data: IntermediateData): Promise<string> {
    return this.helper.generate(`Write testing documentation for a ${lang} project. Include how to run tests, write new tests, and testing best practices.`);
  }

  private async generateProjectDescription(name: string, data: IntermediateData): Promise<string> {
    return this.helper.generate(`Write a one-sentence description for a ${data.languages?.primary || ''} project named "${name}".`);
  }
}

/**
 * 中間データの型定義
 */
interface IntermediateData {
  dependencies: any;
  languages: any;
  frameworks: any;
  fileList: any;
  architecture: string;
  moduleSummaries: Map<string, string>;
  callGraph?: any;
  dependencyGraph?: any;
  inheritance?: any;
  crossRefs?: any;
  moduleBoundaries?: any;
  quality?: any;
  sourceRefs?: any;
}
