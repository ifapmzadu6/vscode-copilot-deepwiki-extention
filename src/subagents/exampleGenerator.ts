import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { CodeExample, PublicAPI, FunctionAnalysis, ClassAnalysis } from '../types/analysis';

// Configuration constants
// TODO: Move to centralized configuration module for better maintainability
const MAX_APIS_TO_GENERATE_EXAMPLES = 10;

/**
 * Generates usage examples for APIs
 */
export class ExampleGeneratorSubagent extends BaseSubagent {
  id = 'example-generator';
  name = 'Example Generator';
  description = 'Generates usage examples for APIs';

  async execute(context: SubagentContext): Promise<Map<string, CodeExample[]>> {
    const { model, progress, token, previousResults } = context;

    progress('Generating usage examples...');

    const apis = previousResults.get('api-extractor') as PublicAPI[] | undefined;
    const functions = previousResults.get('function-analyzer') as FunctionAnalysis[] | undefined;
    
    if (!apis && !functions) {
      return new Map();
    }

    const examples = new Map<string, CodeExample[]>();

    // Generate examples for APIs
    if (apis) {
      for (const api of apis.slice(0, MAX_APIS_TO_GENERATE_EXAMPLES)) {
        if (token.isCancellationRequested) {
          throw new vscode.CancellationError();
        }

        try {
          const moduleExamples = await this.generateExamples(api, model, token);
          examples.set(api.module, moduleExamples);
        } catch (error) {
          console.error(`Error generating examples for ${api.module}:`, error);
        }
      }
    }

    progress(`Generated examples for ${examples.size} modules`);

    return examples;
  }

  private async generateExamples(
    api: PublicAPI,
    model: vscode.LanguageModelChat,
    token: vscode.CancellationToken
  ): Promise<CodeExample[]> {
    const exportNames = api.exports.slice(0, 3).map(e => e.name).join(', ');

    const prompt = `Generate 1-2 concise usage examples for these exports from module "${api.module}":
${exportNames}

Provide JSON array:
[{
  "title": "Basic Usage",
  "description": "How to use...",
  "code": "const example = ...",
  "language": "typescript"
}]`;

    try {
      const response = await this.queryModel(
        model,
        `You are a technical writer. Generate clear, practical code examples. 
Respond ONLY with a valid JSON array (no markdown, no extra text).
Each example must have: title (string), description (string), code (string), language (string).
Example format: [{"title":"Basic Usage","description":"How to...","code":"const x = ...","language":"typescript"}]`,
        prompt,
        token
      );

      return this.parseJsonResponse<CodeExample[]>(response);
    } catch (error) {
      // Return basic example on error
      return [{
        title: 'Basic Usage',
        description: `Import and use exports from ${api.module}`,
        code: `import { ${exportNames} } from './${api.module}';`,
        language: 'typescript',
      }];
    }
  }
}
