import * as vscode from 'vscode';
import * as path from 'path';
import { logger } from './logger';

/**
 * 中間ファイルの種類（7レベル対応）
 */
export enum IntermediateFileType {
  // ===========================================
  // Level 1: DISCOVERY - ファイル発見・基本情報
  // ===========================================
  DISCOVERY_FILES = 'discovery-files',
  DISCOVERY_FRAMEWORKS = 'discovery-frameworks',
  DISCOVERY_LANGUAGES = 'discovery-languages',
  DISCOVERY_ENTRY_POINTS = 'discovery-entry-points',
  DISCOVERY_CONFIGS = 'discovery-configs',

  // ===========================================
  // Level 2: CODE_EXTRACTION - 行番号付き抽出
  // ===========================================
  EXTRACTION_AST = 'extraction-ast',
  EXTRACTION_CLASSES = 'extraction-classes',
  EXTRACTION_FUNCTIONS = 'extraction-functions',
  EXTRACTION_INTERFACES = 'extraction-interfaces',
  EXTRACTION_TYPES = 'extraction-types',
  EXTRACTION_ENUMS = 'extraction-enums',
  EXTRACTION_CONSTANTS = 'extraction-constants',
  EXTRACTION_IMPORTS = 'extraction-imports',
  EXTRACTION_EXPORTS = 'extraction-exports',
  EXTRACTION_FILE = 'extraction-file', // 個別ファイルの抽出結果
  EXTRACTION_SUMMARY = 'extraction-summary', // 全体のサマリー
  EXTRACTION_BY_FILE = 'extraction-by-file', // ファイルごとの抽出結果（キャッシュ用）

  // ===========================================
  // Level 3: DEEP_ANALYSIS - LLM分析
  // ===========================================
  ANALYSIS_CLASS = 'analysis-class',
  ANALYSIS_FUNCTION = 'analysis-function',
  ANALYSIS_MODULE = 'analysis-module',
  ANALYSIS_ARCHITECTURE = 'analysis-architecture',
  ANALYSIS_PATTERNS = 'analysis-patterns',
  ANALYSIS_COMPLEXITY = 'analysis-complexity',

  // ===========================================
  // Level 4: RELATIONSHIP - 関係構築
  // ===========================================
  RELATIONSHIP_DEPENDENCY_GRAPH = 'relationship-dependency-graph',
  RELATIONSHIP_CALL_GRAPH = 'relationship-call-graph',
  RELATIONSHIP_INHERITANCE = 'relationship-inheritance',
  RELATIONSHIP_MODULES = 'relationship-modules',
  RELATIONSHIP_CROSS_REFS = 'relationship-cross-refs',

  // ===========================================
  // Level 5: DOCUMENTATION - ドキュメント生成
  // ===========================================
  DOCS_PAGE_DRAFT = 'docs-page-draft',
  DOCS_PAGE_REVIEWED = 'docs-page-reviewed',
  DOCS_DIAGRAM = 'docs-diagram',

  // ===========================================
  // Level 6: QUALITY_REVIEW - 品質レビュー
  // ===========================================
  REVIEW_SOURCE_REFS = 'review-source-refs',
  REVIEW_COMPLETENESS = 'review-completeness',
  REVIEW_ACCURACY = 'review-accuracy',
  REVIEW_CONSISTENCY = 'review-consistency',
  REVIEW_LINKS = 'review-links',
  REVIEW_OVERALL = 'review-overall',
  REVIEW_PAGE = 'review-page', // ページごとのレビュー

  // ===========================================
  // Level 7: OUTPUT - 最終出力
  // ===========================================
  OUTPUT_PAGE = 'output-page',
  OUTPUT_META = 'output-meta',
  OUTPUT_SEARCH_INDEX = 'output-search-index',
  OUTPUT_SITE_CONFIG = 'output-site-config',

