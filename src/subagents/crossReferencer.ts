import * as vscode from 'vscode';
import * as path from 'path';
import { BaseSubagent } from './baseSubagent';
import { SubagentContext } from '../types';
import { ExtractionSummary, ExtractedClass, ExtractedFunction, ExtractedInterface, createSourceRef } from '../types/extraction';
import {
  CrossReferenceIndex,
  EntityCrossReference,
  EntityDefinition,
  EntityUsage,
} from '../types/relationships';
import { getIntermediateFileManager, IntermediateFileType, logger } from '../utils';

/**
 * クロスリファレンスサブエージェント
 *
 * Level 4: RELATIONSHIP
 *
 * 抽出結果からエンティティ間のクロスリファレンスを構築:
 * - クラス、関数、インターフェース、型の定義場所
 * - それぞれの使用箇所
 * - インポート関係
 *
 * 出力:
 * - .deepwiki/intermediate/relationships/cross-refs.json
 */
export class CrossReferencerSubagent extends BaseSubagent {
  id = 'cross-referencer';
  name = 'Cross Referencer';
  description = 'Creates cross-references between code entities';

  private fileManager: any;

  async execute(context: SubagentContext): Promise<CrossReferenceIndex> {
    const { progress, token, previousResults } = context;

    progress('Building cross-references...');

    this.fileManager = getIntermediateFileManager();

    // Get extraction results from Level 2
    const extractionResult = previousResults.get('code-extractor') as ExtractionSummary | undefined;

    if (!extractionResult) {
      progress('No extraction results found');
      return this.createEmptyIndex();
    }

    const byEntity = new Map<string, EntityCrossReference>();
    const byFile = new Map<string, string[]>();

    // Index classes
    for (const cls of extractionResult.classes) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      const entityId = this.createEntityId('class', cls.name, cls.file);
      const definition: EntityDefinition = {
        entityId,
        name: cls.name,
        type: 'class',
        file: cls.file,
        sourceRef: cls.sourceRef,
      };

      const crossRef: EntityCrossReference = {
        entityId,
        definition,
        usages: [],
        importedBy: [],
      };

      byEntity.set(entityId, crossRef);
      this.addToFileIndex(byFile, cls.file, entityId);

      // Index methods as separate entities
      for (const method of cls.methods) {
        const methodId = this.createEntityId('method', `${cls.name}.${method.name}`, cls.file);
        const methodDef: EntityDefinition = {
          entityId: methodId,
          name: method.name,
          type: 'method',
          file: cls.file,
          sourceRef: method.sourceRef,
        };

        byEntity.set(methodId, {
          entityId: methodId,
          definition: methodDef,
          usages: [],
          importedBy: [],
        });
        this.addToFileIndex(byFile, cls.file, methodId);
      }
    }

    // Index functions
    for (const func of extractionResult.functions) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      const entityId = this.createEntityId('function', func.name, func.file);
      const definition: EntityDefinition = {
        entityId,
        name: func.name,
        type: 'function',
        file: func.file,
        sourceRef: func.sourceRef,
      };

