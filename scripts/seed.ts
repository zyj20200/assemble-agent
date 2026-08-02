/**
 * 数据库播种：从环境变量 + 演示数据初始化 DB（DESIGN.md §10 M6 种子数据）
 *
 * 用法：npm run seed
 *   LLM_BASE_URL / LLM_API_KEY / LLM_MODEL   → 注册 Provider + 模型
 *   EMBEDDING_BASE_URL / KEY / MODEL         → 客服小助手挂知识库
 */

import { openDb } from '../src/db/index.ts';
import { schema } from '../src/db/index.ts';

const db = openDb().db;

const count = <T,>(table: T) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (db.select().from(table as any) as any).all().length;
};

const seeded: string[] = [];

// --- Provider + Model（来自环境变量）---
const llmBase = process.env.LLM_BASE_URL;
const llmKey = process.env.LLM_API_KEY;
const llmModel = process.env.LLM_MODEL;

if (llmBase && llmModel && count(schema.providers) === 0) {
  const embModel = process.env.EMBEDDING_MODEL ?? null;
  const provider = db
    .insert(schema.providers)
    .values({ name: 'default', baseUrl: llmBase, apiKey: llmKey ?? null, embeddingModel: embModel })
    .returning()
    .get();
  db.insert(schema.models)
    .values({
      name: llmModel,
      providerId: provider.id,
      modelId: llmModel,
      description: '由 seed 从环境变量注册',
    })
    .run();
  seeded.push(`Provider「default」+ 模型「${llmModel}」`);
}

// --- 知识库（有嵌入配置时）---
let kbId: number | null = null;
const embBase = process.env.EMBEDDING_BASE_URL;
const embKey = process.env.EMBEDDING_API_KEY;
if (embBase && embKey && count(schema.knowledgeBases) === 0) {
  const kb = db
    .insert(schema.knowledgeBases)
    .values({
      name: '产品FAQ',
      description: '产品常见问题与退换货政策',
      chunkSize: 500,
      chunkOverlap: 100,
      embeddingModel: process.env.EMBEDDING_MODEL ?? null,
      topK: 5,
      minScore: 0.3,
    })
    .returning()
    .get();
  kbId = kb.id;
  seeded.push(`知识库「产品FAQ」`);
}

// --- Agent ---
if (count(schema.agents) === 0) {
  const modelRow = db.select().from(schema.models).get();
  if (modelRow) {
    const chat = db
      .insert(schema.agents)
      .values({
        name: '纯对话助手',
        description: '只有提示词 + 模型的纯对话 Agent',
        systemPrompt: '你是一个乐于助人的助手，用简洁的中文回答问题。',
        modelId: modelRow.id,
      })
      .returning()
      .get();
    seeded.push(`Agent「纯对话助手」`);

    if (kbId !== null) {
      const kb = db
        .insert(schema.agents)
        .values({
          name: '客服小助手',
          description: '客服 Agent：需要事实依据时自动检索知识库',
          systemPrompt:
            '你是 XX 产品的客服助手。回答需要事实依据的问题时，先调用知识库检索工具，再基于检索结果作答，并注明来源。检索不到时如实说明，不要编造。',
          modelId: modelRow.id,
          ragMode: 'auto',
          useRag: true,
        })
        .returning()
        .get();
      db.insert(schema.agentKnowledgeBases).values({ agentId: kb.id, knowledgeBaseId: kbId }).run();
      seeded.push(`Agent「客服小助手」（挂载知识库）`);
    }
  }
}

if (seeded.length === 0) {
  console.log('DB 已有数据或环境变量不全，未执行播种。');
  console.log('提示：设置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL（+ EMBEDDING_* 可选）后重新执行。');
} else {
  console.log('播种完成：');
  for (const s of seeded) console.log(`  - ${s}`);
}
console.log(`DB 位置：${process.env.ASSEMBLE_DB_PATH ?? 'data/assemble.db'}`);
