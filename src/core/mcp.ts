/**
 * MCP 客户端管理（DESIGN.md §6.3）
 *
 * - stdio：StdioClientTransport（本地脚本/npx 服务），http：StreamableHTTPClientTransport
 * - 工具命名：`{server}__{tool}`（唯一、免重名冲突，描述中注明所属 server）
 * - 连接复用（进程级懒连接 + listTools 缓存 TTL）；高并发多节点演进为连接池
 * - 工具执行超时 60s；响应读流阶段 1MB 硬顶（防恶意/故障 server 无限流打爆内存）
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type TSchema, type Static } from '@earendil-works/pi-ai';

/** mcp_servers 表的运行时形态 */
export interface McpServerConfig {
  id: number;
  name: string;
  transport: 'stdio' | 'http';
  command?: string | null;
  args?: string[] | null;
  env?: Record<string, string> | null;
  url?: string | null;
  headers?: Record<string, string> | null;
}

export interface McpManagerOptions {
  /** listTools 缓存 TTL（ms），默认 5 分钟 */
  toolsTtlMs?: number;
  /** 工具执行超时（ms），默认 60s */
  toolTimeoutMs?: number;
  /** 响应大小上限（字节），默认 1MB */
  maxResponseBytes?: number;
}

const DEFAULT_OPTS: Required<McpManagerOptions> = {
  toolsTtlMs: 5 * 60_000,
  toolTimeoutMs: 60_000,
  maxResponseBytes: 1024 * 1024,
};

interface ServerEntry {
  config: McpServerConfig;
  client: Client;
  close: () => Promise<void>;
  toolsPromise: Promise<AgentTool[]> | null;
  toolsLoadedAt: number;
}

export class McpManager {
  private entries = new Map<number, ServerEntry>();
  private opts: Required<McpManagerOptions>;

  constructor(options: McpManagerOptions = {}) {
    this.opts = { ...DEFAULT_OPTS, ...options };
  }

  /** 获取某 server 的 AgentTool 列表（懒建连 + 缓存 TTL） */
  async getTools(config: McpServerConfig): Promise<AgentTool[]> {
    const entry = await this.ensureConnected(config);
    const now = Date.now();
    if (entry.toolsPromise && now - entry.toolsLoadedAt < this.opts.toolsTtlMs) {
      return entry.toolsPromise;
    }
    entry.toolsPromise = this.listTools(entry);
    entry.toolsLoadedAt = now;
    try {
      return await entry.toolsPromise;
    } catch (err) {
      entry.toolsPromise = null;
      throw err;
    }
  }

  /** 测试连接：建连 + listTools（管理页 test 按钮；超时保护由调用方/内部实现） */
  async test(config: McpServerConfig): Promise<{ ok: true; server: string; tools: string[] }> {
    const entry = await this.ensureConnected(config);
    const { tools } = await entry.client.listTools();
    return { ok: true, server: config.name, tools: tools.map((t) => t.name) };
  }

  /** 关闭全部连接（应用退出） */
  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map((e) => e.close().catch(() => undefined)),
    );
    this.entries.clear();
  }

  // -------------------------------------------------------------------------

  private async ensureConnected(config: McpServerConfig): Promise<ServerEntry> {
    const existing = this.entries.get(config.id);
    if (existing) return existing;

    const { client, close } = await this.connect(config);
    const entry: ServerEntry = {
      config,
      client,
      close,
      toolsPromise: null,
      toolsLoadedAt: 0,
    };
    this.entries.set(config.id, entry);
    return entry;
  }

  private async connect(config: McpServerConfig): Promise<{ client: Client; close: () => Promise<void> }> {
    const client = new Client({ name: 'assemble-agent', version: '0.1.0' });
    let transport: StdioClientTransport | StreamableHTTPClientTransport;

    if (config.transport === 'http') {
      if (!config.url) throw new Error(`MCP Server ${config.name} 缺少 url`);
      transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      });
    } else {
      if (!config.command) throw new Error(`MCP Server ${config.name} 缺少 command`);
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: config.env ?? undefined,
        stderr: 'ignore',
      });
    }

    try {
      await client.connect(transport);
    } catch (err) {
      // 连接失败：关闭 transport，避免后台重试定时器挂起进程
      try {
        await transport.close();
      } catch {
        /* 忽略二次错误 */
      }
      throw err;
    }
    return {
      client,
      close: async () => {
        await client.close();
        try {
          await transport.close();
        } catch {
          /* 忽略 */
        }
      },
    };
  }

  private async listTools(entry: ServerEntry): Promise<AgentTool[]> {
    const { tools } = await entry.client.listTools();
    // 前缀用 ASCII 安全标识 mcp{id}（OpenAI 协议要求工具名匹配 ^[a-zA-Z0-9_-]+$，中文名会 400）；
    // 展示名/描述中保留 server 原始名
    const prefix = `mcp${entry.config.id}__`;
    return tools.map((t) =>
      createMcpTool(entry, prefix + t.name, t.name, t.description ?? '', t.inputSchema ?? {}, this.opts),
    );
  }
}

