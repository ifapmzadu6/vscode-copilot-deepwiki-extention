import * as vscode from 'vscode';

/**
 * Input parameters for the DeepWiki tool
 */
export interface IDeepWikiParameters {
  outputPath?: string;
  includePrivate?: boolean;
  maxDepth?: number;
}

/**
 * Represents a file in the workspace
 */
export interface WorkspaceFile {
  uri: vscode.Uri;
  relativePath: string;
  language: string;
  size: number;
}

/**
 * Result from analyzing workspace structure
 */
export interface WorkspaceStructure {
  rootPath: string;
  files: WorkspaceFile[];
  directories: string[];
  entryPoints: string[];
  configFiles: string[];
}

/**
 * Result from analyzing dependencies
 */
export interface DependencyAnalysis {
  packageManager: string | null;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  frameworks: string[];
  languages: string[];
}

/**
 * Result from analyzing architecture
 */
export interface ArchitectureAnalysis {
  patterns: string[];
  modules: ModuleInfo[];
  entryPoints: string[];
  layers: string[];
}

/**
 * Information about a module/component
 */
export interface ModuleInfo {
  name: string;
  path: string;
  type: 'module' | 'component' | 'service' | 'utility' | 'config' | 'test' | 'other';
  description: string;
  exports: string[];
  imports: string[];
}

/**
 * Result from analyzing a specific file
 */
export interface FileAnalysis {
  path: string;
  summary: string;
  exports: ExportInfo[];
  imports: ImportInfo[];
  classes: ClassInfo[];
  functions: FunctionInfo[];
}

/**
 * Export information
 */
export interface ExportInfo {
  name: string;
  type: 'class' | 'function' | 'const' | 'interface' | 'type' | 'default';
  isPublic: boolean;
}

/**
 * Import information
 */
export interface ImportInfo {
  source: string;
  names: string[];
  isExternal: boolean;
}

/**
 * Class information
 */
export interface ClassInfo {
  name: string;
  description: string;
  methods: string[];
  properties: string[];
  isExported: boolean;
}

/**
 * Function information
 */
export interface FunctionInfo {
  name: string;
  description: string;
  parameters: string[];
  returnType: string;
  isExported: boolean;
  isAsync: boolean;
}

/**
 * Collection of Mermaid diagrams for visualization
 */
export interface DiagramCollection {
  architectureOverview: string;
  moduleDependencies: string;
  directoryStructure: string;
  layerDiagram: string;
}

/**
 * Complete DeepWiki documentation
 */
export interface DeepWikiDocument {
  title: string;
  overview: string;
  structure: WorkspaceStructure;
  dependencies: DependencyAnalysis;
  architecture: ArchitectureAnalysis;
  modules: ModuleDocumentation[];
  diagrams: DiagramCollection;
  generatedAt: string;
}

/**
 * Documentation for a single module
 */
export interface ModuleDocumentation {
  name: string;
  path: string;
  description: string;
  usage: string;
  api: FileAnalysis;
}

/**
 * Progress callback for subagent execution
 */
export type ProgressCallback = (message: string, increment?: number) => void;

/**
 * Subagent task definition
 */
export interface SubagentTask {
  id: string;
  name: string;
  description: string;
  execute: (context: SubagentContext) => Promise<unknown>;
}

/**
 * Context passed to subagents
 */
export interface SubagentContext {
  workspaceFolder: vscode.WorkspaceFolder;
  model: vscode.LanguageModelChat;
  parameters: IDeepWikiParameters;
  previousResults: Map<string, unknown>;
  progress: ProgressCallback;
  token: vscode.CancellationToken;
}
