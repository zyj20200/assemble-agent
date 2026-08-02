/**
 * MCP stub server（stdio）：供 McpManager / Agent 集成测试使用
 *
 * 暴露两个工具：
 * - echo(text: string) → `echo: <text>`
 * - add(a: number, b: number) → `a + b = <sum>`
 *
 * 直接运行：node tests/fixtures/mcp-stub-server.ts
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'assemble-stub-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: '回显输入文本',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: '要回显的文本' } },
        required: ['text'],
      },
    },
    {
      name: 'add',
      description: '两数相加',
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'number', description: '加数 a' },
          b: { type: 'number', description: '加数 b' },
        },
        required: ['a', 'b'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;

  if (name === 'echo') {
    return { content: [{ type: 'text', text: `echo: ${String(a.text ?? '')}` }] };
  }
  if (name === 'add') {
    const sum = Number(a.a ?? 0) + Number(a.b ?? 0);
    return { content: [{ type: 'text', text: `${a.a} + ${a.b} = ${sum}` }] };
  }
  return {
    content: [{ type: 'text', text: `未知工具: ${name}` }],
    isError: true,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
