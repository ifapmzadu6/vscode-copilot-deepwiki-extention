import * as vscode from 'vscode';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { CodeStructure, ScannedFile } from '../types/analysis';

/**
 * Parses code files to extract structure using AST analysis with AI
 */
export class CodeParserSubagent extends BaseSubagent {
  id = 'code-parser';
  name = 'Code Parser';
  description = 'Parses code files and extracts structure using AST analysis';

  async execute(context: SubagentContext): Promise<Map<string, CodeStructure>> {
    const { model, progress, token, previousResults } = context;

    progress('Parsing code files...');

    const scannedFiles = previousResults.get('file-scanner') as ScannedFile[] | undefined;
    if (!scannedFiles) {
      throw new Error('File scanner results not found');
    }

    // Filter for code files
    const codeFiles = scannedFiles.filter((f) =>
      this.isCodeFile(f.language)
    );

    progress(`Analyzing ${codeFiles.length} code files...`);

    const structures = new Map<string, CodeStructure>();

    // Process files in batches
    const batchSize = 10;
    for (let i = 0; i < codeFiles.length; i += batchSize) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      const batch = codeFiles.slice(i, i + batchSize);
      progress(`Parsing files ${i + 1}-${Math.min(i + batchSize, codeFiles.length)}...`);

      for (const file of batch) {
        try {
          const structure = await this.parseFile(file, model, token);
          if (structure) {
            structures.set(file.relativePath, structure);
          }
        } catch (error) {
          console.error(`Error parsing ${file.relativePath}:`, error);
          // Continue with other files
        }
      }
    }

    progress(`Parsed ${structures.size} code files`);

    return structures;
  }

  private async parseFile(
    file: ScannedFile,
    model: vscode.LanguageModelChat,
    token: vscode.CancellationToken
  ): Promise<CodeStructure | null> {
    const uri = vscode.Uri.file(file.path);
    const content = await this.readFile(uri);

    if (!content || content.length > 50000) {
      // Skip empty or very large files
      return null;
    }

    try {
      const prompt = `Analyze this ${file.language} code file and extract its structure.

File: ${file.relativePath}

Code:
\`\`\`${file.language}
${content}
\`\`\`

Provide a JSON response with:
{
  "imports": [{"source": "string", "names": ["string"], "isExternal": boolean}],
  "exports": [{"name": "string", "type": "class|function|const|interface|type", "isPublic": boolean}],
  "classes": [{"name": "string", "description": "string", "isExported": boolean, "methods": ["string"], "properties": ["string"]}],
  "functions": [{"name": "string", "description": "string", "isExported": boolean, "isAsync": boolean, "parameters": ["string"], "returnType": "string"}],
  "interfaces": [{"name": "string", "description": "string", "isExported": boolean}],
  "types": [{"name": "string", "description": "string", "isExported": boolean}],
  "constants": [{"name": "string", "type": "string", "isExported": boolean}]
}

Focus on exported items and public APIs. Keep descriptions concise.`;

      const response = await this.queryModel(
        model,
        'You are a code analyzer. Extract code structure accurately. Respond only with valid JSON.',
        prompt,
        token
      );

      const parsed = this.parseJsonResponse<any>(response);

      return {
        filePath: file.path,
        imports: parsed.imports || [],
        exports: parsed.exports || [],
        classes: parsed.classes || [],
        functions: parsed.functions || [],
        interfaces: parsed.interfaces || [],
        types: parsed.types || [],
        constants: parsed.constants || [],
      };
    } catch (error) {
      console.error(`Error parsing file ${file.relativePath}:`, error);
      return null;
    }
  }

  private isCodeFile(language: string): boolean {
    const codeLanguages = [
      'typescript',
      'typescriptreact',
      'javascript',
      'javascriptreact',
      'python',
      'java',
      'go',
      'rust',
      'csharp',
      'cpp',
      'c',
    ];
    return codeLanguages.includes(language);
  }
}
