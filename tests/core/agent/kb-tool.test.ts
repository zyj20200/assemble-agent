import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '@earendil-works/pi-agent-core';
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { InMemoryVectorStore } from '../../../src/core/rag/vector-store.ts';
import { createKnowledgeBaseTool } from '../../../src/core/agent/kb-tool.ts';
import type { EmbedFn } from '../../../src/core/rag/types.ts';

/** 确定性伪嵌入（与其余测试一致） */
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

/** 预置一个含 2 条 QA 的知识库 */
async function seedKb() {
  const store = new InMemoryVectorStore();
  const { embed } = makeExactEmbed();
  const items = [
    { datasetId: 'ds', documentId: 'faq', chunkIndex: 0, vectorText: '怎么退货？', content: '联系客服处理退款' },
    { datasetId: 'ds', documentId: 'faq', chunkIndex: 0, vectorText: '退款流程', content: '联系客服处理退款' },
    { datasetId: 'ds', documentId: 'faq', chunkIndex: 1, vectorText: '密码忘了？', content: '点击找回密码' },
  ];
  await store.insert(items, await embed(items.map((i) => i.vectorText)));
  return { store, embed };
}

describe('agent + kb-tool 集成（pi-agent-core）', () => {
  it('Agent 自主调用知识库工具并基于检索结果作答', async () => {
    const { store, embed } = await seedKb();

    // 脚本化模型：第一轮调工具，第二轮给最终答案
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    assert.ok(model, 'faux 模型应存在');

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('search_knowledge', { query: '怎么退货？' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxText('根据知识库，答案是：联系客服处理退款。')]),
    ]);

    const agent = new Agent({
      initialState: {
        systemPrompt: '你是客服助手。需要事实依据时先检索知识库，再基于检索结果作答。',
        model: model!,
        tools: [createKnowledgeBaseTool({ store, embed, datasetId: 'ds', minScore: 0.3 })],
      },
      streamFn: models.streamSimple.bind(models),
    });

    const events: string[] = [];
    agent.subscribe((e) => { events.push(e.type); });

    await agent.prompt('怎么退货？');

    // 工具执行轨迹
    assert.ok(events.includes('tool_execution_start'), '应发出 tool_execution_start');
    assert.ok(events.includes('tool_execution_end'), '应发出 tool_execution_end');

    // 最终助手消息引用了检索内容
    const messages = agent.state.messages;
    const finalAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    const text = JSON.stringify(finalAssistant?.content ?? '');
    assert.ok(text.includes('联系客服处理退款'), '最终回答应包含知识库内容');
  });

  it('知识库无命中时工具如实说明，不编造', async () => {
    const { store, embed } = await seedKb();

    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel()!;

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('search_knowledge', { query: '完全不存在的主题XYZ' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxText('知识库中没有相关内容，我无法回答。')]),
    ]);

    const agent = new Agent({
      initialState: {
        systemPrompt: '你是客服助手。',
        model,
        tools: [createKnowledgeBaseTool({ store, embed, datasetId: 'ds', minScore: 0.3 })],
      },
      streamFn: models.streamSimple.bind(models),
    });

    await agent.prompt('完全不存在的主题XYZ是什么？');

    const messages = agent.state.messages;
    const toolResults = messages.filter((m) => m.role === 'toolResult');
    assert.ok(toolResults.length >= 1, '应有工具结果消息');
    const resultText = JSON.stringify(toolResults[0]!.content);
    assert.ok(resultText.includes('未检索到'), '无命中时工具应如实说明');
  });

  it('参数校验：top_k 超出范围时工具报错而非崩溃', async () => {
    const { store, embed } = await seedKb();

    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel()!;

    // 模型传入非法 top_k=999（超过 schema 上限 20）
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('search_knowledge', { query: '怎么退货？', top_k: 999 })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxText('完成。')]),
    ]);

    const agent = new Agent({
      initialState: {
        systemPrompt: '你是客服助手。',
        model,
        tools: [createKnowledgeBaseTool({ store, embed, datasetId: 'ds', minScore: 0.3 })],
      },
      streamFn: models.streamSimple.bind(models),
    });

    // 不应抛异常（参数校验失败会作为工具错误回喂）
    await agent.prompt('怎么退货？');
    const messages = agent.state.messages;
    const errors = messages.filter((m) => m.role === 'toolResult' && m.isError);
    assert.ok(errors.length >= 1, '非法参数应作为工具错误回馈');
  });
});
