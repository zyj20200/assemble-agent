/**
 * QA 对逻辑 + 向量规划（从 knowledge-control 移植并抽取为纯函数）
 *
 * 核心思想（FastGPT 的 QA 数据集模式）：
 * - 一条问答对 = 问题 + 答案 + N 个索引/关键词
 * - 问题列与每个索引列**各自生成一个向量**（多路召回）：
 *   用户问题无论命中"问题列"还是任意"索引列"，都能召回同一条答案
 * - 文本模式：分块后每块一个向量，可选将文件名拼入向量文本增强召回
 */

import type { ParsedRow, VectorItem } from './types.ts';
import { splitText2Chunks } from './textSplitter.ts';

/** 向量文本规划结果 */
export interface VectorPlan {
  /** 待嵌入的文本列表（顺序与最终向量一一对应） */
  vectorTexts: string[];
  /** 每个问答对/分块拥有的向量数（用于把向量映射回条目） */
  itemVectorCounts: number[];
}

/** QA 模式：问题 + 每个索引各生成一个向量文本 */
export function planQaVectorTexts(qaData: ParsedRow[]): VectorPlan {
  const vectorTexts: string[] = [];
  const itemVectorCounts: number[] = [];

  qaData.forEach((item) => {
    let count = 0;
    // 问题本身总是默认索引
    if (item.q) {
      vectorTexts.push(item.q);
      count++;
    }
    // 每个索引列单独一个向量
    if (item.indexes && item.indexes.length > 0) {
      item.indexes.forEach((idx) => {
        if (idx && idx.trim()) {
          vectorTexts.push(idx.trim());
          count++;
        }
      });
    }
    itemVectorCounts.push(count);
  });

  return { vectorTexts, itemVectorCounts };
}

/** 文本模式：每个分块一个向量，可选把文件名拼入向量文本（标题增强） */
export function planTextVectorTexts(
  chunks: string[],
  fileName: string,
  enhanceWithTitle: boolean,
): VectorPlan {
  const vectorTexts = enhanceWithTitle
    ? chunks.map((chunk) => `filename: ${fileName}\n${chunk}`)
    : chunks;
  return { vectorTexts, itemVectorCounts: chunks.map(() => 1) };
}

/** buildVectorItems 的可选参数（分块相关，透传给 splitText2Chunks） */
export interface BuildVectorItemsOptions {
  datasetId: string;
  documentId: string;
  fileName: string;
  /** 分块大小（字符），默认 500 */
  chunkSize?: number;
  /** 重叠比例，默认 0.2 */
  overlapRatio?: number;
  /** Markdown 标题切分深度，默认 5 */
  paragraphChunkDeep?: number;
  /** 文本模式是否把文件名拼入向量文本，默认 true */
  enhanceWithTitle?: boolean;
}

/**
 * 把解析结果（纯文本或 QA 行）规划成 VectorItem 列表。
 * 纯函数、无 I/O：嵌入与存储由上层负责（见 ingest.ts）。
 */
export function buildVectorItems(
  parsed: string | ParsedRow[],
  opts: BuildVectorItemsOptions,
): VectorItem[] {
  const {
    datasetId,
    documentId,
    fileName,
    chunkSize = 500,
    overlapRatio = 0.2,
    paragraphChunkDeep = 5,
    enhanceWithTitle = true,
  } = opts;

  // QA 模式：每条问答对 → 1 + indexes.length 个向量
  if (Array.isArray(parsed)) {
    const qaData = parsed.filter((item) => item.q);
    const plan = planQaVectorTexts(qaData);
    const items: VectorItem[] = [];
    let cursor = 0;

    qaData.forEach((item, index) => {
      const count = plan.itemVectorCounts[index]!;
      for (let k = 0; k < count; k++) {
        items.push({
          datasetId,
          documentId,
          chunkIndex: index,
          vectorText: plan.vectorTexts[cursor + k]!,
          content: item.a || item.q,
          q: item.q,
          a: item.a,
        });
      }
      cursor += count;
    });

    return items;
  }

  // 文本模式：分块 → 每块一个向量
  const splitResult = splitText2Chunks({
    text: parsed,
    chunkSize,
    overlapRatio,
    paragraphChunkDeep,
  });
  const plan = planTextVectorTexts(splitResult.chunks, fileName, enhanceWithTitle);

  return splitResult.chunks.map((chunk, index) => ({
    datasetId,
    documentId,
    chunkIndex: index,
    vectorText: plan.vectorTexts[index]!,
    content: chunk,
  }));
}
