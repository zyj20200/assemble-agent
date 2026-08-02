/**
 * OpenAI 兼容 API 层（DESIGN.md §5.1）
 *
 * 职责（薄适配，不承担循环逻辑）：
 * - 解析 OpenAI 请求 → 组装 pi-agent-core Agent
 * - 把 agent 事件流映射为 OpenAI SSE chunk（text_delta → delta.content；客户端工具 → delta.tool_calls）
 * - 非流式：收集事件，产出标准 ChatCompletion（含 usage）
 * - 错误映射为 OpenAI 风格错误码（§5.1.5）
 *
 * 工具语义（§5.1.3）：
 * - 服务端工具（kb-tool / 后续 MCP）：Agent 内部执行，流中**不**暴露 tool_calls（透明）
 * - 请求内 tools（客户端工具）：注册为占位 AgentTool，调用返回"未注册"并终止循环，
 *   流中暴露 tool_calls chunk 且 finish_reason='tool_calls'，由客户端执行后续送
 */

import { Hono } from 'hono';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai';
import { assembleAgent, type AgentDefinition } from '../core/agent/assemble.ts';
import type { ModelRegistry } from '../core/models.ts';
import { ApiError, ApiErrors } from './errors.ts';
import { McpManager } from '../core/mcp.ts';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }> | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>;
  tool_choice?: unknown;
  n?: number;
  /** 管理页试运行专用：SSE 中透出服务端工具轨迹（process delta） */
  x_emit_process?: boolean;
  stream_options?: { include_usage?: boolean };
}

export interface OpenAiCompatDeps {
  registry: ModelRegistry;
  getAgent: (name: string) => AgentDefinition | undefined;
  /** 已启用 Agent 名列表（/v1/models） */
  listAgents: () => string[];
  /** MCP 管理器（装配时拉取工具） */
  mcp?: McpManager;
}

// ---------------------------------------------------------------------------
// 请求解析
// ---------------------------------------------------------------------------

function textOf(content: ChatMessage['content']): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text)
    .join('\n');
}

/** 空 usage（构造历史 assistant 消息时需要完整字段） */
const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** OpenAI 消息 → AgentMessage[]，并提取 system 覆盖 */
function toAgentMessages(
  messages: ChatMessage[],
  meta: { provider: string; model: string },
): { systemPrompt?: string; agentMessages: AgentMessage[] } {
  let systemPrompt: string | undefined;
  const out: AgentMessage[] = [];


  for (const m of messages) {
    switch (m.role) {
      case 'system':
        systemPrompt = textOf(m.content);
        break;
      case 'user':
        out.push({ role: 'user', content: textOf(m.content), timestamp: Date.now() });
        break;
      case 'assistant': {
        const blocks: AssistantMessage['content'] = [];
        const text = textOf(m.content);
        if (text) blocks.push({ type: 'text', text });
        for (const tc of m.tool_calls ?? []) {
          let args: Record<string, unknown> = {};
          try {
            args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch {
            args = {};
          }
          blocks.push({ type: 'toolCall', id: tc.id, name: tc.function.name, arguments: args } as ToolCall);
        }
        if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
        out.push({
          role: 'assistant',
          content: blocks,
          // 历史消息需携带完整 AssistantMessage 元数据（api/provider/model/usage/stopReason）
          api: 'openai-completions',
          provider: meta.provider,
          model: meta.model,
          usage: EMPTY_USAGE,
          stopReason: 'stop',
          timestamp: Date.now(),
        });
        break;
      }
      case 'tool': {
        if (!m.tool_call_id) throw ApiErrors.invalidRequest('role=tool 的消息缺少 tool_call_id');
        out.push({
          role: 'toolResult',
          toolCallId: m.tool_call_id,
          toolName: m.name ?? '',
          content: [{ type: 'text', text: textOf(m.content) }],
          isError: false,
          timestamp: Date.now(),
        });
        break;
      }
      default:
        throw ApiErrors.invalidRequest(`不支持的 message role: ${m.role}`);
    }
  }

  return { systemPrompt, agentMessages: out };
}

/** 请求级客户端工具 → 占位 AgentTool（"未注册" + terminate） */
function clientToolPlaceholders(
  tools: NonNullable<ChatRequest['tools']>,
  serverToolNames: Set<string>,
): { placeholders: AgentTool[]; clientNames: Set<string> } {
  const placeholders: AgentTool[] = [];
  const clientNames = new Set<string>();
  for (const t of tools) {
    if (serverToolNames.has(t.function.name)) {
      throw ApiErrors.invalidRequest(`请求内工具 ${t.function.name} 与服务端工具重名`);
    }
    clientNames.add(t.function.name);
    placeholders.push({
      name: t.function.name,
      label: t.function.name,
      description: t.function.description ?? '客户端工具（未在本服务注册）',
      parameters: Type.Unknown(),
      execute: async () => ({
        content: [
          { type: 'text', text: `工具 ${t.function.name} 未在本服务注册，无法执行。请由调用方执行后回传结果。` },
        ],
        // 单工具批次下终止循环，让 finish_reason='tool_calls' 返回给客户端
        terminate: true,
        details: { unregistered: true },
      }),
    });
  }
  return { placeholders, clientNames };
}

// ---------------------------------------------------------------------------
// 响应构造
// ---------------------------------------------------------------------------

const textOfBlocks = (blocks: readonly { type: string; text?: string }[]) =>
  blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');

const toolCallsOf = (msg: AssistantMessage) =>
  msg.content.filter((b): b is ToolCall => b.type === 'toolCall');

function toOpenAiUsage(usage: AssistantMessage['usage']) {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.input,
    completion_tokens: usage.output,
    total_tokens: usage.totalTokens ?? usage.input + usage.output,
  };
}

