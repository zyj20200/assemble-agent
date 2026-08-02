import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitText2Chunks, CUSTOM_SPLIT_SIGN } from '../../../src/core/rag/textSplitter.ts';

const validLen = (s: string) => s.replace(/\s+/g, '').length;

describe('textSplitter: 中文分块', () => {
  it('长文本按 chunkSize 切分，单块不超过 1.2x 上限', () => {
    const text = '这是一段用于测试分块的中文文本，包含多个句子。'.repeat(300);
    const { chunks, chars } = splitText2Chunks({ text, chunkSize: 200, overlapRatio: 0.1 });

    assert.ok(chunks.length > 1, '应切出多块');
    // 重叠会使各块长度之和 ≥ 原文长度（chars 定义 = 各块长度之和，非保真度量）
    assert.ok(chars >= text.length, 'chars 应为各块长度之和');
    for (const c of chunks) {
      assert.ok(validLen(c) <= 200 * 1.2 + 2, `块超长: ${validLen(c)}`);
    }
    // 拼接回去应保留原文主体（允许重叠引入少量重复）
    const joined = chunks.join('');
    assert.ok(joined.length >= text.length);
  });

  it('chunkSize 大于全文时返回单块', () => {
    const text = '短文本。';
    const { chunks } = splitText2Chunks({ text, chunkSize: 1000 });
    assert.deepEqual(chunks, ['短文本。']);
  });

  it('中文之间多余空格被清理 (simpleText)', () => {
    const { chunks } = splitText2Chunks({ text: '中 文 之 间 有 空 格', chunkSize: 100 });
    assert.equal(chunks[0], '中文之间有空格');
  });
});

describe('textSplitter: Markdown', () => {
  it('Markdown 表格整块保留且表头随每个分块携带', () => {
    const rows = Array.from({ length: 40 }, (_, i) => `| 商品${i} | ${i * 10} 元 |`);
    const table = `| 名称 | 价格 |\n| --- | --- |\n${rows.join('\n')}`;
    const { chunks } = splitText2Chunks({ text: table, chunkSize: 60 });

    assert.ok(chunks.length > 1, '大表格应切出多块');
    for (const c of chunks) {
      assert.ok(c.includes('名称'), '每个分块应保留表头');
    }
  });

  it('Markdown 标题随内容保留（标题切分深度）', () => {
    const text = [
      '# 第一章',
      '这是第一章的内容，用于测试标题透传。',
      '## 第一节',
      '这是第一节的内容。',
      '## 第二节',
      '这是第二节的内容。',
    ].join('\n');
    const { chunks } = splitText2Chunks({ text, chunkSize: 100, paragraphChunkDeep: 2 });
    const joined = chunks.join('\n');
    assert.ok(joined.includes('# 第一章'));
    assert.ok(joined.includes('## 第一节'));
    assert.ok(joined.includes('## 第二节'));
  });

  it('代码块不会被句子规则切碎', () => {
    const text = '说明文字。\n```ts\nconst a = 1;\nconst b = 2;\n```\n后续文字。';
    const { chunks } = splitText2Chunks({ text, chunkSize: 50 });
    const codeChunk = chunks.find((c) => c.includes('```'));
    assert.ok(codeChunk !== undefined, '应存在包含代码块的块');
    assert.ok(codeChunk!.includes('const a = 1;'));
    assert.ok(codeChunk!.includes('const b = 2;'));
  });
});

describe('textSplitter: 自定义分隔符', () => {
  it('CUSTOM_SPLIT_SIGN 强制分块', () => {
    const { chunks } = splitText2Chunks({
      text: `第一部分内容。${CUSTOM_SPLIT_SIGN}第二部分内容。`,
      chunkSize: 1000,
    });
    assert.equal(chunks.length, 2);
    assert.ok(chunks[0]!.includes('第一部分'));
    assert.ok(chunks[1]!.includes('第二部分'));
  });
});
