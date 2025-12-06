/**
 * Types for RELATIONSHIP level
 *
 * Defines dependency graphs, call graphs, and cross-references
 */

import { SourceReference, formatSourceRef } from './extraction';

// =============================================================================
// Dependency Graph Types
// =============================================================================

/**
 * Node in the dependency graph
 */
export interface DependencyGraphNode {
  id: string;
  path: string;
  type: 'file' | 'module' | 'package';
  module?: string;
  exports: string[];
  isExternal: boolean;
}

/**
 * Edge in the dependency graph
 */
export interface DependencyGraphEdge {
  from: string;
  to: string;
  type: 'import' | 'require' | 'dynamic-import';
  line: number;
  sourceRef: SourceReference;
  items: string[];
  isTypeOnly: boolean;
}

/**
 * Complete dependency graph
 */
export interface DependencyGraph {
  nodes: DependencyGraphNode[];
  edges: DependencyGraphEdge[];
  cycles: string[][];
  externalDependencies: string[];
}

// =============================================================================
// Call Graph Types
// =============================================================================

/**
 * Node in the call graph (a function or method)
 */
export interface CallGraphNode {
  id: string;
  name: string;
  file: string;
  sourceRef: SourceReference;
  type: 'function' | 'method' | 'constructor' | 'arrow' | 'callback';
  className?: string;
  isAsync: boolean;
  isExported: boolean;
}

/**
 * Edge in the call graph (a function call)
 */
export interface CallGraphEdge {
  from: string;
  to: string;
  line: number;
  sourceRef: SourceReference;
  callType: 'direct' | 'indirect' | 'conditional' | 'loop' | 'callback';
  isAsync: boolean;
}

/**
 * Complete call graph
 */
export interface CallGraph {
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
  entryPoints: string[];
  recursiveFunctions: string[];
}

// =============================================================================
// Inheritance Tree Types
// =============================================================================

/**
 * Node in the inheritance tree
 */
export interface InheritanceNode {
  id: string;
  name: string;
  file: string;
  sourceRef: SourceReference;
  type: 'class' | 'interface' | 'abstract-class';
  isExternal: boolean;
}

/**
 * Edge in the inheritance tree
 */
export interface InheritanceEdge {
  from: string;
  to: string;
  type: 'extends' | 'implements';
  sourceRef: SourceReference;
}

/**
 * Complete inheritance tree
 */
export interface InheritanceTree {
  nodes: InheritanceNode[];
  edges: InheritanceEdge[];
  roots: string[];
  depth: number;
}

// =============================================================================
// Module Boundary Types
// =============================================================================

/**
 * Defined module (logical grouping)
 */
export interface ModuleDefinition {
  name: string;
  path: string;
  files: string[];

  // Public API
  exports: ModuleExport[];

  // Dependencies
  internalDependencies: string[];
  externalDependencies: string[];

  // Metrics
  cohesion: number;
  coupling: number;
  instability: number;

  // Description (from analysis)
  description?: string;
}

/**
 * Module export entry
 */
export interface ModuleExport {
  name: string;
  type: 'class' | 'function' | 'interface' | 'type' | 'const' | 'enum';
  file: string;
  sourceRef: SourceReference;
  isReExport: boolean;
}

/**
 * Module boundaries result
 */
export interface ModuleBoundaries {
  modules: ModuleDefinition[];
  moduleGraph: {
    nodes: string[];
    edges: Array<{ from: string; to: string; weight: number }>;
  };
  layering?: {
    layers: string[][];
    violations: Array<{ from: string; to: string }>;
  };
}

// =============================================================================
// Cross-Reference Types
// =============================================================================

/**
 * Where an entity is defined
 */
export interface EntityDefinition {
  entityId: string;
  name: string;
  type: 'class' | 'function' | 'interface' | 'type' | 'const' | 'enum' | 'property' | 'method';
  file: string;
  sourceRef: SourceReference;
}

/**
 * Where an entity is used
 */
export interface EntityUsage {
  entityId: string;
  file: string;
  line: number;
  sourceRef: SourceReference;
  usageType: 'import' | 'instantiation' | 'call' | 'reference' | 'type-annotation' | 'extends' | 'implements';
  context: string;
}

/**
 * Complete cross-reference for an entity
 */
export interface EntityCrossReference {
  entityId: string;
  definition: EntityDefinition;
  usages: EntityUsage[];
  importedBy: Array<{
    file: string;
    line: number;
    sourceRef: SourceReference;
  }>;
}

/**
 * All cross-references
 */
export interface CrossReferenceIndex {
  byEntity: Map<string, EntityCrossReference>;
  byFile: Map<string, string[]>;
  orphans: string[];
  mostUsed: Array<{ entityId: string; usageCount: number }>;
}

// =============================================================================
// Relationship Summary
// =============================================================================

/**
 * Complete relationship analysis result
 */
export interface RelationshipAnalysis {
  dependencyGraph: DependencyGraph;
  callGraph: CallGraph;
  inheritanceTree: InheritanceTree;
  moduleBoundaries: ModuleBoundaries;
  crossReferences: CrossReferenceIndex;

  analyzedAt: string;
}

// =============================================================================
// Helper functions for formatting
// =============================================================================

/**
 * Format a dependency edge as markdown
 */
export function formatDependencyEdge(edge: DependencyGraphEdge): string {
  const items = edge.items.length > 0 ? ` (${edge.items.join(', ')})` : '';
  return `${edge.from} → ${edge.to}${items} ${formatSourceRef(edge.sourceRef)}`;
}

/**
 * Format a call edge as markdown
 */
export function formatCallEdge(edge: CallGraphEdge): string {
  const asyncMarker = edge.isAsync ? ' (async)' : '';
  return `${edge.from} → ${edge.to}${asyncMarker} ${formatSourceRef(edge.sourceRef)}`;
}

/**
 * Get all files that depend on a given file
 */
export function getDependents(graph: DependencyGraph, filePath: string): string[] {
  return graph.edges.filter((e) => e.to === filePath).map((e) => e.from);
}

/**
 * Get all files that a given file depends on
 */
export function getDependencies(graph: DependencyGraph, filePath: string): string[] {
  return graph.edges.filter((e) => e.from === filePath).map((e) => e.to);
}
