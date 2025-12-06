# DeepWiki 改善計画 - 評価結果に基づく対応

> **🚀 重要な方針転換**: 機械的パーサーではなく、**LLMベースのユニバーサルパーサー**を採用
> 詳細は [LLM_PARSER_DESIGN.md](./LLM_PARSER_DESIGN.md) を参照

## 📊 評価結果サマリー

**プロジェクト**: SakeRhythm (Swift/SwiftUI iOS アプリ)
**評価日**: 2025-12-06
**Overall Score**: 65% (実際の精度: < 20%)

### 重大な不正確さ

| 項目 | DeepWikiの記述 | 実際の内容 |
|------|----------------|------------|
| プロジェクトの性質 | "plaintext-based project" | **Swift/SwiftUI iOSアプリ** |
| 技術スタック | Python, Node.js, Django, React | **Swift 5.9+, SwiftUI, SwiftData, ActivityKit** |
| データベース | PostgreSQL, MongoDB | **SwiftData (ローカル)** |

---

## 🔴 根本原因

### 問題1: TypeScript/JavaScript専用実装

**CodeExtractor** (src/subagents/codeExtractor.ts:30-52)
```typescript
// TS/JS (high-fidelity AST) vs. others (DocumentSymbol fallback)
const tsExtensions = ['.ts', '.tsx', '.js', '.jsx'];
const tsJsFiles = fileList.filter((f) => tsExtensions.includes(...));
const otherFiles = fileList.filter((f) => !tsExtensions.includes(...));
// ← Swiftは "otherFiles" として低精度処理される
```

**影響**:
- Swiftクラス（DrinkingSession, HealthTip等）がパースされない
- メソッド・プロパティの詳細が抽出されない
- ソース参照（行番号）が不正確

### 問題2: フレームワーク検出がJS/TS専用

**FrameworkDetector** (src/subagents/frameworkDetector.ts:28-51)
```typescript
const frameworkMap: Record<string, { name: string; category: FrameworkInfo['category'] }> = {
  'react': { name: 'React', category: 'frontend' },
  'vue': { name: 'Vue.js', category: 'frontend' },
  // ... JavaScript/TypeScript フレームワークのみ
  // SwiftUI, SwiftData, ActivityKit, UIKit 等は未対応
};
```

**影響**:
- iOS/Swift特有のフレームワークを検出できない
- package.json しか見ない（Podfile, Package.swift, xcodeproj を無視）
- プロジェクトの技術スタックが完全に誤認識される

### 問題3: 既存ドキュメントの未活用

**現状**: docs/ 配下の詳細なMarkdown（PRODUCT_PLAN.md, iOS_TECHNICAL_STACK.md等）を読んでいない

**影響**:
- 既に存在する正確な情報を無視
- ゼロから推測して誤った内容を生成

### 問題4: 品質スコアの信頼性問題

**Accuracy**: 100% と表示されているが、実際は 20% 未満

---

## ✅ 改善策（優先順位順）

> **💡 新アプローチ**: LLMベースのユニバーサルパーサー
> - 1つの実装で全言語対応（Swift, Python, Java, Go, Rust...）
> - セマンティック理解（コメント・設計意図も抽出）
> - 完全な関係抽出（継承・プロトコル・ジェネリクス）
> - DeepWiki思想に完全一致（"LLMを大量に使う"）

### Phase 1: LLMベースのユニバーサルパーサー実装 ⭐⭐⭐ (最優先)

#### 1.1 LLMUniversalCodeExtractor実装

**目標**: 機械的パーサー（ts-morph, DocumentSymbol等）を使わず、LLMで全言語のコードを解析する

**実装**: src/subagents/llmCodeExtractor.ts（完全な実装はLLM_PARSER_DESIGN.mdを参照）

