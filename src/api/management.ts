/**
 * 管理 API（DESIGN.md §5.2）
 *
 * RESTful CRUD：providers / models / skills / mcp-servers / knowledge-bases / documents / agents
 * 约定：列表 {items, total}；错误 {error:{message, code}}；引用完整性校验（400）
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppDb } from '../db/index.ts';
import { schema } from '../db/index.ts';
import type { KnowledgeBaseService } from '../core/kb-service.ts';
import { McpManager, type McpServerConfig } from '../core/mcp.ts';
import { encryptSecret, decryptSecret } from '../security.ts';
import { ApiError, ApiErrors } from './errors.ts';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface ManagementDeps {
  db: AppDb;
  kb: KnowledgeBaseService;
  mcp?: McpManager;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const notFound = (entity: string, id: number) =>
  new ApiError(404, 'invalid_request_error', 'not_found', `${entity} 不存在: ${id}`);

const jsonStr = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
const jsonParse = <T>(s: string | null): T | undefined => {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
};

function isUniqueError(err: unknown): boolean {
  return err instanceof Error && err.name === 'SqliteError' && 'code' in err && String((err as { code: string }).code).includes('CONSTRAINT_UNIQUE');
}

function isFkError(err: unknown): boolean {
  // SQLite FK restrict 由触发器实现，错误码为 CONSTRAINT_TRIGGER
  if (!(err instanceof Error) || err.name !== 'SqliteError' || !('code' in err)) return false;
  const code = String((err as { code: string }).code);
  return code.includes('CONSTRAINT_FOREIGNKEY') || code.includes('CONSTRAINT_TRIGGER');
}

const requireName = (body: Record<string, unknown>, ...fields: string[]): string => {
  for (const f of fields) {
    if (typeof body[f] !== 'string' || !(body[f] as string).trim()) {
      throw ApiErrors.invalidRequest(`字段 ${f} 必填`);
    }
  }
  return body[fields[0]!] as string;
};

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

export function createManagementApp(deps: ManagementDeps): Hono {
  const { db, kb, mcp } = deps;
  const app = new Hono();

  // ---------- Providers ----------
  app.get('/api/providers', (c) => {
    const rows = db.select().from(schema.providers).all().map((r) => ({ ...r, apiKey: r.apiKey ? decryptSecret(r.apiKey) : null }));
    return c.json({ items: rows, total: rows.length });
  });
  app.post('/api/providers', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const name = requireName(body, 'name', 'base_url');
    try {
      const row = db
        .insert(schema.providers)
        .values({
          name,
          baseUrl: String(body.base_url),
          apiKey: typeof body.api_key === 'string' ? encryptSecret(body.api_key) : null,
          embeddingModel: typeof body.embedding_model === 'string' ? body.embedding_model : null,
          enabled: body.enabled !== false,
        })
        .returning()
        .get();
      return c.json(row, 201);
    } catch (err) {
      if (isUniqueError(err)) throw ApiErrors.invalidRequest(`Provider 名称已存在: ${name}`);
      throw err;
    }
  });
  app.get('/api/providers/:id', (c) => {
    const id = Number(c.req.param('id'));
    const row = db.select().from(schema.providers).where(eq(schema.providers.id, id)).get();
    if (!row) throw notFound('Provider', id);
    return c.json({ ...row, apiKey: row.apiKey ? decryptSecret(row.apiKey) : null });
  });
  app.put('/api/providers/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!db.select().from(schema.providers).where(eq(schema.providers.id, id)).get()) throw notFound('Provider', id);
    const body = (await c.req.json()) as Record<string, unknown>;
    const row = db
      .update(schema.providers)
      .set({
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(typeof body.base_url === 'string' ? { baseUrl: body.base_url } : {}),
        ...(typeof body.api_key === 'string' ? { apiKey: encryptSecret(body.api_key) } : {}),
        ...(typeof body.embedding_model === 'string' ? { embeddingModel: body.embedding_model } : {}),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.providers.id, id))
      .returning()
      .get();
    return c.json(row);
  });
  app.delete('/api/providers/:id', (c) => {
    const id = Number(c.req.param('id'));
    try {
      db.delete(schema.providers).where(eq(schema.providers.id, id)).run();
    } catch (err) {
      if (isFkError(err)) throw ApiErrors.invalidRequest('该 Provider 下存在模型，无法删除');
      throw err;
    }
    return c.body(null, 204);
  });

  // ---------- Models ----------
  app.get('/api/models', (c) => {
    const rows = db.select().from(schema.models).all();
    return c.json({ items: rows, total: rows.length });
  });
  app.post('/api/models', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const name = requireName(body, 'name', 'model_id');
    const providerId = Number(body.provider_id);
    if (!db.select().from(schema.providers).where(eq(schema.providers.id, providerId)).get()) {
      throw ApiErrors.invalidRequest(`Provider 不存在: ${providerId}`);
    }
    try {
      const row = db
        .insert(schema.models)
        .values({
          name,
          providerId,
          modelId: String(body.model_id),
          temperature: typeof body.temperature === 'number' ? body.temperature : null,
          maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : null,
          enabled: body.enabled !== false,
          description: typeof body.description === 'string' ? body.description : null,
        })
        .returning()
        .get();
      return c.json(row, 201);
    } catch (err) {
      if (isUniqueError(err)) throw ApiErrors.invalidRequest(`模型名已存在: ${name}`);
      throw err;
    }
  });
  app.put('/api/models/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!db.select().from(schema.models).where(eq(schema.models.id, id)).get()) throw notFound('Model', id);
    const body = (await c.req.json()) as Record<string, unknown>;
    const row = db
      .update(schema.models)
      .set({
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(typeof body.model_id === 'string' ? { modelId: body.model_id } : {}),
        ...(body.provider_id !== undefined ? { providerId: Number(body.provider_id) } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature as number } : {}),
        ...(body.max_tokens !== undefined ? { maxTokens: body.max_tokens as number } : {}),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
      })
      .where(eq(schema.models.id, id))
      .returning()
      .get();
    return c.json(row);
  });
  app.delete('/api/models/:id', (c) => {
    const id = Number(c.req.param('id'));
    try {
      db.delete(schema.models).where(eq(schema.models.id, id)).run();
    } catch (err) {
      if (isFkError(err)) throw ApiErrors.invalidRequest('该模型被 Agent 引用，无法删除');
      throw err;
    }
    return c.body(null, 204);
  });

  // ---------- Skills ----------
  app.get('/api/skills', (c) => {
    const rows = db.select().from(schema.skills).all();
    return c.json({ items: rows, total: rows.length });
  });
  app.post('/api/skills', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const name = requireName(body, 'name', 'content');
    try {
      const row = db
        .insert(schema.skills)
        .values({
          name,
          description: typeof body.description === 'string' ? body.description : null,
          content: String(body.content),
          enabled: body.enabled !== false,
        })
        .returning()
        .get();
      return c.json(row, 201);
    } catch (err) {
      if (isUniqueError(err)) throw ApiErrors.invalidRequest(`技能名已存在: ${name}`);
      throw err;
    }
  });
  app.put('/api/skills/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!db.select().from(schema.skills).where(eq(schema.skills.id, id)).get()) throw notFound('Skill', id);
    const body = (await c.req.json()) as Record<string, unknown>;
    const row = db
      .update(schema.skills)
      .set({
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
        ...(typeof body.content === 'string' ? { content: body.content } : {}),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      })
      .where(eq(schema.skills.id, id))
      .returning()
      .get();
    return c.json(row);
  });
  app.delete('/api/skills/:id', (c) => {
    const id = Number(c.req.param('id'));
    db.delete(schema.skills).where(eq(schema.skills.id, id)).run();
    return c.body(null, 204);
  });

  // ---------- MCP Servers ----------
  app.get('/api/mcp-servers', (c) => {
    const rows = db.select().from(schema.mcpServers).all();
    return c.json({ items: rows, total: rows.length });
  });
  app.post('/api/mcp-servers', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const name = requireName(body, 'name');
    const transport = body.transport === 'http' ? 'http' : 'stdio';
    if (transport === 'http' && typeof body.url !== 'string') {
      throw ApiErrors.invalidRequest('http 传输需要 url');
    }
    if (transport === 'stdio' && typeof body.command !== 'string') {
      throw ApiErrors.invalidRequest('stdio 传输需要 command');
    }
    try {
      const row = db
        .insert(schema.mcpServers)
        .values({
          name,
          transport,
          command: typeof body.command === 'string' ? body.command : null,
          args: jsonStr(body.args),
          env: jsonStr(body.env),
          url: typeof body.url === 'string' ? body.url : null,
          headers: jsonStr(body.headers),
          enabled: body.enabled !== false,
          description: typeof body.description === 'string' ? body.description : null,
        })
        .returning()
        .get();
      return c.json(row, 201);
    } catch (err) {
      if (isUniqueError(err)) throw ApiErrors.invalidRequest(`MCP Server 名已存在: ${name}`);
      throw err;
    }
  });
  app.put('/api/mcp-servers/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!db.select().from(schema.mcpServers).where(eq(schema.mcpServers.id, id)).get()) throw notFound('MCPServer', id);
    const body = (await c.req.json()) as Record<string, unknown>;
    const row = db
      .update(schema.mcpServers)
      .set({
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(body.transport === 'http' || body.transport === 'stdio' ? { transport: body.transport } : {}),
        ...(typeof body.command === 'string' ? { command: body.command } : {}),
        ...(body.args !== undefined ? { args: jsonStr(body.args) } : {}),
        ...(body.env !== undefined ? { env: jsonStr(body.env) } : {}),
        ...(typeof body.url === 'string' ? { url: body.url } : {}),
        ...(body.headers !== undefined ? { headers: jsonStr(body.headers) } : {}),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
      })
      .where(eq(schema.mcpServers.id, id))
      .returning()
      .get();
    return c.json(row);
  });
  app.delete('/api/mcp-servers/:id', (c) => {
    const id = Number(c.req.param('id'));
    db.delete(schema.mcpServers).where(eq(schema.mcpServers.id, id)).run();
    return c.body(null, 204);
  });
  // 测试连接：建连 + listTools（超时 15s）
  app.post('/api/mcp-servers/:id/test', async (c) => {
    const id = Number(c.req.param('id'));
    const row = db.select().from(schema.mcpServers).where(eq(schema.mcpServers.id, id)).get();
    if (!row) throw notFound('MCPServer', id);
    if (!mcp) throw ApiErrors.internal('MCP 管理器未初始化');
    const config: McpServerConfig = {
      id: row.id,
      name: row.name,
      transport: row.transport,
      command: row.command,
      args: jsonParse(row.args),
      env: jsonParse(row.env),
      url: row.url,
      headers: jsonParse(row.headers),
    };
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(ApiErrors.invalidRequest('MCP 连接测试超时（>15s）')), 15_000),
    );
    try {
      const result = await Promise.race([mcp.test(config), timeout]);
      return c.json(result);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw ApiErrors.invalidRequest(`连接失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ---------- Knowledge Bases ----------
  app.get('/api/knowledge-bases', (c) => {
    const rows = db.select().from(schema.knowledgeBases).all();
    return c.json({ items: rows, total: rows.length });
  });
  app.post('/api/knowledge-bases', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const name = requireName(body, 'name');
    try {
      const row = db
        .insert(schema.knowledgeBases)
        .values({
          name,
          description: typeof body.description === 'string' ? body.description : null,
          chunkSize: typeof body.chunk_size === 'number' ? body.chunk_size : 800,
          chunkOverlap: typeof body.chunk_overlap === 'number' ? body.chunk_overlap : 100,
          embeddingModel: typeof body.embedding_model === 'string' ? body.embedding_model : null,
          topK: typeof body.top_k === 'number' ? body.top_k : 5,
          minScore: typeof body.min_score === 'number' ? body.min_score : 0.3,
        })
        .returning()
        .get();
      kb.reload(); // 新 KB 纳入索引
      return c.json(row, 201);
    } catch (err) {
      if (isUniqueError(err)) throw ApiErrors.invalidRequest(`知识库名已存在: ${name}`);
      throw err;
    }
  });
  app.get('/api/knowledge-bases/:id', (c) => {
    const id = Number(c.req.param('id'));
    const row = db.select().from(schema.knowledgeBases).where(eq(schema.knowledgeBases.id, id)).get();
    if (!row) throw notFound('知识库', id);
    return c.json(row);
  });
  app.put('/api/knowledge-bases/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!db.select().from(schema.knowledgeBases).where(eq(schema.knowledgeBases.id, id)).get()) throw notFound('知识库', id);
    const body = (await c.req.json()) as Record<string, unknown>;
    const row = db
      .update(schema.knowledgeBases)
      .set({
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
        ...(typeof body.chunk_size === 'number' ? { chunkSize: body.chunk_size } : {}),
        ...(typeof body.chunk_overlap === 'number' ? { chunkOverlap: body.chunk_overlap } : {}),
        ...(typeof body.embedding_model === 'string' ? { embeddingModel: body.embedding_model } : {}),
        ...(typeof body.top_k === 'number' ? { topK: body.top_k } : {}),
        ...(typeof body.min_score === 'number' ? { minScore: body.min_score } : {}),
      })
      .where(eq(schema.knowledgeBases.id, id))
      .returning()
      .get();
    kb.reload();
    return c.json(row);
  });
  app.delete('/api/knowledge-bases/:id', (c) => {
    const id = Number(c.req.param('id'));
    kb.deleteKnowledgeBase(id);
    return c.body(null, 204);
  });

  // ---------- Documents ----------
  app.get('/api/knowledge-bases/:id/documents', (c) => {
    const id = Number(c.req.param('id'));
    const rows = kb.listDocuments(id);
    return c.json({ items: rows, total: rows.length });
  });
  app.post('/api/knowledge-bases/:id/documents', async (c) => {
    const kbId = Number(c.req.param('id'));
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw ApiErrors.invalidRequest('缺少 file 字段（multipart 上传）');
    if (file.size > 20 * 1024 * 1024) throw ApiErrors.invalidRequest('文件超过 20MB 限制');
    const isQaCsv = form.get('isQaCsv') === '1' || form.get('isQaCsv') === 'true';
    const fileName = file.name || 'upload.txt';

    const dir = await mkdtemp(path.join(tmpdir(), 'assemble-upload-'));
    const filePath = path.join(dir, fileName);
    try {
      await writeFile(filePath, Buffer.from(await file.arrayBuffer()));
      const result = await kb.ingestDocument(kbId, filePath, fileName, isQaCsv);
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Unsupported file extension')) {
        throw ApiErrors.invalidRequest(err.message);
      }
      throw err;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  app.get('/api/documents/:id', (c) => {
    const id = Number(c.req.param('id'));
    const row = db.select().from(schema.documents).where(eq(schema.documents.id, id)).get();
    if (!row) throw notFound('文档', id);
    return c.json(row);
  });
  app.delete('/api/documents/:id', (c) => {
    const id = Number(c.req.param('id'));
    const row = db.select().from(schema.documents).where(eq(schema.documents.id, id)).get();
    if (!row) throw notFound('文档', id);
    kb.deleteDocument(row.knowledgeBaseId, id);
    return c.body(null, 204);
  });

  // 检索调试（管理页"检索调试"）
  app.post('/api/knowledge-bases/:id/search', async (c) => {
    const id = Number(c.req.param('id'));
    const body = (await c.req.json()) as Record<string, unknown>;
    if (typeof body.query !== 'string' || !body.query.trim()) {
      throw ApiErrors.invalidRequest('字段 query 必填');
    }
    try {
      const hits = await kb.search(id, body.query, {
        limit: typeof body.limit === 'number' ? body.limit : undefined,
        minScore: typeof body.min_score === 'number' ? body.min_score : undefined,
      });
      return c.json({ items: hits, total: hits.length });
    } catch (err) {
      if (err instanceof Error && err.message.includes('未配置嵌入模型')) {
        throw ApiErrors.invalidRequest(err.message);
      }
      throw err;
    }
  });

  // ---------- Agents ----------
  app.get('/api/agents', (c) => {
    const rows = db.select().from(schema.agents).all();
    return c.json({ items: rows, total: rows.length });
  });
  app.post('/api/agents', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const name = requireName(body, 'name', 'system_prompt');
    const modelId = Number(body.model_id);
    if (!db.select().from(schema.models).where(eq(schema.models.id, modelId)).get()) {
      throw ApiErrors.invalidRequest(`模型不存在: ${modelId}`);
    }
    const skillIds = assertIdArray(body.skill_ids, 'skill_ids');
    const mcpIds = assertIdArray(body.mcp_server_ids, 'mcp_server_ids');
    const kbIds = assertIdArray(body.knowledge_base_ids, 'knowledge_base_ids');
    assertAllExist((id) => !!db.select().from(schema.skills).where(eq(schema.skills.id, id)).get(), skillIds, '技能');
    assertAllExist((id) => !!db.select().from(schema.mcpServers).where(eq(schema.mcpServers.id, id)).get(), mcpIds, 'MCP Server');
    assertAllExist((id) => !!db.select().from(schema.knowledgeBases).where(eq(schema.knowledgeBases.id, id)).get(), kbIds, '知识库');

    try {
      const row = db
        .insert(schema.agents)
        .values({
          name,
          description: typeof body.description === 'string' ? body.description : null,
          systemPrompt: String(body.system_prompt),
          modelId,
          temperature: typeof body.temperature === 'number' ? body.temperature : null,
          maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : null,
          ragMode: body.rag_mode === 'always' ? 'always' : 'auto',
          useRag: body.use_rag !== false,
          maxToolRounds: typeof body.max_tool_rounds === 'number' ? body.max_tool_rounds : 8,
          enabled: body.enabled !== false,
        })
        .returning()
        .get();
      linkAgentComponents(db, row.id, skillIds, mcpIds, kbIds);
      return c.json(loadAgentDetail(db, row.id), 201);
    } catch (err) {
      if (isUniqueError(err)) throw ApiErrors.invalidRequest(`Agent 名已存在: ${name}`);
      throw err;
    }
  });
  app.get('/api/agents/:id', (c) => {
    const id = Number(c.req.param('id'));
    const detail = loadAgentDetail(db, id);
    if (!detail) throw notFound('Agent', id);
    return c.json(detail);
  });
  app.put('/api/agents/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!db.select().from(schema.agents).where(eq(schema.agents.id, id)).get()) throw notFound('Agent', id);
    const body = (await c.req.json()) as Record<string, unknown>;
    if (body.model_id !== undefined) {
      const modelId = Number(body.model_id);
      if (!db.select().from(schema.models).where(eq(schema.models.id, modelId)).get()) {
        throw ApiErrors.invalidRequest(`模型不存在: ${modelId}`);
      }
    }
    // 关联组件整体替换（DESIGN.md 组装规则：列表字段整体替换）
    if (body.skill_ids !== undefined || body.mcp_server_ids !== undefined || body.knowledge_base_ids !== undefined) {
      const skillIds = assertIdArray(body.skill_ids ?? [], 'skill_ids');
      const mcpIds = assertIdArray(body.mcp_server_ids ?? [], 'mcp_server_ids');
      const kbIds = assertIdArray(body.knowledge_base_ids ?? [], 'knowledge_base_ids');
      assertAllExist((id) => !!db.select().from(schema.skills).where(eq(schema.skills.id, id)).get(), skillIds, '技能');
      assertAllExist((id) => !!db.select().from(schema.mcpServers).where(eq(schema.mcpServers.id, id)).get(), mcpIds, 'MCP Server');
      assertAllExist((id) => !!db.select().from(schema.knowledgeBases).where(eq(schema.knowledgeBases.id, id)).get(), kbIds, '知识库');
      db.delete(schema.agentSkills).where(eq(schema.agentSkills.agentId, id)).run();
      db.delete(schema.agentMcpServers).where(eq(schema.agentMcpServers.agentId, id)).run();
      db.delete(schema.agentKnowledgeBases).where(eq(schema.agentKnowledgeBases.agentId, id)).run();
      linkAgentComponents(db, id, skillIds, mcpIds, kbIds);
    }
    const row = db
      .update(schema.agents)
      .set({
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
        ...(typeof body.system_prompt === 'string' ? { systemPrompt: body.system_prompt } : {}),
        ...(body.model_id !== undefined ? { modelId: Number(body.model_id) } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature as number } : {}),
        ...(body.max_tokens !== undefined ? { maxTokens: body.max_tokens as number } : {}),
        ...(body.rag_mode === 'auto' || body.rag_mode === 'always' ? { ragMode: body.rag_mode } : {}),
        ...(typeof body.use_rag === 'boolean' ? { useRag: body.use_rag } : {}),
        ...(typeof body.max_tool_rounds === 'number' ? { maxToolRounds: body.max_tool_rounds } : {}),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.agents.id, id))
      .returning()
      .get();
    return c.json(loadAgentDetail(db, id));
  });
  app.delete('/api/agents/:id', (c) => {
    const id = Number(c.req.param('id'));
    db.delete(schema.agents).where(eq(schema.agents.id, id)).run();
    return c.body(null, 204);
  });

  // ---------- 健康检查 ----------
  app.get('/api/health', (c) => {
    const counts = {
      providers: db.select().from(schema.providers).all().length,
      models: db.select().from(schema.models).all().length,
      skills: db.select().from(schema.skills).all().length,
      mcpServers: db.select().from(schema.mcpServers).all().length,
      knowledgeBases: db.select().from(schema.knowledgeBases).all().length,
      agents: db.select().from(schema.agents).all().length,
    };
    return c.json({ status: 'ok', ...counts });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Agent 装配详情（含关联组件 id 与名称）
// ---------------------------------------------------------------------------

function loadAgentDetail(db: AppDb, id: number) {
  const agent = db.select().from(schema.agents).where(eq(schema.agents.id, id)).get();
  if (!agent) return undefined;
  const model = db.select().from(schema.models).where(eq(schema.models.id, agent.modelId)).get();
  const skills = db
    .select({ id: schema.skills.id, name: schema.skills.name })
    .from(schema.agentSkills)
    .innerJoin(schema.skills, eq(schema.agentSkills.skillId, schema.skills.id))
    .where(eq(schema.agentSkills.agentId, id))
    .all();
  const mcpServers = db
    .select({ id: schema.mcpServers.id, name: schema.mcpServers.name })
    .from(schema.agentMcpServers)
    .innerJoin(schema.mcpServers, eq(schema.agentMcpServers.mcpServerId, schema.mcpServers.id))
    .where(eq(schema.agentMcpServers.agentId, id))
    .all();
  const knowledgeBases = db
    .select({ id: schema.knowledgeBases.id, name: schema.knowledgeBases.name })
    .from(schema.agentKnowledgeBases)
    .innerJoin(schema.knowledgeBases, eq(schema.agentKnowledgeBases.knowledgeBaseId, schema.knowledgeBases.id))
    .where(eq(schema.agentKnowledgeBases.agentId, id))
    .all();
  return {
    ...agent,
    model: model ? { id: model.id, name: model.name, modelId: model.modelId } : null,
    skills,
    mcp_servers: mcpServers,
    knowledge_bases: knowledgeBases,
  };
}

function linkAgentComponents(
  db: AppDb,
  agentId: number,
  skillIds: number[],
  mcpIds: number[],
  kbIds: number[],
): void {
  for (const s of skillIds) db.insert(schema.agentSkills).values({ agentId, skillId: s }).run();
  for (const m of mcpIds) db.insert(schema.agentMcpServers).values({ agentId, mcpServerId: m }).run();
  for (const k of kbIds) db.insert(schema.agentKnowledgeBases).values({ agentId, knowledgeBaseId: k }).run();
}

function assertIdArray(v: unknown, field: string): number[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'number' && Number.isInteger(x))) {
    throw ApiErrors.invalidRequest(`字段 ${field} 应为整数 id 数组`);
  }
  return v as number[];
}

function assertAllExist(
  check: (id: number) => boolean,
  ids: number[],
  entityName: string,
): void {
  for (const id of ids) {
    if (!check(id)) throw ApiErrors.invalidRequest(`${entityName} 不存在: ${id}`);
  }
}
