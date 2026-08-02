/**
 * Drizzle Schema（DESIGN.md §4 数据模型）
 *
 * MVP：SQLite；演进：PostgreSQL + pgvector（字段可平移）。
 * JSON 字段（args/env/headers/embedding）以 text 存储，repo 层负责序列化。
 */

import { sqliteTable, text, integer, real, primaryKey, index } from 'drizzle-orm/sqlite-core';

const now = () => new Date();

// ---------- 组件 ----------

export const providers = sqliteTable('providers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  baseUrl: text('base_url').notNull(),
  apiKey: text('api_key'),
  embeddingModel: text('embedding_model'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
});

export const models = sqliteTable('models', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  providerId: integer('provider_id')
    .notNull()
    .references(() => providers.id, { onDelete: 'cascade' }),
  modelId: text('model_id').notNull(),
  temperature: real('temperature'),
  maxTokens: integer('max_tokens'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  description: text('description'),
});

export const skills = sqliteTable('skills', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  description: text('description'),
  content: text('content').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
});

export const prompts = sqliteTable('prompts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  description: text('description'),
  content: text('content').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
});

export const mcpServers = sqliteTable('mcp_servers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  transport: text('transport', { enum: ['stdio', 'http'] }).notNull().default('stdio'),
  command: text('command'),
  args: text('args'), // JSON string[]
  env: text('env'), // JSON Record<string,string>
  url: text('url'),
  headers: text('headers'), // JSON Record<string,string>
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  description: text('description'),
});

export const knowledgeBases = sqliteTable('knowledge_bases', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  description: text('description'),
  chunkSize: integer('chunk_size').notNull().default(800),
  chunkOverlap: integer('chunk_overlap').notNull().default(100),
  embeddingModel: text('embedding_model'),
  topK: integer('top_k').notNull().default(5),
  minScore: real('min_score').notNull().default(0.3),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
});

export const documents = sqliteTable(
  'documents',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    knowledgeBaseId: integer('knowledge_base_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    content: text('content').notNull(),
    docType: text('doc_type').notNull().default('md'),
    status: text('status', { enum: ['ready', 'failed'] }).notNull().default('ready'),
    contentHash: text('content_hash'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
  },
  (t) => [index('documents_kb_idx').on(t.knowledgeBaseId)],
);

export const chunks = sqliteTable(
  'chunks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    knowledgeBaseId: integer('knowledge_base_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    documentId: integer('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    q: text('q'),
    a: text('a'),
    vectorText: text('vector_text').notNull(),
    embedding: text('embedding'), // JSON number[]
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
  },
  (t) => [
    index('chunks_kb_idx').on(t.knowledgeBaseId),
    index('chunks_doc_idx').on(t.documentId),
  ],
);

export const agents = sqliteTable('agents', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  description: text('description'),
  /** 关联的提示词模板（可复用组件）；system_prompt 为非空时覆盖模板 */
  promptId: integer('prompt_id').references(() => prompts.id, { onDelete: 'set null' }),
  systemPrompt: text('system_prompt'),
  modelId: integer('model_id')
    .notNull()
    .references(() => models.id, { onDelete: 'restrict' }),
  temperature: real('temperature'),
  maxTokens: integer('max_tokens'),
  ragMode: text('rag_mode', { enum: ['auto', 'always'] }).notNull().default('auto'),
  useRag: integer('use_rag', { mode: 'boolean' }).notNull().default(true),
  maxToolRounds: integer('max_tool_rounds').notNull().default(8),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
});

// ---------- 关联表 ----------

export const agentSkills = sqliteTable(
  'agent_skills',
  {
    agentId: integer('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    skillId: integer('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.skillId] })],
);

export const agentMcpServers = sqliteTable(
  'agent_mcp_servers',
  {
    agentId: integer('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    mcpServerId: integer('mcp_server_id')
      .notNull()
      .references(() => mcpServers.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.mcpServerId] })],
);

export const agentKnowledgeBases = sqliteTable(
  'agent_knowledge_bases',
  {
    agentId: integer('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    knowledgeBaseId: integer('knowledge_base_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.knowledgeBaseId] })],
);
