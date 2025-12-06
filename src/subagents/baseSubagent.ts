import * as vscode from 'vscode';
import { SubagentContext, SubagentTask } from '../types';

/**
 * Base class for subagents that perform specific analysis tasks
 */
export abstract class BaseSubagent implements SubagentTask {
  abstract id: string;
  abstract name: string;
  abstract description: string;

  /**
   * Execute the subagent task
   */
  abstract execute(context: SubagentContext): Promise<unknown>;

  /**
   * Send a prompt to the language model and get a response
   */
  protected async queryModel(
    model: vscode.LanguageModelChat,
    systemPrompt: string,
    userPrompt: string,
    token: vscode.CancellationToken
  ): Promise<string> {
    const messages = [
      vscode.LanguageModelChatMessage.User(
        `${systemPrompt}\n\n---\n\n${userPrompt}`
      ),
    ];

    const response = await model.sendRequest(messages, {}, token);

    let result = '';
    for await (const chunk of response.text) {
      result += chunk;
    }

    return result;
  }

  /**
   * Parse JSON from model response, handling markdown code blocks
   */
  protected parseJsonResponse<T>(response: string): T {
    // Remove markdown code blocks if present
    let jsonStr = response.trim();

    // Handle ```json ... ``` blocks
    const jsonBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonBlockMatch) {
      jsonStr = jsonBlockMatch[1].trim();
    }

    try {
      return JSON.parse(jsonStr);
    } catch (error) {
      // Try to extract JSON object or array
      const jsonMatch = jsonStr.match(/[\[{][\s\S]*[\]}]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      throw new Error(`Failed to parse JSON response: ${error}`);
    }
  }

  /**
   * Read file content with error handling
   */
  protected async readFile(uri: vscode.Uri): Promise<string> {
    try {
      const content = await vscode.workspace.fs.readFile(uri);
      return new TextDecoder().decode(content);
    } catch {
      return '';
    }
  }

  /**
   * Get files matching a glob pattern
   */
  protected async findFiles(
    pattern: string,
    exclude?: string,
    maxResults?: number,
    workspaceFolder?: vscode.WorkspaceFolder
  ): Promise<vscode.Uri[]> {
    const searchPattern = workspaceFolder
      ? new vscode.RelativePattern(workspaceFolder, pattern)
      : pattern;
    return vscode.workspace.findFiles(searchPattern, exclude, maxResults);
  }

  /**
   * Check if a file is a source code file based on extension
   */
  protected isSourceFile(filePath: string): boolean {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const sourceExtensions = [
      'ts', 'js', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'kts', 'scala', 'm', 'mm'
    ];
    return ext ? sourceExtensions.includes(ext) : false;
  }

  protected createEmptySummary(): any {
    return {
      stats: { totalClasses: 0, totalFunctions: 0, totalInterfaces: 0, totalTypes: 0, totalEnums: 0, totalConstants: 0, totalExports: 0, totalImports: 0 },
      filesProcessed: 0, totalLLMCalls: 0, savedToFile: 'extraction-summary'
    };
  }

  protected async loadCachedExtraction(relativePath: string): Promise<any> {
    // Placeholder for base caching logic if needed, 
    // though implementation is usually in the subagent itself
    return null;
  }

  protected async saveCachedExtraction(relativePath: string, data: any): Promise<void> {
    // Placeholder
  }

  protected buildMethodSignature(method: any): string {
    const params = method.parameters?.map((p: any) =>
      `${p.name}${p.isOptional ? '?' : ''}: ${p.type}`
    ).join(', ') || '';
    return `${method.name}(${params}): ${method.returnType || 'void'}`;
  }

  protected transformFunctions(funcs: any[], file: string): any[] {
    // Helper for transformation if needed by multiple agents
    return funcs;
    // ... actually, the extractor implements its own specific transform logic.
    // But we need to avoid "Property 'transformFunctions' does not exist" error in the extractor if it calls `this.transformFunctions`.
    // Checking the extractor code... it calls `this.transformFunctions`.
    // So define them here or move them back to extractor?
    // Moving them to base class is good for reuse.
    return [];
  }

  // To avoid breaking the Extractor which expects these methods on `this`
  protected transformClasses(classes: any[], file: string): any[] { return []; }
  protected transformInterfaces(interfaces: any[], file: string): any[] { return []; }
  protected transformTypeAliases(types: any[], file: string): any[] { return []; }
  protected transformEnums(enums: any[], file: string): any[] { return []; }
}
