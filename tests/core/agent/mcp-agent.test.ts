import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Agent } from '@earendil-works/pi-agent-core';
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { McpManager, type McpServerConfig } from '../../../src/core/mcp.ts';
import { assembleAgent, type AgentDefinition } from '../../../src/core/agent/assemble.ts';
import { ModelRegistry } from '../../../src/core/models.ts';

const STUB_PATH = fileURLToPath(new URL('../../fixtures/mcp-stub-server.ts', import.meta.url));

let mcp: McpManager;
let def: AgentDefinition;

before(async () => {
  mcp = new McpManager();

  // 预拉取一次，确保装配时命中缓存
  await mcp.getTools({ id: 1, name: 'stub', transport: 'stdio', command: process.execPath, args: [STUB_PATH] } satisfies McpServerConfig);

  const faux = fauxProvider();
  const registry = new ModelRegistry();
  registry.registerProviderInstance(faux.provider);
  const model = faux.getModel()!;

  def = {
    name: 'mcp助手',
    systemPrompt: '你有 MCP 工具可用。',
    providerId: model.provider,
    modelId: model.id,
    mcpServers: [{ id: 1, name: 'stub', transport: 'stdio', command: process.execPath, args: [STUB_PATH] }],
  };
});

after(async () => {
  await mcp.closeAll();
});

describe('Agent + MCP 工具集成（真实 stdio 子进程）', () => {
  it('Agent 调用 mcp1__echo 工具并基于结果作答', async () => {
    const faux = fauxProvider();
    const registry = new ModelRegistry();
    registry.registerProviderInstance(faux.provider);
    const model = faux.getModel()!;
    const myDef: AgentDefinition = { ...def, providerId: model.provider, modelId: model.id };

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('mcp1__echo', { text: '来自 MCP' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('工具返回：echo: 来自 MCP')]),
    ]);

    const agent = await assembleAgent(myDef, { registry, mcp });
    const events: string[] = [];
    agent.subscribe((e) => { events.push(e.type); });

    await agent.prompt('帮我 echo');

    assert.ok(events.includes('tool_execution_end'), '应执行 MCP 工具');
    const messages = agent.state.messages;
    const toolResults = messages.filter((m) => m.role === 'toolResult');
    assert.ok(toolResults.length >= 1);
    const resultText = JSON.stringify(toolResults[0]!.content);
    assert.ok(resultText.includes('echo: 来自 MCP'), `工具结果应来自子进程: ${resultText}`);

    const final = [...messages].reverse().find((m) => m.role === 'assistant');
    assert.ok(JSON.stringify(final?.content).includes('来自 MCP'));
  });

  it('MCP server 连接失败时不拖垮 Agent（工具被跳过）', async () => {
    const faux = fauxProvider();
    const registry = new ModelRegistry();
    registry.registerProviderInstance(faux.provider);
    const model = faux.getModel()!;
    const myDef: AgentDefinition = {
      ...def,
      providerId: model.provider,
      modelId: model.id,
      mcpServers: [{ id: 999, name: '不存在的server', transport: 'stdio', command: '/nonexistent/bin', args: [] }],
    };

    faux.setResponses([fauxAssistantMessage([fauxText('我仍然可以回答。')])]);

    const agent = await assembleAgent(myDef, { registry, mcp });
    assert.equal(agent.state.tools.length, 0, '失败的 MCP server 不应注入任何工具');

    await agent.prompt('你好');
    const final = [...agent.state.messages].reverse().find((m) => m.role === 'assistant');
    assert.ok(JSON.stringify(final?.content).includes('我仍然可以回答'));
  });
});
