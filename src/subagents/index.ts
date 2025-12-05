// Base
export { BaseSubagent } from './baseSubagent';

// Original subagents (Level 0 - Legacy)
export { StructureAnalyzerSubagent } from './structureAnalyzer';
export { DependencyAnalyzerSubagent } from './dependencyAnalyzer';
export { ArchitectureAnalyzerSubagent } from './architectureAnalyzer';
export { ModuleDocumenterSubagent } from './moduleDocumenter';
export { DiagramGeneratorSubagent } from './diagramGenerator';
export { OverviewGeneratorSubagent } from './overviewGenerator';

// Level 1 - Analysis Phase
export { FileScannerSubagent } from './fileScanner';
export { CodeParserSubagent } from './codeParser';
export { DependencyMapperSubagent } from './dependencyMapper';
export { FrameworkDetectorSubagent } from './frameworkDetector';
export { PatternRecognizerSubagent } from './patternRecognizer';

// Level 2 - Deep Analysis Phase
export { FunctionAnalyzerSubagent } from './functionAnalyzer';
export { ClassAnalyzerSubagent } from './classAnalyzer';
export { APIExtractorSubagent } from './apiExtractor';
export { TypeAnalyzerSubagent } from './typeAnalyzer';

// Level 3 - Quality Enhancement Phase
export { ExampleGeneratorSubagent } from './exampleGenerator';
export { CrossReferencerSubagent } from './crossReferencer';

// Level 4 - Validation Phase
export { AccuracyValidatorSubagent } from './accuracyValidator';
export { CompletenessCheckerSubagent } from './completenessChecker';
export { ConsistencyCheckerSubagent } from './consistencyChecker';

// Level 5 - Output Phase
export { MarkdownFormatterSubagent } from './markdownFormatter';
export { TOCGeneratorSubagent } from './tocGenerator';
export { IndexBuilderSubagent } from './indexBuilder';