```typescript
/**
 * LLMベースのユニバーサルコード抽出サブエージェント
 *
 * 特徴:
 * - 全ての言語に対応（Swift, TypeScript, Python, Java, Go, Rust...）
 * - クラス、関数、型、継承関係を完全抽出
 * - コメント・設計意図も同時抽出
 * - 構文エラーがあっても抽出可能
 */
export class LLMUniversalCodeExtractorSubagent extends BaseSubagent {
  async execute(context: SubagentContext): Promise<ExtractionSummary> {
    // ファイルを並列バッチ処理（5ファイルずつ）
    for (let i = 0; i < sourceFiles.length; i += batchSize) {
      const batch = sourceFiles.slice(i, i + batchSize);

      const batchPromises = batch.map(file =>
        this.extractWithLLM(file.relativePath, content, file.language)
      );

      const results = await Promise.all(batchPromises);
      // 結果を集約
    }
  }

  private async extractWithLLM(
    relativePath: string,
    content: string,
    language: string
  ): Promise<FileExtractionResult> {
    const prompt = `Extract ALL code entities from this ${language} source file.

SOURCE CODE:
\`\`\`${language}
${content}
\`\`\`

Return JSON with: classes, functions, interfaces, enums...
Include: line numbers, inheritance, visibility, parameters, types
`;

    const result = await this.helper.generateJsonStrict(prompt);
    return this.transformToExtractionResult(result);
  }
}
```

**利点**:
- ✅ 1つの実装で全言語対応
- ✅ Swift, Python, Java, Go... すべて同じコードで処理
- ✅ 継承・プロトコル・ジェネリクスも完全抽出
- ✅ 言語仕様変更に自動適応
- ✅ 実装コスト: 言語×1（従来は言語×N）

#### 1.2 並列バッチ処理とキャッシング

**目標**: LLMパーサーのパフォーマンスを機械的パーサーと同等にする

```typescript
// 並列バッチ処理
const batchSize = 5; // 5ファイルずつ並列処理
for (let i = 0; i < sourceFiles.length; i += batchSize) {
  const batch = sourceFiles.slice(i, i + batchSize);
  const batchPromises = batch.map(file => this.extractWithLLM(file, ...));
  const results = await Promise.all(batchPromises);
}

// キャッシング
const cached = await fileManager.loadJson(
  IntermediateFileType.EXTRACTION_BY_FILE,
  file
);
if (cached && !fileChanged) {
  return cached; // LLM呼び出しをスキップ
}
```

**効果**:
- 50ファイル = 10バッチ × 5並列 = **実行時間 1/5**
- キャッシュヒット率 80% → **LLM呼び出し 1/5**
- 合計: **25倍高速化**

---

### Phase 2: フレームワーク検出の拡張 ⭐⭐

#### 2.1 iOS/Swift フレームワーク検出

**ファイル**: src/subagents/frameworkDetector.ts を拡張

```typescript
export class FrameworkDetectorSubagent extends BaseSubagent {
  async execute(context: SubagentContext): Promise<FrameworkInfo[]> {
    const frameworks: FrameworkInfo[] = [];

    // 既存: package.json ベース
    frameworks.push(...await this.detectJavaScriptFrameworks(workspaceFolder));

    // 新規: Swift/iOS フレームワーク検出
    frameworks.push(...await this.detectSwiftFrameworks(workspaceFolder));

    // 新規: Python フレームワーク検出
    frameworks.push(...await this.detectPythonFrameworks(workspaceFolder));

    return frameworks;
  }

