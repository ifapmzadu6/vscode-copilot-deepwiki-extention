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
}