  // レガシー互換性
  FILE_LIST = 'file-list',
  DEPENDENCIES = 'dependencies',
  FRAMEWORKS = 'frameworks',
  ARCHITECTURE = 'architecture',
  LANGUAGES = 'languages',
  MODULE_ANALYSIS = 'module-analysis',
  FUNCTION_ANALYSIS = 'function-analysis',
  CLASS_ANALYSIS = 'class-analysis',
  TYPE_ANALYSIS = 'type-analysis',
  MODULE_SUMMARY = 'module-summary',
  ARCHITECTURE_SUMMARY = 'architecture-summary',
  API_SUMMARY = 'api-summary',
  REVIEW_RESULT = 'review-result',
  IMPROVEMENT_PLAN = 'improvement-plan',
  FINAL_PAGE = 'final-page',
}

/**
 * ファイルの種類
 */
export type FileFormat = 'json' | 'markdown' | 'mermaid';

/**
 * 中間ファイルのメタデータ
 */
export interface IntermediateFileMeta {
  type: IntermediateFileType;
  name: string;
  createdAt: string;
  version: number;
  level: number; // パイプラインレベル (1-7)
  dependencies?: string[];
  llmAnalyzed?: boolean;
  llmScore?: number;
  llmIterations?: number;
}

/**
 * 中間ファイルのコンテンツ（JSON用）
 */
export interface IntermediateFileContent<T = unknown> {
  meta: IntermediateFileMeta;
  data: T;
}

/**
 * ディレクトリ構造の定義
 */
const DIRECTORY_STRUCTURE = {
  // Level 1
  discovery: 'intermediate/discovery',
  // Level 2
  extraction: 'intermediate/extraction',
  extractionAst: 'intermediate/extraction/ast',
  // Level 3
  analysisClasses: 'intermediate/analysis/classes',
  analysisFunctions: 'intermediate/analysis/functions',
  analysisModules: 'intermediate/analysis/modules',
  analysisGeneral: 'intermediate/analysis',
  // Level 4
  relationships: 'intermediate/relationships',
  // Level 5
  docsPages: 'intermediate/docs/pages',
  docsDiagrams: 'intermediate/docs/diagrams',
  // Level 6
  review: 'intermediate/review',
  reviewPages: 'intermediate/review/pages',
  // Level 7
  outputPages: 'pages',
  output: '',
} as const;

/**
 * 中間ファイル管理クラス（7レベル対応版）
 *
 * ディレクトリ構造:
 * .deepwiki/
 * ├── intermediate/
 * │   ├── discovery/              # Level 1
 * │   │   ├── files.json
 * │   │   ├── frameworks.json
 * │   │   ├── languages.json
 * │   │   ├── entry-points.json
 * │   │   └── configs.json
 * │   ├── extraction/             # Level 2
 * │   │   ├── ast/{file-hash}.json
 * │   │   ├── classes.json
 * │   │   ├── functions.json
 * │   │   ├── interfaces.json
 * │   │   ├── types.json
 * │   │   ├── imports.json
 * │   │   └── exports.json
 * │   ├── analysis/               # Level 3
 * │   │   ├── classes/{ClassName}.json
 * │   │   ├── functions/{functionName}.json
 * │   │   ├── modules/{moduleName}.json
 * │   │   ├── architecture.json
 * │   │   ├── patterns.json
 * │   │   └── complexity.json
 * │   ├── relationships/          # Level 4
 * │   │   ├── dependency-graph.json
 * │   │   ├── call-graph.json
 * │   │   ├── inheritance.json
 * │   │   ├── modules.json
 * │   │   └── cross-refs.json
 * │   ├── docs/                   # Level 5
 * │   │   ├── pages/{page-id}.draft.md
 * │   │   ├── pages/{page-id}.reviewed.md
 * │   │   └── diagrams/*.mermaid
 * │   └── review/                 # Level 6
 * │       ├── source-refs.json
 * │       ├── completeness.json
 * │       ├── accuracy.json
 * │       ├── consistency.json
 * │       ├── overall.json
 * │       └── pages/{page-id}.review.json
 * ├── pages/                      # Level 7 (最終出力)
 * │   ├── _meta.json
 * │   ├── 1-overview.md
 * │   └── ...
 * ├── deepwiki.json
 * └── search-index.json
 */
