# 组装智能体（assemble-agent）设计文档

> 版本：0.2 · 状态：设计定稿，核心代码已落地（RAG 核心 / 嵌入适配 / Agent 集成）
> v0.2 变更：技术栈由 Python/FastAPI 切换为 **TypeScript + Node.js + pi 生态**（pi-agent-core / pi-ai），
> 知识库 RAG 采用从 knowledge-control（FastGPT 衍生）移植并修复的实现。

## 1. 项目概述

**组装智能体（assemble-agent）** 是一个"可自由组装的 Agent 平台"：以"组件 + 组装"为核心思想，把 **模型（Model）、系统提示词（System Prompt）、技能（Skill）、MCP 工具（MCP Server）、知识库（Knowledge Base）** 等作为可复用的积木，通过数据库配置任意组装成一个个独立的 Agent，并对外暴露一个 **OpenAI 兼容的 `/v1/chat/completions` API**。

- 调用方（任何兼容 OpenAI 的客户端 / 框架 / 应用）只需把 `model` 参数传成 Agent 名称，即可使用组装好的 Agent。
- 组装结果完全由数据库配置驱动，**无需改代码**即可增删组件、新建 Agent、切换模型。
- 提供 Web 管理页面，可视化地完成组装与配置。

### 1.1 设计目标

| 目标 | 说明 |
| --- | --- |
| 零代码组装 | 新 Agent = 数据库里一行配置，不需要发版 |
| 接口兼容 | 外部世界只看到一个 OpenAI 兼容端点，切换/升级 Agent 不影响调用方 |
| 组件复用 | 同一个 MCP / Skill / 知识库 / 模型可被多个 Agent 引用 |
| 开箱即用 | 单机 SQLite + 一条命令启动，数据全本地；也可 Docker Compose 起 PostgreSQL+pgvector |
| 渐进演进 | MVP 只依赖 OpenAI 兼容协议，后续可扩展原生 Provider 与向量库 |

### 1.2 非目标（MVP 不做）

- 多租户 / 复杂权限体系（预留字段，见 §8）
- 自有向量数据库（MVP 用 InMemory/SQLite 向量存储，演进目标 pgvector，见 §6.4）
- Agent 自主创建子 Agent / 多 Agent 编排（后续版本）
- 模型微调、训练

---

## 2. 核心概念与组装模型

### 2.1 组件（Component）

系统中可被复用的最小配置单元，全部以数据库记录存在：

```
┌─────────────────────────────────────────────────────────┐
│                      组件（Component）                    │
├─────────────────────────────────────────────────────────┤
│  Provider   模型提供方（base_url + api_key + 嵌入模型）      │
│  Model      具体模型（隶属于 Provider，含温度/长度等默认参数） │
│  Skill      技能（名称/描述/Markdown 指令内容，可注入提示词）  │
│  MCPServer  MCP 服务（stdio 命令 或 HTTP URL）             │
│  KnowledgeBase  知识库（切块参数 + 嵌入模型 + 文档）          │
└─────────────────────────────────────────────────────────┘
```

### 2.2 Agent（组装产物）

Agent 是组装后的产物，由一条主记录 + 四组关联组成：

```
Agent
├── 系统提示词 system_prompt        （模板，支持占位符，见 §6.5）
├── 模型 model                      （必选，1 个）
├── 技能 skills                     （多选，N 个）
├── MCP 服务 mcp_servers            （多选，N 个）
├── 知识库 knowledge_bases          （多选，N 个）
└── 运行时参数                       （temperature / max_tokens / rag_mode / 记忆开关等）
```

**组装规则**：
- `model` 必选，其余组件可选（最少：只有提示词 + 模型的纯对话 Agent）。
- 同一组件可被多个 Agent 引用（多对多）。
- 一个请求进来时，运行时按 Agent 配置"即时装配"：加载模型 → 注入技能 → 连接 MCP 发现工具 → RAG 检索知识库 → 组装提示词 → 执行对话/工具循环。

### 2.3 组装示例

```
Agent「客服小助手」
├── 系统提示词：你是 XX 产品的客服，语气友好，必要时查询工单系统……
├── 模型：deepseek-chat（Provider: DeepSeek）
├── Skills：客服话术规范、退款政策摘要
├── MCP：工单查询服务（stdio）、订单服务（HTTP）
└── 知识库：产品 FAQ、退换货手册
```

