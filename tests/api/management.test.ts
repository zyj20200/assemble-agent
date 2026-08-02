import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/index.ts';
import { openDb } from '../../src/db/index.ts';
import { KnowledgeBaseService } from '../../src/core/kb-service.ts';
import type { EmbedFn } from '../../src/core/rag/types.ts';

/** 确定性伪嵌入：相同文本 → 相同向量 */
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

let app: ReturnType<typeof createApp>;
let kb: KnowledgeBaseService;

before(() => {
  const { db } = openDb(':memory:');
  kb = new KnowledgeBaseService({ db, resolveEmbedder: () => makeExactEmbed().embed });
  app = createApp({ db, kbService: kb });
});

const api = async (method: string, url: string, body?: unknown) => {
  const res = await app.request(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { res, json: () => res.json() as Promise<any> };
};

describe('管理 API: Providers', () => {
  it('创建 → 列表 → 详情 → 更新 → 删除', async () => {
    const { res, json } = await api('POST', '/api/providers', {
      name: 'deepseek',
      base_url: 'https://api.deepseek.com/v1',
      api_key: 'sk-xxx',
      embedding_model: 'bge-m3',
    });
    assert.equal(res.status, 201);
    const created = await json();
    assert.equal(created.name, 'deepseek');

    const list = (await (await api('GET', '/api/providers')).json()) as any;
    assert.equal(list.total, 1);

    const detail = await (await api('GET', `/api/providers/${created.id}`)).json();
    assert.equal(detail.baseUrl, 'https://api.deepseek.com/v1');

    const updated = await (await api('PUT', `/api/providers/${created.id}`, { enabled: false })).json();
    assert.equal(updated.enabled, false);

    const del = await api('DELETE', `/api/providers/${created.id}`);
    assert.equal(del.res.status, 204);
    const after = await api('GET', `/api/providers/${created.id}`);
    assert.equal(after.res.status, 404);
  });

  it('重名 → 400', async () => {
    await api('POST', '/api/providers', { name: 'p1', base_url: 'http://x' });
    const dup = await api('POST', '/api/providers', { name: 'p1', base_url: 'http://y' });
    assert.equal(dup.res.status, 400);
  });

  it('缺 base_url → 400', async () => {
    const r = await api('POST', '/api/providers', { name: 'p2' });
    assert.equal(r.res.status, 400);
  });
});

describe('管理 API: Models', () => {
  let providerId: number;
  before(async () => {
    providerId = (await (await api('POST', '/api/providers', { name: 'mp', base_url: 'http://x' })).json()).id;
  });

  it('创建（含 provider 校验）→ 更新 → 删除', async () => {
    const bad = await api('POST', '/api/models', { name: 'm1', provider_id: 999, model_id: 'x' });
    assert.equal(bad.res.status, 400);

    const { json } = await api('POST', '/api/models', {
      name: 'deepseek-chat',
      provider_id: providerId,
      model_id: 'deepseek-chat',
      temperature: 0.7,
    });
    const created = await json();
    assert.equal(created.providerId, providerId);

    const updated = await (await api('PUT', `/api/models/${created.id}`, { temperature: 0.3 })).json();
    assert.equal(updated.temperature, 0.3);

    assert.equal((await api('DELETE', `/api/models/${created.id}`)).res.status, 204);
  });
});

describe('管理 API: Skills', () => {
  it('CRUD + 重名 400', async () => {
    const { res, json } = await api('POST', '/api/skills', {
      name: '话术规范',
      description: '客服话术',
      content: '## 规范\n语气友好。',
    });
    assert.equal(res.status, 201);
    const s = await json();
    assert.equal((await api('POST', '/api/skills', { name: '话术规范', content: 'x' })).res.status, 400);
    const list = (await (await api('GET', '/api/skills')).json()) as any;
    assert.equal(list.total, 1);
    const upd = await (await api('PUT', `/api/skills/${s.id}`, { content: '新内容' })).json();
    assert.equal(upd.content, '新内容');
    assert.equal((await api('DELETE', `/api/skills/${s.id}`)).res.status, 204);
  });
});

describe('管理 API: MCP Servers', () => {
  it('stdio 需 command；http 需 url', async () => {
    const r1 = await api('POST', '/api/mcp-servers', { name: 'bad-stdio', transport: 'stdio' });
    assert.equal(r1.res.status, 400);
    const r2 = await api('POST', '/api/mcp-servers', { name: 'bad-http', transport: 'http' });
    assert.equal(r2.res.status, 400);
  });

  it('创建 stdio + http + test 接口', async () => {
    const { json } = await api('POST', '/api/mcp-servers', {
      name: 'fs',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      env: { KEY: 'v' },
    });
    const s = await json();
    assert.equal(s.transport, 'stdio');

    const http = await (await api('POST', '/api/mcp-servers', {
      name: 'order',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    })).json();
    assert.equal(http.transport, 'http');

    const t = await (await api('POST', `/api/mcp-servers/${s.id}/test`)).json();
    assert.ok(t.ok);
  });
});

describe('管理 API: Knowledge Bases + Documents + 检索', () => {
  let kbId: number;
  before(async () => {
    kbId = (await (await api('POST', '/api/knowledge-bases', {
      name: 'FAQ',
      chunk_size: 5000,
      top_k: 3,
      min_score: 0.3,
    })).json()).id;
  });

  it('上传 md 文档 → 摄取 → 检索命中 → 删除', async () => {
    const content = '# 退货政策\n\n客户可在签收后 7 天内联系客服申请退货退款。\n\n# 密码找回\n\n点击登录页"忘记密码"链接。';
    const form = new FormData();
    form.append('file', new File([content], 'faq.md', { type: 'text/markdown' }));
    const upload = await app.request(`/api/knowledge-bases/${kbId}/documents`, { method: 'POST', body: form });
    assert.equal(upload.status, 201);
    const doc = (await upload.json()) as any;
    assert.equal(doc.filename, 'faq.md');
    assert.ok(doc.vectors > 0, '应产生向量');

    // 列表
    const docs = (await (await api('GET', `/api/knowledge-bases/${kbId}/documents`)).json()) as any;
    assert.equal(docs.total, 1);

    // 检索调试（伪嵌入：完全相同 query 命中；vectorText 含标题增强前缀 filename: faq.md）
    const search = await (await api('POST', `/api/knowledge-bases/${kbId}/search`, {
      query: 'filename: faq.md\n# 退货政策\n\n客户可在签收后 7 天内联系客服申请退货退款。',
      min_score: 0.99,
    })).json();
    assert.ok((search as any).total >= 1, '应检索命中');
    assert.equal((search as any).items[0].content.includes('退货退款'), true);

    // 删除文档
    assert.equal((await api('DELETE', `/api/documents/${doc.documentId}`)).res.status, 204);
    const after = await api('GET', `/api/documents/${doc.documentId}`);
    assert.equal(after.res.status, 404);
  });

  it('不支持的扩展名 → 400', async () => {
    const form = new FormData();
    form.append('file', new File(['x'], 'a.xyz', { type: 'text/plain' }));
    const upload = await app.request(`/api/knowledge-bases/${kbId}/documents`, { method: 'POST', body: form });
    assert.equal(upload.status, 400);
  });
});

describe('管理 API: Agents（组装）', () => {
  let modelId: number;
  let skillId: number;
  let kbId: number;
  before(async () => {
    const pid = (await (await api('POST', '/api/providers', { name: 'agp', base_url: 'http://x' })).json()).id;
    modelId = (await (await api('POST', '/api/models', { name: 'm', provider_id: pid, model_id: 'm' })).json()).id;
    skillId = (await (await api('POST', '/api/skills', { name: 's', content: 'x' })).json()).id;
    kbId = (await (await api('POST', '/api/knowledge-bases', { name: 'kb' })).json()).id;
  });

  it('组装（模型 + 技能 + 知识库）→ 详情含关联 → 更新替换关联 → 删除', async () => {
    const { res, json } = await api('POST', '/api/agents', {
      name: '客服小助手',
      system_prompt: '你是客服。',
      model_id: modelId,
      skill_ids: [skillId],
      knowledge_base_ids: [kbId],
    });
    assert.equal(res.status, 201);
    const agent = await json();
    assert.equal(agent.skills.length, 1);
    assert.equal(agent.knowledge_bases.length, 1);
    assert.equal(agent.model.modelId, 'm');

    // 引用不存在 → 400
    const bad = await api('POST', '/api/agents', {
      name: 'x',
      system_prompt: 'p',
      model_id: modelId,
      skill_ids: [999],
    });
    assert.equal(bad.res.status, 400);

    // 更新：替换关联（整体替换语义）
    const updated = await (await api('PUT', `/api/agents/${agent.id}`, {
      skill_ids: [],
      knowledge_base_ids: [kbId],
    })).json();
    assert.equal(updated.skills.length, 0, '整体替换后应清空技能');
    assert.equal(updated.knowledge_bases.length, 1);

    // 详情
    const detail = await (await api('GET', `/api/agents/${agent.id}`)).json();
    assert.equal(detail.name, '客服小助手');

    // 删除
    assert.equal((await api('DELETE', `/api/agents/${agent.id}`)).res.status, 204);
    assert.equal((await api('GET', `/api/agents/${agent.id}`)).res.status, 404);
  });

  it('Agent 被引用时删除模型 → 400', async () => {
    const pid = (await (await api('POST', '/api/providers', { name: 'agp2', base_url: 'http://x' })).json()).id;
    const mid = (await (await api('POST', '/api/models', { name: 'm2', provider_id: pid, model_id: 'm2' })).json()).id;
    await api('POST', '/api/agents', { name: 'a2', system_prompt: 'p', model_id: mid });
    const del = await api('DELETE', `/api/models/${mid}`);
    assert.equal(del.res.status, 400, '被 Agent 引用的模型不可删除');
  });
});

describe('管理 API: 健康检查', () => {
  it('返回各实体计数', async () => {
    const body = await (await api('GET', '/api/health')).json();
    assert.equal(body.status, 'ok');
    for (const k of ['providers', 'models', 'skills', 'mcpServers', 'knowledgeBases', 'agents']) {
      assert.equal(typeof body[k], 'number', `${k} 应为计数`);
    }
  });
});
