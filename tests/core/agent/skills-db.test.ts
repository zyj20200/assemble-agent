import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fauxProvider } from '@earendil-works/pi-ai';
import { openDb, schema } from '../../../src/db/index.ts';
import { buildRegistryFromDb, loadAgentsFromDb } from '../../../src/db/loaders.ts';
import { KnowledgeBaseService } from '../../../src/core/kb-service.ts';
import { McpManager } from '../../../src/core/mcp.ts';
import { assembleAgent } from '../../../src/core/agent/assemble.ts';
import { ModelRegistry } from '../../../src/core/models.ts';

describe('Skills：DB → 装配 → 系统提示词（端到端）', () => {
  let mcp: McpManager;

  before(() => {
    mcp = new McpManager();
  });
  after(async () => {
    await mcp.closeAll();
  });

  it('Agent 挂载技能后 systemPrompt 含技能全文', async () => {
    const faux = fauxProvider();
    const registry = new ModelRegistry();
    registry.registerProviderInstance(faux.provider);
    const model = faux.getModel()!;

    // 直接装配（注入式路径）
    const agent = await assembleAgent(
      {
        name: '技能助手',
        systemPrompt: '你是客服。\n{{skills}}',
        providerId: model.provider,
        modelId: model.id,
        skills: [
          { name: '话术规范', description: '客服话术', content: '先致谢，语气友好。' },
          { name: '退款政策', content: '7 天内可退。' },
        ],
      },
      { registry, mcp },
    );

    const sp = agent.state.systemPrompt;
    assert.ok(sp.includes('你是客服。'), '基础提示词保留');
    assert.ok(!sp.includes('{{skills}}'), '占位符被替换');
    assert.ok(sp.includes('## 技能：话术规范'));
    assert.ok(sp.includes('先致谢，语气友好。'));
    assert.ok(sp.includes('## 技能：退款政策'));
  });

  it('DB 全链路：建技能 → 挂载 → loaders 装载 → 提示词含技能', () => {
    const { db } = openDb(':memory:');
    const provider = db.insert(schema.providers).values({ name: 'p', baseUrl: 'http://x' }).returning().get();
    const m = db.insert(schema.models).values({ name: 'm', providerId: provider.id, modelId: 'm' }).returning().get();
    const skill = db.insert(schema.skills).values({ name: '话术', description: '客服', content: '语气友好。' }).returning().get();
    const agent = db.insert(schema.agents).values({
      name: 'db助手',
      systemPrompt: '你是客服。\n{{skills}}',
      modelId: m.id,
    }).returning().get();
    db.insert(schema.agentSkills).values({ agentId: agent.id, skillId: skill.id }).run();

    const kb = new KnowledgeBaseService({ db });
    const registry = new ModelRegistry();
    buildRegistryFromDb(db, registry);
    // registry 无 faux → 模型注册自 DB（provider 'p'），装配需真实注册
    const defs = loadAgentsFromDb(db, kb);
    const def = defs.find((d) => d.name === 'db助手');
    assert.ok(def, '应加载出 Agent');
    assert.deepEqual(def!.skills, [{ name: '话术', description: '客服', content: '语气友好。' }]);
    assert.ok(def!.systemPrompt.includes('{{skills}}'), '模板原样保留');
  });
});
