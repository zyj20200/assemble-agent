import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import * as XLSX from 'xlsx';
import { parseFile, normalizeDataset, isSupportedExtension } from '../../../src/core/rag/parser.ts';

let dir: string;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rag-parser-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (name: string, content: string | Buffer) =>
  writeFile(path.join(dir, name), content);

describe('parser: 文本类', () => {
  it('txt UTF-8', async () => {
    await write('a.txt', '你好，世界。\n第二行。');
    const out = await parseFile(path.join(dir, 'a.txt'));
    assert.equal(out, '你好，世界。\n第二行。');
  });

  it('txt GBK 编码自动识别', async () => {
    const gbk = iconv.encode('中文编码测试：退款流程。', 'gbk');
    await write('gbk.txt', gbk);
    const out = await parseFile(path.join(dir, 'gbk.txt'));
    assert.equal(out, '中文编码测试：退款流程。');
  });

  it('md 直读', async () => {
    await write('doc.md', '# 标题\n内容。');
    const out = await parseFile(path.join(dir, 'doc.md'));
    assert.equal(out, '# 标题\n内容。');
  });

  it('无扩展名按文本处理', async () => {
    await write('noext', 'plain text');
    const out = await parseFile(path.join(dir, 'noext'));
    assert.equal(out, 'plain text');
  });
});

describe('parser: CSV', () => {
  it('普通模式返回纯文本', async () => {
    await write('plain.csv', 'a,b\n1,2\n3,4\n');
    const out = await parseFile(path.join(dir, 'plain.csv'));
    assert.equal(typeof out, 'string');
    assert.ok((out as string).includes('a,b'));
  });

  it('QA 模板模式按列位置解析（跳过表头）', async () => {
    await write(
      'qa.csv',
      '问题,答案,索引1,索引2\n怎么退货？,联系客服处理,退款,退货流程\n密码忘了？,点击找回密码,登录,账号\n',
    );
    const out = (await parseFile(path.join(dir, 'qa.csv'), undefined, true)) as Array<{
      q: string;
      a: string;
      indexes: string[];
    }>;
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { q: '怎么退货？', a: '联系客服处理', indexes: ['退款', '退货流程'] });
    assert.deepEqual(out[1], { q: '密码忘了？', a: '点击找回密码', indexes: ['登录', '账号'] });
  });
});

describe('parser: Excel', () => {
  const writeXlsx = async (name: string, rows: Record<string, unknown>[]) => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    await write(name, buf);
  };

  it('中文列名（问题/答案/索引）自动归一化', async () => {
    await writeXlsx('cn.xlsx', [
      { 问题: '如何退款？', 答案: '在订单页申请', 索引: 'refund' },
      { 问题: '如何改地址？', 答案: '联系客服' },
    ]);
    const out = (await parseFile(path.join(dir, 'cn.xlsx'))) as Array<{
      q: string;
      a?: string;
      indexes?: string[];
    }>;
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { q: '如何退款？', a: '在订单页申请', indexes: ['refund'] });
    assert.deepEqual(out[1], { q: '如何改地址？', a: '联系客服', indexes: [] });
  });

  it('英文列名 q/a 归一化', async () => {
    await writeXlsx('en.xlsx', [{ q: 'Q1', a: 'A1' }]);
    const out = (await parseFile(path.join(dir, 'en.xlsx'))) as Array<{ q: string; a: string }>;
    assert.deepEqual(out[0], { q: 'Q1', a: 'A1', indexes: [] });
  });

  it('无问题列时整行格式化为 Key: Value 文本', async () => {
    await writeXlsx('kv.xlsx', [{ name: '张三', age: 30 }]);
    const out = (await parseFile(path.join(dir, 'kv.xlsx'))) as Array<{ q: string }>;
    assert.ok(out[0]!.q.includes('name: 张三'));
    assert.ok(out[0]!.q.includes('age: 30'));
  });
});

describe('parser: normalizeDataset 与扩展名校验', () => {
  it('normalizeDataset 支持 q/question/问题/题目 列', () => {
    const rows = normalizeDataset([
      { question: 'q1', answer: 'a1' },
      { 题目: 'q2', 答案: 'a2' },
    ]);
    assert.deepEqual(rows, [
      { q: 'q1', a: 'a1', indexes: [] },
      { q: 'q2', a: 'a2', indexes: [] },
    ]);
  });

  it('isSupportedExtension', () => {
    assert.equal(isSupportedExtension('a.pdf'), true);
    assert.equal(isSupportedExtension('a.xlsx'), true);
    assert.equal(isSupportedExtension('a.xyz'), false);
    assert.equal(isSupportedExtension('noext'), true);
  });

  it('不支持的扩展名抛错', async () => {
    await write('bad.xyz', 'xxx');
    await assert.rejects(parseFile(path.join(dir, 'bad.xyz')), /Unsupported file extension/);
  });
});