调用方 POST `/v1/chat/completions`，`model="客服小助手"`（或 `agent:客服小助手`）即得到完整能力的 Agent。

---

## 3. 系统架构

```
                        ┌────────────────────────────────────────────┐
                        │                assemble-agent             │
                        │                                            │
  OpenAI 客户端          │   ┌──────────────┐    ┌─────────────────┐  │
  curl / SDK / 应用 ─────┼──▶│  /v1/* 兼容层  │───▶│ Agent Runtime   │  │
                        │   │ chat/complet  │    │ (pi-agent-core) │  │
                        │   │ -ions, models │    └───┬────────┬────┘  │
                        │   └──────────────┘        │        │        │
                        │   ┌──────────────┐        ▼        ▼        │
  Web 浏览器 ────────────┼──▶│  /api/* 管理层 │───▶ MCP Client │ RAG    │
  （管理页面）            │   │ CRUD + 上传   │   (TS SDK)   │(已落地) │
                        │   └──────────────┘        │        │        │
                        │   ┌──────────────── 数据库 ────────────────┐ │
                        │   │ MVP: SQLite 单文件 / 演进: PostgreSQL   │ │
                        │   │ Provider/Model/Skill/MCPServer/KB/Agent│ │
                        │   │ 文档 Chunk / kb_vectors(向量,pgvector) │ │
                        │   └────────────────────────────────────────┘ │
                        └──────────────────────┬───────────────────────┘
                                               │
                        ┌──────────────────────┴───────────────┐
                        ▼                                      ▼
              ┌──────────────────┐                  ┌────────────────────┐
              │ 模型层 (pi-ai)    │                  │  MCP Server(s)      │
              │ OpenAI/DeepSeek/ │                  │  stdio 本地进程 /     │
              │ 通义/vLLM/Ollama │                  │  Streamable HTTP     │
              └──────────────────┘                  └────────────────────┘
```

**分层职责**：

| 层 | 模块 | 职责 |
| --- | --- | --- |
| 兼容层 | `src/api/openai-compat.ts` | `/v1/chat/completions`、`/v1/models`，流式 SSE，把 OpenAI 请求翻译成 Agent 运行时调用（pi 事件 → OpenAI chunk 映射） |
| 管理层 | `src/api/management.ts` | 所有组件与 Agent 的 CRUD、知识库文档上传、健康检查 |
| 运行时 | `src/core/agent/` | **基于 pi-agent-core**：Agent 循环、工具执行、事件流；`kb-tool.ts` 已落地 |
| 模型层 | pi-ai（`src/core/models.ts` 包装） | 多 Provider 统一接入、流式、成本/用量 |
| 组件执行 | `src/core/mcp.ts` `src/core/rag/` `src/core/prompt-builder.ts` | MCP 连接与工具包装、嵌入/检索/摄取（已落地）、提示词组装 |
| 数据层 | `src/db/` | SQLite（MVP）/ PostgreSQL+pgvector（演进），Drizzle ORM |
| 展示层 | `web/` | 静态管理页面（HTML/JS），调管理层 API |

### 3.1 技术选型

| 项 | 选择 | 理由 |
| --- | --- | --- |
| 语言/运行时 | TypeScript + Node.js 22+（NodeNext，`.ts` 扩展名导入） | 与 pi 生态同栈；v8 JIT 对计算/JSON 更优；Node 原生支持 TS 类型剥离 |
| Web 框架 | **Hono**（已定，见 §10.1 ADR） | 轻量、SSE 流式一等公民（streamSSE）、TS 类型好 |
| Agent 运行时 | **@earendil-works/pi-agent-core** | 对话/工具循环、事件流、steering、会话/压缩开箱即用，不自研循环 |
| 模型层 | **@earendil-works/pi-ai** | 30+ Provider 统一 API、流式、用量/成本统计、OAuth/CredentialStore |
| ORM/DB | Drizzle + SQLite（MVP）；PostgreSQL 16 + pgvector（演进） | SQLite 零部署单文件；pgvector 承接向量检索 |
| 上游接入 | pi-ai（内置 OpenAI 兼容 provider，`base_url`/`compat` 可配） | 覆盖 OpenAI/DeepSeek/通义/Kimi/vLLM/Ollama |
| MCP | 官方 `@modelcontextprotocol/sdk`（TS） | 工具发现/调用协议标准化，包装为 AgentTool |
| 嵌入 | 自研 `OpenAICompatibleEmbedder`（裸 fetch，已落地） | OpenAI 兼容 `/v1/embeddings`，批量/重试/维度校验 |
| 向量存储 | `VectorStore` 抽象：InMemory（MVP/测试）+ pgvector（已落地） | 存储层不感知嵌入模型，可替换 |
| 分块/解析 | 从 knowledge-control 移植（parser + FastGPT 系 splitter） | 六格式解析 + GBK 检测 + Markdown 表格/标题/中文标点分块 |
| 管理界面 | 原生 HTML/JS 单页 | 无构建链，依赖少；后续可替换为 Vue/React |

