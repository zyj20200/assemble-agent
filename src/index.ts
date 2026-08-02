/**
 * 服务入口：Hono app 组装 + 启动
 *
 * 首次使用：npm run seed（播种演示数据）→ npm start
 * 或：LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL=... npm run seed
 */

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { fileURLToPath } from 'node:url';
import { createOpenAiCompatApp, handleApiError } from './api/openai-compat.ts';
import { createManagementApp } from './api/management.ts';
import { config } from './config.ts';
import { openDb, type AppDb } from './db/index.ts';
import { buildRegistryFromDb, loadAgentsFromDb } from './db/loaders.ts';
import { KnowledgeBaseService } from './core/kb-service.ts';
import { McpManager } from './core/mcp.ts';
import { logger, newRequestId } from './log.ts';
import { configureSecretKey } from './security.ts';
import { ModelRegistry } from './core/models.ts';
import type { AgentDefinition } from './core/agent/assemble.ts';

export interface CreateAppOptions {
  /** 测试注入：自定义 registry（如 faux provider） */
  registry?: ModelRegistry;
  /** 测试注入：直接指定 Agent 列表（跳过 DB 装配） */
  agents?: AgentDefinition[];
  /** 测试注入：内存 DB */
  db?: AppDb;
  kbService?: KnowledgeBaseService;
  mcp?: McpManager;
}

export function createApp(options: CreateAppOptions = {}): Hono {
  configureSecretKey();
  const { db } = options.db ? { db: options.db } : openDb();
  const registry = options.registry ?? new ModelRegistry();
  const kb = options.kbService ?? new KnowledgeBaseService({ db });
  const mcp = options.mcp ?? new McpManager();

  let agents: AgentDefinition[];
  let loadAgents: () => AgentDefinition[];
  if (options.agents) {
    agents = options.agents;
    loadAgents = () => options.agents!;
  } else {
    // DB 驱动装配：Provider/模型注册在启动时；Agent 每请求从 DB 即时装载
    buildRegistryFromDb(db, registry);
    loadAgents = () => loadAgentsFromDb(db, kb);
    agents = loadAgents();
  }

  const app = new Hono();

  // 结构化请求日志：requestId / method / path / status / durationMs（不记请求体与密钥）
  app.use('*', async (c, next) => {
    const requestId = newRequestId();
    const start = performance.now();
    try {
      await next();
    } finally {
      logger.info('request', {
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Math.round((performance.now() - start) * 10) / 10,
      });
    }
  });

  // CORS：ASSEMBLE_ALLOW_ORIGINS（逗号分隔）；默认关闭
  const allowOrigins = (config.allowOrigins ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (allowOrigins.length > 0) {
    const set = new Set(allowOrigins);
    app.use('*', async (c, next) => {
      const origin = c.req.header('origin');
      if (origin && set.has(origin)) {
        c.header('Access-Control-Allow-Origin', origin);
        c.header('Vary', 'Origin');
        c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      }
      if (c.req.method === 'OPTIONS') return c.body(null, 204);
      await next();
    });
  }

  app.onError(handleApiError);

  // 可选鉴权：ASSEMBLE_API_KEY 存在时 /v1/* 要求 Bearer
  if (config.apiKey) {
    app.use('/v1/*', async (c, next) => {
      const auth = c.req.header('authorization');
      if (auth !== `Bearer ${config.apiKey}`) {
        return c.json(
          { error: { message: '未授权', type: 'invalid_request_error', code: 'invalid_api_key' } },
          401,
        );
      }
      await next();
    });
  }

  app.route('/', createManagementApp({ db, kb, mcp }));
  app.route(
    '/',
    createOpenAiCompatApp({
      registry,
      mcp,
      // 每请求从 DB 装载（SQLite 毫秒级；后续可加 TTL 缓存优化）
      getAgent: (name) => loadAgents().find((a) => a.name === name),
      listAgents: () => loadAgents().map((a) => a.name),
    }),
  );

  // 管理页面（静态）
  const webRoot = fileURLToPath(new URL('../web', import.meta.url));
  app.get('/', serveStatic({ root: webRoot, path: 'index.html' }));
  app.get('/prototype.html', serveStatic({ root: webRoot, path: 'prototype.html' }));

  return app;
}

// 直接运行（node src/index.ts）时启动服务
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const mcp = new McpManager();
  const app = createApp({ mcp });
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`assemble-agent 已启动: http://localhost:${info.port}`);
    console.log(`  POST /v1/chat/completions（OpenAI 兼容，model=Agent 名）`);
    console.log(`  GET  /v1/models | /api/health | /api/agents`);
    console.log(`  管理 CRUD：/api/providers /api/models /api/skills /api/mcp-servers /api/knowledge-bases`);
  });
  const shutdown = async () => {
    await mcp.closeAll(); // 关闭 MCP 子进程/连接
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
