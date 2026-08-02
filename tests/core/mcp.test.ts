import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { McpManager, jsonSchemaToTypebox, type McpServerConfig } from '../../src/core/mcp.ts';

const STUB_PATH = fileURLToPath(new URL('../fixtures/mcp-stub-server.ts', import.meta.url));

const stubConfig: McpServerConfig = {
  id: 1,
  name: 'stub',
  transport: 'stdio',
  command: process.execPath,
  args: [STUB_PATH],
};

let mcp: McpManager;

before(() => {
  mcp = new McpManager();
});
after(async () => {
  await mcp.closeAll();
});

describe('McpManager: stdio 连接', () => {
  it('getTools 返回前缀命名的 AgentTool', async () => {
    const tools = await mcp.getTools(stubConfig);
    const names = tools.map((t) => t.name);
    assert.deepEqual(names, ['mcp1__echo', 'mcp1__add']);
    assert.ok(tools[0]!.description.includes('[MCP: stub]'));
  });

  it('执行 echo 工具', async () => {
    const tools = await mcp.getTools(stubConfig);
    const echo = tools.find((t) => t.name === 'mcp1__echo')!;
    const result = await echo.execute('call-1', { text: '你好 MCP' });
    const text = result.content.find((b) => b.type === 'text') as { text: string };
    assert.equal(text.text, 'echo: 你好 MCP');
  });

  it('执行 add 工具（数值参数）', async () => {
    const tools = await mcp.getTools(stubConfig);
    const add = tools.find((t) => t.name === 'mcp1__add')!;
    const result = await add.execute('call-2', { a: 2, b: 3 });
    const text = result.content.find((b) => b.type === 'text') as { text: string };
    assert.equal(text.text, '2 + 3 = 5');
  });

  it('连接复用：第二次 getTools 命中缓存', async () => {
    const t1 = await mcp.getTools(stubConfig);
    const t2 = await mcp.getTools(stubConfig);
    assert.equal(t1, t2, '应复用同一工具实例（缓存）');
  });

  it('test() 返回工具清单', async () => {
    const result = await mcp.test(stubConfig);
    assert.equal(result.ok, true);
    assert.deepEqual(result.tools, ['echo', 'add']);
  });
});

describe('jsonSchemaToTypebox', () => {
  it('object + required + 各基础类型', () => {
    const schema = jsonSchemaToTypebox({
      type: 'object',
      properties: {
        name: { type: 'string', description: '名字' },
        age: { type: 'integer' },
        score: { type: 'number' },
        vip: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
    });
    const type = schema as { type: string; properties: Record<string, unknown> };
    assert.equal(type.type, 'object');
    const props = type.properties as Record<string, { type: string; [k: string]: unknown }>;
    assert.equal(props.name!.type, 'string');
    assert.ok('description' in props.name!, '应保留 description');
  });

  it('enum → Union Literal', () => {
    const schema = jsonSchemaToTypebox({ type: 'string', enum: ['a', 'b'] }) as { anyOf?: unknown[] };
    assert.ok(Array.isArray(schema.anyOf) && schema.anyOf.length === 2);
  });

  it('未知 schema → Type.Unknown', () => {
    const schema = jsonSchemaToTypebox(undefined);
    // Type.Unknown() 仅含 Kind symbol（JSON 序列化为 {}），与普通 Unknown 结构一致即可
    assert.deepEqual(JSON.parse(JSON.stringify(schema)), {});
  });
});