---

## 4. 数据模型设计

### 4.1 ER 概览

```
Provider 1 ──── * Model
Agent * ──────── 1 Model
Agent * ──── * Skill           (agent_skills)
Agent * ──── * MCPServer       (agent_mcp_servers)
Agent * ──── * KnowledgeBase   (agent_knowledge_bases)
KnowledgeBase 1 ──── * Document
Document 1 ──── * Chunk  (Chunk.embedding 向量, Chunk.kb_id 冗余索引)
```

### 4.2 表定义

> MVP：SQLite（better-sqlite3/Drizzle）。演进：PostgreSQL + pgvector，Chunk 向量迁至
> `kb_vectors` 表（见 §6.4 已落地的 pgvector 适配器，含 HNSW `vector_cosine_ops` 索引）。

**providers**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | int PK | |
| name | str UNIQUE | 显示名，如 `deepseek` |
| base_url | str | OpenAI 兼容端点，如 `https://api.deepseek.com/v1` |
| api_key | str | 密钥（明文存储，MVP；后续可加密，见 §8） |
| embedding_model | str | 默认嵌入模型，如 `text-embedding-3-small`，RAG 用 |
| enabled | bool | 是否可用 |
| created_at / updated_at | datetime | |

**models**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | int PK | |
| name | str UNIQUE | 展示名，如 `deepseek-chat` |
| provider_id | FK→providers | 所属提供方 |
| model_id | str | 上游真实模型 ID |
| temperature | float NULL | 默认温度（可空，取上游默认） |
| max_tokens | int NULL | 默认最大输出 |
| enabled | bool | |
| description | str | |

**skills**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | int PK | |
| name | str UNIQUE | |
| description | str | 用途说明（未来可用于自动选择） |
| content | text | Markdown 指令内容，注入提示词 |
| enabled | bool | |
| created_at | datetime | |

**mcp_servers**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | int PK | |
| name | str UNIQUE | |
| transport | str | `stdio` / `http` |
| command / args / env | str / JSON / JSON | stdio 启动参数（如 `npx -y @modelcontextprotocol/server-filesystem`） |
| url | str NULL | http 传输时的端点（Streamable HTTP） |
| headers | JSON | http 传输的认证头 |
| enabled | bool | |
| description | str | |

**knowledge_bases**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | int PK | |
| name | str UNIQUE | |
| description | str | 写进检索工具描述，帮模型判断何时查 |
| chunk_size | int | 切块字符数，默认 800 |
| chunk_overlap | int | 重叠，默认 100 |
| embedding_model | str NULL | 覆盖 Provider 默认嵌入模型 |
| top_k | int | 检索返回块数，默认 5 |
| min_score | float | 相似度阈值，默认 0.3 |
| created_at | datetime | |

**documents**（上传的原始文档）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | int PK | |
| knowledge_base_id | FK→knowledge_bases | |
| filename | str | 原始文件名（同 KB 内唯一，重传 = 原子替换） |
| content | text | 抽取后的纯文本 |
| doc_type | str | `md`/`txt`/`pdf`/`docx`/`csv`/`xlsx`（已全部支持） |
| status | str | `ready`/`failed`（预留异步摄取状态机） |
| content_hash | str | 内容哈希，重传秒跳（预留） |
| created_at | datetime | |

**chunks**（切块 + 向量）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | int PK | |
| knowledge_base_id | FK | 冗余，便于按库检索 |
| document_id | FK→documents | |
| chunk_index | int | 块序号（QA 模式 = 问答对下标） |
| content | text | 块文本 / QA 答案 |
| q / a | text NULL | QA 模式的问题/答案 |
| embedding | text | JSON 数组（float32 序列化）；演进迁至 pgvector `kb_vectors` 表 |

