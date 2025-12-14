import { JSDOM } from 'jsdom';

export interface MermaidValidationError {
  startLine: number; // 1-based line number of the opening ```mermaid fence
  message: string;
}

type MermaidAPI = {
  initialize: (config: { startOnLoad: boolean; securityLevel: 'strict' | 'loose' | 'antiscript' }) => void;
  parse: (code: string) => Promise<unknown> | unknown;
};

let mermaidPromise: Promise<MermaidAPI> | undefined;

async function getMermaid(): Promise<MermaidAPI> {
  if (!mermaidPromise) {
    mermaidPromise = (async () => {
      const dom = new JSDOM('<!doctype html><html><body></body></html>');
      const g = globalThis as unknown as { window?: unknown; document?: unknown; navigator?: unknown };
      g.window = dom.window;
      g.document = dom.window.document;
      g.navigator = dom.window.navigator;

      const mermaidModule = await import('mermaid');
      const mermaidUnknown = (mermaidModule as { default?: unknown }).default ?? (mermaidModule as unknown);
      const mermaid = mermaidUnknown as MermaidAPI;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
      return mermaid;
    })();
  }
  return mermaidPromise;
}

function extractMermaidBlocks(markdown: string): Array<{ code: string; startLine: number }> {
  const lines = markdown.split(/\r?\n/);
  const blocks: Array<{ code: string; startLine: number }> = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```(?:mermaid)\s*$/i.test(line)) {
      const startLine = i + 1;
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ code: codeLines.join('\n'), startLine });
    }
    i++;
  }

  return blocks;
}

export async function validateMermaidMarkdown(markdown: string): Promise<MermaidValidationError[]> {
  const mermaid = await getMermaid();
  const blocks = extractMermaidBlocks(markdown);
  const errors: MermaidValidationError[] = [];

  for (const block of blocks) {
    const code = block.code.trim();
    if (code === '') continue;
    try {
      await mermaid.parse(code);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ startLine: block.startLine, message });
    }
  }

  return errors;
}
