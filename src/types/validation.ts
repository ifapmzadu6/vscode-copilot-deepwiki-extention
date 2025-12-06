/**
 * Types for validation and quality checking
 */

/**
 * Overall validation result
 */
export interface ValidationResult {
  isValid: boolean;
  accuracy: AccuracyValidation;
  completeness: CompletenessValidation;
  consistency: ConsistencyValidation;
  overallScore: number;
  recommendations: ValidationRecommendation[];
  regenerated?: boolean;
}

/**
 * Accuracy validation result
 */
export interface AccuracyValidation {
  score: number;
  issues: AccuracyIssue[];
  verified: VerifiedItem[];
  total: number;
}

/**
 * Accuracy issue
 */
export interface AccuracyIssue {
  severity: 'error' | 'warning' | 'info';
  type: 'incorrect-type' | 'wrong-signature' | 'invalid-reference' | 'outdated-info' | 'other';
  location: IssueLocation;
  message: string;
  suggestion?: string;
  autoFixable: boolean;
}

/**
 * Issue location
 */
export interface IssueLocation {
  file?: string;
  section?: string;
  line?: number;
  element?: string;
}

/**
 * Verified item
 */
export interface VerifiedItem {
  type: string;
  name: string;
  location: string;
  verificationMethod: string;
}

/**
 * Completeness validation result
 */
export interface CompletenessValidation {
  score: number;
  coverage: CoverageMetrics;
  missing: MissingItem[];
  suggestions: string[];
}

/**
 * Coverage metrics
 */
export interface CoverageMetrics {
  filesDocumented: number;
  totalFiles: number;
  exportsCovered: number;
  totalExports: number;
  classesCovered: number;
  totalClasses: number;
  functionsCovered: number;
  totalFunctions: number;
  examplesCoverage: number;
}

/**
 * Missing documentation item
 */
export interface MissingItem {
  type: 'file' | 'class' | 'function' | 'interface' | 'type' | 'property' | 'method' | 'example';
  name: string;
  location: string;
  priority: 'high' | 'medium' | 'low';
  reason: string;
}

/**
 * Consistency validation result
 */
export interface ConsistencyValidation {
  score: number;
  inconsistencies: Inconsistency[];
  standards: StandardCompliance[];
}

/**
 * Inconsistency found
 */
export interface Inconsistency {
  severity: 'error' | 'warning' | 'info';
  type: 'naming' | 'formatting' | 'structure' | 'cross-reference' | 'terminology' | 'style';
  locations: IssueLocation[];
  description: string;
  expectedPattern: string;
  actualPattern: string;
  autoFixable: boolean;
}

/**
 * Standard compliance check
 */
export interface StandardCompliance {
  standard: string;
  compliant: boolean;
  violations: string[];
  recommendations: string[];
}

/**
 * Validation recommendation
 */
export interface ValidationRecommendation {
  priority: 'critical' | 'high' | 'medium' | 'low';
  category: 'accuracy' | 'completeness' | 'consistency' | 'quality';
  title: string;
  description: string;
  action: string;
  impact: string;
  effort: 'low' | 'medium' | 'high';
  autoApplicable: boolean;
}

/**
 * Quality metrics
 */
export interface QualityMetrics {
  overallScore: number;
  readability: number;
  maintainability: number;
  completeness: number;
  accuracy: number;
  consistency: number;
  usability: number;
}

/**
 * Improvement suggestion
 */
export interface ImprovementSuggestion {
  target: string;
  type: 'add-example' | 'enhance-description' | 'fix-error' | 'add-diagram' | 'cross-reference' | 'clarify';
  priority: number;
  description: string;
  before?: string;
  after?: string;
}

/**
 * Self-validation feedback
 */
export interface SelfValidationFeedback {
  passed: boolean;
  iterations: number;
  improvements: ImprovementApplied[];
  finalQuality: QualityMetrics;
  timeSpent: number;
}

/**
 * Improvement applied
 */
export interface ImprovementApplied {
  iteration: number;
  type: string;
  target: string;
  description: string;
  qualityBefore: number;
  qualityAfter: number;
}