**agents**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | int PK | |
| name | str UNIQUE | **同时作为 `/v1` API 的 model 名** |
| description | str | |
| system_prompt | text | 提示词模板，支持 `{{skills}}`/`{{knowledge}}` 占位符（§6.5） |
| model_id | FK→models | 必选 |
| temperature / max_tokens | float / int NULL | 覆盖模型默认 |
| rag_mode | str | `auto`（工具式检索）/ `always`（注入式），默认 `auto` |
| use_rag | bool | 是否启用知识库检索 |
| max_tool_rounds | int | 工具循环上限，默认 8 |
| enabled | bool | 停用后 API 返回 404 |
| created_at / updated_at | datetime | |

**关联表**：`agent_skills`、`agent_mcp_servers`、`agent_knowledge_bases`（agent_id + 组件 id，复合主键）

---

## 5. API 设计

### 5.1 OpenAI 兼容 API（对外，`/v1/*`）

**`POST /v1/chat/completions`**

请求体：OpenAI Chat Completions 格式。

```jsonc
{
  "model": "客服小助手",            // Agent 名；也接受 "agent:客服小助手"
  "messages": [
    {"role": "system", "content": "覆盖 Agent 默认提示词（可选）"},
    {"role": "user", "content": "我的订单还没发货"}
  ],
  "temperature": 0.7,              // 可选，覆盖 Agent 默认
  "max_tokens": 1024,              // 可选
  "stream": true,                  // 可选，SSE
  "tools": null,                   // 见下方说明
  "tool_choice": null
}
```

响应：标准 ChatCompletion / 流式 chunk。

**要点**：
1. `model` 解析顺序：`agent:<name>` → 精确匹配 Agent 名 → 无匹配返回 404（OpenAI 风格 `model_not_found` 错误）。
2. 请求内 `messages` 中的 `system` 消息**覆盖** Agent 默认提示词（若想合并需在提示词模板里设计）。
3. 请求内 `tools`：**透传给上游模型**；若模型调用了其中某个工具，运行时返回"该工具未在本服务注册"的结果（保证协议兼容，同时如实告知）。Agent 自带能力来自其 MCP 配置，不受请求 tools 影响。
4. 支持 `stream: true`（SSE，`data: [DONE]`）与非流式。
5. 错误码遵循 OpenAI 约定：`400 invalid_request_error`、`404 model_not_found`、`429 rate_limit_error`、`500 internal_error`、`503 upstream_unavailable`。

**`GET /v1/models`**

返回已启用 Agent 列表（id=Agent 名）+ 可选的上游模型列表，供客户端发现。

```jsonc
{ "object": "list", "data": [ { "id": "客服小助手", "object": "model", "owned_by": "assemble-agent" } ] }
```

**`GET /v1/agents`**（可选扩展）：返回 Agent 元信息（描述、能力清单），便于调用方发现能力。

### 5.2 管理 API（内部，`/api/*`）

统一前缀 `/api`，RESTful，JSON。所有实体提供标准 CRUD：

| 实体 | 端点 |
| --- | --- |
| Providers | `GET/POST /api/providers`，`GET/PUT/DELETE /api/providers/{id}` |
| Models | `GET/POST /api/models`，`GET/PUT/DELETE /api/models/{id}` |
| Skills | `GET/POST /api/skills`，`GET/PUT/DELETE /api/skills/{id}` |
| MCP Servers | `GET/POST /api/mcp-servers`，`GET/PUT/DELETE /api/mcp-servers/{id}`；`POST /api/mcp-servers/{id}/test`（连通性/工具列表探测） |
| Knowledge Bases | `GET/POST /api/knowledge-bases`，`GET/PUT/DELETE /api/knowledge-bases/{id}` |
| Documents | `POST /api/knowledge-bases/{id}/documents`（multipart 上传，自动切块嵌入）；`GET/DELETE /api/documents/{id}` |
| Agents | `GET/POST /api/agents`，`GET/PUT/DELETE /api/agents/{id}`；组装字段直接出现在 Agent 表单：`model_id` + `skill_ids` + `mcp_server_ids` + `knowledge_base_ids` |
| 系统 | `GET /api/health`（服务与依赖状态） |

**响应约定**：列表 `{items: [...], total: n}`；详情直接返回对象；错误 `{"error": {"message", "code"}}`。创建/更新时后端做引用完整性校验（如 Agent 引用的 skill 不存在 → 400）。

### 5.3 Web 管理页面（`/` 与 `/admin`）

单页应用，三个视图（装配台 / 资源库 / Agents），详见 §7 与原型。

---

