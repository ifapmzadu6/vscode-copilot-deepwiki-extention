import * as vscode from 'vscode';
import { logger } from './logger';

/**
 * LLMヘルパークラス
 * LLM呼び出しの共通処理を提供
 */
export class LLMHelper {
  private model: vscode.LanguageModelChat;
  private defaultMaxTokens: number;

  constructor(model: vscode.LanguageModelChat, defaultMaxTokens = 4096) {
    this.model = model;
    this.defaultMaxTokens = defaultMaxTokens;
  }

  /**
   * LLMにプロンプトを送信してレスポンスを取得
   */
  async generate(
    prompt: string,
    options?: {
      systemPrompt?: string;
      maxTokens?: number;
      temperature?: number;
    }
  ): Promise<string> {
    const messages: vscode.LanguageModelChatMessage[] = [];

    if (options?.systemPrompt) {
      messages.push(vscode.LanguageModelChatMessage.User(options.systemPrompt));
    }

    messages.push(vscode.LanguageModelChatMessage.User(prompt));

    const response = await this.model.sendRequest(
      messages,
      {
        justification: 'DeepWiki documentation generation',
      },
      new vscode.CancellationTokenSource().token
    );

    let result = '';
    for await (const chunk of response.text) {
      result += chunk;
    }

    return result.trim();
  }

  /**
   * JSON形式でレスポンスを取得
   */
  async generateJson<T>(
    prompt: string,
    options?: {
      systemPrompt?: string;
      maxTokens?: number;
    }
  ): Promise<T | null> {
    const jsonPrompt = `${prompt}

IMPORTANT: Respond ONLY with valid JSON. No markdown, no explanations, just the JSON object.`;

    const response = await this.generate(jsonPrompt, options);
    
    try {
      // JSONブロックを抽出
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) || 
                       response.match(/(\{[\s\S]*\})/);
      
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1].trim()) as T;
      }
      
      return JSON.parse(response) as T;
    } catch (error) {
      logger.error('LLMHelper', 'Failed to parse JSON response:', error);
      logger.error('LLMHelper', `Raw response: ${response}`);
      return null;
    }
  }

  /**
   * JSON取得（厳格版、最大2回リトライ）
   */
  async generateJsonStrict<T>(
    prompt: string,
    options?: {
      systemPrompt?: string;
      maxTokens?: number;
    }
  ): Promise<T | null> {
    const attempts = 2;
    let lastError: unknown = null;

    for (let i = 0; i < attempts; i++) {
      const response = await this.generateJson<T>(
        `${prompt}\n\nSTRICT: Respond only with JSON. No prose, no code fences.`,
        options
      );
      if (response) return response;
      lastError = new Error('Failed to parse JSON response');
    }

    logger.error('LLMHelper', 'generateJsonStrict failed', lastError);
    return null;
  }

  /**
   * 複数のプロンプトを並列実行
   */
  async generateParallel(
    prompts: Array<{ id: string; prompt: string; systemPrompt?: string }>
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    
    const promises = prompts.map(async ({ id, prompt, systemPrompt }) => {
      try {
        const response = await this.generate(prompt, { systemPrompt });
        return { id, response, error: null };
      } catch (error) {
        return { id, response: '', error };
      }
    });

    const responses = await Promise.all(promises);
    
    for (const { id, response, error } of responses) {
      if (!error) {
        results.set(id, response);
      } else {
        logger.error('LLMHelper', `Failed to generate for ${id}:`, error);
      }
    }

    return results;
  }

  /**
   * トークン数を推定（簡易版）
   */
  estimateTokens(text: string): number {
    // 英語: 約4文字/トークン、日本語: 約1.5文字/トークン
    // 平均的に3文字/トークンで計算
    return Math.ceil(text.length / 3);
  }

  /**
   * テキストをチャンクに分割
   */
  splitIntoChunks(text: string, maxTokensPerChunk: number): string[] {
    const chunks: string[] = [];
    const lines = text.split('\n');
    let currentChunk = '';
    let currentTokens = 0;

    for (const line of lines) {
      const lineTokens = this.estimateTokens(line);
      
      if (currentTokens + lineTokens > maxTokensPerChunk && currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
        currentTokens = 0;
      }
      
      currentChunk += line + '\n';
      currentTokens += lineTokens;
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }
}

/**
 * フィードバック結果
 */
export interface FeedbackResult<T> {
  original: T;
  improved: T;
  feedback: string;
  score: number;
  iterations: number;
}

/**
 * LLMフィードバックループ
 * 生成→レビュー→改善のサイクルを実行
 */
export class LLMFeedbackLoop {
  private helper: LLMHelper;
  private maxIterations: number;
  private targetScore: number;

  constructor(
    model: vscode.LanguageModelChat,
    options?: {
      maxIterations?: number;
      targetScore?: number;
    }
  ) {
    this.helper = new LLMHelper(model);
    this.maxIterations = options?.maxIterations || 3;
    this.targetScore = options?.targetScore || 8;
  }

