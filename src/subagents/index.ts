// Base
export { BaseSubagent } from './baseSubagent';

// =============================================================================
// 7-LEVEL ARCHITECTURE
// =============================================================================

// Level 1: DISCOVERY - File discovery and basic information
export { FileScannerSubagent } from './fileScanner';
export { FrameworkDetectorSubagent } from './frameworkDetector';
export { DependencyAnalyzerSubagent } from './dependencyAnalyzer';
export { LanguageDetectorSubagent } from './languageDetector';
export { EntryPointFinderSubagent } from './entryPointFinder';
export { ConfigFinderSubagent } from './configFinder';
export { ExistingDocumentAnalyzerSubagent } from './existingDocumentAnalyzer';

// Level 2: CODE_EXTRACTION - LLM-based universal code extraction
// All languages (TypeScript, JavaScript, Swift, Python, Java, Go, Rust...) are now parsed by LLM
export { LLMUniversalCodeExtractorSubagent } from './llmCodeExtractor';

// Level 3: DEEP_ANALYSIS - LLM-based deep analysis
export { LLMClassAnalyzerSubagent } from './llmClassAnalyzer';
export { LLMFunctionAnalyzerSubagent } from './llmFunctionAnalyzer';
export { LLMModuleAnalyzerSubagent } from './llmModuleAnalyzer';

// Level 4: RELATIONSHIP - Relationship building
export { DependencyMapperSubagent } from './dependencyMapper';
export { CrossReferencerSubagent } from './crossReferencer';
export { InheritanceTreeBuilderSubagent } from './inheritanceTreeBuilder';
export { CallGraphBuilderSubagent } from './callGraphBuilder';
export { ModuleBoundaryBuilderSubagent } from './moduleBoundaryBuilder';
export { LayerViolationCheckerSubagent } from './layerViolationChecker';

// Level 5: DOCUMENTATION - Document generation with feedback loop
export { ModuleSummaryGeneratorSubagent } from './moduleSummaryGenerator';
export { FinalDocumentGeneratorSubagent } from './finalDocumentGenerator';
export { DiagramGeneratorSubagent } from './diagramGenerator';

// Level 6: QUALITY_REVIEW - Quality review and improvement
export { DocumentQualityReviewerSubagent } from './documentQualityReviewer';
export { AccuracyValidatorSubagent } from './accuracyValidator';
export { CompletenessCheckerSubagent } from './completenessChecker';
export { ConsistencyCheckerSubagent } from './consistencyChecker';
export { SourceReferenceValidatorSubagent } from './sourceReferenceValidator';
export { QualityGateSubagent } from './qualityGate';
export { RegenerationPlannerSubagent } from './regenerationPlanner';
export { RegenerationOrchestratorSubagent } from './regenerationOrchestrator';
export { LinkValidatorSubagent } from './linkValidator';
export { PageRegeneratorSubagent } from './pageRegenerator';

// Level 7: OUTPUT - Final output generation
export { MarkdownFormatterSubagent } from './markdownFormatter';
export { TOCGeneratorSubagent } from './tocGenerator';
export { IndexBuilderSubagent } from './indexBuilder';