## 6. 关键机制设计

### 6.1 Agent 运行时（基于 pi-agent-core，不自研循环）✅ 已落地

```
收到 /v1/chat/completions
  │
  ├─ 1. 解析 model → 加载 Agent（含 model/skills/mcp/kb 关联）
  ├─ 2. 装配提示词（prompt-builder）：基础提示词 + {{skills}} + RAG 上下文
  ├─ 3. 连接 MCP（mcp.ts）：list_tools → 包装为 AgentTool
  ├─ 4. 组装 Agent：new Agent({ initialState: { systemPrompt, model, tools } })
  │
  └─ 5. agent.prompt() —— pi-agent-core 内部循环：
        ┌─────────────────────────────────────────────┐
        │ turn: LLM(pi-ai streamSimple) → 事件流       │
        │   ├─ 无工具调用 ──▶ 结束，返回最终回复        │
        │   └─ 有工具调用 ──▶ 并行执行 AgentTool       │
        │        （MCP 工具 / 请求 tools 占位 / kb-tool）│
        │     结果以 toolResult 回填 → 下一轮           │
        └─────────────────────────────────────────────┘
```

**事件 → OpenAI SSE 映射**（兼容层职责，运行时不管协议）：

| pi 事件 | OpenAI SSE chunk |
| --- | --- |
| `message_update.text_delta` | `choices[0].delta.content` |
| `message_update.toolcall_*` | `choices[0].delta.tool_calls`（流式工具调用） |
| `tool_execution_*` | 工具执行期间暂停文本增量，结果回填后续轮 |
| `agent_end` / `turn_end` | `finish_reason` + `data: [DONE]` |

- **流式与工具共存**：先流式输出助手文本增量；若本轮以工具调用结束，输出工具调用 chunk，暂停流；执行工具后继续下一轮文本增量；最终 `data: [DONE]`。
- **异常隔离**：单个 MCP server 连接失败 → 记日志，该 server 工具不注入，不拖垮整个请求；工具执行抛错 → pi-agent-core 捕获并以 `isError: true` 回馈模型。
- **会话与清理**：每个请求独立 `new Agent()`（无状态 pod 语义），MCP 会话请求结束关闭；`finally` 中确保关闭 stdio 子进程。
- **无状态用法**：MVP 无服务端记忆，每请求独立；请求内 `messages` 直接作为 `initialState.messages`。

### 6.2 模型接入（pi-ai 层）✅ 已落地（`src/core/models.ts`：自定义 OpenAI 兼容 provider 注册、模型级默认 temperature）

- 统一 `createModels()`，按 Provider 注册 pi-ai provider（OpenAI 兼容端点用 `compat` 字段适配各家差异）。
- 请求参数优先级：请求体 > Agent 配置 > Model 配置 > Provider 上游默认。
- 流式：`models.streamSimple(model, context)`，事件流经兼容层映射为 SSE。
- 每请求 API key：显式传参或 `getApiKey` 动态解析（多租户预留）。
- 用量/成本：`message.usage`（input/output tokens + cost），管理页试运行展示。
- 错误映射：pi-ai 错误事件（`stopReason: error/aborted`）→ OpenAI 风格错误码。

### 6.3 MCP 接入（@modelcontextprotocol/sdk TS）✅ 已落地（`src/core/mcp.ts`）

- **transport=stdio**：`StdioClientTransport(command, args, env)` → `Client` → `listTools()`。进程生命周期由运行时管理（`stderr: 'ignore'` 防句柄泄漏）。
- **transport=http**：`StreamableHTTPClientTransport(url, headers)`，用于远程服务。
- 工具发现：`client.listTools()` → 每个 tool 包装为 AgentTool：
  - `name`：为避免跨 server 冲突且满足 OpenAI 工具名规范 `^[a-zA-Z0-9_-]+$`，使用 `mcp{server_id}__{tool}`（中文名 server 前缀会被上游 400）。
  - `inputSchema`：直接透传 MCP 的 JSON Schema → typebox（或转换）。
- 工具调用：`client.callTool(name, arguments)` → 结果（含 `isError`、文本/图片内容）序列化为文本回填模型。
- **`/api/mcp-servers/{id}/test`**：管理界面"测试连接"按钮的后端实现——建立会话、list_tools、返回工具清单、关闭会话，全程超时保护（默认 15s）。
- 演进：并发上量后按 `(server_id, headers_hash)` 连接池，接口不变。

