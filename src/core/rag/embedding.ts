/**
 * OpenAI 兼容嵌入适配器（真实调用 /v1/embeddings）
 *
 * 对应 DESIGN.md 中 Provider 组件的嵌入模型（如 Pro/BAAI/bge-m3）。
 * - 零依赖：直接用 fetch，不引入 openai SDK（与参考设计"裸 HTTP 最透明"一致）
 * - 批量请求（默认 16 条/批，可配置）
 * - 自动重试（429/5xx，指数退避 + 抖动），超时保护
 * - 维度一致性校验（bge-m3 = 1024 维），响应乱序按 index 重排
 */

import type { EmbedFn } from './types.ts';

export interface OpenAICompatibleEmbeddingConfig {
  /** 网关地址：接受 `https://host/v1` 或 `https://host/v1/embeddings` */
  baseUrl: string;
  apiKey: string;
  /** 嵌入模型名，如 `Pro/BAAI/bge-m3` */
  model: string;
  /** 每批文本数，默认 16 */
  batchSize?: number;
  /** 失败重试次数（429/5xx），默认 2 */
  maxRetries?: number;
  /** 单次请求超时（ms），默认 60_000 */
  timeoutMs?: number;
  /** 期望的向量维度，设置后与返回不符即抛错（防模型配错） */
  dimensions?: number;
  /** 额外请求头 */
  headers?: Record<string, string>;
}

export interface EmbeddingResponseData {
  embedding: number[];
  index?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 归一化 baseUrl：统一到 .../embeddings 端点 */
const toEmbeddingsEndpoint = (baseUrl: string): string => {
  const cleaned = baseUrl.trim().replace(/\/+$/, '');
  return cleaned.endsWith('/embeddings') ? cleaned : `${cleaned}/embeddings`;
};

export class OpenAICompatibleEmbedder {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly dimensions?: number;
  private readonly headers: Record<string, string>;
  private observedDimension: number | null = null;

  constructor(config: OpenAICompatibleEmbeddingConfig) {
    if (!config.baseUrl || !config.apiKey || !config.model) {
      throw new Error('embedder: baseUrl / apiKey / model 均为必填');
    }
    this.endpoint = toEmbeddingsEndpoint(config.baseUrl);
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.batchSize = config.batchSize ?? 16;
    this.maxRetries = config.maxRetries ?? 2;
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.dimensions = config.dimensions;
    this.headers = config.headers ?? {};
  }

  /** 实现 EmbedFn：自动分批 */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const result: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      result.push(...(await this.embedBatch(batch)));
    }
    return result;
  }

  private async embedBatch(batch: string[]): Promise<number[][]> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.requestOnce(batch);
      } catch (err) {
        lastError = err;
        const retriable = isRetriable(err);
        if (!retriable || attempt === this.maxRetries) break;
        // 指数退避 + 抖动：500ms * 2^attempt ± 25%
        const jitter = () => 0.75 + Math.random() * 0.5;
        await sleep(500 * 2 ** attempt * jitter());
      }
    }
    throw lastError;
  }

  private async requestOnce(batch: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          ...this.headers,
        },
        body: JSON.stringify({ model: this.model, input: batch }),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted =
        err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
      throw new EmbeddingError(
        aborted ? `嵌入请求超时（>${this.timeoutMs}ms）` : `嵌入请求失败: ${(err as Error).message}`,
        aborted ? 'timeout' : 'network',
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let detail = '';
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        detail = body?.error?.message ?? '';
      } catch {
        /* 忽略响应体解析失败 */
      }
      const category =
        res.status === 401 || res.status === 403
          ? 'auth'
          : res.status === 429
            ? 'rate_limit'
            : res.status >= 500
              ? 'upstream'
              : 'bad_request';
      throw new EmbeddingError(
        `嵌入请求失败 HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
        category,
      );
    }

    const body = (await res.json()) as { data?: EmbeddingResponseData[]; usage?: unknown };
    if (!body.data || body.data.length !== batch.length) {
      throw new EmbeddingError(
        `嵌入响应数量不符：请求 ${batch.length} 条，返回 ${body.data?.length ?? 0} 条`,
        'bad_response',
      );
    }

    // 按 index 重排（部分网关乱序返回）
    const sorted = [...body.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

    const vectors = sorted.map((d) => d.embedding);
    for (const v of vectors) {
      if (!Array.isArray(v) || v.length === 0) {
        throw new EmbeddingError('嵌入响应包含空向量', 'bad_response');
      }
      if (this.observedDimension === null) this.observedDimension = v.length;
      if (v.length !== this.observedDimension) {
        throw new EmbeddingError(
          `嵌入维度不一致：${v.length} != ${this.observedDimension}（bge-m3 应为 1024）`,
          'bad_response',
        );
      }
    }
    if (this.dimensions !== undefined && this.observedDimension !== this.dimensions) {
      throw new EmbeddingError(
        `嵌入维度与配置不符：期望 ${this.dimensions}，实际 ${this.observedDimension}`,
        'bad_response',
      );
    }

    return vectors;
  }
}

export type EmbeddingErrorCategory =
  | 'network'
  | 'timeout'
  | 'auth'
  | 'rate_limit'
  | 'upstream'
  | 'bad_request'
  | 'bad_response';

export class EmbeddingError extends Error {
  readonly category: EmbeddingErrorCategory;
  constructor(message: string, category: EmbeddingErrorCategory) {
    super(message);
    this.name = 'EmbeddingError';
    this.category = category;
  }
}

/** 判断错误是否可重试 */
export function isRetriable(err: unknown): boolean {
  if (err instanceof EmbeddingError) {
    return err.category === 'network' || err.category === 'timeout' || err.category === 'rate_limit' || err.category === 'upstream';
  }
  return true; // 未知错误默认重试
}
