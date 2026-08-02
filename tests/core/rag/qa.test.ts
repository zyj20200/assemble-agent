import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  planQaVectorTexts,
  planTextVectorTexts,
  buildVectorItems,
} from '../../../src/core/rag/qa.ts';
import type { ParsedRow } from '../../../src/core/rag/types.ts';

describe('qa: 向量文本规划', () => {
  it('QA 行：问题 + 每个索引各一个向量文本', () => {
    const rows: ParsedRow[] = [
      { q: '如何退款？', a: '联系客服', indexes: ['退款', '退货流程'] },
      { q: '密码忘了', a: '找回密码' },
    ];
    const plan = planQaVectorTexts(rows);
    assert.deepEqual(plan.vectorTexts, ['如何退款？', '退款', '退货流程', '密码忘了']);
    assert.deepEqual(plan.itemVectorCounts, [3, 1]);
  });

  it('文本块：每块一个向量，标题增强可开关', () => {
    const chunks = ['块一', '块二'];
    const withTitle = planTextVectorTexts(chunks, '手册.md', true);
    assert.equal(withTitle.vectorTexts[0], 'filename: 手册.md\n块一');
    assert.deepEqual(withTitle.itemVectorCounts, [1, 1]);

    const withoutTitle = planTextVectorTexts(chunks, '手册.md', false);
    assert.deepEqual(withoutTitle.vectorTexts, ['块一', '块二']);
  });
});

describe('qa: buildVectorItems', () => {
  const base = { datasetId: 'ds-1', documentId: 'doc-1', fileName: 'faq.xlsx' };

  it('QA 模式：多向量映射到同一条答案', () => {
    const rows: ParsedRow[] = [{ q: '怎么退货？', a: '联系客服退款', indexes: ['退货', 'refund'] }];
    const items = buildVectorItems(rows, base);
    assert.equal(items.length, 3);
    for (const item of items) {
      assert.equal(item.content, '联系客服退款');
      assert.equal(item.q, '怎么退货？');
      assert.equal(item.a, '联系客服退款');
      assert.equal(item.chunkIndex, 0);
    }
    assert.deepEqual(
      items.map((i) => i.vectorText),
      ['怎么退货？', '退货', 'refund'],
    );
  });

  it('QA 模式：无答案时 content 用问题', () => {
    const items = buildVectorItems([{ q: '只有问题' }], base);
    assert.equal(items[0]!.content, '只有问题');
  });

  it('文本模式：分块 + 标题增强', () => {
    const text = '第一段内容，介绍产品。'.repeat(40);
    const items = buildVectorItems(text, { ...base, chunkSize: 60 });
    assert.ok(items.length > 1);
    assert.ok(items[0]!.vectorText.includes('filename: faq.xlsx'));
    assert.equal(items[0]!.content, items[0]!.vectorText.replace('filename: faq.xlsx\n', ''));
    assert.ok(items.every((i) => i.documentId === 'doc-1' && i.datasetId === 'ds-1'));
  });

  it('文本模式：关闭标题增强', () => {
    const items = buildVectorItems('纯文本。', {
      ...base,
      enhanceWithTitle: false,
      chunkSize: 100,
    });
    assert.equal(items[0]!.vectorText, '纯文本。');
  });

  it('空内容返回空数组', () => {
    assert.deepEqual(buildVectorItems('', base), []);
    assert.deepEqual(buildVectorItems([], base), []);
  });
});
