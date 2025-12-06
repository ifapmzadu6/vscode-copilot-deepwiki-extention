import * as path from 'path';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { DeepWikiSite, DeepWikiPage } from '../types/deepwiki';
import { LLMHelper, getIntermediateFileManager } from '../utils';

/**
 * 品質結果に基づき対象ページを再生成し、ファイルにも書き戻す
 */
export class PageRegeneratorSubagent extends BaseSubagent {
  id = 'page-regenerator';
  name = 'Page Regenerator';
  description = 'Regenerates low-quality pages and writes updated files';

  async execute(context: SubagentContext): Promise<DeepWikiSite | null> {
    const { model, previousResults, progress, token } = context;
    const regenDecision = previousResults.get('regeneration-orchestrator') as {
      shouldRegenerate?: boolean;
      targets?: string[];
    } | undefined;
    const site = previousResults.get('final-document-generator') as DeepWikiSite | undefined;

    if (!regenDecision?.shouldRegenerate || !site) {
      return site || null;
    }

    const helper = new LLMHelper(model);
    const targets = regenDecision.targets || [];
    const updatedSite: DeepWikiSite = { ...site, pages: [...site.pages] };

    progress(`Regenerating ${targets.length} pages...`);

    for (const pageId of targets) {
      if (token.isCancellationRequested) throw new Error('Cancellation');
      const pageIndex = updatedSite.pages.findIndex((p) => p.id === pageId);
      if (pageIndex === -1) continue;
      const page = updatedSite.pages[pageIndex];

      const regeneratedSections = await this.regenerateSections(helper, page);
      if (!regeneratedSections) continue;

      const newPage: DeepWikiPage = {
        ...page,
        sections: regeneratedSections,
      };
      updatedSite.pages[pageIndex] = newPage;

      // Write to disk
      try {
        const fm = getIntermediateFileManager();
        await fm.saveFinalPage(`${page.slug}.md`, this.renderPageMarkdown(newPage));
      } catch {
        // ignore write errors
      }
    }

    return updatedSite;
  }

  /**
   * 単一ページをLLMで再生成（既存コンテンツを改善）
   */
  private async regenerateSections(helper: LLMHelper, page: DeepWikiPage): Promise<DeepWikiPage['sections'] | null> {
    const regenerated: DeepWikiPage['sections'] = [];
    for (const section of page.sections) {
      const prompt = `Improve this documentation section. Preserve technical accuracy, keep mermaid blocks if present, and add missing details.

Section Title: ${section.title}
Content:
${section.content}`;
      try {
        const improved = await helper.generate(prompt, {
          systemPrompt: 'You are a precise technical writer. Return clean Markdown content for the section only.',
        });
        regenerated.push({
          ...section,
          content: improved.trim(),
        });
      } catch {
        regenerated.push(section);
      }
    }
    return regenerated;
  }

  /**
   * 簡易 Markdown 生成（DeepWikiPage -> markdown）
   */
  private renderPageMarkdown(page: DeepWikiPage): string {
    const lines: string[] = [];
    lines.push(`# ${page.title}`);
    lines.push('');
    if (page.sections) {
      for (const section of page.sections) {
        lines.push(`## ${section.title}`);
        lines.push('');
        if (section.content) lines.push(section.content);
        if (section.diagrams) {
          for (const d of section.diagrams) {
            lines.push('```mermaid');
            lines.push(d);
            lines.push('```');
          }
        }
        lines.push('');
      }
    }
    return lines.join('\n');
  }
}
