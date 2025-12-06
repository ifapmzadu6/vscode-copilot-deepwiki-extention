/**
 * Types for CODE_EXTRACTION level
 *
 * All types include line numbers for source references
 */

// =============================================================================
// Source Reference Types
// =============================================================================

/**
 * Source code reference with line numbers
 * Format: [file:startLine-endLine]() or [file:line]()
 */
export interface SourceReference {
  file: string;
  startLine: number;
  endLine?: number;
}

/**
 * Format a source reference as a markdown link
 */
export function formatSourceRef(ref: SourceReference): string {
  if (ref.endLine && ref.endLine !== ref.startLine) {
    return `[${ref.file}:${ref.startLine}-${ref.endLine}]()`;
  }
  return `[${ref.file}:${ref.startLine}]()`;
}

/**
 * Entity with source location
 */
export interface LocatedEntity {
  name: string;
  sourceRef: SourceReference;
}

// =============================================================================
// File Discovery Types
// =============================================================================

/**
 * Discovered file information
 */
export interface DiscoveredFile {
  path: string;
  relativePath: string;
  language: string;
  size: number;
  lineCount: number;
  isEntryPoint: boolean;
  isConfig: boolean;
  isTest: boolean;
  category: 'core' | 'util' | 'test' | 'config' | 'doc' | 'asset' | 'other';
}

/**
 * Discovery phase results
 */
export interface DiscoveryResult {
  files: DiscoveredFile[];
  summary: {
    totalFiles: number;
    totalLines: number;
    byLanguage: Record<string, number>;
    byCategory: Record<string, number>;
  };
  entryPoints: string[];
  configFiles: string[];
}

// =============================================================================
// Extracted Entity Types (with line numbers)
// =============================================================================

/**
 * Extracted import statement
 */
export interface ExtractedImport {
  file: string;
  line: number;
  sourceRef: SourceReference;
  source: string;
  items: string[];
  defaultImport?: string;
  namespaceImport?: string;
  isExternal: boolean;
  isTypeOnly: boolean;
}

/**
 * Extracted export statement
 */
export interface ExtractedExport {
  file: string;
  line: number;
  sourceRef: SourceReference;
  name: string;
  type: 'class' | 'function' | 'const' | 'interface' | 'type' | 'default' | 'namespace' | 'enum';
  isDefault: boolean;
}

/**
 * Extracted class definition
 */
export interface ExtractedClass {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  sourceRef: SourceReference;

  // Inheritance
  extends?: string;
  implements: string[];

  // Modifiers
  isExported: boolean;
  isAbstract: boolean;
  isDefault: boolean;

  // Members
  properties: ExtractedProperty[];
  methods: ExtractedMethod[];
  constructorInfo?: ExtractedConstructor;

  // Metadata
  decorators: string[];
  typeParameters: string[];
  jsdoc?: string;
}

/**
 * Extracted property
 */
export interface ExtractedProperty {
  name: string;
  type: string;
  line: number;
  sourceRef: SourceReference;
  visibility: 'public' | 'private' | 'protected';
  isStatic: boolean;
  isReadonly: boolean;
  isOptional: boolean;
  defaultValue?: string;
  decorators: string[];
  jsdoc?: string;
}

/**
 * Extracted method
 */
export interface ExtractedMethod {
  name: string;
  startLine: number;
  endLine: number;
  sourceRef: SourceReference;
  signature: string;

  // Modifiers
  visibility: 'public' | 'private' | 'protected';
  isStatic: boolean;
  isAbstract: boolean;
  isAsync: boolean;
  isGenerator: boolean;

  // Signature details
  parameters: ExtractedParameter[];
  returnType: string;
  typeParameters: string[];

  // Metadata
  decorators: string[];
  jsdoc?: string;

  // Implementation info (for deep analysis)
  bodyStartLine?: number;
  bodyEndLine?: number;
}

/**
 * Extracted constructor
 */
export interface ExtractedConstructor {
  startLine: number;
  endLine: number;
  sourceRef: SourceReference;
  parameters: ExtractedParameter[];
  jsdoc?: string;
}

/**
 * Extracted parameter
 */