### 6.4 知识库 RAG（已落地：从 knowledge-control 移植并修复）

```
上传文档（multipart，md/txt/pdf/docx/csv/xlsx，GBK 自动检测）
  └─ parseFile（parser.ts，已落地）
      └─ 分块（textSplitter.ts，FastGPT 系，已落地）：
         Markdown 表格整块保留 / 标题深度切分 / 中文标点断句 / overlap / 自定义分隔符
      └─ QA 模式（qa.ts，已落地）：CSV/Excel 问答对 → 问题 + 索引列各生成一个向量（多路召回）
          └─ 嵌入（embedding.ts，已落地）：OpenAI 兼容 /v1/embeddings，批量/重试/维度校验
              └─ 入库（vector-store.ts，已落地）：VectorStore 抽象
                   ├─ InMemoryVectorStore（MVP/测试）
                   └─ PgVectorStore（pgvector，参数化查询 + 归一化 + 余弦，HNSW 索引）

检索（请求时）
  └─ rag_mode=auto：包装为 search_knowledge AgentTool（kb-tool.ts，已落地），模型自主决定检索
  └─ rag_mode=always：检索结果注入 {{knowledge}}（prompt-builder）
  └─ 阈值过滤 min_score，命中返回 [{content, q?, a?, score}]，带相似度/来源
```

**移植修复清单**（相对 knowledge-control 原版）：
1. SQL 注入：向量参数化（`$n::vector`），杜绝字符串插值；
2. 相似度语义：向量归一化 + `<=>` 余弦距离（原版用未归一化内积，阈值语义错误）；
3. 单库：去掉 Mongo 双写，元数据与向量同表；
4. JS 正则 bug：`[\s&&[^\n]]`（Java 风格字符类交集）在 JS 中静默失效 → `[^\S\n]` + 前瞻；
5. xlsx ESM 导入修复（`import * as` → 默认导入）；
6. pgvector 要求列固定维度 + 向量需序列化为字面量字符串。

**规模说明**：InMemory 全表扫描万级 chunk 内可用；生产直接上 pgvector（HNSW，已实测通过）。

### 6.5 提示词组装（Prompt Builder）✅ 已落地（`src/core/agent/skills.ts`：`{{skills}}` 占位符替换 / 末尾追加 `## 可用技能`）

系统提示词 = 模板 + 组件注入，规则：

1. 以 Agent 的 `system_prompt` 为模板。
2. **占位符**：
   - `{{skills}}` → 按关联顺序拼接的 Skill 内容（每个以 `## 技能：{name}` 分隔）。
   - `{{knowledge}}` → RAG 检索结果（每个以 `## 知识：{kb_name}` 分隔，附来源）。
3. 若模板中**没有**占位符，则自动在末尾追加两个固定章节（`## 可用技能`、`## 知识库上下文`），保证组件不因模板疏漏而丢失。
4. 组装顺序：基础提示词 → 技能 → 知识，知识最新（紧贴对话）。

**多 Agent 场景示例**：同一份 `system_prompt` 模板可被多个 Agent 复用，仅靠挂载不同技能/知识库形成差异。

> 实现参考：pi-agent-core 的 `loadSkills` / `formatSkillsForSystemPrompt` / prompt templates；
> 技能内容存 DB 时，自定义 ExecutionEnv 或落临时目录后加载。

### 6.6 会话记忆（v0.2 预留）

- MVP：**无服务器端记忆**，每请求独立（stateless），记忆由调用方在 messages 里携带（OpenAI 惯例）。
- v0.2：pi-agent-core 自带 `Session`（会话树）+ compaction（摘要压缩 + 保留最近 N 轮），
  比"简单截断"更优；`memory` 开关打开时启用。

---

## 7. Web 管理页面设计

单页应用（`/`），**工程图纸/装配台风格**（样式参考 `reference/动态智能体`）：图纸白底 + 32px 网格线、墨青描边方角、五类组件专属线色（模型蓝 `#245A8D` / 提示词红 `#A03A3A` / MCP 绿 `#0F7A5A` / 技能棕 `#8A5A24` / 知识库紫 `#6B4B8A`）、等宽 mono 标签。顶栏导航（装配台 / 资源库 / Agents）+ 状态胶囊（未发布/已发布），三个视图：

