import * as vscode from 'vscode';
import { logger } from './logger';

/**
 * Recursive type for call hierarchy information
 */
export interface CallInfo {
    name: string;
    file: string;
    children?: CallInfo[];
}

/**
 * Recursive type for extracted symbols with call hierarchy
 */
export interface ExtractedSymbol {
    name: string;
    kind: string;
    detail: string;
    startLine: number;
    endLine: number;
    children?: ExtractedSymbol[];
    calls?: CallInfo[];
    calledBy?: CallInfo[];
}

/**
 * Extract document symbols from a file using VS Code DocumentSymbolProvider.
 */
export async function extractSymbolsFromFile(fileUri: vscode.Uri): Promise<ExtractedSymbol[]> {
    try {
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            fileUri
        );

        if (!symbols || symbols.length === 0) {
            return [];
        }

        const kindToString = (kind: vscode.SymbolKind): string => {
            const kindMap: Record<number, string> = {
                [vscode.SymbolKind.File]: 'File',
                [vscode.SymbolKind.Class]: 'Class',
                [vscode.SymbolKind.Method]: 'Method',
                [vscode.SymbolKind.Function]: 'Function',
                [vscode.SymbolKind.Interface]: 'Interface',
                [vscode.SymbolKind.Enum]: 'Enum',
                [vscode.SymbolKind.EnumMember]: 'EnumMember',
                [vscode.SymbolKind.Struct]: 'Struct',
                [vscode.SymbolKind.Constructor]: 'Constructor',
                [vscode.SymbolKind.Property]: 'Property',
                [vscode.SymbolKind.Variable]: 'Variable',
                [vscode.SymbolKind.Constant]: 'Constant',
                [vscode.SymbolKind.Namespace]: 'Namespace',
                [vscode.SymbolKind.Module]: 'Module',
            };
            return kindMap[kind] || 'Symbol';
        };

        // Recursive helper to extract symbol and its children
        const extractSymbol = (symbol: vscode.DocumentSymbol): ExtractedSymbol => ({
            name: symbol.name,
            kind: kindToString(symbol.kind),
            detail: symbol.detail || '',
            startLine: symbol.range.start.line + 1,
            endLine: symbol.range.end.line + 1,
            children: symbol.children?.map(extractSymbol)
        });

        return symbols.map(extractSymbol);
    } catch (error) {
        logger.error('DeepWiki', `Failed to extract symbols from ${fileUri.fsPath}`, error);
        return [];
    }
}

/**
 * Extract call hierarchy (Calls/Called By) for a symbol using VS Code CallHierarchyProvider.
 * Returns calls up to specified depth.
 */
export async function extractCallHierarchy(
    fileUri: vscode.Uri,
    position: vscode.Position,
    depth: number = 2
): Promise<{
    calls: CallInfo[];
    calledBy: CallInfo[];
}> {
    try {
        // Prepare call hierarchy at the symbol position
        const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
            'vscode.prepareCallHierarchy',
            fileUri,
            position
        );

        if (!items || items.length === 0) {
            return { calls: [], calledBy: [] };
        }

        const item = items[0];

        // Get outgoing calls (what this function calls)
        const getOutgoingCalls = async (
            hierarchyItem: vscode.CallHierarchyItem,
            currentDepth: number
        ): Promise<CallInfo[]> => {
            if (currentDepth <= 0) return [];

            const outgoing = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
                'vscode.provideOutgoingCalls',
                hierarchyItem
            );

            if (!outgoing) return [];

            const results: CallInfo[] = [];
            for (const call of outgoing) {
                const callInfo: CallInfo = {
                    name: call.to.name,
                    file: vscode.workspace.asRelativePath(call.to.uri)
                };

                if (currentDepth > 1) {
                    const children = await getOutgoingCalls(call.to, currentDepth - 1);
                    if (children.length > 0) {
                        callInfo.children = children;
                    }
                }
                results.push(callInfo);
            }
            return results;
        };

        // Get incoming calls (what calls this function)
        const getIncomingCalls = async (
            hierarchyItem: vscode.CallHierarchyItem,
            currentDepth: number
        ): Promise<CallInfo[]> => {
            if (currentDepth <= 0) return [];

            const incoming = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
                'vscode.provideIncomingCalls',
                hierarchyItem
            );

            if (!incoming) return [];

            const results: CallInfo[] = [];
            for (const call of incoming) {
                const callInfo: CallInfo = {
                    name: call.from.name,
                    file: vscode.workspace.asRelativePath(call.from.uri)
                };

                if (currentDepth > 1) {
                    const children = await getIncomingCalls(call.from, currentDepth - 1);
                    if (children.length > 0) {
                        callInfo.children = children;
                    }
                }
                results.push(callInfo);
            }
            return results;
        };

        const [calls, calledBy] = await Promise.all([
            getOutgoingCalls(item, depth),
            getIncomingCalls(item, depth)
        ]);

        return { calls, calledBy };
    } catch (error) {
        // CallHierarchyProvider may not be available for all languages
        logger.log('DeepWiki', `CallHierarchy not available for ${fileUri.fsPath}: ${error}`);
        return { calls: [], calledBy: [] };
    }
}