/** MCP 远端工具 → AgentTool（参数 schema 由 JSON Schema 转换，执行走 client.callTool） */
function createMcpTool(
  entry: ServerEntry,
  toolName: string,
  remoteName: string,
  description: string,
  inputSchema: unknown,
  opts: Required<McpManagerOptions>,
): AgentTool {
  const parameters = jsonSchemaToTypebox(inputSchema);

  return {
    name: toolName,
    label: `${entry.config.name} / ${remoteName}`,
    description: `[MCP: ${entry.config.name}] ${description}`,
    parameters,
    execute: async (toolCallId, params) => {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`工具 ${toolName} 执行超时（>${opts.toolTimeoutMs}ms）`)), opts.toolTimeoutMs),
      );
      const call = entry.client.callTool({ name: remoteName, arguments: params as Record<string, unknown> | undefined });
      const result = await Promise.race([call, timeout]);
      const text = await serializeToolResult(result, opts.maxResponseBytes);
      return {
        content: [{ type: 'text', text }],
        details: { server: entry.config.name, tool: remoteName, isError: result?.isError === true },
      };
    },
  };
}

/** 工具结果序列化：文本/图片混合 → 文本；读流阶段限 1MB */
async function serializeToolResult(result: unknown, maxBytes: number): Promise<string> {
  const r = result as { content?: unknown[]; isError?: boolean } | undefined;
  if (!r || !Array.isArray(r.content)) return String(result ?? '');

  const parts: string[] = [];
  let bytes = 0;
  for (const block of r.content) {
    const b = block as { type?: string; text?: string; data?: string };
    if (b?.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
      bytes += b.text.length;
    } else if (b?.type === 'image' && typeof b.data === 'string') {
      const marker = `[图片内容，base64 ${b.data.length} 字符]`;
      parts.push(marker);
      bytes += marker.length;
    } else {
      parts.push(JSON.stringify(block ?? null));
      bytes += JSON.stringify(block ?? null).length;
    }
    if (bytes > maxBytes) {
      return parts.join('\n').slice(0, maxBytes) + '\n[结果已截断（超过 1MB 限制）]';
    }
  }
  if (r.isError) {
    return `[工具返回错误]\n${parts.join('\n')}`;
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// JSON Schema → typebox（MCP inputSchema 常见形态；未识别时退回 Unknown）
// ---------------------------------------------------------------------------

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  anyOf?: JsonSchema[];
};

export function jsonSchemaToTypebox(schema: unknown): TSchema {
  const s = (schema ?? {}) as JsonSchema;
  if (!s || typeof s !== 'object') return Type.Unknown();
  const desc = s.description ? { description: s.description } : {};

  switch (s.type) {
    case 'object': {
      const props: Record<string, TSchema> = {};
      const required = new Set(s.required ?? []);
      for (const [key, ps] of Object.entries(s.properties ?? {})) {
        const t = jsonSchemaToTypebox(ps);
        props[key] = required.has(key) ? t : Type.Optional(t);
      }
      return Type.Object(props, desc);
    }
    case 'string': {
      if (Array.isArray(s.enum) && s.enum.length > 0) {
        return Type.Union(s.enum.map((v) => Type.Literal(String(v))), desc);
      }
      return Type.String(desc);
    }
    case 'number':
      return Type.Number(desc);
    case 'integer':
      return Type.Integer(desc);
    case 'boolean':
      return Type.Boolean(desc);
    case 'array':
      return Type.Array(jsonSchemaToTypebox(s.items ?? {}), desc);
    default: {
      if (Array.isArray(s.anyOf) && s.anyOf.length > 0) {
        return Type.Union(s.anyOf.map((x) => jsonSchemaToTypebox(x)));
      }
      return Type.Unknown();
    }
  }
}

// Static 类型引用（供类型推导使用，避免未使用告警）
export type { Static };
