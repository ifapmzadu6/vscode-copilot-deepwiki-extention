import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { logger } from '../utils/logger';
import { getIntermediateFileManager, IntermediateFileType } from '../utils/intermediateFileManager';

/**
 * 既存のドキュメント
 */
export interface ExistingDocument {
  path: string;
  title: string;
  content: string;
  category: 'architecture' | 'api' | 'guide' | 'spec' | 'product' | 'technical' | 'other';
  metadata: {
    createdAt?: string;
    updatedAt?: string;
    authors?: string[];
  };
}

/**
 * 既存ドキュメント分析結果
 */
export interface ExistingDocumentAnalysis {
  documents: ExistingDocument[];
  summary: {
    totalCount: number;
    byCategory: Record<string, number>;
    keyDocuments: string[];
  };
}

/**
 * 既存のMarkdownドキュメントを検索・分析するサブエージェント
 *
 * Level 1: DISCOVERY
 *
 * - docs/, doc/, documentation/ 配下のMarkdownファイルを検索
 * - 既存のREADME、技術ドキュメント、製品仕様書などを収集
 * - 後続のステージでこれらの情報を活用することで、より正確なドキュメントを生成
 */
export class ExistingDocumentAnalyzerSubagent extends BaseSubagent {
  id = 'existing-document-analyzer';
  name = 'Existing Document Analyzer';
  description = 'Analyzes existing documentation (Markdown, README, etc.)';

  async execute(context: SubagentContext): Promise<ExistingDocumentAnalysis> {
    const { workspaceFolder, progress } = context;
    const workspacePath = workspaceFolder.uri.fsPath;

    progress('Scanning for existing documentation...');

    // 既存のMarkdownファイルを検索
    const docFiles = await this.findDocumentationFiles(workspacePath);

    const documents: ExistingDocument[] = [];

    for (const file of docFiles) {
      try {
        const fullPath = path.join(workspacePath, file);
        const content = await fs.promises.readFile(fullPath, 'utf-8');

        const title = this.extractTitle(content, file);
        const category = this.categorizeDocument(file, content);

        documents.push({
          path: file,
          title,
          content,
          category,
          metadata: {},
        });

        logger.log(this.id, `Found document: ${file} (${category})`);
      } catch (error) {
        logger.error(this.id, `Failed to read ${file}:`, error);
      }
    }

    progress(`Found ${documents.length} existing documentation files`);

    // カテゴリ別集計
    const byCategory: Record<string, number> = {};
    for (const doc of documents) {
      byCategory[doc.category] = (byCategory[doc.category] || 0) + 1;
    }

    // 重要なドキュメントを特定
    const keyDocuments = this.identifyKeyDocuments(documents);

    const analysis: ExistingDocumentAnalysis = {
      documents,
      summary: {
        totalCount: documents.length,
        byCategory,
        keyDocuments,
      },
    };

    // 中間ファイルに保存
    const fileManager = getIntermediateFileManager();
    await fileManager.saveJson(
      IntermediateFileType.DISCOVERY_EXISTING_DOCS,
      analysis
    );

    logger.log(this.id, `Analysis complete: ${documents.length} documents found`);
    logger.log(this.id, `By category: ${JSON.stringify(byCategory)}`);
    logger.log(this.id, `Key documents: ${keyDocuments.join(', ')}`);

    return analysis;
  }

  /**
   * ドキュメントファイルを検索
   */
  private async findDocumentationFiles(workspacePath: string): Promise<string[]> {
    const files: string[] = [];

    // 検索対象のディレクトリパターン
    const searchPatterns = [
      'docs/**/*.md',
      'doc/**/*.md',
      'documentation/**/*.md',
      '*.md', // ルートのREADME.md等
    ];

    // 除外パターン
    const ignorePatterns = [
      '**/node_modules/**',
      '**/.deepwiki/**',
      '**/dist/**',
      '**/build/**',
      '**/out/**',
      '**/.git/**',
    ];

    const globby = require('globby');

    try {
      const foundFiles = await globby(searchPatterns, {
        cwd: workspacePath,
        ignore: ignorePatterns,
        absolute: false,
      });

      files.push(...foundFiles);
    } catch (error) {
      logger.error(this.id, 'Failed to search for documentation files:', error);
    }

    return files;
  }

  /**
   * Markdownファイルからタイトルを抽出
   */
  private extractTitle(content: string, filePath: string): string {
    // 最初の # ヘッダーを探す
    const match = content.match(/^#\s+(.+)$/m);
    if (match) {
      return match[1].trim();
    }

    // ファイル名から推測
    const fileName = path.basename(filePath, '.md');
    return fileName
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * ドキュメントのカテゴリを判定
   */
  private categorizeDocument(
    filePath: string,
    content: string
  ): ExistingDocument['category'] {
    const lowerPath = filePath.toLowerCase();
    const lowerContent = content.toLowerCase();

    // ファイル名ベースの判定
    if (
      lowerPath.includes('architecture') ||
      lowerPath.includes('design') ||
      lowerPath.includes('adr')
    ) {
      return 'architecture';
    }

    if (
      lowerPath.includes('api') ||
      lowerPath.includes('endpoint') ||
      lowerPath.includes('rest')
    ) {
      return 'api';
    }

    if (
      lowerPath.includes('guide') ||
      lowerPath.includes('tutorial') ||
      lowerPath.includes('how-to')
    ) {
      return 'guide';
    }

    if (
      lowerPath.includes('spec') ||
      lowerPath.includes('requirement') ||
      lowerPath.includes('rfc')
    ) {
      return 'spec';
    }

    if (
      lowerPath.includes('product') ||
      lowerPath.includes('plan') ||
      lowerPath.includes('roadmap')
    ) {
      return 'product';
    }

    if (
      lowerPath.includes('technical') ||
      lowerPath.includes('stack') ||
      lowerPath.includes('technology')
    ) {
      return 'technical';
    }

    // コンテンツベースの判定
    if (lowerContent.includes('api') && lowerContent.includes('endpoint')) {
      return 'api';
    }

    if (lowerContent.includes('architecture') && lowerContent.includes('component')) {
      return 'architecture';
    }

    return 'other';
  }

  /**
   * 重要なドキュメントを特定
   */
  private identifyKeyDocuments(documents: ExistingDocument[]): string[] {
    const keyDocs: string[] = [];

    // 優先度の高いドキュメント
    const priorityPatterns = [
      /readme\.md$/i,
      /architecture/i,
      /technical.*stack/i,
      /product.*plan/i,
      /api.*doc/i,
    ];

    for (const doc of documents) {
      for (const pattern of priorityPatterns) {
        if (pattern.test(doc.path)) {
          keyDocs.push(doc.path);
          break;
        }
      }
    }

    return keyDocs;
  }
}