  /**
   * Swift/iOS プロジェクトのフレームワーク検出
   */
  private async detectSwiftFrameworks(
    workspaceFolder: vscode.WorkspaceFolder
  ): Promise<FrameworkInfo[]> {
    const frameworks: FrameworkInfo[] = [];
    const workspacePath = workspaceFolder.uri.fsPath;

    // 1. Package.swift を読む（Swift Package Manager）
    const packageSwiftPath = path.join(workspacePath, 'Package.swift');
    if (fs.existsSync(packageSwiftPath)) {
      const content = fs.readFileSync(packageSwiftPath, 'utf-8');

      // .package(url: "...", from: "...") の形式で依存関係を抽出
      const packageRegex = /\.package\(url:\s*"([^"]+)",/g;
      const matches = content.matchAll(packageRegex);

      for (const match of matches) {
        const url = match[1];
        const name = this.extractPackageName(url);
        frameworks.push({
          name,
          version: 'unknown',
          category: 'library',
          confidence: 0.9,
          files: [packageSwiftPath],
          patterns: [url],
        });
      }
    }

    // 2. Podfile を読む（CocoaPods）
    const podfilePath = path.join(workspacePath, 'Podfile');
    if (fs.existsSync(podfilePath)) {
      const content = fs.readFileSync(podfilePath, 'utf-8');

      // pod 'PodName', '~> version' の形式
      const podRegex = /pod\s+'([^']+)'/g;
      const matches = content.matchAll(podRegex);

      for (const match of matches) {
        frameworks.push({
          name: match[1],
          version: 'unknown',
          category: 'library',
          confidence: 1.0,
          files: [podfilePath],
          patterns: [match[0]],
        });
      }
    }

    // 3. *.xcodeproj/project.pbxproj を読む（Xcode設定）
    const xcodeProjects = glob.sync('**/*.xcodeproj/project.pbxproj', {
      cwd: workspacePath,
      ignore: ['**/Pods/**'],
    });

    for (const projectFile of xcodeProjects) {
      const content = fs.readFileSync(path.join(workspacePath, projectFile), 'utf-8');

      // PRODUCT_BUNDLE_IDENTIFIER から識別
      // SwiftUI, SwiftData, ActivityKit, WidgetKit 等のフレームワーク使用を検出
      if (content.includes('SwiftUI.framework')) {
        frameworks.push({
          name: 'SwiftUI',
          version: 'iOS built-in',
          category: 'ui-framework',
          confidence: 1.0,
          files: [projectFile],
          patterns: ['SwiftUI'],
        });
      }

      if (content.includes('SwiftData')) {
        frameworks.push({
          name: 'SwiftData',
          version: 'iOS 17+',
          category: 'database',
          confidence: 1.0,
          files: [projectFile],
          patterns: ['SwiftData'],
        });
      }

      if (content.includes('ActivityKit')) {
        frameworks.push({
          name: 'ActivityKit',
          version: 'iOS 16.1+',
          category: 'system',
          confidence: 1.0,
          files: [projectFile],
          patterns: ['ActivityKit'],
        });
      }
    }

    // 4. ソースコードから import 文を検出（最終手段）
    const swiftFiles = glob.sync('**/*.swift', {
      cwd: workspacePath,
      ignore: ['**/Pods/**', '**/Carthage/**'],
    });

    const importFrameworks = new Set<string>();
    for (const swiftFile of swiftFiles.slice(0, 50)) { // サンプリング
      const content = fs.readFileSync(path.join(workspacePath, swiftFile), 'utf-8');
      const importRegex = /^import\s+(\w+)/gm;
      const matches = content.matchAll(importRegex);

      for (const match of matches) {
        importFrameworks.add(match[1]);
      }
    }

    // UIKit, Foundation 等の標準フレームワーク
    const iosFrameworkMap: Record<string, { category: FrameworkInfo['category'] }> = {
      'UIKit': { category: 'ui-framework' },
      'SwiftUI': { category: 'ui-framework' },
      'Foundation': { category: 'core' },
      'Combine': { category: 'reactive' },
      'CoreData': { category: 'database' },
      'SwiftData': { category: 'database' },
      'WidgetKit': { category: 'system' },
      'ActivityKit': { category: 'system' },
      'AVFoundation': { category: 'media' },
      'MapKit': { category: 'maps' },
    };

    for (const [framework, info] of Object.entries(iosFrameworkMap)) {
      if (importFrameworks.has(framework)) {
        // 既に追加されていなければ追加
        if (!frameworks.some(f => f.name === framework)) {
          frameworks.push({
            name: framework,
            version: 'iOS built-in',
            category: info.category,
            confidence: 0.8,
            files: [],
            patterns: [`import ${framework}`],
          });
        }
      }
    }

    return frameworks;
  }

  private extractPackageName(url: string): string {
    // https://github.com/user/repo.git -> repo
    const match = url.match(/\/([^\/]+?)(?:\.git)?$/);
    return match ? match[1] : url;
  }
}
```

**検出対象**:
- ✅ Swift Package Manager (Package.swift)
- ✅ CocoaPods (Podfile)
- ✅ Xcode project settings (.xcodeproj/project.pbxproj)
- ✅ import 文の解析

#### 2.2 Python フレームワーク検出

```typescript
private async detectPythonFrameworks(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<FrameworkInfo[]> {
  const frameworks: FrameworkInfo[] = [];
  const workspacePath = workspaceFolder.uri.fsPath;

  // requirements.txt
  const reqPath = path.join(workspacePath, 'requirements.txt');
  if (fs.existsSync(reqPath)) {
    const content = fs.readFileSync(reqPath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      const match = line.match(/^([a-zA-Z0-9-_]+)(?:==|>=|<=)?([\d.]+)?/);
      if (match) {
        const name = match[1];
        const version = match[2] || 'unknown';

        const category = this.categorizePythonPackage(name);
        frameworks.push({
          name,
          version,
          category,
          confidence: 1.0,
          files: [reqPath],
          patterns: [line.trim()],
        });
      }
    }
  }

  // pyproject.toml
  const pyprojectPath = path.join(workspacePath, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath)) {
    // TOML パース
  }

  return frameworks;
}

