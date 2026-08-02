import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { createApp } from '../../src/index.ts';
import { openDb } from '../../src/db/index.ts';
import { ModelRegistry } from '../../src/core/models.ts';
import { InMemoryVectorStore } from '../../src/core/rag/vector-store.ts';
import type { AgentDefinition } from '../../src/core/agent/assemble.ts';
import type { EmbedFn } from '../../src/core/rag/types.ts';

function makeExactEmbed(): { embed: EmbedFn } {
  const map = new Map<string, number[]>();
  const dim = 64;
  const embed: EmbedFn = async (texts) =>
    texts.map((t) => {
      let v = map.get(t);
      if (!v) {
        v = new Array(dim).fill(0);
        v[map.size % dim] = 1;
        map.set(t, v);
      }
      return v;
    });
  return { embed };
}

// ---------- 环境 ----------

const faux = fauxProvider();
const registry = new ModelRegistry();
registry.registerProviderInstance(faux.provider);
const fauxModel = faux.getModel();
assert.ok(fauxModel, 'faux 模型应存在');

let app: ReturnType<typeof createApp>;
let kbStore: InMemoryVectorStore;
let kbEmbed: EmbedFn;

const chatDef: AgentDefinition = {
  name: '测试助手',
  description: '纯对话',
  systemPrompt: '测试系统提示词。',
  providerId: fauxModel!.provider,
  modelId: fauxModel!.id,
};

before(async () => {
  kbStore = new InMemoryVectorStore();
  kbEmbed = makeExactEmbed().embed;
  await kbStore.insert(
    [
      { datasetId: 'ds', documentId: 'faq', chunkIndex: 0, vectorText: '怎么退货？', content: '联系客服处理退款' },
      { datasetId: 'ds', documentId: 'faq', chunkIndex: 1, vectorText: '密码忘了', content: '点击找回密码' },
    ],
    await kbEmbed(['怎么退货？', '密码忘了']),
  );

  const kbDef: AgentDefinition = {
    name: '客服小助手',
    systemPrompt: '你是客服助手，先检索知识库再回答。',
    providerId: fauxModel!.provider,
    modelId: fauxModel!.id,
    knowledgeBase: { store: kbStore, embed: kbEmbed, datasetId: 'ds', minScore: 0.3 },
  };

  app = createApp({ registry, agents: [chatDef, kbDef], db: openDb(':memory:').db });
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

/** 解析 SSE 响应体 → chunk 对象数组（不含 [DONE]） */
async function parseSse(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('data: '));
  assert.equal(lines[lines.length - 1], 'data: [DONE]', 'SSE 应以 [DONE] 结尾');
  return lines.slice(0, -1).map((l) => JSON.parse(l.slice(6)));
}

describe('POST /v1/chat/completions（OpenAI 兼容）', () => {
  it('非流式：返回标准 ChatCompletion + usage', async () => {
    faux.setResponses([fauxAssistantMessage([fauxText('你好！')])]);
    const res = await post({
      model: '测试助手',
      messages: [{ role: 'user', content: '你好' }],
      stream: false,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.model, '测试助手');
    assert.equal(body.choices[0].message.role, 'assistant');
    assert.equal(body.choices[0].message.content, '你好！');
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.ok(body.usage && body.usage.total_tokens > 0, '应返回 usage');
    assert.ok(body.id.startsWith('chatcmpl-'));
  });

  it('流式：SSE chunk 序列正确（role → 内容增量 → stop → [DONE]）', async () => {
    faux.setResponses([fauxAssistantMessage([fauxText('流式')])]);
    const res = await post({ model: '测试助手', messages: [{ role: 'user', content: 'hi' }], stream: true });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

    const chunks = await parseSse(res);
    assert.ok(chunks.length >= 3, `应有多个 chunk，实际 ${chunks.length}`);
    const first = chunks[0] as any;
    assert.equal(first.object, 'chat.completion.chunk');
    assert.deepEqual(first.choices[0].delta, { role: 'assistant', content: '' });
    const content = chunks
      .map((c) => (c as any).choices?.[0]?.delta?.content ?? '')
      .join('');
    assert.equal(content, '流式');
    const last = chunks[chunks.length - 1] as any;
    assert.equal(last.choices[0].finish_reason, 'stop');
  });

  it('未知模型 → 404 model_not_found', async () => {
    const res = await post({ model: '不存在的Agent', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(res.status, 404);
    const body = (await res.json()) as any;
    assert.equal(body.error.code, 'model_not_found');
    assert.equal(body.error.type, 'invalid_request_error');
  });

  it('n=2 → 400；无消息 → 400', async () => {
    const r1 = await post({ model: '测试助手', messages: [{ role: 'user', content: 'x' }], n: 2 });
    assert.equal(r1.status, 400);
    const r2 = await post({ model: '测试助手', messages: [{ role: 'system', content: 'x' }] });
    assert.equal(r2.status, 400);
  });

  it('服务端知识库工具：内部执行，流中不暴露 tool_calls，最终内容含检索结果', async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('search_knowledge', { query: '怎么退货？' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('根据知识库：联系客服处理退款。')]),
    ]);
    const res = await post({
      model: '客服小助手',
      messages: [{ role: 'user', content: '怎么退货？' }],
      stream: true,
    });
    const chunks = await parseSse(res);
    // 服务端工具透明：任何 chunk 都不含 tool_calls
    for (const c of chunks) {
      const delta = (c as any).choices?.[0]?.delta ?? {};
      assert.ok(!('tool_calls' in delta), '服务端工具不应暴露 tool_calls');
    }
    const content = chunks.map((c) => (c as any).choices?.[0]?.delta?.content ?? '').join('');
    assert.ok(content.includes('联系客服处理退款'), `最终内容应含检索结果: ${content}`);
    const last = chunks[chunks.length - 1] as any;
    assert.equal(last.choices[0].finish_reason, 'stop');
  });

  it('客户端工具：流式暴露 tool_calls + finish_reason=tool_calls', async () => {
    faux.setResponses([fauxAssistantMessage([fauxToolCall('echo', { text: 'hi' })], { stopReason: 'toolUse' })]);
    const res = await post({
      model: '测试助手',
      messages: [{ role: 'user', content: 'echo hi' }],
      stream: true,
      tools: [{ type: 'function', function: { name: 'echo', description: '回声', parameters: { type: 'object', properties: { text: { type: 'string' } } } } }],
    });
    const chunks = await parseSse(res);
    const toolChunks = chunks.filter((c) => 'tool_calls' in ((c as any).choices?.[0]?.delta ?? {}));
    assert.ok(toolChunks.length >= 1, '应暴露 tool_calls chunk');
    const name = toolChunks
      .map((c) => (c as any).choices[0].delta.tool_calls[0]?.function?.name ?? '')
      .join('');
    assert.ok(name.includes('echo'), `tool 名应含 echo: ${name}`);
    const args = toolChunks
      .map((c) => (c as any).choices[0].delta.tool_calls[0]?.function?.arguments ?? '')
      .join('');
    assert.ok(args.includes('hi'), `arguments 应含 hi: ${args}`);
    const last = chunks[chunks.length - 1] as any;
    assert.equal(last.choices[0].finish_reason, 'tool_calls');
  });

  it('客户端工具：非流式返回 message.tool_calls', async () => {
    faux.setResponses([fauxAssistantMessage([fauxToolCall('echo', { text: 'hi' })], { stopReason: 'toolUse' })]);
    const res = await post({
      model: '测试助手',
      messages: [{ role: 'user', content: 'echo hi' }],
      stream: false,
      tools: [{ type: 'function', function: { name: 'echo', parameters: {} } }],
    });
    const body = (await res.json()) as any;
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    assert.equal(body.choices[0].message.tool_calls[0].function.name, 'echo');
    assert.equal(body.choices[0].message.content, null);
  });

  it('请求内工具与服务端工具重名 → 400', async () => {
    const res = await post({
      model: '客服小助手',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'search_knowledge', parameters: {} } }],
    });
    assert.equal(res.status, 400);
  });
});