export class IntermediateFileManager {
  private workspaceFolder: vscode.Uri;
  private baseDir: string;

  constructor(workspaceFolder: vscode.Uri, outputDir?: string) {
    this.workspaceFolder = workspaceFolder;
    this.baseDir = path.isAbsolute(outputDir || '')
      ? (outputDir as string)
      : path.join(workspaceFolder.fsPath, outputDir || '.deepwiki');
  }

  // ===========================================
  // パス解決
  // ===========================================

  /**
   * 中間ファイルのパスを取得
   */
  getFilePath(type: IntermediateFileType, name?: string): string {
    const { dir, fileName } = this.resolveLocation(type, name);
    return path.join(this.baseDir, dir, fileName);
  }

  /**
   * 最終出力ファイルのパスを取得
   */
  getOutputPath(fileName: string): string {
    return path.join(this.baseDir, 'pages', fileName);
  }

  /**
   * ファイルタイプとディレクトリを解決
   */
  private resolveLocation(
    type: IntermediateFileType,
    name?: string
  ): { dir: string; fileName: string; format: FileFormat } {
    const baseName = name || type;

    switch (type) {
      // Level 1: Discovery
      case IntermediateFileType.DISCOVERY_FILES:
        return { dir: DIRECTORY_STRUCTURE.discovery, fileName: 'files.json', format: 'json' };
      case IntermediateFileType.DISCOVERY_FRAMEWORKS:
        return { dir: DIRECTORY_STRUCTURE.discovery, fileName: 'frameworks.json', format: 'json' };
      case IntermediateFileType.DISCOVERY_LANGUAGES:
        return { dir: DIRECTORY_STRUCTURE.discovery, fileName: 'languages.json', format: 'json' };
      case IntermediateFileType.DISCOVERY_ENTRY_POINTS:
        return { dir: DIRECTORY_STRUCTURE.discovery, fileName: 'entry-points.json', format: 'json' };
      case IntermediateFileType.DISCOVERY_CONFIGS:
        return { dir: DIRECTORY_STRUCTURE.discovery, fileName: 'configs.json', format: 'json' };

      // Level 2: Extraction
      case IntermediateFileType.EXTRACTION_AST:
        return { dir: DIRECTORY_STRUCTURE.extractionAst, fileName: `${baseName}.json`, format: 'json' };
      case IntermediateFileType.EXTRACTION_CLASSES:
        return { dir: DIRECTORY_STRUCTURE.extraction, fileName: 'classes.json', format: 'json' };
      case IntermediateFileType.EXTRACTION_FUNCTIONS:
        return { dir: DIRECTORY_STRUCTURE.extraction, fileName: 'functions.json', format: 'json' };
      case IntermediateFileType.EXTRACTION_INTERFACES:
        return { dir: DIRECTORY_STRUCTURE.extraction, fileName: 'interfaces.json', format: 'json' };
      case IntermediateFileType.EXTRACTION_TYPES:
        return { dir: DIRECTORY_STRUCTURE.extraction, fileName: 'types.json', format: 'json' };
      case IntermediateFileType.EXTRACTION_ENUMS:
        return { dir: DIRECTORY_STRUCTURE.extraction, fileName: 'enums.json', format: 'json' };
      case IntermediateFileType.EXTRACTION_CONSTANTS:
        return { dir: DIRECTORY_STRUCTURE.extraction, fileName: 'constants.json', format: 'json' };
      case IntermediateFileType.EXTRACTION_IMPORTS:
        return { dir: DIRECTORY_STRUCTURE.extraction, fileName: 'imports.json', format: 'json' };
      case IntermediateFileType.EXTRACTION_EXPORTS:
        return { dir: DIRECTORY_STRUCTURE.extraction, fileName: 'exports.json', format: 'json' };
      case IntermediateFileType.EXTRACTION_FILE:
        return { dir: DIRECTORY_STRUCTURE.extraction, fileName: `${baseName}.json`, format: 'json' };

      // Level 3: Analysis
      case IntermediateFileType.ANALYSIS_CLASS:
        return { dir: DIRECTORY_STRUCTURE.analysisClasses, fileName: `${baseName}.json`, format: 'json' };
      case IntermediateFileType.ANALYSIS_FUNCTION:
        return { dir: DIRECTORY_STRUCTURE.analysisFunctions, fileName: `${baseName}.json`, format: 'json' };
      case IntermediateFileType.ANALYSIS_MODULE:
        return { dir: DIRECTORY_STRUCTURE.analysisModules, fileName: `${baseName}.json`, format: 'json' };
      case IntermediateFileType.ANALYSIS_ARCHITECTURE:
        return { dir: DIRECTORY_STRUCTURE.analysisGeneral, fileName: 'architecture.json', format: 'json' };
      case IntermediateFileType.ANALYSIS_PATTERNS:
        return { dir: DIRECTORY_STRUCTURE.analysisGeneral, fileName: 'patterns.json', format: 'json' };
      case IntermediateFileType.ANALYSIS_COMPLEXITY:
        return { dir: DIRECTORY_STRUCTURE.analysisGeneral, fileName: 'complexity.json', format: 'json' };

      // Level 4: Relationships
      case IntermediateFileType.RELATIONSHIP_DEPENDENCY_GRAPH:
        return { dir: DIRECTORY_STRUCTURE.relationships, fileName: 'dependency-graph.json', format: 'json' };
      case IntermediateFileType.RELATIONSHIP_CALL_GRAPH:
        return { dir: DIRECTORY_STRUCTURE.relationships, fileName: 'call-graph.json', format: 'json' };
      case IntermediateFileType.RELATIONSHIP_INHERITANCE:
        return { dir: DIRECTORY_STRUCTURE.relationships, fileName: 'inheritance.json', format: 'json' };
      case IntermediateFileType.RELATIONSHIP_MODULES:
        return { dir: DIRECTORY_STRUCTURE.relationships, fileName: 'modules.json', format: 'json' };
      case IntermediateFileType.RELATIONSHIP_CROSS_REFS:
        return { dir: DIRECTORY_STRUCTURE.relationships, fileName: 'cross-refs.json', format: 'json' };

      // Level 5: Documentation
      case IntermediateFileType.DOCS_PAGE_DRAFT:
        return { dir: DIRECTORY_STRUCTURE.docsPages, fileName: `${baseName}.draft.md`, format: 'markdown' };
      case IntermediateFileType.DOCS_PAGE_REVIEWED:
        return { dir: DIRECTORY_STRUCTURE.docsPages, fileName: `${baseName}.reviewed.md`, format: 'markdown' };
      case IntermediateFileType.DOCS_DIAGRAM:
        return { dir: DIRECTORY_STRUCTURE.docsDiagrams, fileName: `${baseName}.mermaid`, format: 'mermaid' };

      // Level 6: Review
      case IntermediateFileType.REVIEW_SOURCE_REFS:
        return { dir: DIRECTORY_STRUCTURE.review, fileName: 'source-refs.json', format: 'json' };
      case IntermediateFileType.REVIEW_COMPLETENESS:
        return { dir: DIRECTORY_STRUCTURE.review, fileName: 'completeness.json', format: 'json' };
      case IntermediateFileType.REVIEW_ACCURACY:
        return { dir: DIRECTORY_STRUCTURE.review, fileName: 'accuracy.json', format: 'json' };
      case IntermediateFileType.REVIEW_CONSISTENCY:
        return { dir: DIRECTORY_STRUCTURE.review, fileName: 'consistency.json', format: 'json' };
      case IntermediateFileType.REVIEW_LINKS:
        return { dir: DIRECTORY_STRUCTURE.review, fileName: 'links.json', format: 'json' };
      case IntermediateFileType.REVIEW_OVERALL:
        return { dir: DIRECTORY_STRUCTURE.review, fileName: 'overall.json', format: 'json' };
      case IntermediateFileType.REVIEW_PAGE:
        return { dir: DIRECTORY_STRUCTURE.reviewPages, fileName: `${baseName}.review.json`, format: 'json' };

      // Level 7: Output
      case IntermediateFileType.OUTPUT_PAGE:
        return { dir: DIRECTORY_STRUCTURE.outputPages, fileName: `${baseName}.md`, format: 'markdown' };
      case IntermediateFileType.OUTPUT_META:
        return { dir: DIRECTORY_STRUCTURE.outputPages, fileName: '_meta.json', format: 'json' };
      case IntermediateFileType.OUTPUT_SEARCH_INDEX:
        return { dir: DIRECTORY_STRUCTURE.output, fileName: 'search-index.json', format: 'json' };
      case IntermediateFileType.OUTPUT_SITE_CONFIG:
        return { dir: DIRECTORY_STRUCTURE.output, fileName: 'deepwiki.json', format: 'json' };

      // レガシー互換性
      case IntermediateFileType.FILE_LIST:
        return { dir: 'intermediate/analysis', fileName: 'file-list.json', format: 'json' };
      case IntermediateFileType.DEPENDENCIES:
        return { dir: 'intermediate/analysis', fileName: 'dependencies.json', format: 'json' };
      case IntermediateFileType.FRAMEWORKS:
        return { dir: 'intermediate/analysis', fileName: 'frameworks.json', format: 'json' };
      case IntermediateFileType.LANGUAGES:
        return { dir: 'intermediate/analysis', fileName: 'languages.json', format: 'json' };
      case IntermediateFileType.ARCHITECTURE:
        return { dir: 'intermediate/analysis', fileName: 'architecture.json', format: 'json' };
      case IntermediateFileType.MODULE_ANALYSIS:
        return { dir: 'intermediate/modules', fileName: `${baseName}.json`, format: 'json' };
      case IntermediateFileType.FUNCTION_ANALYSIS:
        return { dir: 'intermediate/modules', fileName: `${baseName}.json`, format: 'json' };
      case IntermediateFileType.CLASS_ANALYSIS:
        return { dir: 'intermediate/modules', fileName: `${baseName}.json`, format: 'json' };
      case IntermediateFileType.TYPE_ANALYSIS:
        return { dir: 'intermediate/modules', fileName: `${baseName}.json`, format: 'json' };
      case IntermediateFileType.MODULE_SUMMARY:
        return { dir: 'intermediate/summaries', fileName: `${baseName}.summary.md`, format: 'markdown' };
      case IntermediateFileType.ARCHITECTURE_SUMMARY:
        return { dir: 'intermediate/summaries', fileName: `${baseName}.summary.md`, format: 'markdown' };
      case IntermediateFileType.API_SUMMARY:
        return { dir: 'intermediate/summaries', fileName: `${baseName}.summary.md`, format: 'markdown' };
      case IntermediateFileType.REVIEW_RESULT:
        return { dir: 'intermediate/reviews', fileName: `${baseName}.json`, format: 'json' };
      case IntermediateFileType.IMPROVEMENT_PLAN:
        return { dir: 'intermediate/reviews', fileName: 'improvement-plan.json', format: 'json' };
      case IntermediateFileType.FINAL_PAGE:
        return { dir: 'pages', fileName: `${baseName}.md`, format: 'markdown' };

      default:
        return { dir: 'intermediate/misc', fileName: `${baseName}.json`, format: 'json' };
    }
  }

