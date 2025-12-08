import * as vscode from 'vscode';
import { DeepWikiTool } from './tools/deepWikiTool';
import { logger } from './utils/logger';

export function activate(context: vscode.ExtensionContext) {
  logger.log('Extension', 'DeepWiki Generator extension is now active');

  // Register the DeepWiki Language Model Tool
  const deepWikiTool = new DeepWikiTool(context);
  context.subscriptions.push(
    vscode.lm.registerTool('deepwiki-generator_createDeepWiki', deepWikiTool)
  );

  logger.log('Extension', 'DeepWiki tool registered successfully');
}

export function deactivate() {
  logger.log('Extension', 'DeepWiki Generator extension deactivated');
  logger.dispose();
}