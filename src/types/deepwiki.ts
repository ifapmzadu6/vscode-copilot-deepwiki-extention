/**
 * Types for DeepWiki-style documentation generation
 * Based on https://deepwiki.com structure
 */

/**
 * Navigation item for sidebar
 */
export interface NavigationItem {
  id: string;
  title: string;
  path: string;
  order: number;
  children?: NavigationItem[];
}

/**
 * Source reference linking to code
 */
export interface SourceReference {
  file: string;
  startLine: number;
  endLine: number;
  url?: string; // GitHub URL if available
}

/**
 * A section within a page
 */
export interface PageSection {
  id: string;
  title: string;
  content: string;
  sources?: SourceReference[];
  diagrams?: string[]; // Mermaid diagrams
  tables?: TableData[];
  codeExamples?: CodeBlock[];
}

/**
 * Table data for documentation
 */
export interface TableData {
  headers: string[];
  rows: string[][];
  caption?: string;
}

/**
 * Code block with metadata
 */
export interface CodeBlock {
  language: string;
  code: string;
  title?: string;
  source?: SourceReference;
}

/**
 * A single documentation page
 */
export interface DeepWikiPage {
  id: string;
  title: string;
  slug: string;
  order: number;
  parent?: string;
  sections: PageSection[];
  relatedPages?: string[];
  sources?: SourceReference[];
}

/**
 * Complete DeepWiki site structure
 */
export interface DeepWikiSite {
  projectName: string;
  projectDescription: string;
  repositoryUrl?: string;
  generatedAt: string;
  navigation: NavigationItem[];
  pages: DeepWikiPage[];
  index: WikiIndex;
}

/**
 * Search index for the wiki
 */
export interface WikiIndex {
  files: IndexedFile[];
  symbols: IndexedSymbol[];
  keywords: string[];
}

/**
 * Indexed file for search
 */
export interface IndexedFile {
  path: string;
  description: string;
  language: string;
  pageId: string;
}

/**
 * Indexed symbol (class, function, etc.)
 */
export interface IndexedSymbol {
  name: string;
  type: 'class' | 'function' | 'interface' | 'type' | 'constant' | 'module';
  file: string;
  pageId: string;
  description: string;
}

/**
 * Standard page structure for DeepWiki
 */
export const DEEPWIKI_PAGE_STRUCTURE = {
  // Top-level sections
  OVERVIEW: {
    id: '1-overview',
    title: 'Overview',
    children: [
      { id: '1.1-architecture-overview', title: 'Architecture Overview' },
      { id: '1.2-package-structure', title: 'Package Structure' },
    ],
  },
  GETTING_STARTED: {
    id: '2-getting-started',
    title: 'Getting Started',
    children: [
      { id: '2.1-installation-and-setup', title: 'Installation and Setup' },
      { id: '2.2-configuration', title: 'Configuration' },
      { id: '2.3-basic-usage', title: 'Basic Usage' },
    ],
  },
  USER_GUIDE: {
    id: '3-user-guide',
    title: 'User Guide',
    children: [], // Dynamic based on features
  },
  CORE_SYSTEMS: {
    id: '4-core-systems',
    title: 'Core Systems',
    children: [], // Dynamic based on modules
  },
  ADVANCED_TOPICS: {
    id: '5-advanced-topics',
    title: 'Advanced Topics',
    children: [],
  },
  DEVELOPMENT: {
    id: '6-development',
    title: 'Development',
    children: [
      { id: '6.1-development-setup', title: 'Development Setup' },
      { id: '6.2-build-system', title: 'Build System' },
      { id: '6.3-testing', title: 'Testing' },
    ],
  },
  API_REFERENCE: {
    id: '7-api-reference',
    title: 'API Reference',
    children: [], // Dynamic based on exports
  },
} as const;

/**
 * Helper to generate source reference markdown
 */
export function formatSourceReference(ref: SourceReference): string {
  const lineRange = ref.startLine === ref.endLine 
    ? `L${ref.startLine}` 
    : `L${ref.startLine}-L${ref.endLine}`;
  
  if (ref.url) {
    return `[${ref.file} ${ref.startLine}-${ref.endLine}](${ref.url}#${lineRange})`;
  }
  return `\`${ref.file}:${ref.startLine}-${ref.endLine}\``;
}

/**
 * Helper to generate markdown table
 */
export function formatTable(table: TableData): string {
  const lines: string[] = [];
  
  // Header
  lines.push(`| ${table.headers.join(' | ')} |`);
  lines.push(`| ${table.headers.map(() => '---').join(' | ')} |`);
  
  // Rows
  for (const row of table.rows) {
    lines.push(`| ${row.join(' | ')} |`);
  }
  
  if (table.caption) {
    lines.push('');
    lines.push(`*${table.caption}*`);
  }
  
  return lines.join('\n');
}