      byEntity.set(entityId, {
        entityId,
        definition,
        usages: [],
        importedBy: [],
      });
      this.addToFileIndex(byFile, func.file, entityId);
    }

    // Index interfaces
    for (const iface of extractionResult.interfaces) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      const entityId = this.createEntityId('interface', iface.name, iface.file);
      const definition: EntityDefinition = {
        entityId,
        name: iface.name,
        type: 'interface',
        file: iface.file,
        sourceRef: iface.sourceRef,
      };

      byEntity.set(entityId, {
        entityId,
        definition,
        usages: [],
        importedBy: [],
      });
      this.addToFileIndex(byFile, iface.file, entityId);
    }

    // Index type aliases
    for (const typeAlias of extractionResult.typeAliases) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      const entityId = this.createEntityId('type', typeAlias.name, typeAlias.file);
      const definition: EntityDefinition = {
        entityId,
        name: typeAlias.name,
        type: 'type',
        file: typeAlias.file,
        sourceRef: typeAlias.sourceRef,
      };

      byEntity.set(entityId, {
        entityId,
        definition,
        usages: [],
        importedBy: [],
      });
      this.addToFileIndex(byFile, typeAlias.file, entityId);
    }

    // Index enums
    for (const enumDef of extractionResult.enums) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      const entityId = this.createEntityId('enum', enumDef.name, enumDef.file);
      const definition: EntityDefinition = {
        entityId,
        name: enumDef.name,
        type: 'enum',
        file: enumDef.file,
        sourceRef: enumDef.sourceRef,
      };

      byEntity.set(entityId, {
        entityId,
        definition,
        usages: [],
        importedBy: [],
      });
      this.addToFileIndex(byFile, enumDef.file, entityId);
    }

    // Index constants
    for (const constant of extractionResult.constants) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      const entityId = this.createEntityId('const', constant.name, constant.file);
      const definition: EntityDefinition = {
        entityId,
        name: constant.name,
        type: 'const',
        file: constant.file,
        sourceRef: constant.sourceRef,
      };

      byEntity.set(entityId, {
        entityId,
        definition,
        usages: [],
        importedBy: [],
      });
      this.addToFileIndex(byFile, constant.file, entityId);
    }

    // Build usage relationships from imports
    for (const imp of extractionResult.imports) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      // Skip external imports
      if (imp.isExternal) {
        continue;
      }

      // Find entities that match the imported items
      for (const item of imp.items) {
        // Find entity by name (check all types)
        const matchingEntities = this.findEntitiesByName(byEntity, item);

        for (const entityRef of matchingEntities) {
          // Add import reference
          entityRef.importedBy.push({
            file: imp.file,
            line: imp.line,
            sourceRef: imp.sourceRef,
          });

          // Add usage
          entityRef.usages.push({
            entityId: entityRef.entityId,
            file: imp.file,
            line: imp.line,
            sourceRef: imp.sourceRef,
            usageType: 'import',
            context: `Imported from ${imp.source}`,
          });
        }
      }

      // Handle default import
      if (imp.defaultImport) {
        const matchingEntities = this.findEntitiesByName(byEntity, imp.defaultImport);
        for (const entityRef of matchingEntities) {
          entityRef.importedBy.push({
            file: imp.file,
            line: imp.line,
            sourceRef: imp.sourceRef,
          });
        }
      }
    }

    // Find extends/implements relationships
    for (const cls of extractionResult.classes) {
      if (cls.extends) {
        const parentEntities = this.findEntitiesByName(byEntity, cls.extends);
        for (const parent of parentEntities) {
          parent.usages.push({
            entityId: parent.entityId,
            file: cls.file,
            line: cls.startLine,
            sourceRef: cls.sourceRef,
            usageType: 'extends',
            context: `Extended by ${cls.name}`,
          });
        }
      }

      for (const impl of cls.implements) {
        const ifaceEntities = this.findEntitiesByName(byEntity, impl);
        for (const iface of ifaceEntities) {
          iface.usages.push({
            entityId: iface.entityId,
            file: cls.file,
            line: cls.startLine,
            sourceRef: cls.sourceRef,
            usageType: 'implements',
            context: `Implemented by ${cls.name}`,
          });
        }
      }
    }

    // Find orphans (entities with no usages)
    const orphans: string[] = [];
    for (const [entityId, crossRef] of byEntity) {
      if (crossRef.usages.length === 0 && crossRef.importedBy.length === 0) {
        orphans.push(entityId);
      }
    }

    // Calculate most used
    const usageCounts = Array.from(byEntity.entries())
      .map(([entityId, crossRef]) => ({
        entityId,
        usageCount: crossRef.usages.length + crossRef.importedBy.length,
      }))
      .filter((item) => item.usageCount > 0)
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, 20);

    const result: CrossReferenceIndex = {
      byEntity,
      byFile,
      orphans,
      mostUsed: usageCounts,
    };

    // Save to intermediate file (convert Map to serializable format)
    await this.fileManager.saveJson(IntermediateFileType.RELATIONSHIP_CROSS_REFS, {
      byEntity: Array.from(byEntity.entries()),
      byFile: Array.from(byFile.entries()),
      orphans,
      mostUsed: usageCounts,
    });

    progress(`Built cross-references: ${byEntity.size} entities, ${orphans.length} orphans`);

    return result;
  }

  /**
   * 空のインデックスを作成
   */
  private createEmptyIndex(): CrossReferenceIndex {
    return {
      byEntity: new Map(),
      byFile: new Map(),
      orphans: [],
      mostUsed: [],
    };
  }

  /**
   * エンティティIDを作成
   */
  private createEntityId(type: string, name: string, file: string): string {
    const fileName = path.basename(file, path.extname(file));
    return `${type}:${fileName}:${name}`;
  }

  /**
   * ファイルインデックスに追加
   */
  private addToFileIndex(byFile: Map<string, string[]>, file: string, entityId: string): void {
    if (!byFile.has(file)) {
      byFile.set(file, []);
    }
    byFile.get(file)!.push(entityId);
  }

  /**
   * 名前でエンティティを検索
   */
  private findEntitiesByName(
    byEntity: Map<string, EntityCrossReference>,
    name: string
  ): EntityCrossReference[] {
    const results: EntityCrossReference[] = [];

    for (const [entityId, crossRef] of byEntity) {
      if (crossRef.definition.name === name) {
        results.push(crossRef);
      }
    }

    return results;
  }
}
