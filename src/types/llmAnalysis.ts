/**
 * Types for LLM-based analysis results (DEEP_ANALYSIS level)
 *
 * These types represent the structured output from LLM analysis
 */

import { SourceReference } from './extraction';

// =============================================================================
// LLM Analysis Request/Response Types
// =============================================================================

/**
 * Request for LLM analysis
 */
export interface LLMAnalysisRequest {
  type: 'class' | 'function' | 'module' | 'architecture';
  entityId: string;
  code: string;
  context: {
    file: string;
    sourceRef: SourceReference;
    relatedEntities?: string[];
    imports?: string[];
  };
}

/**
 * LLM feedback loop result
 */
export interface LLMFeedbackResult<T> {
  content: T;
  score: number;
  iterations: number;
  feedback?: string[];
  improvements?: string[];
  analyzedAt: string;
}

// =============================================================================
// Class Analysis Types
// =============================================================================

/**
 * LLM analysis result for a class
 */
export interface ClassLLMAnalysis {
  name: string;
  sourceRef: SourceReference;

  // High-level understanding
  purpose: string;
  responsibilities: string[];
  category: 'controller' | 'service' | 'model' | 'utility' | 'factory' | 'builder' | 'adapter' | 'other';

  // Design patterns
  designPatterns: IdentifiedPattern[];

  // Method analysis
  keyMethods: MethodAnalysis[];

  // State & behavior
  stateManagement: string;
  lifecycle?: string;
  errorHandling: string;

  // Relationships
  dependencies: DependencyDescription[];
  usedBy: UsageDescription[];

  // Quality insights
  complexity: 'low' | 'medium' | 'high';
  suggestions?: string[];

  // Metadata
  llmScore: number;
  llmIterations: number;
  analyzedAt: string;
}

/**
 * Identified design pattern
 */
export interface IdentifiedPattern {
  name: string;
  type: 'creational' | 'structural' | 'behavioral' | 'architectural';
  confidence: number;
  explanation: string;
  elements: string[];
}

/**
 * Analysis of a single method
 */
export interface MethodAnalysis {
  name: string;
  sourceRef: SourceReference;
  purpose: string;
  algorithm?: string;
  complexity: string;
  sideEffects: string[];
  errorScenarios?: string[];
}

/**
 * Description of a dependency
 */
export interface DependencyDescription {
  name: string;
  sourceRef?: SourceReference;
  role: string;
  isRequired: boolean;
}

/**
 * Description of usage
 */
export interface UsageDescription {
  by: string;
  sourceRef?: SourceReference;
  context: string;
}

// =============================================================================
// Function Analysis Types
// =============================================================================

/**
 * LLM analysis result for a function
 */
export interface FunctionLLMAnalysis {
  name: string;
  sourceRef: SourceReference;

  // High-level understanding
  purpose: string;
  category: 'utility' | 'handler' | 'transformer' | 'validator' | 'factory' | 'hook' | 'middleware' | 'other';

  // Implementation details
  algorithm: string;
  complexity: {
    time: string;
    space: string;
  };
  keySteps: string[];

  // Input/Output
  inputDescription: ParameterAnalysis[];
  outputDescription: string;
  sideEffects: string[];

  // Error handling
  errorScenarios: ErrorScenario[];

  // Usage
  usagePatterns: string[];
  examples: GeneratedExample[];

  // Quality insights
  suggestions?: string[];

  // Metadata
  llmScore: number;
  llmIterations: number;
  analyzedAt: string;
}

/**
 * Analysis of a function parameter
 */
export interface ParameterAnalysis {
  name: string;
  type: string;
  purpose: string;
  constraints?: string;
  defaultBehavior?: string;
}

/**
 * Error scenario analysis
 */
export interface ErrorScenario {
  condition: string;
  behavior: string;
  recoverable: boolean;
}

/**
 * Generated code example
 */
export interface GeneratedExample {
  title: string;
  description: string;
  code: string;
  sourceRef?: SourceReference;
}

// =============================================================================
// Module Analysis Types
// =============================================================================

/**
 * LLM analysis result for a module
 */
export interface ModuleLLMAnalysis {
  name: string;
  path: string;

  // High-level understanding
  purpose: string;
  responsibilities: string[];
  category: 'core' | 'feature' | 'utility' | 'infrastructure' | 'integration' | 'other';

  // Architecture
  architecture: {
    pattern: string;
    layers?: string[];
    components: ComponentDescription[];
  };

