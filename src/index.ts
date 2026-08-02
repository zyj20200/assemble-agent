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
}

export function createApp(options: CreateAppOptions = {}): Hono {
  const { db } = options.db ? { db: options.db } : openDb();
  const registry = options.registry ?? new ModelRegistry();
  const kb = options.kbService ?? new KnowledgeBaseService({ db });

  let agents: AgentDefinition[];
  if (options.agents) {
    agents = options.agents;
  } else {
    // DB 驱动装配：Provider/模型注册 + Agent 组装
    buildRegistryFromDb(db, registry);
    agents = loadAgentsFromDb(db, kb);
  }
  const byName = new Map(agents.map((a) => [a.name, a]));

  const app = new Hono();
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

  app.route('/', createManagementApp({ db, kb }));
  app.route(
    '/',
    createOpenAiCompatApp({
      registry,
      getAgent: (name) => byName.get(name),
      listAgents: () => agents.map((a) => a.name),
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
  const app = createApp();
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`assemble-agent 已启动: http://localhost:${info.port}`);
    console.log(`  POST /v1/chat/completions（OpenAI 兼容，model=Agent 名）`);
    console.log(`  GET  /v1/models | /api/health | /api/agents`);
    console.log(`  管理 CRUD：/api/providers /api/models /api/skills /api/mcp-servers /api/knowledge-bases`);
  });
}