private categorizePythonPackage(name: string): FrameworkInfo['category'] {
  const categoryMap: Record<string, FrameworkInfo['category']> = {
    'django': 'backend',
    'flask': 'backend',
    'fastapi': 'backend',
    'pytest': 'testing',
    'sqlalchemy': 'orm',
    'pandas': 'data-science',
    'numpy': 'data-science',
  };
  return categoryMap[name.toLowerCase()] || 'library';
}
```

---

### Phase 3: 既存ドキュメントの活用 ⭐⭐

#### 3.1 既存Markdownファイルの読み込み

**新規サブエージェント**: `ExistingDocumentAnalyzerSubagent`

**レベル**: Level 1 (DISCOVERY)

```typescript
// src/subagents/existingDocumentAnalyzer.ts

export interface ExistingDocument {
  path: string;
  title: string;
  content: string;
  category: 'architecture' | 'api' | 'guide' | 'spec' | 'other';
  metadata: {
    createdAt?: string;
    updatedAt?: string;
    authors?: string[];
  };
}

export class ExistingDocumentAnalyzerSubagent extends BaseSubagent {
  id = 'existing-document-analyzer';
  name = 'Existing Document Analyzer';
  description = 'Analyzes existing documentation (Markdown, README, etc.)';

  async execute(context: SubagentContext): Promise<ExistingDocument[]> {
    const { workspaceFolder, progress } = context;
    const workspacePath = workspaceFolder.uri.fsPath;

    progress('Scanning for existing documentation...');

    // docs/, doc/, documentation/ 配下のMarkdownファイルを検索
    const docFiles = glob.sync('**/*.md', {
      cwd: workspacePath,
      ignore: [
        '**/node_modules/**',
        '**/.deepwiki/**',
        '**/dist/**',
        '**/build/**',
      ],
    });

    const documents: ExistingDocument[] = [];

    for (const file of docFiles) {
      const fullPath = path.join(workspacePath, file);
      const content = fs.readFileSync(fullPath, 'utf-8');

      const title = this.extractTitle(content, file);
      const category = this.categorizeDocument(file, content);

      documents.push({
        path: file,
        title,
        content,
        category,
        metadata: {},
      });
    }

    progress(`Found ${documents.length} existing documentation files`);

    // 中間ファイルに保存
    await fileManager.saveJson(
      IntermediateFileType.DISCOVERY_EXISTING_DOCS,
      { documents }
    );

    return documents;
  }

