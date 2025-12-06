import * as vscode from 'vscode';
import * as path from 'path';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { ExtractionSummary, SourceReference } from '../types/extraction';
import { AccuracyIssue, AccuracyValidation } from '../types/validation';

/**
 * SourceReference 検証サブエージェント
 *
 * Level 6: QUALITY_REVIEW
 * 抽出結果に含まれる全 SourceReference が実在し、行番号が範囲内であることを検証する。
 */
export class SourceReferenceValidatorSubagent extends BaseSubagent {
  id = 'source-reference-validator';
  name = 'Source Reference Validator';
  description = 'Validates that all source references point to existing files and line ranges';

  async execute(context: SubagentContext): Promise<AccuracyValidation> {
    const { workspaceFolder, previousResults, progress, token } = context;

    progress('Validating source references...');

    const extraction = previousResults.get('code-extractor') as ExtractionSummary | undefined;
    if (!extraction) {
      return { score: 1, issues: [], verified: [], total: 0 };
    }

    const issues: AccuracyIssue[] = [];
    let verifiedCount = 0;
    let total = 0;

    const allRefs: Array<{ ref: SourceReference; context: string }> = [];

    const collect = (refs: SourceReference[], ctx: string) => {
      for (const ref of refs) {
        allRefs.push({ ref, context: ctx });
      }
    };

    collect(extraction.imports.map((i) => i.sourceRef), 'import');
    collect(extraction.exports.map((e) => e.sourceRef), 'export');
    collect(extraction.classes.map((c) => c.sourceRef), 'class');
    collect(extraction.functions.map((f) => f.sourceRef), 'function');
    collect(extraction.interfaces.map((i) => i.sourceRef), 'interface');
    collect(extraction.typeAliases.map((t) => t.sourceRef), 'type');
    collect(extraction.enums.map((e) => e.sourceRef), 'enum');
    collect(extraction.constants.map((c) => c.sourceRef), 'const');

    // Deduplicate identical refs
    const key = (r: SourceReference) => `${r.file}:${r.startLine}-${r.endLine ?? r.startLine}`;
    const seen = new Set<string>();
    const deduped = allRefs.filter(({ ref }) => {
      const k = key(ref);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    for (const { ref, context: ctx } of deduped) {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      total++;
      const abs = path.join(workspaceFolder.uri.fsPath, ref.file);
      try {
        const content = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
        const lines = Buffer.from(content).toString('utf-8').split('\n');
        const start = ref.startLine;
        const end = ref.endLine ?? ref.startLine;
        if (start < 1 || end > lines.length) {
          issues.push({
            severity: 'error',
            type: 'invalid-reference',
            location: { file: ref.file, line: start, element: ctx },
            message: `Line range out of bounds (${start}-${end} / ${lines.length})`,
            autoFixable: false,
          });
          continue;
        }
        verifiedCount++;
      } catch (error) {
        issues.push({
          severity: 'error',
          type: 'invalid-reference',
          location: { file: ref.file, element: ctx },
          message: `File not found or unreadable: ${ref.file}`,
          autoFixable: false,
        });
      }
    }

    const score = total > 0 ? verifiedCount / total : 1;
    progress(`Source reference validation: ${verifiedCount}/${total} valid`);

    return {
      score,
      issues,
      verified: [],
      total,
    };
  }
}