function toOpenAiToolCalls(calls: ToolCall[]) {
  return calls.map((c) => ({
    id: c.id,
    type: 'function' as const,
    function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
  }));
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

export function createOpenAiCompatApp(deps: OpenAiCompatDeps): Hono {
  const app = new Hono();

  app.get('/v1/models', (c) => {
    return c.json({
      object: 'list',
      data: deps.listAgents().map((name) => ({
        id: name,
        object: 'model',
        owned_by: 'assemble-agent',
      })),
    });
  });

  app.post('/v1/chat/completions', async (c) => {
    let body: ChatRequest;
    try {
      body = await c.req.json();
    } catch {
      throw ApiErrors.invalidRequest('请求体不是合法 JSON');
    }

    // --- 校验（§5.1.5 / §8.2 裁定子集） ---
    if (body.n !== undefined && body.n !== 1) {
      throw ApiErrors.invalidRequest('n 仅支持 1');
    }
    if (body.tool_choice !== undefined && body.tool_choice !== 'auto') {
      throw ApiErrors.invalidRequest('tool_choice 仅支持 auto');
    }
    const def = deps.getAgent(body.model);
    if (!def) throw ApiErrors.modelNotFound(body.model);
    const { systemPrompt, agentMessages } = toAgentMessages(body.messages ?? [], {
      provider: def.providerId,
      model: def.modelId,
    });
    if (agentMessages.length === 0) {
      throw ApiErrors.invalidRequest('messages 中至少需要一条非 system 消息');
    }

    const agent = await assembleAgent(def, {
      registry: deps.registry,
      mcp: deps.mcp,
      systemPromptOverride: systemPrompt,
    });
    // 服务端工具名（kb + MCP）从 Agent 实际装配结果取，用于区分客户端工具
    const serverToolNames = new Set(agent.state.tools.map((t) => t.name));
    const { placeholders, clientNames } = clientToolPlaceholders(body.tools ?? [], serverToolNames);
    if (placeholders.length > 0) {
      agent.state.tools = [...agent.state.tools, ...placeholders];
    }

    if (!body.stream) {
      return await runNonStream({ c, agent, messages: agentMessages, model: body.model, clientNames });
    }
    return await runStream({
      c,
      agent,
      messages: agentMessages,
      model: body.model,
      clientNames,
      emitProcess: body.x_emit_process === true,
      includeUsage: body.stream_options?.include_usage === true,
    });
  });

  return app;
}

// ---------------------------------------------------------------------------
// 实现细节
// ---------------------------------------------------------------------------

const isClientTool =
  (clientNames: Set<string>) =>
  (name: string): boolean =>
    clientNames.has(name);

// ---------- 非流式 ----------

async function runNonStream(args: {
  c: import('hono').Context;
  agent: import('@earendil-works/pi-agent-core').Agent;
  messages: AgentMessage[];
  model: string;
  clientNames: Set<string>;
}) {
  const { c, agent, messages, model, clientNames } = args;
  let agentEnd: Extract<AgentEvent, { type: 'agent_end' }> | undefined;
  agent.subscribe((e) => {
    if (e.type === 'agent_end') agentEnd = e;
  });

  try {
    await agent.prompt(messages);
  } catch (err) {
    const last = agentEnd ? lastAssistant(agentEnd.messages) : undefined;
    if (last?.stopReason === 'error') {
      throw ApiErrors.upstreamUnavailable(last.errorMessage ?? '上游模型错误');
    }
    throw ApiErrors.internal(err instanceof Error ? err.message : String(err));
  }

  if (!agentEnd) throw ApiErrors.internal('Agent 运行未产生 agent_end');

  const last = lastAssistant(agentEnd.messages);
  // 上游失败时 pi-agent-core 不抛异常，而是产出 stopReason=error 的失败消息 + agent_end
  if (last?.stopReason === 'error') {
    throw ApiErrors.upstreamUnavailable(last.errorMessage ?? '上游模型错误');
  }
  const text = last ? textOfBlocks(last.content) : '';
  const clientCalls = last ? toolCallsOf(last).filter((tc) => isClientTool(clientNames)(tc.name)) : [];
  const finish = clientCalls.length > 0 ? 'tool_calls' : last?.stopReason === 'length' ? 'length' : 'stop';

  return c.json({
    id: `chatcmpl-${randomId()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          ...(clientCalls.length ? { tool_calls: toOpenAiToolCalls(clientCalls) } : {}),
        },
        finish_reason: finish,
      },
    ],
    usage: last ? toOpenAiUsage(last.usage) : undefined,
  });
}

// ---------- 流式 ----------

interface StreamState {
  id: string;
  created: number;
  sentRole: boolean;
  argsLen: Map<number, number>;
}

function sseChunk(state: StreamState, model: string, delta: Record<string, unknown>, finish_reason: string | null): string {
  return JSON.stringify({
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model,
    choices: [{ index: 0, delta, finish_reason }],
  });
}

async function runStream(args: {
  c: import('hono').Context;
  agent: import('@earendil-works/pi-agent-core').Agent;
  messages: AgentMessage[];
  model: string;
  clientNames: Set<string>;
  /** 管理页试运行：透出服务端工具轨迹 */
  emitProcess?: boolean;
  /** 流式返回 usage（OpenAI stream_options.include_usage） */
  includeUsage?: boolean;
}) {
  const { c, agent, messages, model, clientNames, emitProcess = false, includeUsage = false } = args;

  return streamSSE(c, async (stream) => {
    const state: StreamState = {
      id: `chatcmpl-${randomId()}`,
      created: Math.floor(Date.now() / 1000),
      sentRole: false,
      argsLen: new Map(),
    };
    const write = (chunk: string) => stream.writeSSE({ data: chunk });

    try {
      agent.subscribe(async (event) => {
        switch (event.type) {
          case 'agent_start': {
            if (emitProcess) {
              await write(sseChunk(state, model, { process: { type: 'agent_started' } }, null));
            }
            return;
          }
          case 'tool_execution_start': {
            if (emitProcess) {
              const isKb = event.toolName === 'search_knowledge';
              await write(sseChunk(state, model, {
                process: { type: isKb ? 'knowledge_searched' : 'tool_call_started', tool: event.toolName },
              }, null));
            }
            return;
          }
          case 'tool_execution_end': {
            if (emitProcess) {
              const isKb = event.toolName === 'search_knowledge';
              await write(sseChunk(state, model, {
                process: { type: isKb ? 'knowledge_searched' : 'tool_call_finished', tool: event.toolName },
              }, null));
            }
            return;
          }
          case 'message_update': {
            if (event.message.role !== 'assistant') return;
            const ev = event.assistantMessageEvent;
            if (ev.type === 'text_start' && !state.sentRole) {
              state.sentRole = true;
              await write(sseChunk(state, model, { role: 'assistant', content: '' }, null));
            } else if (ev.type === 'text_delta') {
              await write(sseChunk(state, model, { content: ev.delta }, null));
            } else if (ev.type === 'toolcall_start') {
              const call = ev.partial.content[ev.contentIndex];
              if (call?.type === 'toolCall' && isClientTool(clientNames)(call.name)) {
                await write(
                  sseChunk(state, model, {
                    tool_calls: [
                      {
                        index: ev.contentIndex,
                        id: call.id ?? `call_${ev.contentIndex}`,
                        type: 'function',
                        function: { name: call.name, arguments: '' },
                      },
                    ],
                  }, null),
                );
              }
            } else if (ev.type === 'toolcall_delta' || ev.type === 'toolcall_end') {
              const call = ev.partial.content[ev.contentIndex];
              if (call?.type === 'toolCall' && isClientTool(clientNames)(call.name)) {
                // 真实 provider 增量给出参数字符串；部分 provider/faux 直接给对象 → 序列化
                const cur =
                  typeof call.arguments === 'string'
                    ? call.arguments
                    : JSON.stringify(call.arguments ?? {});
                const prev = state.argsLen.get(ev.contentIndex) ?? 0;
                if (cur.length > prev) {
                  await write(
                    sseChunk(state, model, {
                      tool_calls: [{ index: ev.contentIndex, function: { arguments: cur.slice(prev) } }],
                    }, null),
                  );
                  state.argsLen.set(ev.contentIndex, cur.length);
                }
              }
            }
            return;
          }
          case 'agent_end': {
            const last = lastAssistant(event.messages);
            // 上游失败（pi-agent-core 以 stopReason=error 消息 + agent_end 收尾，不抛异常）
            if (last?.stopReason === 'error') {
              await write(JSON.stringify({
                error: { message: last.errorMessage ?? '上游模型错误', type: 'server_error', code: 'upstream_unavailable' },
              }));
              await write('[DONE]');
              return;
            }
            const clientCalls = last ? toolCallsOf(last).filter((tc) => isClientTool(clientNames)(tc.name)) : [];
            const finish = clientCalls.length > 0 ? 'tool_calls' : last?.stopReason === 'length' ? 'length' : 'stop';
            await write(sseChunk(state, model, {}, finish));
            if (includeUsage) {
              // 跨轮累加 usage（OpenAI 约定：stream_options.include_usage 时末尾发 usage chunk）
              const usage = event.messages
                .filter((m) => m.role === 'assistant' && (m as AssistantMessage).usage)
                .reduce((acc, m) => {
                  const u = (m as AssistantMessage).usage;
                  return {
                    prompt_tokens: acc.prompt_tokens + u.input,
                    completion_tokens: acc.completion_tokens + u.output,
                    total_tokens: acc.total_tokens + (u.totalTokens ?? u.input + u.output),
                  };
                }, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
              await write(JSON.stringify({ id: state.id, object: 'chat.completion.chunk', created: state.created, model, choices: [], usage }));
            }
            await write('[DONE]');
            return;
          }
          default:
            return;
        }
      });

      await agent.prompt(messages);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      await write(sseChunk(state, model, {}, null));
      await write(JSON.stringify({ error: { message, type: 'server_error', code: 'internal_error' } }));
      await write('[DONE]');
    }
  });
}

// ---------- 工具函数 ----------

function lastAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'assistant') return m as AssistantMessage;
  }
  return undefined;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

// 统一错误处理：注册到外层 app
export function handleApiError(err: unknown, c: import('hono').Context) {
  if (err instanceof ApiError) {
    return c.json(err.toBody(), err.status as ContentfulStatusCode);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return c.json(ApiErrors.internal(msg).toBody(), 500);
}