  /**
   * パイプラインレベルを取得
   */
  private getLevel(type: IntermediateFileType): number {
    if (type.startsWith('discovery-')) return 1;
    if (type.startsWith('extraction-')) return 2;
    if (type.startsWith('analysis-')) return 3;
    if (type.startsWith('relationship-')) return 4;
    if (type.startsWith('docs-')) return 5;
    if (type.startsWith('review-')) return 6;
    if (type.startsWith('output-')) return 7;
    return 0; // レガシー
  }

  // ===========================================
  // 保存・読み込み
  // ===========================================

  /**
   * JSONファイルを保存
   */
  async saveJson<T>(
    type: IntermediateFileType,
    data: T,
    name?: string,
    options?: {
      dependencies?: string[];
      llmAnalyzed?: boolean;
      llmScore?: number;
      llmIterations?: number;
    }
  ): Promise<string> {
    const filePath = this.getFilePath(type, name);
    const content: IntermediateFileContent<T> = {
      meta: {
        type,
        name: name || type,
        createdAt: new Date().toISOString(),
        version: 1,
        level: this.getLevel(type),
        dependencies: options?.dependencies,
        llmAnalyzed: options?.llmAnalyzed,
        llmScore: options?.llmScore,
        llmIterations: options?.llmIterations,
      },
      data,
    };

    await this.ensureDirectory(path.dirname(filePath));
    const uri = vscode.Uri.file(filePath);
    const jsonContent = JSON.stringify(content, null, 2);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(jsonContent, 'utf-8'));

