/**
 * Agent 装配：由 AgentDefinition（DB 配置的运行时形态）+ ModelRegistry 组装出 pi-agent-core Agent
 */

import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import type { ModelRegistry } from '../models.ts';
import { createKnowledgeBaseTool } from './kb-tool.ts';
import type { EmbedFn } from '../rag/types.ts';
import type { VectorStore } from '../rag/vector-store.ts';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 知识库引用（KB 组件的运行时形态） */
export interface KnowledgeBaseRef {
  store: VectorStore;
  embed: EmbedFn;
  datasetId: string;
  topK?: number;
  minScore?: number;
}

/** Agent 组装产物定义（DESIGN.md agents 表 + 关联组件的运行时形态） */
export interface AgentDefinition {
  /** 同时也是 /v1 API 的 model 名 */
  name: string;
  description?: string;
  systemPrompt: string;
  providerId: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  temperature?: number;
  maxTokens?: number;
  knowledgeBase?: KnowledgeBaseRef;
}

export interface AssembleOptions {
  registry: ModelRegistry;
  /** 额外工具（请求级客户端工具占位等） */
  extraTools?: AgentTool[];
  /** 覆盖默认系统提示词（请求内 system 消息） */
  systemPromptOverride?: string;
}

export function assembleAgent(def: AgentDefinition, opts: AssembleOptions): Agent {
  const { registry, extraTools = [], systemPromptOverride } = opts;

  const model = registry.getModel(def.providerId, def.modelId);
  if (!model) {
    throw new Error(`模型未注册: ${def.providerId}/${def.modelId}`);
  }

  const tools: AgentTool[] = [];
  if (def.knowledgeBase) {
    tools.push(
      createKnowledgeBaseTool({
        store: def.knowledgeBase.store,
        embed: def.knowledgeBase.embed,
        datasetId: def.knowledgeBase.datasetId,
        topK: def.knowledgeBase.topK,
        minScore: def.knowledgeBase.minScore,
      }),
    );
  }
  tools.push(...extraTools);

  return new Agent({
    initialState: {
      systemPrompt: systemPromptOverride ?? def.systemPrompt,
      model,
      tools,
      ...(def.thinkingLevel ? { thinkingLevel: def.thinkingLevel } : {}),
    },
    streamFn: registry.streamSimple,
  });
}
