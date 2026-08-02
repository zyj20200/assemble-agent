import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ingestDocument, searchKnowledge } from '../../../src/core/rag/ingest.ts';
import { splitText2Chunks } from '../../../src/core/rag/textSplitter.ts';
import { InMemoryVectorStore } from '../../../src/core/rag/vector-store.ts';
import type { EmbedFn } from '../../../src/core/rag/types.ts';

/**
 * 确定性伪嵌入：完全相同文本 → 相同 one-hot 向量（已归一化），
 * 不同文本 → 正交向量（余弦相似度 0）。
 * 用于验证管线机制，不涉及真实语义。
 */
function makeExactEmbed(): { embed: EmbedFn } {
  const map = new Map<string, number[]>();
  const dim = 64;
  const embed: EmbedFn = async (texts) =>
    texts.map((t) => {
      let v = map.get(t);
      if (!v) {
        v = new Array(dim).fill(0);
        v[map.size % dim] = 1;
        map.set(t, v);
      }
      return v;
    });
  return { embed };
}

let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rag-ingest-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ingest: 文本模式全链路', () => {
  it('解析 → 分块 → 嵌入 → 入库 → 精确检索命中', async () => {
    const store = new InMemoryVectorStore();
    const { embed } = makeExactEmbed();
    const file = path.join(dir, 'guide.md');
    const content = '# 退货指南\n\n联系客服即可办理退货。'.repeat(30);
    await writeFile(file, content);

    const result = await ingestDocument({
      datasetId: 'ds-text',
      documentId: 'doc-guide',
      filePath: file,
      fileName: 'guide.md',
      embed,
      store,
      chunkSize: 80,
    });

    assert.ok(result.items > 1, '应产生多个分块');
    assert.equal(result.vectors, result.items);
    assert.equal(store.size, result.vectors);

    // 标题增强会改变 vectorText，这里关闭以简化；同参数分块得到一致的 chunk
    const store2 = new InMemoryVectorStore();
    await ingestDocument({
      datasetId: 'ds-text2',
      documentId: 'doc-guide2',
      filePath: file,
      fileName: 'guide.md',
      embed,
      store: store2,
      chunkSize: 80,
      enhanceWithTitle: false,
    });
    const { chunks } = splitText2Chunks({ text: content, chunkSize: 80 });
    const query = chunks[0]!;

    const hits = await searchKnowledge({
      datasetId: 'ds-text2',
      query,
      embed,
      store: store2,
      limit: 3,
      minScore: 0.99,
    });
    assert.ok(hits.length >= 1, '应命中至少一条');
    assert.ok(hits[0]!.score > 0.99);
    assert.equal(hits[0]!.documentId, 'doc-guide2');
  });
});

describe('ingest: QA 模式全链路', () => {
  it('CSV QA 上传 → 多向量入库 → 按索引词召回答案', async () => {
    const store = new InMemoryVectorStore();
    const { embed } = makeExactEmbed();
    const file = path.join(dir, 'faq.csv');
    await writeFile(
      file,
      '问题,答案,索引\n怎么退货？,联系客服处理退款,退款流程\n密码忘了？,点击找回密码,账号安全\n',
    );

    const result = await ingestDocument({
      datasetId: 'ds-qa',
      documentId: 'doc-faq',
      filePath: file,
      fileName: 'faq.csv',
      isQaCsv: true,
      embed,
      store,
    });

    // 2 行 × (1 问题 + 1 索引) = 4 条向量；items = 2 条问答
    assert.equal(result.vectors, 4);
    assert.equal(result.items, 2);
    assert.equal(store.size, 4);

    // 用索引词召回答案
    const hits = await searchKnowledge({
      datasetId: 'ds-qa',
      query: '退款流程',
      embed,
      store,
      minScore: 0.99,
    });
    assert.equal(hits[0]!.content, '联系客服处理退款');
    assert.equal(hits[0]!.a, '联系客服处理退款');
    assert.equal(hits[0]!.q, '怎么退货？');
  });
});

describe('ingest: 删除与空内容', () => {
  it('deleteByDocument 只删该文档，deleteByDataset 清空', async () => {
    const store = new InMemoryVectorStore();
    const { embed } = makeExactEmbed();
    const f1 = path.join(dir, 'd1.md');
    const f2 = path.join(dir, 'd2.md');
    await writeFile(f1, '文档一的内容。'.repeat(20));
    await writeFile(f2, '文档二的内容。'.repeat(20));

    await ingestDocument({
      datasetId: 'ds',
      documentId: 'a',
      filePath: f1,
      embed,
      store,
      chunkSize: 50,
    });
    await ingestDocument({
      datasetId: 'ds',
      documentId: 'b',
      filePath: f2,
      embed,
      store,
      chunkSize: 50,
    });
    const total = store.size;
    assert.ok(total > 0);

    await store.deleteByDocument('ds', 'a');
    assert.ok(store.size < total, '删除后应减少');

    await store.deleteByDataset('ds');
    assert.equal(store.size, 0);
  });

  it('嵌入数量不匹配时报错', async () => {
    const store = new InMemoryVectorStore();
    const badEmbed: EmbedFn = async () => [];
    const file = path.join(dir, 'x.md');
    await writeFile(file, '内容。'.repeat(30));
    await assert.rejects(
      ingestDocument({
        datasetId: 'ds',
        documentId: 'x',
        filePath: file,
        embed: badEmbed,
        store,
      }),
      /embed|数量不一致/,
    );
  });
});
