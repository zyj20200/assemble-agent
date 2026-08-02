/**
 * 真实网关 smoke 测试：验证 OpenAI 兼容嵌入端点 + pgvector 全链路
 *
 * 用法：
 *   EMBEDDING_BASE_URL=... EMBEDDING_API_KEY=... EMBEDDING_MODEL=... \
 *     PG_TEST_URL=postgresql://postgres:test@127.0.0.1:55433/postgres \
 *     node scripts/embedding-smoke.ts
 *
 * 前提：PG 已启动（见 tests/core/rag/pg-vector-store.test.ts 顶部说明），
 * 且嵌入网关对当前 key 开放了嵌入模型权限。
 *
 * 注意：API key 只从环境变量读取，不要写死进脚本。
 */

import { OpenAICompatibleEmbedder } from '../src/core/rag/embedding.ts';
import { PgVectorStore } from '../src/core/rag/vector-store.ts';
import { ingestDocument, searchKnowledge } from '../src/core/rag/ingest.ts';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE_URL = process.env.EMBEDDING_BASE_URL ?? 'https://new.hw.22483523.xyz/v1';
const API_KEY = process.env.EMBEDDING_API_KEY;
const MODEL = process.env.EMBEDDING_MODEL ?? 'Pro/BAAI/bge-m3';
const PG_URL =
  process.env.PG_TEST_URL ?? 'postgresql://postgres:test@127.0.0.1:55433/postgres';

if (!API_KEY) {
  console.error('请设置环境变量 EMBEDDING_API_KEY（勿写死在脚本/代码中）');
  process.exit(1);
}
async function main() {
  console.log('== 1. 嵌入端点连通性 ==');
  const embedder = new OpenAICompatibleEmbedder({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    model: MODEL,
    dimensions: 1024,
  });
  const [v0] = await embedder.embed(['冒烟测试']);
  console.log(`   ✅ 嵌入成功，维度=${v0?.length ?? '?'}`);

  console.log('\n== 2. 摄取 → pgvector 检索全链路 ==');
  const store = new PgVectorStore({ connectionString: PG_URL, tableName: 'kb_smoke', dimensions: v0!.length });
  const dir = await mkdtemp(path.join(tmpdir(), 'smoke-'));
  const file = path.join(dir, 'faq.md');
  await writeFile(file, '# 退货政策\n\n客户可在签收后 7 天内联系客服申请退货退款。');

  const result = await ingestDocument({
    datasetId: 'smoke-ds',
    documentId: 'smoke-doc',
    filePath: file,
    fileName: 'faq.md',
    embed: embedder.embed.bind(embedder),
    store,
    chunkSize: 200,
  });
  console.log(`   ✅ 摄取完成：${result.items} 个分块 / ${result.vectors} 条向量`);

  const hits = await searchKnowledge({
    datasetId: 'smoke-ds',
    query: '怎么退货？',
    embed: embedder.embed.bind(embedder),
    store,
    limit: 3,
    minScore: 0.2,
  });
  console.log(`   ✅ 检索命中 ${hits.length} 条:`);
  for (const h of hits) {
    console.log(`      [score=${h.score.toFixed(4)}] ${h.content.slice(0, 60)}`);
  }

  await store.deleteByDataset('smoke-ds');
  await store.close();
  await rm(dir, { recursive: true, force: true });
  console.log('\n   ✅ 清理完成，smoke 通过');
}

main().catch((err) => {
  console.error('\n❌ smoke 失败:', err instanceof Error ? err.message : err);
  console.error('   提示：如果报"token has no access to model"，请在网关（new-api）管理端');
  console.error('   给该令牌添加嵌入模型（Pro/BAAI/bge-m3）所在分组的访问权限。');
  process.exit(1);
});
