import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { DesignPattern, CodeStructure } from '../types/analysis';

/**
 * Recognizes design patterns in the codebase
 * TODO: Implement more sophisticated AST-based pattern detection for higher accuracy
 */
export class PatternRecognizerSubagent extends BaseSubagent {
  id = 'pattern-recognizer';
  name = 'Pattern Recognizer';
  description = 'Recognizes design patterns in the codebase';

  async execute(context: SubagentContext): Promise<DesignPattern[]> {
    const { model, progress, token, previousResults } = context;

    progress('Recognizing design patterns...');

    const codeStructures = previousResults.get('code-parser') as Map<string, CodeStructure> | undefined;
    
    if (!codeStructures || codeStructures.size === 0) {
      return [];
    }

    const patterns: DesignPattern[] = [];

    // Simple pattern detection based on code structure
    for (const [filePath, structure] of codeStructures.entries()) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      // Detect Singleton pattern
      if (this.detectSingleton(structure)) {
        patterns.push({
          name: 'Singleton',
          type: 'creational',
          confidence: 0.8,
          locations: [{ file: filePath, elements: [], description: 'Singleton pattern detected' }],
          description: 'Ensures a class has only one instance',
        });
      }

      // Detect Factory pattern
      if (this.detectFactory(structure)) {
        patterns.push({
          name: 'Factory',
          type: 'creational',
          confidence: 0.7,
          locations: [{ file: filePath, elements: [], description: 'Factory pattern detected' }],
          description: 'Creates objects without specifying exact class',
        });
      }

      // Detect Observer pattern
      if (this.detectObserver(structure)) {
        patterns.push({
          name: 'Observer',
          type: 'behavioral',
          confidence: 0.7,
          locations: [{ file: filePath, elements: [], description: 'Observer pattern detected' }],
          description: 'Defines subscription mechanism',
        });
      }
    }

    progress(`Recognized ${patterns.length} design patterns`);

    return patterns;
  }

  private detectSingleton(structure: CodeStructure): boolean {
    // Look for classes with getInstance method
    return structure.classes.some(cls => 
      cls.methods?.some(m => m.name.includes('getInstance') || m.name.includes('instance'))
    );
  }

  private detectFactory(structure: CodeStructure): boolean {
    // Look for classes/functions with 'create' or 'factory' in name
    const hasFactoryFunction = structure.functions.some(f =>
      f.name.toLowerCase().includes('create') || f.name.toLowerCase().includes('factory')
    );
    const hasFactoryClass = structure.classes.some(c =>
      c.name.toLowerCase().includes('factory')
    );
    return hasFactoryFunction || hasFactoryClass;
  }

  private detectObserver(structure: CodeStructure): boolean {
    // Look for event emitter patterns
    const hasObserverMethods = structure.classes.some(cls =>
      cls.methods?.some(m =>
        m.name.includes('subscribe') || m.name.includes('on') || m.name.includes('addListener') ||
        m.name.includes('emit') || m.name.includes('notify')
      )
    );
    return hasObserverMethods;
  }
}