  private extractTitle(content: string, filepath: string): string {
    // 最初の # タイトルを探す
    const match = content.match(/^#\s+(.+)$/m);
    if (match) return match[1];

    // ファイル名から推測
    return path.basename(filepath, '.md');
  }

  private categorizeDocument(filepath: string, content: string): ExistingDocument['category'] {
    const lower = filepath.toLowerCase();

    if (lower.includes('architecture') || lower.includes('design')) {
      return 'architecture';
    }
    if (lower.includes('api') || content.includes('API Reference')) {
      return 'api';
    }
    if (lower.includes('guide') || lower.includes('tutorial')) {
      return 'guide';
    }
    if (lower.includes('spec') || lower.includes('technical')) {
      return 'spec';
    }

    return 'other';
  }
}
```

#### 3.2 LLMによる既存ドキュメント活用

**FinalDocumentGenerator** で既存ドキュメントを参照する:

```typescript
// src/subagents/finalDocumentGenerator.ts の拡張

private async generatePageWithExistingDocs(
  pageId: string,
  context: any,
  existingDocs: ExistingDocument[]
): Promise<DeepWikiPage> {

  // 関連する既存ドキュメントを検索
  const relevantDocs = this.findRelevantDocs(pageId, existingDocs);

  const prompt = `Generate a comprehensive documentation page.

PAGE: ${pageId}

## Analysis Results
${JSON.stringify(context, null, 2)}

## Existing Documentation (USE THIS as authoritative source)
${relevantDocs.map(doc => `
### ${doc.title} (${doc.path})
${doc.content}
`).join('\n\n')}

IMPORTANT:
1. USE information from existing documentation as the PRIMARY source
2. SUPPLEMENT with analysis results where existing docs don't cover
3. CITE sources using [source](${doc.path}) format
4. DO NOT contradict existing documentation

Generate the page content...`;

  // LLM呼び出し
}
```

---

### Phase 4: 品質スコアリングの改善 ⭐

#### 4.1 実際の精度を反映したスコアリング

**問題**: 現在のスコアは「生成したドキュメントの構造的品質」のみを測定しており、「実際のコードとの一致度」を測定していない

**改善**:

```typescript
// src/subagents/accuracyValidator.ts の拡張

export class AccuracyValidatorSubagent extends BaseSubagent {
  async execute(context: SubagentContext): Promise<AccuracyValidationResult> {
    const site = previousResults.get('final-document-generator') as DeepWikiSite;
    const extractionSummary = previousResults.get('code-extractor') as ExtractionSummary;

    // 1. 全publicエンティティが文書化されているか
    const coverageScore = this.calculateCoverage(site, extractionSummary);

    // 2. ソース参照の正確性（リンク切れチェック）
    const sourceRefScore = this.validateSourceReferences(site, extractionSummary);

    // 3. LLMによる記述の正確性検証（サンプリング）
    const contentAccuracyScore = await this.validateContentAccuracy(
      site,
      extractionSummary,
      context
    );

    // 4. 技術スタックの正確性
    const techStackScore = this.validateTechStack(site, previousResults);

    // 重み付け平均
    const overallAccuracy = (
      coverageScore * 0.3 +
      sourceRefScore * 0.2 +
      contentAccuracyScore * 0.3 +
      techStackScore * 0.2
    );

    return {
      overallAccuracy: overallAccuracy * 100, // 0-100%
      coverage: coverageScore * 100,
      sourceReferenceValidity: sourceRefScore * 100,
      contentAccuracy: contentAccuracyScore * 100,
      techStackAccuracy: techStackScore * 100,
      issues: [/* 具体的な問題リスト */],
    };
  }