  /**
   * コンテンツを生成してフィードバックループで改善
   */
  async generateWithFeedback(
    generatePrompt: string,
    reviewPrompt: (content: string) => string,
    improvePrompt: (content: string, feedback: string) => string,
    options?: {
      systemPrompt?: string;
    }
  ): Promise<FeedbackResult<string>> {
    // 1. 初期生成
    let content = await this.helper.generate(generatePrompt, options);
    const original = content;
    let feedback = '';
    let score = 0;
    let iterations = 0;

    // 2. フィードバックループ
    for (let i = 0; i < this.maxIterations; i++) {
      iterations++;
      
      // 2a. レビュー
      const reviewResponse = await this.helper.generateJsonStrict<{
        score: number;
        feedback: string;
        issues: string[];
        suggestions: string[];
      }>(reviewPrompt(content));

      if (!reviewResponse) {
        logger.warn('LLMFeedbackLoop', 'Failed to get review response');
        break;
      }

      score = reviewResponse.score;
      feedback = reviewResponse.feedback;

      logger.log('LLMFeedbackLoop', `Iteration ${i + 1}: Score ${score}/10`);

      // 2b. 目標スコアに達したら終了
      if (score >= this.targetScore) {
        logger.log('LLMFeedbackLoop', `Target score reached: ${score}`);
        break;
      }

      // 2c. 改善
      const improveFeedback = `
Score: ${score}/10
Feedback: ${feedback}
Issues: ${reviewResponse.issues.join(', ')}
Suggestions: ${reviewResponse.suggestions.join(', ')}
`;
      
      content = await this.helper.generate(
        improvePrompt(content, improveFeedback),
        options
      );
    }

    return {
      original,
      improved: content,
      feedback,
      score,
      iterations,
    };
  }

  /**
   * 複数セクションを並列でフィードバック改善
   */
  async generateSectionsWithFeedback(
    sections: Array<{
      id: string;
      generatePrompt: string;
      context?: string;
    }>,
    reviewPromptTemplate: (sectionId: string, content: string) => string,
    improvePromptTemplate: (sectionId: string, content: string, feedback: string) => string
  ): Promise<Map<string, FeedbackResult<string>>> {
    const results = new Map<string, FeedbackResult<string>>();

    // 並列実行（ただしAPI制限に注意）
    const batchSize = 3; // 同時実行数を制限
    
    for (let i = 0; i < sections.length; i += batchSize) {
      const batch = sections.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (section) => {
        const result = await this.generateWithFeedback(
          section.generatePrompt,
          (content) => reviewPromptTemplate(section.id, content),
          (content, feedback) => improvePromptTemplate(section.id, content, feedback)
        );
        return { id: section.id, result };
      });

      const batchResults = await Promise.all(batchPromises);
      
      for (const { id, result } of batchResults) {
        results.set(id, result);
      }
    }

    return results;
  }

  /**
   * ドキュメント全体のレビューと改善
   */
  async reviewAndImproveDocument(
    document: string,
    criteria: string[]
  ): Promise<{
    improved: string;
    report: {
      overallScore: number;
      criteriaScores: Map<string, number>;
      improvements: string[];
    };
  }> {
    // 1. 評価基準ごとにレビュー
    const criteriaReviews = new Map<string, { score: number; feedback: string }>();
    
    for (const criterion of criteria) {
      const reviewPrompt = `
Review the following documentation based on this criterion: "${criterion}"

Documentation:
${document}

Respond with JSON:
{
  "score": <1-10>,
  "feedback": "<specific feedback>",
  "examples_of_issues": ["<issue1>", "<issue2>"],
  "suggestions": ["<suggestion1>", "<suggestion2>"]
}
`;
      const review = await this.helper.generateJson<{
        score: number;
        feedback: string;
        examples_of_issues: string[];
        suggestions: string[];
      }>(reviewPrompt);

      if (review) {
        criteriaReviews.set(criterion, {
          score: review.score,
          feedback: review.feedback,
        });
      }
    }

    // 2. 全体スコアを計算
    const scores = Array.from(criteriaReviews.values()).map((r) => r.score);
    const overallScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    // 3. 改善が必要な場合
    let improved = document;
    const improvements: string[] = [];

    if (overallScore < this.targetScore) {
      const feedbackSummary = Array.from(criteriaReviews.entries())
        .filter(([_, review]) => review.score < this.targetScore)
        .map(([criterion, review]) => `- ${criterion}: ${review.feedback}`)
        .join('\n');

      const improvePrompt = `
Improve the following documentation based on this feedback:

${feedbackSummary}

Original Documentation:
${document}

Provide the improved documentation. Keep the same structure but enhance the content based on the feedback.
`;

      improved = await this.helper.generate(improvePrompt);
      improvements.push(...feedbackSummary.split('\n'));
    }

    return {
      improved,
      report: {
        overallScore,
        criteriaScores: new Map(
          Array.from(criteriaReviews.entries()).map(([k, v]) => [k, v.score])
        ),
        improvements,
      },
    };
  }

  /**
   * LLMHelperを取得
   */
  getHelper(): LLMHelper {
    return this.helper;
  }
}