describe('过程事件透出 + 流式 usage（管理页试运行）', () => {
  it('x_emit_process：SSE 含 process 轨迹（工具调用）', async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('search_knowledge', { query: '怎么退货？' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('基于知识库回答。')]),
    ]);
    const res = await post({
      model: '客服小助手',
      messages: [{ role: 'user', content: '怎么退货？' }],
      stream: true,
      x_emit_process: true,
    });
    const chunks = await parseSse(res);
    const processEvents = chunks
      .map((c) => (c as any).choices?.[0]?.delta?.process)
      .filter(Boolean);
    const types = processEvents.map((p: { type: string }) => p.type);
    assert.ok(types.includes('agent_started'), `应含 agent_started: ${types}`);
    assert.ok(types.includes('knowledge_searched'), `应含 knowledge_searched: ${types}`);
  });

  it('x_emit_process 默认关闭：无 process 轨迹', async () => {
    faux.setResponses([fauxAssistantMessage([fauxText('好')])]);
    const res = await post({
      model: '测试助手',
      messages: [{ role: 'user', content: 'x' }],
      stream: true,
    });
    const chunks = await parseSse(res);
    const hasProcess = chunks.some((c) => (c as any).choices?.[0]?.delta?.process);
    assert.equal(hasProcess, false);
  });

  it('stream_options.include_usage：末尾 usage chunk（跨轮累加）', async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('search_knowledge', { query: 'q' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('答案')]),
    ]);
    const res = await post({
      model: '客服小助手',
      messages: [{ role: 'user', content: 'x' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const chunks = await parseSse(res);
    const usageChunk = chunks.find((c) => (c as any).usage);
    assert.ok(usageChunk, '应含 usage chunk');
    const u = (usageChunk as any).usage;
    assert.equal(typeof u.prompt_tokens, 'number');
    assert.equal(u.total_tokens, u.prompt_tokens + u.completion_tokens);
  });
});

describe('上游失败（faux 空队列 → stopReason=error）', () => {
  it('非流式 → 503 upstream_unavailable', async () => {
    faux.setResponses([]); // 空队列：faux 返回错误消息
    const res = await post({
      model: '测试助手',
      messages: [{ role: 'user', content: 'x' }],
      stream: false,
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as any;
    assert.equal(body.error.code, 'upstream_unavailable');
  });

  it('流式 → 错误 chunk + [DONE]', async () => {
    faux.setResponses([]);
    const res = await post({
      model: '测试助手',
      messages: [{ role: 'user', content: 'x' }],
      stream: true,
    });
    const text = await res.text();
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('data: '));
    assert.equal(lines[lines.length - 1], 'data: [DONE]');
    const errorLine = lines.find((l) => l.includes('upstream_unavailable'));
    assert.ok(errorLine, '应包含 upstream_unavailable 错误 chunk');
  });
});

describe('GET /v1/models', () => {
  it('返回已启用 Agent 列表', async () => {
    const res = await app.request('/v1/models');
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    const ids = body.data.map((m: { id: string }) => m.id);
    assert.ok(ids.includes('测试助手'));
    assert.ok(ids.includes('客服小助手'));
  });
});

describe('GET /api/health', () => {
  it('服务健康', async () => {
    const res = await app.request('/api/health');
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.status, 'ok');
    assert.ok('agents' in body && 'providers' in body, '应包含 DB 统计字段');
  });
});
