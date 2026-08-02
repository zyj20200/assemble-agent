/**
 * 知识库检索 AgentTool（pi-agent-core 集成）
 *
 * 把 RAG 检索包装成工具（工具式检索）：模型自主决定何时调用 search_knowledge，
 * 需要事实依据时检索，命中内容以带来源/相似度的文本返回。
 *
 * 对应 assemble-agent 的 rag_mode=auto 模式（注入式模式后续用 transformContext 实现）。
 */

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { searchKnowledge } from '../rag/ingest.ts';
import type { EmbedFn, SearchHit } from '../rag/types.ts';
import type { VectorStore } from '../rag/vector-store.ts';

export interface KnowledgeBaseToolOptions {
  store: VectorStore;
  embed: EmbedFn;
  /** 目标知识库（dataset）ID */
  datasetId: string;
  /** 工具名，默认 search_knowledge */
  name?: string;
  /** 工具描述（写清楚何时使用，模型据此决策） */
  description?: string;
  /** 默认返回条数，默认 5 */
  topK?: number;
  /** 相似度阈值，低于视为无命中，默认 0.3 */
  minScore?: number;
  /** 自定义命中格式化（默认带序号、相似度、来源） */
  formatHit?: (hit: SearchHit, index: number) => string;
}

/** 默认命中格式化：`[1] (score=0.85) Q: xxx\nA: xxx` */
const defaultFormatHit = (hit: SearchHit, index: number): string => {
  const head = `[${index + 1}] (score=${hit.score.toFixed(3)})`;
  const qa = hit.q ? `问题: ${hit.q}\n` : '';
  return `${head} ${qa}${hit.content}`;
};

const parameters = Type.Object({
  query: Type.String({ description: '检索问句或关键词，用自然语言表达需要的事实' }),
  top_k: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 20, description: '返回片段条数（默认按工具配置）' }),
  ),
});

export function createKnowledgeBaseTool(opts: KnowledgeBaseToolOptions): AgentTool<typeof parameters> {
  const {
    store,
    embed,
    datasetId,
    name = 'search_knowledge',
    description,
    topK = 5,
    minScore = 0.3,
    formatHit = defaultFormatHit,
  } = opts;

  return {
    name,
    label: '知识库检索',
    description:
      description ??
      `在知识库中检索与问题相关的内容片段。当用户问题需要事实依据、具体数据、文档/手册/FAQ 内容时调用；检索不到时如实说明，不要编造。检索结果带相似度分数与来源。`,
    parameters,
    execute: async (_toolCallId, params) => {
      const hits = await searchKnowledge({
        datasetId,
        query: params.query,
        embed,
        store,
        limit: params.top_k ?? topK,
        minScore,
      });

      if (hits.length === 0) {
        return {
          content: [{ type: 'text', text: '未检索到与查询相关的知识库内容。' }],
          details: { hits: 0 },
        };
      }

      const text = hits.map((h, i) => formatHit(h, i)).join('\n\n');
      return {
        content: [{ type: 'text', text }],
        details: { hits: hits.length, topScore: hits[0]!.score },
      };
    },
  };
}
