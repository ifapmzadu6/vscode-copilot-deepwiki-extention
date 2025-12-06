import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { DeepWikiSite, DeepWikiPage, PageSection } from '../types/deepwiki';
import { getIntermediateFileManager, IntermediateFileType, LLMHelper } from '../utils';
import { logger } from '../utils/logger';

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
 * Uses LLM extensively to validate and improve content quality
 */
export class DocumentQualityReviewerSubagent extends BaseSubagent {
  id = 'document-quality-reviewer';
  name = 'Document Quality Reviewer';
  description = 'Performs comprehensive LLM-based quality review of generated documentation';

  async execute(context: SubagentContext): Promise<QualityReport> {
    const { model, progress, token, previousResults } = context;
    const helper = new LLMHelper(model);

    progress('Starting comprehensive document quality review...');

    // Use output from FinalDocumentGenerator (ID: final-document-generator)
    const site = previousResults.get('final-document-generator') as DeepWikiSite;
    if (!site || !site.pages || site.pages.length === 0) {
      return this.createEmptyReport();
    }

    const pageReviews: PageReviewResult[] = [];

    // Review each page with auto-regeneration if score is low
    for (let i = 0; i < site.pages.length; i++) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      const page = site.pages[i];
      progress(`Reviewing page ${i + 1}/${site.pages.length}: ${page.title}`);

      const review = await this.reviewPage(helper, page, site, token);
      pageReviews.push(review);

      // If issues found, improve the content and re-review once
      if (review.issues.length > 0 && review.overallScore < 7) {
        progress(`Improving content for: ${page.title}`);
        const improvedSections = await this.improveSections(model, page, review, token);
        review.revisedSections = improvedSections;
        
        // Update the page in the site
        const pageIndex = site.pages.findIndex(p => p.id === page.id);
        if (pageIndex !== -1 && improvedSections.length > 0) {
          site.pages[pageIndex].sections = improvedSections;
        }

        // Re-review once after improvement
        const rereview = await this.reviewPage(helper, site.pages[pageIndex], site, token);
        pageReviews.push({
          ...rereview,
          pageId: `${page.id}-revised`,
          pageTitle: `${page.title} (revised)`,
          revisedSections: improvedSections,
        });
      }
    }

    // Generate overall report
    progress('Generating quality report...');
    const report = await this.generateReport(model, pageReviews, site, token);

    // Final consistency check
    progress('Final consistency check...');
    await this.performConsistencyCheck(model, site, token);

    progress('Quality review complete!');

    // Save report for downstream consumers
    try {
      const fileManager = getIntermediateFileManager();
      await fileManager.saveJson(IntermediateFileType.REVIEW_OVERALL, report);
    } catch {
      // ignore save errors
    }

