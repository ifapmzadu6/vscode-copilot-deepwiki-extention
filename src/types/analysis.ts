/**
 * Types for detailed code analysis results
 */

/**
 * Basic file information from scanner
 */
export interface ScannedFile {
  path: string;
  relativePath: string;
  size: number;
  language: string;
  lastModified: number;
}

/**
 * AST-based code structure
 */
export interface CodeStructure {
  filePath: string;
  imports: ImportDeclaration[];
  exports: ExportDeclaration[];
  classes: ClassDeclaration[];
  functions: FunctionDeclaration[];
  interfaces: InterfaceDeclaration[];
  types: TypeDeclaration[];
  constants: ConstantDeclaration[];
}

/**
 * Import declaration details
 */
export interface ImportDeclaration {
  source: string;
  names: string[];
  defaultImport?: string;
  namespaceImport?: string;
  isExternal: boolean;
  isTypeOnly: boolean;
}

/**
 * Export declaration details
 */
export interface ExportDeclaration {
  name: string;
  type: 'class' | 'function' | 'const' | 'interface' | 'type' | 'default' | 'namespace';
  isDefault: boolean;
  isPublic: boolean;
}

/**
 * Class declaration with details
 */
export interface ClassDeclaration {
  name: string;
  description: string;
  isExported: boolean;
  isAbstract: boolean;
  extends?: string;
  implements: string[];
  properties: PropertyDeclaration[];
  methods: MethodDeclaration[];
  constructorParams: ParameterDeclaration[];
  decorators: string[];
  typeParameters: string[];
}

/**
 * Function declaration with details
 */
export interface FunctionDeclaration {
  name: string;
  description: string;
  isExported: boolean;
  isAsync: boolean;
  isGenerator: boolean;
  parameters: ParameterDeclaration[];
  returnType: string;
  typeParameters: string[];
  decorators: string[];
  complexity: number;
}

/**
 * Interface declaration
 */
export interface InterfaceDeclaration {
  name: string;
  description: string;
  isExported: boolean;
  extends: string[];
  properties: PropertyDeclaration[];
  methods: MethodSignature[];
  typeParameters: string[];
}

/**
 * Type alias declaration
 */
export interface TypeDeclaration {
  name: string;
  description: string;
  isExported: boolean;
  definition: string;
  typeParameters: string[];
}

/**
 * Constant declaration
 */
export interface ConstantDeclaration {
  name: string;
  type: string;
  value?: string;
  isExported: boolean;
  description: string;
}

/**
 * Property declaration
 */
export interface PropertyDeclaration {
  name: string;
  type: string;
  isOptional: boolean;
  isReadonly: boolean;
  isStatic: boolean;
  visibility: 'public' | 'private' | 'protected';
  description: string;
  decorators: string[];
}

/**
 * Method declaration
 */
export interface MethodDeclaration {
  name: string;
  description: string;
  isAsync: boolean;
  isStatic: boolean;
  isAbstract: boolean;
  visibility: 'public' | 'private' | 'protected';
  parameters: ParameterDeclaration[];
  returnType: string;
  decorators: string[];
  complexity: number;
}

/**
 * Method signature (for interfaces)
 */
export interface MethodSignature {
  name: string;
  description: string;
  parameters: ParameterDeclaration[];
  returnType: string;
  isOptional: boolean;
}

/**
 * Parameter declaration
 */
export interface ParameterDeclaration {
  name: string;
  type: string;
  isOptional: boolean;
  defaultValue?: string;
  description: string;
}

/**
 * Dependency graph node
 */
export interface DependencyNode {
  id: string;
  path: string;
  type: 'file' | 'module' | 'package';
  dependencies: string[];
  dependents: string[];
  isExternal: boolean;
  cyclic: boolean;
}

/**
 * Dependency graph
 */
export interface DependencyGraph {
  nodes: Map<string, DependencyNode>;
  edges: Array<{ from: string; to: string }>;
  cycles: string[][];
  layers: string[][];
}

/**
 * Framework detection result
 */
export interface FrameworkInfo {
  name: string;
  version?: string;
  category: 'frontend' | 'backend' | 'fullstack' | 'testing' | 'build' | 'orm' | 'other';
  confidence: number;
  files: string[];
  patterns: string[];
}

/**
 * Design pattern detection
 */
export interface DesignPattern {
  name: string;
  type: 'creational' | 'structural' | 'behavioral' | 'architectural';
  confidence: number;
  locations: PatternLocation[];
  description: string;
}

/**
 * Location where a pattern is detected
 */
export interface PatternLocation {
  file: string;
  elements: string[];
  description: string;
}

/**
 * Detailed function analysis
 */
export interface FunctionAnalysis {
  function: FunctionDeclaration;
  complexity: ComplexityMetrics;
  dependencies: string[];
  usages: FunctionUsage[];
  testCoverage?: number;
  documentation: string;
  examples: CodeExample[];
}

/**
 * Complexity metrics
 */
export interface ComplexityMetrics {
  cyclomatic: number;
  cognitive: number;
  lines: number;
  parameters: number;
  returns: number;
  nesting: number;
}

/**
 * Function usage information
 */
export interface FunctionUsage {
  file: string;
  line: number;
  context: string;
}

/**
 * Code example
 */
export interface CodeExample {
  title: string;
  description: string;
  code: string;
  language: string;
}

/**
 * Detailed class analysis
 */
export interface ClassAnalysis {
  class: ClassDeclaration;
  metrics: ClassMetrics;
  relationships: ClassRelationship[];
  usages: ClassUsage[];
  documentation: string;
  examples: CodeExample[];
}

/**
 * Class metrics
 */
export interface ClassMetrics {
  methods: number;
  properties: number;
  linesOfCode: number;
  complexity: number;
  cohesion: number;
  coupling: number;
}

/**
 * Class relationship
 */
export interface ClassRelationship {
  type: 'extends' | 'implements' | 'uses' | 'composed-of' | 'aggregates';
  target: string;
  description: string;
}

/**
 * Class usage
 */
export interface ClassUsage {
  file: string;
  type: 'instantiation' | 'inheritance' | 'reference' | 'type-annotation';
  context: string;
}

/**
 * Public API extraction
 */
export interface PublicAPI {
  module: string;
  exports: APIExport[];
  examples: CodeExample[];
  changelog?: string;
}

/**
 * API export
 */
export interface APIExport {
  name: string;
  kind: 'class' | 'function' | 'interface' | 'type' | 'constant';
  signature: string;
  description: string;
  deprecated?: boolean;
  since?: string;
  parameters?: ParameterDeclaration[];
  returns?: string;
  examples: CodeExample[];
  relatedAPIs: string[];
}

/**
 * Type information analysis
 */
export interface TypeAnalysis {
  file: string;
  types: TypeInfo[];
  interfaces: InterfaceInfo[];
  generics: GenericInfo[];
}

/**
 * Type information
 */
export interface TypeInfo {
  name: string;
  kind: 'primitive' | 'union' | 'intersection' | 'literal' | 'object' | 'array' | 'tuple' | 'generic';
  definition: string;
  description: string;
  usages: number;
}

/**
 * Interface information
 */
export interface InterfaceInfo {
  name: string;
  extends: string[];
  properties: PropertyDeclaration[];
  methods: MethodSignature[];
  description: string;
  usages: number;
}

/**
 * Generic type information
 */
export interface GenericInfo {
  name: string;
  constraints: string[];
  defaults: string[];
  description: string;
}
