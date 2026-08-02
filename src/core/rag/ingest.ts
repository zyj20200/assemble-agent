/**
 * 摄取/检索管线编排（I/O 层）
 *
 * 流程：parseFile（解析）→ buildVectorItems（分块/QA 规划）
 *      → embed（批量嵌入）→ store.insert（写入向量库）
 *
 * 纯逻辑（parser/splitter/qa）与 I/O（嵌入、存储）解耦：
 * - embed / store 由调用方注入，可替换为任何嵌入服务与任何 VectorStore
 * - 批量嵌入默认 10 条一批（与 knowledge-control 一致），可配置
 */

import { parseFile } from './parser.ts';
import { buildVectorItems } from './qa.ts';
import type { EmbedFn, SearchHit, VectorItem } from './types.ts';
import type { VectorStore } from './vector-store.ts';

/** 批量嵌入：按 batchSize 分批，失败即抛（上层决定重试策略） */
export async function batchEmbed(
  embed: EmbedFn,
  texts: string[],
  batchSize = 10,
): Promise<number[][]> {
  const result: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const vectors = await embed(batch);
    if (vectors.length !== batch.length) {
      throw new Error(`embed: 输入 ${batch.length} 条，返回 ${vectors.length} 条向量`);
    }
    result.push(...vectors);
  }
  return result;
}

export interface IngestDocumentOptions {
  datasetId: string;
  documentId: string;
  filePath: string;
  fileName?: string;
  /** CSV QA 模板模式（按列位置解析），默认 false */
  isQaCsv?: boolean;
  embed: EmbedFn;
  store: VectorStore;
  /** 嵌入批大小，默认 10 */
  embedBatchSize?: number;
  // 分块参数透传
  chunkSize?: number;
  overlapRatio?: number;
  paragraphChunkDeep?: number;
  enhanceWithTitle?: boolean;
}

export interface IngestResult {
  /** 写入的向量条数（QA 模式 > 问答对数量，因为含索引向量） */
  vectors: number;
  /** 条目数（文本模式 = 分块数；QA 模式 = 问答对数） */
  items: number;
}

/** 完整摄取：解析 → 规划 → 嵌入 → 入库 */
export async function ingestDocument(opts: IngestDocumentOptions): Promise<IngestResult> {
  const {
    datasetId,
    documentId,
    filePath,
    fileName,
    isQaCsv = false,
    embed,
    store,
    embedBatchSize = 10,
    chunkSize,
    overlapRatio,
    paragraphChunkDeep,
    enhanceWithTitle,
  } = opts;

  const parsed = await parseFile(filePath, fileName, isQaCsv);

  const items: VectorItem[] = buildVectorItems(parsed, {
    datasetId,
    documentId,
    fileName: fileName ?? filePath,
    chunkSize,
    overlapRatio,
    paragraphChunkDeep,
    enhanceWithTitle,
  });

  if (items.length === 0) {
    return { vectors: 0, items: 0 };
  }

  const embeddings = await batchEmbed(embed, items.map((i) => i.vectorText), embedBatchSize);
  await store.insert(items, embeddings);

  return {
    vectors: items.length,
    items: new Set(items.map((i) => i.chunkIndex)).size,
  };
}

export interface SearchKnowledgeOptions {
  datasetId: string;
  query: string;
  embed: EmbedFn;
  store: VectorStore;
  /** 返回条数，默认 5 */
  limit?: number;
  /** 余弦相似度阈值，低于视为无命中，默认 0（不过滤） */
  minScore?: number;
}

/** 语义检索：嵌入查询 → 向量库召回 */
export async function searchKnowledge(opts: SearchKnowledgeOptions): Promise<SearchHit[]> {
  const { datasetId, query, embed, store, limit = 5, minScore = 0 } = opts;
  const [queryEmbedding] = await batchEmbed(embed, [query]);
  if (!queryEmbedding) throw new Error('searchKnowledge: 查询向量为空');
  return store.search(datasetId, queryEmbedding, { limit, minScore });
}