    logger.log('IntermediateFileManager', `Saved: ${filePath}`);
    return filePath;
  }

  /**
   * JSONファイルを読み込み
   */
  async loadJson<T>(type: IntermediateFileType, name?: string): Promise<T | null> {
    const filePath = this.getFilePath(type, name);
    const exists = await this.pathExists(filePath);
    if (!exists) {
      return null;
    }

    try {
      const uri = vscode.Uri.file(filePath);
      const content = await vscode.workspace.fs.readFile(uri);
      const parsed: IntermediateFileContent<T> = JSON.parse(Buffer.from(content).toString('utf-8'));
      return parsed.data;
    } catch (error) {
      logger.log('IntermediateFileManager', `File not found or invalid: ${filePath}`);
      return null;
    }
  }

  /**
   * JSONファイルとメタデータを読み込み
   */
  async loadJsonWithMeta<T>(
    type: IntermediateFileType,
    name?: string
  ): Promise<IntermediateFileContent<T> | null> {
    const filePath = this.getFilePath(type, name);
    const exists = await this.pathExists(filePath);
    if (!exists) {
      return null;
    }

    try {
      const uri = vscode.Uri.file(filePath);
      const content = await vscode.workspace.fs.readFile(uri);
      return JSON.parse(Buffer.from(content).toString('utf-8'));
    } catch (error) {
      return null;
    }
  }

  /**
   * Markdownファイルを保存
   */
  async saveMarkdown(type: IntermediateFileType, content: string, name?: string): Promise<string> {
    const filePath = this.getFilePath(type, name);

    await this.ensureDirectory(path.dirname(filePath));
    const uri = vscode.Uri.file(filePath);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));

    logger.log('IntermediateFileManager', `Saved: ${filePath}`);
    return filePath;
  }

  /**
   * Markdownファイルを読み込み
   */
  async loadMarkdown(type: IntermediateFileType, name?: string): Promise<string | null> {
    const filePath = this.getFilePath(type, name);

    try {
      const uri = vscode.Uri.file(filePath);
      const content = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(content).toString('utf-8');
    } catch (error) {
      logger.log('IntermediateFileManager', `File not found: ${filePath}`);
      return null;
    }
  }

  /**
   * 最終出力ファイルを保存
   */
  async saveFinalPage(fileName: string, content: string): Promise<string> {
    const filePath = this.getOutputPath(fileName);

    await this.ensureDirectory(path.dirname(filePath));
    const uri = vscode.Uri.file(filePath);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));

    logger.log('IntermediateFileManager', `Saved final page: ${filePath}`);
    return filePath;
  }

  // ===========================================
  // バッチ操作
  // ===========================================

  /**
   * 特定タイプの全ファイルを一覧
   */
  async listFiles(type: IntermediateFileType): Promise<string[]> {
    const { dir } = this.resolveLocation(type);
    const dirPath = path.join(this.baseDir, dir);

    const exists = await this.pathExists(dirPath);
    if (!exists) return [];

    try {
      const uri = vscode.Uri.file(dirPath);
      const entries = await vscode.workspace.fs.readDirectory(uri);
      return entries.filter(([_, fileType]) => fileType === vscode.FileType.File).map(([name]) => name);
    } catch (error) {
      return [];
    }
  }

  /**
   * Level 3: 全クラス分析を読み込み
   */
  async loadAllClassAnalyses<T>(): Promise<Map<string, T>> {
    return this.loadAllFromDirectory<T>(DIRECTORY_STRUCTURE.analysisClasses);
  }

  /**
   * Level 3: 全関数分析を読み込み
   */
  async loadAllFunctionAnalyses<T>(): Promise<Map<string, T>> {
    return this.loadAllFromDirectory<T>(DIRECTORY_STRUCTURE.analysisFunctions);
  }

  /**
   * Level 3: 全モジュール分析を読み込み
   */
  async loadAllModuleAnalyses<T>(): Promise<Map<string, T>> {
    return this.loadAllFromDirectory<T>(DIRECTORY_STRUCTURE.analysisModules);
  }

  /**
   * Level 5: 全ドキュメントドラフトを読み込み
   */
  async loadAllPageDrafts(): Promise<Map<string, string>> {
    const drafts = new Map<string, string>();
    const files = await this.listFilesInDirectory(DIRECTORY_STRUCTURE.docsPages);

    for (const file of files) {
      if (file.endsWith('.draft.md')) {
        const pageId = file.replace('.draft.md', '');
        const filePath = path.join(this.baseDir, DIRECTORY_STRUCTURE.docsPages, file);
        try {
          const uri = vscode.Uri.file(filePath);
          const content = await vscode.workspace.fs.readFile(uri);
          drafts.set(pageId, Buffer.from(content).toString('utf-8'));
        } catch (error) {
          // Skip files that can't be read
        }
      }
    }

    return drafts;
  }

  /**
   * ディレクトリ内の全JSONを読み込み
   */
  private async loadAllFromDirectory<T>(dirRelPath: string): Promise<Map<string, T>> {
    const results = new Map<string, T>();
    const dirPath = path.join(this.baseDir, dirRelPath);

    const exists = await this.pathExists(dirPath);
    if (!exists) {
      return results;
    }

    try {
      const uri = vscode.Uri.file(dirPath);
      const entries = await vscode.workspace.fs.readDirectory(uri);

      for (const [fileName, fileType] of entries) {
        if (fileType === vscode.FileType.File && fileName.endsWith('.json')) {
          const name = fileName.replace('.json', '');
          const filePath = path.join(dirPath, fileName);
          try {
            const fileUri = vscode.Uri.file(filePath);
            const content = await vscode.workspace.fs.readFile(fileUri);
            const parsed: IntermediateFileContent<T> = JSON.parse(Buffer.from(content).toString('utf-8'));
            results.set(name, parsed.data);
          } catch (error) {
            // Skip invalid files
          }
        }
      }
    } catch {
      // Directory unreadable; ignore
    }

    return results;
  }

  /**
   * ディレクトリ内のファイル一覧
   */
  private async listFilesInDirectory(dirRelPath: string): Promise<string[]> {
    const dirPath = path.join(this.baseDir, dirRelPath);
    const exists = await this.pathExists(dirPath);
    if (!exists) {
      return [];
    }

    try {
      const uri = vscode.Uri.file(dirPath);
      const entries = await vscode.workspace.fs.readDirectory(uri);
      return entries.filter(([_, fileType]) => fileType === vscode.FileType.File).map(([name]) => name);
    } catch (error) {
      return [];
    }
  }

  // ===========================================
  // レガシー互換性
  // ===========================================

  /**
   * 全モジュールのサマリーを読み込み（レガシー）
   */
  async loadAllModuleSummaries(): Promise<Map<string, string>> {
    const summaries = new Map<string, string>();
    const files = await this.listFiles(IntermediateFileType.MODULE_SUMMARY);

    for (const file of files) {
      if (file.endsWith('.summary.md')) {
        const moduleName = file.replace('.summary.md', '');
        const content = await this.loadMarkdown(IntermediateFileType.MODULE_SUMMARY, moduleName);
        if (content) {
          summaries.set(moduleName, content);
        }
      }
    }

    return summaries;
  }

  // ===========================================
  // ユーティリティ
  // ===========================================

  /**
   * ディレクトリを作成
   */
  private async ensureDirectory(dirPath: string): Promise<void> {
    try {
      const uri = vscode.Uri.file(dirPath);
      await vscode.workspace.fs.createDirectory(uri);
    } catch (error) {
      // ディレクトリが既に存在する場合は無視
    }
  }

  /**
   * Check if a path exists to avoid noisy read errors.
   */
  private async pathExists(fsPath: string): Promise<boolean> {
    try {
      const uri = vscode.Uri.file(fsPath);
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 特定レベルの中間ファイルをクリア
   */
  async clearLevel(level: number): Promise<void> {
    const levelDirs: Record<number, string[]> = {
      1: [DIRECTORY_STRUCTURE.discovery],
      2: [DIRECTORY_STRUCTURE.extraction],
      3: [
        DIRECTORY_STRUCTURE.analysisClasses,
        DIRECTORY_STRUCTURE.analysisFunctions,
        DIRECTORY_STRUCTURE.analysisModules,
        DIRECTORY_STRUCTURE.analysisGeneral,
      ],
      4: [DIRECTORY_STRUCTURE.relationships],
      5: [DIRECTORY_STRUCTURE.docsPages, DIRECTORY_STRUCTURE.docsDiagrams],
      6: [DIRECTORY_STRUCTURE.review, DIRECTORY_STRUCTURE.reviewPages],
      7: [DIRECTORY_STRUCTURE.outputPages],
    };

    const dirs = levelDirs[level] || [];
    for (const dir of dirs) {
      const fullPath = path.join(this.baseDir, dir);
      try {
        const uri = vscode.Uri.file(fullPath);
        await vscode.workspace.fs.delete(uri, { recursive: true });
        logger.log('IntermediateFileManager', `Cleared level ${level}: ${dir}`);
      } catch (error) {
        // ディレクトリが存在しない場合は無視
      }
    }
  }

  /**
   * 中間ファイルをクリア
   */
  async clearIntermediate(): Promise<void> {
    const intermediatePath = path.join(this.baseDir, 'intermediate');
    try {
      const uri = vscode.Uri.file(intermediatePath);
      await vscode.workspace.fs.delete(uri, { recursive: true });
      logger.log('IntermediateFileManager', 'Cleared intermediate files');
    } catch (error) {
      // ディレクトリが存在しない場合は無視
    }
  }

  /**
   * 全体をクリア
   */
  async clearAll(): Promise<void> {
    try {
      const uri = vscode.Uri.file(this.baseDir);
      await vscode.workspace.fs.delete(uri, { recursive: true });
      logger.log('IntermediateFileManager', 'Cleared all files');
    } catch (error) {
      // ディレクトリが存在しない場合は無視
    }
  }

  /**
   * 統計情報を取得
   */
  async getStats(): Promise<{
    byLevel: Record<number, number>;
    totalFiles: number;
    totalSize: number;
  }> {
    const stats = {
      byLevel: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 } as Record<number, number>,
      totalFiles: 0,
      totalSize: 0,
    };

    // TODO: Implement actual stats collection
    return stats;
  }
}

/**
 * グローバルインスタンスを取得するためのファクトリ
 */
let managerInstance: IntermediateFileManager | null = null;

export function getIntermediateFileManager(workspaceFolder?: vscode.Uri): IntermediateFileManager {
  if (!managerInstance && workspaceFolder) {
    managerInstance = new IntermediateFileManager(workspaceFolder);
  }
  if (!managerInstance) {
    throw new Error('IntermediateFileManager not initialized');
  }
  return managerInstance;
}

export function initIntermediateFileManager(
  workspaceFolder: vscode.Uri,
  outputDir?: string
): IntermediateFileManager {
  managerInstance = new IntermediateFileManager(workspaceFolder, outputDir);
  return managerInstance;
}
