import * as vscode from 'vscode';
import { DeepWikiTool } from './tools/deepWikiTool';

export function activate(context: vscode.ExtensionContext) {
  console.log('DeepWiki Generator extension is now active');

  // Register the DeepWiki Language Model Tool
  const deepWikiTool = new DeepWikiTool(context);
  context.subscriptions.push(
    vscode.lm.registerTool('deepwiki-generator_createDeepWiki', deepWikiTool)
  );

  console.log('DeepWiki tool registered successfully');
}

export function deactivate() {
  console.log('DeepWiki Generator extension deactivated');
}
