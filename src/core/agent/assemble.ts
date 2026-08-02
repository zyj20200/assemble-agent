/**
 * Agent 装配：由 AgentDefinition（DB 配置的运行时形态）+ ModelRegistry 组装出 pi-agent-core Agent
 */

import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import type { ModelRegistry } from '../models.ts';
import { createKnowledgeBaseTool } from './kb-tool.ts';
import type { EmbedFn } from '../rag/types.ts';
import type { VectorStore } from '../rag/vector-store.ts';
import { McpManager, type McpServerConfig } from '../mcp.ts';

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
  /** 关联的 MCP Server（M4） */
  mcpServers?: McpServerConfig[];
}

export interface AssembleOptions {
  registry: ModelRegistry;
  /** MCP 管理器（工具拉取）；缺省则跳过 MCP 工具 */
  mcp?: McpManager;
  /** 额外工具（请求级客户端工具占位等） */
  extraTools?: AgentTool[];
  /** 覆盖默认系统提示词（请求内 system 消息） */
  systemPromptOverride?: string;
}

export async function assembleAgent(def: AgentDefinition, opts: AssembleOptions): Promise<Agent> {
  const { registry, extraTools = [], systemPromptOverride, mcp } = opts;

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
  // MCP 工具（懒拉取 + 缓存；单个 server 连接失败仅跳过该 server，不拖垮 Agent）
  if (mcp && def.mcpServers && def.mcpServers.length > 0) {
    for (const server of def.mcpServers) {
      try {
        tools.push(...(await mcp.getTools(server)));
      } catch {
        // 异常隔离：连接失败记日志（上层），该 server 工具不注入
      }
    }
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
