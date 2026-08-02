/**
 * 知识库服务：DB（chunks 元数据 + 嵌入 JSON）与运行时向量索引（InMemory）的桥
 *
 * MVP 设计（DESIGN.md §6.4）：
 * - 摄取：parseFile → buildVectorItems → embed → InMemoryVectorStore + chunks 表落库
 * - 检索：searchKnowledge（走 InMemory 索引，万级 chunk 内可用）
 * - 演进：chunks 表平移 pgvector 后，检索层替换为 PgVectorStore，本服务接口不变
 */

import type { AppDb } from '../db/index.ts';
import { schema } from '../db/index.ts';
import { and, eq } from 'drizzle-orm';
import {
  InMemoryVectorStore,
  type VectorStore,
} from './rag/vector-store.ts';
import { OpenAICompatibleEmbedder } from './rag/embedding.ts';
import { buildVectorItems } from './rag/qa.ts';
import { batchEmbed, searchKnowledge } from './rag/ingest.ts';
import { parseFile } from './rag/parser.ts';
import type { EmbedFn, SearchHit } from './rag/types.ts';
import { config } from '../config.ts';

export interface KbServiceDeps {
  db: AppDb;
  /** 兜底嵌入配置（env EMBEDDING_* 优先，其次取 providers 表） */
  resolveEmbedder?: (kb: { embeddingModel?: string | null }) => EmbedFn;
}

/** KB 摄取结果 */
export interface IngestResult {
  documentId: number;
  filename: string;
  vectors: number;
  items: number;
  docType: string;
}

export class KnowledgeBaseService {
  private db: AppDb;
  private resolveEmbedder?: (kb: { embeddingModel?: string | null }) => EmbedFn;
  private stores = new Map<number, InMemoryVectorStore>();
  private embedders = new Map<number, EmbedFn>();

  constructor(deps: KbServiceDeps) {
    this.db = deps.db;
    this.resolveEmbedder = deps.resolveEmbedder;
    this.reload();
  }

  /** 从 DB 全量加载 KB 索引（启动/配置变更后调用） */
  reload(): void {
    this.stores.clear();
    this.embedders.clear();
    const kbs = this.db.select().from(schema.knowledgeBases).all();
    for (const kb of kbs) {
      this.stores.set(kb.id, new InMemoryVectorStore());
      this.embedders.set(kb.id, this.buildEmbedder(kb));
    }
    // 加载向量
    const rows = this.db.select().from(schema.chunks).all();
    const byKb = new Map<number, (typeof rows)[number][]>();
    for (const r of rows) {
      const list = byKb.get(r.knowledgeBaseId) ?? [];
      list.push(r);
      byKb.set(r.knowledgeBaseId, list);
    }
    for (const [kbId, list] of byKb) {
      const store = this.stores.get(kbId);
      if (!store) continue;
      const items = list.map((r) => ({
        datasetId: String(kbId),
        documentId: String(r.documentId),
        chunkIndex: r.chunkIndex,
        vectorText: r.vectorText,
        content: r.content,
        q: r.q ?? undefined,
        a: r.a ?? undefined,
      }));
      const embeddings = list.map((r) => parseEmbedding(r.embedding));
      if (embeddings.some((e) => e === undefined)) continue;
      store.insert(items, embeddings as number[][]);
    }
  }

  getStore(kbId: number): VectorStore | undefined {
    return this.stores.get(kbId);
  }

  getEmbedder(kbId: number): EmbedFn {
    const e = this.embedders.get(kbId);
    if (!e) throw new Error(`知识库 ${kbId} 未配置嵌入模型（需设置 EMBEDDING_* 或 Provider 的 embedding_model）`);
    return e;
  }

  /** 解析嵌入配置：kb.embedding_model 覆盖 env/Provider 默认 */
  private buildEmbedder(kb: { embeddingModel?: string | null }): EmbedFn {
    if (this.resolveEmbedder) return this.resolveEmbedder(kb);
    const emb = config.embedding;
    const model = kb.embeddingModel ?? emb.model;
    if (emb.baseUrl && emb.apiKey && model) {
      const e = new OpenAICompatibleEmbedder({
        baseUrl: emb.baseUrl,
        apiKey: emb.apiKey,
        model,
      });
      return e.embed.bind(e);
    }
    // 兜底：第一个配置了 embedding_model 的启用 Provider
    const p = this.db
      .select()
      .from(schema.providers)
      .where(eq(schema.providers.enabled, true))
      .all()
      .find((x) => x.embeddingModel && x.apiKey && x.baseUrl);
    if (p) {
      const e = new OpenAICompatibleEmbedder({
        baseUrl: p.baseUrl,
        apiKey: p.apiKey!,
        model: kb.embeddingModel ?? p.embeddingModel!,
      });
      return e.embed.bind(e);
    }
    // 返回一个明确报错的占位（避免启动即崩）
    return async () => {
      throw new Error('知识库未配置嵌入模型');
    };
  }

