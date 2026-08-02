import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PgVectorStore } from '../../../src/core/rag/vector-store.ts';
import type { VectorItem } from '../../../src/core/rag/types.ts';

/**
 * pgvector 真库集成测试。
 * 需要 PG_TEST_URL 指向启用了 pgvector 的 PostgreSQL；不可用时自动 skip。
 * 启动方式：
 *   docker run -d --name assemble-pg-test -e POSTGRES_PASSWORD=test \
 *     -p 55433:5432 pgvector/pgvector:pg16
 *   PG_TEST_URL=postgresql://postgres:test@127.0.0.1:55433/postgres npm test
 */
const PG_TEST_URL =
  process.env.PG_TEST_URL ?? 'postgresql://postgres:test@127.0.0.1:55433/postgres';
const TABLE = `kb_vec_test_${Date.now()}`;

/** 确定性 8 维 one-hot 向量（已归一化）：相同文本 → 相同向量，不同文本 → 正交 */
function makeExactEmbed() {
  const map = new Map<string, number[]>();
  const embed = async (texts: string[]) =>
    texts.map((t) => {
      let v = map.get(t);
      if (!v) {
        v = new Array(8).fill(0);
        v[map.size % 8] = 1;
        map.set(t, v);
      }
      return v;
    });
  return { embed };
}

let available = true;
let store: PgVectorStore | null = null;
let admin: pg.Pool | null = null;

before(async () => {
  try {
    admin = new pg.Pool({ connectionString: PG_TEST_URL, connectionTimeoutMillis: 2500 });
    await admin.query('SELECT 1');
    store = new PgVectorStore({ connectionString: PG_TEST_URL, tableName: TABLE, dimensions: 8 });
  } catch {
    available = false;
    console.warn(`[pgvector] PG 不可用（${PG_TEST_URL}），跳过集成测试`);
  }
});

after(async () => {
  if (available && admin) {
    try {
      await admin.query(`DROP TABLE IF EXISTS ${TABLE}`);
    } catch {
      /* 忽略清理失败 */
    }
    await admin.end();
    await store?.close();
  }
});

describe('pgvector 真库：存取与检索', () => {
  it('insert → search 精确命中 + 分数正确', async (t) => {
    if (!available || !store) return t.skip('PG 不可用');
    const { embed } = makeExactEmbed();
    const items: VectorItem[] = [
      { datasetId: 'ds', documentId: 'a', chunkIndex: 0, vectorText: '怎么退货？', content: '联系客服处理退款' },
      { datasetId: 'ds', documentId: 'a', chunkIndex: 1, vectorText: '密码忘了', content: '点击找回密码' },
      { datasetId: 'other', documentId: 'b', chunkIndex: 0, vectorText: '无关内容', content: '别的库' },
    ];
    await store.insert(items, await embed(items.map((i) => i.vectorText)));

    // 精确命中：query = 同一文本 → score ≈ 1
    const [qv] = await embed(['怎么退货？']);
    const hits = await store.search('ds', qv!, { limit: 5, minScore: 0.99 });
    assert.equal(hits.length, 1, '应精确命中一条');
    assert.equal(hits[0]!.content, '联系客服处理退款');
    assert.ok(hits[0]!.score > 0.99);

    // 跨库隔离：other 库内容不出现
    assert.ok(hits.every((h) => h.datasetId === 'ds'));
  });

  it('minScore 阈值过滤与 limit', async (t) => {
    if (!available || !store) return t.skip('PG 不可用');
    const { embed } = makeExactEmbed();
    const [qv] = await embed(['怎么退货？']);
    const all = await store.search('ds', qv!, { limit: 10, minScore: 0 });
    assert.ok(all.length >= 2, '不限阈值应返回库内全部（含正交向量 score≈0）');
    const strict = await store.search('ds', qv!, { limit: 10, minScore: 0.5 });
    assert.equal(strict.length, 1, '阈值 0.5 只留精确命中');
    const limited = await store.search('ds', qv!, { limit: 1, minScore: 0 });
    assert.equal(limited.length, 1);
  });

  it('deleteByDocument 只删该文档，deleteByDataset 清空', async (t) => {
    if (!available || !store) return t.skip('PG 不可用');
    const { embed } = makeExactEmbed();
    const items: VectorItem[] = [
      { datasetId: 'ds', documentId: 'x', chunkIndex: 0, vectorText: 'x1', content: 'X1' },
      { datasetId: 'ds', documentId: 'y', chunkIndex: 0, vectorText: 'y1', content: 'Y1' },
    ];
    await store.insert(items, await embed(items.map((i) => i.vectorText)));

    await store.deleteByDocument('ds', 'x');
    const [qv] = await embed(['x1']);
    const afterDoc = await store.search('ds', qv!, { limit: 10, minScore: 0 });
    assert.ok(!afterDoc.some((h) => h.documentId === 'x'), '文档 x 应被删除');

    await store.deleteByDataset('ds');
    const afterDs = await store.search('ds', qv!, { limit: 10, minScore: 0 });
    assert.equal(afterDs.length, 0, 'dataset 应被清空');
  });

  it('数量不匹配抛错', async (t) => {
    if (!available || !store) return t.skip('PG 不可用');
    const items: VectorItem[] = [{ datasetId: 'ds', documentId: 'z', chunkIndex: 0, vectorText: 'z', content: 'Z' }];
    // 1 条 item 配 2 个向量 → 触发数量校验
    await assert.rejects(store.insert(items, [[1, 2, 3], [4, 5, 6]]), /数量不一致/);
  });
});
