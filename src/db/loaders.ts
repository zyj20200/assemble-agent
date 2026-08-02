/**
 * DB → 运行时装配：从数据库加载 Provider/模型/Agent，注册进 ModelRegistry
 * （DESIGN.md §2.2：组装结果由数据库配置驱动）
 */

import { eq } from 'drizzle-orm';
import type { AppDb } from './index.ts';
import { schema } from './index.ts';
import type { ModelRegistry } from '../core/models.ts';
import type { AgentDefinition } from '../core/agent/assemble.ts';
import type { KnowledgeBaseService } from '../core/kb-service.ts';

/** 从 DB 注册所有启用 Provider 及其模型 */
export function buildRegistryFromDb(db: AppDb, registry: ModelRegistry): void {
  const providers = db.select().from(schema.providers).where(eq(schema.providers.enabled, true)).all();
  const allModels = db.select().from(schema.models).where(eq(schema.models.enabled, true)).all();
  for (const p of providers) {
    const models = allModels.filter((m) => m.providerId === p.id).map((m) => ({
      id: m.modelId,
      name: m.name,
      providerId: String(p.id),
      temperature: m.temperature ?? undefined,
      maxTokens: m.maxTokens ?? undefined,
    }));
    if (models.length === 0) continue;
    registry.registerProvider(
      { id: String(p.id), name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey ?? undefined },
      models,
    );
  }
}

/** 从 DB 加载启用 Agent 的组装定义 */
export function loadAgentsFromDb(db: AppDb, kb: KnowledgeBaseService): AgentDefinition[] {
  const agents = db.select().from(schema.agents).where(eq(schema.agents.enabled, true)).all();
  const defs: AgentDefinition[] = [];

  for (const a of agents) {
    const model = db.select().from(schema.models).where(eq(schema.models.id, a.modelId)).get();
    if (!model) continue; // 模型被删/禁用 → 跳过

    const kbLinks = db
      .select({ kbId: schema.agentKnowledgeBases.knowledgeBaseId })
      .from(schema.agentKnowledgeBases)
      .where(eq(schema.agentKnowledgeBases.agentId, a.id))
      .all();

    const knowledgeBaseRefs = kbLinks
      .map((link) => {
        const store = kb.getStore(link.kbId);
        if (!store) return undefined;
        const kbRow = db.select().from(schema.knowledgeBases).where(eq(schema.knowledgeBases.id, link.kbId)).get();
        return {
          store,
          embed: kb.getEmbedder(link.kbId),
          datasetId: String(link.kbId),
          topK: kbRow?.topK ?? 5,
          minScore: kbRow?.minScore ?? 0.3,
        };
      })
      .filter((x): x is NonNullable<typeof x> => !!x);

    defs.push({
      name: a.name,
      description: a.description ?? undefined,
      systemPrompt: a.systemPrompt,
      providerId: String(model.providerId),
      modelId: model.modelId,
      temperature: a.temperature ?? undefined,
      maxTokens: a.maxTokens ?? undefined,
      knowledgeBase: knowledgeBaseRefs[0], // MVP：单知识库；多知识库后续支持
    });
  }

  return defs;
}
