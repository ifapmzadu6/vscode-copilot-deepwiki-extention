/**
 * Logger utility with timestamp support and VS Code Output Channel
 */
import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('DeepWiki Generator');
  }
  return outputChannel;
}

function getTimestamp(): string {
  const now = new Date();
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const seconds = now.getSeconds().toString().padStart(2, '0');
  const milliseconds = now.getMilliseconds().toString().padStart(3, '0');
  return `${hours}:${minutes}:${seconds}.${milliseconds}`;
}

function formatMessage(prefix: string, message: string): string {
  return `[${getTimestamp()}] [${prefix}] ${message}`;
}

export const logger = {
  log(prefix: string, message: string): void {
    const formatted = formatMessage(prefix, message);
    console.log(formatted);
    getOutputChannel().appendLine(formatted);
  },

  info(prefix: string, message: string): void {
    const formatted = formatMessage(prefix, message);
    console.info(formatted);
    getOutputChannel().appendLine(`ℹ️ ${formatted}`);
  },

  warn(prefix: string, message: string): void {
    const formatted = formatMessage(prefix, message);
    console.warn(formatted);
    getOutputChannel().appendLine(`⚠️ ${formatted}`);
  },

  error(prefix: string, message: string, error?: unknown): void {
    const formatted = formatMessage(prefix, message);
    console.error(formatted);
    getOutputChannel().appendLine(`❌ ${formatted}`);
    if (error) {
      console.error(error);
      getOutputChannel().appendLine(`   ${String(error)}`);
    }
  },

  /**
   * Show the output channel to the user
   */
  show(): void {
    getOutputChannel().show(true);
  },

  /**
   * Dispose the output channel (call on extension deactivation)
   */
  dispose(): void {
    if (outputChannel) {
      outputChannel.dispose();
      outputChannel = undefined;
    }
  },
};
