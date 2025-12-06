import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { DeepWikiSite, DeepWikiPage, PageSection } from '../types/deepwiki';
import {
  getIntermediateFileManager,
  IntermediateFileType,
  LLMHelper,
  logger,
} from '../utils';

/**
 * Quality review result for a page
 */
interface PageReviewResult {
  pageId: string;
  pageTitle: string;
  overallScore: number; // 1-10
  issues: ReviewIssue[];
  improvements: string[];
  revisedSections?: PageSection[];
}

/**
 * Issue found during review
 */
interface ReviewIssue {
  sectionId: string;
  severity: 'critical' | 'major' | 'minor';
  type: 'content' | 'structure' | 'accuracy' | 'completeness' | 'clarity';
  description: string;
  suggestion: string;
}

/**
 * Overall quality report
 */
interface QualityReport {
  overallScore: number;
  pageReviews: PageReviewResult[];
  summary: string;
  topIssues: ReviewIssue[];
  recommendedActions: string[];
  updatedSite?: DeepWikiSite;
}

/**
 * Subagent that performs comprehensive quality review of generated documentation
 * Output: Markdown reports
 */
export class DocumentQualityReviewerSubagent extends BaseSubagent {
  id = 'document-quality-reviewer';
  name = 'Document Quality Reviewer';
  description = 'Performs comprehensive quality review generating Markdown reports';

  async execute(context: SubagentContext): Promise<{
    overallScore: number;
    issuesFound: number;
    savedToFile: IntermediateFileType;
  }> {
    const { model, progress, token } = context;
    const helper = new LLMHelper(model);
    const fileManager = getIntermediateFileManager();

    progress('Starting comprehensive document quality review (Markdown)...');

    const site = await fileManager.loadJson<DeepWikiSite>(IntermediateFileType.OUTPUT_SITE_CONFIG);

    if (!site || !site.pages || site.pages.length === 0) {
      return {
        overallScore: 0,
        issuesFound: 0,
        savedToFile: IntermediateFileType.REVIEW_OVERALL,
      };
    }

    const pageReviews: PageReviewResult[] = [];

    // Review each page
    for (let i = 0; i < site.pages.length; i++) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      const page = site.pages[i];
      progress(`Reviewing page ${i + 1}/${site.pages.length}: ${page.title}`);

      const review = await this.reviewPage(helper, page, site, token);
      pageReviews.push(review);

      // Save page review as Markdown
      const reviewMd = this.renderPageReviewToMarkdown(review);
      await fileManager.saveMarkdown(IntermediateFileType.REVIEW_PAGE, reviewMd, page.slug);

      // Improvement logic (Control flow)
      if (review.issues.length > 0 && review.overallScore < 7) {
        progress(`Improving content for: ${page.title}`);
        const improvedSections = await this.improveSections(model, page, review, token);

        if (improvedSections.length > 0) {
          const pageIndex = site.pages.findIndex(p => p.id === page.id);
          if (pageIndex !== -1) {
            site.pages[pageIndex].sections = improvedSections;
          }
        }
      }
    }

    // Generate overall report
    progress('Generating quality report...');
    const report = await this.generateReport(model, pageReviews, site, token);

    progress('Quality review complete!');

    // Save overall report as Markdown
    const reportMd = this.renderOverallReportToMarkdown(report);
    await fileManager.saveMarkdown(IntermediateFileType.REVIEW_OVERALL, reportMd, 'overall');

    // Save updated site (JSON)
    await fileManager.saveJson(IntermediateFileType.OUTPUT_SITE_CONFIG, site);