  /** 摄取文档：解析 → 分块/QA → 嵌入 → 索引 + 落库 */
  async ingestDocument(kbId: number, filePath: string, fileName: string, isQaCsv = false): Promise<IngestResult> {
    const kb = this.db.select().from(schema.knowledgeBases).where(eq(schema.knowledgeBases.id, kbId)).get();
    if (!kb) throw new Error(`知识库不存在: ${kbId}`);
    const store = this.stores.get(kbId);
    if (!store) throw new Error(`知识库索引未加载: ${kbId}`);
    const embed = this.getEmbedder(kbId);

    const parsed = await parseFile(filePath, fileName, isQaCsv);
    const items = buildVectorItems(parsed, {
      datasetId: String(kbId),
      documentId: 'pending', // 先插入后回填 documentId
      fileName,
      chunkSize: kb.chunkSize,
      overlapRatio: 0.2,
      paragraphChunkDeep: 5,
      enhanceWithTitle: true,
    });
    if (items.length === 0) throw new Error('文档解析后无可索引内容');

    const embeddings = await batchEmbed(embed, items.map((i) => i.vectorText), 10);

    // 1) 文档行
    const content = typeof parsed === 'string' ? parsed : '';
    const doc = this.db
      .insert(schema.documents)
      .values({
        knowledgeBaseId: kbId,
        filename: fileName,
        content,
        docType: fileExt(fileName),
        status: 'ready',
      })
      .returning()
      .get();

    // 2) 索引 + chunks 行（每向量一行）
    const withDoc = items.map((i) => ({ ...i, documentId: String(doc.id) }));
    await store.insert(withDoc, embeddings);
    for (let i = 0; i < withDoc.length; i++) {
      this.db
        .insert(schema.chunks)
        .values({
          knowledgeBaseId: kbId,
          documentId: doc.id,
          chunkIndex: withDoc[i]!.chunkIndex,
          content: withDoc[i]!.content,
          q: withDoc[i]!.q ?? null,
          a: withDoc[i]!.a ?? null,
          vectorText: withDoc[i]!.vectorText,
          embedding: JSON.stringify(embeddings[i]),
        })
        .run();
    }

    return { documentId: doc.id, filename: fileName, vectors: items.length, items: new Set(items.map((i) => i.chunkIndex)).size, docType: fileExt(fileName) };
  }

  /** 语义检索（管理页"检索调试" + 工具检索共用） */
  async search(kbId: number, query: string, opts?: { limit?: number; minScore?: number }): Promise<SearchHit[]> {
    const store = this.stores.get(kbId);
    if (!store) throw new Error(`知识库索引未加载: ${kbId}`);
    const kb = this.db.select().from(schema.knowledgeBases).where(eq(schema.knowledgeBases.id, kbId)).get();
    return searchKnowledge({
      datasetId: String(kbId),
      query,
      embed: this.getEmbedder(kbId),
      store,
      limit: opts?.limit ?? kb?.topK ?? 5,
      minScore: opts?.minScore ?? kb?.minScore ?? 0.3,
    });
  }

  /** 删除文档（索引 + DB 级联） */
  deleteDocument(kbId: number, documentId: number): void {
    const store = this.stores.get(kbId);
    store?.deleteByDocument(String(kbId), String(documentId));
    this.db.delete(schema.documents).where(eq(schema.documents.id, documentId)).run();
  }

  /** 删除整个知识库（索引 + DB 级联） */
  deleteKnowledgeBase(kbId: number): void {
    this.stores.delete(kbId);
    this.embedders.delete(kbId);
    this.db.delete(schema.knowledgeBases).where(eq(schema.knowledgeBases.id, kbId)).run();
  }

  /** 列出 KB 的文档 */
  listDocuments(kbId: number) {
    return this.db.select().from(schema.documents).where(eq(schema.documents.knowledgeBaseId, kbId)).all();
  }
}

function parseEmbedding(json: string | null): number[] | undefined {
  if (!json) return undefined;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) && v.every((x) => typeof x === 'number') ? v : undefined;
  } catch {
    return undefined;
  }
}

function fileExt(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i >= 0 ? fileName.slice(i + 1).toLowerCase() : 'txt';
}
