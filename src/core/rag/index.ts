/**
 * RAG 核心模块（从 knowledge-control 移植并修复）
 *
 * 模块划分：
 * - parser.ts        多格式解析（txt/md/pdf/docx/csv/xlsx + GBK 检测）
 * - textSplitter.ts  FastGPT 系分块器（Markdown 表格/标题/中文标点/重叠）
 * - qa.ts            QA 对多向量规划（问题 + 索引多路召回）
 * - vector-store.ts  向量存储抽象 + InMemory/pgvector 实现（参数化 + 余弦）
 * - ingest.ts        摄取/检索管线编排（解析 → 规划 → 嵌入 → 入库）
 */

export * from './types.ts';
export * from './textSplitter.ts';
export * from './parser.ts';
export * from './qa.ts';
export * from './embedding.ts';
export * from './vector-store.ts';
export * from './ingest.ts';