/**
 * Enrich symbols with call hierarchy data.
 */
export async function enrichSymbolsWithCalls(
    fileUri: vscode.Uri,
    symbols: ExtractedSymbol[]
): Promise<ExtractedSymbol[]> {
    const enrichedSymbols: ExtractedSymbol[] = [];

    for (const symbol of symbols) {
        const position = new vscode.Position(symbol.startLine - 1, 0);
        const hierarchy = await extractCallHierarchy(fileUri, position, 2);

        const enrichedSymbol: ExtractedSymbol = {
            ...symbol,
            calls: hierarchy.calls,
            calledBy: hierarchy.calledBy
        };

        // Also enrich children with call hierarchy
        if (symbol.children) {
            enrichedSymbol.children = [];
            for (const child of symbol.children) {
                const childPosition = new vscode.Position(child.startLine - 1, 0);
                const childHierarchy = await extractCallHierarchy(fileUri, childPosition, 2);
                enrichedSymbol.children.push({
                    ...child,
                    calls: childHierarchy.calls,
                    calledBy: childHierarchy.calledBy
                });
            }
        }

        enrichedSymbols.push(enrichedSymbol);
    }

    return enrichedSymbols;
}

/**
 * Generate L2 markdown skeleton with call hierarchy data.
 */
export function generateL2Skeleton(
    filePath: string,
    symbols: ExtractedSymbol[]
): string {
    const lines: string[] = [];
    lines.push(`## ${filePath}`);

    // Helper to format calls with hierarchy
    const formatCalls = (calls: CallInfo[], indent: string = ''): string[] => {
        const result: string[] = [];
        for (const call of calls) {
            result.push(`${indent}- ${call.name} (${call.file})`);
            if (call.children && call.children.length > 0) {
                result.push(...formatCalls(call.children, indent + '  '));
            }
        }
        return result;
    };

    // Recursive helper to generate skeleton for nested symbols
    const addSymbol = (
        symbol: ExtractedSymbol,
        depth: number,
        parentName: string = ''
    ) => {
        const fullName = parentName ? `${parentName}.${symbol.name}` : symbol.name;
        const signature = symbol.detail ? `${symbol.name}${symbol.detail}` : symbol.name;
        const hasChildren = !!(symbol.children && symbol.children.length > 0);
        const headingLevel = '#'.repeat(Math.min(depth + 2, 6)); // ### for depth 1, #### for depth 2, etc.

        lines.push(`${headingLevel} \`${signature}\``);
        lines.push(`**Kind**: ${symbol.kind}`);
        lines.push(`**Lines**: ${symbol.startLine}-${symbol.endLine}`);

        // Show detail if available (type signature, return type, etc.)
        if (symbol.detail) {
            lines.push(`**Detail**: ${symbol.detail}`);
        }

        // Only add call sections for leaf nodes (no children)
        if (!hasChildren) {
            // Render Calls (programmatically generated)
            if (symbol.calls && symbol.calls.length > 0) {
                lines.push('**Calls**:');
                lines.push(...formatCalls(symbol.calls));
            } else {
                lines.push('**Calls**: (none detected)');
            }

            // Render Called By (programmatically generated)
            if (symbol.calledBy && symbol.calledBy.length > 0) {
                lines.push('**Called By**:');
                lines.push(...formatCalls(symbol.calledBy));
            } else {
                lines.push('**Called By**: (none detected)');
            }
        }

        // Recursively add children
        if (symbol.children) {
            for (const child of symbol.children) {
                addSymbol(child, depth + 1, fullName);
            }
        }

        // Add separator and blank line at top level
        if (depth === 1) {
            lines.push('');
            lines.push('---');
            lines.push('');
        } else {
            // Add blank line between child symbols
            lines.push('');
        }
    };

    for (const symbol of symbols) {
        addSymbol(symbol, 1);
    }

    return lines.join('\n');
}
