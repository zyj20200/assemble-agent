/**
 * 服务入口：Hono app 组装 + 启动
 *
 * 用法：
 *   LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL=... npm start
 */

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { fileURLToPath } from 'node:url';
import { createOpenAiCompatApp, handleApiError } from './api/openai-compat.ts';
import { config } from './config.ts';
import { createAgents, createRegistry } from './seed.ts';
import type { ModelRegistry } from './core/models.ts';
import type { AgentDefinition } from './core/agent/assemble.ts';

export interface CreateAppOptions {
  registry?: ModelRegistry;
  agents?: AgentDefinition[];
}

export function createApp(options: CreateAppOptions = {}): Hono {
  const registry = options.registry ?? createRegistry();
  const agents = options.agents ?? createAgents(registry);
  const byName = new Map(agents.map((a) => [a.name, a]));

  const app = new Hono();
  app.onError(handleApiError);

  // 可选鉴权：ASSEMBLE_API_KEY 存在时 /v1/* 要求 Bearer
  if (config.apiKey) {
    app.use('/v1/*', async (c, next) => {
      const auth = c.req.header('authorization');
      if (auth !== `Bearer ${config.apiKey}`) {
        return c.json({ error: { message: '未授权', type: 'invalid_request_error', code: 'invalid_api_key' } }, 401);
      }
      await next();
    });
  }

  app.route(
    '/',
    createOpenAiCompatApp({
      registry,
      getAgent: (name) => byName.get(name),
      listAgents: () => agents.map((a) => a.name),
    }),
  );

  app.get('/api/health', (c) =>
    c.json({ status: 'ok', agents: agents.length, providers: registry.listProviders() }),
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
    console.log(`  GET  /v1/models | GET /api/health`);
  });
}