| 视图 | 内容 |
| --- | --- |
| **装配台**（主视图） | 三栏「资源库点选 → 总线接线 → 对外接口」：① **资源库**：五类组件以图纸风 checkbox/radio 点选接线（模型、提示词单选必选；MCP、技能、知识库多选），实时计数；② **装配台**：墨青总线 + 5 个接线 slot（MODEL/PROMPT/MCP/SKILL/KNOWLEDGE，彩色线 + 针脚圆点），已接入组件显示 chip 可断开；PROMPT 内嵌提示词预览 + 运行时注入说明（`<skills>`/`<knowledge>`/边界声明）；底部「过程事件透出」开关 + 工具轮次滑杆 + 预算闸 + **发布智能体**按钮（slug 格式与必选项校验）；③ **对外接口**：tab = 接入示例（curl + OpenAI SDK，`model=agent:{slug}` 实时生成）/ 装配 JSON 快照 / 试运行（模拟 SSE 流式回答 + 工具调用/技能加载/知识检索过程事件轨迹 + usage） |
| **资源库** | 五类组件以 **5 个 tab** 切换（每次仅显示一个模块，tab 带专属线色 + 条目计数）：每行「编辑 / 删除」均可用——**编辑**弹出预填表单模态框（保存后表格与装配台资源库同步更新，改名即时生效）；**删除**带 confirm 确认并从装配台同步移除；「＋ 新增」模态框校验名称必填，保存后同步进装配台资源库；MCP 模块含「测试连接」展开工具清单、知识库模块含「检索调试」演示 RAG 命中 |
| **Agents** | 已发布装配卡片列表（名称 / slug / MODEL·PROMPT·MCP·SKILL·KNOWLEDGE 五线清单 / 发布状态），每张卡片「**▶ 运行测试**」：弹出该 Agent 专属测试对话模态框，**按该 Agent 真实组件配置**动态模拟（工具调用 / 技能加载 / 知识检索轨迹 + 流式打字回答 + `usage · model=agent:{slug}` 统计）；另有编辑 / 删除操作 |

原型见 `web/prototype.html`（静态演示，无后端，纯前端可交互：装配 → 发布 → 测试全链路）。

---

## 8. 安全与运维

| 项 | MVP 方案 | 后续 |
| --- | --- | --- |
| API 认证 | 无（仅限本机/内网使用）；环境变量 `ASSEMBLE_API_KEY` 存在时，`/v1/*` 要求 `Authorization: Bearer <key>` | JWT / 多租户 |
| api_key 存储 | SQLite 明文 | Fernet 加密（密钥来自环境变量） |
| MCP 风险 | stdio 命令仅管理员在管理页配置；`test` 接口有超时与输出截断 | 命令白名单 / 沙箱 |
| 上传文件 | 扩展名白名单（md/txt/pdf/docx/csv/xlsx），大小限制（默认 20MB） | 病毒扫描 |
| CORS | 默认关闭，`ASSEMBLE_ALLOW_ORIGINS` 可配置 | — |
| 日志 | 结构化日志（请求 ID、Agent、耗时、工具轨迹） | 指标/追踪 |
| 部署 | `node dist/index.js`，SQLite 单文件备份即全量备份 | Docker / systemd / PostgreSQL |

---

## 9. 目录结构

```
assemble-agent/
├── package.json / tsconfig.json / .npmrc
├── DESIGN.md
├── README.md
├── src/
│   ├── index.ts               # ✅ 服务入口：Hono 组装 + 启动（node src/index.ts）
│   ├── config.ts              # ✅ 环境变量配置（PORT/API key/LLM/嵌入）
│   ├── db/                    # Drizzle schema + 连接（SQLite MVP / PG 演进）
│   ├── api/
│   │   ├── openai-compat.ts   # ✅ /v1/chat/completions, /v1/models（事件→SSE 映射，含客户端工具）
│   │   ├── management.ts      # /api/* CRUD
│   │   └── errors.ts          # OpenAI 风格错误处理
│   ├── core/
│   │   ├── models.ts          # pi-ai 包装：createModels + provider 注册 + 请求 key 解析
│   │   ├── agent/
│   │   │   ├── kb-tool.ts     # ✅ 已落地：知识库检索 AgentTool
│   │   ├── assemble.ts      # ✅ Agent 装配（AgentDefinition + ModelRegistry → Agent，含技能注入）
│   │   ├── skills.ts           # ✅ 技能注入（{{skills}} 占位符 / 末尾追加）
│   │   │   └── index.ts
│   │   ├── mcp.ts             # MCP 会话管理、工具发现/调用、test 探测
│   │   ├── rag/               # ✅ 已落地（从 knowledge-control 移植并修复）
│   │   │   ├── parser.ts      #   六格式解析 + GBK 检测 + QA 列归一化
│   │   │   ├── textSplitter.ts#   FastGPT 系分块器
│   │   │   ├── qa.ts          #   QA 对多向量规划
│   │   │   ├── embedding.ts   #   OpenAI 兼容嵌入适配器
│   │   │   ├── vector-store.ts#   VectorStore 抽象 + InMemory + pgvector
│   │   │   ├── ingest.ts      #   摄取/检索管线
│   │   │   └── index.ts
│   │   └── prompt-builder.ts  # 提示词组装（§6.5）
│   └── web/
│       ├── prototype.html     # 交互原型：工程图纸风装配台（装配→发布→测试全链路）
│       ├── index.html         # 正式管理页（实现阶段）
│       └── app.js / style.css
├── scripts/
│   └── embedding-smoke.ts     # ✅ 真实网关 + pgvector 全链路冒烟
├── tests/
│   └── core/
│       ├── rag/               # ✅ 30+ 用例：splitter/parser/qa/embedding/pgvector 真库
│       └── agent/             # ✅ kb-tool + pi-agent-core 集成（faux provider）
└── data/                      # assemble.db（运行时生成）
```

