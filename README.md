<div align="center">

# 🧩 assemble-agent · 组装智能体

**可自由组装的 Agent 平台** —— 把 模型 / 系统提示词 / 技能 / MCP 工具 / 知识库 当作积木，通过数据库配置任意组装成独立 Agent，对外暴露 **OpenAI 兼容的 `/v1/chat/completions` API**。

![tests](https://img.shields.io/badge/tests-101%20passed-green)
![stack](https://img.shields.io/badge/stack-TypeScript%20%2B%20pi%20ecosystem-3178c6)

</div>

---

## 📸 界面预览

| 装配台 · 点选组件发布 Agent | 试运行 · 真实流式对话 + 工具轨迹 + usage |
| :---: | :---: |
| ![装配台](docs/screenshots/01-assembly.png) | ![试运行](docs/screenshots/04-test-run.png) |

> 🎨 双布局可切换：顶栏（B 档，默认）与侧边栏仪表盘（C 档），右上角一键切换、刷新记忆。

| C 档 · 侧边栏仪表盘 | C 档 · 资源库 |
| :---: | :---: |
| ![C 档装配台](docs/screenshots/05-skin-c-assembly.png) | ![C 档资源库](docs/screenshots/06-skin-c-library.png) |

| 资源库 · 五类组件 CRUD | Agents · 已发布智能体 |
| :---: | :---: |
| ![资源库](docs/screenshots/02-library.png) | ![Agents](docs/screenshots/03-agents.png) |

---

## ✨ 功能特性

- **内置专业模板库**：`npm run templates` 一键播种 8 个专业提示词模板 + 6 个技能（客服/数据分析/代码评审/RAG 问答等），新增时支持从模板复制改局部即用
- **零代码组装**：新 Agent = 数据库里一行配置，无需发版。可复用组件：
  - **Model** — 任意 OpenAI 兼容端点（DeepSeek / 通义 / vLLM / Ollama / 网关…）
  - **Prompt 模板** — 可复用提示词模板（支持 `{{skills}}` 占位符），Agent 引用并可实例覆盖
  - **Skill** — Markdown 指令包，注入系统提示词
  - **MCP Server** — stdio / Streamable HTTP，工具自动包装进 Agent 循环
  - **Knowledge Base** — 上传文档自动切块嵌入，模型按需检索（工具式 RAG）
- **OpenAI 兼容**：任何 OpenAI SDK / 客户端零改造接入，`model` 参数即 Agent 名
- **完整 Agent 循环**：基于 pi-agent-core（工具执行 / 流式事件 / 客户端工具协议）
- **管理页面**：工程图纸风装配台，可视化组装 + 发布 + 试运行（含过程事件透出与 usage）
- **生产硬化**：结构化日志、CORS、api_key 加密、Docker 一键部署

## 🚀 快速开始

### 本地运行（Node.js 22+）

```bash
# 1. 安装依赖
npm install --include=dev

# 2. 配置并播种演示数据（Provider + Agent）
export LLM_BASE_URL=https://api.deepseek.com/v1
export LLM_API_KEY=sk-xxxx
export LLM_MODEL=deepseek-chat
# 可选：知识库嵌入（客服小助手需要）
export EMBEDDING_BASE_URL=https://api.deepseek.com/v1
export EMBEDDING_API_KEY=sk-xxxx
export EMBEDDING_MODEL=bge-m3
npm run seed

# 3. 启动（注意：本机环境若有 PORT 变量会干扰，显式指定）
PORT=8787 npm start
```

打开管理页 <http://localhost:8787/>，在装配台点选组件 → 发布 → 试运行。

### Docker

```bash
LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL=... docker compose up -d --build
# 首次启动自动播种；管理页 http://localhost:8787/
```

## 🔌 调用示例

```bash
# curl —— model 传 Agent 名
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"客服小助手","messages":[{"role":"user","content":"怎么退货？"}],"stream":true}'
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8787/v1", api_key="unused")
resp = client.chat.completions.create(
    model="客服小助手",                      # ← Agent 名
    messages=[{"role": "user", "content": "配送要多久？"}],
)
print(resp.choices[0].message.content)
```

```typescript
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://localhost:8787/v1', apiKey: 'unused' });
const stream = await client.chat.completions.create({
  model: '客服小助手',
  messages: [{ role: 'user', content: '退货政策是什么？' }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
```

**过程事件透出**（管理页试运行专用，服务端工具轨迹）：

```bash
curl -N http://localhost:8787/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"客服小助手","messages":[{"role":"user","content":"怎么退货？"}],
       "stream":true,"x_emit_process":true,"stream_options":{"include_usage":true}}'
# data: {"choices":[{"index":0,"delta":{"process":{"type":"knowledge_searched","tool":"search_knowledge"}}}]}
# data: {"choices":[{"index":0,"delta":{"content":"…"}}]}
# data: {"choices":[],"usage":{"prompt_tokens":…}}
```

## 🏗️ 架构

```
OpenAI 客户端 / SDK ──▶ /v1/chat/completions ──▶ pi-agent-core（对话/工具循环）
                              │                        │
                        /api/* 管理 CRUD          pi-ai（30+ Provider 统一接入）
                              │                        │
                        SQLite（配置/向量）       MCP 工具 / 知识库 RAG / 技能
```

| 层 | 技术 |
| --- | --- |
| Web 框架 | Hono（streamSSE） |
| Agent 运行时 | @earendil-works/pi-agent-core |
| 模型层 | @earendil-works/pi-ai |
| MCP | @modelcontextprotocol/sdk（stdio / HTTP） |
| 存储 | better-sqlite3 + Drizzle（迁移管理）；向量：InMemory / pgvector |
| 知识库 | 自研（FastGPT 系分块器 + QA 多向量 + OpenAI 兼容嵌入） |

## 📂 目录结构

```
src/
├── index.ts          # 服务入口（日志/CORS 中间件、路由挂载）
├── api/              # /v1 兼容层 + 管理 CRUD
├── core/
│   ├── agent/        # Agent 装配、kb-tool、技能注入
│   ├── rag/          # 解析/分块/嵌入/向量存储/摄取管线
│   ├── mcp.ts        # MCP 连接与工具包装
│   ├── kb-service.ts # 知识库服务
│   └── models.ts     # pi-ai 模型注册
├── db/               # Drizzle schema + DB→运行时装配
└── web/index.html    # 管理页面（单文件自包含）
scripts/seed.ts       # 播种演示数据
tests/                # 101 个测试（含 pgvector 真库、MCP 子进程、API 集成）
```

## ⚙️ 环境变量

| 变量 | 说明 |
| --- | --- |
| `PORT` | 服务端口（默认 8787） |
| `ASSEMBLE_API_KEY` | 设置后 `/v1/*` 要求 Bearer 鉴权 |
| `ASSEMBLE_SECRET_KEY` | api_key 加密密钥（AES-256-GCM，建议生产设置） |
| `ASSEMBLE_ALLOW_ORIGINS` | CORS 允许来源（逗号分隔，默认关闭） |
| `ASSEMBLE_DB_PATH` | SQLite 路径（默认 `data/assemble.db`） |
| `LLM_BASE_URL/LLM_API_KEY/LLM_MODEL` | 播种用默认 Provider（运行后由管理页 DB 配置驱动） |
| `EMBEDDING_*` | 播种用嵌入配置（RAG 需要） |

## 🧪 测试

```bash
npm test                # 101 个测试（node 原生测试器）
npm run typecheck       # tsc 严格模式

# pgvector 真库集成测试（可选）：
docker run -d --name assemble-pg-test -e POSTGRES_PASSWORD=test -p 55433:5432 pgvector/pgvector:pg16
PG_TEST_URL=postgresql://postgres:test@127.0.0.1:55433/postgres npm test
```

## 📚 文档

- 详细设计（架构/数据模型/API 规范/安全）：[DESIGN.md](DESIGN.md)

## 📈 路线图

| 阶段 | 状态 |
| --- | --- |
| M1 设计 / M2 骨架 / M3 对话链路 / M4 组件接入 / M5 管理页面 / M6 硬化 | ✅ 全部完成 |
| 多租户（CredentialStore + JWT）、pgvector 生产化、OpenTelemetry | ⬜ 后续 |
