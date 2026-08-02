/**
 * RAG 核心共享类型
 *
 * 从 knowledge-control (FastGPT 衍生) 移植时定下的数据形状：
 * - 摄取侧：一份文档 → 若干 VectorItem（每个 VectorItem 对应一条向量记录）
 * - 检索侧：SearchHit（内容 + 来源 + 相似度）
 */

/** CSV/Excel QA 模式解析出的一行问答对 */
export interface ParsedRow {
  /** 问题（QA 模式必填；普通模式退化为整行文本） */
  q: string;
  /** 答案（可选） */
  a?: string;
  /** 索引/关键词列：每个索引单独生成一个向量，实现多路召回 */
  indexes?: string[];
}

/** 一个可索引单元 = 一条向量记录。QA 行可能产生多条（问题 + 各索引列）。 */

/** 一个可索引单元 = 一条向量记录。QA 行可能产生多条（问题 + 各索引列）。 */
export interface VectorItem {
  datasetId: string;
  documentId: string;
  /** 文档内序号：文本模式 = chunk 下标；QA 模式 = 问答对下标 */
  chunkIndex: number;
  /** 实际被嵌入的文本（问题 / 索引关键词 / 分块文本） */
  vectorText: string;
  /** 检索命中后返回给模型的内容（QA 模式 = 答案，文本模式 = 分块） */
  content: string;
  /** QA 模式的问题原文（用于展示/溯源） */
  q?: string;
  /** QA 模式的答案原文 */
  a?: string;
}

/** 检索命中结果 */
export interface SearchHit {
  id: string;
  datasetId: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  q?: string;
  a?: string;
  /** 余弦相似度，范围 0..1，越大越相似 */
  score: number;
}

/** 嵌入函数签名：入参文本数组，返回等长向量数组 */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;