---

## 10. 实施路线图

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| **M1 设计** | 设计文档 + 工程图纸风交互原型 | ✅ 完成（含 v0.2 技术栈切换） |
| **M2 骨架** | TS 工程脚手架、DB/ORM/schema、管理 CRUD 全通 | 🔄 脚手架/测试基建完成，CRUD 待写 |
| **M3 对话链路** | pi-ai 模型层 + pi-agent-core 运行时 + `/v1/chat/completions`（非流式+流式） | ✅ **完成**（10 项 API 集成测试：SSE 序列/客户端工具/错误映射；真实网关验证 503 路径） |
| **M4 组件接入** | MCP（stdio+http）+ Skills 注入 + 知识库上传/检索 | 🔄 **知识库 RAG 已落地**（含 pgvector 真库测试）；MCP/Skills 待接 |
| **M5 管理页面** | 正式 index.html 对接全部管理 API + 对话测试 | ⬜ 未开始 |
| **M6 硬化** | 错误码、超时、日志、安全项（§8）、种子数据 | ⬜ 未开始 |

### 10.1 决策记录（ADR 摘要）

| 决策 | 理由 | 备选 | 可逆性 |
| --- | --- | --- | --- |
| TypeScript + pi 生态 | 与 pi-agent-core/pi-ai 同栈；运行时/模型层开箱即用 | Python + FastAPI（v0.1） | 高（逻辑层已抽象） |
| pi-agent-core 运行时 | 对话/工具循环、事件流、steering、会话压缩免自研 | 自研循环 / LangGraph | 高（事件接口解耦） |
| pi-ai 模型层 | 30+ Provider、用量/成本、OAuth 免自研 | openai SDK 直连 | 高 |
| Hono Web 框架 | streamSSE 原生、零依赖、TS 类型好 | Fastify | 高（路由薄层） |
| SQLite 起步 | 零运维，单文件备份 | PostgreSQL | 高（Drizzle 已抽象） |
| RAG 移植 knowledge-control | 分块/解析/QA 多路召回是难点，移植并修复 6 个问题 | 完全自研 | 高（VectorStore 抽象） |
| pgvector 向量检索 | 生产可用、HNSW、单库 | InMemory/SQLite-numpy | 高（VectorStore 抽象） |
| MCP 官方 SDK | 协议标准化、官方维护 | 自研协议 | 中 |

---

## 11. 开放问题（待评审确认）

1. Agent 名是否允许中文/空格（作为 `model` 参数时）？—— 建议允许（OpenAI 的 model id 本就是字符串），`agent:` 前缀用于消歧。
2. 请求内 `tools` 的处理：MVP 透传+不可执行（§5.1.3），是否接受？
3. 是否需要 `/v1/embeddings` 透传（让外部直接使用本服务的嵌入能力）？
4. 知识库是否需要支持 web 导入（URL 抓取）？
5. 记忆开关 v0.2 的形态：pi-agent-core `Session` + compaction（推荐），还是简单最近 N 轮？
6. `rag_mode`：默认 `auto`（工具式）还是 `always`（注入式）？—— 建议默认 `auto`，管理页可切换。