    return {
      overallScore: report.overallScore,
      issuesFound: report.pageReviews.flatMap(r => r.issues).length,
      savedToFile: IntermediateFileType.REVIEW_OVERALL,
    };
  }

  private async reviewPage(
    helper: LLMHelper,
    page: DeepWikiPage,
    site: DeepWikiSite,
    token: vscode.CancellationToken
  ): Promise<PageReviewResult> {
    const pageContent = this.serializePage(page);

    // Try to load context (Analysis Markdown) if available
    // Look for analysis file matching the page slug or title
    let contextMd = '';
    try {
      // Simplistic approach: Try to find a class analysis file with the same name
      // In a real scenario, we'd have a map.
      // For now, let's just ask to check internal consistency if no context is found.
      // If we had the entity name, we could do:
      // contextMd = await this.fileManager.loadMarkdown(IntermediateFileType.ANALYSIS_CLASS, page.slug); 
    } catch { }

    const reviewPrompt = `Review this documentation page.
PAGE: ${page.title}
CONTENT:
${pageContent}

CONTEXT/REQUIREMENTS:
1. **Completeness**: Is the document well-structured with clear sections?
2. **Accuracy**: Does it reflect the actual code behavior? (Check for contradictions)
3. **Clarity**: Is it easy to read?

OUTPUT FORMAT:
Respond with a Markdown report.
---
# Review Report

## Score
<1-10>

## Issues
- [CRITICAL] <Description> | Suggestion: <Suggestion>
- [MINOR] <Description> | Suggestion: ...

## Improvements
- <Suggestion 1>
- <Suggestion 2>
---
`;

    try {
      const reviewMd = await helper.generate(reviewPrompt);
      const parsed = this.parseReviewMarkdown(reviewMd, page.id, page.title);
      return parsed;
    } catch (e) {
      logger.error('DocumentQualityReviewer', `Failed to review ${page.title}`, e);
      return {
        pageId: page.id,
        pageTitle: page.title,
        overallScore: 5,
        issues: [],
        improvements: [],
      };
    }
  }

  private parseReviewMarkdown(md: string, pageId: string, pageTitle: string): PageReviewResult {
    const lines = md.split('\n');
    let score = 5;
    const issues: ReviewIssue[] = [];
    const improvements: string[] = [];

    let section = '';

    for (const line of lines) {
      const l = line.trim();
      if (l.startsWith('## Score')) {
        section = 'score';
        continue;
      } else if (l.startsWith('## Issues')) {
        section = 'issues';
        continue;
      } else if (l.startsWith('## Improvements')) {
        section = 'improvements';
        continue;
      }

      if (section === 'score') {
        const match = l.match(/(\d+)/);
        if (match) score = parseInt(match[1]);
      } else if (section === 'issues') {
        if (l.startsWith('-')) {
          // - [CRITICAL] Desc | Suggestion: Sug
          const content = l.replace(/^-\s*/, '');
          const severityMatch = content.match(/^\[(CRITICAL|MAJOR|MINOR)\]/i);
          const severity = severityMatch ? severityMatch[1].toLowerCase() as any : 'minor';

          const parts = content.split('| Suggestion:');
          const description = parts[0].replace(/^\[.*?\]\s*/, '').trim();
          const suggestion = parts[1] ? parts[1].trim() : 'Fix it';

          issues.push({
            sectionId: 'unknown', // Hard to map back to exact section without line numbers
            severity,
            type: 'content',
            description,
            suggestion
          });
        }
      } else if (section === 'improvements') {
        if (l.startsWith('-')) {
          improvements.push(l.replace(/^-\s*/, '').trim());
        }
      }
    }

    return {
      pageId,
      pageTitle,
      overallScore: score,
      issues,
      improvements
    };
  }

  private async improveSections(
    model: vscode.LanguageModelChat,
    page: DeepWikiPage,
    review: PageReviewResult,
    token: vscode.CancellationToken
  ): Promise<PageSection[]> {
    const improvedSections: PageSection[] = [];
    const helper = new LLMHelper(model);

    for (const section of page.sections) {
      const issues = review.issues.filter(i => i.sectionId === section.id);
      if (issues.length > 0) {
        const improvePrompt = `Improve section "${section.title}" based on issues:
Issues:
${issues.map(i => `- ${i.description}: ${i.suggestion}`).join('\n')}

Content:
${section.content}

Return improved Markdown content only.`;
        try {
          const improved = await helper.generate(improvePrompt);
          improvedSections.push({ ...section, content: improved });
        } catch {
          improvedSections.push(section);
        }
      } else {
        improvedSections.push(section);
      }
    }
    return improvedSections;
  }

  private async generateReport(
    model: vscode.LanguageModelChat,
    pageReviews: PageReviewResult[],
    site: DeepWikiSite,
    token: vscode.CancellationToken
  ): Promise<QualityReport> {
    const avgScore = pageReviews.reduce((sum, r) => sum + r.overallScore, 0) / (pageReviews.length || 1);
    const allIssues = pageReviews.flatMap(r => r.issues);

    // Sort issues logic...
    const topIssues = allIssues.slice(0, 10); // Simplified

    return {
      overallScore: avgScore,
      pageReviews,
      summary: `Reviewed ${pageReviews.length} pages. Avg Score: ${avgScore.toFixed(1)}. Total Issues: ${allIssues.length}.`,
      topIssues,
      recommendedActions: [],
      updatedSite: site
    };
  }

  private serializePage(page: DeepWikiPage): string {
    return page.sections.map(s => `## ${s.title}\n${s.content.substring(0, 1000)}...`).join('\n');
  }

  private renderPageReviewToMarkdown(review: PageReviewResult): string {
    return `# Review: ${review.pageTitle}

**Validness Score:** ${review.overallScore}/10

## Issues
${review.issues.length === 0 ? 'No issues found.' : review.issues.map(i =>
      `- [${i.severity.toUpperCase()}] ${i.description}\n  Suggestion: ${i.suggestion}`
    ).join('\n')}

## Improvements
${review.improvements.map(s => `- ${s}`).join('\n')}
`;
  }

  private renderOverallReportToMarkdown(report: QualityReport): string {
    return `# Quality Report

**Overall Score:** ${report.overallScore.toFixed(1)}/10

## Summary
${report.summary}

## Page Reviews
${report.pageReviews.map(r =>
      `- **${r.pageTitle}**: ${r.overallScore}/10 (${r.issues.length} issues)`
    ).join('\n')}

## Top Issues
${report.topIssues.map(i => `- ${i.description}`).join('\n')}
`;
  }
}