    return { ...report, updatedSite: site };
  }

  /**
   * Review a single page comprehensively
   */
  private async reviewPage(
    helper: LLMHelper,
    page: DeepWikiPage,
    site: DeepWikiSite,
    token: vscode.CancellationToken
  ): Promise<PageReviewResult> {
    const pageContent = this.serializePage(page);

    const reviewPrompt = `Review this documentation page for quality. Be strict and thorough.

PAGE TITLE: ${page.title}
PAGE ID: ${page.id}

CONTENT:
${pageContent}

Evaluate on these criteria:
1. CONTENT QUALITY (1-10): Is the content informative, accurate, and valuable?
2. STRUCTURE (1-10): Is it well-organized with clear headings and flow?
3. COMPLETENESS (1-10): Does it cover the topic thoroughly?
4. CLARITY (1-10): Is it easy to understand?
5. TECHNICAL ACCURACY (1-10): Are technical details correct?

Respond with JSON:
{
  "overallScore": <1-10>,
  "scores": {
    "content": <1-10>,
    "structure": <1-10>,
    "completeness": <1-10>,
    "clarity": <1-10>,
    "accuracy": <1-10>
  },
  "issues": [
    {
      "sectionId": "section-id",
      "severity": "critical|major|minor",
      "type": "content|structure|accuracy|completeness|clarity",
      "description": "What's wrong",
      "suggestion": "How to fix it"
    }
  ],
  "improvements": ["Specific improvement suggestion 1", "..."],
  "strengths": ["What's good about this page"]
}`;

    try {
      const review = await helper.generateJsonStrict<{
        overallScore: number;
        issues: ReviewIssue[];
        improvements: string[];
      }>(reviewPrompt, {
        systemPrompt: 'You are a strict technical documentation reviewer. Be thorough and critical.',
      });

      return {
        pageId: page.id,
        pageTitle: page.title,
        overallScore: review ? review.overallScore || 5 : 5,
        issues: review ? review.issues || [] : [],
        improvements: review ? review.improvements || [] : [],
      };
    } catch {
      return {
        pageId: page.id,
        pageTitle: page.title,
        overallScore: 5,
        issues: [],
        improvements: [],
      };
    }
  }

  /**
   * Improve sections based on review feedback
   */
  private async improveSections(
    model: vscode.LanguageModelChat,
    page: DeepWikiPage,
    review: PageReviewResult,
    token: vscode.CancellationToken
  ): Promise<PageSection[]> {
    const improvedSections: PageSection[] = [];

    for (const section of page.sections) {
      const sectionIssues = review.issues.filter(i => i.sectionId === section.id);
      
      if (sectionIssues.length > 0 || review.overallScore < 6) {
        // Improve this section
        const improvePrompt = `Improve this documentation section based on the feedback.

SECTION TITLE: ${section.title}
SECTION ID: ${section.id}

CURRENT CONTENT:
${section.content}

ISSUES FOUND:
${sectionIssues.map(i => `- [${i.severity}] ${i.description}: ${i.suggestion}`).join('\n') || 'General quality improvement needed'}

GENERAL IMPROVEMENTS SUGGESTED:
${review.improvements.join('\n')}

Rewrite this section to:
1. Address all issues
2. Add more technical depth and detail
3. Include specific examples where appropriate
4. Add source code references if relevant
5. Improve clarity and readability
6. Make it more like DeepWiki.com quality (detailed, technical, with diagrams if needed)

Respond with the improved content ONLY (markdown format). If diagrams would help, include Mermaid diagrams.`;

        try {
          const improvedContent = await this.queryModel(
            model,
            'You are a technical documentation expert. Create high-quality, detailed documentation.',
            improvePrompt,
            token
          );

          improvedSections.push({
            ...section,
            content: improvedContent,
          });
        } catch {
          improvedSections.push(section);
        }
      } else {
        improvedSections.push(section);
      }
    }

    return improvedSections;
  }

  /**
   * Generate comprehensive quality report
   */
  private async generateReport(
    model: vscode.LanguageModelChat,
    pageReviews: PageReviewResult[],
    site: DeepWikiSite,
    token: vscode.CancellationToken
  ): Promise<QualityReport> {
    const avgScore = pageReviews.reduce((sum, r) => sum + r.overallScore, 0) / pageReviews.length;
    const allIssues = pageReviews.flatMap(r => r.issues);
    const criticalIssues = allIssues.filter(i => i.severity === 'critical');
    const majorIssues = allIssues.filter(i => i.severity === 'major');

    // Generate summary using LLM
    const summaryPrompt = `Generate a quality summary for this documentation.

PROJECT: ${site.projectName}
PAGES REVIEWED: ${pageReviews.length}
AVERAGE SCORE: ${avgScore.toFixed(1)}/10
CRITICAL ISSUES: ${criticalIssues.length}
MAJOR ISSUES: ${majorIssues.length}
TOTAL ISSUES: ${allIssues.length}

PAGE SCORES:
${pageReviews.map(r => `- ${r.pageTitle}: ${r.overallScore}/10 (${r.issues.length} issues)`).join('\n')}

Write a 2-3 paragraph summary of the documentation quality, highlighting:
1. Overall assessment
2. Key strengths
3. Areas needing improvement
4. Recommended next steps`;

    let summary = '';
    try {
      summary = await this.queryModel(
        model,
        'You are a documentation quality analyst.',
        summaryPrompt,
        token
      );
    } catch {
      summary = `Documentation quality score: ${avgScore.toFixed(1)}/10. Found ${allIssues.length} issues across ${pageReviews.length} pages.`;
    }

    // Sort issues by severity
    const topIssues = [...allIssues]
      .sort((a, b) => {
        const severityOrder = { critical: 0, major: 1, minor: 2 };
        return severityOrder[a.severity] - severityOrder[b.severity];
      })
      .slice(0, 10);

    return {
      overallScore: avgScore,
      pageReviews,
      summary,
      topIssues,
      recommendedActions: this.generateRecommendedActions(pageReviews, allIssues),
    };
  }

  /**
   * Perform final consistency check across all pages
   */
  private async performConsistencyCheck(
    model: vscode.LanguageModelChat,
    site: DeepWikiSite,
    token: vscode.CancellationToken
  ): Promise<void> {
    // Check for consistency in terminology, style, and cross-references
    const consistencyPrompt = `Check this documentation for consistency issues.

PROJECT: ${site.projectName}
PAGES: ${site.pages.map(p => p.title).join(', ')}

Check for:
1. Terminology consistency (same concepts use same names)
2. Style consistency (headings, formatting)
3. Cross-reference validity (links point to real pages)
4. Technical term consistency

List any consistency issues found (JSON array):
[{"issue": "description", "pages": ["affected pages"], "fix": "how to fix"}]`;

    try {
      const response = await this.queryModel(
        model,
        'You are a documentation consistency checker.',
        consistencyPrompt,
        token
      );

      // Log consistency issues but don't block
      logger.log('DocumentQualityReviewer', `Consistency check: ${response}`);
    } catch {
      // Ignore errors in consistency check
    }
  }

  /**
   * Serialize a page to string for review
   */
  private serializePage(page: DeepWikiPage): string {
    const lines: string[] = [];
    
    for (const section of page.sections) {
      lines.push(`## ${section.title}`);
      lines.push('');
      if (section.content) {
        lines.push(section.content);
        lines.push('');
      }
      if (section.diagrams?.length) {
        lines.push('[Has diagrams]');
      }
      if (section.tables?.length) {
        lines.push('[Has tables]');
      }
      if (section.codeExamples?.length) {
        lines.push('[Has code examples]');
      }
    }

    return lines.join('\n');
  }

  /**
   * Generate recommended actions based on issues
   */
  private generateRecommendedActions(
    reviews: PageReviewResult[],
    issues: ReviewIssue[]
  ): string[] {
    const actions: string[] = [];

    const criticalCount = issues.filter(i => i.severity === 'critical').length;
    const majorCount = issues.filter(i => i.severity === 'major').length;
    const lowScorePages = reviews.filter(r => r.overallScore < 6);

    if (criticalCount > 0) {
      actions.push(`Address ${criticalCount} critical issues immediately`);
    }

    if (majorCount > 0) {
      actions.push(`Review and fix ${majorCount} major issues`);
    }

    if (lowScorePages.length > 0) {
      actions.push(`Improve content quality for: ${lowScorePages.map(p => p.pageTitle).join(', ')}`);
    }

    // Type-specific recommendations
    const typeGroups = issues.reduce((acc, i) => {
      acc[i.type] = (acc[i.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    if (typeGroups['completeness'] > 3) {
      actions.push('Add more detailed content to incomplete sections');
    }

    if (typeGroups['clarity'] > 3) {
      actions.push('Improve clarity with better explanations and examples');
    }

    if (typeGroups['accuracy'] > 0) {
      actions.push('Verify technical accuracy of flagged sections');
    }

    return actions;
  }

  /**
   * Create empty report when no site is available
   */
  private createEmptyReport(): QualityReport {
    return {
      overallScore: 0,
      pageReviews: [],
      summary: 'No documentation to review.',
      topIssues: [],
      recommendedActions: ['Generate documentation first'],
    };
  }
}
