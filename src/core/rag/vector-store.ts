/**
 * 向量存储抽象 + 实现
 *
 * 设计（移植时对 knowledge-control 的修复）：
 * 1. **单库**：去掉 Mongo + PG 双写，元数据与向量同表（KB 场景足够）
 * 2. **参数化查询**：向量一律 `$n::vector` 绑定，杜绝字符串插值 SQL 注入
 * 3. **归一化 + 余弦**：写入/查询时统一归一化，用 `<=>` 余弦距离
 *    （原代码用 `vector_ip_ops` 内积却未归一化，相似度语义是错的）
 * 4. 存储层不感知嵌入模型：embed 由调用方注入，store 只管存取
 */

import type { SearchHit, VectorItem } from './types.ts';

/** 归一化向量（L2），保证内积 == 余弦相似度 */
export function normalizeEmbedding(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

/** 向量点积（向量已归一化时即余弦相似度，范围 [-1, 1]） */
export function dotProduct(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}

/** 存储条目（内部形态：VectorItem + 归一化向量） */
export interface StoredVector {
  id: string;
  datasetId: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  q?: string;
  a?: string;
  embedding: number[];
}

export interface VectorStore {
  /** 批量写入（调用方负责调用 embed；向量在此统一归一化） */
  insert(items: VectorItem[], embeddings: number[][]): Promise<void>;
  /** 余弦相似度检索，score ∈ [-1, 1]，按 score 降序 */
  search(
    datasetId: string,
    queryEmbedding: number[],
    options?: { limit?: number; minScore?: number },
  ): Promise<SearchHit[]>;
  /** 删除某文档的全部向量（重传同名文件时原子替换用） */
  deleteByDocument(datasetId: string, documentId: string): Promise<void>;
  /** 删除某知识库的全部向量 */
  deleteByDataset(datasetId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// InMemory 实现：MVP / 测试 / 单机小规模（全表扫描，万级 chunk 内可用）
// ---------------------------------------------------------------------------

export class InMemoryVectorStore implements VectorStore {
  private rows: StoredVector[] = [];
  private seq = 0;

  async insert(items: VectorItem[], embeddings: number[][]): Promise<void> {
    if (items.length !== embeddings.length) {
      throw new Error(`insert: items(${items.length}) 与 embeddings(${embeddings.length}) 数量不一致`);
    }
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      this.rows.push({
        id: `mem-${++this.seq}`,
        datasetId: item.datasetId,
        documentId: item.documentId,
        chunkIndex: item.chunkIndex,
        content: item.content,
        q: item.q,
        a: item.a,
        embedding: normalizeEmbedding(embeddings[i]!),
      });
    }
  }

  async search(
    datasetId: string,
    queryEmbedding: number[],
    options?: { limit?: number; minScore?: number },
  ): Promise<SearchHit[]> {
    const limit = options?.limit ?? 5;
    const minScore = options?.minScore ?? 0;
    const q = normalizeEmbedding(queryEmbedding);

    const scored = this.rows
      .filter((r) => r.datasetId === datasetId)
      .map((r) => ({ row: r, score: dotProduct(q, r.embedding) }))
      .filter(({ score }) => score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map(({ row, score }) => ({
      id: row.id,
      datasetId: row.datasetId,
      documentId: row.documentId,
      chunkIndex: row.chunkIndex,
      content: row.content,
      q: row.q,
      a: row.a,
      score,
    }));
  }

  async deleteByDocument(datasetId: string, documentId: string): Promise<void> {
    this.rows = this.rows.filter(
      (r) => !(r.datasetId === datasetId && r.documentId === documentId),
    );
  }

  async deleteByDataset(datasetId: string): Promise<void> {
    this.rows = this.rows.filter((r) => r.datasetId !== datasetId);
  }

  /** 测试辅助：当前行数 */
  get size(): number {
    return this.rows.length;
  }
}

// ---------------------------------------------------------------------------
// pgvector 实现（PostgreSQL + pgvector 插件）
// ---------------------------------------------------------------------------

import pg from 'pg';

export interface PgVectorStoreOptions {
  /** 连接串或已创建的 Pool */
  connectionString?: string;
  pool?: pg.Pool;
  /** 表名，默认 kb_vectors */
  tableName?: string;
  /**
   * 向量维度（必须与嵌入模型一致，如 bge-m3=1024）。
   * pgvector 的 HNSW 索引要求列声明固定维度；不传时默认 1024。
   */
  dimensions?: number;
}

const DEFAULT_TABLE = 'kb_vectors';
const DEFAULT_DIMENSIONS = 1024;

/** 向量序列化为 pgvector 字面量（node-pg 传 JS 数组会被加引号，pgvector 不接受） */
const toVectorLiteral = (v: number[]) => `[${v.join(',')}]`;

const SCHEMA_SQL = (table: string, dimensions: number) => `
CREATE TABLE IF NOT EXISTS ${table} (
  id BIGSERIAL PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  chunk_index INT NOT NULL,
  vector_text TEXT NOT NULL,
  content TEXT NOT NULL,
  q TEXT,
  a TEXT,
  embedding vector(${dimensions}) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ${table}_hnsw_idx ON ${table} USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS ${table}_dataset_idx ON ${table} (dataset_id);
`;

export class PgVectorStore implements VectorStore {
  private pool: pg.Pool;
  private table: string;
  private dimensions: number;
  private schemaReady: Promise<void> | null = null;

  constructor(options: PgVectorStoreOptions) {
    this.pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString });
    this.table = options.tableName ?? DEFAULT_TABLE;
    this.dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
  }

  /** 幂等建表 + HNSW 索引（首次使用前自动执行一次） */
  ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.pool
        .query(SCHEMA_SQL(this.table, this.dimensions))
        .then(() => undefined);
    }
    return this.schemaReady;
  }

  /** 关闭连接池（应用退出时调用） */
  async close(): Promise<void> {
    await this.pool.end();
  }

  async insert(items: VectorItem[], embeddings: number[][]): Promise<void> {
    if (items.length !== embeddings.length) {
      throw new Error(`insert: items(${items.length}) 与 embeddings(${embeddings.length}) 数量不一致`);
    }
    await this.ensureSchema();

    // 参数化批量插入：向量序列化为 pgvector 字面量字符串 '[x,y,z]' 再 ::vector 强转
    const params: unknown[] = [];
    const placeholders = items.map((item, i) => {
      const base = i * 8;
      params.push(
        item.datasetId,
        item.documentId,
        item.chunkIndex,
        item.vectorText,
        item.content,
        item.q ?? null,
        item.a ?? null,
      );
      params.push(toVectorLiteral(normalizeEmbedding(embeddings[i]!)));
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}::vector)`;
    });

    await this.pool.query(
      `INSERT INTO ${this.table}
         (dataset_id, document_id, chunk_index, vector_text, content, q, a, embedding)
       VALUES ${placeholders.join(', ')}`,
      params,
    );
  }

  async search(
    datasetId: string,
    queryEmbedding: number[],
    options?: { limit?: number; minScore?: number },
  ): Promise<SearchHit[]> {
    await this.ensureSchema();
    const limit = options?.limit ?? 5;
    const minScore = options?.minScore ?? 0;
    // 余弦距离 <=> ：score = 1 - distance（向量已归一化）
    const q = normalizeEmbedding(queryEmbedding);

    const res = await this.pool.query(
      `SELECT id::text, dataset_id, document_id, chunk_index, content, q, a,
               (1 - (embedding <=> $1::vector)) AS score
         FROM ${this.table}
        WHERE dataset_id = $2
          AND (1 - (embedding <=> $1::vector)) >= $3
        ORDER BY embedding <=> $1::vector ASC
        LIMIT $4`,
      [toVectorLiteral(q), datasetId, minScore, limit],
    );

    return res.rows.map((row) => ({
      id: row.id,
      datasetId: row.dataset_id,
      documentId: row.document_id,
      chunkIndex: row.chunk_index,
      content: row.content,
      q: row.q ?? undefined,
      a: row.a ?? undefined,
      score: Number(row.score),
    }));
  }

  async deleteByDocument(datasetId: string, documentId: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `DELETE FROM ${this.table} WHERE dataset_id = $1 AND document_id = $2`,
      [datasetId, documentId],
    );
  }

  async deleteByDataset(datasetId: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(`DELETE FROM ${this.table} WHERE dataset_id = $1`, [datasetId]);
  }
}