  // Key entities
  keyClasses: KeyEntityDescription[];
  keyFunctions: KeyEntityDescription[];
  keyTypes: KeyEntityDescription[];

  // Relationships
  internalFlow: string;
  externalInterface: string;
  dependencies: ModuleDependencyDescription[];
  dependents: ModuleDependencyDescription[];

  // Data flow
  dataFlow: DataFlowDescription;

  // Quality
  cohesion: 'low' | 'medium' | 'high';
  coupling: 'low' | 'medium' | 'high';
  suggestions?: string[];

  // Metadata
  llmScore: number;
  llmIterations: number;
  analyzedAt: string;
}

/**
 * Description of a component within a module
 */
export interface ComponentDescription {
  name: string;
  type: 'class' | 'function' | 'subsystem';
  role: string;
  sourceRef?: SourceReference;
}

/**
 * Description of a key entity
 */
export interface KeyEntityDescription {
  name: string;
  sourceRef: SourceReference;
  importance: 'critical' | 'high' | 'medium';
  summary: string;
}

/**
 * Module dependency description
 */
export interface ModuleDependencyDescription {
  module: string;
  purpose: string;
  coupling: 'tight' | 'loose';
}

/**
 * Data flow description
 */
export interface DataFlowDescription {
  inputs: Array<{ name: string; source: string }>;
  outputs: Array<{ name: string; destination: string }>;
  transformations: string[];
}

// =============================================================================
// Architecture Analysis Types
// =============================================================================

/**
 * Overall architecture analysis
 */
export interface ArchitectureLLMAnalysis {
  projectName: string;

  // Overview
  purpose: string;
  domain: string;
  targetAudience: string;

  // Architecture style
  architectureStyle: string;
  architecturePatterns: IdentifiedPattern[];

  // Structure
  layers: LayerDescription[];
  modules: ModuleOverview[];
  crossCuttingConcerns: string[];

  // Key flows
  mainExecutionFlows: ExecutionFlowDescription[];

  // Technology
  primaryLanguage: string;
  frameworks: FrameworkDescription[];
  externalServices: string[];

  // Quality attributes
  scalability: string;
  maintainability: string;
  testability: string;

  // Recommendations
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];

  // Metadata
  llmScore: number;
  llmIterations: number;
  analyzedAt: string;
}

/**
 * Layer description
 */
export interface LayerDescription {
  name: string;
  purpose: string;
  modules: string[];
  dependencies: string[];
}

/**
 * Module overview for architecture
 */
export interface ModuleOverview {
  name: string;
  path: string;
  purpose: string;
  importance: 'critical' | 'high' | 'medium' | 'low';
}

/**
 * Execution flow description
 */
export interface ExecutionFlowDescription {
  name: string;
  trigger: string;
  steps: ExecutionStep[];
}

/**
 * Single step in execution flow
 */
export interface ExecutionStep {
  order: number;
  description: string;
  location: string;
  sourceRef?: SourceReference;
}

/**
 * Framework description
 */
export interface FrameworkDescription {
  name: string;
  version?: string;
  purpose: string;
  usage: string;
}

// =============================================================================
// Quality Review Types
// =============================================================================

/**
 * Quality review for generated documentation
 */
export interface DocumentationQualityReview {
  pageId: string;
  scores: {
    technicalAccuracy: number;
    completeness: number;
    sourceReferences: number;
    clarity: number;
    usefulness: number;
  };
  overallScore: number;

  issues: QualityIssue[];
  improvements: string[];
  missingContent: string[];

  reviewedAt: string;
}

/**
 * Quality issue found in documentation
 */
export interface QualityIssue {
  severity: 'critical' | 'high' | 'medium' | 'low';
  location: string;
  issue: string;
  suggestion: string;
}

// =============================================================================
// Aggregated Analysis Results
// =============================================================================

/**
 * All LLM analysis results for a project
 */
export interface ProjectLLMAnalysis {
  architecture: ArchitectureLLMAnalysis;
  modules: Map<string, ModuleLLMAnalysis>;
  classes: Map<string, ClassLLMAnalysis>;
  functions: Map<string, FunctionLLMAnalysis>;

  qualityReviews: Map<string, DocumentationQualityReview>;

  summary: {
    totalAnalyzed: number;
    averageScore: number;
    totalLLMCalls: number;
    analyzedAt: string;
  };
}