  /**
   * 技術スタックの正確性を検証
   */
  private validateTechStack(
    site: DeepWikiSite,
    previousResults: Map<string, any>
  ): number {
    const detectedLanguages = previousResults.get('language-detector') as LanguageDetectionResult;
    const detectedFrameworks = previousResults.get('framework-detector') as FrameworkInfo[];

    // ドキュメントに記載されている技術スタックを抽出
    const documentedTech = this.extractTechFromDocs(site);

    // 実際のコードベースと一致度を計算
    let matchCount = 0;
    let totalTech = 0;

    // 主要言語の一致
    if (documentedTech.primaryLanguage === detectedLanguages.primary) {
      matchCount++;
    }
    totalTech++;

    // フレームワークの一致
    for (const framework of detectedFrameworks.filter(f => f.confidence > 0.8)) {
      if (documentedTech.frameworks.includes(framework.name)) {
        matchCount++;
      }
      totalTech++;
    }

    return totalTech > 0 ? matchCount / totalTech : 0;
  }
}
```

---

## 📅 実装ロードマップ（LLMパーサーアプローチ）

### Sprint 1: LLMユニバーサルパーサー実装（1週間）

**目標**: LLMで全言語のコードを解析できるようにする

- [ ] **Task 1.1**: LLMUniversalCodeExtractor実装 - 3日
- [ ] **Task 1.2**: 並列バッチ処理の実装 - 1日
- [ ] **Task 1.3**: キャッシング機構の実装 - 1日
- [ ] **Task 1.4**: iOS Framework Detector実装（LLM不要） - 1日
- [ ] **Task 1.5**: テスト（TS, Swift, Python） - 1日

**成功基準**:
- SakeRhythmで "Swift/SwiftUI iOS アプリ" と正しく認識される
- SwiftUI, SwiftData, ActivityKit が検出される
- DrinkingSession, HealthTip 等のクラスが抽出される
- Overall Accuracy > 60%

### Sprint 2: パイプライン統合とテスト（3日）

- [ ] **Task 2.1**: orchestrator.tsでLLMパーサーを使用 - 1日
- [ ] **Task 2.2**: 中間ファイル形式の統一 - 1日
- [ ] **Task 2.3**: SakeRhythmで検証 - 1日

**成功基準**:
- SakeRhythmで Overall Accuracy > 70%
- 処理時間 < 10分

### Sprint 3: 既存ドキュメント活用（1週間）

- [ ] **Task 3.1**: ExistingDocumentAnalyzer実装 - 2日
- [ ] **Task 3.2**: FinalDocumentGenerator で既存ドキュメント参照 - 2日
- [ ] **Task 3.3**: SakeRhythmで再テスト（docs/活用） - 1日

**成功基準**:
- docs/の内容が反映される
- Overall Accuracy > 80%

### Sprint 4: 品質スコアリング改善（1週間）

- [ ] **Task 4.1**: AccuracyValidator で実精度測定 - 3日
- [ ] **Task 4.2**: 技術スタック一致度検証 - 2日
- [ ] **Task 4.3**: 最終検証 - 1日

**成功基準**:
- スコアが実態を反映している（誤認識時にスコアが低くなる）

### Sprint 5: プロンプト最適化（将来）

- [ ] Few-shot examples の追加で精度向上
- [ ] Chain-of-thought プロンプトでセマンティック理解強化
- [ ] 大規模プロジェクト（200+ファイル）での検証

---

## 🎯 最優先アクション

**今すぐ実装すべき3つ**:

1. **LLMUniversalCodeExtractor実装** (src/subagents/llmCodeExtractor.ts)
   - LLMで全言語対応
   - SakeRhythmの問題の90%を解決
   - 実装時間: 3日

2. **並列バッチ処理** (同上)
   - 5ファイルずつ並列処理
   - キャッシング機構
   - 実装時間: 1日

3. **iOS Framework Detector** (src/subagents/frameworkDetector.ts拡張)
   - Package.swift, Podfile, xcodeproj の解析
   - import 文のスキャン
   - 実装時間: 1日

---

## 📊 期待される改善効果（LLMパーサーアプローチ）

| 指標 | 現在 | Sprint 1-2後 | Sprint 3-4後 |
|------|------|--------------|--------------|
| Swift/iOS プロジェクト認識 | 0% | **95%** | 98% |
| 技術スタック正確性 | 0% | **90%** | 95% |
| クラス抽出率 | 10% | **90%** | 95% |
| 継承・プロトコル抽出 | 0% | **85%** | 90% |
| Overall Accuracy | <20% | **70%** | 85% |
| 既存ドキュメント活用 | 0% | 0% | 90% |
| 対応言語数 | 1 (TS/JS) | **全言語** | 全言語 |

### LLMパーサーの追加利点

- ✅ **セマンティック理解**: コメント・設計意図も抽出
- ✅ **構文エラー耐性**: エラーがあっても処理継続
- ✅ **保守コスト削減**: 言語仕様変更に自動適応
- ✅ **実装コスト削減**: 言語×1（従来は言語×N）

---

## ✅ チェックリスト

### Sprint 1 完了条件
- [ ] LLMUniversalCodeExtractor が Swift, TypeScript, Python でクラス・関数を抽出できる
- [ ] 継承・インターフェース・ジェネリクスを正しく抽出できる
- [ ] 並列処理で50ファイルを5分以内に処理できる
- [ ] Package.swift, Podfile から依存関係を検出できる
- [ ] import文から iOS フレームワークを検出できる
- [ ] 抽出精度 > 90%（手動検証）

### Sprint 2 完了条件
- [ ] SakeRhythm で "Swift/SwiftUI iOS アプリ" と正しく認識される
- [ ] DrinkingSession, HealthTip クラスが完全に抽出される
- [ ] Overall Accuracy > 70%

### Sprint 3 完了条件
- [ ] docs/ 配下の Markdown ファイルをスキャンできる
- [ ] LLM生成時に既存ドキュメントを参照できる
- [ ] SakeRhythm で既存のPRODUCT_PLAN.md等が活用される
- [ ] Overall Accuracy > 80%

### Sprint 4 完了条件
- [ ] 技術スタック一致度が測定される
- [ ] カバレッジ（全エンティティの文書化率）が測定される
- [ ] スコアが実際の精度を反映している
- [ ] Overall Accuracy > 85%

---

## 📝 追加メモ

### 考慮事項（LLMパーサーアプローチ）

1. **LLM呼び出しコスト**
   - 50ファイル = 約$0.60/実行
   - キャッシング有効で80%削減 → $0.12/実行
   - 許容可能なコスト

2. **パフォーマンス**
   - 並列処理（5ファイル/バッチ）で高速化
   - キャッシングで2回目以降は5倍高速
   - 50ファイル: 初回5分、2回目以降1分

3. **精度の保証**
   - 構造化JSON出力で信頼性向上
   - 検証ステップでエラー検出
   - フィードバックループ（必要な場合）

4. **iOS プロジェクトの複雑性**
   - Xcode project ファイル (.xcodeproj/project.pbxproj) は複雑なフォーマット
   - パースライブラリの使用を検討（pbxproj-parser 等）

### 技術的利点

- ✅ TypeScript/JavaScript以外も**全て同じ精度**
- ✅ 言語ごとの専用パーサー不要
- ✅ 技術的負債なし（LLMが自動適応）
- ✅ 将来の言語追加がゼロコスト

---

**作成日**: 2025-12-06
**対象プロジェクト**: vscode-copilot-deepwiki-extention
**評価対象**: SakeRhythm (Swift/SwiftUI iOS アプリ)