export interface ExtractedParameter {
  name: string;
  type: string;
  isOptional: boolean;
  isRest: boolean;
  defaultValue?: string;
  decorators: string[];
}

/**
 * Extracted function definition
 */
export interface ExtractedFunction {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  sourceRef: SourceReference;
  signature: string;

  // Modifiers
  isExported: boolean;
  isDefault: boolean;
  isAsync: boolean;
  isGenerator: boolean;

  // Signature details
  parameters: ExtractedParameter[];
  returnType: string;
  typeParameters: string[];

  // Metadata
  decorators: string[];
  jsdoc?: string;

  // Implementation info
  bodyStartLine?: number;
  bodyEndLine?: number;
}

/**
 * Extracted interface definition
 */
export interface ExtractedInterface {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  sourceRef: SourceReference;

  isExported: boolean;
  extends: string[];
  typeParameters: string[];

  properties: ExtractedInterfaceProperty[];
  methods: ExtractedInterfaceMethod[];

  jsdoc?: string;
}

/**
 * Extracted interface property
 */
export interface ExtractedInterfaceProperty {
  name: string;
  type: string;
  line: number;
  sourceRef: SourceReference;
  isOptional: boolean;
  isReadonly: boolean;
  jsdoc?: string;
}

/**
 * Extracted interface method signature
 */
export interface ExtractedInterfaceMethod {
  name: string;
  line: number;
  sourceRef: SourceReference;
  signature: string;
  parameters: ExtractedParameter[];
  returnType: string;
  isOptional: boolean;
  jsdoc?: string;
}

/**
 * Extracted type alias
 */
export interface ExtractedTypeAlias {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  sourceRef: SourceReference;

  isExported: boolean;
  typeParameters: string[];
  definition: string;

  jsdoc?: string;
}

/**
 * Extracted enum
 */
export interface ExtractedEnum {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  sourceRef: SourceReference;

  isExported: boolean;
  isConst: boolean;

  members: ExtractedEnumMember[];

  jsdoc?: string;
}

/**
 * Extracted enum member
 */
export interface ExtractedEnumMember {
  name: string;
  value?: string | number;
  line: number;
  sourceRef: SourceReference;
}

/**
 * Extracted constant
 */
export interface ExtractedConstant {
  name: string;
  file: string;
  line: number;
  sourceRef: SourceReference;

  type: string;
  value?: string;
  isExported: boolean;

  jsdoc?: string;
}

// =============================================================================
// Extraction Results
// =============================================================================

/**
 * All extracted entities from a single file
 */
export interface FileExtractionResult {
  file: string;
  relativePath: string;
  language: string;
  lineCount: number;

  imports: ExtractedImport[];
  exports: ExtractedExport[];
  classes: ExtractedClass[];
  functions: ExtractedFunction[];
  interfaces: ExtractedInterface[];
  typeAliases: ExtractedTypeAlias[];
  enums: ExtractedEnum[];
  constants: ExtractedConstant[];

  extractedAt: string;
}

/**
 * Aggregated extraction results
 */
export interface ExtractionSummary {
  // All entities by type
  classes: ExtractedClass[];
  functions: ExtractedFunction[];
  interfaces: ExtractedInterface[];
  typeAliases: ExtractedTypeAlias[];
  enums: ExtractedEnum[];
  constants: ExtractedConstant[];

  // All imports/exports
  imports: ExtractedImport[];
  exports: ExtractedExport[];

  // By file index
  byFile: Map<string, FileExtractionResult>;

  // Summary stats
  stats: {
    totalClasses: number;
    totalFunctions: number;
    totalInterfaces: number;
    totalTypes: number;
    totalEnums: number;
    totalConstants: number;
    totalExports: number;
    totalImports: number;
  };
}

// =============================================================================
// Helper functions
// =============================================================================

/**
 * Create a source reference
 */
export function createSourceRef(file: string, startLine: number, endLine?: number): SourceReference {
  return { file, startLine, endLine };
}

/**
 * Get source reference string for logging
 */
export function sourceRefToString(ref: SourceReference): string {
  if (ref.endLine && ref.endLine !== ref.startLine) {
    return `${ref.file}:${ref.startLine}-${ref.endLine}`;
  }
  return `${ref.file}:${ref.startLine}`;
}
