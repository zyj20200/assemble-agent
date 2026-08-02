/**
 * 种子配置：环境变量驱动的演示 Agent（正式版由 DB 配置驱动，见 DESIGN.md §2）
 *
 * - LLM_BASE_URL / LLM_API_KEY / LLM_MODEL → 注册一个 OpenAI 兼容 Provider
 * - EMBEDDING_BASE_URL / EMBEDDING_API_KEY / EMBEDDING_MODEL → 客服小助手的知识库
 */

import { ModelRegistry } from './core/models.ts';
import { InMemoryVectorStore } from './core/rag/vector-store.ts';
import { OpenAICompatibleEmbedder } from './core/rag/embedding.ts';
import type { AgentDefinition } from './core/agent/assemble.ts';
import { config } from './config.ts';

const PROVIDER_ID = 'default';

export function createRegistry(): ModelRegistry {
  const registry = new ModelRegistry();
  const { baseUrl, apiKey, model } = config.llm;
  if (baseUrl && model) {
    registry.registerProvider(
      { id: PROVIDER_ID, name: 'default', baseUrl, apiKey },
      [{ id: model, name: model, providerId: PROVIDER_ID }],
    );
  }
  return registry;
}

export function createAgents(registry: ModelRegistry): AgentDefinition[] {
  const agents: AgentDefinition[] = [];
  const { baseUrl, apiKey, model } = config.llm;
  if (!baseUrl || !model) return agents;

  agents.push({
    name: '纯对话助手',
    description: '只有提示词 + 模型的纯对话 Agent',
    systemPrompt: '你是一个乐于助人的助手，用简洁的中文回答问题。',
    providerId: PROVIDER_ID,
    modelId: model,
  });

  // 嵌入配置齐备时，装配带知识库的客服小助手
  const emb = config.embedding;
  if (emb.baseUrl && emb.apiKey && emb.model) {
    const embedder = new OpenAICompatibleEmbedder({
      baseUrl: emb.baseUrl,
      apiKey: emb.apiKey,
      model: emb.model,
      dimensions: 1024,
    });
    agents.push({
      name: '客服小助手',
      description: '客服 Agent：需要事实依据时自动检索知识库',
      systemPrompt:
        '你是 XX 产品的客服助手。回答需要事实依据的问题时，先调用知识库检索工具，再基于检索结果作答，并注明来源。检索不到时如实说明，不要编造。',
      providerId: PROVIDER_ID,
      modelId: model,
      knowledgeBase: {
        store: new InMemoryVectorStore(),
        embed: embedder.embed.bind(embedder),
        datasetId: 'seed-kb',
        minScore: 0.3,
        topK: 5,
      },
    });
  }

  return agents;
}
